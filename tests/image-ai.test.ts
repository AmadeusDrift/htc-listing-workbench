import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutput } from '../src/main/ai/validation.ts';
import { fixture, chat } from './fixtures/listing-ai.ts';

test('image plans keep visible wording separate from the image prompt and cite verified evidence', () => {
  const plan = { kind: 'image-plan', prompt: 'Photograph the supplied coaster on a plain white background.', textMode: 'none', expectedText: [] };
  assert.deepEqual(validateOutput(plan), plan);
});

test('US image plans reject non-English overlay text before paying the image provider', () => {
  assert.throws(() => validateOutput({ kind: 'image-plan', prompt: 'Show material.', textMode: 'planned', expectedText: [{ text: '硅胶', evidenceIds: ['material'] }] }));
});

test('already validated listing copy receives an independent review before images', async t => {
  const f = await fixture(t);
  const draft = f.amazon.saveDraft({ id: f.draft.id, revision: f.draft.revision, attributes: { item_name: [{ value: 'Blue Silicone Coaster' }], material: [{ value: 'Silicone' }], color: [{ value: 'Blue' }] } });
  f.respond(payload => chat({ kind: 'amazon-fields-review', verdict: 'PASS', checks: payload.candidate.candidates.flatMap((item: any) => item.items.map((value: any, index: number) => {
    const evidenceIds = payload.evidence.filter((evidence: any) => ['material','color','item_shape','care_instructions'].includes(item.field) ? evidence.meaning === item.field : true).map((evidence: any) => evidence.id);
    return { field: item.field, index, verdict: 'SUPPORTED', evidenceIds, reason: 'Supported by original facts.', claims: [{ text: value.value, verdict: 'SUPPORTED', evidenceIds, reason: 'Supported by original facts.' }] };
  })), issues: [] }));
  assert.equal(typeof (f.listing as any).reviewCurrentForImages, 'function');
  const result = await f.listing.reviewCurrentForImages({ draftId: draft.id, draftRevision: draft.revision });
  assert.equal(result.review.providerId, 'deepseek-review');
  assert.equal(result.review.output.kind, 'listing-current-review');
  assert.equal(result.review.output.verdict, 'PASS');
  assert.equal(f.requests.length, 1);
  assert.equal(f.amazon.getDraft(f.draft.id).revision, draft.revision);
});
