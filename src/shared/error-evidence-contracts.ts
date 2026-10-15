import type { AbortSource, RequestCertainty } from './run-evidence-contracts.ts';
export interface ErrorStageEvidence {
  networkDiagnostic?:NetworkDiagnostic; validationPath?:string; validationField?:string;
  version: 1; stage: string; code: string; productId?: string; taskId?: string; variantId?: string;
  draftId?: string; requestId?: string; callId?: string; operationId?: string; itemKey?: string; sku?: string;
  abortSource?: AbortSource; certainty?: RequestCertainty; executionTaskIds?: string[];
  requestOutcome?: 'NOT_SENT' | 'DEFINITIVE_FAILURE' | 'RESULT_UNKNOWN'; httpStatus?: number; callsite?: string; diagnosticReason?: string;
}

export interface NetworkDiagnostic {
  cause:'DNS'|'CONNECTION_RESET'|'CONNECTION_REFUSED'|'TIMEOUT'|'TLS'|'PROXY'|'UNKNOWN';
  stage:'connect'|'body'|'save'; httpStatus?:number; receivedBytes:number;
}
