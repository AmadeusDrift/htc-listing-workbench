import type {DraftRecord} from '../amazon/persistence.ts';
import type {AutomaticListingTask} from '../../shared/automatic-listing-contracts.ts';
import {validateSalesPlan} from './records.ts';
import {validateAutomaticListingTask} from '../automatic-listing/records.ts';
import {fingerprint} from '../execution/records.ts';
import {UserFacingError} from '../../shared/errors.ts';

export interface DraftUnitAdoptionProof {version:1;token:string;before:DraftRecord;after:DraftRecord;basis:string}
export interface TaskUnitAdoptionProof {taskId:string;itemKey:string;token:string;before:AutomaticListingTask;afterTask:AutomaticListingTask;afterPlan:unknown;afterDraftRevision:number}
function conflict(reason='evidence'):never{throw new UserFacingError('UNIT_ADOPTION_RESTORE_CONFLICT ('+reason+')：旧备份计量采用与原来源、SKU、请求或图片证明不一致，未恢复；请选择更新备份或保留当前工作区');}
const same=(a:unknown,b:unknown)=>fingerprint({value:a})===fingerprint({value:b});
const unsafeDraft=(r:DraftRecord)=>r.unresolvedWrite||r.draft.submittedAt||['UNKNOWN','SUBMITTING','SUBMITTED','PROCESSING','BUYABLE','DISCOVERABLE'].includes(r.draft.state);
/** Only credential disconnection/preview revocation performed by restore may differ. */
function disconnectedDraft(r:DraftRecord){
 const next=structuredClone(r);if(next.draft.mode==='live'){next.preview=null;next.draft.previewedAt=null;if(next.draft.state==='AMAZON_VALIDATED')next.draft.state='DRAFT';}return next;
}
export const capturedUnitDraft=(snapshot:DraftRecord,current:DraftRecord)=>same(disconnectedDraft(snapshot),disconnectedDraft(current));
export function restoreAdoptedDraft(snapshot:DraftRecord,current:DraftRecord,proof:DraftUnitAdoptionProof):DraftRecord {
 try{
  const captured=capturedUnitDraft(snapshot,current);
  if(proof.version!==1||!/^[a-f0-9]{64}$/u.test(proof.token)||!proof.basis.trim()||!captured&&(unsafeDraft(current)||unsafeDraft(snapshot))||unsafeDraft(proof.before)||unsafeDraft(proof.after))conflict();
  const before=proof.before.draft,after=proof.after.draft,old=validateSalesPlan(before.salesPlan),next=validateSalesPlan(after.salesPlan);
  if(!next.unitAdoption||!same(next.unitAdoption.previousRecipe,old.recipe)||next.unitAdoption.originalRecipeKey!==old.recipe.key||next.unitAdoption.basis!==proof.basis||after.revision!==before.revision+1)conflict();
  for(const key of ['id','productId','productRevision','variantId','targetId','sellerId','marketplaceId','mode','sku','createdAt'] as const)if(before[key]!==after[key]||after[key]!==current.draft[key])conflict();
  for(const key of ['schema','parentImageSourceDraftId'] as const)if(!same(before[key],after[key])||!same(after[key],current.draft[key]))conflict();
  const imageRefs=(r:DraftRecord)=>Object.fromEntries(Object.entries(r.draft.attributes).filter(([key])=>/image|media_location/i.test(key)));if(!same(imageRefs(proof.before),imageRefs(proof.after)))conflict();
  for(const key of ['namingGroupId','sourceGroupKey','collectedAt','sku','baseSku','namingChildKey','parentage','parentSku','variationTheme','familyBinding'] as const)if(!same(old[key],next[key]))conflict();
  if(!same(current.draft.salesPlan,next))conflict();
  // A newer selected snapshot already containing the current local facts needs
  // no transplant. Old snapshots cannot silently discard later manual edits.
  if(captured)return structuredClone(snapshot);
  if(!same(disconnectedDraft(current),disconnectedDraft(proof.after)))conflict();
  if(same(disconnectedDraft(snapshot),disconnectedDraft(proof.after)))return structuredClone(snapshot);
  if(!same(disconnectedDraft(snapshot),disconnectedDraft(proof.before)))conflict();
  // Adopt-time result only: later current fields/results are never copied into an old snapshot.
  return disconnectedDraft(proof.after);
 }catch(error){if(error instanceof UserFacingError&&error.message.startsWith('UNIT_ADOPTION_RESTORE_CONFLICT'))throw error;conflict();}
}
function originalTask(snapshot:AutomaticListingTask,before:AutomaticListingTask,current?:AutomaticListingTask){
 const next=structuredClone(snapshot);
 if(next.error==='已恢复备份；请核对配置和任务范围后继续'&&next.status==='PAUSED'&&next.revision>before.revision){next.status=before.status;next.error=before.error;next.revision=before.revision;}
 if(current&&next.error==='已恢复显式计量采用；保留原 SKU、请求和费用，请核对配置后自行继续'&&next.status==='PAUSED'&&next.revision>before.revision){
  next.revision=before.revision;next.status=before.status;next.error=before.error;
  for(const row of next.items){const original=before.items.find(r=>r.key===row.key),live=current.items.find(r=>r.key===row.key);if(!original||!live||row.imageAttempts<original.imageAttempts||row.imageAttempts>Math.max(original.imageAttempts,live.imageAttempts)||row.repairAttempts<original.repairAttempts||row.repairAttempts>Math.max(original.repairAttempts,live.repairAttempts))conflict();row.imageAttempts=original.imageAttempts;row.repairAttempts=original.repairAttempts;}
 }
 return next;
}
const unsafeTask=(task:AutomaticListingTask)=>!['PAUSED','NEEDS_ATTENTION'].includes(task.status)||task.items.some(row=>row.status==='RUNNING'||row.batchWait||row.familyTransition||row.schemaRetry?.state==='IN_FLIGHT'||row.repair?.phase==='FIELDS_STARTED'||row.outcome?.kind==='UNKNOWN'||['READBACK','LABELS','COMPLETE'].includes(row.stage));
export const capturedUnitTask=(snapshot:AutomaticListingTask,current:AutomaticListingTask)=>same(originalTask(snapshot,current,current),current);
export function restoreAdoptedTask(snapshot:AutomaticListingTask,current:AutomaticListingTask,proof:TaskUnitAdoptionProof,draft:DraftRecord):AutomaticListingTask {
 try{
  const before=validateAutomaticListingTask(proof.before),after=validateAutomaticListingTask(proof.afterTask);
  const captured=capturedUnitTask(snapshot,current);
  if(!captured&&(unsafeTask(current)||unsafeTask(snapshot))||unsafeTask(before)||unsafeTask(after)||proof.taskId!==before.id||before.id!==after.id||after.id!==current.id||snapshot.id!==after.id||after.revision!==before.revision+1)conflict();
  const old=before.items.find(row=>row.key===proof.itemKey),next=after.items.find(row=>row.key===proof.itemKey),latest=current.items.find(row=>row.key===proof.itemKey);
  if(!old?.salesPlan||!next?.salesPlan?.unitAdoption||!latest||old.draftId!==draft.draft.id||next.draftId!==old.draftId||!same(next.salesPlan,proof.afterPlan)||!same(next.salesPlan,draft.draft.salesPlan)||(captured?proof.afterDraftRevision>draft.draft.revision:proof.afterDraftRevision!==draft.draft.revision)||!same(next.salesPlan,latest.salesPlan))conflict();
  for(const key of ['key','productId','productRevision','sourceStamp','variantId','sku','draftId'] as const)if(old[key]!==next[key]||next[key]!==latest[key])conflict();
  if(!same(next.salesPlan.unitAdoption.previousRecipe,old.salesPlan.recipe))conflict();
  if(captured)return validateAutomaticListingTask({...structuredClone(snapshot),status:'PAUSED'});
  const fromBefore=same(originalTask(snapshot,before),before),fromAfter=same(originalTask(snapshot,after,current),after);if(!fromBefore&&!fromAfter)conflict('task snapshot');
  const restored=structuredClone(after);restored.status='PAUSED';restored.error='已恢复显式计量采用；保留原 SKU、请求和费用，请核对配置后自行继续';restored.revision=Math.max(snapshot.revision,after.revision)+1;
  for(const row of restored.items){const live=current.items.find(item=>item.key===row.key);if(!live)conflict();row.imageAttempts=Math.max(row.imageAttempts,live.imageAttempts);row.repairAttempts=Math.max(row.repairAttempts,live.repairAttempts);}
  return validateAutomaticListingTask(restored);
 }catch(error){if(error instanceof UserFacingError&&error.message.startsWith('UNIT_ADOPTION_RESTORE_CONFLICT'))throw error;conflict();}
}
