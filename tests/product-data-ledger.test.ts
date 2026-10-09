import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import type { DraftRecord } from '../src/main/amazon/persistence.ts';
import type { AmazonDraft, AmazonTarget, JsonObject } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import { ProductDataService } from '../src/main/product-data/service.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';

const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const FIRST = '2026-01-02T12:00:00.000Z';
function record(p: ProductDetail, target: AmazonTarget, patch: Partial<AmazonDraft> = {}): DraftRecord {
  const draft: AmazonDraft = { id: randomUUID(), productId: p.id, variantId: p.variants[0].id, sku: p.variants[0].sku, productRevision: p.revision,
    targetId: target.id, targetName: target.name, sellerId: target.sellerId, marketplaceId: target.marketplaceId, mode: 'live', listingProgram: 'haul', revision: 1,
    schema: { key: 'test', targetId: target.id, productType: 'ITEM', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US', mode: 'live',
      schema: {}, metaSchema: {}, checksum: 'hash', version: 'test', propertyGroups: {}, fetchedAt: FIRST, expiresAt: FIRST, fromCache: false },
    attributes: { sentinel: 'RAW_ATTRIBUTE_MUST_NOT_ENTER_LEDGER' }, state: 'SUBMITTED', localIssues: [], previewIssues: [], listingIssues: [], statuses: [],
    submissionId: 'accepted-id', requestId: 'request-id', previewedAt: null, submittedAt: FIRST, checkedAt: null, createdAt: FIRST, updatedAt: FIRST,
    events: [], ...patch };
  return { draft, preview: null, request: { secret: 'RAW_REQUEST_MUST_NOT_ENTER_LEDGER' }, previewResponse: null,
    submitResponse: { sku: draft.sku, status: 'ACCEPTED', submissionId: 'accepted-id' }, readResponse: null, unresolvedWrite: false };
}
function fixture(t: test.TestContext) {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'product-data-ledger-'));
  const directory = join(root, 'source'); const store = new WorkspaceStore(directory); let persistence = new AmazonPersistence(directory);
  const product = store.createProduct(); const target: AmazonTarget = { id: randomUUID(), name: 'test', sellerId: 'SELLER', marketplaceId: 'ATVPDKIKX0DER', mode: 'live',
    marketplaceName: 'US', region: 'na', locale: 'en_US', configured: true, paused: false, credentialUpdatedAt: FIRST, lastError: null };
  persistence.putTarget(target, true);
  let persistenceOpen = true; let storeOpen = true;
  t.after(() => { if (persistenceOpen) persistence.close(); if (storeOpen) store.close(); const absolute = resolve(root); assert.ok(absolute.startsWith(parent + '\\')); rmSync(absolute, { recursive: true, force: true }); });
  return { directory, root, store, product, target, get persistence() { return persistence; },
    reopen() { persistence.close(); persistence = new AmazonPersistence(directory); return persistence; },
    close() { persistence.close(); persistenceOpen = false; store.close(); storeOpen = false; } };
}
function ledger(persistence: AmazonPersistence, targetId: string) {
  assert.equal(typeof persistence.listAcceptedSkus, 'function', 'Persistence must provide a durable accepted-SKU ledger');
  return persistence.listAcceptedSkus(targetId);
}

test('finishWrite atomically stores a minimal accepted SKU identity with its earliest accepted time', t => {
  const f = fixture(t); const first = record(f.product, f.target); f.persistence.finishWrite('hash-first', first);
  let rows = ledger(f.persistence, f.target.id); assert.equal(rows.length, 1); assert.equal(rows[0].firstAcceptedAt, FIRST);
  assert.equal(rows[0].productId, f.product.id); assert.equal(rows[0].variantId, f.product.variants[0].id);
  assert.doesNotMatch(JSON.stringify(rows), /RAW_|requestId|submissionId|attributes|response|credential/);
  const later = record(f.product, f.target, { submittedAt: '2026-10-01T12:00:00.000Z' }); f.persistence.finishWrite('hash-later', later);
  rows = ledger(f.persistence, f.target.id); assert.equal(rows.length, 1); assert.equal(rows[0].firstAcceptedAt, FIRST);
  assert.equal(rows[0].lastAcceptedAt, '2026-10-01T12:00:00.000Z');
});

test('cleanup backfills legacy accepted live child drafts before deleting them, and restart preserves first acceptance', t => {
  const f = fixture(t); const older = record(f.product, f.target); const later = record(f.product, f.target, { submittedAt: '2026-02-02T12:00:00.000Z' });
  f.persistence.putRecord(later); f.persistence.putRecord(older); f.persistence.savePolicy({ retentionDays: 1, logRetentionDays: 365, lastCleanupAt: null });
  const cleaned = f.persistence.cleanup(NOW); assert.equal(cleaned.removedDrafts, 2); assert.equal(f.persistence.records().length, 0);
  assert.equal(ledger(f.persistence, f.target.id)[0].firstAcceptedAt, FIRST);
  f.reopen(); assert.equal(ledger(f.persistence, f.target.id)[0].firstAcceptedAt, FIRST);
});

test('demo, parents, samples, unsubmitted and unaccepted responses never create accepted SKU ledger entries', t => {
  const f = fixture(t); const demo = record(f.product, f.target, { mode: 'demo' });
  const parent = record(f.product, f.target); parent.draft.schema.parentageLevel = 'PARENT';
  const pending = record(f.product, f.target, { submittedAt: null, state: 'AMAZON_VALIDATED' });
  const rejected = record(f.product, f.target); rejected.submitResponse!.status = 'INVALID';
  const ambiguous = record(f.product, f.target); ambiguous.unresolvedWrite = true; ambiguous.draft.state = 'UNKNOWN';
  const wrongSku = record(f.product, f.target); wrongSku.submitResponse!.sku = 'OLD-STORE-SKU';
  const sample = f.store.createProduct(); f.persistence.db.prepare("UPDATE products SET origin='sample' WHERE id=?").run(sample.id);
  for (const entry of [demo, parent, pending, rejected, ambiguous, wrongSku, record(sample, f.target)]) f.persistence.finishWrite(randomUUID(), entry);
  f.persistence.cleanup(NOW); assert.deepEqual(ledger(f.persistence, f.target.id), []);
});

test('accepted ledger is written in the same transaction as final draft state', t => {
  const f = fixture(t); const accepted = record(f.product, f.target); const before = structuredClone(accepted); before.draft.state = 'SUBMITTING'; before.draft.submittedAt = null;
  f.persistence.putRecord(before);
  f.persistence.db.exec("CREATE TRIGGER reject_ledger BEFORE INSERT ON amazon_settings WHEN NEW.key LIKE 'accepted_sku_v1:%' BEGIN SELECT RAISE(ABORT, 'ledger write failed'); END");
  assert.throws(() => f.persistence.finishWrite('hash', accepted), /ledger write failed/);
  assert.equal(f.persistence.record(accepted.draft.id).draft.state, 'SUBMITTING'); assert.deepEqual(ledger(f.persistence, f.target.id), []);
});

test('persistent accepted scope drives tracking after cleanup; generation rotates data cache while preserving identity', async t => {
  const f = fixture(t); f.persistence.finishWrite('hash', record(f.product, f.target)); f.persistence.cleanup(NOW); f.reopen(); let calls = 0;
  const amazon = { executionTargetScope: (id: string) => ({ target: f.persistence.target(id), generation: f.persistence.generation(id) }),
    listAcceptedSkus: (id: string) => ledger(f.persistence, id),
    readProductData: async (_id: string, kind: 'listings' | 'inventory' | 'sales', query: Record<string, string>) => {
      calls++; const data: JsonObject = kind === 'listings' ? { items: [{ sku: f.product.variants[0].sku, summaries: [{ marketplaceId: f.target.marketplaceId, asin: 'B000000001' }] }] }
        : kind === 'sales' ? { payload: [{ interval: query.interval, unitCount: 3 }] }
        : { payload: { granularity: { granularityType: 'Marketplace', granularityId: f.target.marketplaceId }, inventorySummaries: [] } };
      return { data, status: 200, requestId: null };
    } };
  const service = new ProductDataService(f.directory, f.store, amazon, { now: () => NOW }); t.after(() => service.close());
  assert.equal(service.get(f.target.id).rows[0].salesSince, FIRST); service.start(f.target.id);
  for (let i = 0; i < 100 && service.get(f.target.id).job.state === 'running'; i++) await new Promise<void>(r => setImmediate(r));
  assert.equal(service.get(f.target.id).rows[0].listing.value?.asin, 'B000000001');
  f.persistence.putTarget(f.target, true); const rotated = service.get(f.target.id); assert.equal(rotated.rows.length, 1); assert.equal(rotated.rows[0].salesSince, FIRST);
  assert.equal(rotated.rows[0].listing.value, null); assert.equal(calls, 3);
  f.persistence.putTarget({ ...f.target, sellerId: 'ANOTHER-SELLER' }, true); assert.equal(service.get(f.target.id).rows.length, 0);
  f.persistence.putTarget(f.target, true); f.persistence.db.prepare('DELETE FROM audit_events WHERE product_id=?').run(f.product.id);
  f.persistence.db.prepare('DELETE FROM products WHERE id=?').run(f.product.id); assert.equal(service.get(f.target.id).rows.length, 0);
});

test('failed legacy ledger backfill rolls cleanup back before it can remove accepted drafts', t => {
  const f = fixture(t); const accepted = record(f.product, f.target); f.persistence.putRecord(accepted);
  f.persistence.db.exec("CREATE TRIGGER reject_backfill BEFORE INSERT ON amazon_settings WHEN NEW.key LIKE 'accepted_sku_v1:%' BEGIN SELECT RAISE(ABORT, 'backfill failed'); END");
  assert.throws(() => f.persistence.cleanup(NOW), /backfill failed/); assert.equal(f.persistence.record(accepted.draft.id).draft.submittedAt, FIRST);
});

test('malformed, oversized and mismatched-key ledger entries are ignored without admitting untracked SKUs', t => {
  const f = fixture(t); f.persistence.finishWrite('hash', record(f.product, f.target));
  const saved = f.persistence.db.prepare("SELECT key,value_json FROM amazon_settings WHERE key GLOB 'accepted_sku_v1:*'").get()!;
  const valid = JSON.parse(String(saved.value_json));
  for (const content of ['{broken-json', JSON.stringify({ ...valid, sku: 'OLD-STORE-SKU' }), JSON.stringify({ ...valid, firstAcceptedAt: 'not-a-date' }), ' '.repeat(4097)]) {
    f.persistence.db.prepare('UPDATE amazon_settings SET value_json=? WHERE key=?').run(content, saved.key); assert.deepEqual(ledger(f.persistence, f.target.id), []);
  }
  f.persistence.db.prepare('UPDATE amazon_settings SET value_json=? WHERE key=?').run(JSON.stringify({ ...valid, rawResponse: 'DO_NOT_EXPOSE' }), saved.key);
  assert.doesNotMatch(JSON.stringify(ledger(f.persistence, f.target.id)), /DO_NOT_EXPOSE|rawResponse/);
});

test('stop reaches the callback checked immediately before a queued transport request is sent', async t => {
  const f = fixture(t); f.persistence.finishWrite('hash', record(f.product, f.target)); let release!: () => void; let sent = 0;
  const queued = new Promise<void>(resolve => { release = resolve; });
  const amazon = { executionTargetScope: (id: string) => ({ target: f.persistence.target(id), generation: f.persistence.generation(id) }),
    listAcceptedSkus: (id: string) => ledger(f.persistence, id),
    readProductData: async (_id: string, _kind: 'listings' | 'inventory' | 'sales', _query: Record<string, string>, beforeSend?: () => void) => {
      assert.equal(typeof beforeSend, 'function'); await queued; beforeSend!(); sent++; return { data: { items: [] }, status: 200, requestId: null };
    } };
  const service = new ProductDataService(f.directory, f.store, amazon, { now: () => NOW }); t.after(() => service.close());
  service.start(f.target.id); await new Promise<void>(r => setImmediate(r)); service.stop(f.target.id); release();
  await new Promise<void>(r => setImmediate(r)); assert.equal(sent, 0); assert.equal(service.busy, false);
});

test('workspace backup and restore preserve the accepted SKU ledger without schema changes or credentials', async t => {
  const f = fixture(t); f.persistence.finishWrite('hash', record(f.product, f.target)); f.persistence.cleanup(NOW); f.close();
  const file = join(f.root, 'ledger.htcbackup'); const restoredDirectory = join(f.root, 'restored');
  await createWorkspaceBackup(f.directory, file, 'ledger test passphrase 123');
  const prepared = await prepareWorkspaceRestore(restoredDirectory, file, 'ledger test passphrase 123'); await commitWorkspaceRestore(restoredDirectory, prepared);
  const restored = new AmazonPersistence(restoredDirectory);
  try { const rows = ledger(restored, f.target.id); assert.equal(rows.length, 1); assert.equal(rows[0].firstAcceptedAt, FIRST);
    assert.equal(restored.target(f.target.id).configured, false); assert.equal(restored.target(f.target.id).paused, true);
  } finally { restored.close(); }
});
