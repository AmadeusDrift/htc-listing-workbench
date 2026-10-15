import type {CategoryRepairClaim} from './category-ai-contracts.ts';
import type {ProductTypeOption} from './amazon-contracts.ts';

export interface CategoryExpansionSnapshot {
 version:1;candidates:ProductTypeOption[];
 evidence:{name:string;hitKeywords:string[];sources:('local'|'platform')[]}[];
 candidateSnapshotSha256:string;sha256:string;requestId:string;receiptSha256:string;receivedAt:string;
}
export interface CategoryExpansionOperation {
 version:1;operationId:string;inputVersion:string;originalDecisionId:string;originalCallId:string;
 fromCandidateSnapshotSha256:string;claimedAt:string;requestId:string;targetId:string;query:string;requestSha256:string;permittedAt:string|null;snapshot:CategoryExpansionSnapshot|null;
}
/** M07 safety state only. Actual calls, responses, usage and money stay in their existing ledgers. */
export interface CategoryOperationRecord {
 version:1;id:string;productId:string;repairs:CategoryRepairClaim[];expansion:CategoryExpansionOperation|null;
}
