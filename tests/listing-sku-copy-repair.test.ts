import { confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,saveInput,chat} from './fixtures/listing-ai.ts';
import {ListingAiService} from '../src/main/listing-ai/service.ts';

for(const example of [
  {spec:'Blue children toothbrush with hard bristles',before:'Adult Toothbrush with Soft Bristles',after:'Children Toothbrush with Hard Bristles'},
  {spec:'Blue toothbrush with medium bristles',before:'Manual Toothbrush with Soft Bristles, Medium Bristle Head',after:'Manual Toothbrush with Medium Bristles'},
])test(`known SKU facts repair existing contradictory copy without an independent review: ${example.spec}`,async t=>{
  const f=await fixture(t),saved=saveInput(f.product);
  const product=f.store.saveProduct({...saved,variants:saved.variants.map(variant=>({...variant,originalSpec:example.spec,normalizedSpec:example.spec}))});
  await confirmSourceConsistencyFixture(f.directory,f.store,product.id);
  let draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  draft=f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,item_name:[{value:example.before,marketplace_id:draft.marketplaceId}]}});
  f.amazon.previewDraft=async input=>({...f.amazon.getDraft((input as {id:string}).id),state:'AMAZON_VALIDATED',previewIssues:[]});
  f.respond(payload=>{
    assert.equal(payload.candidate,undefined,'copy review remains disabled');
    assert.deepEqual(payload.fields.map((field:any)=>field.name),['item_name']);
    const source=payload.evidence.find((evidence:any)=>evidence.name==='Selected SKU specification');
    return chat({kind:'amazon-fields',candidates:[{field:'item_name',items:[{value:example.after,evidenceIds:[source.id],transformation:'compose'}]}],missing:[]});
  });
  const result=await new ListingAiService(f.store,f.amazon,f.ai,()=>false).complete({draftId:draft.id,draftRevision:draft.revision});
  assert.equal((result.draft.attributes.item_name as any)[0].value,example.after);assert.deepEqual(result.remaining,[]);
  assert.equal(result.aiCalls,1);assert.equal(f.requests.length,1);assert.equal(result.draft.fieldAdoptions?.at(-1)?.reviewDisposition,'SKIPPED_DISABLED');
});
