import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { derivedAssetIdsForProduct } from '../src/main/image-workflow/derived-assets.ts';
import { workflowRuns } from '../src/main/image-workflow/records.ts';

function fixture(t:import('node:test').TestContext){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,product_id TEXT); CREATE TABLE image_workflow_runs(id TEXT PRIMARY KEY,record_json TEXT)');
  return db;
}
test('derived exclusion covers every draft, old run, legacy approved image and slot, including foreign owner references',t=>{
  const db=fixture(t),product=randomUUID(),other=randomUUID(),ids=Array.from({length:6},()=>randomUUID());
  for(const [index,id] of ids.entries())db.prepare('INSERT INTO assets VALUES(?,?)').run(id,index===5?other:product);
  const records=[
    {draftId:randomUUID(),productId:product,status:'FAILED',approvedAssetId:ids[0]},
    {draftId:randomUUID(),productId:product,status:'BLOCKED',slots:[{approvedAssetId:ids[1]},{approvedAssetId:ids[2]}]},
    {draftId:randomUUID(),productId:other,status:'RUNNING',slots:[{approvedAssetId:ids[3]},{approvedAssetId:ids[5]}]},
  ];
  for(const record of records)db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(randomUUID(),JSON.stringify(record));
  db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(randomUUID(),`{"approvedAssetId":"${ids[0]}","approvedAssetId":"${ids[4]}"}`);
  assert.deepEqual([...derivedAssetIdsForProduct(db,product)].sort(),ids.slice(0,5).sort());
  assert.deepEqual([...derivedAssetIdsForProduct(db,other)],[ids[5]]);
});
test('exclusion projection never validates unrelated giant business contexts or changes records; business reads remain strict',t=>{
  const db=fixture(t),product=randomUUID(),asset=randomUUID();db.prepare('INSERT INTO assets VALUES(?,?)').run(asset,product);
  const raw=JSON.stringify({productId:randomUUID(),approvedAssetId:asset,imageContext:{invalid:true,unused:'x'.repeat(20000)}});
  db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(randomUUID(),raw);
  const before=db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.deepEqual([...derivedAssetIdsForProduct(db,product)],[asset]);
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,before);
  assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs').get()!.record_json,raw);
  assert.throws(()=>workflowRuns(db),'complete owner history validation is still required for actual business use');
});
