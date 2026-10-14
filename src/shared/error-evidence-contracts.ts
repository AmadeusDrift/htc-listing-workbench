import type { AbortSource, RequestCertainty } from './run-evidence-contracts.ts';
export interface ErrorStageEvidence {
  version: 1; stage: string; code: string; productId?: string; taskId?: string; variantId?: string;
  draftId?: string; requestId?: string; callId?: string; operationId?: string; itemKey?: string; sku?: string;
  abortSource?: AbortSource; certainty?: RequestCertainty; executionTaskIds?: string[];
  requestOutcome?: 'NOT_SENT' | 'DEFINITIVE_FAILURE' | 'RESULT_UNKNOWN'; httpStatus?: number; callsite?: string; diagnosticReason?: string;
}
