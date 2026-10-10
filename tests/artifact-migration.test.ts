import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, SCHEMA_VERSION } from '../src/main/database.ts';
import { dropRecordQueryIndexes } from './helpers/legacy-schema.ts';

test('v5 workspaces gain independent image and copy version tables without altering existing AI records', t => {
  mkdirSync(resolve('.test-data'), { recursive: true }); const root = mkdtempSync(resolve('.test-data/artifact-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = openDatabase(root);
  dropRecordQueryIndexes(legacy);
  legacy.exec('DROP TABLE IF EXISTS ai_usage_ledger; DROP TABLE IF EXISTS ai_usage_policies; DROP TABLE IF EXISTS image_write_operations; DROP TABLE IF EXISTS image_versions; DROP TABLE IF EXISTS image_selections; DROP TABLE IF EXISTS content_versions; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; PRAGMA user_version=5');
  legacy.prepare('INSERT INTO ai_profiles VALUES(?,?)').run('fixture', '{"sentinel":"preserved"}'); legacy.close();
  const db = openDatabase(root);
  try {
    assert.equal(SCHEMA_VERSION, 19);
    for (const table of ['image_versions', 'image_selections', 'content_versions', 'image_write_operations']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
    assert.equal(db.prepare('SELECT record_json FROM ai_profiles WHERE id=?').get('fixture')!.record_json, '{"sentinel":"preserved"}');
  } finally { db.close(); }
});
