import type { SourceConsistencyContext,SourceConsistencyOutput } from './source-image-consistency-contracts.ts';
import type { ProductRecordQuery, RecordPage, RecordPageOptions } from './record-query-contracts.ts';
import type { CategoryDecision } from './category-ai-contracts.ts';
import type { AiProviderConfigInput } from './connection-inputs.ts';
import type { AiConnectionApi } from './ai-connection-contracts.ts';
import type { ListingAiApi, ListingAiContext, ListingFieldsOutput, ListingFieldsReviewOutput, ListingEvidenceContractVersion } from './listing-ai-contracts.ts';
import type { GeneratedImageOcrOutput, ImagePlanOutput, ImageTextReviewOutput, ImageIpReviewOutput, ListingCurrentReviewOutput, ProductImageContext } from './image-ai-contracts.ts';
import type { SourceColorContext, SourceColorOutput } from './source-color-contracts.ts';
import type { ListingNormalization } from './listing-normalization-contracts.ts';

export const AI_PROVIDER_IDS = ['aliyun-ocr', 'aidge-segmentation', 'deepseek', 'deepseek-review', 'aliyun-image-risk'] as const;
export type AiProviderId = typeof AI_PROVIDER_IDS[number];
export type AiCapability = 'ocr' | 'segmentation' | 'text' | 'text-review' | 'image-generation' | 'image-risk';
/** Returned connection metadata only. Saved credentials are never returned. */
export interface AiProfile {
  thinking?: boolean;
  id: AiProviderId;
  capability: Exclude<AiCapability, 'image-generation'>;
  model: string;
  enabled: boolean;
  configured: boolean;
  generation: number;
}
export interface AiCapabilityInfo { capability: AiCapability; providerId: AiProviderId | 'openai-images' | 'tyai-images' | null; available: boolean; reason: string | null }
export type AiErrorCode = 'INVALID_INPUT' | 'INVALID_CONFIG' | 'NOT_CONFIGURED' | 'DISABLED' | 'CONFIG_CHANGED' | 'SOURCE_CHANGED' | 'IMAGE_INVALID' | 'HOSTED_IMAGE_REQUIRED' | 'ENCRYPTION_UNAVAILABLE' | 'AUTH_FAILED' | 'SERVICE_PERMISSION_REQUIRED' | 'QUOTA_EXCEEDED' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK_ERROR' | 'PROVIDER_ERROR' | 'OUTPUT_INVALID' | 'BUSY' | 'CANCELLED' | 'INTERRUPTED' | 'SERVICE_CLOSED';
export interface AiUsage { promptTokens: number; completionTokens: number; processedImages: number }
export const AI_DAILY_CALL_MAX = 1000000;
export const AI_DAILY_TOKEN_MAX = 1000000000000;
export interface AiUsagePolicy { providerId: AiProviderId; dailyCallLimit: number | null; dailyTokenLimit: number | null }
/** UTC calendar day. Unknown attempts retain their reservation; no monetary cost is inferred. */
export interface AiUsageSummary {
  providerId: AiProviderId; day: string; timeZone: 'UTC'; attempts: number; pendingCalls: number; unknownCalls: number;
  reportedTokens: number; reservedTokens: number; usedTokens: number | null; processedImages: number;
  /** Legacy unknown calls whose original request budget cannot be reconstructed. */
  unboundedCalls: number; policy: AiUsagePolicy;
}
export interface AiCall {
  /** Provider content was received; independent of local parsing success. */
  responseReceived?: true;
  thinking?: boolean;
  rejection?: import('./rejection-presentation.ts').OutputRejection;
  presentationContext?: {imagePlanRequestSha256?:string;workflowId?:string;kind:'image'|'listing';draftId:string;variantId:string;sourceSha256:string;slot:number};
  id: string; providerId: AiProviderId; productId: string; productRevision: number;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; errorCode: AiErrorCode | null;
  requestId: string | null; model: string; generation: number;
  startedAt: string; finishedAt: string | null; usage: AiUsage;
  /** Persisted with the usage reservation to prevent repeating an unknown color request. */
  sourceColorContext?: SourceColorContext;
  sourceConsistencyContext?: SourceConsistencyContext;
}
/** Confidence is normalized to 0..1; Commerce placement is unknown. */
export interface OcrLine { text: string; confidence: number | null; box: [number, number, number, number] | null }
export interface OcrOutput {
  kind: 'ocr'; text: string; lines: OcrLine[]; width: number; height: number;
  /** Commerce does not promise original-image coordinates. Unknown means no overlay. */
  coordinateSpace: 'unknown';
}
export interface SegmentationOutput {
  kind: 'segmentation'; outputKind: 'transparent-cutout'; imageUrl: string;
  /** Aidge quality score is not a probability. */
  width: number; height: number; score: number | null;
  /** Temporary provider artifact. It is not a reviewed managed product image or grayscale mask. */
  materialized: false;
}
export interface ContentSuggestionOutput {
  kind: 'text'; title: string; bullets: string[]; description: string;
  attributes: { name: string; value: string; factIds: string[] }[];
}
export const TEXT_REVIEW_POLICY_VERSION = 'content-review/v1' as const;
export type ContentReviewField = 'title' | 'description' | `bullets.${number}` | `attributes.${number}`;
export interface ContentReviewCheck {
  field: ContentReviewField; verdict: 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED'; evidenceIds: string[]; reason: string;
}
export interface ContentReviewIssue { code: string; field: ContentReviewField | null; message: string }
export interface TextReviewOutput {
  kind: 'text-review'; suggestionId: string; suggestionSha256: string;
  /** Main-process source fingerprint; never supplied by the renderer or model. */
  sourceSha256: string; policyVersion: typeof TEXT_REVIEW_POLICY_VERSION;
  verdict: 'PASS' | 'NEEDS_CHANGES' | 'BLOCKED'; checks: ContentReviewCheck[]; issues: ContentReviewIssue[];
}
export type AiOutput = OcrOutput | SegmentationOutput | ContentSuggestionOutput | TextReviewOutput | ListingFieldsOutput | ListingFieldsReviewOutput | ImagePlanOutput | GeneratedImageOcrOutput | ImageTextReviewOutput | ImageIpReviewOutput | ListingCurrentReviewOutput | CategoryDecision | SourceColorOutput | SourceConsistencyOutput;
export interface AiResult {
  fieldCandidateRecovery?: {parserVersion:'field-reference-recovery/v1';originalResult:unknown;originalSha256:string;recoveredAt:string};
  imagePlanRecovery?: { repair?:{previousPlanId:string;issues:string[]}; parserVersion:'image-plan-recovery/v1'; contextSha256:string; rawSha256:string; rawOutput:unknown; recoveredAt:string };
  localRecovery?: { parserVersion:'full-schema-recovery/v1'; operationId:string; contextSha256:string; rawSha256:string; rawOutput:unknown; recoveredAt:string };
  fieldRejections?: import('./rejection-presentation.ts').FieldRejections;
  id: string; callId: string; providerId: AiProviderId; productId: string; productRevision: number;
  variantId: string | null; assetId: string | null; assetSha256: string | null;
  sourceResultIds: string[]; model: string; createdAt: string;
  /** Generation-time evidence snapshot hash. Legacy text is readable but needs regeneration before review. */
  sourceSha256?: string;
  listingContext?: ListingAiContext;
  /** Main-process contract marker; never part of provider output or context fingerprints. */
  listingEvidenceContractVersion?: ListingEvidenceContractVersion;
  /** Optional ingestion provenance; excluded from source context and candidate output. */
  listingNormalization?: ListingNormalization;
  listingRequestBytes?: number;
  imageContext?: ProductImageContext;
  imageRequestBytes?: number;
  sourceColorContext?: SourceColorContext;
  sourceConsistencyContext?: SourceConsistencyContext;
  sourceColorRequestBytes?: number;
  sourceConsistencyRequestBytes?: number;
  reviewState: 'unreviewed'; output: AiOutput;
}
export interface RecognizeImageInput { productId: string; productRevision: number; assetId: string }
export interface SegmentImageInput extends RecognizeImageInput { hostedAssetId: string }
export interface SuggestContentInput { productId: string; productRevision: number; variantId: string; ocrResultIds: string[] }
export interface ReviewContentInput { productId: string; productRevision: number; suggestionResultId: string }
/** Image generation uses the independent, candidate-only ImageGenerationApi contract. */
export interface AiCallQuery extends RecordPageOptions { productId?: string; providerId?: AiProviderId; status?: AiCall['status'] }
export interface AiApi extends AiConnectionApi, ListingAiApi {
  listAiProviders(): Promise<AiProfile[]>;
  listAiCapabilities(): Promise<AiCapabilityInfo[]>;
  importAiProviderConfig(): Promise<AiProfile | null>;
  saveAiProviderConfig(input: AiProviderConfigInput): Promise<AiProfile>;
  exportAiProviderTemplate(id: AiProviderId): Promise<{ cancelled: boolean }>;
  setAiProviderEnabled(input: { id: AiProviderId; enabled: boolean }): Promise<AiProfile>;
  disconnectAiProvider(id: AiProviderId): Promise<AiProfile>;
  recognizeProductImage(input: RecognizeImageInput): Promise<AiResult>;
  segmentProductImage(input: SegmentImageInput): Promise<AiResult>;
  suggestProductContent(input: SuggestContentInput): Promise<AiResult>;
  reviewProductContent(input: ReviewContentInput): Promise<AiResult>;
  listAiResults(productId: string): Promise<AiResult[]>;
  listAiCalls(): Promise<AiCall[]>;
  queryAiResults(input: ProductRecordQuery): Promise<RecordPage<AiResult>>;
  queryAiCalls(input: AiCallQuery): Promise<RecordPage<AiCall>>;
  getAiUsagePolicy(id: AiProviderId): Promise<AiUsagePolicy>;
  setAiUsagePolicy(policy: AiUsagePolicy): Promise<AiUsagePolicy>;
  getAiUsageSummary(id: AiProviderId): Promise<AiUsageSummary>;
}
