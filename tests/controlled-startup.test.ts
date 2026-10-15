import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';

const module=await import('../src/main/application/controlled-startup.ts').catch(()=>null);
function fixture(){mkdirSync(resolve('.test-data'),{recursive:true});const directory=mkdtempSync(resolve('.test-data/s08-cold-')),file=join(directory,'red.sqlite'),db=new DatabaseSync(file);for(const table of ['automatic_listing_tasks','execution_tasks','ai_calls','ai_usage_ledger','hosting_uploads','item_labels','ai_spend_reservations','ai_batches','image_workflow_runs'])db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)`);db.exec('CREATE TABLE amazon_write_locks(listing_hash TEXT PRIMARY KEY,state TEXT NOT NULL)');return {directory,file,db,put(table:string,record:any){if(table==='amazon_write_locks')db.prepare('INSERT INTO amazon_write_locks VALUES(?,?)').run(randomUUID(),record.state);else db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(record.id??randomUUID(),JSON.stringify(record));},hash(){return createHash('sha256').update(readFileSync(file)).digest('hex');}};}
test('cold controlled startup leaves historical waiting, unknown and bare PENDING records byte-identical',()=>{
 assert.ok(module?.preflightControlledAcceptance);const f=fixture();f.put('automatic_listing_tasks',{status:'WAITING'});f.put('automatic_listing_tasks',{status:'NEEDS_ATTENTION'});f.put('ai_usage_ledger',{id:randomUUID(),state:'PENDING'});f.put('ai_spend_reservations',{state:'UNKNOWN'});f.put('hosting_uploads',{status:'PENDING'});f.put('ai_batches',{state:'submission_unknown',remoteBatchId:null,remoteStatus:null});f.db.close();const before=f.hash();module.preflightControlledAcceptance(f.directory);assert.equal(f.hash(),before);
});
for(const [table,record] of [
 ['automatic_listing_tasks',{status:'RUNNING'}],['execution_tasks',{status:'QUEUED'}],['ai_calls',{status:'RUNNING'}],['hosting_uploads',{status:'UPLOADING'}],['item_labels',{status:'REQUESTING'}],['item_labels',{status:'FAILED',requestPending:true}],['ai_spend_reservations',{state:'DISPATCH_ATTEMPTED'}],['ai_batches',{state:'submitting'}],['ai_batches',{state:'waiting',remoteBatchId:'batch_original',remoteStatus:'in_progress'}],['image_workflow_runs',{status:'RUNNING'}],['amazon_write_locks',{state:'SUBMITTING'}],
] as const)test(`cold controlled startup refuses active ${table} ${JSON.stringify(record)} before changing any database byte`,()=>{
 assert.ok(module?.preflightControlledAcceptance);const f=fixture();f.put(table,record);f.db.close();const before=f.hash();assert.throws(()=>module.preflightControlledAcceptance(f.directory),/在途/);assert.equal(f.hash(),before);
});
test('interrupted restore is refused before recovery and a fresh empty workspace needs no database creation',()=>{
 assert.ok(module?.preflightControlledAcceptance);const f=fixture();f.db.close();writeFileSync(join(f.directory,'.restore-journal.json'),'synthetic unresolved restore');const before=f.hash();assert.throws(()=>module.preflightControlledAcceptance(f.directory),/恢复/);assert.equal(f.hash(),before);assert.equal(readFileSync(join(f.directory,'.restore-journal.json'),'utf8'),'synthetic unresolved restore');const blank=mkdtempSync(resolve('.test-data/s08-cold-empty-'));module.preflightControlledAcceptance(blank);
});
