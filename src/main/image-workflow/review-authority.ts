import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ImageWorkflowRun,ImageReviewRequestV2} from '../../shared/image-workflow-contracts.ts';
import type {AiCall} from '../../shared/ai-contracts.ts';
import {taskAiContext} from '../ai/batch/task-context.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {localAiRequestResolved} from '../ai/request-certainty.ts';
import {readCallReceiptSync} from '../ai/receipts.ts';
import {UserFacingError} from '../../shared/errors.ts';
interface ManualCommand{draftId:string;at:string;id:string;active:boolean}
const commands=new AsyncLocalStorage<ManualCommand>();
/** Called only by the existing authorized main IPC handler, never by workflow retries. */
export function withManualImageReviewCommand<T>(draftId:string,work:()=>Promise<T>):Promise<T>{const c={draftId,at:new Date().toISOString(),id:randomUUID(),active:true};return commands.run(c,async()=>{try{return await work();}finally{c.active=false;}});}
const fail=():never=>{throw new UserFacingError('已收无效审核须有当前明确继续授权及原图位剩余额度；原候选、次数与费用保留');};
export function imageReviewRepairAuthorization(db:DatabaseSync,directory:string,run:ImageWorkflowRun,request:ImageReviewRequestV2,prior:AiCall):NonNullable<ImageReviewRequestV2['repair']>{
 const receipt=readCallReceiptSync(db,directory,prior);if(request.state!=='RECEIVED_INVALID'||prior.id!==request.requestId||prior.status!=='FAILED'||prior.errorCode!=='OUTPUT_INVALID'||!prior.finishedAt||!localAiRequestResolved(db,directory,prior.id,prior)||!receipt||receipt.capture.body==='[omitted: credential echo]')fail();
 const manual=commands.getStore(),scope=taskAiContext.getStore();let repair:NonNullable<ImageReviewRequestV2['repair']>;
 if(manual?.active&&manual.draftId===run.draftId&&manual.at>prior.finishedAt!){repair={priorRequestId:prior.id,rootRequestId:request.repair?.rootRequestId??prior.id,commandSha256:listingFingerprint({kind:'manual',id:manual.id,draftId:manual.draftId}),authorizedAt:manual.at,owner:{kind:'manual',draftId:manual.draftId}};}
 else if(scope?.explicitContinueAt&&scope.explicitContinueAt>prior.finishedAt!&&scope.authorize()===true){
  const bound=db.prepare("SELECT 1 FROM audit_events WHERE action='run.evidence' AND json_extract(detail_json,'$.event')='REQUEST_RESERVED' AND json_extract(detail_json,'$.callId')=? AND json_extract(detail_json,'$.taskId')=? AND json_extract(detail_json,'$.itemKey')=?").get(prior.id,scope.taskId,scope.rowKey);
  const current=db.prepare("SELECT 1 FROM automatic_listing_tasks t,json_each(t.record_json,'$.items') i WHERE t.id=? AND json_extract(t.record_json,'$.status')='RUNNING' AND json_extract(i.value,'$.key')=? AND json_extract(i.value,'$.draftId')=? AND json_extract(i.value,'$.sku')=? AND json_extract(i.value,'$.productId')=? AND json_extract(i.value,'$.variantId')=?").get(scope.taskId,scope.rowKey,run.draftId,run.sku,run.productId,run.variantId);if(!bound||!current)fail();
  repair={priorRequestId:prior.id,rootRequestId:request.repair?.rootRequestId??prior.id,commandSha256:listingFingerprint({kind:'task',taskId:scope.taskId,itemKey:scope.rowKey,at:scope.explicitContinueAt}),authorizedAt:scope.explicitContinueAt,owner:{kind:'task',taskId:scope.taskId,itemKey:scope.rowKey}};
 }else return fail();
 if(run.reviewRequests?.some(r=>r.version===2&&r.repair?.rootRequestId===repair.rootRequestId&&r.repair.commandSha256===repair.commandSha256&&r.reservedAt!==null))fail();return repair;
}
export function assertImageReviewRepairAuthorization(db:DatabaseSync,directory:string,run:ImageWorkflowRun,request:ImageReviewRequestV2,prior:AiCall):void {
 if(!request.repair)fail();const original=run.reviewRequests?.find(r=>r.requestId===request.repair!.priorRequestId);if(!original||original.version!==2)fail();const actual=imageReviewRepairAuthorization(db,directory,{...run,reviewRequests:run.reviewRequests?.filter(r=>r.requestId!==request.requestId)},original as ImageReviewRequestV2,prior);if(listingFingerprint(actual)!==listingFingerprint(request.repair))fail();
}
