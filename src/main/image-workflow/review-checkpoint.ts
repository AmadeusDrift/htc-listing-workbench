import type {ImageReviewRequest,ImageWorkflowRun} from '../../shared/image-workflow-contracts.ts';
import {boundedText,date,integer,keys,modelFor,providerId,sha256,uuid} from '../ai/primitives.ts';
import {validateCandidateImageIdentity} from '../ai/image-validation.ts';
import {validatePurposeSnapshot} from '../ai/purpose-routing.ts';
import {UserFacingError} from '../../shared/errors.ts';
const invalid=():never=>{throw new UserFacingError('图片审核原请求身份或所属图位不一致，已保留候选与费用');};
function plain(raw:unknown):void {
 if(!raw||typeof raw!=='object'||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).some(k=>typeof k!=='string')||Object.values(Object.getOwnPropertyDescriptors(raw)).some(d=>!('value'in d)))invalid();
}
export function validateImageReviewRequest(raw:unknown):ImageReviewRequest {
 plain(raw);const r=keys(raw,['version','requestId','step','runId','draftId','productId','productRevision','variantId','sku','slot','attempt','generationRequestId','candidate','planResultId','ocrResultId','contextSha256','requestFingerprint','execution','reservedAt','state','resultId']);
 if(r.version!==1||!['risk','ocr','text'].includes(String(r.step))||!['SENT_UNKNOWN','RESULT_STORED'].includes(String(r.state)))invalid();
 plain(r.candidate);plain(r.execution);const e=keys(r.execution,['providerId','model','generation','purposeSnapshot']),id=providerId(e.providerId),purpose=e.purposeSnapshot===null?null:validatePurposeSnapshot(e.purposeSnapshot);
 if(r.step==='risk'&&(id!=='aliyun-image-risk'||purpose)||r.step==='ocr'&&(id!=='aliyun-ocr'||purpose)||r.step==='text'&&(!['deepseek-review','openrouter-review'].includes(id)||purpose?.purposeId!=='image_text_review'))invalid();
 if(purpose&&(purpose.model!==e.model||purpose.gateway!==(id==='openrouter-review'?'openrouter':'deepseek')))invalid();
 const resultId=r.resultId===null?null:uuid(r.resultId),ocrResultId=r.ocrResultId===null?null:uuid(r.ocrResultId);
 if((r.state==='RESULT_STORED')!==!!resultId||(r.step==='text')!==!!ocrResultId)invalid();
 return {version:1,requestId:uuid(r.requestId),step:r.step as ImageReviewRequest['step'],runId:uuid(r.runId),draftId:uuid(r.draftId),productId:uuid(r.productId),productRevision:integer(r.productRevision,1,Number.MAX_SAFE_INTEGER),variantId:uuid(r.variantId),sku:boundedText(r.sku,100),slot:integer(r.slot,0,7),attempt:integer(r.attempt,1,Number.MAX_SAFE_INTEGER),generationRequestId:uuid(r.generationRequestId),candidate:validateCandidateImageIdentity(r.candidate),planResultId:uuid(r.planResultId),ocrResultId,contextSha256:sha256(r.contextSha256),requestFingerprint:sha256(r.requestFingerprint),execution:{providerId:id,model:modelFor(id,e.model),generation:integer(e.generation,1,Number.MAX_SAFE_INTEGER-1),purposeSnapshot:purpose},reservedAt:date(r.reservedAt),state:r.state as ImageReviewRequest['state'],resultId};
}
/** Context/slot identity is checked independently of whether a result passed review. */
export function validateImageReviewRequests(raw:unknown,run:ImageWorkflowRun):ImageReviewRequest[] {
 if(!Array.isArray(raw))invalid();const requests=(raw as unknown[]).map(validateImageReviewRequest);
 if(new Set(requests.map(r=>r.requestId)).size!==requests.length)invalid();
 for(const r of requests){
  if(r.runId!==run.id||r.draftId!==run.draftId||r.productId!==run.productId||r.productRevision!==run.productRevision||r.variantId!==run.variantId||r.sku!==run.sku||r.reservedAt<run.createdAt||r.reservedAt>run.updatedAt)invalid();
  if(run.slots){const slot=run.slots[r.slot-1],attempt=slot?.attempts[r.attempt-1];if(!slot||!attempt||attempt.requestId!==r.generationRequestId||attempt.candidateId!==r.candidate.id||attempt.planResultId!==r.planResultId||slot.contextSha256!==r.contextSha256||r.step==='text'&&attempt.ocrResultId!==r.ocrResultId)invalid();}
  else if(r.slot!==0||run.candidateIds[r.attempt-1]!==r.candidate.id||run.planResultIds[r.attempt-1]!==r.planResultId||run.contextSha256!==r.contextSha256||r.generationRequestId!==r.candidate.id||r.step==='text'&&run.ocrResultIds[r.attempt-1]!==r.ocrResultId)invalid();
 }
 return requests;
}
