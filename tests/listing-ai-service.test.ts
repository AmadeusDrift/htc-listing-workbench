import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, candidateFor, chat, saveInput, reviewFor } from './fixtures/listing-ai.ts';
import { validateAiResult } from '../src/main/ai/validation.ts';
test('generation and independent review share the connection and ledger without changing draft',async t=>{
  const f=await fixture(t),suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});
  assert.equal(suggestion.output.kind,'amazon-fields');assert.equal(review.output.kind,'amazon-fields-review');assert.deepEqual(f.amazon.getDraft(f.draft.id),f.draft);
  assert.equal(f.ai.getUsageSummary('deepseek').reportedTokens,150);assert.equal(f.ai.getUsageSummary('deepseek-review').reportedTokens,150);
  assert.equal(f.requests[0].max_tokens,4096);assert.equal(f.requests[1].max_tokens,16384);
  const prompt=JSON.stringify(f.requests[0]);assert.ok(!prompt.includes('PRIVATE_BRAND'));assert.ok(!prompt.includes(f.draft.targetId));assert.ok(!prompt.includes('fixture-shared-listing-key'));
  assert.deepEqual(validateAiResult(suggestion),suggestion);assert.throws(()=>validateAiResult({...suggestion,listingContext:{...suggestion.listingContext,draftRevision:999}}));
});
test('adoption is selective atomic versioned idempotent and allows an incomplete draft',async t=>{
  const f=await fixture(t),suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});
  const input={...f.reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['material' as const]};const draft=await f.listing.adopt(input);
  assert.equal(draft.revision,2);assert.equal((draft.attributes.material as any)[0].value,'Silicone');assert.deepEqual(draft.attributes.item_name,f.draft.attributes.item_name);assert.equal(draft.previewedAt,null);assert.equal(draft.fieldAdoptions?.length,1);assert.equal(draft.state,'BLOCKED');
  assert.deepEqual(await f.listing.adopt(input),draft);
  f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,item_name:[{value:'Manual title',marketplace_id:draft.marketplaceId,language_tag:'en_US'}]}});
  await assert.rejects(f.listing.adopt(input),/草稿|修改/);
});
test('changed source, cross-draft and rejected review cannot be adopted',async t=>{
  const f=await fixture(t),suggestion=await f.listing.suggest(f.reference);
  const other=await f.amazon.createDraft({productId:f.product.id,variantId:f.product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  await assert.rejects(f.listing.review({draftId:other.id,draftRevision:other.revision,suggestionResultId:suggestion.id}));
  f.store.saveProduct({...saveInput(f.product),description:'Changed'});
  await assert.rejects(f.listing.review({...f.reference,suggestionResultId:suggestion.id}));
});
test('invalid output is charged once and limits/cancellation prevent automatic retry',async t=>{
  const f=await fixture(t);f.respond(p=>{const c=candidateFor(p);c.candidates[0].items[0].value='中文';return chat(c);});
  await assert.rejects(f.listing.suggest(f.reference));assert.equal(f.requests.length,1);assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);
  f.ai.setUsagePolicy({providerId:'deepseek',dailyCallLimit:1,dailyTokenLimit:null});await assert.rejects(f.listing.suggest(f.reference));assert.equal(f.requests.length,1);
  f.ai.setUsagePolicy({providerId:'deepseek',dailyCallLimit:null,dailyTokenLimit:null});const controller=new AbortController();controller.abort();await assert.rejects(f.listing.suggest(f.reference,controller.signal));assert.equal(f.requests.length,1);
});

test('an otherwise valid review with omitted words becomes actionable NEEDS_CHANGES and cannot be adopted', async t => {
  const f = await fixture(t);
  f.respond(payload => {
    if (!payload.candidate) return chat(candidateFor(payload));
    const review = reviewFor(payload);
    const check = review.checks.find((c: any) => c.field === 'product_description');
    check.claims[0].text = 'blue silicone';
    return chat(review);
  });
  const suggestion = await f.listing.suggest(f.reference);
  const review = await f.listing.review({ ...f.reference, suggestionResultId: suggestion.id });
  assert.equal(review.output.kind, 'amazon-fields-review');
  if (review.output.kind !== 'amazon-fields-review') throw Error('Unexpected review');
  assert.equal(review.output.verdict, 'NEEDS_CHANGES');
  assert.ok(review.output.issues.some(i => i.field === 'product_description' && /复核.*遗漏/.test(i.message)));
  assert.deepEqual(validateAiResult(review), review);
  await assert.rejects(f.listing.adopt({ ...f.reference, suggestionResultId: suggestion.id, reviewResultId: review.id, fields: ['product_description'] }), /复核发现问题/);
  assert.equal(f.requests.length, 2, 'Incomplete review must not silently send another paid request');
  assert.deepEqual(f.amazon.getDraft(f.draft.id), f.draft);
});
