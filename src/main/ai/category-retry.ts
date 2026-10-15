import {validCategoryDecisionAnswers} from './category-decision-receipt.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {AiCall} from '../../shared/ai-contracts.ts';
import {readCallReceiptSync} from './receipts.ts';
import {openRouterReceiptState} from './adapters/openrouter-http.ts';
import {validateCategoryDecision} from './category-adapter.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {canRetryConsistencyAuthentication} from '../source-image-consistency/history.ts';
import {canRetryConfirmedForbidden} from './confirmed-forbidden-retry.ts';
import {categoryCandidateSnapshot} from './category-context.ts';
import type {ProductTypeOption} from '../../shared/amazon-contracts.ts';

export type CategoryFailureKind='UNKNOWN'|'VALID_OUTPUT'|'INVALID_OUTPUT'|'REJECTION'|'AUTHENTICATION'|'FORBIDDEN';
/** Request knowledge only. Permission, cumulative budgets and a once-only claim are separate. */
export function categoryFailureKind(db:DatabaseSync,directory:string,call:AiCall,identity?:{candidates:ProductTypeOption[];requestSha256:string}):CategoryFailureKind {
 if(call.status!=='FAILED'||!call.categoryContext)return 'UNKNOWN';const saved=readCallReceiptSync(db,directory,call);if(!saved||listingFingerprint((saved.capture as unknown as {purpose:unknown}).purpose??null)!==listingFingerprint(call.purposeSnapshot??null))return 'UNKNOWN';
 const {record,capture}=saved,body=capture.body as any,state=openRouterReceiptState(record.status,body);if(state==='unknown')return 'UNKNOWN';
 if(record.status<200||record.status>=300){if(state!=='rejected')return 'UNKNOWN';return record.status===401||record.gateway==='deepseek'&&record.status===403?'AUTHENTICATION':record.status===403?'FORBIDDEN':'REJECTION';}
 if(call.errorCode!=='OUTPUT_INVALID')return 'UNKNOWN';if(state==='invalid')return 'INVALID_OUTPUT';
 try{
  if(record.endpoint==='/api/alpha/decisions'){
   if(!validCategoryDecisionAnswers(body?.answers))return 'INVALID_OUTPUT';
   const choice=body.answers.category.choice;
   const sameCandidates=identity&&(call.categoryContext.version===2?call.categoryContext.candidateSnapshotSha256===categoryCandidateSnapshot(identity.candidates):call.categoryContext.requestSha256===identity.requestSha256);
   return sameCandidates&&choice!=='$NO_SUITABLE'&&!identity.candidates.some(candidate=>candidate.name===choice)?'INVALID_OUTPUT':'VALID_OUTPUT';
  }
  if(!Array.isArray(body?.choices)||body.choices.length!==1||body.choices[0]?.finish_reason!=='stop'||body.choices[0]?.message?.refusal||body.choices[0]?.message?.tool_calls?.length||typeof body.choices[0]?.message?.content!=='string')return 'INVALID_OUTPUT';
  const output=validateCategoryDecision(JSON.parse(body.choices[0].message.content));if(output.phase!==call.categoryContext.phase)return 'INVALID_OUTPUT';
  if(call.categoryContext.version===2&&output.selection&&output.selection.candidateSnapshotSha256!==call.categoryContext.candidateSnapshotSha256)return 'INVALID_OUTPUT';
  const sameCandidates=identity&&(call.categoryContext.version===2?call.categoryContext.candidateSnapshotSha256===categoryCandidateSnapshot(identity.candidates):call.categoryContext.requestSha256===identity.requestSha256);
  return sameCandidates&&output.productType&&!identity.candidates.some(candidate=>candidate.name===output.productType)?'INVALID_OUTPUT':'VALID_OUTPUT';
 }catch{return 'INVALID_OUTPUT';}
}
export function categoryAuthenticationAllowed(db:DatabaseSync,prior:AiCall,current:{providerId:string;generation:number},scopeKey:string):boolean {
 if(current.providerId!==prior.providerId)return false;
 return canRetryConfirmedForbidden(db,prior,scopeKey)||canRetryConsistencyAuthentication(db,prior,current);
}
