import test from 'node:test';
import assert from 'node:assert/strict';
import { completionOwnerFixture } from './fixtures/completion-owners.ts';
import { imageWorkflowDraftStamp } from '../src/main/image-workflow/records.ts';
import { openDatabase } from '../src/main/database.ts';
import { CompletionJournal } from '../src/main/listing-ai/completion-journal.ts';
import { summarizeAutomaticItems } from '../src/renderer/automatic-product-groups.ts';
import { candidateFor, chat } from './fixtures/listing-ai.ts';

test('historical automatic owner replays cached DONE through Generic/color migration without losing responses, source identity or budget', async t => {
  const f = await completionOwnerFixture(t, 'automatic', false, false, '樱花粉');
  // Produce a genuine persisted provider result and adoption through the owner first.
  await assert.rejects(f.run(), /Downstream|文案/);
  const p = (f.amazon as any).persistence;
  const priorOp = f.listing.completionOperations(f.draft.id)[0];
  assert.equal(priorOp.state, 'DONE');
  const results = f.ai.listResults(f.product.id).map(result => JSON.stringify(result));
  const requests = f.requests.length;
  assert.ok(requests > 0);
  const record = p.record(f.draft.id);
  record.draft.listingProgram = 'haul';
  record.draft.schema.schema.properties.brand = structuredClone(record.draft.schema.schema.properties.color);
  record.draft.attributes.brand = [{ value: 'Old Supplier Brand', marketplace_id: f.target.marketplaceId }];
  record.draft.attributes.color = [{ value: 'Cherry Blossom Pink', marketplace_id: f.target.marketplaceId }];
  record.draft.attributes.is_value_stores_item = [{ value: true }];
  record.draft.localIssues = [];
  record.draft.previewIssues = [{ code: '5882', source: 'amazon', severity: 'ERROR', category: 'field', attributeNames: ['brand'], autoFixable: false, message: 'Brand approval required (5882)' }];
  record.previewResponse = { issues: record.draft.previewIssues, receipt: 'synthetic historical receipt' };
  delete record.draft.businessRules;
  p.putRecord(record);
  const receipt = structuredClone(record.previewResponse);
  const op = f.listing.beginCompletion(f.reference());
  op.state = 'DONE';
  op.remaining = ['brand: Brand approval required (5882)'];
  f.ai.completionJournal.save(op);
  const saved = p.db.prepare('SELECT id,record_json FROM automatic_listing_tasks').get();
  const task = JSON.parse(saved.record_json), row = task.items[0];
  row.repair = { ...row.repair, phase: 'FIELDS_PENDING', operationId: op.id, draftRevision: record.draft.revision, draftStamp: imageWorkflowDraftStamp(record.draft), remaining: ['brand: Brand approval required (5882)'] };
  const budget = row.repairAttempts;
  p.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task), saved.id);
  await f.reopen();
  await assert.rejects(f.run(), /人工/);
  const migrated = f.amazon.getDraft(f.draft.id);
  assert.equal((migrated.attributes.brand as any)[0].value, 'Generic');
  assert.equal((migrated.attributes.color as any)[0].value, 'Pink');
  assert.equal((migrated.attributes.is_value_stores_item as any)[0].value, true);
  assert.deepEqual(p.record(f.draft.id).previewResponse, receipt);
  assert.equal(f.store.getProduct(f.product.id).variants[0].originalSpec, '樱花粉');
  assert.deepEqual(f.store.getProduct(f.product.id).assets[0].variantIds, [f.draft.variantId]);
  assert.equal((f.progress() as any).repairAttempts, budget);
  assert.deepEqual(f.ai.listResults(f.product.id).map(result => JSON.stringify(result)), results);
  assert.equal(f.requests.length, requests);
  const outcome = await f.classifyFailure();
  assert.equal(outcome.kind, 'NEEDS_INPUT');
  await f.reopen();
  await assert.rejects(f.run(), /人工/);
  assert.equal(f.amazon.getDraft(f.draft.id).revision, migrated.revision);
  assert.equal(f.requests.length, requests);
  const disk = openDatabase(f.directory);
  try {
    assert.deepEqual(new CompletionJournal(disk).get(op.id).rounds, op.rounds);
    assert.deepEqual(new CompletionJournal(disk).get(priorOp.id), priorOp);
    const persisted = JSON.parse(String(disk.prepare('SELECT record_json FROM automatic_listing_tasks').get()!.record_json));
    assert.equal(persisted.items[0].repairAttempts, budget);
    assert.equal(Object.values(summarizeAutomaticItems(persisted.items)).reduce((a, b) => a + b, 0), 1);
  } finally { disk.close(); }
});

for (const owner of ['automatic', 'images'] as const) {
  test(`${owner}: historical explicit field rejections retain their budget across owner restarts and adopt only the later success`, async t => {
    const f = await completionOwnerFixture(t, owner);
    f.respond(() => Response.json({error:'synthetic authentication rejection'},{status:401}));
    await assert.rejects(f.run());
    const original = f.listing.completionOperations(f.draft.id)[0];
    const firstCall = structuredClone(f.ai.listCalls()[0]);
    await f.reopen();
    await assert.rejects(f.run());
    assert.equal(f.requests.length, 2);
    f.respond(payload => chat(candidateFor(payload)));
    await f.reopen();
    await assert.rejects(f.run(), /Downstream|文案/);
    assert.equal(f.requests.length, 3);
    const recovered = f.listing.getCompletion(original.id);
    assert.equal(recovered.state, 'DONE');
    assert.equal(recovered.rounds[0].candidate.previous?.length, 2);
    assert.equal(recovered.rounds[0].candidate.previous?.[0].id, original.rounds[0].candidate.id);
    assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length, 1);
    assert.deepEqual(f.ai.listCalls().find(call => call.id === firstCall.id), firstCall);
    await f.reopen();
    assert.deepEqual(f.listing.getCompletion(original.id), recovered);
    assert.equal(f.ai.getUsageSummary('deepseek').attempts, 3);
  });

  test(`${owner}: repeated historical UNKNOWN recovery preserves the original call without resending after restarts`, async t => {
    const f = await completionOwnerFixture(t, owner);
    f.respond(() => { throw new Error('Synthetic persistent response loss'); });
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(f.run());
      assert.equal(f.requests.length, 1);
      await f.reopen();
    }
    const operations = f.listing.completionOperations(f.draft.id), calls = f.ai.listCalls();
    for (let restart = 0; restart < 2; restart++) {
      await assert.rejects(f.run());
      await f.reopen();
    }
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.ai.listCalls(), calls);
    assert.deepEqual(f.listing.completionOperations(f.draft.id), operations);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].rounds[0].candidate.previous?.length??0, 0);
    assert.equal(f.ai.getUsageSummary('deepseek').attempts, 1);
  });

  test(`${owner}: unknown Amazon submission stops historical AI recovery after restart and preserves every ledger`, async t => {
    const f = await completionOwnerFixture(t, owner);
    f.respond(() => { throw new Error('Synthetic connection lost after field request was sent'); });
    await assert.rejects(f.run());
    assert.equal(f.requests.length, 1);
    const operations = f.listing.completionOperations(f.draft.id);
    const calls = f.ai.listCalls();
    const p = (f.amazon as any).persistence, record = p.record(f.draft.id);
    record.unresolvedWrite = true;
    record.draft.state = 'UNKNOWN';
    p.putRecord(record);
    // This is an Amazon safety boundary, even if the AI request is retryable.
    if (owner === 'automatic') f.child.items[0].submitStarted = true;
    const bytes = JSON.stringify(p.record(f.draft.id));
    await f.reopen();
    await assert.rejects(f.run());
    await f.reopen();
    await assert.rejects(f.run());
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.ai.listCalls(), calls);
    assert.deepEqual(f.listing.completionOperations(f.draft.id), operations);
    assert.equal(JSON.stringify(p.record(f.draft.id)), bytes);
    if (owner === 'images') assert.equal((f.progress() as any).slots.length, 7);
  });
}
