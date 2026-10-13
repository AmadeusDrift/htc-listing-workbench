import type { AiPurposeSnapshot } from './ai-purpose-contracts.ts';

export type ListingExecutionMode='immediate'|'deferred_batch';
export type BatchState='prepared'|'submitting'|'submission_unknown'|'waiting'|'reconciled'|'failed';
export type BatchRemoteStatus='validating'|'in_progress'|'finalizing'|'completed'|'failed'|'expired'|'cancelling'|'cancelled';
export interface BatchReference {
  pinId:string; assetId:string; sha256:string; url:string; retainedUntil:string;
}
/** Main-only prepared operation. URLs require a matching M09 pin, not a renderer assertion. */
export interface BatchOperation {
  aiCallId?:string;
  taskId:string; operationId:string; attempt:number; phase:string;
  inputFingerprint:string; schemaFingerprint:string; credentialScope:string;
  owner:{productId:string;productRevision:number;providerId:'openrouter'|'openrouter-review';generation:number};
  purpose:AiPurposeSnapshot; body:Record<string,unknown>; references:BatchReference[];
}
export interface BatchRecord {
  version:1; id:string; taskId:string; phase:string; fingerprint:string; credentialScope:string;
  purpose:AiPurposeSnapshot; model:string; schemaFingerprint:string; itemIds:string[];
  state:BatchState; remoteBatchId:string|null; remoteStatus:BatchRemoteStatus|null;
  locallyStopped:boolean; createdAt:string; submittedAt:string|null; updatedAt:string;
  receiptIds:string[]; reportedCostUsd:number|null; error:string|null;
}
export interface BatchItem extends BatchOperation {
  version:1; id:string; batchId:string; customId:string;
  state:'prepared'|'waiting'|'received'|'failed'|'missing';
  receiptId:string|null; resultFingerprint:string|null; reportedCostUsd:number|null;
  adoption:{id:string;at:string}|null;
}
export interface BatchPlan {
  groups:BatchOperation[][];
  ordinary:{operationId:string;reason:string}[];
}

export interface TaskBatchPlan {version:1;credentialScope:string;purposes:AiPurposeSnapshot[];coverage:{purposeId:string;mode:ListingExecutionMode;reason:string}[]}

/** Read-only UI projection. Request bodies, asset URLs and credentials never leave main. */
export interface TaskBatchSummary {
 mode:ListingExecutionMode;plan:TaskBatchPlan|null;batches:BatchRecord[];
 details:{batchId:string;lastQueriedAt:string|null;items:{id:string;operationId:string;state:BatchItem['state'];adopted:boolean;skus:string[]}[]}[];
}
