import type { AmazonMode, ListingIssue, ListingState } from './amazon-contracts.ts';

export type FollowupStatus = 'WAITING' | 'PROCESSING' | 'READY' | 'NEEDS_ATTENTION';
export type FollowupReason = 'UNKNOWN_WRITE' | 'TARGET_CHANGED' | 'TARGET_UNAVAILABLE' | 'DRAFT_CHANGED' | 'LISTING_ERRORS' | 'READ_FAILED' | 'PLATFORM_REVIEW' | 'EXPIRED';

/** A matching Listings Items observation is evidence of a listing, not FBA inbound eligibility. */
export interface ListingObservation {
  draftId: string;
  targetId: string;
  sellerId: string;
  marketplaceId: string;
  sku: string;
  checkedAt: string;
  requestId: string | null;
  asin: string | null;
  fnsku: string | null;
  statuses: string[];
  issues: ListingIssue[];
  familyRelationship?: {status:'NOT_REQUIRED'|'WAITING'|'MATCHED'|'MISMATCHED';parentSkus:string[];variationTheme:string|null};
}

export interface FollowupRecord {
  /** One durable job per submitted draft; the id equals draftId. */
  id: string;
  draftId: string;
  revision: number;
  productId: string;
  variantId: string;
  sku: string;
  targetId: string;
  targetName: string;
  sellerId: string;
  marketplaceId: string;
  mode: AmazonMode;
  targetGeneration: number;
  draftRevision: number;
  draftFingerprint: string;
  submittedAt: string | null;
  submissionId: string | null;
  status: FollowupStatus;
  reason: FollowupReason | null;
  attempts: number;
  nextDueAt: string | null;
  /** Explicit query authorized but not yet checkpointed; consumed before sending. */
  requeryPending?: true;
  lastAttemptAt: string | null;
  checkedAt: string | null;
  listingState: ListingState;
  statuses: string[];
  issues: ListingIssue[];
  asin: string | null;
  fnsku: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FollowupSummary {
  total: number;
  waiting: number;
  processing: number;
  ready: number;
  needsAttention: number;
  nextDueAt: string | null;
}

export interface FollowupApi {
  listListingFollowups(): Promise<FollowupRecord[]>;
  getListingFollowupSummary(): Promise<FollowupSummary>;
  rescheduleListingFollowup(draftId: string): Promise<FollowupRecord>;
}
