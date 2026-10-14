import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm,readFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { writeStreamingBackup,hashBackupFile } from '../src/main/backup-stream.ts';
import { createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore,discardPreparedRestore } from '../src/main/backup.ts';
import { archiveWorkBatch,currentWorkBatch,listWorkBatches } from '../src/main/automatic-listing/work-batches.ts';
import { createInertBatchTask } from './fixtures/work-batches.ts';
const passphrase='synthetic batch backup passphrase';
async function fixture(t:test.TestContext){await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/work-batch-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,'workspace'),store=new WorkspaceStore(directory),product=store.createProduct();store.moveWorkspaceProducts({productIds:[product.id],destination:'automatic'});store.close();return {root,directory,product,file:join(root,'snapshot.htcbackup')};}
for(const version of [30,31,32])test(`schema${version} backup restore keeps later empty batch identity and restart numbering`,async t=>{
 const f=await fixture(t);
 if(version<32){const db=new DatabaseSync(join(f.directory,'red.sqlite'));db.exec(`DROP TABLE automatic_work_batches; DELETE FROM module_migration_journal WHERE version=32; PRAGMA user_version=${version}`);if(version===30)db.exec('DROP TABLE image_retry_allowances; DELETE FROM module_migration_journal WHERE version=31');db.close();}
 if(version<32)await writeStreamingBackup(f.file,passphrase,{format:'htc-workspace-backup',version:2,source:{application:'HTC',kind:'local-workspace',databaseVersion:version},createdAt:new Date().toISOString(),retention:{amazonDays:180,logDays:365,dataOldestAt:null,expiresAt:null},files:[{path:'red.sqlite',...await hashBackupFile(join(f.directory,'red.sqlite')),role:'workspace-database'}]},()=>join(f.directory,'red.sqlite'),async()=>{});else await createWorkspaceBackup(f.directory,f.file,passphrase);
 const db=openDatabase(f.directory),old=currentWorkBatch(db),next=archiveWorkBatch(db,old.id);const before=listWorkBatches(db);db.close();
 const prepared=await prepareWorkspaceRestore(f.directory,f.file,passphrase);await commitWorkspaceRestore(f.directory,prepared);
 const restored=openDatabase(f.directory);assert.deepEqual(listWorkBatches(restored),before);assert.equal(currentWorkBatch(restored).id,next.id);assert.deepEqual(currentWorkBatch(restored).productIds,[]);assert.equal(archiveWorkBatch(restored,next.id).sequence,next.sequence+1);restored.close();
 const store=new WorkspaceStore(f.directory);assert.equal(store.getProduct(f.product.id).variants[0].sku,f.product.variants[0].sku);store.close();
});
test('missing post-backup original task rejects staged restore without changing live bytes or identity',async t=>{
 const f=await fixture(t);await createWorkspaceBackup(f.directory,f.file,passphrase);const task=await createInertBatchTask(f.directory,f.product.id);
 const before=await readFile(join(f.directory,'red.sqlite'));
 await assert.rejects(()=>prepareWorkspaceRestore(f.directory,f.file,passphrase),/备份缺少后续批次原任务身份/);
 assert.deepEqual(await readFile(join(f.directory,'red.sqlite')),before);
 const db=openDatabase(f.directory);assert.ok(currentWorkBatch(db).taskIds.includes(task.id));assert.equal(JSON.parse(String(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id)!.record_json)).status,'CREATED');db.close();
});
test('schema32 foreign same-day batch conflict rejects and leaves live data intact',async t=>{
 const f=await fixture(t),other=join(f.root,'other');const store=new WorkspaceStore(other);store.close();await createWorkspaceBackup(other,f.file,passphrase);const before=await readFile(join(f.directory,'red.sqlite'));await assert.rejects(()=>prepareWorkspaceRestore(f.directory,f.file,passphrase),/序号重复/);assert.deepEqual(await readFile(join(f.directory,'red.sqlite')),before);
});
test('current and archived original task references survive complete backup and remain paused',async t=>{
 const f=await fixture(t),task=await createInertBatchTask(f.directory,f.product.id);const db=openDatabase(f.directory),old=currentWorkBatch(db);archiveWorkBatch(db,old.id);db.close();await createWorkspaceBackup(f.directory,f.file,passphrase);
 const prepared=await prepareWorkspaceRestore(f.directory,f.file,passphrase);const stage=openDatabase(prepared.stagingDirectory);assert.ok(listWorkBatches(stage).find(b=>b.id===old.id)!.taskIds.includes(task.id));assert.equal(JSON.parse(String(stage.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id)!.record_json)).status,'PAUSED');stage.close();await discardPreparedRestore(f.directory,prepared);
});
import { Worker } from 'node:worker_threads';
test('two independent connections cannot archive the same current twice or duplicate daily sequence',async t=>{
 const f=await fixture(t),db=openDatabase(f.directory),initial=currentWorkBatch(db);db.close();
 const run=()=>new Promise<{ok:boolean;error?:string}>((resolve,reject)=>{const w=new Worker(new URL('./fixtures/work-batch-archive-worker.mjs',import.meta.url),{workerData:{path:join(f.directory,'red.sqlite'),id:initial.id}});w.once('message',resolve);w.once('error',reject);});
 const results=await Promise.all([run(),run()]);assert.equal(results.filter(r=>r.ok).length,1);assert.match(results.find(r=>!r.ok)!.error!,/当前批次/);
 const reopened=openDatabase(f.directory);const rows=listWorkBatches(reopened);assert.equal(rows.length,2);assert.equal(currentWorkBatch(reopened).sequence,initial.sequence+1);assert.deepEqual(currentWorkBatch(reopened).productIds,[]);reopened.close();
});
import { randomUUID } from 'node:crypto';
test('same task missing a later SKU row fails restore and leaves live database bytes intact',async t=>{
 const f=await fixture(t),task=await createInertBatchTask(f.directory,f.product.id);await createWorkspaceBackup(f.directory,f.file,passphrase);
 const later={...task.items[0],variantId:randomUUID(),sku:'KEEP-LATER-SKU'};later.key=later.productId+':'+later.variantId;task.items.push(later);const db=openDatabase(f.directory);db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),task.id);db.close();
 const before=await readFile(join(f.directory,'red.sqlite'));await assert.rejects(()=>prepareWorkspaceRestore(f.directory,f.file,passphrase),/后续.*SKU/);assert.deepEqual(await readFile(join(f.directory,'red.sqlite')),before);
});
