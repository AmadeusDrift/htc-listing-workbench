import {verifiedRecoveryReceipt} from '../ai/receipt-recovery.ts';
import {imageReviewProvenNotSent} from './review-journal.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {AiCall} from '../../shared/ai-contracts.ts';
import type {ImageWorkflowRun} from '../../shared/image-workflow-contracts.ts';
import {AiError} from '../ai/errors.ts';
import {localAiRequestResolved} from '../ai/request-certainty.ts';

type ReviewStep='risk'|'ocr'|'text'|'appearance';
interface PendingReview {callId?:string;workflowId?:string;slot?:number;step:ReviewStep}
/** Original request identity only; an absent legacy field is never fabricated. */
export class ImageReviewPendingError extends AiError {
 readonly workflowId?:string;readonly slot?:number;readonly step:ReviewStep;
 constructor(pending:PendingReview){super('INTERRUPTED');this.diagnosticReason=pending.callId?'IMAGE_REVIEW_RESULT_UNKNOWN':'IMAGE_REVIEW_IDENTITY_MISSING';if(pending.callId)this.certainty='SENT_UNKNOWN';this.callId=pending.callId;this.workflowId=pending.workflowId;this.slot=pending.slot;this.step=pending.step;this.message=pending.callId?'原图片审核结果尚未确认；已保留原工作流、候选和费用，未复用旧审批或重新发送':'历史图片审核缺少原请求身份，无法证明未发送；原工作流和候选待核，未复用旧审批或重新发送';}
}
function reviewStep(call:AiCall):ReviewStep|undefined {
 if(call.providerId==='aliyun-image-risk')return 'risk';
 if(call.providerId==='aliyun-ocr'&&call.presentationContext?.kind==='image')return 'ocr';
 if(call.requestScope?.operation==='image-text-review'||call.purposeSnapshot?.purposeId==='image_text_review'&&call.presentationContext?.kind==='image')return 'text';
 if(call.requestScope?.operation==='image-appearance-review'||call.purposeSnapshot?.purposeId.startsWith('appearance_review')&&call.presentationContext?.kind==='image')return 'appearance';
}
/** M07 determines request certainty from its original call/result/strict receipt.
 * This image-owner query performs no writes, settlement, recovery or permission claim. */
export function assertApprovalReviewsResolved(db:DatabaseSync,directory:string,anchor:ImageWorkflowRun,runs:readonly ImageWorkflowRun[],calls:readonly AiCall[]|undefined,recoveryRunId?:string):void {
 const owned=runs.filter(run=>run.draftId===anchor.draftId&&run.productId===anchor.productId&&run.variantId===anchor.variantId&&run.sku===anchor.sku);
 const relevant=(calls??[]).filter(call=>{
  if(!reviewStep(call)||call.productId!==anchor.productId)return false;
  const p=call.presentationContext,s=call.requestScope,variants=[p?.variantId,s?.variantId].filter(Boolean);
  return (!p||p.kind==='image'&&p.draftId===anchor.draftId)&&(!s?.draftId||s.draftId===anchor.draftId)&&(!variants.length||variants.includes(anchor.variantId));
 });
 for(const call of relevant){
  if(localAiRequestResolved(db,directory,call.id,call))continue;
  const originalRecovery=owned.find(r=>r.id===recoveryRunId)?.reviewRequests?.find(r=>r.version===2&&r.requestId===call.id&&r.state==='SENT_UNKNOWN');
  if(originalRecovery&&verifiedRecoveryReceipt(db,directory,call))continue;
  const p=call.presentationContext,s=call.requestScope,scopeSlot=s?.slot??(p?.slot===0?0:undefined),slot=p?.slot===scopeSlot?p?.slot:undefined;
  // Exact context and candidate evidence establish ownership; time is only an additional bound.
  const matches=owned.filter(run=>{
   if(!p||!s||s.sku!==run.sku||p.variantId!==run.variantId||s.variantId!==run.variantId||slot===undefined||call.productRevision!==run.productRevision||call.startedAt<run.createdAt||s.targetId!==run.imageContext?.listing.targetId||s.marketplaceId!==run.imageContext?.listing.marketplaceId)return false;
   const image=run.slots?.[slot-1],attempt=image?.attempts.at(-1),source=owned.find(source=>source.id===run.recheckedFromRunId),approved=source?.slots?.[slot-1];
   const candidateId=attempt?.candidateId,hash=image?.approvedSha256??(approved?.attempts.at(-1)?.candidateId===candidateId?approved?.approvedSha256:null);
   return !!candidateId&&!!hash&&p.sourceSha256===image?.contextSha256&&s.candidateSha256===hash;
  });
  throw new ImageReviewPendingError({callId:call.id,...(matches.length===1?{workflowId:matches[0].id}:{}),...(slot===undefined?{}:{slot}),step:reviewStep(call)!});
 }
 // A historical review checkpoint without a recorded request cannot prove NOT_SENT.
 for(const run of owned){
  if(!run.recheckedFromRunId||!['FAILED','INTERRUPTED','CANCELLED'].includes(run.status))continue;
  const slot=run.slots?.find(slot=>slot.index===run.activeSlot),attempt=slot?.attempts.at(-1);
  const step:ReviewStep|undefined=run.stage==='ip-check'&&!attempt?.ipReviewResultId?'risk':run.stage==='ocr'&&!attempt?.ocrResultId?'ocr':run.stage==='reviewing'&&attempt?.appearanceReview?.state==='PENDING'?'appearance':run.stage==='reviewing'&&slot?.index===1&&!attempt?.reviewResultId?'text':undefined;
  if(!step||!slot||!attempt?.candidateId)continue;
  const prepared=run.reviewRequests?.findLast(r=>r.version===2&&r.step===step&&r.slot===slot.index&&r.attempt===attempt.number&&r.candidate.id===attempt.candidateId&&r.contextSha256===slot.contextSha256);
  if(prepared&&imageReviewProvenNotSent(db,prepared))continue;
  if(!relevant.some(call=>reviewStep(call)===step&&call.presentationContext?.sourceSha256===slot.contextSha256&&call.presentationContext.slot===slot.index&&call.startedAt>=run.createdAt))throw new ImageReviewPendingError({workflowId:run.id,slot:slot.index,step});
 }
}
