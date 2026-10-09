import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readWorkflowCandidatePreview } from '../src/main/image-workflow/preview.ts';
import type { ImageWorkflowRun } from '../src/shared/image-workflow-contracts.ts';
import type { GeneratedImageCandidate } from '../src/shared/image-generation-contracts.ts';

function fixture() {
  const candidateId = randomUUID(), draftId = randomUUID(), productId = randomUUID();
  const input = { draftId, slot: 2, candidateId };
  const run = { id: randomUUID(), draftId, productId, productRevision: 3, slots: [{ index: 2, attempts: [{ candidateId }] }] } as ImageWorkflowRun;
  const candidate = { id: candidateId, productId, productRevision: 3, width: 1024, height: 1536 } as GeneratedImageCandidate;
  const local = { candidate, bytes: Buffer.from('original'), preview: Buffer.from('validated preview') };
  return { input, run, local };
}
test('preview reads only the saved candidate and returns no source paths or original bytes', async () => {
  const f = fixture(), before = structuredClone(f.run), reads: string[] = [];
  const value = await readWorkflowCandidatePreview(f.input, () => f.run, async id => { reads.push(id); return f.local; });
  assert.deepEqual(value, { candidateId: f.input.candidateId, previewUrl: 'data:image/png;base64,' + f.local.preview.toString('base64'), width: 1024, height: 1536 });
  assert.deepEqual(reads, [f.input.candidateId]); assert.deepEqual(f.run, before);
});
test('preview rejects unowned draft, slot and candidate before reading any local candidate', async () => {
  const f = fixture(); let reads = 0;
  for (const input of [{ ...f.input, draftId: randomUUID() }, { ...f.input, slot: 1 }, { ...f.input, candidateId: randomUUID() }, { ...f.input, slot: 8 }, { ...f.input, path: 'C:/private.png' }]) {
    await assert.rejects(readWorkflowCandidatePreview(input, () => f.run, async () => { reads++; return f.local; }));
  }
  assert.equal(reads, 0);
});
test('preview rejects mismatched product, revision or candidate identity in saved files', async () => {
  for (const change of [{ productId: randomUUID() }, { productRevision: 4 }, { id: randomUUID() }]) {
    const f = fixture(); Object.assign(f.local.candidate, change);
    await assert.rejects(readWorkflowCandidatePreview(f.input, () => f.run, async () => f.local), /候选记录已变化/);
  }
});
test('preview rejects a replaced workflow while the local candidate was loading', async () => {
  const f = fixture(); let current = f.run;
  await assert.rejects(readWorkflowCandidatePreview(f.input, () => current, async () => { current = { ...f.run, id: randomUUID() }; return f.local; }), /候选记录已变化/);
});
test('missing local candidate is an unavailable preview and does not change workflow evidence', async () => {
  const f = fixture(), before = structuredClone(f.run);
  await assert.rejects(readWorkflowCandidatePreview(f.input, () => f.run, async () => { throw Error('local candidate unavailable'); }), /unavailable/);
  assert.deepEqual(f.run, before);
});
