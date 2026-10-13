import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

async function adapter(){const path='../src/main/ai/adapters/openrouter-chat.ts';assert.ok(existsSync(new URL(path,import.meta.url)),'OpenRouter adapter must exist');return import(path);}
test('OpenRouter chat sends the exact model and effective effort with no native DeepSeek parameters',async()=>{
  const {requestOpenRouterJson}=await adapter(),requests:any[]=[],receipts:any[]=[];
  const result=await requestOpenRouterJson({task:'title'},'Return JSON','openai/gpt-6-astra',{apiKey:'or-fixture-key'},new AbortController().signal,{
    fetch:async(url:any,init:any)=>{requests.push({url,init});return new Response(JSON.stringify({id:'gen_fixture',choices:[{finish_reason:'stop',message:{content:'{"title":"test"}'}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:.01}}));},
    now:()=>new Date('2026-10-13T00:00:00.000Z'),nonce:()=>'',maxResponseBytes:10000,effectiveEffort:'max',onProviderReceipt:(r:any)=>receipts.push(r),
  });
  assert.equal(requests[0].url,'https://openrouter.ai/api/v1/chat/completions');
  const body=JSON.parse(requests[0].init.body);assert.equal(body.model,'openai/gpt-6-astra');assert.deepEqual(body.reasoning,{effort:'max'});assert.equal(body.thinking,undefined);
  assert.equal(new Headers(requests[0].init.headers).get('authorization'),'Bearer or-fixture-key');
  assert.deepEqual(result.content,{title:'test'});assert.equal(receipts.length,1);assert.equal(result.usageKnown,true);
});
test('missing usage stays unknown while the response is retained before domain parsing',async()=>{
  const {requestOpenRouterJson}=await adapter(),receipts:any[]=[];
  const result=await requestOpenRouterJson({},'JSON','openai/gpt-6-luna',{apiKey:'or-fixture-key'},new AbortController().signal,{
    fetch:async()=>new Response(JSON.stringify({id:'gen_unknown_usage',choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})),now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,effectiveEffort:'none',onProviderReceipt:(r:any)=>receipts.push(r),
  });
  assert.equal(result.usageKnown,false);assert.equal(receipts.length,1);assert.equal(receipts[0].costUsd,null);
});
test('cancelled callers can retain a late provider result but cannot receive it as adopted output',async()=>{
  const {requestOpenRouterJson}=await adapter(),controller=new AbortController(),receipts:any[]=[];
  await assert.rejects(requestOpenRouterJson({},'JSON','openai/gpt-6-luna',{apiKey:'or-fixture-key'},controller.signal,{
    fetch:async()=>{controller.abort();return new Response(JSON.stringify({id:'gen_late',choices:[{finish_reason:'stop',message:{content:'{}'}}]}));},now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,effectiveEffort:'low',onProviderReceipt:(r:any)=>receipts.push(r),
  }));
  assert.equal(receipts[0].requestId,'gen_late');
});
