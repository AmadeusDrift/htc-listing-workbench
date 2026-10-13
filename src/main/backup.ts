import { CORRECTION_TABLES, assertCorrectionHistory, retainCorrectionHistory, invalidateCorrectionAuthorizations } from './amazon/correction-history.ts';
import { MIGRATION_TABLES, assertMigrationJournal } from './storage/migrations.ts';
import { SOURCE_TABLES } from './miaoshou/source-snapshots.ts';
import { assertSourceAdoptionHistory } from './products/source-adoption.ts';
import { SCHEMA_OPERATION_TABLES,assertSchemaOperationHistory,restoreSchemaOperations,revokeSchemaInFlight } from './catalog/schema-operations.ts';
import { retainSchemaRetryBudgets } from './automatic-listing/schema-retry-budget.ts';
import { retainSchemaResponseCalls } from './ai/usage.ts';
import { CONSISTENCY_TABLES,CONSISTENCY_VALIDATORS,assertConsistencyHistory,retainConsistencyAttempts } from './source-image-consistency/history.ts';
import { assertSourceImageHistory, validateSourceImageProvenance } from './source-image-provenance.ts';
import { assertCompletionHistory, retainCompletionOperations, validateCompletionOperation } from './listing-ai/completion-journal.ts';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename, rm, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { UserFacingError } from '../shared/errors.ts';
import { parseListingRules } from '../shared/listing-rules.ts';
import { openDatabase, SCHEMA_VERSION } from './database.ts';
import { RECORD_INDEXES } from './record-indexes.ts';
import { assertUnambiguousRecordJson } from './record-json.ts';
import { managedAssetPath } from './security.ts';
import { writeFileAtomically } from './files.ts';
import { registerManagedBackup } from './backup-retention.ts';
import type { BackupRetention } from './backup-retention.ts';
import { validatePersistedProfile, validatePersistedUpload } from './hosting/validation.ts';
import { validateExecutionTask } from './execution/records.ts';
import { validateFollowupRecord } from './followup/records.ts';
import { validateCategoryLibrary } from './catalog/records.ts';
import { validateProcurementBatch } from './procurement/records.ts';
import { assertAutomaticRejectionHistory } from './automatic-listing/rejection-history.ts';
import { assertPresentationResultOwner } from './ai/presentation-history.ts';
import { validateAiProfile, validateAiCall, validateStoredAiResult } from './ai/validation.ts';
import { assertSourceColorHistory } from './ai/source-color-validation.ts';
import { assertListingHistory } from './listing-ai/history.ts';
import { AiUsageLedger, retainAiUsage, retainSourceColorAttempts, retainImagePlanningAttempts, validateAiUsageRecord, validateStoredAiUsagePolicy } from './ai/usage.ts';
import { validateImageVersion, validateImageSelection } from './image-versions/validation.ts';
import { validateImageWriteOperation } from './image-versions/recovery.ts';
import { assertContentHistory, validateContentVersion } from './content/validation.ts';
import { COLLECTION_INDEXES } from './collection/indexes.ts';
import { validateCollectionCapture, validateCollectionReceipt } from './collection/validation.ts';
import { assertCollectionHistory } from './collection/records.ts';
import { MIAOSHOU_INDEXES } from './miaoshou/indexes.ts';
import { assertMiaoshouHistory, validateMiaoshouReceipt } from './miaoshou/persistence.ts';
import { clearMiaoshouConfig } from './miaoshou/vault.ts';
import { clearImageGenerationConnection } from './image-generation/vault.ts';
import { MIAOSHOU_SYNC_INDEXES, assertSyncHistory, validateSyncRun, validateSyncItem } from './miaoshou/sync-records.ts';
import { validateStoredImageWorkflowRun } from './image-workflow/records.ts';
import { assertImageWorkflowHistory } from './image-workflow/history.ts';
import { readImageRiskSettings } from './image-workflow/risk-settings.ts';
import { readCopyReviewSettings } from './listing-ai/review-settings.ts';
import { validateAutomaticListingTask } from './automatic-listing/records.ts';
import { validateItemLabelRecord } from './item-labels/records.ts';
import { validateItemLabelFormat } from './item-labels/adapter.ts';
import { validateLabelPdf } from './item-labels/files.ts';
import { validateShipmentDocument } from './procurement/shipment-documents.ts';
import { SKU_NAMING_TABLES } from './sku-naming/schema.ts';
import { assertSkuNamingHistory, retainSkuNamingHistory } from './sku-naming/records.ts';
import { assertSalesPlanHistory } from './sales-plans/history.ts';

const compress = promisify(gzip), decompress = promisify(gunzip);
const MAGIC = Buffer.from('HTC-BACKUP-1\n');
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_CONTAINER = 400 * 1024 * 1024;
const managedNames = ['red.sqlite', 'red.sqlite-wal', 'red.sqlite-shm', 'assets', 'documents'];
const activeDestinations = new Set<string>();
const requiredTables: Record<string, string[]> = {
  products: ['id','title','source_url','description','status','origin','revision','created_at','updated_at'],
  variants: ['id','product_id','sku','original_spec','normalized_spec','purchase_price','inventory','source_spec','source_purchase_price','position'],
  facts: ['id','product_id','name','value','source','source_ref','state','position'],
  assets: ['id','product_id','file_name','role','mime_type','width','height','byte_size','original_path','preview_path','sha256','created_at'],
  variant_assets: ['asset_id','variant_id','confirmed','updated_at'],
  audit_events: ['id','product_id','action','summary','detail_json','created_at'],
  amazon_targets: ['id','name','seller_id','marketplace_id','product_type','parentage_level','credential_ref'],
  schema_cache: ['cache_key','target_id','schema_json','meta_schema_json','checksum','requirements','parentage_level','fetched_at','expires_at'],
  listing_drafts: ['id','product_id','target_id','request_json','schema_checksum','validation_json','preview_json','state','created_at'],
  issues: ['id','draft_id','code','severity','category','field','message','status'],
};
const versionTwoTables: Record<string, string[]> = {
  amazon_targets: ['target_json','credential_generation'], schema_cache: ['snapshot_json'], listing_drafts: ['record_json','updated_at'],
  amazon_calls: ['id','target_id','created_at','event_json'], amazon_settings: ['key','value_json'], amazon_write_locks: ['listing_hash','draft_id','state','created_at'],
};
const versionThreeTables: Record<string, string[]> = {
  product_workspaces: ['product_id','lane','updated_at'],
};
const versionFourTables: Record<string, string[]> = {
  hosting_profiles: ['id','record_json'], hosting_uploads: ['id','record_json'], execution_tasks: ['id','record_json'],
};
const versionFiveTables: Record<string, string[]> = {
  ai_profiles: ['id','record_json'], ai_calls: ['id','record_json'], ai_results: ['id','record_json'],
};
const versionSixTables: Record<string, string[]> = {
  image_versions: ['id','record_json'], image_selections: ['id','record_json'], content_versions: ['id','record_json'],
};
const versionSevenTables: Record<string, string[]> = { image_write_operations: ['id','record_json'] };
const versionEightTables: Record<string, string[]> = { ai_usage_policies: ['id','record_json'], ai_usage_ledger: ['id','record_json'] };
const versionTenTables: Record<string, string[]> = { collection_receipts: ['id','record_json'], collection_captures: ['id','record_json'] };
const versionElevenTables: Record<string, string[]> = { miaoshou_receipts: ['id','record_json'] };
const versionThirteenTables: Record<string, string[]> = { miaoshou_sync_runs: ['id','record_json'], miaoshou_sync_items: ['id','record_json'] };
const versionFourteenTables: Record<string, string[]> = { listing_followups: ['id','record_json'], category_libraries: ['id','record_json'], procurement_batches: ['id','record_json'] };
const versionFifteenTables: Record<string, string[]> = { image_workflow_runs: ['id','record_json'] };
const versionNineteenTables: Record<string,string[]> = {source_image_provenance:['id','record_json']};
const versionEighteenTables: Record<string,string[]> = {listing_completion_operations:['id','record_json']};
const versionSixteenTables: Record<string, string[]> = { automatic_listing_tasks: ['id','record_json'], item_labels: ['id','record_json'], shipment_documents: ['id','record_json'] };
interface AssetCopy { path: string; data: string; sha256: string }
interface BackupManifest { format: 'htc-workspace-backup'; version: 1; source: { application: 'HTC'; kind: 'local-workspace'; databaseVersion: number }; retention: BackupRetention; createdAt: string; database: string; databaseSha256: string; assets: AssetCopy[] }
export interface PreparedRestore { stagingDirectory: string; createdAt: string; productCount: number; assetCount: number; expiresAt: string | null }
interface RestoreJournal { version: 1; phase: 'installing' | 'complete'; stagingDirectory: string; rollbackDirectory: string; priorNames: string[] }
function digest(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function managedBackupFile(root: string, path: string): string {
  if (/^documents\/(?:item-labels\/[a-f0-9-]{36}\/[1-9]\d{0,2}|shipments\/[a-f0-9-]{36})\.pdf$/.test(path)) return resolve(root, path);
  return managedAssetPath(root, path);
}
function passphraseCheck(value: string): void {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw new UserFacingError('备份口令需要 12–256 个字符');
}
async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolveKey, reject) => scrypt(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolveKey(key)));
}
function stagingPath(root: string, path: string, kind: 'staging' | 'rollback'): string {
  const actual = resolve(path), expectedRoot = resolve(root);
  if (dirname(actual).toLowerCase() !== expectedRoot.toLowerCase() || !new RegExp(`^\\.restore-${kind}-[0-9a-f-]{36}$`).test(basename(actual))) throw new UserFacingError('恢复暂存目录无效');
  return actual;
}
async function removeStaging(root: string, path: string, kind: 'staging' | 'rollback'): Promise<void> {
  const valid = stagingPath(root, path, kind);
  if (existsSync(valid) && (await lstat(valid)).isSymbolicLink()) throw new UserFacingError('恢复目录不能是链接');
  await rm(valid, { recursive: true, force: true });
}
function checkDatabase(path: string): { productCount: number; assetCount: number; assetPaths: Set<string>; artifactChecks: Map<string, { sha256: string; byteSize: number }> } {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA trusted_schema=OFF');
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view') OR (type='table' AND upper(sql) LIKE 'CREATE VIRTUAL TABLE%')").get()) throw new UserFacingError('备份包含不受支持的数据库对象');
    const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
    if (version < 1 || version > SCHEMA_VERSION) throw new UserFacingError('备份的数据版本不受当前工作台支持，请更新后重试');
    for (const [name, expected] of [...Object.entries(requiredTables), ...Object.entries(version >= 2 ? versionTwoTables : {}), ...Object.entries(version >= 3 ? versionThreeTables : {}), ...Object.entries(version >= 4 ? versionFourTables : {}), ...Object.entries(version >= 5 ? versionFiveTables : {}), ...Object.entries(version >= 6 ? versionSixTables : {}), ...Object.entries(version >= 7 ? versionSevenTables : {}), ...Object.entries(version >= 8 ? versionEightTables : {}), ...Object.entries(version >= 10 ? versionTenTables : {}), ...Object.entries(version >= 11 ? versionElevenTables : {}), ...Object.entries(version >= 13 ? versionThirteenTables : {}), ...Object.entries(version >= 14 ? versionFourteenTables : {}), ...Object.entries(version >= 15 ? versionFifteenTables : {}), ...Object.entries(version >= 16 ? versionSixteenTables : {}), ...Object.entries(version >= 17 ? SKU_NAMING_TABLES : {}), ...Object.entries(version >= 18 ? versionEighteenTables : {}), ...Object.entries(version >= 19 ? versionNineteenTables : {}), ...Object.entries(version >= 20 ? CONSISTENCY_TABLES : {}), ...Object.entries(version >= 21 ? {...CORRECTION_TABLES,amazon_write_locks:[...versionTwoTables.amazon_write_locks,'owner_kind','owner_id']} : {})]) {
      const columns = new Set(database.prepare(`PRAGMA table_xinfo(${name})`).all().map(row => row.name));
      if (expected.some(column => !columns.has(column))) throw new UserFacingError('备份数据库结构不完整，当前工作区未更改');
    }
    const approved: Record<string, string[]> = Object.fromEntries(Object.entries(requiredTables).map(([name, columns]) => [name, [...columns, ...(version >= 2 ? versionTwoTables[name] ?? [] : [])]]));
    if (version >= 2) {
      readImageRiskSettings(database);
      readCopyReviewSettings(database);
      for (const [name, columns] of Object.entries(versionTwoTables)) if (!approved[name]) approved[name] = columns;
      approved.amazon_exchanges = ['id','draft_id','created_at','exchange_json'];
    }
    if (version >= 3) Object.assign(approved, versionThreeTables);
    if (version >= 4) Object.assign(approved, versionFourTables);
    if (version >= 5) Object.assign(approved, versionFiveTables);
    if (version >= 6) Object.assign(approved, versionSixTables);
    if (version >= 7) Object.assign(approved, versionSevenTables);
    if (version >= 8) Object.assign(approved, versionEightTables);
    if (version >= 10) Object.assign(approved, versionTenTables);
    if (version >= 11) Object.assign(approved, versionElevenTables);
    if (version >= 13) Object.assign(approved, versionThirteenTables);
    if (version >= 14) Object.assign(approved, versionFourteenTables);
    if (version >= 15) Object.assign(approved, versionFifteenTables);
    if (version >= 16) Object.assign(approved, versionSixteenTables);
    if (version >= 17) Object.assign(approved, SKU_NAMING_TABLES);
    if (version >= 18) Object.assign(approved, versionEighteenTables);
    if (version >= 19) Object.assign(approved, versionNineteenTables);
    if (version >= 20) Object.assign(approved, CONSISTENCY_TABLES);
    if (version >= 21) {Object.assign(approved,CORRECTION_TABLES);approved.amazon_write_locks=[...versionTwoTables.amazon_write_locks,'owner_kind','owner_id'];assertCorrectionHistory(database);}
    if(version>=22){Object.assign(approved,MIGRATION_TABLES);assertMigrationJournal(database);}
    if(version>=23){Object.assign(approved,SOURCE_TABLES);assertSourceAdoptionHistory(database);}
    if(version>=24){Object.assign(approved,SCHEMA_OPERATION_TABLES);assertSchemaOperationHistory(database);}
    for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const name = String(row.name), expected = approved[name];
      const actual = database.prepare('SELECT name,hidden FROM pragma_table_xinfo(?)').all(name);
      if (!expected || actual.length !== expected.length || actual.some(column => column.hidden !== 0 || !expected.includes(String(column.name)))) throw new UserFacingError('备份含有不支持的数据库结构，未更改工作区');
    }
    if (version >= 4) {
      for (const name of [...Object.keys(versionFourTables), ...Object.keys(version >= 5 ? versionFiveTables : {}), ...Object.keys(version >= 6 ? versionSixTables : {}), ...Object.keys(version >= 7 ? versionSevenTables : {}), ...Object.keys(version >= 8 ? versionEightTables : {}), ...Object.keys(version >= 10 ? versionTenTables : {}), ...Object.keys(version >= 11 ? versionElevenTables : {}), ...Object.keys(version >= 13 ? versionThirteenTables : {}), ...Object.keys(version >= 14 ? versionFourteenTables : {}), ...Object.keys(version >= 15 ? versionFifteenTables : {}), ...Object.keys(version >= 16 ? versionSixteenTables : {}), ...Object.keys(version >= 18 ? versionEighteenTables : {}), ...Object.keys(version >= 19 ? versionNineteenTables : {}), ...Object.keys(version >= 20 ? CONSISTENCY_TABLES : {})]) {
        const table = database.prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND name=?").get(name);
        if (!table || table.wr !== 0) throw new UserFacingError('备份任务或 FTP 表必须保留标准行标识');
        const columns = database.prepare(`PRAGMA table_xinfo(${name})`).all(), indexes = database.prepare(`PRAGMA index_list(${name})`).all();
        const primary = indexes.filter(index => index.origin === 'pk'), allowedIndexes = [...(version >= 9 ? RECORD_INDEXES.filter(index => index.table === name) : []), ...(version >= 10 ? COLLECTION_INDEXES.filter(index => index.table === name) : []), ...(version >= 11 ? MIAOSHOU_INDEXES.filter(index => index.table === name) : []), ...(version >= 13 ? MIAOSHOU_SYNC_INDEXES.filter(index => index.table === name) : [])];
        if (columns.some(c => c.type !== 'TEXT' || c.notnull !== 1 || c.pk !== (c.name === 'id' ? 1 : 0) || c.dflt_value !== null)
          || indexes.length !== 1 + allowedIndexes.length || primary.length !== 1 || primary[0].unique !== 1 || primary[0].partial !== 0
          || database.prepare(`PRAGMA foreign_key_list(${name})`).all().length) throw new UserFacingError('备份任务或 FTP 表结构不正确');
        const keys = database.prepare('SELECT name,coll,desc FROM pragma_index_xinfo(?) WHERE key=1').all(String(primary[0].name));
        if (keys.length !== 1 || keys[0].name !== 'id' || keys[0].coll !== 'BINARY' || keys[0].desc !== 0) throw new UserFacingError('备份任务或 FTP 索引不正确');
        for (const declaration of allowedIndexes) {
          const index = indexes.find(index => index.name === declaration.name);
          const stored = database.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='index' AND name=?").get(declaration.name);
          const expressions = database.prepare('SELECT cid,name,coll,desc FROM pragma_index_xinfo(?) WHERE key=1').all(declaration.name);
          if (!index || index.origin !== 'c' || index.unique !== 0 || index.partial !== 0 || stored?.tbl_name !== name || stored.sql !== declaration.sql
            || expressions.length !== declaration.expressions || expressions.some(key => key.cid !== -2 || key.name !== null || key.coll !== 'BINARY' || key.desc !== 0)) throw new UserFacingError('备份记录索引不正确');
        }
        assertUnambiguousRecordJson(database, name);
        for (const row of database.prepare(`SELECT id,record_json FROM ${name}`).all()) {
          if (typeof row.record_json !== 'string' || Buffer.byteLength(row.record_json) > 4 * 1024 * 1024) throw new UserFacingError('备份任务或 FTP 记录过大');
          const value = JSON.parse(row.record_json);
          const validators = { ...CONSISTENCY_VALIDATORS, source_image_provenance:validateSourceImageProvenance, hosting_profiles: validatePersistedProfile, hosting_uploads: validatePersistedUpload, execution_tasks: validateExecutionTask,
            listing_completion_operations:validateCompletionOperation, ai_profiles: validateAiProfile, ai_calls: validateAiCall, ai_results: validateStoredAiResult, ai_usage_policies: validateStoredAiUsagePolicy, ai_usage_ledger: validateAiUsageRecord,
            image_versions: validateImageVersion, image_selections: validateImageSelection, content_versions: validateContentVersion, image_write_operations: validateImageWriteOperation,
            collection_receipts: validateCollectionReceipt, collection_captures: validateCollectionCapture, miaoshou_receipts: validateMiaoshouReceipt,
            miaoshou_sync_runs: validateSyncRun, miaoshou_sync_items: validateSyncItem,
            listing_followups: validateFollowupRecord, category_libraries: validateCategoryLibrary, procurement_batches: validateProcurementBatch, image_workflow_runs: validateStoredImageWorkflowRun,
            automatic_listing_tasks: validateAutomaticListingTask, item_labels: validateItemLabelRecord, shipment_documents: validateShipmentDocument };
          const validated = validators[name as keyof typeof validators](value);
          if (validated.id !== row.id) throw new UserFacingError('备份任务或 FTP 记录身份不一致');
        }
      }
    }
    if (version >= 18) assertCompletionHistory(database);
    if (version >= 10) assertCollectionHistory(database);
    if (version >= 11) assertMiaoshouHistory(database);
    if (version >= 13) assertSyncHistory(database);
    if (version >= 17) { assertSkuNamingHistory(database); assertSalesPlanHistory(database); }
    if (version >= 3) {
      const columns = database.prepare('PRAGMA table_xinfo(product_workspaces)').all();
      const references = database.prepare('PRAGMA foreign_key_list(product_workspaces)').all();
      if (columns.some(column => column.type !== 'TEXT' || column.notnull !== 1 || column.pk !== (column.name === 'product_id' ? 1 : 0))
        || references.length !== 1 || references[0].table !== 'products' || references[0].from !== 'product_id'
        || references[0].to !== 'id' || references[0].on_delete !== 'CASCADE') throw new UserFacingError('备份工作区分流表结构不完整');
      const indexes = database.prepare('PRAGMA index_list(product_workspaces)').all();
      // Extra UNIQUE constraints can silently replace another product's placement.
      // The application schema contains only SQLite's product_id primary-key index.
      if (indexes.length !== 1 || indexes[0].origin !== 'pk' || indexes[0].unique !== 1 || indexes[0].partial !== 0) {
        throw new UserFacingError('备份工作区分流表含有不支持的索引或唯一约束');
      }
      for (const row of database.prepare('SELECT lane,updated_at FROM product_workspaces').all()) {
        if (typeof row.lane !== 'string' || !['inbox', 'manual', 'automatic', 'ignored'].includes(row.lane)
          || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) throw new UserFacingError('备份包含无效的工作区分流记录');
      }
    }
    if (version >= 2) {
      const allowed = ['id','name','mode','sellerId','marketplaceId','marketplaceName','region','locale','paused','configured','credentialUpdatedAt','lastError'];
      for (const row of database.prepare('SELECT id,target_json FROM amazon_targets WHERE target_json IS NOT NULL').all()) {
        const target = JSON.parse(String(row.target_json)) as Record<string, unknown>;
        if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).length !== allowed.length || Object.keys(target).some(key => !allowed.includes(key))
          || ['id','name','sellerId','marketplaceId','marketplaceName','region','locale','mode'].some(key => typeof target[key] !== 'string' || !(target[key] as string).trim())
          || target.id !== row.id || !['demo','live'].includes(String(target.mode)) || !['na','eu','fe'].includes(String(target.region))
          || typeof target.configured !== 'boolean' || typeof target.paused !== 'boolean'
          || (target.credentialUpdatedAt !== null && (typeof target.credentialUpdatedAt !== 'string' || !Number.isFinite(Date.parse(target.credentialUpdatedAt))))
          || (target.lastError !== null && typeof target.lastError !== 'string')) throw new UserFacingError('备份店铺配置格式不正确或含有不允许的字段');
      }
    }
    const jsonColumns: [string, string[]][] = [['audit_events',['detail_json']], ['schema_cache',['schema_json','meta_schema_json']], ['listing_drafts',['request_json','validation_json','preview_json']]];
    if (version >= 2) jsonColumns.push(['schema_cache',['snapshot_json']], ['listing_drafts',['record_json']], ['amazon_calls',['event_json']], ['amazon_settings',['value_json']]);
    for (const [table, columns] of jsonColumns) for (const column of columns) if (database.prepare(`SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL AND NOT json_valid(${column}) LIMIT 1`).get()) throw new UserFacingError('备份包含格式损坏的数据记录');
    if (version >= 2) {
      const rules = database.prepare("SELECT value_json FROM amazon_settings WHERE key='listing_rules_v1'").get();
      if (rules) parseListingRules(JSON.parse(String(rules.value_json)));
      const labelFormat = database.prepare("SELECT value_json FROM amazon_settings WHERE key='item_label_format_v1'").get();
      if (labelFormat) validateItemLabelFormat(JSON.parse(String(labelFormat.value_json)));
    }
    if (database.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok' || database.prepare('PRAGMA foreign_key_check').all().length) throw new UserFacingError('备份数据库完整性检查未通过');
    const products = Number(database.prepare('SELECT COUNT(*) AS n FROM products').get()!.n);
    const assets = database.prepare('SELECT original_path, preview_path FROM assets').all();
    const paths = new Set<string>();
    for (const asset of assets) for (const key of ['original_path', 'preview_path']) {
      const assetPath = String(asset[key]); managedAssetPath(dirname(path), assetPath); paths.add(assetPath);
    }
    const artifactChecks = new Map<string, { sha256: string; byteSize: number }>();
    if(version>=20)for(const asset of assertConsistencyHistory(database))artifactChecks.set(asset.relativePath,{sha256:asset.sha256,byteSize:asset.byteSize});
    if(version>=19)for(const asset of assertSourceImageHistory(database))artifactChecks.set(asset.relativePath,{sha256:asset.sha256,byteSize:asset.byteSize});
    if (version >= 16) {
      const batches = new Map(database.prepare('SELECT record_json FROM procurement_batches').all().map(row => {
        const batch = validateProcurementBatch(JSON.parse(String(row.record_json))); return [batch.id, batch] as const;
      }));
      for (const row of database.prepare('SELECT record_json FROM item_labels').all()) {
        const label = validateItemLabelRecord(JSON.parse(String(row.record_json))), batch = batches.get(label.batchId);
        if (!batch || !batch.lines.some(line => line.id === label.lineId && line.draftId === label.draftId && line.sellerId === label.sellerId && line.marketplaceId === label.marketplaceId) || label.mode !== batch.mode) throw new UserFacingError('商品标签与备货批次关联不完整');
        for (const file of label.files) {
          managedBackupFile(dirname(path), file.relativePath);
          if (paths.has(file.relativePath)) throw new UserFacingError('商品标签文件归属重复');
          paths.add(file.relativePath); artifactChecks.set(file.relativePath, { sha256: file.sha256, byteSize: file.byteSize });
        }
      }
      for (const row of database.prepare('SELECT record_json FROM shipment_documents').all()) {
        const doc = validateShipmentDocument(JSON.parse(String(row.record_json)));
        if (!batches.has(doc.batchId) || paths.has(doc.relativePath)) throw new UserFacingError('箱唛文件与备货批次关联不完整');
        managedBackupFile(dirname(path), doc.relativePath); paths.add(doc.relativePath); artifactChecks.set(doc.relativePath, { sha256: doc.sha256, byteSize: doc.byteSize });
      }
    }
    if (version >= 15) for (const row of database.prepare("SELECT a.original_path,a.sha256,a.byte_size FROM assets a JOIN image_workflow_runs w ON a.id=json_extract(w.record_json,'$.approvedAssetId') WHERE json_extract(w.record_json,'$.status')='COMPLETED'").all()) {
      artifactChecks.set(String(row.original_path), {sha256:String(row.sha256),byteSize:Number(row.byte_size)});
    }
    if(version>=15)for(const row of database.prepare("SELECT a.original_path,a.sha256,a.byte_size FROM image_workflow_runs w, json_each(w.record_json,'$.slots') s JOIN assets a ON a.id=json_extract(s.value,'$.approvedAssetId') WHERE json_extract(s.value,'$.status')='PASSED'").all()){
      artifactChecks.set(String(row.original_path),{sha256:String(row.sha256),byteSize:Number(row.byte_size)});
    }
    if (version >= 6) {
      const results = new Map(database.prepare('SELECT record_json FROM ai_results').all().map(row => { const result = validateStoredAiResult(JSON.parse(String(row.record_json))); return [result.id, result] as const; }));
      const calls = new Map(database.prepare('SELECT record_json FROM ai_calls').all().map(row => { const call = validateAiCall(JSON.parse(String(row.record_json))); return [call.id, call] as const; }));
      for(const result of results.values())assertPresentationResultOwner(result,calls.get(result.callId),database);
      for(const asset of assertSourceColorHistory(database,results,calls))artifactChecks.set(asset.relativePath,{sha256:asset.sha256,byteSize:asset.byteSize});
      if (version >= 15) assertImageWorkflowHistory(database, results, calls);
      if(version>=16)for(const row of database.prepare('SELECT record_json FROM automatic_listing_tasks').all())assertAutomaticRejectionHistory(database,validateAutomaticListingTask(JSON.parse(String(row.record_json))));
      for (const row of database.prepare('SELECT record_json FROM listing_drafts WHERE record_json IS NOT NULL').all()) assertListingHistory(JSON.parse(String(row.record_json)).draft, results, calls, database);
      for (const row of database.prepare('SELECT record_json FROM content_versions').all()) assertContentHistory(validateContentVersion(JSON.parse(String(row.record_json))), results, calls);
      const versions = database.prepare('SELECT record_json FROM image_versions').all().map(row => validateImageVersion(JSON.parse(String(row.record_json))));
      if (version >= 7) for (const row of database.prepare('SELECT record_json FROM image_write_operations').all()) {
        const operation = validateImageWriteOperation(JSON.parse(String(row.record_json)));
        if (operation.state === 'COMMITTED' && !versions.some(record => JSON.stringify(record) === JSON.stringify(operation.candidate))) throw new UserFacingError('图片写入日志与已提交版本不一致');
      }
      for (const record of versions) {
        const source = database.prepare('SELECT product_id,sha256 FROM assets WHERE id=?').get(record.sourceAssetId);
        if (!source || source.product_id !== record.productId || source.sha256 !== record.sourceSha256 || database.prepare('SELECT id FROM assets WHERE id=?').get(record.id)) throw new UserFacingError('图片版本的来源关联不完整');
        for (const [file, sha256, byteSize] of [[record.originalPath, record.sha256, record.byteSize], [record.previewPath, record.previewSha256, record.previewByteSize]] as const) {
          managedAssetPath(dirname(path), file); if (paths.has(file)) throw new UserFacingError('图片版本文件出现重复归属');
          paths.add(file); artifactChecks.set(file, { sha256, byteSize });
        }
      }
      for (const row of database.prepare('SELECT record_json FROM image_selections').all()) {
        const record = validateImageSelection(JSON.parse(String(row.record_json))), source = database.prepare('SELECT product_id,sha256 FROM assets WHERE id=?').get(record.sourceAssetId);
        if (!source || source.product_id !== record.productId || source.sha256 !== record.sourceSha256 || (record.versionId && !versions.some(v => v.id === record.versionId && v.sourceAssetId === record.sourceAssetId && v.productId === record.productId))) throw new UserFacingError('图片选用记录的来源关联不完整');
      }
    }
    return { productCount: products, assetCount: assets.length, assetPaths: paths, artifactChecks };
  } catch (error) {
    if (error instanceof UserFacingError) throw error;
    throw new UserFacingError('备份数据库格式不正确或已经损坏');
  } finally { database?.close(); }
}

function snapshotRetention(path: string): BackupRetention {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT value_json FROM amazon_settings WHERE key='data_policy'").get();
    const policy = row ? JSON.parse(String(row.value_json)) as { retentionDays: number; logRetentionDays: number } : { retentionDays: 180, logRetentionDays: 365 };
    if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 548 || !Number.isInteger(policy.logRetentionDays) || policy.logRetentionDays < 365) throw new UserFacingError('备份的数据保留设置无效');
    const dates = database.prepare(`SELECT fetched_at AS at FROM schema_cache UNION ALL SELECT created_at FROM listing_drafts
      UNION ALL SELECT created_at FROM amazon_exchanges`).all().map(record => Date.parse(String(record.at)));
    const calls = database.prepare('SELECT created_at FROM amazon_calls').all().map(record => Date.parse(String(record.created_at)));
    if ([...dates, ...calls].some(date => !Number.isFinite(date))) throw new UserFacingError('备份的 Amazon 数据时间无效');
    const oldest = dates.length ? dates.reduce((a, b) => Math.min(a, b)) : null;
    const expiries = [...(oldest === null ? [] : [oldest + policy.retentionDays * 86400000]), ...(calls.length ? [calls.reduce((a, b) => Math.min(a, b)) + policy.logRetentionDays * 86400000] : [])];
    return { amazonDays: policy.retentionDays, logDays: policy.logRetentionDays, dataOldestAt: oldest === null ? null : new Date(oldest).toISOString(), expiresAt: expiries.length ? new Date(expiries.reduce((a, b) => Math.min(a, b))).toISOString() : null };
  } finally { database.close(); }
}

function disconnectSnapshot(path: string): void {
  const database = openDatabase(dirname(path));
  try {
    revokeSchemaInFlight(database);
    database.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE;');
    database.exec('UPDATE amazon_targets SET credential_ref=NULL;');
    invalidateCorrectionAuthorizations(database);
    const columns = database.prepare('PRAGMA table_xinfo(amazon_targets)').all().map(row => row.name);
    if (columns.includes('target_json') && columns.includes('credential_generation')) database.exec(`
      UPDATE amazon_targets SET credential_generation=credential_generation+1,
      target_json=json_set(target_json,'$.configured',json('false'),'$.paused',json('true'),'$.lastError','已从备份恢复，请重新导入授权配置')
      WHERE json_extract(target_json,'$.mode')='live';`);
    database.exec(`UPDATE listing_drafts SET preview_json=NULL,
      state=CASE WHEN state='AMAZON_VALIDATED' THEN 'DRAFT' ELSE state END,
      record_json=json_set(record_json,'$.preview',NULL,'$.draft.previewedAt',NULL,
        '$.draft.state',CASE WHEN state='AMAZON_VALIDATED' THEN 'DRAFT' ELSE state END)
      WHERE record_json IS NOT NULL AND target_id IN (SELECT id FROM amazon_targets WHERE json_extract(target_json,'$.mode')='live');`);
    database.exec(`UPDATE hosting_profiles SET record_json=json_set(record_json,'$.configured',json('false'),'$.enabled',json('false'),'$.generation',json_extract(record_json,'$.generation')+1);
      UPDATE hosting_uploads SET record_json=json_set(record_json,'$.status','PENDING') WHERE json_extract(record_json,'$.status') IN ('UPLOADING','VERIFYING');
      UPDATE execution_tasks SET record_json=json_set(record_json,'$.status','PAUSED','$.revision',json_extract(record_json,'$.revision')+1,'$.error','已恢复备份；请重新配置授权并核对任务范围')
      WHERE json_extract(record_json,'$.status') NOT IN ('COMPLETED','CANCELLED');`);
    database.exec(`UPDATE ai_profiles SET record_json=json_set(record_json,'$.configured',json('false'),'$.enabled',json('false'),'$.generation',json_extract(record_json,'$.generation')+1);`);
    database.prepare(`UPDATE ai_calls SET record_json=json_set(record_json,'$.status','FAILED','$.errorCode','INTERRUPTED','$.finishedAt',max(?,json_extract(record_json,'$.startedAt')))
      WHERE json_extract(record_json,'$.status')='RUNNING'`).run(new Date().toISOString());
    new AiUsageLedger(database, () => new Date()).recoverPending();
    database.exec(`UPDATE miaoshou_sync_runs SET record_json=json_set(record_json,'$.status','paused','$.errorCode',NULL) WHERE json_extract(record_json,'$.status')='running'`);
    database.exec(`UPDATE image_workflow_runs SET record_json=json_set(record_json,'$.status','INTERRUPTED','$.error','已恢复备份，自动图片请求未重发，请重新配置接口后核对任务') WHERE json_extract(record_json,'$.status')='RUNNING'`);
    database.exec(`UPDATE automatic_listing_tasks SET record_json=json_set(record_json,'$.status','PAUSED','$.revision',json_extract(record_json,'$.revision')+1,'$.error','已恢复备份；请核对配置和任务范围后继续') WHERE json_extract(record_json,'$.status') NOT IN ('COMPLETED','CANCELLED');
      UPDATE item_labels SET record_json=json_set(record_json,'$.paused',json('true'),'$.status','FAILED','$.errorCode','INTERRUPTED','$.message','已恢复备份，未自动重发中断的标签请求','$.nextDueAt',NULL) WHERE json_extract(record_json,'$.status') IN ('REQUESTING','DOWNLOADING');
      UPDATE item_labels SET record_json=json_set(record_json,'$.paused',json('true')) WHERE json_extract(record_json,'$.status') NOT IN ('READY','STALE','CANCELLED');`);
    database.exec(`UPDATE listing_followups SET record_json=json_set(record_json,'$.status','NEEDS_ATTENTION','$.reason','TARGET_UNAVAILABLE',
      '$.nextDueAt',NULL,'$.revision',json_extract(record_json,'$.revision')+1,'$.error','工作区已恢复，请核对店铺授权后重新安排回读')`);
    // SQLite backups copy free pages too. Rebuild only the staged snapshot so
    // deleted API payloads and old credential references cannot enter exports.
    database.exec('VACUUM');
  } finally { database.close(); }
}

function retainSafetyHistory(currentPath: string, snapshotPath: string): void {
  if (!existsSync(currentPath)) return;
  const current = new DatabaseSync(currentPath, { readOnly: true });
  const snapshot = new DatabaseSync(snapshotPath);
  try {
    snapshot.exec('BEGIN IMMEDIATE');
    if (current.prepare("SELECT 1 FROM sqlite_master WHERE name='amazon_write_locks' AND type='table'").get() && snapshot.prepare("SELECT 1 FROM sqlite_master WHERE name='amazon_write_locks' AND type='table'").get()) {
      const owners=current.prepare('PRAGMA table_info(amazon_write_locks)').all().some(r=>r.name==='owner_kind');
      const insert = snapshot.prepare("INSERT INTO amazon_write_locks(listing_hash,draft_id,state,created_at,owner_kind,owner_id) VALUES(?,?,'UNKNOWN',?,?,?) ON CONFLICT(listing_hash) DO UPDATE SET state='UNKNOWN',owner_kind=excluded.owner_kind,owner_id=excluded.owner_id,draft_id=excluded.draft_id");
      for (const row of current.prepare('SELECT * FROM amazon_write_locks').all()) insert.run(row.listing_hash, row.draft_id, row.created_at,owners?row.owner_kind:'draft',owners?(row.owner_id||row.draft_id):row.draft_id);
    }
    if (current.prepare("SELECT 1 FROM sqlite_master WHERE name='amazon_calls' AND type='table'").get()) {
      const addCall = snapshot.prepare('INSERT OR IGNORE INTO amazon_calls(id,target_id,created_at,event_json) VALUES(?,?,?,?)');
      for (const row of current.prepare('SELECT id,target_id,created_at,event_json FROM amazon_calls').all()) addCall.run(row.id, row.target_id, row.created_at, row.event_json);
    }
    retainCorrectionHistory(current,snapshot);
    retainAiUsage(current, snapshot);
    retainSchemaRetryBudgets(current,snapshot);
    restoreSchemaOperations(current,snapshot);
    retainSchemaResponseCalls(current,snapshot);
    retainConsistencyAttempts(current,snapshot);
    retainSourceColorAttempts(current, snapshot);
    retainImagePlanningAttempts(current, snapshot);
    retainCompletionOperations(current, snapshot);
    retainSkuNamingHistory(current, snapshot);
    snapshot.exec('COMMIT');
  } catch (error) { try { snapshot.exec('ROLLBACK'); } catch { /* Transaction may have failed before acquiring its lock. */ } throw error;
  } finally { snapshot.close(); current.close(); }
}

export async function createWorkspaceBackup(directory: string, destination: string, passphrase: string): Promise<Omit<PreparedRestore, 'stagingDirectory'>> {
  passphraseCheck(passphrase);
  const root = resolve(directory), staging = join(root, `.restore-staging-${randomUUID()}`);
  const target = resolve(destination), local = relative(root, target).replaceAll('\\', '/').toLowerCase();
  if (extname(target).toLowerCase() !== '.htcbackup' || /^(assets|documents|amazon-vault|hosting-vault|ai-vault|miaoshou-vault|browser|\.restore-[^/]+)(\/|$)/.test(local)) throw new UserFacingError('请选择独立的 .htcbackup 备份文件，不能覆盖工作区内部文件');
  if (existsSync(target)) throw new UserFacingError('备份文件已存在，请选择新文件名；原备份和清理登记保持不变');
  const destinationKey = target.toLowerCase();
  if (activeDestinations.has(destinationKey)) throw new UserFacingError('此备份文件正在写入，请完成后再试');
  activeDestinations.add(destinationKey);
  let source: DatabaseSync | undefined;
  try {
    await mkdir(staging, { recursive: true });
    source = new DatabaseSync(join(root, 'red.sqlite'), { readOnly: true });
    const snapshot = join(staging, 'red.sqlite');
    await backup(source, snapshot); source.close(); source = undefined;
    checkDatabase(snapshot); disconnectSnapshot(snapshot);
    const info = checkDatabase(snapshot);
    let size = (await lstat(snapshot)).size;
    for (const path of info.assetPaths) {
      const file = managedBackupFile(root, path), metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (await realpath(file)).toLowerCase() !== resolve(file).toLowerCase()) throw new UserFacingError('素材路径异常，无法生成完整备份');
      size += metadata.size;
    }
    if (size > MAX_BYTES) throw new UserFacingError('当前完整备份支持最多 256 MB 原始数据；请先整理素材后再备份');
    const database = await readFile(snapshot), assets: AssetCopy[] = [];
    for (const path of info.assetPaths) {
      const data = await readFile(managedBackupFile(root, path)), expected = info.artifactChecks.get(path);
      if (expected && (data.length !== expected.byteSize || digest(data) !== expected.sha256)) throw new UserFacingError('图片版本文件校验未通过，未创建备份');
      if (path.startsWith('documents/')) await validateLabelPdf(data);
      assets.push({ path, data: data.toString('base64'), sha256: digest(data) });
    }
    const createdAt = new Date().toISOString(), retention = snapshotRetention(snapshot);
    const manifest: BackupManifest = { format: 'htc-workspace-backup', version: 1, source: { application: 'HTC', kind: 'local-workspace', databaseVersion: SCHEMA_VERSION }, retention, createdAt, database: database.toString('base64'), databaseSha256: digest(database), assets };
    const salt = randomBytes(16), iv = randomBytes(12), header = Buffer.concat([MAGIC, salt, iv]);
    const key = await deriveKey(passphrase, salt);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
      const plain = await compress(Buffer.from(JSON.stringify(manifest)));
      const encrypted = Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      await registerManagedBackup(root, { path: target, sha256: digest(encrypted), byteSize: encrypted.length, createdAt, retention });
      await writeFileAtomically(destination, encrypted, false);
    } finally { key.fill(0); }
    return { createdAt, productCount: info.productCount, assetCount: info.assetCount, expiresAt: retention.expiresAt };
  } finally {
    try { source?.close(); await removeStaging(root, staging, 'staging'); }
    finally { activeDestinations.delete(destinationKey); }
  }
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > MAX_CONTAINER || value.length % 4 !== 0) throw new UserFacingError('备份包含无效文件数据');
  const data = Buffer.from(value, 'base64');
  if (data.toString('base64') !== value) throw new UserFacingError('备份包含无效文件数据');
  return data;
}
export async function prepareWorkspaceRestore(directory: string, sourceFile: string, passphrase: string): Promise<PreparedRestore> {
  passphraseCheck(passphrase);
  if ((await lstat(sourceFile)).size > MAX_CONTAINER) throw new UserFacingError('备份文件超过 400 MB，无法恢复');
  const bytes = await readFile(sourceFile), offset = MAGIC.length;
  if (bytes.length < offset + 44 || !bytes.subarray(0, offset).equals(MAGIC)) throw new UserFacingError('不是受支持的 HTC 加密备份');
  const salt = bytes.subarray(offset, offset + 16), iv = bytes.subarray(offset + 16, offset + 28), headerEnd = offset + 28;
  const key = await deriveKey(passphrase, salt);
  let value: BackupManifest;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(bytes.subarray(0, headerEnd)); decipher.setAuthTag(bytes.subarray(-16));
    const compressed = Buffer.concat([decipher.update(bytes.subarray(headerEnd, -16)), decipher.final()]);
    const plain = await decompress(compressed, { maxOutputLength: MAX_CONTAINER });
    value = JSON.parse(plain.toString('utf8')) as BackupManifest;
  } catch { throw new UserFacingError('口令不正确或备份已经损坏，当前工作区未更改'); }
  finally { key.fill(0); }
  if (!value || value.format !== 'htc-workspace-backup' || value.version !== 1 || !Array.isArray(value.assets) || value.assets.length > 20_000 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new UserFacingError('备份清单格式不正确');
  if (Object.keys(value).some(key => !['format','version','source','retention','createdAt','database','databaseSha256','assets'].includes(key)) || value.source?.application !== 'HTC' || value.source.kind !== 'local-workspace' || !Number.isInteger(value.source.databaseVersion) || value.source.databaseVersion > SCHEMA_VERSION || !value.retention) throw new UserFacingError('备份来源或数据保留信息不完整');
  const root = resolve(directory), staging = join(root, `.restore-staging-${randomUUID()}`);
  await mkdir(join(staging, 'assets'), { recursive: true });
  try {
    const database = decodeBase64(value.database);
    if (database.length > MAX_BYTES || digest(database) !== value.databaseSha256) throw new UserFacingError('备份数据库校验未通过');
    const snapshot = join(staging, 'red.sqlite'); await writeFile(snapshot, database, { flag: 'wx' });
    const info = checkDatabase(snapshot);
    const found = new Set<string>(); let size = database.length;
    for (const asset of value.assets) {
      if (!asset || typeof asset.path !== 'string' || !info.assetPaths.has(asset.path) || found.has(asset.path)) throw new UserFacingError('备份素材清单不匹配或包含重复路径');
      const path = managedBackupFile(staging, asset.path), data = decodeBase64(asset.data);
      size += data.length;
      if (size > MAX_BYTES || digest(data) !== asset.sha256) throw new UserFacingError('备份素材校验未通过或数据超限');
      const expected = info.artifactChecks.get(asset.path);
      if (expected && (data.length !== expected.byteSize || digest(data) !== expected.sha256)) throw new UserFacingError('备份图片版本与记录不一致');
      if (asset.path.startsWith('documents/')) await validateLabelPdf(data);
      found.add(asset.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, data, { flag: 'wx' });
    }
    if (found.size !== info.assetPaths.size) throw new UserFacingError('备份缺少商品图片，无法完整恢复');
    disconnectSnapshot(snapshot);
    const retention = snapshotRetention(snapshot);
    if (JSON.stringify(value.retention) !== JSON.stringify(retention)) throw new UserFacingError('备份保留信息与数据快照不匹配');
    retainSafetyHistory(join(root, 'red.sqlite'), snapshot);
    return { stagingDirectory: staging, createdAt: value.createdAt, productCount: info.productCount, assetCount: info.assetCount, expiresAt: retention.expiresAt };
  } catch (error) { await removeStaging(root, staging, 'staging'); throw error; }
}

export async function discardPreparedRestore(directory: string, prepared: PreparedRestore): Promise<void> {
  await removeStaging(directory, prepared.stagingDirectory, 'staging');
}

async function recoverJournal(root: string, journal: RestoreJournal): Promise<void> {
  const staging = stagingPath(root, journal.stagingDirectory, 'staging'), rollback = stagingPath(root, journal.rollbackDirectory, 'rollback');
  if (journal.version !== 1 || !['installing', 'complete'].includes(journal.phase) || !Array.isArray(journal.priorNames) || journal.priorNames.some(name => !managedNames.includes(name))) throw new UserFacingError('恢复日志不完整，请保留当前数据目录后联系维护人员');
  for (const path of [staging, rollback]) if (existsSync(path) && (await lstat(path)).isSymbolicLink()) throw new UserFacingError('恢复暂存目录不能是链接');
  if (journal.phase === 'installing') {
    for (const name of managedNames) {
      const prior = join(rollback, name), current = join(root, name);
      if (existsSync(prior)) { await rm(current, { recursive: name === 'assets' || name === 'documents', force: true }); await rename(prior, current); }
      else if (!journal.priorNames.includes(name)) await rm(current, { recursive: name === 'assets' || name === 'documents', force: true });
      else if (!existsSync(current)) throw new UserFacingError('恢复中断，原始工作区需要人工恢复；未建立空库以免覆盖资料');
    }
  }
  await removeStaging(root, rollback, 'rollback'); await removeStaging(root, staging, 'staging');
  await rm(join(root, '.restore-journal.json'), { force: true });
}
/** Run before opening SQLite, so a crash during replacement never creates an empty workspace. */
export async function recoverInterruptedRestore(directory: string): Promise<'rolled-back' | 'completed' | null> {
  const root = resolve(directory), path = join(root, '.restore-journal.json');
  if (!existsSync(path)) return null;
  if ((await lstat(path)).size > 4096) throw new UserFacingError('恢复日志过大，请保留数据目录后联系维护人员');
  let journal: RestoreJournal;
  try { journal = JSON.parse(await readFile(path, 'utf8')) as RestoreJournal; }
  catch { throw new UserFacingError('恢复日志损坏，请保留数据目录后联系维护人员'); }
  await recoverJournal(root, journal);
  clearMiaoshouConfig(root);
  clearImageGenerationConnection(root);
  return journal.phase === 'installing' ? 'rolled-back' : 'completed';
}

export type RestoreCheckpoint = 'journal-written' | 'old-files-moved' | 'database-installed' | 'assets-installed' | 'complete-marked';
/** Caller closes every workspace SQLite connection. The optional checkpoint is an internal fault-test seam, never an IPC parameter. */
export async function commitWorkspaceRestore(directory: string, prepared: PreparedRestore, checkpoint?: (point: RestoreCheckpoint) => void | Promise<void>): Promise<void> {
  const root = resolve(directory), staging = stagingPath(root, prepared.stagingDirectory, 'staging');
  if ((await lstat(staging)).isSymbolicLink()) throw new UserFacingError('恢复暂存目录不能是链接');
  checkDatabase(join(staging, 'red.sqlite'));
  for (const name of managedNames) if (existsSync(join(root, name)) && (await lstat(join(root, name))).isSymbolicLink()) throw new UserFacingError('工作区内部文件不能是链接，未更改资料');
  const rollback = join(root, `.restore-rollback-${randomUUID()}`); await mkdir(rollback);
  const journal: RestoreJournal = { version: 1, phase: 'installing', stagingDirectory: staging, rollbackDirectory: rollback, priorNames: managedNames.filter(name => existsSync(join(root, name))) };
  const journalFile = join(root, '.restore-journal.json');
  await writeFileAtomically(journalFile, JSON.stringify(journal));
  try {
    clearMiaoshouConfig(root);
    clearImageGenerationConnection(root);
    if (checkpoint) await checkpoint('journal-written');
    // All services are closed by the caller. Include usage acquired after prepare, immediately before replacement.
    retainSafetyHistory(join(root, 'red.sqlite'), join(staging, 'red.sqlite'));
    checkDatabase(join(staging, 'red.sqlite'));
    for (const name of journal.priorNames) await rename(join(root, name), join(rollback, name));
    if (checkpoint) await checkpoint('old-files-moved');
    await rename(join(staging, 'red.sqlite'), join(root, 'red.sqlite'));
    if (checkpoint) await checkpoint('database-installed');
    await rename(join(staging, 'assets'), join(root, 'assets'));
    if (existsSync(join(staging, 'documents'))) await rename(join(staging, 'documents'), join(root, 'documents'));
    if (checkpoint) await checkpoint('assets-installed');
    checkDatabase(join(root, 'red.sqlite'));
    journal.phase = 'complete'; await writeFileAtomically(journalFile, JSON.stringify(journal));
    if (checkpoint) await checkpoint('complete-marked');
  } catch (error) { await recoverJournal(root, { ...journal, phase: 'installing' }); throw error; }
  await recoverJournal(root, journal);
}
