import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {openDatabase} from '../src/main/database.ts';
import {migrateModules} from '../src/main/storage/migrations.ts';
import {createWorkspaceBackup,prepareWorkspaceRestore,discardPreparedRestore} from '../src/main/backup.ts';

test('schema39 preserves workflow scope rows and rowid order and rolls back both indexes atomically',t=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/workflow-index-')),db=openDatabase(dir);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const downgrade=()=>db.exec('DROP INDEX record_workflow_product;DROP INDEX record_workflow_draft;DELETE FROM module_migration_journal WHERE version=39;PRAGMA user_version=38');downgrade();
 const insert=db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)');insert.run('old',JSON.stringify({productId:'p',draftId:'d',status:'UNKNOWN',attempts:3}));insert.run('other',JSON.stringify({productId:'other',draftId:'other'}));insert.run('new',JSON.stringify({productId:'p',draftId:'d',status:'COMPLETE'}));
 const original=db.prepare('SELECT * FROM image_workflow_runs ORDER BY rowid').all(),sqls=["SELECT record_json FROM image_workflow_runs WHERE json_extract(record_json,'$.productId')=? ORDER BY rowid DESC","SELECT id,record_json FROM image_workflow_runs WHERE json_extract(record_json,'$.draftId')=? ORDER BY rowid DESC"],ids=['p','d'];
 const before=sqls.map((sql,i)=>db.prepare(sql).all(ids[i]));for(let i=0;i<2;i++){assert.equal(before[i].length,2);assert.match(String(db.prepare('EXPLAIN QUERY PLAN '+sqls[i]).get(ids[i])!.detail),/SCAN/);}migrateModules(db);migrateModules(db);
 for(let i=0;i<2;i++){assert.deepEqual(db.prepare(sqls[i]).all(ids[i]),before[i]);assert.match(String(db.prepare('EXPLAIN QUERY PLAN '+sqls[i]).get(ids[i])!.detail),/USING INDEX record_workflow_/);}assert.deepEqual(db.prepare('SELECT * FROM image_workflow_runs ORDER BY rowid').all(),original);
 downgrade();db.exec("CREATE TEMP TRIGGER fail39 BEFORE INSERT ON module_migration_journal WHEN NEW.version=39 BEGIN SELECT RAISE(FAIL,'fail39');END");assert.throws(()=>migrateModules(db),/fail39/);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,38);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('record_workflow_product','record_workflow_draft')").get()!.n,0);assert.deepEqual(db.prepare('SELECT * FROM image_workflow_runs ORDER BY rowid').all(),original);
});

test('backup accepts exact schema39 workflow indexes and rejects a replaced expression',async t=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const root=mkdtempSync(resolve('.test-data/workflow-index-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const dir=join(root,'data');let db=openDatabase(dir);db.close();
 const file=join(root,'schema39.htcbackup');await createWorkspaceBackup(dir,file,'synthetic passphrase');const prepared=await prepareWorkspaceRestore(join(root,'target'),file,'synthetic passphrase');await discardPreparedRestore(join(root,'target'),prepared);
 db=openDatabase(dir);db.exec("DROP INDEX record_workflow_draft;CREATE INDEX record_workflow_draft ON image_workflow_runs(json_extract(record_json,'$.productId'))");db.close();await assert.rejects(createWorkspaceBackup(dir,join(root,'wrong.htcbackup'),'synthetic passphrase'),/索引/);
});
