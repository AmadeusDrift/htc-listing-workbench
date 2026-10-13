import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
async function adapter(){const path='../src/main/ai/adapters/openrouter-decisions.ts';assert.ok(existsSync(new URL(path,import.meta.url)),'Decisions adapter must exist');return import(path);}
test('Decisions sends state/questions and validates a real candidate answer',async()=>{
  const {requestOpenRouterDecisions}=await adapter(),requests:any[]=[],receipts:any[]=[];
  const result=await requestOpenRouterDecisions('openai/gpt-6-luna-decisions',{product:'Coaster'},{category:{type:'choice',criteria:{COASTER:'Coaster',TOY:'Toy'},instructions:'Choose a real supplied category'}},{apiKey:'or-fixture-key'},new AbortController().signal,{fetch:async(url:any,init:any)=>{requests.push({url,init});return new Response(JSON.stringify({id:'gen_decision',answers:{category:{type:'choice',choice:'COASTER',probabilities:{COASTER:.9,TOY:.1},confidence:.9}},usage:{input_tokens:12,output_tokens:0,cost:.0001}}));},now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,onProviderReceipt:(r:any)=>receipts.push(r)});
  assert.equal(requests[0].url,'https://openrouter.ai/api/alpha/decisions');const body=JSON.parse(requests[0].init.body);assert.ok(body.state);assert.ok(body.questions);assert.equal(body.messages,undefined);
  assert.equal(result.answers.category.choice,'COASTER');assert.equal(result.usageKnown,true);assert.equal(receipts.length,1);
});
test('Decisions cannot introduce a candidate outside supplied criteria',async()=>{
  const {requestOpenRouterDecisions}=await adapter();
  await assert.rejects(requestOpenRouterDecisions('openai/gpt-6-luna-decisions','state',{category:{type:'choice',criteria:{COASTER:null},instructions:'Choose'}},{apiKey:'or-fixture-key'},new AbortController().signal,{fetch:async()=>new Response(JSON.stringify({answers:{category:{type:'choice',choice:'INVENTED'}}})),now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000}));
});
