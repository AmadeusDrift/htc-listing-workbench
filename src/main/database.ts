import { validateStartupHistory } from './startup-database-validation.ts';
import { assertProductFactModels } from './products/fact-models.ts';
import { CONSISTENCY_SCHEMA, assertConsistencyHistory } from './source-image-consistency/history.ts';
import { migrateModules, MODULE_SCHEMA_VERSION } from './storage/migrations.ts';
import { assertSourceAdoptionHistory } from './products/source-adoption.ts';
import { assertSchemaOperationHistory } from './catalog/schema-operations.ts';
import { assertSourceImageHistory } from './source-image-provenance.ts';
import { UserFacingError } from '../shared/errors.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrateLegacyAiUsage } from './ai/usage.ts';
import { RECORD_INDEXES } from './record-indexes.ts';
import { assertUnambiguousRecordJson } from './record-json.ts';
import { COLLECTION_INDEXES } from './collection/indexes.ts';
import { MIAOSHOU_INDEXES } from './miaoshou/indexes.ts';
import { MIAOSHOU_SYNC_INDEXES } from './miaoshou/sync-records.ts';
import { SKU_NAMING_SCHEMA } from './sku-naming/schema.ts';

export const SCHEMA_VERSION = MODULE_SCHEMA_VERSION;
export function openDatabase(directory: string): DatabaseSync {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'red.sqlite'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version > SCHEMA_VERSION) { db.close(); throw new UserFacingError('数据库来自更高版本，请使用新版 HTC 打开'); }
  if (version === 0) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE products (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('draft','ready','archived')), origin TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE variants (
          id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          sku TEXT NOT NULL COLLATE NOCASE UNIQUE, original_spec TEXT NOT NULL, normalized_spec TEXT NOT NULL,
          purchase_price TEXT NOT NULL, inventory INTEGER, source_spec TEXT NOT NULL, source_purchase_price TEXT NOT NULL,
          position INTEGER NOT NULL
        );
        CREATE INDEX variants_product ON variants(product_id);
        CREATE TABLE facts (
          id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          name TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT NOT NULL, state TEXT NOT NULL, position INTEGER NOT NULL
        );
        CREATE TABLE assets (
          id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          file_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('main','gallery','detail')),
          mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, byte_size INTEGER NOT NULL,
          original_path TEXT NOT NULL, preview_path TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(product_id,sha256)
        );
        CREATE UNIQUE INDEX one_main_image ON assets(product_id) WHERE role = 'main';
        CREATE TABLE variant_assets (
          asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
          confirmed INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
          PRIMARY KEY(asset_id,variant_id)
        );
        CREATE TABLE audit_events (
          id TEXT PRIMARY KEY, product_id TEXT REFERENCES products(id), action TEXT NOT NULL,
          summary TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX audit_product ON audit_events(product_id,created_at);
        CREATE TABLE amazon_targets (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, seller_id TEXT NOT NULL, marketplace_id TEXT NOT NULL,
          product_type TEXT NOT NULL, parentage_level TEXT NOT NULL, credential_ref TEXT
        );
        CREATE TABLE schema_cache (
          cache_key TEXT PRIMARY KEY, target_id TEXT REFERENCES amazon_targets(id), schema_json TEXT NOT NULL,
          meta_schema_json TEXT NOT NULL, checksum TEXT NOT NULL, requirements TEXT NOT NULL,
          parentage_level TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL
        );
        CREATE TABLE listing_drafts (
          id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), target_id TEXT REFERENCES amazon_targets(id),
          request_json TEXT NOT NULL, schema_checksum TEXT NOT NULL, validation_json TEXT NOT NULL,
          preview_json TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE issues (
          id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES listing_drafts(id), code TEXT NOT NULL,
          severity TEXT NOT NULL, category TEXT NOT NULL, field TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL
        );
        PRAGMA user_version = 1;
        COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 2) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE amazon_targets ADD COLUMN target_json TEXT;
        ALTER TABLE amazon_targets ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE schema_cache ADD COLUMN snapshot_json TEXT;
        ALTER TABLE listing_drafts ADD COLUMN record_json TEXT;
        ALTER TABLE listing_drafts ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
        CREATE INDEX amazon_drafts_product ON listing_drafts(product_id,created_at);
        CREATE TABLE amazon_calls (
          id TEXT PRIMARY KEY, target_id TEXT NOT NULL, created_at TEXT NOT NULL, event_json TEXT NOT NULL
        );
        CREATE INDEX amazon_calls_created ON amazon_calls(created_at);
        CREATE TABLE amazon_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
        CREATE TABLE amazon_write_locks (
          listing_hash TEXT PRIMARY KEY, draft_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL
        );
        PRAGMA user_version = 2;
        COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 3) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE product_workspaces (
          product_id TEXT PRIMARY KEY NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          lane TEXT NOT NULL CHECK(lane IN ('inbox','manual','automatic','ignored')),
          updated_at TEXT NOT NULL
        );
        INSERT INTO product_workspaces(product_id,lane,updated_at) SELECT id,'manual',updated_at FROM products;
        PRAGMA user_version = 3;
        COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 4) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE hosting_profiles (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        CREATE TABLE hosting_uploads (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        CREATE TABLE execution_tasks (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        PRAGMA user_version = 4;
        COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 5) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE ai_profiles (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        CREATE TABLE ai_calls (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        CREATE TABLE ai_results (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        PRAGMA user_version = 5;
        COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 6) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE image_versions (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        CREATE TABLE image_selections (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        CREATE TABLE content_versions (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        PRAGMA user_version = 6;
        COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 7) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE image_write_operations (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        PRAGMA user_version = 7;
        COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 8) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE ai_usage_policies (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
        CREATE TABLE ai_usage_ledger (id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);`);
      migrateLegacyAiUsage(db);
      db.exec('PRAGMA user_version=8; COMMIT;');
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 9) {
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const table of new Set(RECORD_INDEXES.map(index => index.table))) assertUnambiguousRecordJson(db, table);
      for (const index of RECORD_INDEXES) db.exec(index.sql);
      db.exec('PRAGMA user_version=9; COMMIT;');
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 10) {
    try {
      db.exec('BEGIN IMMEDIATE; CREATE TABLE collection_receipts (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); CREATE TABLE collection_captures (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL);');
      for (const index of COLLECTION_INDEXES) db.exec(index.sql);
      db.exec('PRAGMA user_version=10; COMMIT;');
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 11) {
    try {
      db.exec('BEGIN IMMEDIATE; CREATE TABLE miaoshou_receipts (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL);');
      for (const index of MIAOSHOU_INDEXES) db.exec(index.sql);
      db.exec('PRAGMA user_version=11; COMMIT;');
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 12) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        UPDATE listing_drafts SET record_json=json_set(record_json,'$.draft.listingProgram','standard')
        WHERE record_json IS NOT NULL AND json_type(record_json,'$.draft.listingProgram') IS NULL;
        PRAGMA user_version=12; COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 13) {
    try {
      db.exec('BEGIN IMMEDIATE; CREATE TABLE miaoshou_sync_runs (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); CREATE TABLE miaoshou_sync_items (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL);');
      assertUnambiguousRecordJson(db, 'miaoshou_receipts');
      for (const index of MIAOSHOU_SYNC_INDEXES) db.exec(index.sql);
      db.exec('PRAGMA user_version=13; COMMIT;');
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 14) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE listing_followups (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL);
        CREATE TABLE category_libraries (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL);
        CREATE TABLE procurement_batches (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL);
        PRAGMA user_version=14; COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 15) {
    try { db.exec('BEGIN IMMEDIATE; CREATE TABLE image_workflow_runs (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); PRAGMA user_version=15; COMMIT;'); }
    catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 16) {
    try { db.exec('BEGIN IMMEDIATE; CREATE TABLE automatic_listing_tasks (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); CREATE TABLE item_labels (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); CREATE TABLE shipment_documents (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); PRAGMA user_version=16; COMMIT;'); }
    catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 17) {
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const sql of SKU_NAMING_SCHEMA) db.exec(sql);
      db.exec('PRAGMA user_version=17; COMMIT;');
    } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 18) {
    try { db.exec('BEGIN IMMEDIATE; CREATE TABLE listing_completion_operations (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); PRAGMA user_version=18; COMMIT;'); }
    catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 19) {
    try { db.exec('BEGIN IMMEDIATE; CREATE TABLE source_image_provenance (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); PRAGMA user_version=19; COMMIT;'); }
    catch(error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 20) {
    try { db.exec('BEGIN IMMEDIATE'); for(const sql of CONSISTENCY_SCHEMA) db.exec(sql); db.exec('PRAGMA user_version=20; COMMIT;'); }
    catch(error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  if (version < 21) {
    try { db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE amazon_write_locks ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'draft';
      ALTER TABLE amazon_write_locks ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
      UPDATE amazon_write_locks SET owner_id=draft_id;
      CREATE TABLE listing_corrections(id TEXT PRIMARY KEY NOT NULL,draft_id TEXT NOT NULL,listing_hash TEXT NOT NULL,record_json TEXT NOT NULL);
      CREATE INDEX listing_corrections_scope ON listing_corrections(listing_hash);
      CREATE TABLE listing_correction_attempts(id TEXT PRIMARY KEY NOT NULL,correction_id TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL);
      PRAGMA user_version=21; COMMIT;`); }
    catch(error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
  }
  try { validateStartupHistory(directory,'consistency',()=>assertConsistencyHistory(db));validateStartupHistory(directory,'sourceImage',()=>assertSourceImageHistory(db)); } catch(error) { db.close();throw error; }
  // Idempotent for databases created during development of schema version 2.
  db.exec(`CREATE TABLE IF NOT EXISTS amazon_exchanges (
    id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES listing_drafts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, exchange_json TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS amazon_exchanges_draft ON amazon_exchanges(draft_id,created_at);`);
  try { migrateModules(db);validateStartupHistory(directory,'factModels',()=>assertProductFactModels(db));validateStartupHistory(directory,'sourceAdoption',()=>assertSourceAdoptionHistory(db));validateStartupHistory(directory,'schemaOperations',()=>assertSchemaOperationHistory(db)); } catch(error) { db.close();throw error; }
  return db;
}
