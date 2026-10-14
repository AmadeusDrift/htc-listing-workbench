import test from 'node:test';
import assert from 'node:assert/strict';
import {requestDeepSeekJson} from '../src/main/ai/adapters.ts';

const key='synthetic-deepseek-transport-key';
for(const status of [401,402,403,429,503])test(`complete DeepSeek ${status} retains exact bytes and matching refusal certainty without inferring fees`,async()=>{
  const body=JSON.stringify({error:{message:'Synthetic service response',code:status}}),events:any[]=[],receipts:any[]=[];let posts=0;
  await assert.rejects(requestDeepSeekJson({},'JSON','deepseek-flash',{apiKey:key},new AbortController().signal,{fetch:async()=>{posts++;return new Response(body,{status});},now:()=>new Date(),nonce:()=>'',maxResponseBytes:4096,onProviderReceipt:r=>{receipts.push(r);},onRunEvidence:e=>events.push(e)}),(error:any)=>error.certainty===(status===503?'SENT_UNKNOWN':'DEFINITIVE_REJECTION'));
  assert.equal(posts,1);assert.equal(receipts.length,1);assert.equal(receipts[0].costUsd,null);assert.deepEqual(receipts[0].body,JSON.parse(body));assert.equal(events.at(-1).receivedBytes,Buffer.byteLength(body));assert.equal(events.at(-1).certainty,status===503?'SENT_UNKNOWN':'DEFINITIVE_REJECTION');
});

for(const variant of ['empty200','empty401','missing401','partial401','utf8','utf8401','echo','echo401'] as const)test(`DeepSeek ${variant} preserves EOF or partial byte evidence without granting retries`,async()=>{
  const status=variant.endsWith('401')?401:200,bytes=variant.startsWith('utf8')?Buffer.from([0xff,0x61]):variant.startsWith('echo')?Buffer.concat([Buffer.from([0xff]),Buffer.from(key)]):variant==='partial401'?Buffer.from('{"error":'):Buffer.alloc(0),events:any[]=[],receipts:any[]=[];let posts=0;
  const response=()=>variant==='missing401'?new Response(null,{status}):variant==='partial401'?new Response(new ReadableStream({start(controller){controller.enqueue(bytes);},pull(controller){controller.error(Error('synthetic partial stream'));}}),{status}):new Response(bytes,{status});
  const expected=['empty200','utf8'].includes(variant)?'RECEIVED_INVALID':'SENT_UNKNOWN';
  await assert.rejects(requestDeepSeekJson({},'JSON','deepseek-flash',{apiKey:key},new AbortController().signal,{fetch:async()=>{posts++;return response();},now:()=>new Date(),nonce:()=>'',maxResponseBytes:4096,onProviderReceipt:r=>{receipts.push(r);},onRunEvidence:e=>events.push(e)}),(error:any)=>error.certainty===expected);
  assert.equal(posts,1);assert.equal(events.at(-1).certainty,expected);assert.equal(events.at(-1).receivedBytes,bytes.length);assert.equal(receipts.length,['partial401','missing401'].includes(variant)?0:1);
  if(variant.startsWith('echo')){assert.equal(receipts[0].body,'[omitted: credential echo]');assert.doesNotMatch(JSON.stringify(receipts),/synthetic-deepseek-transport-key|base64/);}if(variant.startsWith('utf8'))assert.deepEqual(Buffer.from(receipts[0].body.base64,'base64'),bytes);
});
