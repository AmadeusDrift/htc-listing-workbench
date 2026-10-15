import type { RunEvidence, RequestCertainty, AbortSource } from './run-evidence-contracts.ts';
export interface RunReportQuery { taskId: string; sku?: string; pageSize?: number; cursor?: string }
export interface RunCallReport {
  callId: string; operationId: string | null; receiptId: string | null; draftId: string | null;
  itemKey: string | null; sku: string | null; stage: string | null;
  association: 'TASK_EVENT' | 'DRAFT_REFERENCE' | 'CLASSIFICATION_REFERENCE'; startedAt: string | null; receivedAt: string | null;
  certainty: RequestCertainty | null; abortSource: AbortSource | null; errorCode: string | null;
  httpStatus: number | null; receivedBytes: number | null; resultIds: string[]; adopted: boolean;
  nextAction: 'VERIFY_ORIGINAL_REQUEST' | 'INSPECT_SAVED_RESULT' | 'INSPECT_REJECTION_AND_BUDGET' | 'CONTINUE_FROM_ADOPTED_RESULT' | 'INSPECT_LEGACY_EVIDENCE';
  missing: string[]; evidence: RunEvidence[];
}
export interface RunCategoryLookupReport {
  operationId:string;requestId:string;itemKeys:string[];skus:string[];permittedAt:string|null;
  httpStatus:number|null;remoteRequestId:string|null;receivedAt:string|null;receivedBytes:number|null;receiptSha256:string|null;
  snapshotSaved:boolean;snapshotSha256:string|null;candidateCount:number|null;adopted:boolean;adoptedResultIds:string[];
  certainty:RequestCertainty|null;receiptIntegrity:'SAVED_METADATA_ONLY';missing:string[];
}
export interface RunFailureSummary {
  affectedProducts: number; failedSalesItems: number;
  groups: { stage: string; kind: string; code: string; reason: string; productCount: number; salesItemCount: number }[];
}
export interface RunDiagnosticReport {
  reportVersion: 1; generatedAt: string;
  provenance: { appVersion: string | null; sourceCommit: string | null; sourceDigest: string | null; buildDigest: string | null; workspaceId: string; connection: 'CURRENT_PROCESS'; consistentSnapshot: true };
  scope: { taskId: string; taskRevision: number | null; sku: string | null };
  counts: { totalCalls: number; savedReceipts: number; validResults: number; adoptedResults: number; submittedSkus: number; buyableSkus: number; demoSubmittedSkus: number; previewRequests: number; submissionRequests: number; readbackRequests: number; evidenceEvents: number };
  coverage: { missing: string[]; unassignedProductCalls: number; draftReferenceCalls: number; receiptIntegrity: 'SAVED_METADATA_ONLY' };
  calls: RunCallReport[]; events: RunEvidence[]; categoryLookups:RunCategoryLookupReport[];
  currentFailures: RunFailureSummary;
  platform: { id: string; draftId: string; stage: 'preview' | 'submit' | 'readback'; at: string | null; httpStatus: number | null; requestId: string | null }[];
  errors: { stage: string; code: string; at: string | null; callId?: string; requestId?: string; abortSource?: AbortSource; certainty?: RequestCertainty; draftId?: string; itemKey?: string; sku?: string; operationId?: string; validationField?:string; validationPath?:string; networkDiagnostic?:import('./error-evidence-contracts.ts').NetworkDiagnostic }[];
  page: { total: number; returned: number; nextCursor: string | null; complete: boolean };
}
export interface RunReportContext { appVersion?: string; sourceCommit?: string; sourceDigest?: string; buildDigest?: string }
