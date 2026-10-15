import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AutomaticTaskCheckpoints } from '../src/main/automatic-listing/checkpoints.ts';
import { validateAutomaticListingTask } from '../src/main/automatic-listing/records.ts';

function fixture() {
  const now=new Date().toISOString(), productId=randomUUID();
  const row=(sku:string)=>{const variantId=randomUUID();return {key:productId+':'+variantId,productId,productRevision:1,sourceStamp:'a'.repeat(64),productTitle:'Box',variantId,sku,stockSets:1,sourcesPrepared:false,status:'PENDING',stage:'SOURCES',draftId:null,executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,batchId:null,error:null};};
  const task=validateAutomaticListingTask({id:randomUUID(),revision:1,status:'RUNNING',targetId:'target',targetName:'Target',sellerId:'seller',marketplaceId:'market',mode:'demo',targetStamp:'a'.repeat(64),profileId:'alpha',profileStamp:'a'.repeat(64),rulesStamp:'a'.repeat(64),ruleRevision:1,productType:'AUTO',locale:'en_US',labelFormat:{labelType:'STANDARD_FORMAT',pageType:'A4_21',localeCode:'en_US'},items:[row('ONE'),row('TWO')],createdAt:now,updatedAt:now,error:null});
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE automatic_listing_tasks(id TEXT PRIMARY KEY, record_json TEXT NOT NULL)');
  db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));
  return {task,db,checkpoints:new AutomaticTaskCheckpoints()};
}

test('one SKU checkpoint patches only its item and preserves full JSON readers',()=>{
  const {task,db,checkpoints}=fixture();try{
    checkpoints.remember(task);const before=JSON.stringify(task.items[1]),stamp=checkpoints.itemStamp(task.id,task.items[1].key);task.items[0].status='RUNNING';task.revision++;
    Object.defineProperty(task.items[1],'toJSON',{value:()=>{throw new Error('unchanged SKU must not be serialized');},enumerable:false});
    const change=checkpoints.prepare(task);assert.deepEqual(change.items.map(r=>r.key),[task.items[0].key]);assert.equal(change.full,false);
    checkpoints.write(db,task,change,1);checkpoints.remember(task,change);
    assert.equal(checkpoints.itemStamp(task.id,task.items[1].key),stamp);
    const stored=validateAutomaticListingTask(JSON.parse(String(db.prepare('SELECT record_json FROM automatic_listing_tasks').get()!.record_json)));
    assert.deepEqual(stored,task);assert.equal(JSON.stringify(stored.items[1]),before);
    assert.match(change.sql,/json_set/);assert.equal(change.serializedItems.length,1);
  }finally{db.close();}
});

test('changed malformed row, duplicate SKU, scope and terminal mismatch remain rejected',()=>{
  for(const corrupt of [(t:any)=>t.items[1].repairAttempts=-1,(t:any)=>t.items[1].sku=t.items[0].sku,(t:any)=>t.targetStamp='bad',(t:any)=>t.status='COMPLETED']){
    const {task,db,checkpoints}=fixture();try{checkpoints.remember(task);corrupt(task);assert.throws(()=>checkpoints.prepare(task));}finally{db.close();}
  }
});

test('task-wide changes use full verification; stale CAS cannot overwrite pause',()=>{
  const {task,db,checkpoints}=fixture();try{
    checkpoints.remember(task);task.rulesStamp='b'.repeat(64);task.revision++;
    const change=checkpoints.prepare(task);assert.equal(change.full,true);
    db.prepare("UPDATE automatic_listing_tasks SET record_json=json_set(record_json,'$.revision',7,'$.status','PAUSED')").run();
    assert.throws(()=>checkpoints.write(db,task,change,1),/检查点/);
    assert.equal(JSON.parse(String(db.prepare('SELECT record_json FROM automatic_listing_tasks').get()!.record_json)).status,'PAUSED');
  }finally{db.close();}
});

