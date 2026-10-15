import {readImageReviewLedger,writeImageReviewLedger} from './review-ledger.ts';
import {imageCopySourceIds} from '../../shared/image-ai-contracts.ts';
import {localAiRequestResolved,aliyunFinalOutcome} from '../ai/request-certainty.ts';
import {readCallReceiptSync} from '../ai/receipts.ts';
import type {DatabaseSync} from 'node:sqlite';
import {realpathSync} from 'node:fs';
import type {ImageReviewRequest,ImageReviewRequestV2,ImageWorkflowRun} from '../../shared/image-workflow-contracts.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {validateAiCall,validateStoredAiResult} from '../ai/validation.ts';
import type {AiCall,AiResult} from '../../shared/ai-contracts.ts';
import {resultHasOwner} from '../ai/result-owner.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {validateStoredImageWorkflowRun} from './records.ts';
import {validateImageReviewRequest,validateImageReviewRequests} from './review-checkpoint.ts';

/** Borrow the actual M07 reservation transaction, never begin a second owner transaction. */
function assertBorrowedTransaction(owner:DatabaseSync,borrowed:DatabaseSync):void {
 if(!borrowed.isTransaction)throw new UserFacingError('图片审核预约必须处于当前发送事务');
 if(owner===borrowed)return;
 const file=(db:DatabaseSync)=>String(db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file??'');
 const a=file(owner),b=file(borrowed);
 if(!a||!b||realpathSync.native(a)!==realpathSync.native(b))throw new UserFacingError('图片审核写入连接不属于当前工作区；内存连接不能按空路径借用');
}
/** Called only after M07 inserted the RUNNING call in its still-open reservation transaction. */
export function reserveImageReviewRequest(owner:DatabaseSync,borrowed:DatabaseSync,raw:unknown):void {
 assertBorrowedTransaction(owner,borrowed);const request=validateImageReviewRequest(raw);
 if(request.state!=='SENT_UNKNOWN'||request.resultId!==null)throw new UserFacingError('新图片审核不能伪造已存结果');
 const callRow=borrowed.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(request.requestId);
 if(!callRow)throw new UserFacingError('图片审核缺少同事务原调用');
 const call=validateAiCall(JSON.parse(String(callRow.record_json))),p=call.presentationContext,s=call.requestScope,operation={risk:'image-ip-review',ocr:'generated-image-ocr',text:'image-text-review'}[request.step];
 // Historical single-image scopes omitted slot; only their original slot 0 is compatible.
 if(s&&(s.slot??0)!==request.slot)throw new UserFacingError('图片审核原调用与图位输入不一致');
 if(call.id!==request.requestId||call.status!=='RUNNING'||call.productId!==request.productId||call.productRevision!==request.productRevision||call.providerId!==request.execution.providerId||call.model!==request.execution.model||call.generation!==request.execution.generation||call.startedAt!==request.reservedAt||call.requestFingerprint!==request.requestFingerprint||listingFingerprint(call.purposeSnapshot??null)!==listingFingerprint(request.execution.purposeSnapshot)||!p||p.kind!=='image'||p.draftId!==request.draftId||p.variantId!==request.variantId||p.slot!==request.slot||p.sourceSha256!==request.contextSha256||!s||s.operation!==operation||s.productId!==request.productId||s.variantId!==request.variantId||s.sku!==request.sku||s.candidateSha256!==request.candidate.sha256)throw new UserFacingError('图片审核原调用与图位输入不一致');
 const row=borrowed.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(request.runId);
 if(!row)throw new UserFacingError('图片审核原工作流不存在');
 const previous=String(row.record_json),run=validateStoredImageWorkflowRun(JSON.parse(previous));
 if(run.reviewRequests?.some(prior=>prior.requestId===request.requestId||prior.step===request.step&&prior.slot===request.slot&&prior.attempt===request.attempt&&prior.state==='SENT_UNKNOWN'))throw new UserFacingError('原图片审核请求仍受保护，未重复预约');
 run.updatedAt=[run.updatedAt,request.reservedAt].sort().at(-1)!;
 run.reviewRequests=validateImageReviewRequests([...(run.reviewRequests??[]),request],run);
 const valid=validateStoredImageWorkflowRun(run);
 const saved=borrowed.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=? AND record_json=?').run(JSON.stringify(valid),valid.id,previous);
 if(saved.changes!==1)throw new UserFacingError('图片审核原工作流已变化，未预约发送');
}

/** Safe identity projection; it neither grants a new request nor settles a fee. */
export function pendingImageReviewRequests(requests:readonly ImageReviewRequest[]|undefined):ImageReviewRequest[]{
 return (requests??[]).map(validateImageReviewRequest).filter(request=>request.state==='SENT_UNKNOWN');
}

function writeReviewRun(db:DatabaseSync,run:ImageWorkflowRun,previous:string,requestId:string):void {
 for(const request of run.reviewRequests??[])if(request.version===2&&request.requestId===requestId){const ledger=readImageReviewLedger(db,request.requestId);if(!ledger)throw new UserFacingError('原图片审核安全账缺失，未发送');const callRow=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(request.requestId),resultRow=request.resultId?db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(request.resultId):null;writeImageReviewLedger(db,{...ledger,request,call:callRow?validateAiCall(JSON.parse(String(callRow.record_json))):ledger.call,result:resultRow?validateStoredAiResult(JSON.parse(String(resultRow.record_json))):ledger.result});}
 const valid=validateStoredImageWorkflowRun(run);
 const saved=db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=? AND record_json=?').run(JSON.stringify(valid),valid.id,previous);
 if(saved.changes!==1)throw new UserFacingError('图片审核原工作流已变化，未发送新请求');
}
function readReview(db:DatabaseSync,runId:string,requestId:string){
 const row=db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(runId);if(!row)throw new UserFacingError('图片审核原工作流不存在');
 const previous=String(row.record_json),run=validateStoredImageWorkflowRun(JSON.parse(previous)),request=run.reviewRequests?.find(r=>r.requestId===requestId);
 if(!request||request.version!==2)throw new UserFacingError('图片审核缺少生产端持久化原身份');return {previous,run,request};
}
function callMatches(request:ImageReviewRequestV2,call:AiCall):boolean {
 const p=call.presentationContext,s=call.requestScope;
 return call.id===request.requestId&&call.productId===request.productId&&call.productRevision===request.productRevision&&call.providerId===request.execution.providerId&&call.model===request.execution.model&&call.generation===request.execution.generation&&listingFingerprint(call.purposeSnapshot??null)===listingFingerprint(request.execution.purposeSnapshot)&&!!p&&p.kind==='image'&&p.draftId===request.draftId&&p.variantId===request.variantId&&p.slot===request.slot&&p.sourceSha256===request.contextSha256&&!!s&&(s.slot??0)===request.slot&&s.operation===({risk:'image-ip-review',ocr:'generated-image-ocr',text:'image-text-review'}[request.step])&&s.variantId===request.variantId&&s.sku===request.sku&&s.candidateSha256===request.candidate.sha256;
}
/** Producer-v2 first effect permit and the AiCall/usage hold commit together. */
export function reservePreparedImageReview(owner:DatabaseSync,borrowed:DatabaseSync,runId:string,call:AiCall):void {
 assertBorrowedTransaction(owner,borrowed);const {previous,run,request}=readReview(borrowed,runId,call.id);
 const original=borrowed.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id),usage=borrowed.prepare('SELECT id FROM ai_usage_ledger WHERE id=?').get(call.id);
 if(!original||!usage||JSON.stringify(validateAiCall(JSON.parse(String(original.record_json))))!==JSON.stringify(call)||request.state!=='PREPARED'||!callMatches(request,call)||!call.requestFingerprint||call.startedAt<request.preparedAt)throw new UserFacingError('图片审核预发送身份不一致');
 if(run.reviewRequests?.some(r=>r.requestId!==request.requestId&&r.slot===request.slot&&r.attempt===request.attempt&&r.step===request.step&&r.state==='SENT_UNKNOWN'))throw new UserFacingError('原图片审核请求仍受保护');
 request.state='SENT_UNKNOWN';request.reservedAt=call.startedAt;request.requestFingerprint=call.requestFingerprint;request.effects[0]={...request.effects[0],state:'PERMITTED',permittedAt:call.startedAt};run.updatedAt=[run.updatedAt,call.startedAt].sort().at(-1)!;writeReviewRun(borrowed,run,previous,request.requestId);
}
/** Later effects use the M07 connection, never a second images connection transaction. */
export function markImageReviewEffect(owner:DatabaseSync,borrowed:DatabaseSync,runId:string,requestId:string,kind:ImageReviewRequestV2['effects'][number]['kind'],event:'permit'|'received',at:string):void {
 assertBorrowedTransaction(owner,borrowed);const {previous,run,request}=readReview(borrowed,runId,requestId),index=request.effects.findIndex(e=>e.kind===kind),effect=request.effects[index];
 if(request.state!=='SENT_UNKNOWN'||!effect||event==='permit'&&(effect.state!=='UNPERMITTED'||request.effects.slice(0,index).some(e=>e.state!=='RECEIVED'))||event==='received'&&effect.state!=='PERMITTED')throw new UserFacingError('图片审核子请求不可重复发送或越过未决身份');
 if(event==='permit'){effect.state='PERMITTED';effect.permittedAt=at;}else{effect.state='RECEIVED';effect.receivedAt=at;}run.updatedAt=[run.updatedAt,at].sort().at(-1)!;writeReviewRun(borrowed,run,previous,request.requestId);
}
/** Link only an actual M07 result to its exact original candidate in the borrowed result TX. */
export function storeImageReviewResult(owner:DatabaseSync,borrowed:DatabaseSync,runId:string,raw:AiResult):void {
 assertBorrowedTransaction(owner,borrowed);const result=validateStoredAiResult(raw),{previous,run,request}=readReview(borrowed,runId,result.callId),row=borrowed.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(result.callId),stored=borrowed.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id);
 const call=row?validateAiCall(JSON.parse(String(row.record_json))):null,output=result.output;
 if(!stored||String(stored.record_json)!==JSON.stringify(result)||!call||!callMatches(request,call)||!resultHasOwner(result,call)||request.requestFingerprint!==call.requestFingerprint||!result.imageContext||listingFingerprint(result.imageContext)!==request.contextSha256||listingFingerprint(result.sourceResultIds)!==listingFingerprint([...imageCopySourceIds(result.imageContext),...(request.step==='risk'?[request.planResultId]:request.step==='text'?[request.planResultId,request.ocrResultId!]:[])])||result.sourceSha256!==request.contextSha256||request.state==='PREPARED'||request.resultId!==null&&request.resultId!==result.id||!['image-ip-review','generated-image-ocr','image-text-review'].includes(output.kind)||!('candidate'in output)||listingFingerprint(output.candidate)!==listingFingerprint(request.candidate)||request.step==='risk'&&(output.kind!=='image-ip-review'||output.planResultId!==request.planResultId)||request.step==='ocr'&&output.kind!=='generated-image-ocr'||request.step==='text'&&(output.kind!=='image-text-review'||output.planResultId!==request.planResultId||output.ocrResultId!==request.ocrResultId))throw new UserFacingError('图片审核原结果与候选关联不一致');
 request.state='RESULT_STORED';request.resultId=result.id;const last=request.effects.at(-1)!;if(last.state==='PERMITTED'){last.state='RECEIVED';last.receivedAt=result.createdAt;}
 const singular=request.step==='risk'?'ipReviewResultId':request.step==='ocr'?'ocrResultId':'reviewResultId',plural=request.step==='risk'?'ipReviewResultIds':request.step==='ocr'?'ocrResultIds':'reviewResultIds';
 if(run.slots){const attempt=run.slots[request.slot-1].attempts[request.attempt-1];if(attempt[singular]&&attempt[singular]!==result.id)throw new UserFacingError('图片审核已关联其他原结果');attempt[singular]=result.id;run[plural]=[...new Set(run.slots.flatMap(s=>s.attempts.flatMap(a=>a[singular]?[a[singular]!]:[])))];}
 else{const ids=run[plural]??[];if(ids[request.attempt-1]&&ids[request.attempt-1]!==result.id)throw new UserFacingError('旧单图审核已关联其他原结果');if(ids.length<request.attempt-1)throw new UserFacingError('旧单图审核缺少原结果前缀');ids[request.attempt-1]=result.id;run[plural]=ids;}
 run.updatedAt=[run.updatedAt,result.createdAt].sort().at(-1)!;writeReviewRun(borrowed,run,previous,request.requestId);
}
/** Absence proves nothing for legacy. V2 producer intent proves no grant only with no call/hold. */
export function imageReviewProvenNotSent(db:DatabaseSync,request:ImageReviewRequest):boolean {
 const ledger=readImageReviewLedger(db,request.requestId);
 return ledger!==null&&listingFingerprint(ledger.request)===listingFingerprint(request)&&request.version===2&&request.state==='PREPARED'&&request.effects.every(e=>e.state==='UNPERMITTED')&&!db.prepare('SELECT id FROM ai_calls WHERE id=?').get(request.requestId)&&!db.prepare('SELECT id FROM ai_usage_ledger WHERE id=?').get(request.requestId);
}

/** Persist a verified known outcome separately from unknown cost; never grants a successor. */
export function projectImageReviewOutcome(owner:DatabaseSync,borrowed:DatabaseSync,directory:string,runId:string,requestId:string):void {
 assertBorrowedTransaction(owner,borrowed);const {previous,run,request}=readReview(borrowed,runId,requestId);if(request.state!=='SENT_UNKNOWN')return;
 const row=borrowed.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(requestId);if(!row)return;const call=validateAiCall(JSON.parse(String(row.record_json)));
 if(!callMatches(request,call)||call.requestFingerprint!==request.requestFingerprint||!localAiRequestResolved(borrowed,directory,call.id,call))return;
 const saved=readCallReceiptSync(borrowed,directory,call),ali=aliyunFinalOutcome(call,saved);
 if(ali==='invalid'||saved?.record.version===1&&call.status==='FAILED'&&call.errorCode==='OUTPUT_INVALID')request.state='RECEIVED_INVALID';else if(ali==='rejected'||saved?.record.version===1&&call.status==='FAILED'&&saved.record.status>=400&&saved.record.status<500)request.state='DEFINITIVE_REJECTION';else return;
 const at=call.finishedAt??call.startedAt,last=request.effects.at(-1)!;if(last.state==='PERMITTED'){last.state='RECEIVED';last.receivedAt=at;}run.updatedAt=[run.updatedAt,at].sort().at(-1)!;writeReviewRun(borrowed,run,previous,request.requestId);
}
