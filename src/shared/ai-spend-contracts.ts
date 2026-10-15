export interface AiSpendPolicy {version:1;id:'image-generation-daily'|'controlled-live-lifetime';period:'UTC_DAY'|'LIFETIME';limitUsdMicros:number|null;updatedAt:string}
export interface ImagePriceEvidence {version:1;url:string;fetchedAt:string;expiresAt:string;body:unknown;sha256:string}
export interface AiSpendBound {version:1;method:'fixed-image-endpoints/v1';requestSha256:string;upperUsdMicros:number;evidence:ImagePriceEvidence}
export interface AiSpendReceiptProof {receiptId:string;sha256:string;certainty:'SENT_UNKNOWN'|'RECEIVED_INVALID'|'RECEIVED_VALID'|'DEFINITIVE_REJECTION'}
export interface AiSpendReservation {
 version:1;id:string;businessKey:string;requestSha256:string;model:string;purpose:string;createdAt:string;
 policyIds:AiSpendPolicy['id'][];scopeId:string|null;bound:AiSpendBound|null;
 state:'DISPATCH_ATTEMPTED'|'UNKNOWN'|'SETTLED'|'COST_ANOMALY';
 actualUsdMicros:number|null;receiptIds:string[];receiptProofs:AiSpendReceiptProof[];
}
export interface AiSpendSummary {reportedUsdMicros:number;heldUsdMicros:number;unboundedCalls:number;anomaly:boolean;limitUsdMicros:number|null}
export interface AiSpendStatus extends AiSpendSummary {policyUpdatedAt:string|null;remainingUsdMicros:number|null;pendingCalls:number;unknownCalls:number}
export interface ImageGenerationSpendStatus {currency:'USD';unit:'microUSD';daily:AiSpendStatus;controlledLifetime:AiSpendStatus;controlledRunStatus:'not-registered'|'PAUSED'|'ACTIVE';quoteStatus:'not-checked'}
export interface SetImageDailySpendLimit {limitUsd:string|null;expectedUpdatedAt:string|null}
