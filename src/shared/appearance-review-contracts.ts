import type {AiPurposeSnapshot} from './ai-purpose-contracts.ts';
import type {CandidateImageIdentity} from './image-ai-contracts.ts';
export const APPEARANCE_REVIEW_POLICY_VERSION='appearance-review/v2' as const;
export interface AppearanceReviewOutput {policyVersion?:typeof APPEARANCE_REVIEW_POLICY_VERSION;kind:'image-appearance-review';candidate:CandidateImageIdentity;planResultId:string;previousResultId:string|null;verdict:'PASS'|'MISMATCH'|'UNCERTAIN';checks:{aspect:'identity'|'color'|'count'|'shape'|'other';expected:string;observed:string;reason:string;referenceAssetIds:string[]}[]}
export interface LegacyAppearanceReviewCheckpoint {state:'READY'|'PENDING'|'DONE'|'NOT_PERFORMED';candidate:CandidateImageIdentity;planResultId:string;resultIds:string[];snapshot:AiPurposeSnapshot|null}
export interface AppearanceReviewCheckpoint extends LegacyAppearanceReviewCheckpoint {policyVersion?:typeof APPEARANCE_REVIEW_POLICY_VERSION;previousPolicy?:LegacyAppearanceReviewCheckpoint;basePreviousResultId?:string}
export interface AppearanceReviewPolicy {policyVersion:typeof APPEARANCE_REVIEW_POLICY_VERSION;basePreviousResultId?:string}
