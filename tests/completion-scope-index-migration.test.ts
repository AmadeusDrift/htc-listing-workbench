import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { openDatabase } from '../src/main/database.ts';
import { migrateModules } from '../src/main/storage/migrations.ts';
import { createWorkspaceBackup,prepareWorkspaceRestore,discardPreparedRestore } from '../src/main/backup.ts';

test('schema40 indexes the unchanged draft and cross-draft safety queries, preserves bytes, and rolls back atomically',t=>{
  mkdirSync(resolve('.test-data'),{recursive:true});const root=mkdtempSync(resolve('.test-data/completion-scope-index-')),db=openDatabase(root);t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const downgrade=()=>db.exec('DROP INDEX IF EXISTS record_completion_draft;DROP INDEX IF EXISTS record_completion_safety;DELETE FROM module_migration_journal WHERE version>=40;PRAGMA user_version=39');downgrade();
  const rows=[['one','d1','scope','ACTIVE'],['two','d1','scope','DONE'],['three','d2','scope','GUARD'],['four','d3','other','ACTIVE'],['five','d4','scope','RETIRED']];
  for(const [id,draftId,safetyScopeHash,state] of rows)db.prepare('INSERT INTO listing_completion_operations VALUES(?,?)').run(id,JSON.stringify({draftId,safetyScopeHash,state,unknown:true,attempts:3,cost:0.12}));
  const all=db.prepare('SELECT * FROM listing_completion_operations ORDER BY rowid').all();
  const sqls=["SELECT id,record_json FROM listing_completion_operations WHERE json_extract(record_json,'$.draftId')=? ORDER BY rowid","SELECT 1 FROM listing_completion_operations WHERE json_extract(record_json,'$.safetyScopeHash')=? AND json_extract(record_json,'$.draftId')!=? AND json_extract(record_json,'$.state') NOT IN ('DONE','RETIRED')"],args=[['d1'],['scope','d1']],names=['record_completion_draft','record_completion_safety'];
  const before=sqls.map((sql,index)=>db.prepare(sql).all(...args[index]));assert.equal(before[0].length,2);assert.equal(before[1].length,1);
  for(let index=0;index<2;index++)assert.match(String(db.prepare('EXPLAIN QUERY PLAN '+sqls[index]).get(...args[index])!.detail),/SCAN/);
  migrateModules(db);migrateModules(db);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,40);
  for(let index=0;index<2;index++){assert.deepEqual(db.prepare(sqls[index]).all(...args[index]),before[index]);assert.match(String(db.prepare('EXPLAIN QUERY PLAN '+sqls[index]).get(...args[index])!.detail),new RegExp('USING INDEX '+names[index]));}
  assert.equal(db.prepare(sqls[1]).all('missing','d1').length,0);assert.deepEqual(db.prepare('SELECT * FROM listing_completion_operations ORDER BY rowid').all(),all);
  downgrade();db.exec("CREATE TEMP TRIGGER fail40 BEFORE INSERT ON module_migration_journal WHEN NEW.version=40 BEGIN SELECT RAISE(FAIL,'fail40');END");assert.throws(()=>migrateModules(db),/fail40/);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,39);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('record_completion_draft','record_completion_safety')").get()!.n,0);assert.deepEqual(db.prepare('SELECT * FROM listing_completion_operations ORDER BY rowid').all(),all);
});

test('schema40 backup accepts exact new indexes and refuses a replaced expression',async t=>{
  mkdirSync(resolve('.test-data'),{recursive:true});const root=mkdtempSync(resolve('.test-data/completion-scope-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const directory=join(root,'data');let db=openDatabase(directory);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,40);db.close();
  const file=join(root,'schema40.htcbackup');await createWorkspaceBackup(directory,file,'synthetic passphrase');const prepared=await prepareWorkspaceRestore(join(root,'target'),file,'synthetic passphrase');await discardPreparedRestore(join(root,'target'),prepared);
  db=openDatabase(directory);db.exec("DROP INDEX record_completion_safety;CREATE INDEX record_completion_safety ON listing_completion_operations(json_extract(record_json,'$.scopeHash'))");db.close();
  await assert.rejects(createWorkspaceBackup(directory,join(root,'wrong.htcbackup'),'synthetic passphrase'),/索引/);
});
