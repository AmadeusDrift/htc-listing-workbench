import { linkLegacyPreparation } from '../image-workflow/completion-link.ts';
import { isGenerationProvider } from "../ai/primitives.ts";
import { isFullSchema } from "./native-values.ts";
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {AmazonDraft} from '../../shared/amazon-contracts.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {validateAiCall,validateStoredAiResult} from '../ai/validation.ts';
import {resultHasOwner} from '../ai/result-owner.ts';
import {validateAiUsageRecord} from '../ai/usage.ts';
import { listingFingerprint } from "../json-fingerprint.ts";
import type {CompletionOperation,CompletionRound} from './completion-journal.ts';

export interface LegacyCompletionHistory { checkpointIds:string[]; callIds:string[]; resultIds:string[]; adoptionIds:string[]; priorRounds:number; missingAttemptDebt:number; stepDebts?:{contextHash:string;kind:'candidate'|'review';callIds:string[]}[] }
export function legacyCompletionOwners(db:DatabaseSync,draftId:string){
  return db.prepare("SELECT id,record_json FROM image_workflow_runs WHERE json_extract(record_json,'$.draftId')=? AND json_extract(record_json,'$.contentPreparation.state')='STARTED' AND json_type(record_json,'$.contentPreparation.operationId') IS NULL").all(draftId).map(row=>({id:String(row.id),recordJson:String(row.record_json),record:JSON.parse(String(row.record_json))}));
}
/** Only persisted field outputs and exact adoption receipts prove a completed step. */
export function recoverLegacyCompletion(db:DatabaseSync,operation:CompletionOperation,draft:AmazonDraft,legacyScopeHash?:()=>string):CompletionOperation {
  const owners=legacyCompletionOwners(db,draft.id);if(!owners.length)return operation;
  const invalid=():never=>{throw new UserFacingError('旧字段请求恢复证据不完整，原调用与费用记录已保留');};
  const results=db.prepare("SELECT record_json FROM ai_results WHERE json_extract(record_json,'$.listingContext.draftId')=? ORDER BY json_extract(record_json,'$.createdAt'),id").all(draft.id).map(row=>JSON.parse(String(row.record_json))).filter(raw=>!raw.fieldCandidateRecovery).map(validateStoredAiResult);
  for(const result of results){
    const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(result.callId),usage=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(result.callId);
    if(!row||!usage)invalid();const call=validateAiCall(JSON.parse(String(row!.record_json))),ledger=validateAiUsageRecord(JSON.parse(String(usage!.record_json)));
    if(!resultHasOwner(result,call)||call.productId!==draft.productId||call.productRevision!==draft.productRevision||result.variantId!==draft.variantId||call.model!==result.model||ledger.id!==call.id||ledger.providerId!==call.providerId||ledger.startedAt!==call.startedAt||!result.listingContext||listingFingerprint(result.listingContext)!==result.sourceSha256)invalid();
  }
  const candidates=results.filter(result=>result.output.kind==='amazon-fields'),selected=candidates.slice(-2),rounds:CompletionRound[]=[];
  for(const result of selected){
    const reviews=results.filter(review=>review.output.kind==='amazon-fields-review'&&review.sourceResultIds[0]===result.id&&review.sourceSha256===result.sourceSha256);
    if(reviews.length>1)invalid();const review=reviews[0],adoption=draft.fieldAdoptions?.find(a=>a.suggestionResultId===result.id);
    if(adoption&&(adoption.contextSha256!==result.sourceSha256||adoption.fromRevision!==result.listingContext!.draftRevision||adoption.toRevision!==adoption.fromRevision+1||adoption.toRevision>draft.revision||adoption.reviewResultId!==(review?.id??null)))invalid();
    const resolved=!!adoption||result!==selected.at(-1);
    rounds.push({context:result.listingContext!,contextHash:result.sourceSha256!,candidate:{id:result.callId,sent:true,resultId:result.id},review:operation.copyReviewEnabled?review?{id:review.callId,sent:true,resultId:review.id}:{id:randomUUID(),sent:false,resultId:null}:null,resolved,adoptionId:adoption?.id??null});
    // Disabled review policy cannot erase an old review-based adoption proof.
    if(adoption?.reviewResultId&&!operation.copyReviewEnabled)invalid();
  }
  const bound=db.prepare("SELECT record_json FROM ai_calls WHERE json_extract(record_json,'$.presentationContext.kind')='listing' AND json_extract(record_json,'$.presentationContext.draftId')=?").all(draft.id).map(row=>validateAiCall(JSON.parse(String(row.record_json))));
  for(const call of bound){const row=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(call.id);if(!row)invalid();const usage=validateAiUsageRecord(JSON.parse(String(row!.record_json)));if(call.productId!==draft.productId||call.productRevision!==draft.productRevision||call.presentationContext?.variantId!==draft.variantId||usage.id!==call.id||usage.providerId!==call.providerId||usage.startedAt!==call.startedAt)invalid();}
  if(bound.some(call=>call.status==='RUNNING'))invalid();
  const missing=bound.filter(call=>!results.some(result=>result.callId===call.id));
  // A received invalid response must use its frozen response recovery, never a blind resend.
  if(missing.some(call=>call.responseReceived||call.rejection||call.errorCode==='OUTPUT_INVALID'))invalid();
  if(rounds.length&&rounds.some(round=>!isFullSchema(round.context))){if(!legacyScopeHash||rounds.some(round=>isFullSchema(round.context)))invalid();operation.scopeHash=legacyScopeHash!();}
  operation.rounds=rounds;
  const stepDebts:NonNullable<LegacyCompletionHistory['stepDebts']>=[];
  for(const call of missing){
    if(!['deepseek','deepseek-review'].includes(call.providerId))invalid();
    const contextHash=call.presentationContext!.sourceSha256,kind=isGenerationProvider(call.providerId)?'candidate':'review';
    let step=stepDebts.find(step=>step.contextHash===contextHash&&step.kind===kind);
    if(!step){step={contextHash,kind,callIds:[]};stepDebts.push(step);}step.callIds.push(call.id);
  }
  operation.legacyRecovery={checkpointIds:owners.map(owner=>owner.id),callIds:[...new Set([...results.map(result=>result.callId),...bound.map(call=>call.id)])],resultIds:results.map(result=>result.id),adoptionIds:(draft.fieldAdoptions??[]).map(a=>a.id),priorRounds:Math.max(0,candidates.length-selected.length),missingAttemptDebt:!results.length&&!missing.length?1:0,stepDebts};
  return operation;
}
export function linkLegacyCompletionOwners(db:DatabaseSync,draftId:string,operationId:string):void {
  for(const owner of legacyCompletionOwners(db,draftId)){linkLegacyPreparation(db,{id:owner.id,draftId,operationId,expectedJson:owner.recordJson});}
}

/** The provider identity and frozen hash keep review/candidate and later rounds separate. */
export function legacyStepDebt(op:CompletionOperation,round:CompletionRound,kind:'candidate'|'review'):number {
  const legacy=op.legacyRecovery;if(!legacy)return 0;
  const bound=legacy.stepDebts?.find(step=>step.contextHash===round.contextHash&&step.kind===kind)?.callIds.length??0;
  return bound+(kind==='candidate'&&round===op.rounds[0]?legacy.missingAttemptDebt:0);
}
