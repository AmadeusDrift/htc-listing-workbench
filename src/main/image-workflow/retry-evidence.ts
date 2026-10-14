import type { AiResult } from '../../shared/ai-contracts.ts';
import type { ImageRiskSettings, ImageSlotAttempt, ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { IMAGE_TEXT_REVIEW_POLICY_VERSION } from '../../shared/image-ai-contracts.ts';
import { evaluateImageRisk } from '../../shared/image-risk-policy.ts';
import { listingFingerprint } from '../json-fingerprint.ts';
/** A bypass authorizes the user's disabled policy; it is never a PASS verdict. */
export function candidateRetryEvidence(run:ImageWorkflowRun,index:number,attempt:ImageSlotAttempt|undefined,settings:ImageRiskSettings,getResult:(id:string)=>AiResult|undefined):boolean {
 if(!attempt?.candidateId||!attempt.planResultId||attempt.state!=='RETRYABLE_FAILURE')return false;
 const ip=attempt.ipReviewResultId?getResult(attempt.ipReviewResultId):undefined;
 const riskCandidate=ip?.output.kind==='image-ip-review'&&ip.output.planResultId===attempt.planResultId&&ip.output.candidate.id===attempt.candidateId&&evaluateImageRisk(ip.output,settings).verdict==='PASS'?ip.output.candidate:undefined;
 const bypass=!settings.enabled&&run.riskInterceptionEnabled===false&&attempt.riskBypass?.candidate.id===attempt.candidateId?attempt.riskBypass.candidate:undefined;
 const identity=bypass??riskCandidate;if(!identity)return false;
 const matches=(result:AiResult|undefined)=>!!result&&'candidate' in result.output&&listingFingerprint(result.output.candidate)===listingFingerprint(identity)&&'planResultId' in result.output&&result.output.planResultId===attempt.planResultId;
 const text=attempt.reviewResultId?getResult(attempt.reviewResultId):undefined;
 if(index===1&&attempt.textReviewPolicyVersion===IMAGE_TEXT_REVIEW_POLICY_VERSION&&text?.output.kind==='image-text-review'&&text.output.verdict==='NEEDS_CHANGES'&&text.output.ocrResultId===attempt.ocrResultId&&matches(text))return true;
 const appearanceId=attempt.appearanceReview?.resultIds.at(-1),appearance=appearanceId?getResult(appearanceId):undefined;
 return attempt.appearanceReview?.state==='DONE'&&appearance?.output.kind==='image-appearance-review'&&appearance.output.verdict==='MISMATCH'&&matches(appearance);
}
