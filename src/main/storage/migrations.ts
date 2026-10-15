import {initializeImageReviewLedger} from '../image-workflow/review-ledger.ts';
import { assertUnambiguousRecordJson } from '../record-json.ts';
import { SALES_IDENTITY_INDEXES, RESULT_CALL_INDEXES, COMPLETION_PRODUCT_INDEXES, WORKFLOW_SCOPE_INDEXES } from '../record-indexes.ts';
import { initializeWorkBatches } from '../automatic-listing/work-batches.ts';
import { initializeImageRetryAllowances } from '../image-workflow/retry-allowance.ts';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../application/transaction.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { SOURCE_TABLES } from '../miaoshou/source-snapshots.ts';
import { initializeSchemaOperations } from '../catalog/schema-operations.ts';
import { initializePurposeProfiles } from '../ai/purpose-routing.ts';
import { initializeSpendBudget } from '../ai/spend-budget.ts';
import { initializeControlledRunScopes } from '../application/controlled-run-scope.ts';
import {initializeCategoryOperations} from '../ai/category-operations.ts';

export const MODULE_SCHEMA_VERSION=39;
export const MIGRATION_TABLES={module_migration_journal:['version','name','applied_at']};
const migrations=[{version:22,name:'module-foundation',apply(db:DatabaseSync){
  db.exec('CREATE TABLE module_migration_journal(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
}},{version:23,name:'source-versions-and-adoption',apply(db:DatabaseSync){
  for(const table of Object.keys(SOURCE_TABLES))db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)`);
}},{version:24,name:'catalog-schema-operations',apply:initializeSchemaOperations},{version:25,name:'ai-purpose-routing-and-receipts',apply(db:DatabaseSync){initializePurposeProfiles(db);db.exec('CREATE TABLE ai_provider_receipts(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); CREATE TABLE ai_image_requests(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');}},{version:26,name:'openrouter-batch-identities',apply(db:DatabaseSync){db.exec('CREATE TABLE ai_batches(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); CREATE TABLE ai_batch_items(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');}},{version:27,name:'listing-purpose-groups',apply(db:DatabaseSync){db.exec('CREATE TABLE ai_field_groups(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');}},{version:28,name:'image-reference-pins',apply(db:DatabaseSync){db.exec('CREATE TABLE image_reference_pins(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');}},{version:29,name:'copy-review-upgrades',apply(db:DatabaseSync){db.exec('CREATE TABLE ai_copy_review_upgrades(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');}},{version:30,name:'product-fact-scope-models',apply(db:DatabaseSync){db.exec('CREATE TABLE product_fact_models(id TEXT PRIMARY KEY NOT NULL REFERENCES products(id) ON DELETE CASCADE,record_json TEXT NOT NULL)');}},{version:31,name:'image-retry-allowances',apply:initializeImageRetryAllowances},{version:32,name:'automatic-work-batches',apply:initializeWorkBatches},{version:33,name:'sales-identity-lookup',apply(db:DatabaseSync){assertUnambiguousRecordJson(db,'listing_drafts');for(const index of SALES_IDENTITY_INDEXES)db.exec(index.sql);}},{version:34,name:'money-reservations-and-controlled-run',apply(db:DatabaseSync){initializeSpendBudget(db);initializeControlledRunScopes(db);}},{version:35,name:'image-review-journal',apply:initializeImageReviewLedger},{version:36,name:'category-continuation-permits',apply:initializeCategoryOperations},{version:37,name:'ai-result-call-lookup',apply(db:DatabaseSync){assertUnambiguousRecordJson(db,'ai_results');for(const index of RESULT_CALL_INDEXES)db.exec(index.sql);}},{version:38,name:'completion-product-lookup',apply(db:DatabaseSync){assertUnambiguousRecordJson(db,'listing_completion_operations');for(const index of COMPLETION_PRODUCT_INDEXES)db.exec(index.sql);}},{version:39,name:'workflow-scope-lookup',apply(db:DatabaseSync){assertUnambiguousRecordJson(db,'image_workflow_runs');for(const index of WORKFLOW_SCOPE_INDEXES)db.exec(index.sql);}}];
export function assertMigrationJournal(db:DatabaseSync):void {
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if(version<22)return;
  const rows=db.prepare('SELECT version,name,applied_at FROM module_migration_journal ORDER BY version').all();
  const expected=migrations.filter(m=>m.version<=version);
  if(rows.length!==expected.length||rows.some((r,i)=>r.version!==expected[i].version||r.name!==expected[i].name||!Number.isFinite(Date.parse(String(r.applied_at)))))
    throw new UserFacingError('模块迁移历史不完整或已变化');
}
/** Called only from explicit database initialization, never from ordinary queries. */
export function migrateModules(db:DatabaseSync):void {
  let version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if(version<21||version>MODULE_SCHEMA_VERSION)throw new UserFacingError('模块迁移起始版本不受支持');
  for(const migration of migrations)if(migration.version>version){
    if(migration.version!==version+1)throw new UserFacingError('模块迁移版本不连续');
    transaction(db,()=>{
      migration.apply(db);
      db.prepare('INSERT INTO module_migration_journal(version,name,applied_at) VALUES(?,?,?)').run(migration.version,migration.name,new Date().toISOString());
      db.exec(`PRAGMA user_version=${migration.version}`);
    });
    version=migration.version;
  }
  assertMigrationJournal(db);
}
