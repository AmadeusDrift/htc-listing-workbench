import { SCHEMA_VERSION } from '../src/main/database.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/main/database.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { MiaoshouService } from '../src/main/miaoshou/service.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { testMiaoshouStorage } from './helpers/miaoshou-fixture.ts';
import { DatabaseSync } from 'node:sqlite';
import { MiaoshouSync } from '../src/main/miaoshou/sync.ts';
import { syncScopeId } from '../src/main/miaoshou/sync-records.ts';

test('version 13 indexed sync cache survives encrypted backup and interrupted runs restore paused', async t => {
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/miaoshou-sync-backup-'));
  const store = new WorkspaceStore(root), crypto = testMiaoshouStorage(), service = new MiaoshouService(root, store, crypto);
  t.after(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  service.setMode('demo'); await service.startSync({ pageSize: 500 });
  while (service.getSyncStatus().status === 'running') await new Promise(resolve => setImmediate(resolve));
  const db = openDatabase(root);
  try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION); db.exec("UPDATE miaoshou_sync_runs SET record_json=json_set(record_json,'$.status','running')"); } finally { db.close(); }
  const file = join(root, 'cache.htcbackup'); await createWorkspaceBackup(root, file, 'sync-backup-test-passphrase');
  const target = join(root, 'restored'), prepared = await prepareWorkspaceRestore(target, file, 'sync-backup-test-passphrase'); await commitWorkspaceRestore(target, prepared);
  const restoredStore = new WorkspaceStore(target), restored = new MiaoshouService(target, restoredStore, crypto);
  try {
    restored.setMode('demo'); assert.equal(restored.getSyncStatus().status, 'paused'); assert.equal(restored.getSyncStatus().ready, 3);
    assert.equal(restored.listSyncItems({ page: 1, pageSize: 20, filter: 'all' }).items.length, 3);
    assert.ok(restored.previewSyncedProduct({ id: restored.listSyncItems({ page: 1, pageSize: 20, filter: 'all' }).items[0].remoteId }).product.skus.length > 0);
  } finally { await restored.close(); restoredStore.close(); }
});

test('backup rejects rogue sync snapshot fields and missing scope owners', async t => {
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/miaoshou-sync-invalid-'));
  const store = new WorkspaceStore(root), service = new MiaoshouService(root, store, testMiaoshouStorage());
  t.after(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  service.setMode('demo'); await service.startSync({ pageSize: 500 }); while (service.getSyncStatus().status === 'running') await new Promise(resolve => setImmediate(resolve));
  const db = openDatabase(root);
  try {
    const first = db.prepare('SELECT id,record_json FROM miaoshou_sync_items LIMIT 1').get()!;
    db.prepare("UPDATE miaoshou_sync_items SET record_json=json_set(record_json,'$.snapshot.secret','forbidden') WHERE id=?").run(first.id!);
    await assert.rejects(createWorkspaceBackup(root, join(root, 'invalid.htcbackup'), 'sync-backup-test-passphrase'));
    db.prepare('UPDATE miaoshou_sync_items SET record_json=? WHERE id=?').run(first.record_json!, first.id!); db.exec('DELETE FROM miaoshou_sync_runs');
    await assert.rejects(createWorkspaceBackup(root, join(root, 'orphan.htcbackup'), 'sync-backup-test-passphrase'));
  } finally { db.close(); }
});

test('schema 12 migrates to indexed sync tables without changing existing product data', async t => {
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/miaoshou-sync-migration-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = new WorkspaceStore(root), product = store.createProduct(); store.close();
  const old = openDatabase(root); old.exec('DROP TABLE miaoshou_sync_items; DROP TABLE miaoshou_sync_runs; DROP INDEX miaoshou_receipts_remote_scope; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS listing_completion_operations; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; DROP TABLE IF EXISTS product_fact_models; DROP TABLE IF EXISTS image_retry_allowances; DROP TABLE IF EXISTS schema_fetch_operations; DROP TABLE IF EXISTS ai_purpose_profiles; DROP TABLE IF EXISTS ai_provider_receipts; DROP TABLE IF EXISTS ai_image_requests; DROP TABLE IF EXISTS ai_batches; DROP TABLE IF EXISTS ai_batch_items; DROP TABLE IF EXISTS ai_field_groups; DROP TABLE IF EXISTS image_reference_pins; DROP TABLE IF EXISTS ai_copy_review_upgrades; PRAGMA user_version=12'); old.close();
  const migrated = openDatabase(root);
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
    assert.equal(migrated.prepare('SELECT title FROM products WHERE id=?').get(product.id)!.title, product.title);
    const plan = migrated.prepare("EXPLAIN QUERY PLAN SELECT record_json FROM miaoshou_sync_items WHERE json_extract(record_json,'$.scopeId')=? AND json_extract(record_json,'$.cycle')=? AND json_extract(record_json,'$.status')=? LIMIT 20 OFFSET 20").all('a'.repeat(64), 1, 'ready');
    assert.match(JSON.stringify(plan), /USING INDEX miaoshou_sync_items_scope_cycle_status/);
  } finally { migrated.close(); }
});

test('ambiguous legacy receipt JSON rolls back schema 13 index creation', async t => {
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/miaoshou-sync-migration-bad-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const old = openDatabase(root); old.exec('DROP TABLE miaoshou_sync_items; DROP TABLE miaoshou_sync_runs; DROP INDEX miaoshou_receipts_remote_scope; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS listing_completion_operations; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; DROP TABLE IF EXISTS product_fact_models; DROP TABLE IF EXISTS image_retry_allowances; DROP TABLE IF EXISTS schema_fetch_operations; DROP TABLE IF EXISTS ai_purpose_profiles; DROP TABLE IF EXISTS ai_provider_receipts; DROP TABLE IF EXISTS ai_image_requests; DROP TABLE IF EXISTS ai_batches; DROP TABLE IF EXISTS ai_batch_items; DROP TABLE IF EXISTS ai_field_groups; DROP TABLE IF EXISTS image_reference_pins; DROP TABLE IF EXISTS ai_copy_review_upgrades; PRAGMA user_version=12');
  old.prepare('INSERT INTO miaoshou_receipts VALUES(?,?)').run('ambiguous', '{"accountScope":"first","accountScope":"second"}'); old.close();
  assert.throws(() => openDatabase(root), /重复 JSON 字段/);
  const unchanged = new DatabaseSync(join(root, 'red.sqlite'));
  try { assert.equal(unchanged.prepare('PRAGMA user_version').get()!.user_version, 12); assert.equal(unchanged.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'miaoshou_sync_%'").get()!.n, 0); }
  finally { unchanged.close(); }
});

test('sync progress counts use only the covering index without reading or parsing cached product snapshots', async t => {
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/miaoshou-sync-count-plan-'));
  const db = openDatabase(root); t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const scope = { accountScope: 'a'.repeat(64), mode: 'demo' as const }, id = syncScopeId(scope);
  db.prepare('INSERT INTO miaoshou_sync_runs VALUES(?,?)').run(id, JSON.stringify({ ...scope, id, cycle: 1, status: 'completed', stage: 'details', nextPage: 2, pageSize: 500, remoteTotal: 0, updatedAt: new Date().toISOString(), errorCode: null }));
  const sync = new MiaoshouSync(db, { scope: () => scope, now: () => new Date().toISOString(), list: async () => { throw new Error('No network'); }, detail: async () => { throw new Error('No network'); } });
  const prepare = db.prepare.bind(db); const queries: string[] = [];
  db.prepare = sql => { queries.push(sql); return prepare(sql); };
  assert.equal(sync.status().discovered, 0);
  const sql = queries.find(query => query.includes(' AS skus ')); assert.ok(sql);
  const plan = prepare('EXPLAIN ' + sql).all(id, 1), rootpage = prepare("SELECT rootpage FROM sqlite_master WHERE name='miaoshou_sync_items'").get()!.rootpage;
  const tableCursor = plan.find(row => row.opcode === 'OpenRead' && row.p2 === rootpage)?.p1;
  assert.equal(plan.some(row => row.opcode === 'Column' && row.p1 === tableCursor), false, 'a progress poll must not load any product snapshot');
  assert.equal(plan.some(row => row.opcode === 'Function' && String(row.p4).startsWith('json_')), false, 'cached counts must not reparse snapshot JSON');
});
