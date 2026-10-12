import type { OcrOutput } from './ai-contracts.ts';
import type { CandidateField, ListingAiContext, ListingFieldsReviewOutput } from './listing-ai-contracts.ts';
import type { Fact } from './contracts.ts';

export const PRODUCT_IMAGE_POLICY_VERSION = 'product-image/ip-v3' as const;
export type ProductImagePolicyVersion = 'product-image/v1' | 'product-image/vision-v2' | typeof PRODUCT_IMAGE_POLICY_VERSION;
export interface CurrentListingCopy { field: CandidateField; values: string[] }
/** Unfiltered identity clues for risk screening only; never authority to add listing claims. */
export interface ImageRiskSourceSnapshot {
  description: string; originalSpec: string; sourceSpec: string; normalizedSpec: string;
  facts: Pick<Fact,'id'|'name'|'value'|'source'|'state'>[];
}
export const IMAGE_SET_POLICY = 'seven-product-v2' as const;
export const IMAGE_TEXT_REVIEW_POLICY_VERSION = 'image-text-review/v2' as const;
export type ImageTextReviewPolicyVersion = 'image-text-review/v1' | typeof IMAGE_TEXT_REVIEW_POLICY_VERSION;
export interface ReferenceMeasurement {
  id:string; assetId:string; ocrResultId:string; text:string;
}
export interface SourceImageMeasurement {id:string;name:string;value:string;variantId:string;sourceSha256:string}
export interface ImageSetSlot {
  /** Photography focal length only, never a product measurement or overlay. */
  cameraFocalLength?:string;
  index:number; role:'main_scene'|'selling_point'|'dimensions'|'scene';
  focus:string; evidenceIds:string[]; scene:string; prompt:string;
  textMode:'none'|'planned'; expectedText:{text:string;evidenceIds:string[]}[];
}
export interface ImageSetPlan {
  style:string; dimensionEvidenceIds:string[]; dimensionReason:string; slots:ImageSetSlot[];
}
/** Constructed only by the main process. Listing copy is context, never evidence. */
export interface ProductImageContext {
  listing: ListingAiContext;
  currentListingCopy: CurrentListingCopy[];
  listingReviewResultId: string | null;
  /** Explicitly skipped independent copy review; never a passing review result. */
  copyReviewBypass?: { policy: 'copy-review-disabled/v1'; at: string; contextSha256: string; copySha256: string };
  referenceAssets: { assetId: string; sha256: string; variantId: string | null }[];
  purpose: 'main' | 'detail';
  policyVersion: ProductImagePolicyVersion;
  /** Required by ip-v3; absent in historical contexts. */
  ipSource?: ImageRiskSourceSnapshot;
  sourceVariantIds?: string[];
  slot?:{index:number;total:7;provisional:true};
  setPolicy?:typeof IMAGE_SET_POLICY;
  /** OCR is kept separate from listing facts; only printed measurements can be used, after visual corroboration. */
  referenceMeasurements?:ReferenceMeasurement[];
  sourceMeasurements?:SourceImageMeasurement[];
  setPlan?:ImageSetPlan;
}
export interface CandidateImageIdentity { id: string; sha256: string; width: number; height: number }
export function imageCopySourceIds(context: ProductImageContext): string[] { return context.listingReviewResultId === null ? [] : [context.listingReviewResultId]; }
export interface ImagePlanOutput {
  /** Photography focal length only, never a product measurement or overlay. */
  cameraFocalLength?:string;
  kind: 'image-plan'; prompt: string; textMode: 'none' | 'planned';
  expectedText: { text: string; evidenceIds: string[] }[];
  setPlan?:ImageSetPlan;
  /** Visual observations, not verified specifications or an IP clearance. Absent only on legacy plans. */
  productUnderstanding?: { summary: string; referenceAssetIds: string[]; uncertainties: string[]; sufficient: boolean };
  /** Coarse screening of named IP, not a legal clearance. Absent only in older plans. */
  ipRisk?: { verdict: 'PASS' | 'BLOCKED' | 'UNCERTAIN'; findings: { category: 'character' | 'brand' | 'artwork' | 'uncertain'; name: string; evidence: string; referenceAssetIds: string[] }[] };
}
export interface ImageIpReviewOutput {
  kind: 'image-ip-review'; candidate: CandidateImageIdentity; planResultId: string;
  service: 'aigcViolationDetection'; verdict: 'PASS' | 'BLOCKED' | 'UNCERTAIN';
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  labels: { label: string; confidence: number | null; description: string }[];
}
export interface GeneratedImageOcrOutput extends Omit<OcrOutput, 'kind'> {
  kind: 'generated-image-ocr'; candidate: CandidateImageIdentity;
}
/** Covers the provider summary and every nonempty OCR block independently. */
export interface ImageTextCheck {
  source: 'summary' | 'line'; index: number; text: string;
  verdict: 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED'; evidenceIds: string[]; reason: string;
}
export interface ImageTextReviewOutput {
  kind: 'image-text-review'; candidate: CandidateImageIdentity; planResultId: string; ocrResultId: string;
  verdict: 'PASS' | 'NEEDS_CHANGES' | 'BLOCKED'; checks: ImageTextCheck[];
  expectedTextChecks: { index: number; present: boolean; reason: string }[];
  noTextVerified: boolean; issues: string[];
  /** OCR review makes no claim about product shape, count or visual similarity. */
  visualReview: 'not_performed';
}
/** Current draft copy is reviewed directly; no generation result is fabricated. */
export interface ListingCurrentReviewOutput extends Omit<ListingFieldsReviewOutput, 'kind'> {
  kind: 'listing-current-review'; currentListingCopy: CurrentListingCopy[]; copySha256: string;
}
