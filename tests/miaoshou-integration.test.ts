import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, SCHEMA_VERSION } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';

test('new workspace includes the Miaoshou receipt table and migration preserves existing products', () => {
  const directory = mkdtempSync(join(tmpdir(), 'htc-miaoshou-migration-'));
  let db = openDatabase(directory);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
    assert.deepEqual(db.prepare('PRAGMA table_info(miaoshou_receipts)').all().map(row => row.name), ['id', 'record_json']);
    db.exec("INSERT INTO products VALUES ('existing','Keep me','','','draft','manual',1,'2026-10-06','2026-10-06')");
    db.exec('DROP TABLE miaoshou_sync_items; DROP TABLE miaoshou_sync_runs; DROP TABLE miaoshou_receipts; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS listing_completion_operations; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; PRAGMA user_version=10');
    db.close(); db = openDatabase(directory);
    assert.equal(db.prepare('SELECT title FROM products WHERE id=?').get('existing')?.title, 'Keep me');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM miaoshou_receipts').get()?.count, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('version 11 workspace can be backed up and restored through the existing encrypted backup flow', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'htc-miaoshou-backup-'));
  const target = mkdtempSync(join(tmpdir(), 'htc-miaoshou-restored-'));
  const db = openDatabase(directory); db.close(); const other = openDatabase(target); other.close();
  try {
    const path = join(directory, 'miaoshou.htcbackup');
    await createWorkspaceBackup(directory, path, 'miaoshou-backup-test-password');
    const prepared = await prepareWorkspaceRestore(target, path, 'miaoshou-backup-test-password');
    await commitWorkspaceRestore(target, prepared);
    const restored = openDatabase(target);
    try { assert.equal(restored.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION); }
    finally { restored.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});
