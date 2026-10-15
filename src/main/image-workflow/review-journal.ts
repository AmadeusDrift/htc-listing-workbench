import type {DatabaseSync} from 'node:sqlite';
import {realpathSync} from 'node:fs';
import type {ImageReviewRequest} from '../../shared/image-workflow-contracts.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {validateAiCall} from '../ai/validation.ts';
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
