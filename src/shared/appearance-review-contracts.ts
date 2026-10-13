import type {AiPurposeSnapshot} from './ai-purpose-contracts.ts';
import type {CandidateImageIdentity} from './image-ai-contracts.ts';
export interface AppearanceReviewOutput {kind:'image-appearance-review';candidate:CandidateImageIdentity;planResultId:string;previousResultId:string|null;verdict:'PASS'|'MISMATCH'|'UNCERTAIN';checks:{aspect:'identity'|'color'|'count'|'shape'|'other';expected:string;observed:string;reason:string;referenceAssetIds:string[]}[]}
export interface AppearanceReviewCheckpoint {state:'READY'|'PENDING'|'DONE'|'NOT_PERFORMED';candidate:CandidateImageIdentity;planResultId:string;resultIds:string[];snapshot:AiPurposeSnapshot|null}
