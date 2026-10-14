import test from 'node:test';
import assert from 'node:assert/strict';
import { abortable } from '../src/main/ai/errors.ts';
import { requestOpenRouterJson } from '../src/main/ai/adapters/openrouter-chat.ts';
import { postOpenRouter, openRouterFailure } from '../src/main/ai/adapters/openrouter-http.ts';
import { slowHttp } from './fixtures/stabilization/slow-http.ts';
import { OpenRouterImageAdapter } from '../src/main/ai/adapters/openrouter-images.ts';
import { reviewImageWithAliyun } from '../src/main/ai/aliyun-image-risk.ts';
import { createHash,randomUUID } from 'node:crypto';
import {assertOpaqueResponse,opaqueResponse} from '../src/main/ai/opaque-response.ts';

const validBody = JSON.stringify({ id: 'gen_s02_slow', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: .013 } });
const key = 'or-s02-synthetic-key';
function context(url:string, extra:any={}) { return { fetch: ((_url:any,init:any)=>fetch(url,init)) as typeof fetch, now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,...extra }; }

test('real HTTP early headers and 31-second body preserve the entire original response with one POST', { timeout: 45000 }, async t => {
  const http = await slowHttp({ body: validBody, delayMs: 31000 });t.after(()=>http.close());
  const receipts:any[]=[],events:any[]=[];
  const output=await requestOpenRouterJson({},'JSON','openai/gpt-6-luna',{apiKey:key},new AbortController().signal,context(http.url,{effectiveEffort:'none',responseDeadlineAt:Date.now()+40000,onProviderReceipt:(receipt:any)=>receipts.push(receipt),onRunEvidence:(event:any)=>events.push(event)}));
  assert.deepEqual(output.content,{ok:true});assert.equal(http.posts,1);assert.equal(receipts.length,1);assert.deepEqual(receipts[0].body,JSON.parse(validBody));
  assert.equal(events.find(event=>event.event==='BODY_COMPLETED').receivedBytes,Buffer.byteLength(validBody));
  assert.deepEqual(events.filter(event=>['DISPATCH_ATTEMPTED','HEADERS_RECEIVED','BODY_COMPLETED'].includes(event.event)).map(event=>event.event),['DISPATCH_ATTEMPTED','HEADERS_RECEIVED','BODY_COMPLETED']);
});

for(const [source,options,policy] of [
  ['TOTAL_TIMEOUT',{headersDelayMs:80,delayMs:80},{responseDeadlineAt:()=>Date.now()+110}],
  ['BODY_TIMEOUT',{delayMs:150},{responseDeadlineAt:()=>Date.now()+500,responseBodyTimeoutMs:30}],
] as const)test(`real HTTP ${source} retains request identity and records the interruption`,async t=>{
  const http=await slowHttp({body:validBody,...options});t.after(()=>http.close());const receipts:any[]=[],events:any[]=[];
  await assert.rejects(postOpenRouter('/api/v1/chat/completions',{model:'openai/gpt-6-luna'},{apiKey:key},new AbortController().signal,context(http.url,{...policy,responseDeadlineAt:policy.responseDeadlineAt(),onProviderReceipt:(r:any)=>receipts.push(r),onRunEvidence:(e:any)=>events.push(e)})),(e:any)=>e.code==='TIMEOUT'&&e.abortSource===source);
  assert.equal(http.posts,1);assert.equal(receipts.length,0);const stopped=events.at(-1);assert.equal(stopped.abortSource,source);assert.equal(stopped.certainty,'SENT_UNKNOWN');
});

test('a disconnected partial response is unknown and never saved as a complete receipt',async t=>{
  const http=await slowHttp({body:'',partial:'{"id":"gen_partial",',disconnect:true,delayMs:25});t.after(()=>http.close());const receipts:any[]=[],events:any[]=[];
  await assert.rejects(postOpenRouter('/api/v1/images',{model:'openai/gpt-image-2.5-flare'},{apiKey:key},new AbortController().signal,context(http.url,{onProviderReceipt:(r:any)=>receipts.push(r),onRunEvidence:(e:any)=>events.push(e)})));
  assert.equal(http.posts,1);assert.equal(receipts.length,0);assert.equal(events.at(-1).certainty,'SENT_UNKNOWN');assert.ok(events.at(-1).receivedBytes>0);assert.equal(events.some(event=>event.event==='BODY_COMPLETED'),false);
});

test('user cancellation keeps bounded collection and the late receipt but returns no output',async t=>{
  const http=await slowHttp({body:validBody,delayMs:50});t.after(()=>http.close());const controller=new AbortController(),receipts:any[]=[];
  const promise=postOpenRouter('/api/v1/chat/completions',{model:'openai/gpt-6-luna'},{apiKey:key},controller.signal,context(http.url,{responseDeadlineAt:Date.now()+500,onRunEvidence:(e:any)=>{if(e.event==='HEADERS_RECEIVED')controller.abort();},onProviderReceipt:(r:any)=>receipts.push(r)}));
  await assert.rejects(promise,(e:any)=>e.code==='CANCELLED'&&e.abortSource==='USER');assert.equal(http.posts,1);assert.deepEqual(receipts[0].body,JSON.parse(validBody));assert.equal(receipts[0].costUsd,.013);
});

test('first and recovery classifications distinguish exact no-provider 503 from an ambiguous gateway failure',()=>{
  const noProvider={error:{message:'No available providers found for the selected model.'}},gateway={error:{message:'Upstream unavailable'}};
  assert.equal(openRouterFailure(503,noProvider)?.definitive,true);assert.equal(openRouterFailure(503,gateway)?.definitive,false);
  assert.equal(openRouterFailure(200,noProvider)?.definitive,false);assert.equal(openRouterFailure(200,{choices:[{error:gateway.error}]})?.definitive,false);
});

for(const [name,body,limit,receiptCount] of [['empty','',10000,1],['oversized','x'.repeat(1500),1024,0]] as const)test(`real HTTP ${name} response cannot be a valid result or reset unknown fees`,async t=>{
  const http=await slowHttp({body});t.after(()=>http.close());const receipts:any[]=[],events:any[]=[];
  await assert.rejects(postOpenRouter('/api/v1/chat/completions',{model:'openai/gpt-6-luna'},{apiKey:key},new AbortController().signal,context(http.url,{maxResponseBytes:limit,onProviderReceipt:(r:any)=>receipts.push(r),onRunEvidence:(e:any)=>events.push(e)})),(error:any)=>error.code==='OUTPUT_INVALID');
  assert.equal(http.posts,1);assert.equal(receipts.length,receiptCount);if(receiptCount){assert.equal(receipts[0].costUsd,null);assert.equal(receipts[0].body,'');}assert.equal(events.at(-1).certainty,receiptCount?'RECEIVED_INVALID':'SENT_UNKNOWN');
});

test('an expired original deadline cannot reserve or dispatch even when the timer has not fired',async()=>{
  let reservations=0,posts=0;
  await assert.rejects(postOpenRouter('/api/v1/chat/completions',{model:'openai/gpt-6-luna'},{apiKey:key},new AbortController().signal,{fetch:async()=>{posts++;return Response.json({});},now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,responseDeadlineAt:Date.now()-1,beforeSend:()=>{reservations++;}}),(e:any)=>e.code==='TIMEOUT'&&e.abortSource==='TOTAL_TIMEOUT');
  assert.equal(reservations,0);assert.equal(posts,0);
});

test('cancelled image URL reply retains its raw receipt but cannot schedule a new download GET',async t=>{
  const raw={id:'gen_late_url',data:[{url:'https://fixture.invalid/retained.png'}],usage:{cost:.09}},http=await slowHttp({body:JSON.stringify(raw),delayMs:40});t.after(()=>http.close());
  const controller=new AbortController(),receipts:any[]=[],methods:string[]=[];
  const adapter=new OpenRouterImageAdapter({fetch:async(url:any,init:any)=>{assert.equal(String(url),'https://openrouter.ai/api/v1/images');methods.push(init.method);return fetch(http.url,init);}});
  await assert.rejects(adapter.generate({apiKey:key,model:'openai/gpt-image-2.5-flare',prompt:'Synthetic product photo',size:'auto',quality:'auto',background:'auto',references:[]},controller.signal,{responseTimeoutMs:500,onProviderReceipt:r=>{receipts.push(r);},onRunEvidence:e=>{if(e.event==='HEADERS_RECEIVED')controller.abort();}}),(e:any)=>e.code==='CANCELLED');
  assert.deepEqual(methods,['POST']);assert.equal(http.posts,1);assert.deepEqual(receipts[0].body,raw);assert.equal(receipts[0].costUsd,.09);
});

test('pause during an Ali upload-token body cannot schedule OSS PUT or moderation POST or leak token data',async t=>{
  const bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(256,16);bytes.writeUInt32BE(256,20);
  const raw={Code:200,Data:{OssInternetEndPoint:'https://oss-cn-shanghai.aliyuncs.com',BucketName:'synthetic-bucket',FileNamePrefix:'fixture/',Expiration:Math.floor(Date.now()/1000)+3600,AccessKeyId:'SYNTHETIC_TOKEN_ID',AccessKeySecret:'SYNTHETIC_TOKEN_SECRET',SecurityToken:'SYNTHETIC_TOKEN'}};
  const http=await slowHttp({body:JSON.stringify(raw),delayMs:40});t.after(()=>http.close());const controller=new AbortController(),events:any[]=[],receipts:any[]=[],methods:string[]=[],metadata:any[]=[];
  const candidate={id:randomUUID(),sha256:createHash('sha256').update(bytes).digest('hex'),width:256,height:256};
  await assert.rejects(reviewImageWithAliyun(bytes,candidate,randomUUID(),{accessKeyId:'synthetic-key',accessKeySecret:'synthetic-secret'},controller.signal,{fetch:async(_url:any,init:any)=>{methods.push(init.method);assert.equal(methods.length,1);return fetch(http.url,init);},now:()=>new Date(),nonce:()=>randomUUID(),maxResponseBytes:10000,onMetadata:m=>metadata.push(m),onProviderReceipt:r=>{receipts.push(r);},onRunEvidence:e=>{events.push(e);if(e.event==='HEADERS_RECEIVED')controller.abort();}}),(e:any)=>e.code==='CANCELLED');
  assert.deepEqual(methods,['POST']);assert.equal(http.posts,1);assert.equal(metadata.length,0);assert.equal(receipts.length,0);assert.equal(events.at(-1).certainty,'SENT_UNKNOWN');
  assert.doesNotMatch(JSON.stringify(events),/SYNTHETIC_TOKEN|OssInternet|BucketName|SecurityToken/);
});

test('complete invalid UTF8 retains the exact opaque wire bytes without inventing content or fees',async()=>{
  const bytes=Buffer.from([0xff,0xfe,0x61]),receipts:any[]=[],events:any[]=[];let posts=0;
  await assert.rejects(postOpenRouter('/api/v1/chat/completions',{model:'openai/gpt-6-luna'},{apiKey:key},new AbortController().signal,{fetch:async()=>{posts++;return new Response(bytes);},now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,onProviderReceipt:r=>{receipts.push(r);},onRunEvidence:e=>events.push(e)}),(error:any)=>error.code==='OUTPUT_INVALID'&&error.diagnosticReason==='RESPONSE_UTF8_INVALID');
  assert.equal(posts,1);assert.equal(receipts.length,1);assert.deepEqual(Buffer.from(receipts[0].body.base64,'base64'),bytes);assert.equal(receipts[0].body.encoding,'raw-utf8-invalid/v1');assert.equal(receipts[0].body.complete,true);assert.equal(receipts[0].body.byteSize,3);assert.equal(receipts[0].body.wireSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(receipts[0].costUsd,null);assert.equal(events.at(-1).certainty,'RECEIVED_INVALID');
});

test('opaque byte evidence rejects tampered hashes and valid UTF8; credential echo never persists opaque bytes',async()=>{
  const raw=opaqueResponse(Buffer.from([0xff,0x61]));assert.doesNotThrow(()=>assertOpaqueResponse(raw));assert.throws(()=>assertOpaqueResponse({...raw,wireSha256:'a'.repeat(64)}));assert.throws(()=>assertOpaqueResponse(opaqueResponse(Buffer.from('valid text'))));
  const receipts:any[]=[];await assert.rejects(postOpenRouter('/api/v1/chat/completions',{model:'openai/gpt-6-luna'},{apiKey:key},new AbortController().signal,{fetch:async()=>new Response(Buffer.concat([Buffer.from([0xff]),Buffer.from(key)])),now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,onProviderReceipt:r=>{receipts.push(r);}}),(e:any)=>e.diagnosticReason==='RESPONSE_SECRET_ECHO'&&e.certainty==='SENT_UNKNOWN');assert.equal(receipts[0].body,'[omitted: credential echo]');assert.doesNotMatch(JSON.stringify(receipts),/or-s02-synthetic-key|base64/);
});

test('native deadline expiry is TIMEOUT rather than a user cancellation', async () => {
  const signal = AbortSignal.timeout(10);
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(abortable(new Promise(() => {}), signal), (error: any) => error.code === 'TIMEOUT');
  } finally { clearTimeout(keepAlive); }
});

for (const choiceError of [false, true]) test(`HTTP 200 ${choiceError ? 'choice' : 'top-level'} provider failure retains its receipt and remains non-definitive`, async () => {
  let posts = 0;
  const receipts: any[] = [];
  const upstream = { code: 502, message: 'Synthetic upstream unavailable', metadata: { error_type: 'provider_unavailable' } };
  const body = {
    id: 'gen_s02_failed', usage: { prompt_tokens: 9, completion_tokens: 1, cost: .012 },
    ...(choiceError ? { choices: [{ finish_reason: 'error', message: { content: 'partial output' }, error: upstream }] } : { error: upstream }),
  };
  await assert.rejects(requestOpenRouterJson({}, 'Return JSON', 'openai/gpt-6-luna', { apiKey: 'or-s02-synthetic-key' }, new AbortController().signal, {
    fetch: async () => { posts++; return Response.json(body); },
    now: () => new Date('2026-10-15T00:00:00.000Z'), nonce: () => '', maxResponseBytes: 10000,
    effectiveEffort: 'none', onProviderReceipt: receipt => { receipts.push(receipt); },
  }), (error: any) => error.code === 'PROVIDER_ERROR' && error.httpStatus === 200 && error.definitive === false);
  assert.equal(posts, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 200);
  assert.equal(receipts[0].costUsd, .012);
  assert.deepEqual(receipts[0].body, body);
});
