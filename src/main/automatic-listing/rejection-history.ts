import { fingerprint } from '../execution/records.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { AutomaticListingTask } from '../../shared/automatic-listing-contracts.ts';
import { validateStoredImageWorkflowRun } from '../image-workflow/records.ts';
import { assertWorkflowRejectionOwner,readCompletionForRejection } from '../image-workflow/rejection.ts';
import { validateAiCall,validateStoredAiResult } from '../ai/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
export function assertAutomaticRejectionHistory(db:DatabaseSync,task:AutomaticListingTask):void{
 for(const item of task.items){const r=item.rejection;if(!r)continue;
  const row=db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(r.workflowId);
  if(!row)throw new UserFacingError('拒绝原因工作流记录缺失');
  const run=validateStoredImageWorkflowRun(JSON.parse(String(row.record_json)));
  let retained=false;
  if(task.adaptation&&run.productRevision!==item.productRevision){
    let token:string|undefined=task.adaptation.token;const seen=new Set<string>();
    while(token&&!seen.has(token)&&seen.size<1000){
      seen.add(token);const audit:{detail_json?:unknown}|undefined=db.prepare("SELECT detail_json FROM audit_events WHERE action='automatic-listing.adapted' AND json_extract(detail_json,'$.token')=?").get(token);
      const before:AutomaticListingTask|undefined=audit?JSON.parse(String(audit.detail_json)).before:undefined,prior=before?.items.find(row=>row.key===item.key);
      if(before?.id!==task.id||!prior||fingerprint(prior.rejection??null)!==fingerprint(r))break;
      if(prior.productRevision===run.productRevision){retained=true;break;}token=before.adaptation?.token;
    }
  }
  if(run.id!==r.workflowId||run.draftId!==item.draftId||run.productId!==item.productId||run.productRevision!==item.productRevision&&!retained||run.variantId!==item.variantId)throw new UserFacingError('拒绝原因工作流归属不一致');
  assertWorkflowRejectionOwner({...run,rejection:r.detail},id=>{const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(id);return row?validateAiCall(JSON.parse(String(row.record_json))):undefined;},id=>{const row=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id);return row?validateStoredAiResult(JSON.parse(String(row.record_json))):undefined;},id=>readCompletionForRejection(db,id));
 }
}
