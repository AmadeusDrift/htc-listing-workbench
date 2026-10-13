import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/listing-ai.ts';
import { ImageGenerationService } from '../src/main/image-generation/service.ts';
import { mockStorage } from './fixtures/listing-ai.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('real listing AI service uses the purpose OpenRouter key, model, effort and durable receipt',async t=>{
  const f=await fixture(t),requests:{url:string;key:string|null;body:any}[]=[],context=(f.ai as any).context,fetcher=context.fetch;
  context.fetch=async(url:unknown,init:RequestInit)=>{requests.push({url:String(url),key:new Headers(init.headers).get('authorization'),body:JSON.parse(String(init.body))});return fetcher(url,init);};
  f.ai.saveConnection({id:'openrouter',apiKey:'openrouter-fixture-own-key'});
  f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});
  const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_generation')!;
  f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  f.ai.disconnectConnection('deepseek');
  const result=await f.listing.suggest(f.reference);
  assert.equal(requests.length,1);assert.equal(requests[0].url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(requests[0].key,'Bearer openrouter-fixture-own-key');assert.equal(requests[0].body.model,'openai/gpt-6-astra');
  assert.deepEqual(requests[0].body.reasoning,{effort:'high'});assert.equal(result.providerId,'openrouter');assert.equal(result.model,'openai/gpt-6-astra');
  const call=f.ai.listCalls().find(c=>c.id===result.callId)!;
  assert.equal(call.purposeSnapshot?.model,'openai/gpt-6-astra');assert.equal(call.purposeSnapshot?.effectiveEffort,'high');
  const receipt=await f.ai.readProviderReceipt(call.id);assert.ok(receipt);assert.equal(JSON.stringify(receipt).includes('openrouter-fixture-own-key'),false);
});

test('DeepSeek purpose keeps its own credential and sends selected actual reasoning effort',async t=>{
  const f=await fixture(t),context=(f.ai as any).context,fetcher=context.fetch,requests:any[]=[];
  context.fetch=async(url:unknown,init:RequestInit)=>{requests.push({url:String(url),key:new Headers(init.headers).get('authorization'),body:JSON.parse(String(init.body))});return fetcher(url,init);};
  f.ai.saveConnection({id:'deepseek',apiKey:'deepseek-fixture-own-key'});
  const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_generation')!;
  f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'deepseek',model:'deepseek-flash',effort:'max'}});
  const result=await f.listing.suggest(f.reference);
  assert.equal(result.providerId,'deepseek');assert.equal(requests[0].url,'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].key,'Bearer deepseek-fixture-own-key');assert.equal(requests[0].body.reasoning_effort,'max');assert.deepEqual(requests[0].body.thinking,{type:'enabled'});
  const receipt=await f.ai.readProviderReceipt(result.callId) as any;assert.equal(receipt.gateway,'deepseek');assert.equal(receipt.endpoint,'/chat/completions');assert.equal(receipt.model,'deepseek-flash');assert.ok(receipt.body.choices);assert.equal(JSON.stringify(receipt).includes('deepseek-fixture-own-key'),false);
});

test('category selection uses real Decisions wire with the shared OpenRouter credential',async t=>{
  const f=await fixture(t),context=(f.ai as any).context,requests:any[]=[];
  f.ai.saveConnection({id:'openrouter',apiKey:'or-decisions-fixture-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});
  context.fetch=async(url:unknown,init:RequestInit)=>{requests.push({url:String(url),body:JSON.parse(String(init.body))});return new Response(JSON.stringify({id:'gen_decision',answers:{category:{type:'choice',choice:'COASTER'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:50,output_tokens:0,cost:.00001}}));};
  const product=f.store.getProduct(f.product.id),result=await f.ai.decideCategory({productId:product.id,productRevision:product.revision,phase:'select',candidates:[{name:'COASTER',displayName:'Coaster'}]});
  assert.equal(requests[0].url,'https://openrouter.ai/api/alpha/decisions');assert.ok(requests[0].body.questions);assert.ok(Array.isArray(requests[0].body.state));assert.equal(requests[0].body.messages,undefined);
  assert.equal(result.output.productType,'COASTER');assert.equal(result.model,'openai/gpt-6-luna-decisions');assert.equal(f.ai.getUsageSummary('openrouter').reportedTokens,50);
});

test('main-process image connection reuses the OpenRouter key and persists only a credential reference',async t=>{
  let images:ImageGenerationService;t.after(async()=>images?.close());const f=await fixture(t);
  f.ai.saveConnection({id:'openrouter',apiKey:'or-single-shared-fixture-key'});
  images=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:b=>b,fetch:async()=>{throw Error('No request permitted');}});
  images.attachOpenRouterConnection({read:()=>f.ai.openRouterApiKey(),save:apiKey=>f.ai.saveConnection({id:'openrouter',apiKey}),disconnect:()=>f.ai.disconnectConnection('openrouter')});
  assert.equal(images.getConnection().configured,true);
  images.saveConnection({model:'openai/gpt-image-2.5-sunburst',enabled:true});
  const stored=JSON.parse(mockStorage.decryptString(readFileSync(join(f.directory,'ai-vault','openrouter-images.bin'))));
  assert.equal(stored.credentialRef,'openrouter');assert.equal(stored.apiKey,'');assert.equal(JSON.stringify(stored).includes('or-single-shared-fixture-key'),false);
  f.ai.disconnectConnection('openrouter');assert.equal(images.getConnection().configured,false);
});
