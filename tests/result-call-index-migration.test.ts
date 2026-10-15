import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {openDatabase} from '../src/main/database.ts';
import {migrateModules} from '../src/main/storage/migrations.ts';
import {RESULT_CALL_INDEXES} from '../src/main/record-indexes.ts';
import {createWorkspaceBackup,prepareWorkspaceRestore,discardPreparedRestore} from '../src/main/backup.ts';

test('schema37 indexes the exact original call lookup without changing records, and rolls back on journal failure',t=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/result-index-')),db=openDatabase(dir);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const downgrade=()=>db.exec('DROP INDEX record_completion_product;DROP INDEX record_ai_results_call;DELETE FROM module_migration_journal WHERE version>=37;PRAGMA user_version=36');downgrade();
 const raw='{ "callId": "original", "productId": "retained", "unknown": true }';db.prepare('INSERT INTO ai_results VALUES(?,?)').run('result',raw);
 const sql="SELECT record_json FROM ai_results WHERE json_extract(record_json,'$.callId')=?",before=db.prepare(sql).all('original');
 assert.match(String(db.prepare('EXPLAIN QUERY PLAN '+sql).get('original')!.detail),/SCAN/);migrateModules(db);migrateModules(db);
 assert.deepEqual(db.prepare(sql).all('original'),before);assert.equal(db.prepare('SELECT record_json FROM ai_results').get()!.record_json,raw);
 assert.match(String(db.prepare('EXPLAIN QUERY PLAN '+sql).get('original')!.detail),/USING INDEX record_ai_results_call/);
 assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(RESULT_CALL_INDEXES[0].name)!.sql,RESULT_CALL_INDEXES[0].sql);
 downgrade();db.exec("CREATE TEMP TRIGGER fail37 BEFORE INSERT ON module_migration_journal WHEN NEW.version=37 BEGIN SELECT RAISE(FAIL,'fail37');END");
 assert.throws(()=>migrateModules(db),/fail37/);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,36);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='record_ai_results_call'").get()!.n,0);assert.deepEqual(db.prepare(sql).all('original'),before);
});

test('backup accepts original schema36 and exact schema37 index, rejecting a replaced index',async t=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const root=mkdtempSync(resolve('.test-data/result-index-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dir=join(root,'data');let db=openDatabase(dir);db.exec('DROP INDEX record_completion_product;DROP INDEX record_ai_results_call;DELETE FROM module_migration_journal WHERE version>=37;PRAGMA user_version=36');db.close();
 for(const version of [36,37]){if(version===37){db=openDatabase(dir);db.exec('DROP INDEX record_completion_product;DELETE FROM module_migration_journal WHERE version=38;PRAGMA user_version=37');db.close();}const file=join(root,`schema${version}.htcbackup`);await createWorkspaceBackup(dir,file,'synthetic passphrase');const prepared=await prepareWorkspaceRestore(join(root,'target'+version),file,'synthetic passphrase');await discardPreparedRestore(join(root,'target'+version),prepared);}
 db=openDatabase(dir);db.exec("DROP INDEX record_ai_results_call;CREATE INDEX record_ai_results_call ON ai_results(json_extract(record_json,'$.productId'))");db.close();
 await assert.rejects(createWorkspaceBackup(dir,join(root,'wrong.htcbackup'),'synthetic passphrase'),/索引/);
});
