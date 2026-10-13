import type { TaskResultPort } from '../application/task-port.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { validateAutomaticListingTask } from './records.ts';
import { imageWorkflowDraftStamp } from '../image-workflow/approval-reuse.ts';

const conflict=():never=>{throw new UserFacingError('自动任务检查点已变化，保留原记录；请重新核对后继续');};
/** The task module alone owns task record mutation, including local field-migration results. */
export const automaticTaskResults:TaskResultPort={
 prepare(db,{kind,before,operationId}){
  if(!db.isTransaction)throw new UserFacingError('任务结果命令必须与领域结果处于同一事务');
  const draft=structuredClone(before),stamp=imageWorkflowDraftStamp(draft);
  const owners=db.prepare("SELECT t.id,t.record_json FROM automatic_listing_tasks t WHERE EXISTS(SELECT 1 FROM json_each(t.record_json,'$.items') i WHERE json_extract(i.value,'$.draftId')=?)").all(draft.id).map(saved=>({json:String(saved.record_json),task:validateAutomaticListingTask(JSON.parse(String(saved.record_json)))}));
  for(const {task} of owners)for(const row of task.items.filter(row=>row.draftId===draft.id)){
   if(task.targetId!==draft.targetId||task.sellerId!==draft.sellerId||task.marketplaceId!==draft.marketplaceId||task.mode!==draft.mode||row.productId!==draft.productId||row.productRevision!==draft.productRevision||row.variantId!==draft.variantId||row.sku!==draft.sku)conflict();
   if(kind==='selected-firmness'&&(row.batchId||row.status==='DONE')||kind==='fixed-brand'&&!row.repair)conflict();
   if(row.repair&&(row.repair.operationId!==operationId||row.repair.draftRevision!==draft.revision||row.repair.draftStamp!==stamp||!['FIELDS_PENDING','FIELDS_STARTED','RECHECK_PENDING'].includes(row.repair.phase)))conflict();
  }
  let committed=false;
  return {commit(after,remaining){
   if(!db.isTransaction||committed||after.id!==draft.id||after.revision!==draft.revision+1)conflict();
   for(const {task,json} of owners){
    const rows=task.items.filter(row=>row.draftId===draft.id&&row.repair);
    if(!rows.length)continue;
    for(const row of rows){row.repair!.draftRevision=after.revision;row.repair!.draftStamp=imageWorkflowDraftStamp(after);if(remaining!==undefined)row.repair!.remaining=structuredClone(remaining);}
    task.revision++;task.updatedAt=after.updatedAt;validateAutomaticListingTask(task);
    if(db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=? AND record_json=?').run(JSON.stringify(task),task.id,json).changes!==1)conflict();
   }
   committed=true;
  }};
 }
};
