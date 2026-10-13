import { writeOwnedSetting } from '../storage/settings.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {AiResult} from '../../shared/ai-contracts.ts';
import type {AiPurposeSnapshot} from '../../shared/ai-purpose-contracts.ts';
import type {AppearanceReviewCheckpoint,AppearanceReviewOutput} from '../../shared/appearance-review-contracts.ts';
import type {CandidateImageIdentity} from '../../shared/image-ai-contracts.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {boundedText,keys,uuid,uuidList} from '../ai/primitives.ts';
import {validateCandidateImageIdentity} from '../ai/image-validation.ts';
import {validatePurposeSnapshot} from '../ai/purpose-routing.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
const fail=():never=>{throw new UserFacingError('外观复核依据或所属图片不完整，原图与响应已保留');};
export function validateAppearanceReview(raw:unknown):AppearanceReviewOutput{
 const v=keys(raw,['kind','candidate','planResultId','previousResultId','verdict','checks']);
 if(v.kind!=='image-appearance-review'||!['PASS','MISMATCH','UNCERTAIN'].includes(String(v.verdict))||!Array.isArray(v.checks)||!v.checks.length||v.checks.length>30)fail();
 const checks=(v.checks as unknown[]).map(raw=>{const c=keys(raw,['aspect','expected','observed','reason','referenceAssetIds']);if(!['identity','color','count','shape','other'].includes(String(c.aspect)))fail();const referenceAssetIds=uuidList(c.referenceAssetIds,10);if(!referenceAssetIds.length)fail();return{aspect:c.aspect as AppearanceReviewOutput['checks'][number]['aspect'],expected:boundedText(c.expected,1000),observed:boundedText(c.observed,1000),reason:boundedText(c.reason,2000),referenceAssetIds};});
 return{kind:'image-appearance-review',candidate:validateCandidateImageIdentity(v.candidate),planResultId:uuid(v.planResultId),previousResultId:v.previousResultId===null?null:uuid(v.previousResultId),verdict:v.verdict as AppearanceReviewOutput['verdict'],checks};
}
export function validateAppearanceCheckpoint(raw:unknown):AppearanceReviewCheckpoint{
 const c=keys(raw,['state','candidate','planResultId','resultIds','snapshot']);if(!['READY','PENDING','DONE','NOT_PERFORMED'].includes(String(c.state)))fail();
 const resultIds=uuidList(c.resultIds,2),snapshot=c.snapshot===null?null:validatePurposeSnapshot(c.snapshot);
 if(c.state==='READY'&&resultIds.length||c.state==='PENDING'&&resultIds.length>=2||resultIds.length===2&&!snapshot?.upgrade)fail();
 if(c.state==='NOT_PERFORMED'&&(resultIds.length||snapshot)||c.state!=='NOT_PERFORMED'&&(!snapshot||!snapshot.capability.vision)||c.state==='DONE'&&!resultIds.length)fail();
 return{state:c.state as AppearanceReviewCheckpoint['state'],candidate:validateCandidateImageIdentity(c.candidate),planResultId:uuid(c.planResultId),resultIds,snapshot};
}
export function readAppearanceReviewSettings(db:DatabaseSync):{enabled:boolean}{const row=db.prepare('SELECT value_json FROM amazon_settings WHERE key=?').get('image_appearance_review_v1');return row?parseSettings(JSON.parse(String(row.value_json))):{enabled:true};}
function parseSettings(raw:unknown){const v=keys(raw,['enabled']);if(typeof v.enabled!=='boolean')fail();return{enabled:v.enabled as boolean};}
export function writeAppearanceReviewSettings(db:DatabaseSync,raw:unknown){const v=parseSettings(raw);writeOwnedSetting(db,'images','image_appearance_review_v1',JSON.stringify(v));return v;}
/** This state machine owns review attempts only. It never draws an image or resets slot budgets. */
export async function runAppearanceReview(input:{enabled:boolean;attempt:{appearanceReview?:AppearanceReviewCheckpoint};candidate:CandidateImageIdentity;planResultId:string;getSnapshot:()=>AiPurposeSnapshot;save:()=>void;beforeSend?:()=>void;findResult:(id:string)=>AiResult|undefined;recover?: (previousResultId:string|null)=>AiResult|undefined;send:(snapshot:AiPurposeSnapshot,previousResultId:string|null)=>Promise<AiResult>}):Promise<AppearanceReviewOutput['verdict']|'NOT_PERFORMED'>{
 let checkpoint=input.attempt.appearanceReview;
 if(!checkpoint){checkpoint={state:input.enabled?'READY':'NOT_PERFORMED',candidate:input.candidate,planResultId:input.planResultId,resultIds:[],snapshot:input.enabled?input.getSnapshot():null};input.attempt.appearanceReview=checkpoint;if(!input.enabled){input.save();return'NOT_PERFORMED';}}
 if(listingFingerprint(checkpoint.candidate)!==listingFingerprint(input.candidate)||checkpoint.planResultId!==input.planResultId)fail();
 if(checkpoint.state==='NOT_PERFORMED')return'NOT_PERFORMED';
 const verify=(r:AiResult,previous:string|null)=>{if(r.output.kind!=='image-appearance-review'||r.output.planResultId!==input.planResultId||r.output.previousResultId!==previous||listingFingerprint(r.output.candidate)!==listingFingerprint(input.candidate))fail();return r.output as AppearanceReviewOutput;};
 if(checkpoint.state==='PENDING'){
  const previous=checkpoint.resultIds.at(-1)??null,recovered=input.recover?.(previous);
  if(!recovered)throw new UserFacingError('原外观复核结果未知，保留原尝试与候选；未重复发送或重画');
  verify(recovered,previous);checkpoint.resultIds.push(recovered.id);checkpoint.state='DONE';input.save();
 }
 for(;;){
  const previous=checkpoint.resultIds.at(-1)??null,prior=previous?input.findResult(previous):undefined;
  if(previous&&!prior)fail();
  if(prior){const review=verify(prior,checkpoint.resultIds.at(-2)??null);if(review.verdict!=='UNCERTAIN'||checkpoint.resultIds.length>=2||!checkpoint.snapshot?.upgrade)return review.verdict;}
  const snapshot=prior?{...checkpoint.snapshot!.upgrade!,upgradePurposeId:null,upgrade:null}:checkpoint.snapshot!;
  input.beforeSend?.();checkpoint.state='PENDING';input.save();
  let result:AiResult;try{result=await input.send(snapshot,previous);}catch(error){if(error&&typeof error==='object'&&'notSent' in error&&error.notSent===true){if(checkpoint.resultIds.length)checkpoint.state='DONE';else checkpoint.state='READY';input.save();}throw error;}verify(result,previous);checkpoint.resultIds.push(result.id);checkpoint.state='DONE';input.save();
 }
}
