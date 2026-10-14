import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

test('registered migrations are atomic, sequential and preserve old record bytes',async t=>{
  const path='../src/main/storage/migrations.ts';
  assert.ok(existsSync(new URL(path,import.meta.url)),'registered migration runner must exist');
  const {migrateModules,assertMigrationJournal}=await import(path);
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('PRAGMA user_version=21; CREATE TABLE product_workspaces(product_id TEXT,lane TEXT); CREATE TABLE old_receipts(id TEXT PRIMARY KEY,raw TEXT); CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY,record_json TEXT NOT NULL); CREATE TABLE ai_profiles(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);');
  db.prepare('INSERT INTO old_receipts VALUES(?,?)').run('unknown','{ "response": null, "attempt": 3 }');
  const before=db.prepare('SELECT raw FROM old_receipts').get()!.raw;
  migrateModules(db);migrateModules(db);assertMigrationJournal(db);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,32);
  assert.equal(db.prepare('SELECT count(*) n FROM module_migration_journal').get()!.n,11);
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
