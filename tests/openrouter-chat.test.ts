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
  const body=JSON.parse(requests[0].init.body);assert.equal(body.model,'openai/gpt-6-astra');assert.deepEqual(body.reasoning,{effort:'max'});assert.equal(body.thinking,undefined);assert.deepEqual(body.provider,{allow_fallbacks:true,require_parameters:true});assert.equal(body.models,undefined);
  assert.equal(new Headers(requests[0].init.headers).get('X-OpenRouter-Metadata'),'enabled');
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

test('OpenRouter region refusals are distinct from invalid credentials and never trigger a second POST',async()=>{
 const {requestOpenRouterJson}=await adapter();
 for(const [status,message,code] of [[403,'This model is not available in your region.','MODEL_REGION_RESTRICTED'],[403,'Forbidden','ROUTING_FORBIDDEN'],[401,'Unauthorized','AUTH_FAILED'],[402,'Insufficient credits','QUOTA_EXCEEDED']] as const){
  let posts=0;const receipts:any[]=[];
  await assert.rejects(requestOpenRouterJson({},'JSON','openai/gpt-6-luna',{apiKey:'or-fixture-key'},new AbortController().signal,{fetch:async()=>{posts++;return Response.json({error:{message,code:status}},{status});},now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,effectiveEffort:'none',onProviderReceipt:(r:any)=>{receipts.push(r);}}),(e:any)=>e.code===code&&e.httpStatus===status&&e.definitive===true&&!e.message.includes('Forbidden'));
  assert.equal(posts,1);assert.equal(receipts[0].body.error.message,message);
 }
});

test('known no-provider refusals explain routing without broad 404 or secret-echo classification',async()=>{
 const {requestOpenRouterJson}=await adapter();
 for(const [status,message,code] of [[404,'No allowed providers are available for the selected model.','ROUTING_FORBIDDEN'],[404,'No endpoints found that support the requested parameters.','ROUTING_FORBIDDEN'],[503,'No available providers found for the selected model.','ROUTING_FORBIDDEN'],[404,'Resource not found','PROVIDER_ERROR'],[503,'Upstream unavailable','PROVIDER_ERROR'],[404,'No endpoints found that support or-fixture-key','PROVIDER_ERROR']] as const){
  let posts=0;
  await assert.rejects(requestOpenRouterJson({},'JSON','openai/gpt-6-luna',{apiKey:'or-fixture-key'},new AbortController().signal,{fetch:async()=>{posts++;return Response.json({error:{message,code:status}},{status});},now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,effectiveEffort:'none'}),(e:any)=>e.code===code&&!e.message.includes('or-fixture-key')&&(code!=='ROUTING_FORBIDDEN'||e.message.includes('可用提供商')));
  assert.equal(posts,1);
 }
});
