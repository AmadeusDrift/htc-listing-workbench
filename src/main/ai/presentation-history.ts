import { listingFingerprint } from "../json-fingerprint.ts";
import {validateStoredAiResult} from './validation.ts';
import { resultHasOwner } from './result-owner.ts';
import type { AiCall,AiResult } from '../../shared/ai-contracts.ts';
import { AiError } from './errors.ts';
import type { DatabaseSync } from 'node:sqlite';
import { CompletionJournal } from '../listing-ai/completion-journal.ts';
import { readFieldGroup } from './field-purpose-groups.ts';
export function assertPresentationResultOwner(result:AiResult,call:AiCall|undefined,database?:DatabaseSync):void{
 if(result.fieldGroupAssembly){
   if(!database||!resultHasOwner(result,call))throw new AiError('INVALID_CONFIG');
   for(const original of result.fieldGroupAssembly.sources){
     const row=database.prepare('SELECT record_json FROM ai_results WHERE id=?').get(original.id),owner=database.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(original.callId);
     if(!row||!owner||listingFingerprint(JSON.parse(String(row.record_json)))!==listingFingerprint(original))throw new AiError('INVALID_CONFIG');
     assertPresentationResultOwner(original,JSON.parse(String(owner.record_json)),database);
     if(!resultHasOwner(original,JSON.parse(String(owner.record_json))))throw new AiError('INVALID_CONFIG');
   }
 }
 if(result.fieldCandidateRecovery){
  if(!database||!resultHasOwner(result,call))throw new AiError('INVALID_CONFIG');
  const original=validateStoredAiResult(result.fieldCandidateRecovery.originalResult),row=database.prepare('SELECT record_json FROM ai_results WHERE id=?').get(original.id);
  if(!row||listingFingerprint(JSON.parse(String(row.record_json)))!==result.fieldCandidateRecovery.originalSha256)throw new AiError('INVALID_CONFIG');
  assertPresentationResultOwner(original,call,database);return;
 }
 if(result.localRecovery){
  if(!database||!resultHasOwner(result,call))throw new AiError('INVALID_CONFIG');
  if(result.fieldGroupPart){
    const group=readFieldGroup(database,result.localRecovery.operationId);
    if(!group||group.contextHash!==result.sourceSha256||!group.members.some(m=>m.callId===result.callId&&m.resultId===result.id))throw new AiError('INVALID_CONFIG');
  }else{
  const operation=new CompletionJournal(database).get(result.localRecovery.operationId);
  // Retention and older-backup guards clear reusable references, but keep the
  // original call/context identity. This permits history reads, never replay.
  if(!operation.rounds.some(round=>round.contextHash===result.sourceSha256&&round.candidate.id===result.callId&&(round.candidate.resultId===result.id||operation.state==='GUARD'&&round.candidate.resultId===null)))throw new AiError('INVALID_CONFIG');
  }
 }
 if(!result.fieldRejections&&!call?.presentationContext)return;
 const context=result.listingContext??result.imageContext?.listing,p=call?.presentationContext;
 if(!call||!p||!context||call.id!==result.callId||!resultHasOwner(result,call)||call.productId!==result.productId||call.productRevision!==result.productRevision||call.providerId!==result.providerId||call.model!==result.model||p.draftId!==context.draftId||p.variantId!==result.variantId||p.sourceSha256!==result.sourceSha256||p.kind!==(result.imageContext?'image':'listing')||p.slot!==(result.imageContext?.slot?.index??0))throw new AiError('INVALID_CONFIG');
}
