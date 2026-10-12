export const SOURCE_CONSISTENCY_VERSION='source-image-consistency/v1' as const;
export const SOURCE_OBSERVATION_VERSION='source-image-consistency/v2' as const;
export interface SourceClaimField { id:string; name:string; value:string }
export interface SourceVisualClaim { id:string; fieldId:string; axis:'color'|'shape'|'pattern'; raw:string; value:string; start:number; end:number; rule:'color-family/v1'|'appearance/v1' }
export interface SourceComparisonProjection { fields:SourceClaimField[]; claims:SourceVisualClaim[]; issues:string[] }
export type SourceConsistencyIdentity={kind:'local-original'}|{kind:'native1688'|'miaoshou';receiptId:string;receiptFingerprint:string;sourceSku:string};
export interface SourceConsistencyContext extends SourceComparisonProjection {
  version:typeof SOURCE_CONSISTENCY_VERSION|typeof SOURCE_OBSERVATION_VERSION; productId:string; productRevision:number; variantId:string;
  identity:SourceConsistencyIdentity;
  referenceAssets:{scope?:'product';source:'local-original'|'receipt-image';assetId:string;sha256:string;byteSize:number;bindingEpoch:string;anchorId:string|null;imageId:string|null}[];
}
export interface SourceConsistencyOutput {
  kind:'source-image-consistency';
  version?:typeof SOURCE_OBSERVATION_VERSION;
  assets:{assetId:string;quality:'clear'|'low-detail';visibility:'complete'|'occluded';lighting:'neutral'|'uncertain';presentation:'single-product'|'alternatives'|'unknown';colors:string[];appearance:string[];
    claims:{claimId:string;value:string|null;visibility:'visible'|'unknown'}[];
    observations?:{name:string;values:string[];visibility:'visible'|'unknown'}[]}[];
}
export interface SourceConsistencyConclusion { decision:'MATCH'|'MISMATCH'|'UNCERTAIN'; reasons:string[] }
/** Separate origins survive merging; image observations are never relabeled as supplier facts. */
export interface SourceObservationEvidence {
  version:typeof SOURCE_OBSERVATION_VERSION; variantId:string; assessmentId:string|null;
  sourceFields:SourceClaimField[]; images:SourceConsistencyOutput['assets']; productReferenceAssetIds?:string[];
  conflicts:{claimId:string;fieldId:string;axis:SourceVisualClaim['axis'];sourceValue:string;observedValues:string[];assetIds:string[]}[];
  reasons:string[];
}
export interface SourceConsistencyView {
  context:SourceConsistencyContext;fingerprint:string;status:'PENDING'|'MATCH'|'MANUAL'|'NEEDS_INPUT'|'SYSTEM_REPAIR'|'UNKNOWN';reasons:string[];
  assessmentId:string|null;observations:SourceConsistencyOutput|null;humanDecision:{decision:'CONFIRMED'|'CORRECTION_NEEDED';reason:string}|null;
}
export interface SourceConsistencyInput {productId:string;productRevision:number;variantId:string}
export interface SourceConsistencyDecisionInput extends SourceConsistencyInput {fingerprint:string;decision:'CONFIRMED'|'CORRECTION_NEEDED';reason:string}
export interface SourceConsistencyApi {
  getSourceConsistency(input:SourceConsistencyInput):Promise<SourceConsistencyView>;
  prepareSourceConsistency(input:SourceConsistencyInput):Promise<SourceConsistencyView>;
  decideSourceConsistency(input:SourceConsistencyDecisionInput):Promise<SourceConsistencyView>;
}

export const SOURCE_CONSISTENCY_OUTCOMES={
  SOURCE_CONSISTENCY_BINDING_REQUIRED:'NEEDS_INPUT',
  SOURCE_CONSISTENCY_NEEDS_INPUT:'NEEDS_INPUT',SOURCE_CONSISTENCY_SENT_UNKNOWN:'UNKNOWN',
  SOURCE_CONSISTENCY_IDENTITY_INVALID:'SYSTEM_REPAIR',SOURCE_CONSISTENCY_INVALID_OUTPUT:'SYSTEM_REPAIR',
  SOURCE_CONSISTENCY_UNAVAILABLE:'SYSTEM_REPAIR',SOURCE_CONSISTENCY_REQUEST_FAILED:'SYSTEM_REPAIR',
} as const;
