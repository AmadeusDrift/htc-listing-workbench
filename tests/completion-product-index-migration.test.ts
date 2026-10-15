import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {openDatabase} from '../src/main/database.ts';
import {migrateModules} from '../src/main/storage/migrations.ts';
import {createWorkspaceBackup,prepareWorkspaceRestore,discardPreparedRestore} from '../src/main/backup.ts';

test('schema38 preserves all nine sale predicates and records, and rolls back on journal failure',t=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/completion-index-')),db=openDatabase(dir);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const downgrade=()=>db.exec('DROP INDEX record_completion_product;DELETE FROM module_migration_journal WHERE version=38;PRAGMA user_version=37');downgrade();
 const identity={mode:'demo',productId:'p',productRevision:1,variantId:'v',sku:'sku',sellerId:'s',marketplaceId:'m',listingProgram:'standard',recipeHash:'hash'};
 const fields=Object.keys(identity),args=Object.values(identity),sql='SELECT id,record_json FROM listing_completion_operations WHERE '+fields.map(name=>`json_extract(record_json,'$.safetyIdentity.${name}')=?`).join(' AND ');
 const insert=db.prepare('INSERT INTO listing_completion_operations VALUES(?,?)');for(let i=0;i<fields.length;i++)insert.run('different'+i,JSON.stringify({safetyIdentity:{...identity,[fields[i]]:'different'}}));insert.run('original',JSON.stringify({safetyIdentity:identity,unknown:true,attempts:3}));
 const original=db.prepare('SELECT * FROM listing_completion_operations ORDER BY id').all(),before=db.prepare(sql).all(...args);assert.equal(before.length,1);
 assert.match(String(db.prepare('EXPLAIN QUERY PLAN '+sql).get(...args)!.detail),/SCAN/);migrateModules(db);migrateModules(db);
 assert.deepEqual(db.prepare(sql).all(...args),before);assert.deepEqual(db.prepare('SELECT * FROM listing_completion_operations ORDER BY id').all(),original);assert.match(String(db.prepare('EXPLAIN QUERY PLAN '+sql).get(...args)!.detail),/USING INDEX record_completion_product/);
 downgrade();db.exec("CREATE TEMP TRIGGER fail38 BEFORE INSERT ON module_migration_journal WHEN NEW.version=38 BEGIN SELECT RAISE(FAIL,'fail38');END");assert.throws(()=>migrateModules(db),/fail38/);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,37);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='record_completion_product'").get()!.n,0);assert.deepEqual(db.prepare('SELECT * FROM listing_completion_operations ORDER BY id').all(),original);
});

test('backup accepts exact schema38 product index and rejects its replacement',async t=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const root=mkdtempSync(resolve('.test-data/completion-index-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const dir=join(root,'data');let db=openDatabase(dir);db.close();
 const file=join(root,'schema38.htcbackup');await createWorkspaceBackup(dir,file,'synthetic passphrase');const prepared=await prepareWorkspaceRestore(join(root,'target'),file,'synthetic passphrase');await discardPreparedRestore(join(root,'target'),prepared);
 db=openDatabase(dir);db.exec("DROP INDEX record_completion_product;CREATE INDEX record_completion_product ON listing_completion_operations(json_extract(record_json,'$.safetyIdentity.sku'))");db.close();await assert.rejects(createWorkspaceBackup(dir,join(root,'wrong.htcbackup'),'synthetic passphrase'),/索引/);
});
