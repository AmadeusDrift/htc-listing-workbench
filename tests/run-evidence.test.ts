import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures/listing-ai.ts';
import { taskAiContext } from '../src/main/ai/batch/task-context.ts';

const implementation = await import('../src/main/diagnostics/run-evidence.ts').catch(() => null);
const at = '2026-10-15T01:00:00.000Z';
test('strict evidence preserves real identities while rejecting payloads and invalid semantics', () => {
  assert.equal(typeof implementation?.validateRunEvidence, 'function', 'run evidence strict reader is missing');
  const record = { version: 1, at, event: 'DISPATCH_ATTEMPTED', stage: 'listing_completion', taskId: randomUUID(), itemKey: randomUUID()+':'+ 'a'.repeat(64), sku: '自定义 SKU / 甲', callId: randomUUID(), receiptId: 'a'.repeat(64), certainty: 'SENT_UNKNOWN', abortSource: 'NONE', slot: 0, httpStatus: 200, receivedBytes: 42 };
  assert.deepEqual(implementation!.validateRunEvidence(record), record);
  for (const patch of [{ headers: { Authorization: 'Bearer sk-bait' } }, { body: 'secret' }, { certainty: 'SUCCESS' }, { abortSource: 'RETRY' }, { at: '2026-02-31' }, { callId: 'https://private.test?token=bait' }, { slot: 8 }, { receivedBytes: -1 }]) assert.throws(() => implementation!.validateRunEvidence({ ...record, ...patch }));
});
test('evidence appends on the caller transaction and queries never append duplicates', () => {
  assert.equal(typeof implementation?.appendRunEvidence, 'function', 'run evidence writer is missing');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE audit_events(id TEXT PRIMARY KEY,product_id TEXT,action TEXT,summary TEXT,detail_json TEXT,created_at TEXT)');
    const event = { version: 1, at, event: 'REQUEST_RESERVED', stage: 'fields', callId: randomUUID(), certainty: 'NOT_SENT' } as const;
    db.exec('BEGIN'); implementation!.appendRunEvidence(db, null, event); db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_events').get()!.n, 0);
    implementation!.appendRunEvidence(db, null, event);
    for (let i = 0; i < 100; i++) assert.equal(implementation!.readRunEvidence(db).length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_events').get()!.n, 1);
  } finally { db.close(); }
});
test('transport evidence cannot override business ownership or attach sensitive response properties', () => {
  assert.equal(typeof implementation?.validateTransportRunEvidence, 'function', 'transport evidence validation missing');
  const event = { at, event: 'HEADERS_RECEIVED', httpStatus: 200 };
  assert.deepEqual(implementation!.validateTransportRunEvidence(event), event);
  for (const extra of [{ taskId: randomUUID() }, { stage: 'wrong-owner' }, { requestId: 'token-bait' }, { body: 'private' }, { event: 'RESULT_ADOPTED' }]) assert.throws(() => implementation!.validateTransportRunEvidence({ ...event, ...extra }));
});
test('real AiService reservation, receipt and parsed result retain exact task scope without claiming adoption', async t => {
  const f = await fixture(t), taskId = randomUUID(), rowKey = f.product.id+':'+f.product.variants[0].id;
  const result = await taskAiContext.run({ taskId, rowKey, phase: 'fields', mode: 'immediate', authorize: () => true }, () => f.listing.suggest(f.reference));
  const db = (f.ai as any).db as DatabaseSync;
  const events = db.prepare("SELECT detail_json FROM audit_events WHERE action='run.evidence'").all().map(row => JSON.parse(String(row.detail_json))).filter(e => e.callId === result.callId);
  assert.ok(events.some(e => e.event === 'REQUEST_RESERVED'), 'real reservation has no correlated evidence');
  assert.ok(events.some(e => e.event === 'RECEIPT_SAVED' && /^[a-f0-9]{64}$/.test(e.receiptId)), 'saved receipt has no evidence');
  assert.ok(events.some(e => e.event === 'RESULT_STORED' && e.certainty === 'RECEIVED_VALID'));
  assert.ok(events.every(e => e.taskId === taskId && e.itemKey === rowKey && e.draftId === f.draft.id));
  assert.ok(!events.some(e => e.event === 'RESULT_ADOPTED'));
  assert.equal(f.requests.length, 1);
});
