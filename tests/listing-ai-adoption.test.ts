import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, chat, reviewFor } from './fixtures/listing-ai.ts';

test('image metadata compatibility does not relax listing-field adoption context identity',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw new Error('External network is forbidden in adoption fixtures');});
  const f=await fixture(t),suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});
  const input={...f.reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['material']};
  const before=f.amazon.getDraft(f.draft.id),requests=f.requests.length,context=f.listing.currentContext.bind(f.listing);
  for(const key of ['title','description'] as const){
    const changed=t.mock.method(f.listing,'currentContext',(...args:Parameters<typeof context>)=>{
      const current=context(...args);current.fields[0][key]='Different field metadata';return current;
    });
    await assert.rejects(f.listing.adopt(input),/过期|当前草稿/);changed.mock.restore();
  }
  assert.equal(f.requests.length,requests);assert.deepEqual(f.amazon.getDraft(f.draft.id),before);
});

test('schema refresh or target credential rotation blocks adoption without a paid call or draft mutation', async t => {
  const f = await fixture(t), suggestion = await f.listing.suggest(f.reference), review = await f.listing.review({ ...f.reference, suggestionResultId: suggestion.id });
  const input = { ...f.reference, suggestionResultId: suggestion.id, reviewResultId: review.id, fields: ['material'] };
  const original = f.amazon.getDraft(f.draft.id), requestCount = f.requests.length;
  const schema = structuredClone(f.draft.schema); schema.version += '-updated';
  const schemaMock = t.mock.method(f.amazon, 'getSchema', async () => schema);
  await assert.rejects(f.listing.adopt(input), /规则|更新/);
  schemaMock.mock.restore();
  const scope = f.amazon.executionTargetScope(f.draft.targetId);
  t.mock.method(f.amazon, 'executionTargetScope', () => ({ ...scope, generation: scope.generation + 1 }));
  await assert.rejects(f.listing.adopt(input), /过期|当前草稿/);
  assert.equal(f.requests.length, requestCount);
  assert.deepEqual(f.amazon.getDraft(f.draft.id), original);
});

test('a newer review requiring changes supersedes an earlier PASS', async t => {
  const f = await fixture(t), suggestion = await f.listing.suggest(f.reference), first = await f.listing.review({ ...f.reference, suggestionResultId: suggestion.id });
  f.respond(payload => chat({ ...reviewFor(payload), verdict: 'NEEDS_CHANGES', issues: [{ field: 'item_name', message: 'Confirm product identity before adoption.' }] }));
  const latest = await f.listing.review({ ...f.reference, suggestionResultId: suggestion.id });
  assert.notEqual(latest.id,first.id);assert.notEqual(latest.callId,first.callId);assert.equal(f.requests.length,3);assert.equal((f.ai.getResult(first.id)!.output as any).verdict,'PASS');
  const input = { ...f.reference, suggestionResultId: suggestion.id, fields: ['material'] };
  await assert.rejects(f.listing.adopt({ ...input, reviewResultId: latest.id }), /复核|处理问题/);
  await assert.rejects(f.listing.adopt({ ...input, reviewResultId: first.id }), /更新的复核/);
  assert.deepEqual(f.amazon.getDraft(f.draft.id), f.draft);
});
