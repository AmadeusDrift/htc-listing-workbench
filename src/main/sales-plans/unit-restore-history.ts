import type{DatabaseSync}from'node:sqlite';
import{dirname}from'node:path';
import type{DraftRecord}from'../amazon/persistence.ts';
import{restoreSalesUnitRecord}from'../amazon/unit-retention.ts';
import{restoreSalesUnitTask}from'../automatic-listing/unit-retention.ts';
import{capturedUnitDraft,capturedUnitTask,restoreAdoptedDraft,restoreAdoptedTask}from'./unit-restore.ts';
import{assertSalesPlanNamingIdentity}from'./history.ts';
import{localAiRequestResolved}from'../ai/request-certainty.ts';
import{listingHash}from'../amazon/context.ts';
import{validateAutomaticListingTask}from'../automatic-listing/records.ts';
import{appendAuditEvent}from'../storage/audit.ts';
import{fingerprint}from'../execution/records.ts';
import{UserFacingError}from'../../shared/errors.ts';

function conflict():never{throw new UserFacingError('UNIT_ADOPTION_RESTORE_CONFLICT：原单位采用所需的来源、图片或请求证据缺失/未知，未恢复旧备份');}
const same=(a:unknown,b:unknown)=>fingerprint({value:a})===fingerprint({value:b});
/** Read-only history reconciliation; business writes go through M06/M11 owners. */
export function retainSalesUnitAdoptions(current:DatabaseSync,snapshot:DatabaseSync):void{
 if(!snapshot.isTransaction)conflict();
 const file=String(current.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file??'');if(!file)conflict();
 for(const saved of current.prepare("SELECT id,record_json FROM listing_drafts WHERE json_type(record_json,'$.draft.salesPlan.unitAdoption')='object'").all()){
  const now=JSON.parse(String(saved.record_json)) as DraftRecord,d=now.draft,old=snapshot.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(saved.id);if(!old)conflict();
  const audits=current.prepare("SELECT * FROM audit_events WHERE action='listing.sales-units.adopted' AND json_extract(detail_json,'$.before.draft.id')=? ORDER BY rowid").all(saved.id);if(audits.length!==1)conflict();
  const audit=audits[0],proof=JSON.parse(String(audit.detail_json));if(audit.product_id!==d.productId)conflict();
  const prior=JSON.parse(String(old.record_json)) as DraftRecord,captured=capturedUnitDraft(prior,now),restored=restoreAdoptedDraft(prior,now,proof);
  for(const db of [current,snapshot]){
   if(!captured&&db.prepare('SELECT 1 FROM amazon_write_locks WHERE listing_hash=? OR draft_id=?').get(listingHash(d,d.sku),d.id))conflict();
   assertSalesPlanNamingIdentity(db,restored.draft.salesPlan,d.mode,d.sellerId);
   const product=db.prepare('SELECT revision FROM products WHERE id=?').get(d.productId);if(product?.revision!==d.productRevision)conflict();
   const target=db.prepare('SELECT target_json FROM amazon_targets WHERE id=?').get(d.targetId),t=target?JSON.parse(String(target.target_json)):null;if(!t||(['mode','sellerId','marketplaceId'] as const).some(key=>t[key]!==d[key]))conflict();
   if(!captured){
    for(const call of db.prepare("SELECT id,record_json FROM ai_calls WHERE json_extract(record_json,'$.productId')=?").all(d.productId))if(!localAiRequestResolved(db,dirname(String(db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file??file)),String(call.id),JSON.parse(String(call.record_json))))conflict();
    if(db.prepare("SELECT 1 FROM image_workflow_runs WHERE json_extract(record_json,'$.draftId')=? AND (json_extract(record_json,'$.status') IN ('RUNNING','WAITING_BATCH') OR EXISTS(SELECT 1 FROM json_each(record_json,'$.slots') s WHERE json_extract(s.value,'$.status') IN ('RUNNING','UNKNOWN')))").get(d.id))conflict();
    if(db.prepare("SELECT 1 FROM execution_tasks t,json_each(t.record_json,'$.items') i WHERE json_extract(i.value,'$.draftId')=? AND (json_extract(i.value,'$.submitStarted')=1 OR json_extract(t.record_json,'$.status') IN ('RUNNING','QUEUED'))").get(d.id))conflict();
   }
  }
  // No new source/fact/image metadata is transplanted from current into the selected backup.
  const sourceState=(db:DatabaseSync)=>({
   product:db.prepare('SELECT * FROM products WHERE id=? ORDER BY id').all(d.productId),
   variants:db.prepare('SELECT * FROM variants WHERE product_id=? ORDER BY id').all(d.productId),
   facts:db.prepare('SELECT * FROM facts WHERE product_id=? ORDER BY id').all(d.productId),
   assets:db.prepare('SELECT * FROM assets WHERE product_id=? ORDER BY id').all(d.productId),
   variantAssets:db.prepare('SELECT va.* FROM variant_assets va JOIN variants v ON v.id=va.variant_id WHERE v.product_id=? ORDER BY va.variant_id,va.asset_id').all(d.productId),
  });
  if(!same(sourceState(current),sourceState(snapshot)))conflict();
  const owners=current.prepare("SELECT id,record_json FROM automatic_listing_tasks WHERE EXISTS(SELECT 1 FROM json_each(record_json,'$.items') i WHERE json_extract(i.value,'$.draftId')=? OR json_extract(i.value,'$.sku')=?)").all(d.id,d.sku);if(owners.length>1)conflict();
  let taskPatch:ReturnType<typeof restoreAdoptedTask>|undefined,taskAudit:typeof audit|undefined;
  if(owners.length){
   const task=validateAutomaticListingTask(JSON.parse(String(owners[0].record_json))),entry=task.items.find(row=>row.draftId===d.id&&row.sku===d.sku);if(!entry)conflict();
   const original=snapshot.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id),proofs=current.prepare("SELECT * FROM audit_events WHERE action='automatic-listing.sales-units.adopted' AND json_extract(detail_json,'$.taskId')=? AND json_extract(detail_json,'$.itemKey')=? ORDER BY rowid").all(task.id,entry.key);if(!original||proofs.length!==1)conflict();
   const capturedTask=validateAutomaticListingTask(JSON.parse(String(original.record_json)));if(captured&&!capturedUnitTask(capturedTask,task))conflict();
   taskAudit=proofs[0];if(taskAudit.product_id!==d.productId)conflict();taskPatch=restoreAdoptedTask(capturedTask,task,JSON.parse(String(taskAudit.detail_json)),restored);
   if(taskPatch.items.find(row=>row.key===entry.key)?.unitRecheck){const marker=taskPatch.items.find(row=>row.key===entry.key)!.unitRecheck!;
    const run=current.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(marker.sourceWorkflowId),prior=snapshot.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(marker.sourceWorkflowId);if(!run||!prior||run.record_json!==prior.record_json)conflict();
   }
  }
  for(const event of [audit,...(taskAudit?[taskAudit]:[])]){
   const exists=snapshot.prepare('SELECT * FROM audit_events WHERE id=?').get(event.id);if(exists){if(!same(exists,event))conflict();}
   else appendAuditEvent(snapshot,String(event.id),String(event.product_id),String(event.action),String(event.summary),String(event.detail_json),String(event.created_at));
  }
  if(!captured){restoreSalesUnitRecord(snapshot,restored);if(taskPatch)restoreSalesUnitTask(snapshot,taskPatch);}
 }
}

