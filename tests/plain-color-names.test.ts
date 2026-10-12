import { confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, saveInput, chat } from './fixtures/listing-ai.ts';
import { parseFullGeneration, nativeCandidateIssues } from '../src/main/listing-ai/full-schema.ts';
import { assertListingHistory } from '../src/main/listing-ai/history.ts';

test('plain generated colors preserve original response and accept source-grounded PinkWhite',async t=>{
  const f=await fixture(t);
  const context=f.listing.currentContext(f.draft,f.product,0);
  context.evidence=[{id:'pink',name:'颜色',meaning:'color',source:'source_confirmed',value:'樱花粉'}];
  const raw={kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'color',nativeValue:[{value:'Sakura',marketplace_id:f.draft.marketplaceId}],evidenceIds:['pink'],transformation:'translate'}],missing:[]};
  const output=parseFullGeneration(raw,context);
  assert.equal(output.candidates[0].items[0].value,'Pink');
  assert.equal((raw.candidates[0].nativeValue[0]).value,'Sakura');
  assert.equal(nativeCandidateIssues(output,context).filter(i=>i.code==='SOURCE_VALUE_CONFLICT').length,0);
  context.evidence[0].value='粉色+白色';
  raw.candidates[0].nativeValue[0].value='PinkWhite';
  assert.equal(nativeCandidateIssues(parseFullGeneration(raw,context),context).filter(i=>i.code==='SOURCE_VALUE_CONFLICT').length,0);
});

test('generation prompt and adoption use Pink without changing supplier identity or saved response',async t=>{
  const f=await fixture(t);
  const product=f.store.saveProduct({...saveInput(f.product),variants:saveInput(f.product).variants.map(v=>({...v,originalSpec:'樱花粉',normalizedSpec:'樱花粉'}))});
  await confirmSourceConsistencyFixture(f.directory,f.store,product.id);
  const draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  f.ai.saveFunctionSettings({id:'deepseek-review',model:'deepseek-v4-pro',enabled:false});
  f.respond(_payload=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'color',nativeValue:[{value:'Sakura',marketplace_id:draft.marketplaceId}],evidenceIds:[`${draft.variantId}:spec`],transformation:'translate'}],missing:[]}));
  const reference={draftId:draft.id,draftRevision:draft.revision};
  const suggestion=await f.listing.suggest(reference);
  assert.match(f.requests[0].messages[0].content,/ordinary.*color/i);
  const adopted=await f.listing.adopt({...reference,suggestionResultId:suggestion.id,reviewResultId:null,fields:['color']});
  assert.equal((adopted.attributes.color as any)[0].value,'Pink');
  assert.equal(f.store.getProduct(product.id).variants[0].originalSpec,'樱花粉');
  assert.doesNotThrow(()=>assertListingHistory(adopted,new Map(f.ai.listResults(product.id).map(r=>[r.id,r])),new Map(f.ai.listCalls().map(c=>[c.id,c]))));
});

test('existing mutable drafts normalize only color value leaves during local validation',async t=>{
  const f=await fixture(t);
  const draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,color:[{value:'Cherry Blossom Pink',marketplace_id:f.draft.marketplaceId}],item_name:[{value:'Sakura coaster',marketplace_id:f.draft.marketplaceId}]}});
  const validated=await f.amazon.validateDraft({id:draft.id,revision:draft.revision});
  assert.equal((validated.attributes.color as any)[0].value,'Pink');
  assert.equal((validated.attributes.item_name as any)[0].value,'Sakura coaster');
});


test('ordinary, complex and unknown colors are retained without branding or rejection guesses',async()=>{
  const {plainColorName,plainColorValue}=await import('../src/main/listing-ai/plain-colors.ts');
  for(const value of ['Pink','Blue','PinkWhite','Sage Green','Pine Needle Green','Luminous Natural','Spring Tea','Unknown Supplier Shade','Sakura'])assert.equal(plainColorName(value),value);
  assert.equal(plainColorName('Sakura',['樱花粉']), 'Pink');
  assert.equal(plainColorName('Sakura',['蓝色']), 'Sakura');
  assert.deepEqual(plainColorValue([{value:'Cherry Blossom Pink',language_tag:'en_US',marketplace_id:'Sakura'}]),[{value:'Pink',language_tag:'en_US',marketplace_id:'Sakura'}]);
});

test('legacy evidence accepts ordinary Pink and joined genuine multicolor without losing source constraints',async()=>{
  const {supportsColorClaims}=await import('../src/main/listing-ai/sku-colors.ts');
  const evidence:any=[{id:'v:spec',name:'Selected SKU specification',meaning:'general',source:'selected_sku',value:'樱花粉'}];
  assert.equal(supportsColorClaims('Pink',evidence,true),true);
  evidence[0].value='粉色+白色';
  assert.equal(supportsColorClaims('PinkWhite',evidence,true),true);
  assert.equal(supportsColorClaims('PinkBlue',evidence,true),false);
  assert.equal(supportsColorClaims('Pink',evidence,true),false);
});
