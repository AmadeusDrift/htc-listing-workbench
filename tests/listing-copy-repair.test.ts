import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, candidateFor, chat, reviewFor } from './fixtures/listing-ai.ts';
import { wrapCandidateValues } from '../src/main/amazon/field-mapping.ts';

function review(payload: any, fail = false) {
  const candidate = structuredClone(payload.candidate);
  for (const field of candidate.candidates) for (const item of field.items) item.evidenceIds ??= payload.evidence.map((entry: any) => entry.id);
  const result = reviewFor({ ...payload, candidate });
  if (fail) {
    result.verdict = 'NEEDS_CHANGES';
    for (const check of result.checks) { check.verdict = 'UNSUPPORTED'; check.evidenceIds = []; for (const claim of check.claims) { claim.verdict = 'UNSUPPORTED'; claim.evidenceIds = []; } }
    result.issues = [{ field: 'item_name', message: 'Remove the unsupported wording.' }] as any;
  }
  return result;
}
async function rejected(t: test.TestContext) {
  const f = await fixture(t);
  const draft = f.amazon.saveDraft({ id: f.draft.id, revision: f.draft.revision, attributes: { item_name: [{ value: 'Unsupported coaster' }] } });
  f.respond(payload => chat(review(payload, true)));
  const reference = { draftId: draft.id, draftRevision: draft.revision };
  const current = await f.listing.reviewCurrentForImages(reference);
  return { ...f, reference, current };
}

test('current-copy rejection rewrites only reported fields with verified evidence and independent reviews', async t => {
  const f = await rejected(t);
  f.respond(payload => chat(payload.candidate ? review(payload) : candidateFor(payload)));
  const result = await f.listing.repairCurrentForImages({ ...f.reference, reviewResultId: f.current.review.id });
  assert.equal(result.aiCalls, 3); assert.equal(result.review?.review.output.kind, 'listing-current-review');
  assert.equal((result.review?.review.output as any).verdict, 'PASS');
  assert.equal((result.draft.attributes.item_name as any)[0].value, 'Blue Silicone Coaster');
  assert.ok(result.draft.fieldAdoptions?.[0].reviewResultId);
  const payload = JSON.parse(f.requests[1].messages[1].content);
  assert.deepEqual(payload.fields.map((field: any) => field.name), ['item_name']);
  assert.ok(payload.evidence.some((entry: any) => entry.value === '硅胶'));
  assert.equal(payload.repairRequest.issues[0].message, 'Remove the unsupported wording.');
});

test('failed candidate review stays unadopted and its feedback is reusable without another current-copy call', async t => {
  const f = await rejected(t);
  f.respond(payload => chat(payload.candidate ? review(payload, true) : candidateFor(payload)));
  const first = await f.listing.repairCurrentForImages({ ...f.reference, reviewResultId: f.current.review.id });
  assert.equal(first.aiCalls, 2); assert.equal(first.review, undefined); assert.ok(first.feedbackResultId);
  assert.equal(first.draft.revision, f.reference.draftRevision);
  f.respond(payload => chat(payload.candidate ? review(payload) : candidateFor(payload)));
  const second = await f.listing.repairCurrentForImages({ ...f.reference, reviewResultId: f.current.review.id, feedbackResultId: first.feedbackResultId });
  assert.equal(second.aiCalls, 3); assert.equal((second.review?.review.output as any).verdict, 'PASS');
});

test('stale current-copy feedback is rejected before a paid generation', async t => {
  const f = await rejected(t);
  const changed = f.amazon.saveDraft({ id: f.draft.id, revision: f.reference.draftRevision, attributes: { item_name: [{ value: 'Changed coaster' }] } });
  const before = f.requests.length;
  await assert.rejects(f.listing.repairCurrentForImages({ draftId: changed.id, draftRevision: changed.revision, reviewResultId: f.current.review.id }));
  assert.equal(f.requests.length, before);
});

test('a blocked current review does not enter automatic rewriting', async t => {
  const f = await rejected(t);
  f.respond(payload => chat({ ...review(payload, true), verdict:'BLOCKED' }));
  const blocked = await f.listing.reviewCurrentForImages(f.reference), before = f.requests.length;
  const result = await f.listing.repairCurrentForImages({ ...f.reference, reviewResultId:blocked.review.id });
  assert.equal(result.blocked, true); assert.equal(result.aiCalls, 0); assert.equal(f.requests.length, before);
  assert.equal(result.draft.revision, f.reference.draftRevision);
});

test('missing verified facts stop a round without adopting or inventing a passing review', async t => {
  const f = await rejected(t);
  f.respond(() => chat({ kind:'amazon-fields', candidates:[], missing:[{field:'item_name',reason:'No verified facts support a replacement.'}] }));
  const result = await f.listing.repairCurrentForImages({ ...f.reference, reviewResultId:f.current.review.id });
  assert.equal(result.blocked, true); assert.equal(result.aiCalls, 1); assert.equal(result.review, undefined);
  assert.equal(result.draft.revision, f.reference.draftRevision);
  assert.ok(result.remaining.some(value => value.includes('No verified facts')));
});

test('an unchanged evidence-backed candidate still gets independent review without adoption',async t=>{
  const f=await fixture(t);
  const draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{item_name:wrapCandidateValues(f.draft.schema,f.draft.marketplaceId,'item_name',['Blue Silicone Coaster'])}});
  const reference={draftId:draft.id,draftRevision:draft.revision};
  f.respond(payload=>chat(review(payload,true)));
  const rejected=await f.listing.reviewCurrentForImages(reference);
  f.respond(payload=>chat(payload.candidate?review(payload):candidateFor(payload)));
  const result=await f.listing.repairCurrentForImages({...reference,reviewResultId:rejected.review.id});
  assert.equal(result.aiCalls,3);assert.equal((result.review?.review.output as any).verdict,'PASS');
  assert.equal(result.draft.revision,draft.revision);assert.equal(result.draft.fieldAdoptions?.length??0,0);
  assert.equal(f.requests.filter(request=>JSON.parse(request.messages[1].content).operation==='listing-current-review').length,2);
});
