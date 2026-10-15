import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {migrateModules,assertMigrationJournal,MODULE_SCHEMA_VERSION} from '../src/main/storage/migrations.ts';
import {dataOwner} from '../src/main/storage/owners.ts';
import {assertRecordTable} from '../src/main/storage/record-table.ts';
import {readCategoryOperation} from '../src/main/ai/category-operations.ts';
const setup=()=>{const db=new DatabaseSync(':memory:');db.exec('PRAGMA user_version=21;CREATE TABLE ai_results(id TEXT PRIMARY KEY,record_json TEXT);CREATE TABLE listing_completion_operations(id TEXT PRIMARY KEY,record_json TEXT);CREATE TABLE listing_drafts(id TEXT PRIMARY KEY,record_json TEXT);CREATE TABLE product_workspaces(product_id TEXT,lane TEXT);CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);CREATE TABLE ai_profiles(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)');return db;};
test('schema36 installs exactly one M07 category safety table and read-only queries cannot create a grant',t=>{
 const db=setup();t.after(()=>db.close());migrateModules(db);assert.equal(MODULE_SCHEMA_VERSION,38);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,38);assert.equal(dataOwner('ai_category_operations'),'ai');assertRecordTable(db,'ai_category_operations');assertMigrationJournal(db);
 const before=db.prepare('SELECT total_changes() n').get()!.n,productId=randomUUID();for(let i=0;i<100;i++)assert.equal(readCategoryOperation(db,productId).repairs.length,0);assert.equal(db.prepare('SELECT total_changes() n').get()!.n,before);assert.equal(db.prepare('SELECT count(*) n FROM ai_category_operations').get()!.n,0);
 migrateModules(db);assert.equal(db.prepare('SELECT count(*) n FROM module_migration_journal WHERE version=36').get()!.n,1);
});
test('schema36 journal failure rolls back its DDL, version and safety rows without touching schema35',t=>{
 const db=setup();t.after(()=>db.close());migrateModules(db);
 db.exec("DROP INDEX record_completion_product;DROP INDEX record_ai_results_call;DROP TABLE ai_category_operations;DELETE FROM module_migration_journal WHERE version>=36;PRAGMA user_version=35;CREATE TEMP TRIGGER fail36 BEFORE INSERT ON module_migration_journal WHEN NEW.version=36 BEGIN SELECT RAISE(FAIL,'synthetic schema36 journal failure');END");
 const before=db.prepare('SELECT * FROM ai_spend_policies').all();assert.throws(()=>migrateModules(db),/synthetic schema36 journal failure/);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,35);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='ai_category_operations'").get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM module_migration_journal WHERE version=36').get()!.n,0);assert.deepEqual(db.prepare('SELECT * FROM ai_spend_policies').all(),before);assert.equal(db.isTransaction,false);
});
