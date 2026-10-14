import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {taskKit} from './fixtures/mixed-kit.ts';
import {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore} from '../src/main/backup.ts';
import {openDatabase} from '../src/main/database.ts';
import{currentWorkBatch,addWorkBatchProducts,bindWorkBatchTask}from'../src/main/automatic-listing/work-batches.ts';

test('actual older backup prepare and commit preserve explicit adopted units and original task identity',async t=>{
 const f=await taskKit(t),file=join(f.directory,'older.htcbackup'),pass='synthetic unit restore';
 const batch=currentWorkBatch(f.db);addWorkBatchProducts(f.db,batch.id,[f.p.id]);bindWorkBatchTask(f.db,batch.id,f.task.id);
 await createWorkspaceBackup(f.directory,file,pass);
 const input={taskId:f.task.id,taskRevision:f.task.revision,itemKey:f.task.items[0].key,platformPieces:1,basis:'Synthetic original full kit'};
 const preview=f.owner.previewSalesUnitAdoption(input),adopted=f.owner.adoptSalesUnit({...input,token:preview.token,confirmed:true}),after=f.persistence.record(f.ref.id);
 const history=f.db.prepare("SELECT * FROM audit_events WHERE action IN ('listing.sales-units.adopted','automatic-listing.sales-units.adopted') ORDER BY rowid").all();
 const prepared=await prepareWorkspaceRestore(f.directory,file,pass),stage=new DatabaseSync(join(prepared.stagingDirectory,'red.sqlite'));
 try{
  const r=JSON.parse(String(stage.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.ref.id)!.record_json));
  assert.equal(r.draft.salesPlan.recipe.quantityVersion,2,'older restore must not revert adopted unit to 50 attachment pieces');
  assert.deepEqual(r.draft.salesPlan,after.draft.salesPlan);
  const task=JSON.parse(String(stage.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(f.task.id)!.record_json));
  assert.equal(task.status,'PAUSED');assert.equal(task.items[0].key,adopted.items[0].key);assert.deepEqual(task.items[0].salesPlan,after.draft.salesPlan);
  assert.deepEqual(stage.prepare("SELECT * FROM audit_events WHERE action IN ('listing.sales-units.adopted','automatic-listing.sales-units.adopted') ORDER BY rowid").all(),history);
 }finally{stage.close();}
 await f.owner.close();await f.ai.close();await f.hosting.close();f.amazon.close();f.store.close();t.mock.method(f.store,'close',()=>{});
 await commitWorkspaceRestore(f.directory,prepared);
 const restored=openDatabase(f.directory);try{const r=JSON.parse(String(restored.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.ref.id)!.record_json));assert.deepEqual(r.draft.salesPlan,after.draft.salesPlan);}finally{restored.close();}
 const repeated=await prepareWorkspaceRestore(f.directory,file,pass);await commitWorkspaceRestore(f.directory,repeated);
 const again=openDatabase(f.directory);try{assert.deepEqual(JSON.parse(String(again.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.ref.id)!.record_json)).draft.salesPlan,after.draft.salesPlan);assert.deepEqual(again.prepare("SELECT * FROM audit_events WHERE action IN ('listing.sales-units.adopted','automatic-listing.sales-units.adopted') ORDER BY rowid").all(),history);}finally{again.close();}
 assert.equal(f.requests.length,0);
});

import{restoreAdoptedDraft,restoreAdoptedTask}from'../src/main/sales-plans/unit-restore.ts';
test('pure restore applies only immutable adopt-time proof and keeps original paused task counters',async t=>{
 const f=await taskKit(t),beforeDraft=f.persistence.record(f.ref.id),beforeTask=f.owner.get(f.task.id),input={taskId:f.task.id,taskRevision:f.task.revision,itemKey:f.task.items[0].key,platformPieces:1,basis:'Original synthetic kit'};
 const preview=f.owner.previewSalesUnitAdoption(input),afterTask=f.owner.adoptSalesUnit({...input,token:preview.token,confirmed:true}),afterDraft=f.persistence.record(f.ref.id);
 const draftProof=JSON.parse(String(f.db.prepare("SELECT detail_json FROM audit_events WHERE action='listing.sales-units.adopted'").get()!.detail_json)),taskProof=JSON.parse(String(f.db.prepare("SELECT detail_json FROM audit_events WHERE action='automatic-listing.sales-units.adopted'").get()!.detail_json));
 assert.deepEqual(taskProof.afterTask,afterTask);
 const current=structuredClone(afterDraft),restored=restoreAdoptedDraft(beforeDraft,current,draftProof);assert.deepEqual(restored,afterDraft);
 const live=structuredClone(afterTask);live.items[0].imageAttempts=9;const task=restoreAdoptedTask(beforeTask,live,taskProof,restored);assert.equal(task.status,'PAUSED');assert.equal(task.items[0].imageAttempts,9);assert.equal(task.items[0].key,beforeTask.items[0].key);
 for(const change of ['sku','schema','source','images','unknown','submitted','missing-proof'] as const){const old=structuredClone(beforeDraft),now=structuredClone(current),proof=structuredClone(draftProof);if(change==='sku')old.draft.sku='OTHER-SKU';if(change==='schema')old.draft.schema.checksum='f'.repeat(64);if(change==='source')old.draft.productRevision++;if(change==='images')now.draft.attributes.main_product_image_locator=[{media_location:'https://synthetic.invalid/other.png'}];if(change==='unknown')now.unresolvedWrite=true;if(change==='submitted')now.draft.state='SUBMITTED';if(change==='missing-proof')delete proof.before;assert.throws(()=>restoreAdoptedDraft(old,now,proof),/UNIT_ADOPTION_RESTORE_CONFLICT/,change);}
 const missing=structuredClone(taskProof);delete missing.afterTask;assert.throws(()=>restoreAdoptedTask(beforeTask,afterTask,missing,afterDraft),/UNIT_ADOPTION_RESTORE_CONFLICT/);
 await f.owner.close();assert.equal(f.requests.length,0);
});



test('actual manual save after unit adoption rejects older restore and preserves current facts and history',async t=>{
 const f=await taskKit(t),file=join(f.directory,'before-unit.htcbackup'),pass='synthetic unit manual facts';
 const batch=currentWorkBatch(f.db);addWorkBatchProducts(f.db,batch.id,[f.p.id]);bindWorkBatchTask(f.db,batch.id,f.task.id);await createWorkspaceBackup(f.directory,file,pass);
 const input={taskId:f.task.id,taskRevision:f.task.revision,itemKey:f.task.items[0].key,platformPieces:1,basis:'Synthetic full kit'},preview=f.owner.previewSalesUnitAdoption(input);f.owner.adoptSalesUnit({...input,token:preview.token,confirmed:true});
 const adopted=f.amazon.getDraft(f.ref.id),manual=f.amazon.saveDraft({id:adopted.id,revision:adopted.revision,attributes:{...adopted.attributes,is_value_stores_item:[{value:true,marketplace_id:adopted.marketplaceId}],item_name:[{value:'HUMAN CONFIRMED LATER TITLE',language_tag:'en_US',marketplace_id:adopted.marketplaceId}]}});
 assert.ok(manual.revision>adopted.revision);const before=f.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(adopted.id)!.record_json,history=f.db.prepare('SELECT * FROM audit_events ORDER BY rowid').all();
 await assert.rejects(prepareWorkspaceRestore(f.directory,file,pass),/UNIT_ADOPTION_RESTORE_CONFLICT/);
 assert.equal(f.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(adopted.id)!.record_json,before);assert.deepEqual(f.db.prepare('SELECT * FROM audit_events ORDER BY rowid').all(),history);assert.equal(f.requests.length,0);const newer=join(f.directory,'with-manual.htcbackup');await createWorkspaceBackup(f.directory,newer,pass);const fresh=await prepareWorkspaceRestore(f.directory,newer,pass),stage=new DatabaseSync(join(fresh.stagingDirectory,'red.sqlite'));try{const r=JSON.parse(String(stage.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(adopted.id)!.record_json));assert.deepEqual(r.draft.attributes,manual.attributes);assert.equal(r.draft.revision,manual.revision);}finally{stage.close();}await f.owner.close();
});




test('actual old adapted-task backup retains original unit-only resolved proof and blocked history',async t=>{
 const f=await taskKit(t),checked=f.owner.previewAdaptation(f.task.id),adapted=f.owner.applyAdaptation({taskId:f.task.id,token:checked.token}),file=join(f.directory,'adapted.htcbackup'),pass='synthetic adapted units';
 const batch=currentWorkBatch(f.db);addWorkBatchProducts(f.db,batch.id,[f.p.id]);bindWorkBatchTask(f.db,batch.id,f.task.id);await createWorkspaceBackup(f.directory,file,pass);
 const input={taskId:adapted.id,taskRevision:adapted.revision,itemKey:adapted.items[0].key,platformPieces:1,basis:'Synthetic original kit'},p=f.owner.previewSalesUnitAdoption(input),after=f.owner.adoptSalesUnit({...input,token:p.token,confirmed:true});
 const prepared=await prepareWorkspaceRestore(f.directory,file,pass),stage=new DatabaseSync(join(prepared.stagingDirectory,'red.sqlite'));try{const restored=JSON.parse(String(stage.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(after.id)!.record_json));assert.deepEqual(restored.adaptation.blockedKeys,adapted.adaptation!.blockedKeys);assert.equal(restored.adaptation.token,adapted.adaptation!.token);assert.deepEqual(restored.adaptation.unitResolvedKeys,[input.itemKey]);assertTaskAdaptationHistory(stage,restored);}finally{stage.close();}await f.owner.close();assert.equal(f.requests.length,0);
});
import{assertTaskAdaptationHistory}from'../src/main/automatic-listing/adaptation.ts';
import{saveInput}from'./fixtures/listing-ai.ts';
for(const boundary of ['unknown','submitted','missing-audit','missing-task-after','source-changed','schema-changed'] as const)test('actual old unit restore rejects '+boundary+' without mutating current facts or requests',async t=>{
 const f=await taskKit(t),file=join(f.directory,'protected.htcbackup'),pass='synthetic unknown protection';const batch=currentWorkBatch(f.db);addWorkBatchProducts(f.db,batch.id,[f.p.id]);bindWorkBatchTask(f.db,batch.id,f.task.id);await createWorkspaceBackup(f.directory,file,pass);
 const input={taskId:f.task.id,taskRevision:f.task.revision,itemKey:f.task.items[0].key,platformPieces:1,basis:'Synthetic original kit'},p=f.owner.previewSalesUnitAdoption(input);f.owner.adoptSalesUnit({...input,token:p.token,confirmed:true});
 if(boundary==='unknown'||boundary==='submitted'||boundary==='schema-changed'){const r=f.persistence.record(f.ref.id);if(boundary==='unknown')r.unresolvedWrite=true;if(boundary==='submitted'){r.draft.state='SUBMITTED';r.draft.submittedAt=new Date().toISOString();}if(boundary==='schema-changed')r.draft.schema.checksum='f'.repeat(64);f.persistence.putRecord(r);}
 if(boundary==='missing-audit')f.db.prepare("DELETE FROM audit_events WHERE action='listing.sales-units.adopted'").run();
 if(boundary==='missing-task-after'){const a=f.db.prepare("SELECT id,detail_json FROM audit_events WHERE action='automatic-listing.sales-units.adopted'").get()!,proof=JSON.parse(String(a.detail_json));delete proof.afterTask;f.db.prepare('UPDATE audit_events SET detail_json=? WHERE id=?').run(JSON.stringify(proof),a.id);}
 if(boundary==='source-changed')f.store.saveProduct({...saveInput(f.store.getProductSnapshot(f.p.id)),description:'Human source fact changed after adoption'});
 const before=f.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.ref.id)!.record_json,calls=f.db.prepare('SELECT * FROM ai_calls').all(),fees=f.db.prepare('SELECT * FROM ai_usage_ledger').all();await assert.rejects(prepareWorkspaceRestore(f.directory,file,pass),/UNIT_ADOPTION_RESTORE_CONFLICT/);assert.equal(f.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.ref.id)!.record_json,before);assert.deepEqual(f.db.prepare('SELECT * FROM ai_calls').all(),calls);assert.deepEqual(f.db.prepare('SELECT * FROM ai_usage_ledger').all(),fees);assert.equal(f.requests.length,0);await f.owner.close();
});

test('commit rechecks manual facts saved after restore preparation before installing older units',async t=>{
 const f=await taskKit(t),file=join(f.directory,'before-unit.htcbackup'),pass='synthetic prepare commit';const batch=currentWorkBatch(f.db);addWorkBatchProducts(f.db,batch.id,[f.p.id]);bindWorkBatchTask(f.db,batch.id,f.task.id);await createWorkspaceBackup(f.directory,file,pass);
 const input={taskId:f.task.id,taskRevision:f.task.revision,itemKey:f.task.items[0].key,platformPieces:1,basis:'Synthetic original kit'},p=f.owner.previewSalesUnitAdoption(input);f.owner.adoptSalesUnit({...input,token:p.token,confirmed:true});const prepared=await prepareWorkspaceRestore(f.directory,file,pass),d=f.amazon.getDraft(f.ref.id);
 const manual=f.amazon.saveDraft({id:d.id,revision:d.revision,attributes:{...d.attributes,is_value_stores_item:[{value:true,marketplace_id:d.marketplaceId}],item_name:[{value:'MANUAL FACT AFTER PREPARE',language_tag:'en_US',marketplace_id:d.marketplaceId}]}}),before=f.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(d.id)!.record_json;
 await f.owner.close();await f.ai.close();await f.hosting.close();f.amazon.close();f.store.close();t.mock.method(f.store,'close',()=>{});
 await assert.rejects(commitWorkspaceRestore(f.directory,prepared),/UNIT_ADOPTION_RESTORE_CONFLICT/);
 const db=openDatabase(f.directory);try{const raw=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(d.id)!.record_json;assert.equal(raw,before);assert.deepEqual(JSON.parse(String(raw)).draft.attributes,manual.attributes);}finally{db.close();}assert.equal(f.requests.length,0);
});
import{listingHash}from'../src/main/amazon/context.ts';
for(const state of ['UNKNOWN','SUBMITTED'] as const)test('latest complete '+state+' capture restores original units, response, lock and unknown fee without adoption patch',async t=>{
 const f=await taskKit(t),file=join(f.directory,'latest-protected.htcbackup'),pass='synthetic complete capture';const batch=currentWorkBatch(f.db);addWorkBatchProducts(f.db,batch.id,[f.p.id]);bindWorkBatchTask(f.db,batch.id,f.task.id);
 const input={taskId:f.task.id,taskRevision:f.task.revision,itemKey:f.task.items[0].key,platformPieces:1,basis:'Synthetic original kit'},p=f.owner.previewSalesUnitAdoption(input);f.owner.adoptSalesUnit({...input,token:p.token,confirmed:true});
 f.respond(()=>new Response('{}',{status:500}));await assert.rejects(f.ai.suggest({productId:f.p.id,productRevision:f.p.revision,variantId:f.p.variants[0].id,ocrResultIds:[]}));
 const r=f.persistence.record(f.ref.id);r.draft.state=state;r.unresolvedWrite=state==='UNKNOWN';r.submitResponse={sku:r.draft.sku,status:state==='SUBMITTED'?'ACCEPTED':'RESULT_UNKNOWN',issues:[]};if(state==='SUBMITTED')r.draft.submittedAt=new Date().toISOString();f.persistence.putRecord(r);
 const hash=listingHash(r.draft,r.draft.sku);f.db.prepare('INSERT INTO amazon_write_locks VALUES(?,?,?,?,?,?)').run(hash,r.draft.id,state,new Date().toISOString(),'draft',r.draft.id);
 const calls=f.db.prepare('SELECT * FROM ai_calls').all(),fees=f.db.prepare('SELECT * FROM ai_usage_ledger').all(),draft=f.persistence.record(r.draft.id),adoptions=f.db.prepare("SELECT * FROM audit_events WHERE action IN ('listing.sales-units.adopted','automatic-listing.sales-units.adopted') ORDER BY rowid").all();
 await createWorkspaceBackup(f.directory,file,pass);const prepared=await prepareWorkspaceRestore(f.directory,file,pass);
 await f.owner.close();await f.ai.close();await f.hosting.close();f.amazon.close();f.store.close();t.mock.method(f.store,'close',()=>{});await commitWorkspaceRestore(f.directory,prepared);
 const db=openDatabase(f.directory);try{const now=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(draft.draft.id)!.record_json));assert.deepEqual(now,draft);assert.deepEqual(db.prepare('SELECT * FROM ai_calls').all(),calls);assert.deepEqual(db.prepare('SELECT * FROM ai_usage_ledger').all(),fees);assert.deepEqual(db.prepare("SELECT * FROM audit_events WHERE action IN ('listing.sales-units.adopted','automatic-listing.sales-units.adopted') ORDER BY rowid").all(),adoptions);const lock=db.prepare('SELECT * FROM amazon_write_locks WHERE listing_hash=?').get(hash)!;assert.equal(lock.state,'UNKNOWN');assert.equal(lock.draft_id,draft.draft.id);assert.equal(lock.owner_id,draft.draft.id);assert.equal(now.draft.state,state);assert.notEqual(now.draft.state,'BUYABLE');assert.equal(JSON.parse(String(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(f.task.id)!.record_json)).status,'PAUSED');}finally{db.close();}
 assert.equal(f.requests.length,1,'only original fake-provider POST; backup/restore creates none');
});
