import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/listing-ai.ts';
import { assertListingHistory } from '../src/main/listing-ai/history.ts';
import { assertListingEvidence, listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { CATEGORY_INFERENCE_POLICY_VERSION } from '../src/shared/listing-ai-contracts.ts';
import { wrapCandidateValues } from '../src/main/amazon/field-mapping.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';
import { join } from 'node:path';
import type { AiCall, AiResult } from '../src/shared/ai-contracts.ts';
import type { AmazonDraft } from '../src/shared/amazon-contracts.ts';
import type { BusinessRuleReport } from '../src/shared/listing-rules.ts';
import type { TestContext } from 'node:test';

const OPTIONAL_REVIEW_POLICY = 'haul-us-copy-2026-10-07-v2';
async function history(t: TestContext, policy = OPTIONAL_REVIEW_POLICY, reviewed = false) {
  const f = await fixture(t), suggestion = structuredClone(await f.listing.suggest(f.reference));
  const review = reviewed ? structuredClone(await f.listing.review({ ...f.reference, suggestionResultId: suggestion.id })) : null;
  if (!suggestion.listingContext || suggestion.output.kind !== 'amazon-fields') throw Error('Expected listing fields');
  suggestion.listingContext.policyVersion = policy;
  suggestion.sourceSha256 = listingFingerprint(suggestion.listingContext);
  if (review) { review.listingContext = structuredClone(suggestion.listingContext); review.sourceSha256 = suggestion.sourceSha256; }
  const candidate = suggestion.output.candidates.find(item => item.field === 'material')!;
  const draft = structuredClone(f.draft), before = draft.attributes.material ?? null;
  delete draft.businessRules;
  draft.revision += 1;
  draft.attributes.material = wrapCandidateValues(draft.schema, draft.marketplaceId, 'material', candidate.items.map(item => item.value));
  const evidenceIds = new Set(candidate.items.flatMap(item => item.evidenceIds));
  draft.fieldAdoptions = [{
    id: listingFingerprint({ draftId: draft.id, revision: draft.revision - 1, suggestion: suggestion.id, review: review?.id ?? null, fields: ['material'] }),
    at: new Date(Date.parse(review?.createdAt ?? suggestion.createdAt) + 1).toISOString(), suggestionResultId: suggestion.id, reviewResultId: review?.id ?? null,
    contextSha256: suggestion.sourceSha256, fromRevision: draft.revision - 1, toRevision: draft.revision, fields: ['material'],
    changes: [{ field: 'material', before, after: structuredClone(draft.attributes.material), evidence: suggestion.listingContext.evidence.filter(item => evidenceIds.has(item.id)) }],
  }];
  const results = new Map<string, AiResult>([[suggestion.id, suggestion], ...(review ? [[review.id, review] as [string, AiResult]] : [])]);
  const calls = new Map<string, AiCall>(f.ai.listCalls().map(call => [call.id, call]));
  return { directory: f.directory, draft, suggestion, review, results, calls };
}

test('v2 adoption without a review survives a JSON round trip with a null review hash', async t => {
  const h = await history(t);
  assert.doesNotThrow(() => assertListingHistory(JSON.parse(JSON.stringify(h.draft)), h.results, h.calls));
  const invalid = structuredClone(h.draft);
  invalid.fieldAdoptions![0].id = listingFingerprint({ draftId: h.draft.id, revision: 1, suggestion: h.suggestion.id, review: '', fields: ['material'] });
  assert.throws(() => assertListingHistory(invalid, h.results, h.calls));
});

test('legacy adoption history remains restorable while current and versioned records reject SKU contradictions',async t=>{
  const h=await history(t),suggestion=h.suggestion,c=suggestion.listingContext!;
  if(suggestion.output.kind!=='amazon-fields')throw Error('Expected fields');
  const spec=c.evidence.find(e=>e.source==='selected_sku'&&e.name==='Selected SKU specification')!;
  spec.value='颜色: 佳洁净808（中毛） · 1 pc';
  const title=suggestion.output.candidates.find(item=>item.field==='item_name')!;
  title.items=[{value:'Manual Toothbrush with Soft Bristles, Medium Bristle Head',evidenceIds:[spec.id],transformation:'compose'}];
  suggestion.output.candidates=suggestion.output.candidates.filter(item=>['item_name','material'].includes(item.field));
  const refresh=()=>{suggestion.sourceSha256=listingFingerprint(c);h.draft.fieldAdoptions![0].contextSha256=suggestion.sourceSha256;};refresh();
  assert.throws(()=>assertListingEvidence(suggestion.output as any,c),'new output always uses current consistency rules');
  assert.doesNotThrow(()=>assertListingHistory(h.draft,h.results,h.calls),'old recorded evidence and values remain readable');
  c.categoryInferencePolicyVersion=CATEGORY_INFERENCE_POLICY_VERSION;refresh();
  assert.throws(()=>assertListingHistory(h.draft,h.results,h.calls),'versioned output cannot bypass consistency rules');
  delete c.categoryInferencePolicyVersion;
  c.fields.push({name:'power_source_type',title:'Power',requirement:'required',closedEnum:false,allowedValues:[],suggestedValues:[]});refresh();
  assert.throws(()=>assertListingHistory(h.draft,h.results,h.calls),'a new category field without its marker is not legacy history');
});

test('legacy policies still require the exact successful PASS review and valid audit ID', async t => {
  const h = await history(t, 'haul-us-copy-2026-10-06-v1', true);
  assertListingHistory(h.draft, h.results, h.calls);
  for (const mutate of [
    (draft: AmazonDraft) => { draft.fieldAdoptions![0].reviewResultId = null; draft.fieldAdoptions![0].id = listingFingerprint({ draftId: draft.id, revision: 1, suggestion: h.suggestion.id, review: null, fields: ['material'] }); },
    (draft: AmazonDraft) => { draft.fieldAdoptions![0].reviewResultId = 'missing-review'; },
    (draft: AmazonDraft) => { draft.fieldAdoptions![0].contextSha256 = '0'.repeat(64); },
  ]) {
    const draft = structuredClone(h.draft); mutate(draft); assert.throws(() => assertListingHistory(draft, h.results, h.calls));
  }
  const review = structuredClone(h.review!); if (review.output.kind !== 'amazon-fields-review') throw Error('Expected review');
  review.output.verdict = 'BLOCKED';
  assert.throws(() => assertListingHistory(h.draft, new Map(h.results).set(review.id, review), h.calls));
  assert.throws(() => assertListingHistory(h.draft, h.results, new Map([...h.calls].filter(([id]) => id !== review.callId))));
});

test('unreviewed adoption is not allowed for unknown future or legacy policies', async t => {
  const h = await history(t);
  for (const policy of ['haul-us-copy-2026-10-06-v1', 'future-policy-v3']) {
    const suggestion = structuredClone(h.suggestion), draft = structuredClone(h.draft);
    suggestion.listingContext!.policyVersion = policy; suggestion.sourceSha256 = listingFingerprint(suggestion.listingContext);
    draft.fieldAdoptions![0].contextSha256 = suggestion.sourceSha256;
    assert.throws(() => assertListingHistory(draft, new Map([[suggestion.id, suggestion]]), h.calls));
  }
});

test('optional review never relaxes source context, call, candidate value or evidence integrity', async t => {
  const h = await history(t);
  for (const mutate of [
    (draft: AmazonDraft) => { draft.productId = '00000000-0000-4000-8000-000000000000'; },
    (draft: AmazonDraft) => { draft.fieldAdoptions![0].changes[0].after = [{ value: 'Cotton' }]; },
    (draft: AmazonDraft) => { draft.fieldAdoptions![0].changes[0].evidence[0].value = '棉'; },
    (draft: AmazonDraft) => { draft.fieldAdoptions![0].fromRevision = 0; },
    (draft: AmazonDraft) => { Object.assign(draft.fieldAdoptions![0].changes[0], { apiKey: 'must-not-enter-history' }); },
  ]) {
    const draft = structuredClone(h.draft); mutate(draft); assert.throws(() => assertListingHistory(draft, h.results, h.calls));
  }
  assert.throws(() => assertListingHistory(h.draft, new Map(), h.calls));
  assert.throws(() => assertListingHistory(h.draft, h.results, new Map()));
  const call = h.calls.get(h.suggestion.callId)!;
  assert.throws(() => assertListingHistory(h.draft, h.results, new Map(h.calls).set(call.id, { ...call, status: 'FAILED', errorCode: 'PROVIDER_ERROR' })));
});

function report(draft: AmazonDraft): BusinessRuleReport {
  return { revision: 4, fields: { material: { value: draft.attributes.material!, reason: '明确材质来源换算' } }, notices: ['包装参数尚待核实'], bundleQuantity: 1,
    quote: { price: 2.6, minimum: 2.5, roi: 1.3, deliveryFee: 0.5, commission: 0.39, upfrontCny: 2.3, dimensionalWeightGrams: 25, billableWeightGrams: 100, promotionPrice: 2.5, promotionRoi: 1.1 } };
}

test('business-rule snapshots preserve reasons, notices and quote even after manual field edits', async t => {
  const h = await history(t, OPTIONAL_REVIEW_POLICY, true), draft = structuredClone(h.draft); draft.businessRules = report(draft);
  draft.attributes.material = [{ value: 'Manual change' }];
  assertListingHistory(JSON.parse(JSON.stringify(draft)), h.results, h.calls);
  draft.businessRules.quote = null; draft.businessRules.fields = {}; draft.businessRules.notices = [];
  assertListingHistory(draft, h.results, h.calls);
});

test('pricing basis preserves source sale units and automatic bundles without rewriting old snapshots', async t => {
  const h = await history(t);
  for (const pricingBasis of [
    { kind: 'source_sale_unit', sourceCostCny: 0.7, quantity: 1, saleUnitCostCny: 0.7 },
    { kind: 'auto_bundle', sourceCostCny: 0.1, quantity: 10, saleUnitCostCny: 1 },
    { kind: 'auto_bundle', sourceCostCny: 0.1, quantity: 3, saleUnitCostCny: 0.30000000000000004 },
  ]) {
    const draft = structuredClone(h.draft);
    draft.businessRules = Object.assign(report(draft), { pricingBasis });
    const roundTrip = JSON.parse(JSON.stringify(draft));
    assertListingHistory(roundTrip, h.results, h.calls);
    assert.deepEqual(roundTrip.businessRules.pricingBasis, pricingBasis);
    draft.businessRules.quote = null;
    assertListingHistory(draft, h.results, h.calls);
  }
  const legacy = structuredClone(h.draft); legacy.businessRules = report(legacy);
  assertListingHistory(legacy, h.results, h.calls);
  assert.equal(Object.hasOwn(legacy.businessRules, 'pricingBasis'), false);
});

test('pricing basis rejects hidden fields, nonfinite costs, invalid counts and inconsistent unit math', async t => {
  const h = await history(t), valid = { kind: 'auto_bundle', sourceCostCny: .1, quantity: 10, saleUnitCostCny: 1 };
  for (const pricingBasis of [
    null, [], {}, { ...valid, token: 'not-for-backup' }, { ...valid, kind: 'future_basis' },
    { ...valid, sourceCostCny: 0 }, { ...valid, sourceCostCny: -1 }, { ...valid, sourceCostCny: Infinity },
    { ...valid, saleUnitCostCny: NaN }, { ...valid, saleUnitCostCny: 0 }, { ...valid, saleUnitCostCny: .1 },
    { ...valid, sourceCostCny: 1e308, saleUnitCostCny: 1e308, quantity: 1000 },
    { ...valid, quantity: 0 }, { ...valid, quantity: 1 }, { ...valid, quantity: 1.5 }, { ...valid, quantity: 1001 },
    { ...valid, kind: 'source_sale_unit' },
  ]) {
    const draft = structuredClone(h.draft); draft.businessRules = Object.assign(report(draft), { pricingBasis, quote: null });
    assert.throws(() => assertListingHistory(draft, h.results, h.calls));
  }
});

test('business-rule snapshots reject unbounded, malformed and hidden metadata before backup', async t => {
  const h = await history(t, OPTIONAL_REVIEW_POLICY, true);
  const invalid: unknown[] = [
    null, [], { ...report(h.draft), apiKey: 'must-not-enter-backup' }, { ...report(h.draft), revision: -1 },
    { ...report(h.draft), bundleQuantity: 0 }, { ...report(h.draft), bundleQuantity: 1.5 },
    { ...report(h.draft), fields: { unknown_field: { value: true, reason: 'Unknown' } } },
    { ...report(h.draft), fields: { material: { value: [], reason: '', extra: 'not-allowed' } } },
    { ...report(h.draft), fields: { material: { value: [{ value: Infinity }], reason: 'Non-finite' } } },
    { ...report(h.draft), fields: { material: { value: [], reason: 'x'.repeat(4001) } } },
    { ...report(h.draft), notices: [false] }, { ...report(h.draft), notices: ['x'.repeat(4001)] },
    { ...report(h.draft), quote: { ...report(h.draft).quote, price: Infinity } },
    { ...report(h.draft), quote: { ...report(h.draft).quote, price: -1 } },
    { ...report(h.draft), quote: { ...report(h.draft).quote, promotionPrice: null } },
    { ...report(h.draft), quote: { ...report(h.draft).quote, token: 'must-not-enter-backup' } },
  ];
  for (const businessRules of invalid) assert.throws(() => assertListingHistory({ ...h.draft, businessRules } as AmazonDraft, h.results, h.calls));
});

test('a v2 unreviewed adoption and business-rule snapshot survive encrypted backup restore', async t => {
  const h = await history(t); h.draft.businessRules = Object.assign(report(h.draft), {
    bundleQuantity: 10, pricingBasis: { kind: 'auto_bundle' as const, sourceCostCny: 0.1, quantity: 10, saleUnitCostCny: 1 },
  });
  const db = openDatabase(h.directory);
  try {
    const record = JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(h.draft.id)!.record_json));
    record.draft = h.draft; record.request = h.draft.attributes;
    db.prepare('UPDATE listing_drafts SET record_json=?,request_json=? WHERE id=?').run(JSON.stringify(record), JSON.stringify(h.draft.attributes), h.draft.id);
  } finally { db.close(); }
  const backup = join(h.directory, 'history.htcbackup'), restoredDirectory = join(h.directory, 'restored-history');
  await createWorkspaceBackup(h.directory, backup, 'isolated history backup passphrase');
  const prepared = await prepareWorkspaceRestore(restoredDirectory, backup, 'isolated history backup passphrase');
  await commitWorkspaceRestore(restoredDirectory, prepared);
  const restored = openDatabase(restoredDirectory);
  try {
    const record = JSON.parse(String(restored.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(h.draft.id)!.record_json));
    assert.deepEqual(record.draft.fieldAdoptions, h.draft.fieldAdoptions);
    assert.deepEqual(record.draft.businessRules, h.draft.businessRules);
  } finally { restored.close(); }
});
