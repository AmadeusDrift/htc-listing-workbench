import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, candidateFor, chat, reviewFor, saveInput } from './fixtures/listing-ai.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { assertListingHistory } from '../src/main/listing-ai/history.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';

const issue = (field: string, code = '90220') => ({ code, message: `Missing ${field}`, severity: 'ERROR' as const, attributeNames: [field], autoFixable: false, source: 'amazon' as const, category: 'field' as const });

test('disabled completion adopts grounded fields with explicit skipped provenance and no reviewer request', async t => {
  const f = await fixture(t), listing = new ListingAiService(f.store, f.amazon, f.ai, () => false);
  let previews = 0;
  f.amazon.previewDraft = async () => ({ ...f.amazon.getDraft(f.draft.id), state: ++previews === 1 ? 'BLOCKED' : 'AMAZON_VALIDATED', previewIssues: previews === 1 ? [issue('material')] : [] });
  const result = await listing.complete(f.reference);
  assert.equal(result.aiCalls, 1); assert.equal(f.requests.length, 1); assert.deepEqual(result.remaining, []);
  assert.equal((result.draft.attributes.material as any)[0].value, 'Silicone');
  assert.equal(result.draft.fieldAdoptions?.[0].reviewResultId, null);
  assert.equal(result.draft.fieldAdoptions?.[0].reviewDisposition, 'SKIPPED_DISABLED');
  assert.equal(f.ai.getUsageSummary('deepseek-review').attempts, 0);
  assert.ok(f.requests.every(request => !JSON.parse(request.messages[1].content).candidate));
  assertListingHistory(JSON.parse(JSON.stringify(result.draft)), new Map(f.ai.listResults(f.product.id).map(result => [result.id, result])), new Map(f.ai.listCalls().map(call => [call.id, call])));
});

test('disabled adoption bypasses an old rejection while preserving it and cannot be replayed as reviewed after enabling', async t => {
  const f = await fixture(t); let enabled = true;
  const listing = new ListingAiService(f.store, f.amazon, f.ai, () => enabled), suggestion = await listing.suggest(f.reference);
  f.respond(payload => chat({ ...reviewFor(payload), verdict: 'NEEDS_CHANGES', issues: [{ field: 'material', message: 'Confirm material wording.' }] }));
  const rejection = await listing.review({ ...f.reference, suggestionResultId: suggestion.id });
  const input = { ...f.reference, suggestionResultId: suggestion.id, reviewResultId: null, fields: ['material'] };
  await assert.rejects(listing.adopt(input), /复核/);
  enabled = false;
  const draft = await listing.adopt(input);
  assert.equal(draft.fieldAdoptions?.[0].reviewDisposition, 'SKIPPED_DISABLED');
  assert.equal(draft.fieldAdoptions?.[0].reviewResultId, null);
  assert.deepEqual(f.ai.getResult(rejection.id), rejection);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await listing.adopt(input), draft);
  enabled = true;
  await assert.rejects(listing.adopt(input), /草稿|修改|审核/);
  assert.equal(f.ai.getResult(rejection.id)?.output.kind, 'amazon-fields-review');
});

test('disabled completion ignores historic model review issues and keeps actual Amazon submission errors', async t => {
  const f = await fixture(t), listing = new ListingAiService(f.store, f.amazon, f.ai, () => false), get = f.amazon.getDraft.bind(f.amazon);
  f.amazon.wasSubmissionRejected = () => true;
  f.amazon.getDraft = id => ({ ...get(id), listingIssues: [issue('product_description', 'CONTENT_REVIEW'), issue('material')] });
  f.amazon.previewDraft = async () => ({ ...f.amazon.getDraft(f.draft.id), state: 'AMAZON_VALIDATED', previewIssues: [] });
  const result = await listing.complete(f.reference);
  assert.equal(result.aiCalls, 1); assert.deepEqual(result.remaining, []);
  assert.deepEqual(JSON.parse(f.requests[0].messages[1].content).fields.map((field: any) => field.name), ['material']);
  assert.equal(f.ai.getUsageSummary('deepseek-review').attempts, 0);
});

test('disabled review keeps invalid candidate evidence out of adopted fields', async t => {
  const f = await fixture(t), listing = new ListingAiService(f.store, f.amazon, f.ai, () => false);
  f.amazon.previewDraft = async () => ({ ...f.amazon.getDraft(f.draft.id), state: 'BLOCKED', previewIssues: [issue('color')] });
  f.respond(payload => {
    const candidate = candidateFor(payload);
    candidate.candidates[0].items[0] = { value: 'Green', evidenceIds: [payload.evidence.find((entry: any) => entry.meaning === 'material').id], transformation: 'translate' };
    return chat(candidate);
  });
  const result = await listing.complete(f.reference);
  assert.equal(result.draft.fieldAdoptions?.length ?? 0, 0);
  assert.ok(result.remaining.some(value => value.includes('矛盾')));
  assert.equal(f.ai.getUsageSummary('deepseek-review').attempts, 0);
});

test('disabled explicit reviewer endpoints and old-review repair send no AI requests', async t => {
  const f = await fixture(t), suggestion = await f.listing.suggest(f.reference), listing = new ListingAiService(f.store, f.amazon, f.ai, () => false);
  const before = f.requests.length;
  await assert.rejects(listing.review({ ...f.reference, suggestionResultId: suggestion.id }), /审核.*关闭|复核.*关闭/);
  await assert.rejects(listing.reviewCurrentForImages(f.reference), /审核.*关闭|复核.*关闭/);
  const repaired = await listing.repairCurrentForImages({ ...f.reference, reviewResultId: suggestion.id });
  assert.equal(repaired.aiCalls, 0); assert.equal(repaired.review, undefined); assert.equal(repaired.blocked, false); assert.deepEqual(repaired.remaining, []);
  assert.equal(f.requests.length, before); assert.equal(repaired.draft.revision, f.draft.revision);
});

test('current image copy can be snapshotted without AI and still checks freshness and cancellation', async t => {
  const f = await fixture(t), listing = new ListingAiService(f.store, f.amazon, f.ai, () => false);
  const draft = f.amazon.saveDraft({ id: f.draft.id, revision: f.draft.revision, attributes: { item_name: [{ value: 'Blue Silicone Coaster' }] } });
  const reference = { draftId: draft.id, draftRevision: draft.revision }, snapshot = await listing.snapshotCurrentForImages(reference);
  assert.deepEqual(snapshot.currentListingCopy, [{ field: 'item_name', values: ['Blue Silicone Coaster'] }]);
  assert.equal(snapshot.context.draftRevision, draft.revision); assert.equal(f.requests.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listing.snapshotCurrentForImages(reference, controller.signal), { name: 'AbortError' });
  const getSchema = f.amazon.getSchema.bind(f.amazon);
  f.amazon.getSchema = async input => {
    f.store.saveProduct({ ...saveInput(f.product), description: 'Changed while reading schema' });
    return getSchema(input);
  };
  await assert.rejects(listing.snapshotCurrentForImages(reference), /更新|变化/);
  assert.equal(f.requests.length, 0);
});

test('changing the review switch during generation stops adoption before a reviewer call', async t => {
  const f = await fixture(t); let enabled = false;
  const listing = new ListingAiService(f.store, f.amazon, f.ai, () => enabled);
  f.amazon.previewDraft = async () => ({ ...f.amazon.getDraft(f.draft.id), state: 'BLOCKED', previewIssues: [issue('material')] });
  f.respond(payload => { enabled = true; return chat(payload.candidate ? reviewFor(payload) : candidateFor(payload)); });
  await assert.rejects(listing.complete(f.reference));
  assert.equal(f.requests.length, 1); assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length ?? 0, 0);
});

test('skipped history is distinct from old optional-review policy and rejects altered provenance', async t => {
  const f = await fixture(t), listing = new ListingAiService(f.store, f.amazon, f.ai, () => false), suggestion = await listing.suggest(f.reference);
  const draft = await listing.adopt({ ...f.reference, suggestionResultId: suggestion.id, reviewResultId: null, fields: ['material'] });
  const results = new Map(f.ai.listResults(f.product.id).map(result => [result.id, result])), calls = new Map(f.ai.listCalls().map(call => [call.id, call]));
  const legacySuggestion = structuredClone(suggestion), legacyDraft = structuredClone(draft);
  legacySuggestion.listingContext!.policyVersion = 'haul-us-copy-2026-10-06-v1';
  legacySuggestion.sourceSha256 = listingFingerprint(legacySuggestion.listingContext);
  legacyDraft.fieldAdoptions![0].contextSha256 = legacySuggestion.sourceSha256;
  assert.doesNotThrow(() => assertListingHistory(legacyDraft, new Map(results).set(suggestion.id, legacySuggestion), calls));
  for (const mutate of [
    (value: typeof draft) => { delete value.fieldAdoptions![0].reviewDisposition; },
    (value: typeof draft) => { Object.assign(value.fieldAdoptions![0], { reviewDisposition: 'PASS' }); },
    (value: typeof draft) => { value.fieldAdoptions![0].reviewResultId = suggestion.id; },
    (value: typeof draft) => { value.fieldAdoptions![0].changes[0].evidence[0].value = 'Cotton'; },
  ]) {
    const value = structuredClone(draft); mutate(value);
    assert.throws(() => assertListingHistory(value, results, calls));
  }
});
