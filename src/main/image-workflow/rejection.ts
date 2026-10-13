import { resultHasOwner } from '../ai/result-owner.ts';
import type { DatabaseSync } from 'node:sqlite';
import { validateCompletionOperation,type CompletionOperation } from '../listing-ai/completion-journal.ts';
import type { AiCall,AiResult } from '../../shared/ai-contracts.ts';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { REJECTION_VERSION,validateOutputRejection } from '../../shared/rejection-presentation.ts';
import { keys, uuid, sha256, integer } from "../ai/primitives.ts";
import { UserFacingError } from '../../shared/errors.ts';
import { listingFingerprint } from "../json-fingerprint.ts";

export function validateWorkflowRejection(raw:unknown):NonNullable<ImageWorkflowRun['rejection']>{
 const o=keys(raw,['version','code','callId','resultId','contextSha256','stage','slot']);
 if(o.version!==REJECTION_VERSION||!['content','planning'].includes(String(o.stage)))throw new UserFacingError('原因记录格式无效');
 if(o.code!=='SOURCE_OBSERVATION_INSUFFICIENT')validateOutputRejection({version:o.version,code:o.code});
 if((o.code==='SOURCE_OBSERVATION_INSUFFICIENT')!==(o.resultId!==null))throw new UserFacingError('原因记录关联无效');
 return {version:REJECTION_VERSION,code:o.code as NonNullable<ImageWorkflowRun['rejection']>['code'],callId:uuid(o.callId),resultId:o.resultId===null?null:uuid(o.resultId),contextSha256:sha256(o.contextSha256),stage:o.stage as 'content'|'planning',slot:integer(o.slot,0,7)};
}
export function assertWorkflowRejectionOwner(run:ImageWorkflowRun,getCall:(id:string)=>AiCall|undefined,getResult:(id:string)=>AiResult|undefined,getCompletion?:(id:string)=>CompletionOperation|undefined):void{
 const r=run.rejection;if(!r)return;
 const invalid=():never=>{throw new UserFacingError('原因记录不属于当前工作流，请核对已有记录');};
 const call=getCall(r.callId);if(!call||call.id!==r.callId||call.productId!==run.productId||call.productRevision!==run.productRevision)invalid();
 if(r.resultId){const result=getResult(r.resultId),context=result?.imageContext;
  if(!result||!context||result.id!==r.resultId||result.callId!==r.callId||!resultHasOwner(result,call)||result.productId!==run.productId||result.productRevision!==run.productRevision||result.variantId!==run.variantId||context.listing.draftId!==run.draftId||result.sourceSha256!==r.contextSha256||listingFingerprint(context)!==r.contextSha256||result.output.kind!=='image-plan'||result.output.productUnderstanding?.sufficient!==false||(context.slot?.index??0)!==r.slot||r.stage!=='planning'||!(run.setPlanResultId===result.id||run.planResultIds.includes(result.id)||r.slot===0&&!!run.imageContext&&listingFingerprint(run.imageContext)===r.contextSha256&&call!.presentationContext?.workflowId===run.id))invalid();
 }else {const p=call!.presentationContext;
  if(r.stage==='planning'){
   const frozen=r.slot===0?run.contextSha256:run.slots?.find(slot=>slot.index===r.slot)?.contextSha256;
   if(!frozen||frozen!==r.contextSha256||p?.workflowId!==run.id)invalid();
   if(r.slot===0&&run.imageContext&&listingFingerprint(run.imageContext)!==frozen)invalid();
  }else{
   const operationId=run.contentPreparation?.operationId,operation=operationId?getCompletion?.(operationId):undefined;
   const round=operation?.rounds.find(round=>[round.candidate,round.review].some(entry=>entry?.id===r.callId&&entry.sent&&!entry.resultId));
   if(!operation||operation.id!==operationId||operation.draftId!==run.draftId||operation.safetyIdentity.productId!==run.productId||operation.safetyIdentity.productRevision!==run.productRevision||operation.safetyIdentity.variantId!==run.variantId||operation.safetyIdentity.sku!==run.sku||!round||round.contextHash!==r.contextSha256||listingFingerprint(round.context)!==r.contextSha256)invalid();
  }
  if(call!.status!=='FAILED'||call!.errorCode!=='OUTPUT_INVALID'||call!.rejection?.code!==r.code||!p||p.draftId!==run.draftId||p.variantId!==run.variantId||p.sourceSha256!==r.contextSha256||p.slot!==r.slot||(p.kind==='image'?'planning':'content')!==r.stage)invalid();
 }
}

export function readCompletionForRejection(db:DatabaseSync,id:string):CompletionOperation|undefined{
 const row=db.prepare('SELECT record_json FROM listing_completion_operations WHERE id=?').get(id);
 return row?validateCompletionOperation(JSON.parse(String(row.record_json))):undefined;
}
