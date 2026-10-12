import test from 'node:test';
import assert from 'node:assert/strict';
import {requestDeepSeekJson} from '../src/main/ai/adapters.ts';
const envelope=(content:unknown,finish='stop')=>({id:'safe-fixture',usage:{prompt_tokens:1,completion_tokens:2},choices:[{finish_reason:finish,message:{content}}]});
test('image plan pre-parse failures retain safe diagnostics and fixed phase reasons',async()=>{
  const cases:[string,string,string][]=[[JSON.stringify({...envelope('{}'),usage:null}),'RESPONSE_ENVELOPE_INVALID','{}'],[JSON.stringify({...envelope('{}'),choices:[]}), 'RESPONSE_ENVELOPE_INVALID',''],['{"choices":[','RESPONSE_ENVELOPE_JSON_INVALID','{"choices":['],[JSON.stringify(envelope('{"ok":true}','length')),'RESPONSE_NOT_COMPLETE','{"ok":true}'],[JSON.stringify(envelope(null)),'RESPONSE_CONTENT_MISSING',''],[JSON.stringify(envelope('{broken')),'RESPONSE_JSON_INVALID','{broken'],[JSON.stringify(envelope('{"note":"\\u0066ixture-secret"}')),'RESPONSE_SECRET_ECHO','[omitted: credential echo]']];
  for(const [raw,reason,expected] of cases){let captured:unknown;await assert.rejects(requestDeepSeekJson({operation:'image-plan'},'JSON','deepseek-flash',{apiKey:'fixture-secret'},new AbortController().signal,{now:()=>new Date(),nonce:()=>'',maxResponseBytes:1000000,fetch:async()=>new Response(raw),onUntrustedOutput:v=>{captured=v;}}),(e:any)=>e.code==='OUTPUT_INVALID'&&e.diagnosticReason===reason);assert.notEqual(captured,undefined);if(expected)assert.equal(captured,expected);assert.ok(!JSON.stringify(captured).includes('fixture-secret'));}
});

test('R2 transport failures retain fixed reason and safe byte metadata without claiming a payload',async()=>{
 const {postJson}=await import('../src/main/ai/transport.ts');
 for(const [response,reason,bytes] of [[new Response(null),'RESPONSE_BODY_MISSING',0],[new Response(''),'RESPONSE_BODY_EMPTY',0],[new Response(new Uint8Array([255])),'RESPONSE_UTF8_INVALID',1],[new Response('x'.repeat(1025)),'RESPONSE_SIZE_LIMIT',1025],[new Response('x',{headers:{'content-length':'bad'}}),'RESPONSE_LENGTH_INVALID',0],[new Response(new ReadableStream({start(c){c.error(Error('secret read failure'));}})),'RESPONSE_READ_FAILED',0]] as const){
  await assert.rejects(postJson('https://offline.invalid',{},'{}',new AbortController().signal,{fetch:async()=>response,now:()=>new Date(),nonce:()=>'',maxResponseBytes:1024}),(e:any)=>{assert.equal(e.code,'OUTPUT_INVALID');assert.equal(e.diagnosticReason,reason);assert.deepEqual(e.responseDiagnostic,{status:200,byteCount:bytes});return true;});
 }
});

test('R2 raw recovery never repairs delimiters, trailing data, invalid escapes or unsafe diagnostics',async()=>{
 const {parseImagePlanRecovery}=await import('../src/main/ai/image-validation.ts');
 for(const raw of ['{"prompt":"a\n",]', '{"prompt":"a"}\n{}', '{"prompt":"a\\\n"}', '{"prompt":"[omitted: credential echo]"}', '{"prompt":"unclosed\n'])assert.throws(()=>parseImagePlanRecovery(raw,{} as any));
});
