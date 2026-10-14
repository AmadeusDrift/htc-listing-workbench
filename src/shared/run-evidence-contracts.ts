export const REQUEST_CERTAINTIES = ['NOT_SENT', 'SENT_UNKNOWN', 'RECEIVED_INVALID', 'RECEIVED_VALID', 'DEFINITIVE_REJECTION'] as const;
export type RequestCertainty = typeof REQUEST_CERTAINTIES[number];
export const ABORT_SOURCES = ['USER', 'TOTAL_TIMEOUT', 'BODY_TIMEOUT', 'SHUTDOWN', 'NONE'] as const;
export type AbortSource = typeof ABORT_SOURCES[number];
export const RUN_EVIDENCE_EVENTS = ['STAGE_STARTED', 'REQUEST_RESERVED', 'DISPATCH_ATTEMPTED', 'HEADERS_RECEIVED', 'BODY_COMPLETED', 'RECEIPT_SAVED', 'OUTPUT_REJECTED', 'RESULT_STORED', 'RESULT_ADOPTED', 'STAGE_BLOCKED', 'STAGE_COMPLETED', 'RECOVERY_LINKED'] as const;
export type RunEvidenceEvent = typeof RUN_EVIDENCE_EVENTS[number];
/** Safe facts only. Dispatch is an application boundary, never proof of provider acceptance.
 * Valid output, adoption, platform acceptance and buyability remain separate facts. */
export interface RunEvidence {
  version: 1; at: string; event: RunEvidenceEvent; stage: string;
  taskId?: string; itemKey?: string; sku?: string; operationId?: string;
  callId?: string; receiptId?: string; draftId?: string; slot?: number;
  certainty?: RequestCertainty; abortSource?: AbortSource; errorCode?: string;
  httpStatus?: number; receivedBytes?: number;
}
/** Transport cannot supply business identities, response text, credentials or headers. */
export type TransportRunEvidence = Pick<RunEvidence, 'at'> & {
  event: 'DISPATCH_ATTEMPTED' | 'HEADERS_RECEIVED' | 'BODY_COMPLETED' | 'STAGE_BLOCKED';
} & Partial<Pick<RunEvidence, 'certainty' | 'abortSource' | 'errorCode' | 'httpStatus' | 'receivedBytes'>>;
