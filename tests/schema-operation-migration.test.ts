import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve,join,dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AutomaticSchemaRetry } from '../src/shared/automatic-listing-contracts.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore } from '../src/main/backup.ts';

const taskId=randomUUID(),rowKey=randomUUID()+':'+randomUUID();
const retry:AutomaticSchemaRetry={version:1,scope:'a'.repeat(64),selection:{targetId:randomUUID(),productType:'COASTER',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'},originalStage:'DRAFT',firstFailureAt:'2026-10-13T00:00:00.000Z',dueAt:'2026-10-13T00:03:00.000Z',deadlineAt:'2026-10-13T00:10:00.000Z',usedDelayedRounds:2,state:'WAITING',reason:'SCHEMA_TRANSIENT'};
async function fixture(t:test.TestContext){
  const path='../src/main/catalog/schema-operations.ts';assert.ok(existsSync(new URL(path,import.meta.url)),'Schema owner must exist');
  const api=await import(path),db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);');
  const raw=JSON.stringify({id:taskId,items:[{key:rowKey,schemaRetry:retry}]});
  db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(taskId,raw);
  return{api,db,raw};
}
test('A14 old task scope migrates once with unchanged deadline, attempts and raw task bytes',async t=>{
  const {api,db,raw}=await fixture(t);api.initializeSchemaOperations(db);api.initializeSchemaOperations(db);
  const operation=api.readSchemaOperation(db,taskId,rowKey,retry.scope);
  assert.deepEqual(operation.budget,retry);assert.deepEqual(operation.initialBudget,retry);
  assert.equal(db.prepare('SELECT count(*) n FROM schema_fetch_operations').get()!.n,1);
  assert.equal(db.prepare('SELECT record_json FROM automatic_listing_tasks').get()!.record_json,raw);
});
test('A14 stale snapshots and old backups cannot refund rounds or extend the initial deadline',async t=>{
  const {api,db}=await fixture(t);api.initializeSchemaOperations(db);
  api.saveSchemaOperation(db,taskId,rowKey,{...retry,usedDelayedRounds:3,state:'EXHAUSTED'});
  const stale=api.saveSchemaOperation(db,taskId,rowKey,{...retry,usedDelayedRounds:0});
  assert.equal(stale.usedDelayedRounds,3);assert.equal(stale.state,'EXHAUSTED');
  assert.throws(()=>api.saveSchemaOperation(db,taskId,rowKey,{...retry,firstFailureAt:'2026-10-13T01:00:00.000Z',dueAt:'2026-10-13T01:03:00.000Z',deadlineAt:'2026-10-13T01:10:00.000Z'}),/范围|历史/);
});

test('M05 authorizes due GET rounds and never grants a fourth delayed attempt',async t=>{
  const {api}=await fixture(t);assert.equal(typeof api.planSchemaAttempt,'function');
  assert.equal(api.planSchemaAttempt(retry,Date.parse(retry.dueAt)-1).kind,'waiting');
  const third=api.planSchemaAttempt(retry,Date.parse(retry.dueAt));assert.equal(third.kind,'ready');assert.equal(third.budget.usedDelayedRounds,3);
  const fourth=api.planSchemaAttempt({...third.budget,state:'WAITING'},Date.parse(third.budget.dueAt));
  assert.equal(fourth.kind,'exhausted');assert.equal(fourth.budget.usedDelayedRounds,3);
});

test('restoring an older backup retains a later operation and its original budget without recreating tasks',async t=>{
  const {api,db}=await fixture(t);api.initializeSchemaOperations(db);
  api.saveSchemaOperation(db,taskId,rowKey,{...retry,usedDelayedRounds:3,state:'SUCCEEDED'});
  const snapshot=new DatabaseSync(':memory:');t.after(()=>snapshot.close());
  snapshot.exec('CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)');api.initializeSchemaOperations(snapshot);
  api.restoreSchemaOperations(db,snapshot);api.restoreSchemaOperations(db,snapshot);
  const restored=api.readSchemaOperation(snapshot,taskId,rowKey,retry.scope);
  assert.deepEqual(restored.initialBudget,retry);assert.equal(restored.budget.usedDelayedRounds,3);assert.equal(restored.budget.state,'WAITING');
  assert.equal(snapshot.prepare('SELECT count(*) n FROM automatic_listing_tasks').get()!.n,0);
});

test('two stale schedulers cannot reserve the same due Schema round twice',async t=>{
  const {api,db}=await fixture(t);api.initializeSchemaOperations(db);
  assert.equal(typeof api.reserveSchemaAttempt,'function');
  const a=api.reserveSchemaAttempt(db,taskId,rowKey,retry,Date.parse(retry.dueAt));
  const b=api.reserveSchemaAttempt(db,taskId,rowKey,retry,Date.parse(retry.dueAt));
  assert.equal(a.kind,'ready');assert.notEqual(b.kind,'ready');
  assert.equal(api.readSchemaOperation(db,taskId,rowKey,retry.scope).budget.usedDelayedRounds,3);
  assert.equal(api.readSchemaOperation(db,taskId,rowKey,retry.scope).budget.state,'IN_FLIGHT');
});

test('restore of a newer in-flight snapshot retains its higher rounds but revokes execution state',async t=>{
  const {api,db}=await fixture(t);api.initializeSchemaOperations(db);
  const snapshot=new DatabaseSync(':memory:');t.after(()=>snapshot.close());
  snapshot.exec('CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)');api.initializeSchemaOperations(snapshot);
  api.saveSchemaOperation(snapshot,taskId,rowKey,{...retry,usedDelayedRounds:3,state:'IN_FLIGHT'});
  api.restoreSchemaOperations(db,snapshot);
  const restored=api.readSchemaOperation(snapshot,taskId,rowKey,retry.scope);
  assert.equal(restored.budget.usedDelayedRounds,3);assert.equal(restored.budget.state,'WAITING');
});

test('snapshot-only in-flight operation is paused even when current DB has no operation table',async t=>{
  const {api,db}=await fixture(t),snapshot=new DatabaseSync(':memory:');t.after(()=>snapshot.close());
  snapshot.exec('CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)');api.initializeSchemaOperations(snapshot);
  api.saveSchemaOperation(snapshot,taskId,rowKey,{...retry,state:'IN_FLIGHT'});
  api.restoreSchemaOperations(db,snapshot);
  const after=api.readSchemaOperation(snapshot,taskId,rowKey,retry.scope);
  assert.equal(after.budget.state,'WAITING');assert.equal(after.budget.usedDelayedRounds,2);
});

test('fresh-directory encrypted restore retains Schema liability and revokes in-flight state',async t=>{
  const path='../src/main/catalog/schema-operations.ts',api=await import(path);
  const parent=resolve('.test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'schema-restore-'));
  t.after(()=>{assert.equal(dirname(root),parent);rmSync(root,{recursive:true,force:true});});
  const source=join(root,'source'),target=join(root,'fresh-target'),file=join(root,'schema.htcbackup');
  const db=openDatabase(source);api.saveSchemaOperation(db,taskId,rowKey,{...retry,state:'IN_FLIGHT'});db.close();
  await createWorkspaceBackup(source,file,'schema-only-fixture-password');
  const prepared=await prepareWorkspaceRestore(target,file,'schema-only-fixture-password');await commitWorkspaceRestore(target,prepared);
  const restored=openDatabase(target);try{
    const operation=api.readSchemaOperation(restored,taskId,rowKey,retry.scope);
    assert.equal(operation.budget.state,'WAITING');assert.equal(operation.budget.usedDelayedRounds,2);assert.equal(operation.budget.deadlineAt,retry.deadlineAt);
    assert.equal(restored.prepare('SELECT count(*) n FROM automatic_listing_tasks').get()!.n,0);
  }finally{restored.close();}
});
