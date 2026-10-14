import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

test('registered migrations are atomic, sequential and preserve old record bytes',async t=>{
  const path='../src/main/storage/migrations.ts';
  assert.ok(existsSync(new URL(path,import.meta.url)),'registered migration runner must exist');
  const {migrateModules,assertMigrationJournal}=await import(path);
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('PRAGMA user_version=21; CREATE TABLE listing_drafts(id TEXT PRIMARY KEY,record_json TEXT); CREATE TABLE product_workspaces(product_id TEXT,lane TEXT); CREATE TABLE old_receipts(id TEXT PRIMARY KEY,raw TEXT); CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY,record_json TEXT NOT NULL); CREATE TABLE ai_profiles(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);');
  db.prepare('INSERT INTO old_receipts VALUES(?,?)').run('unknown','{ "response": null, "attempt": 3 }');
  const before=db.prepare('SELECT raw FROM old_receipts').get()!.raw;
  migrateModules(db);migrateModules(db);assertMigrationJournal(db);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,33);
  assert.equal(db.prepare('SELECT count(*) n FROM module_migration_journal').get()!.n,12);
  assert.equal(db.prepare('SELECT raw FROM old_receipts').get()!.raw,before);
  db.prepare('UPDATE module_migration_journal SET name=?').run('tampered');
  assert.throws(()=>assertMigrationJournal(db),/迁移/);
});

test('migration failure leaves the original version and records intact',async t=>{
  const path='../src/main/storage/migrations.ts';const {migrateModules}=await import(path);
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("PRAGMA user_version=21; CREATE TABLE module_migration_journal(old TEXT); INSERT INTO module_migration_journal VALUES('keep');");
  assert.throws(()=>migrateModules(db),/already exists/);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,21);
  assert.equal(db.prepare('SELECT old FROM module_migration_journal').get()!.old,'keep');
  assert.equal(db.isTransaction,false);
});

test('schema32 to 33 adds lookup indexes without changing UNKNOWN draft bytes and rolls back ambiguous history',async t=>{
 const {migrateModules}=await import('../src/main/storage/migrations.ts');
 const {SALES_IDENTITY_INDEXES}=await import('../src/main/record-indexes.ts');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('PRAGMA user_version=21; CREATE TABLE listing_drafts(id TEXT PRIMARY KEY,record_json TEXT); CREATE TABLE product_workspaces(product_id TEXT,lane TEXT); CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY,record_json TEXT NOT NULL); CREATE TABLE ai_profiles(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)');
 migrateModules(db);
 const downgrade=()=>db.exec('DROP INDEX record_drafts_sku; DROP INDEX record_drafts_recipe; DELETE FROM module_migration_journal WHERE version=33; PRAGMA user_version=32');downgrade();
 const raw='{ "draft": {"sku":"KEEP", "state":"UNKNOWN", "salesPlan":{"recipe":{"key":"keep"}}}, "unresolvedWrite": true, "paid": 3 }';
 db.prepare('INSERT INTO listing_drafts VALUES(?,?)').run('unknown',raw);migrateModules(db);
 assert.equal(db.prepare('SELECT record_json FROM listing_drafts').get()!.record_json,raw);
 for(const index of SALES_IDENTITY_INDEXES)assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(index.name)!.sql,index.sql);
 downgrade();db.prepare('UPDATE listing_drafts SET record_json=?').run('{"draft":{"sku":"A","sku":"B"}}');
 assert.throws(()=>migrateModules(db),/重复 JSON/);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,32);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='record_drafts_sku'").get()!.n,0);
});
