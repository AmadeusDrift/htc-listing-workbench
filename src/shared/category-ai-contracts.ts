export type CategoryPhase = 'keywords' | 'select' | 'judge';
/** v1 remains readable as its original snapshot; missing v2 identity is never inferred as unsent. */
export type CategoryPhaseContext =
  | {version:1;phase:CategoryPhase;requestSha256:string}
  | {version:2;phase:CategoryPhase;requestSha256:string;operationId:string;inputVersion:string;candidateSnapshotSha256:string;expansion:0|1};
/** An explicit, versioned domain outcome, never inferred from legacy null or prose. */
export interface CategorySelection {
  version:1;outcome:'SELECTED'|'NO_SUITABLE';candidateSnapshotSha256:string;
}
/** All paid call IDs refer to the original operation's existing usage/fee ledger; no new budget account. */
export interface CategoryRepairClaim {
  version:1;operationId:string;phase:CategoryPhase;originalCallIds:string[];retryCallId:string;
  inputVersion:string;candidateSnapshotSha256:string;continuedAt:string;
}
/** Reserve once before expanded lookup. A missing completed snapshot is not an unused allowance. */
export interface CategoryExpansionClaim {
  version:1;operationId:string;originalCallId:string;fromCandidateSnapshotSha256:string;
  claimedAt:string;candidateSnapshotSha256:string|null;
}
export interface CategoryDecision {
  kind: 'category-decision';
  phase: CategoryPhase;
  keywords: string[];
  productType: string | null;
  reason: string;
  ambiguous: boolean;
  selection?:CategorySelection;
}
export interface ProductClassification {
  productType: string; reason: string; keywords: string[]; candidateTypes: string[];
  decisionIds: string[]; judged: boolean; classifiedAt: string;
}
