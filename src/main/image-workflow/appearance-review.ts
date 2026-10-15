import { writeOwnedSetting } from '../storage/settings.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {AiResult} from '../../shared/ai-contracts.ts';
import type {AiPurposeSnapshot} from '../../shared/ai-purpose-contracts.ts';
import type {AppearanceReviewCheckpoint,AppearanceReviewOutput} from '../../shared/appearance-review-contracts.ts';
import {APPEARANCE_REVIEW_POLICY_VERSION} from '../../shared/appearance-review-contracts.ts';
import type {CandidateImageIdentity} from '../../shared/image-ai-contracts.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {boundedText,keys,uuid,uuidList} from '../ai/primitives.ts';
import {validateCandidateImageIdentity} from '../ai/image-validation.ts';
import {validatePurposeSnapshot} from '../ai/purpose-routing.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
const fail=():never=>{throw new UserFacingError('外观复核依据或所属图片不完整，原图与响应已保留');};
export function validateAppearanceReview(raw:unknown):AppearanceReviewOutput{
 const v=keys(raw,['kind','candidate','planResultId','previousResultId','verdict','checks'],['policyVersion']);
 if(v.policyVersion!==undefined&&v.policyVersion!==APPEARANCE_REVIEW_POLICY_VERSION)fail();
 if(v.kind!=='image-appearance-review'||!['PASS','MISMATCH','UNCERTAIN'].includes(String(v.verdict))||!Array.isArray(v.checks)||!v.checks.length||v.checks.length>30)fail();
 const checks=(v.checks as unknown[]).map(raw=>{const c=keys(raw,['aspect','expected','observed','reason','referenceAssetIds']);if(!['identity','color','count','shape','other'].includes(String(c.aspect)))fail();const referenceAssetIds=uuidList(c.referenceAssetIds,10);if(!referenceAssetIds.length)fail();return{aspect:c.aspect as AppearanceReviewOutput['checks'][number]['aspect'],expected:boundedText(c.expected,1000),observed:boundedText(c.observed,1000),reason:boundedText(c.reason,2000),referenceAssetIds};});
 return{...(v.policyVersion===undefined?{}:{policyVersion:APPEARANCE_REVIEW_POLICY_VERSION}),kind:'image-appearance-review',candidate:validateCandidateImageIdentity(v.candidate),planResultId:uuid(v.planResultId),previousResultId:v.previousResultId===null?null:uuid(v.previousResultId),verdict:v.verdict as AppearanceReviewOutput['verdict'],checks};
}
export function validateAppearanceCheckpoint(raw:unknown):AppearanceReviewCheckpoint{
 const c=keys(raw,['state','candidate','planResultId','resultIds','snapshot'],['policyVersion','previousPolicy','basePreviousResultId']);if(!['READY','PENDING','DONE','NOT_PERFORMED'].includes(String(c.state)))fail();
 if(c.policyVersion!==undefined&&c.policyVersion!==APPEARANCE_REVIEW_POLICY_VERSION)fail();
 const resultIds=uuidList(c.resultIds,2),snapshot=c.snapshot===null?null:validatePurposeSnapshot(c.snapshot);
 if(c.state==='READY'&&resultIds.length||c.state==='PENDING'&&resultIds.length>=2||resultIds.length===2&&!snapshot?.upgrade)fail();
 if(c.state==='NOT_PERFORMED'&&(resultIds.length||snapshot)||c.state!=='NOT_PERFORMED'&&(!snapshot||!snapshot.capability.vision)||c.state==='DONE'&&!resultIds.length)fail();
 const result:AppearanceReviewCheckpoint={...(c.policyVersion===undefined?{}:{policyVersion:APPEARANCE_REVIEW_POLICY_VERSION}),state:c.state as AppearanceReviewCheckpoint['state'],candidate:validateCandidateImageIdentity(c.candidate),planResultId:uuid(c.planResultId),resultIds,snapshot};
 if(c.previousPolicy!==undefined||c.basePreviousResultId!==undefined){
  if(c.policyVersion!==APPEARANCE_REVIEW_POLICY_VERSION||c.previousPolicy===undefined||c.basePreviousResultId===undefined||c.state==='NOT_PERFORMED')fail();
  const previous=validateAppearanceCheckpoint(keys(c.previousPolicy,['state','candidate','planResultId','resultIds','snapshot'])),base=uuid(c.basePreviousResultId);
  if(previous.state!=='DONE'||previous.resultIds.at(-1)!==base||previous.planResultId!==result.planResultId||listingFingerprint(previous.candidate)!==listingFingerprint(result.candidate)||listingFingerprint(previous.snapshot)!==listingFingerprint(snapshot)||resultIds.some(id=>previous.resultIds.includes(id)))fail();
  result.previousPolicy=previous;result.basePreviousResultId=base;
 }
 return result;
}
/** One explicit policy continuation, preserving the literal old checkpoint. */
export function continueAppearancePolicy(input:{attempt:{appearanceReview?:AppearanceReviewCheckpoint};candidate:CandidateImageIdentity;planResultId:string;findResult:(id:string)=>AiResult|undefined;assertKnown:(result:AiResult)=>void;save:()=>void}):boolean{
 const original=input.attempt.appearanceReview;if(!original||original.policyVersion||original.state==='NOT_PERFORMED'||original.state==='READY')return false;
 const checkpoint=validateAppearanceCheckpoint(original);
 if(checkpoint.state!=='DONE')throw new UserFacingError('原外观复核结果未知，保留原请求与候选；未升级审核策略或重复发送');
 if(checkpoint.planResultId!==input.planResultId||listingFingerprint(checkpoint.candidate)!==listingFingerprint(input.candidate))fail();
 let last:AppearanceReviewOutput|undefined;
 for(const [index,id] of checkpoint.resultIds.entries()){
  const result=input.findResult(id)??fail();if(result.output.kind!=='image-appearance-review')return fail();const output=result.output;
  if(output.policyVersion||output.planResultId!==input.planResultId||listingFingerprint(output.candidate)!==listingFingerprint(input.candidate)||output.previousResultId!==(checkpoint.resultIds[index-1]??null)||index>0&&last?.verdict!=='UNCERTAIN')fail();
  input.assertKnown(result);last=output;
 }
 if(!last||last.verdict==='PASS'||last.verdict==='UNCERTAIN'&&checkpoint.resultIds.length===1&&checkpoint.snapshot?.upgrade)return false;
 input.attempt.appearanceReview={policyVersion:APPEARANCE_REVIEW_POLICY_VERSION,previousPolicy:structuredClone(checkpoint),basePreviousResultId:checkpoint.resultIds.at(-1)!,state:'READY',candidate:input.candidate,planResultId:input.planResultId,resultIds:[],snapshot:checkpoint.snapshot};input.save();return true;
}
export function readAppearanceReviewSettings(db:DatabaseSync):{enabled:boolean}{const row=db.prepare('SELECT value_json FROM amazon_settings WHERE key=?').get('image_appearance_review_v1');return row?parseSettings(JSON.parse(String(row.value_json))):{enabled:true};}
function parseSettings(raw:unknown){const v=keys(raw,['enabled']);if(typeof v.enabled!=='boolean')fail();return{enabled:v.enabled as boolean};}
export function writeAppearanceReviewSettings(db:DatabaseSync,raw:unknown){const v=parseSettings(raw);writeOwnedSetting(db,'images','image_appearance_review_v1',JSON.stringify(v));return v;}
/** This state machine owns review attempts only. It never draws an image or resets slot budgets. */
export async function runAppearanceReview(input:{enabled:boolean;attempt:{appearanceReview?:AppearanceReviewCheckpoint};candidate:CandidateImageIdentity;planResultId:string;getSnapshot:()=>AiPurposeSnapshot;save:()=>void;beforeSend?:()=>void;findResult:(id:string)=>AiResult|undefined;recover?: (previousResultId:string|null)=>AiResult|undefined;send:(snapshot:AiPurposeSnapshot,previousResultId:string|null)=>Promise<AiResult>}):Promise<AppearanceReviewOutput['verdict']|'NOT_PERFORMED'>{
 let checkpoint=input.attempt.appearanceReview;
 if(!checkpoint){checkpoint={policyVersion:APPEARANCE_REVIEW_POLICY_VERSION,state:input.enabled?'READY':'NOT_PERFORMED',candidate:input.candidate,planResultId:input.planResultId,resultIds:[],snapshot:input.enabled?input.getSnapshot():null};input.attempt.appearanceReview=checkpoint;if(!input.enabled){input.save();return'NOT_PERFORMED';}}
 if(listingFingerprint(checkpoint.candidate)!==listingFingerprint(input.candidate)||checkpoint.planResultId!==input.planResultId)fail();
 if(checkpoint.state==='NOT_PERFORMED')return'NOT_PERFORMED';
 const verify=(r:AiResult,previous:string|null)=>{if(r.output.kind!=='image-appearance-review'||r.output.policyVersion!==checkpoint.policyVersion||r.output.planResultId!==input.planResultId||r.output.previousResultId!==previous||listingFingerprint(r.output.candidate)!==listingFingerprint(input.candidate))fail();return r.output as AppearanceReviewOutput;};
 if(checkpoint.state==='PENDING'||checkpoint.state==='READY'&&checkpoint.policyVersion){
  const previous=checkpoint.resultIds.at(-1)??checkpoint.basePreviousResultId??null,recovered=input.recover?.(previous);
  if(!recovered&&checkpoint.state==='PENDING')throw new UserFacingError('原外观复核尚无可安全采用的原身份结果；已有回执或未知费用均保留，未重复发送或重画');
  if(recovered){verify(recovered,previous);checkpoint.resultIds.push(recovered.id);checkpoint.state='DONE';input.save();}
 }
 for(;;){
  const previous=checkpoint.resultIds.at(-1)??checkpoint.basePreviousResultId??null,prior=checkpoint.resultIds.length?input.findResult(checkpoint.resultIds.at(-1)!):undefined;
  if(checkpoint.resultIds.length&&!prior)fail();
  if(prior){const review=verify(prior,checkpoint.resultIds.at(-2)??checkpoint.basePreviousResultId??null);if(review.verdict!=='UNCERTAIN'||checkpoint.resultIds.length>=2||!checkpoint.snapshot?.upgrade)return review.verdict;}
  const snapshot=prior?{...checkpoint.snapshot!.upgrade!,upgradePurposeId:null,upgrade:null}:checkpoint.snapshot!;
  input.beforeSend?.();checkpoint.state='PENDING';input.save();
  let result:AiResult;try{result=await input.send(snapshot,previous);}catch(error){if(error&&typeof error==='object'&&'notSent' in error&&error.notSent===true){if(checkpoint.resultIds.length)checkpoint.state='DONE';else checkpoint.state='READY';input.save();}throw error;}verify(result,previous);checkpoint.resultIds.push(result.id);checkpoint.state='DONE';input.save();
 }
}
