import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures/listing-ai.ts';
import { taskAiContext } from '../src/main/ai/batch/task-context.ts';
import { AiError } from '../src/main/ai/errors.ts';

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
test('transport evidence rejects accessor properties without invoking them', () => {
  let reads = 0; const event = { event: 'HEADERS_RECEIVED' };
  Object.defineProperty(event, 'at', { enumerable: true, get() { reads++; return at; } });
  assert.throws(() => implementation!.validateTransportRunEvidence(event)); assert.equal(reads, 0);
});
test('real AiService reservation, receipt and parsed result retain exact task scope without claiming adoption', async t => {
  const f = await fixture(t), taskId = randomUUID(), rowKey = f.product.id+':'+f.product.variants[0].id;
  const result = await taskAiContext.run({ taskId, rowKey, phase: 'fields', mode: 'immediate', authorize: () => true }, () => f.listing.suggest(f.reference));
  const db = (f.ai as any).db as DatabaseSync;
  const events = db.prepare("SELECT detail_json FROM audit_events WHERE action='run.evidence'").all().map(row => JSON.parse(String(row.detail_json))).filter(e => e.callId === result.callId);
  assert.ok(events.some(e => e.event === 'REQUEST_RESERVED'), 'real reservation has no correlated evidence');
  assert.ok(events.some(e => e.event === 'RECEIPT_SAVED' && /^[a-f0-9]{64}$/.test(e.receiptId)), 'saved receipt has no evidence');
  assert.equal(events.find(e => e.event === 'RECEIPT_SAVED').receivedBytes, undefined, 'receipt envelope size is not transport bytes');
  assert.ok(events.some(e => e.event === 'RESULT_STORED' && e.certainty === 'RECEIVED_VALID'));
  assert.ok(events.every(e => e.taskId === taskId && e.itemKey === rowKey && e.draftId === f.draft.id));
  assert.ok(!events.some(e => e.event === 'RESULT_ADOPTED'));
  assert.equal(f.requests.length, 1);
});
test('receipt audit failure never discards saved receipt linkage, parsed result or fee settlement', async t => {
  const f = await fixture(t), db = (f.ai as any).db as DatabaseSync;
  db.exec("CREATE TEMP TRIGGER reject_receipt_audit BEFORE INSERT ON audit_events WHEN NEW.action='run.evidence' AND json_extract(NEW.detail_json,'$.event')='RECEIPT_SAVED' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  const result = await f.listing.suggest(f.reference), call = f.ai.listCalls().find(c => c.id === result.callId)!;
  assert.equal(call.status, 'SUCCEEDED'); assert.ok(call.providerReceiptId); assert.ok(await f.ai.readProviderReceipt(call.id));
  assert.equal(JSON.parse(String(db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(call.providerReceiptId)!.record_json)).callId, call.id);
  assert.equal(f.ai.getUsageSummary(call.providerId).unknownCalls, 0); assert.equal(f.requests.length, 1);
});
test('reservation evidence failure rolls back call and fee reservation before any send', async t => {
  const f = await fixture(t), db = (f.ai as any).db as DatabaseSync, before = f.ai.listCalls().length;
  db.exec("CREATE TEMP TRIGGER reject_reservation_audit BEFORE INSERT ON audit_events WHEN NEW.action='run.evidence' AND json_extract(NEW.detail_json,'$.event')='REQUEST_RESERVED' BEGIN SELECT RAISE(ABORT,'synthetic reservation audit failure'); END");
  await assert.rejects(f.listing.suggest(f.reference)); assert.equal(f.requests.length, 0); assert.equal(f.ai.listCalls().length, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_ledger').get()!.n, 0);
});
test('post-dispatch failed audit preserves original safe error, call identity and unknown fees', async t => {
  const f = await fixture(t), db = (f.ai as any).db as DatabaseSync;
  db.exec("CREATE TEMP TRIGGER reject_failed_audit BEFORE INSERT ON audit_events WHEN NEW.action='run.evidence' AND json_extract(NEW.detail_json,'$.event')='STAGE_BLOCKED' BEGIN SELECT RAISE(ABORT,'synthetic failed audit failure'); END");
  f.respond(() => { throw new AiError('TIMEOUT'); });
  let caught: any; try { await f.listing.suggest(f.reference); } catch (error) { caught = error; }
  // Existing adapter maps a rejected fetch to NETWORK_ERROR. Audit must not replace it.
  const call = f.ai.listCalls().at(-1)!; assert.equal(caught.code, 'NETWORK_ERROR'); assert.equal(caught.callId, call.id);
  assert.equal(call.errorCode, 'NETWORK_ERROR'); assert.equal(f.ai.getUsageSummary(call.providerId).unknownCalls, 1); assert.equal(f.requests.length, 1);
});
