import {validateAiCall} from '../ai/validation.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {AiCall} from '../../shared/ai-contracts.ts';
import type {ImageWorkflowRun} from '../../shared/image-workflow-contracts.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {readImageReviewLedger,reviewEvidenceFile} from './review-ledger.ts';
/** Retiring a dependency never resolves its original call or releases its usage hold.
 * Only producer-owned frozen evidence and the original private bytes authorize direct review. */
export function canRetireLegacyOcr(db:DatabaseSync,directory:string,run:ImageWorkflowRun,call:AiCall):boolean {
 if(run.planningUnknown||run.pendingRequest&&run.pendingRequest.step!=='ocr'||run.slots?.some(slot=>slot.attempts.some(a=>a.state==='UNKNOWN'||a.state==='GENERATING'))||run.reviewRequests?.some(r=>r.step==='text'&&r.state==='SENT_UNKNOWN'))return false;
 if(call.providerId!=='aliyun-ocr'||call.requestScope?.operation!=='generated-image-ocr')return false;
 try{call=validateAiCall(call);}catch{return false;}
 const request=run.reviewRequests?.find(r=>r.requestId===call.id),p=call.presentationContext,s=call.requestScope;
 if(!request||request.version!==2||request.step!=='ocr'||request.runId!==run.id||request.state==='RESULT_STORED'||!p||p.kind!=='image'||p.draftId!==run.draftId||p.variantId!==run.variantId||p.slot!==request.slot||p.sourceSha256!==request.contextSha256||call.productId!==run.productId||call.productRevision!==run.productRevision||call.requestFingerprint!==request.requestFingerprint||s.variantId!==run.variantId||s.sku!==run.sku||s.candidateSha256!==request.candidate.sha256)return false;
 const attempt=run.slots?.[request.slot-1]?.attempts[request.attempt-1];
 if(run.slots?(!attempt||attempt.requestId!==request.generationRequestId||attempt.candidateId!==request.candidate.id||attempt.planResultId!==request.planResultId||!['GENERATED','PASSED'].includes(attempt.state)||run.slots[request.slot-1].contextSha256!==request.contextSha256):run.candidateIds[request.attempt-1]!==request.candidate.id||run.planResultIds[request.attempt-1]!==request.planResultId||run.contextSha256!==request.contextSha256)return false;
 try{const ledger=readImageReviewLedger(db,call.id);if(!ledger||listingFingerprint(ledger.request)!==listingFingerprint(request)||!ledger.call||listingFingerprint({id:ledger.call.id,providerId:ledger.call.providerId,model:ledger.call.model,generation:ledger.call.generation,startedAt:ledger.call.startedAt,requestFingerprint:ledger.call.requestFingerprint,requestScope:ledger.call.requestScope,presentationContext:ledger.call.presentationContext})!==listingFingerprint({id:call.id,providerId:call.providerId,model:call.model,generation:call.generation,startedAt:call.startedAt,requestFingerprint:call.requestFingerprint,requestScope:call.requestScope,presentationContext:call.presentationContext})||listingFingerprint(ledger.context)!==request.contextSha256)return false;
  for(const expected of ledger.files){const actual=reviewEvidenceFile(directory,expected.path);if(listingFingerprint(actual)!==listingFingerprint(expected))return false;}
  return true;
 }catch{return false;}
}
