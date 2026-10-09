import type { ContentSuggestionOutput, TEXT_REVIEW_POLICY_VERSION } from './ai-contracts.ts';
import type { ProductRecordQuery, RecordPage } from './record-query-contracts.ts';

export interface AdoptReviewedContentInput { productId: string; productRevision: number; reviewResultId: string }
/** A local copy of independently reviewed model output, not a confirmed fact or Amazon listing draft. */
export interface ContentVersion {
  id: string; productId: string; sourceRevision: number; variantId: string;
  generationResultId: string; reviewResultId: string; suggestionSha256: string; sourceSha256: string;
  generationModel: string; reviewModel: string; policyVersion: typeof TEXT_REVIEW_POLICY_VERSION;
  createdAt: string; status: 'model-approved'; output: ContentSuggestionOutput;
}
export interface ContentApi {
  adoptReviewedContent(input: AdoptReviewedContentInput): Promise<ContentVersion>;
  listContentVersions(productId: string): Promise<ContentVersion[]>;
  queryContentVersions(input: ProductRecordQuery): Promise<RecordPage<ContentVersion>>;
}
