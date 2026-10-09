import type { AmazonCredentialInput } from './connection-inputs.ts';
import type { ListingFieldAdoption } from './listing-ai-contracts.ts';
import type { CredentialStatus } from './credential-status.ts';
import type { BusinessRuleReport } from './listing-rules.ts';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type AmazonMode = 'demo' | 'live';
export type ListingProgram = 'haul' | 'standard';
export type ParentageLevel = 'NONE' | 'PARENT' | 'CHILD';
export type ListingRequirements = 'LISTING' | 'LISTING_PRODUCT_ONLY' | 'LISTING_OFFER_ONLY';

/** Returned connection metadata never contains saved credentials. */
export interface AmazonTarget {
  id: string;
  name: string;
  mode: AmazonMode;
  sellerId: string;
  marketplaceId: string;
  marketplaceName: string;
  region: 'na' | 'eu' | 'fe';
  locale: string;
  paused: boolean;
  configured: boolean;
  credentialUpdatedAt: string | null;
  lastError: string | null;
}
export interface ProductTypeOption { name: string; displayName: string }
export interface AmazonCredentialDiagnostics {
  targets: (CredentialStatus & { targetId: string })[];
  orphanedCredentialCount: number;
}
export interface SchemaSelection {
  targetId: string;
  productType: string;
  parentageLevel: ParentageLevel;
  requirements: ListingRequirements;
  locale: string;
}
export interface SchemaRequestInput extends SchemaSelection { forceRefresh?: boolean }
export interface AmazonSchema extends SchemaSelection {
  key: string;
  mode: AmazonMode;
  schema: JsonObject;
  metaSchema: JsonObject;
  checksum: string;
  version: string;
  propertyGroups: Record<string, { title: string; propertyNames: string[] }>;
  fetchedAt: string;
  expiresAt: string;
  fromCache: boolean;
}
export interface ListingIssue {
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  attributeNames: string[];
  category: 'field' | 'fact' | 'qualification' | 'compliance' | 'image' | 'network' | 'rate_limit';
  source: 'local' | 'amazon' | 'demo';
  autoFixable: boolean;
}
export type ListingState = 'DRAFT' | 'LOCAL_VALIDATED' | 'AMAZON_VALIDATED' | 'SUBMITTING' | 'SUBMITTED' | 'PROCESSING' | 'BUYABLE' | 'DISCOVERABLE' | 'BLOCKED' | 'UNKNOWN';
export interface ListingEvent {
  at: string;
  operation: 'create' | 'save' | 'local_validation' | 'preview' | 'submit' | 'readback';
  state: ListingState;
  requestId: string | null;
  summary: string;
}
export interface SourceFieldMapping {
  field: string;
  status: 'mapped' | 'needs_input' | 'not_applicable' | 'conflicting';
  reason: string;
  sourceFactIds: string[];
}
export interface AmazonDraft {
  salesPlan?: import('./sales-plan-contracts.ts').SalesListingPlan;
  parentImageSourceDraftId?: string;
  listingProgram: ListingProgram;
  fieldAdoptions?: ListingFieldAdoption[];
  sourceMapping?: SourceFieldMapping[];
  businessRules?: BusinessRuleReport;
  id: string;
  productId: string;
  productRevision: number;
  variantId: string;
  sku: string;
  targetId: string;
  targetName: string;
  sellerId: string;
  marketplaceId: string;
  mode: AmazonMode;
  revision: number;
  schema: AmazonSchema;
  attributes: JsonObject;
  state: ListingState;
  localIssues: ListingIssue[];
  previewIssues: ListingIssue[];
  listingIssues: ListingIssue[];
  statuses: string[];
  submissionId: string | null;
  requestId: string | null;
  previewedAt: string | null;
  submittedAt: string | null;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: ListingEvent[];
}
export interface CreateAmazonDraftInput extends SchemaSelection { productId: string; variantId: string; listingProgram?: ListingProgram }
export interface PrepareAmazonDraftsInput extends SchemaSelection {
  listingProgram?: ListingProgram;
  items: { productId: string; productRevision: number; variantId: string; attributes: JsonObject }[];
}
export interface PreparedAmazonDraftItem {
  productId: string;
  variantId: string;
  sku: string | null;
  disposition: 'CREATED' | 'REUSED' | 'REJECTED';
  draft: AmazonDraft | null;
  issues: ListingIssue[];
  error: string | null;
}
export interface PrepareAmazonDraftsResult { items: PreparedAmazonDraftItem[] }
export interface DraftReference { id: string; revision: number }
export interface SaveAmazonDraftInput extends DraftReference { attributes: JsonObject }
export interface AmazonCallEvent {
  id: string;
  at: string;
  targetId: string;
  operation: string;
  mode: AmazonMode;
  status: number | null;
  requestId: string | null;
  retries: number;
  durationMs: number;
  rateLimit: string | null;
  category: string | null;
}
export interface AmazonDataPolicy { retentionDays: number; logRetentionDays: number; lastCleanupAt: string | null }
export interface CleanupResult { removedSchemas: number; removedDrafts: number; removedCalls: number; removedBackups?: number }
export interface AmazonApi {
  listAmazonTargets(): Promise<AmazonTarget[]>;
  getAmazonCredentialDiagnostics(): Promise<AmazonCredentialDiagnostics>;
  enableAmazonDemo(): Promise<AmazonTarget>;
  importAmazonCredentials(): Promise<AmazonTarget | null>;
  saveAmazonCredentials(input: AmazonCredentialInput): Promise<AmazonTarget>;
  exportAmazonCredentialTemplate(): Promise<{ cancelled: boolean }>;
  pauseAmazonTarget(input: { targetId: string; paused: boolean }): Promise<AmazonTarget>;
  disconnectAmazonTarget(targetId: string): Promise<{ cancelled: boolean }>;
  searchAmazonProductTypes(input: { targetId: string; keywords: string }): Promise<ProductTypeOption[]>;
  getAmazonSchema(input: SchemaRequestInput): Promise<AmazonSchema>;
  listAmazonDrafts(productId: string): Promise<AmazonDraft[]>;
  createAmazonDraft(input: CreateAmazonDraftInput): Promise<AmazonDraft>;
  prepareAmazonDrafts(input: PrepareAmazonDraftsInput): Promise<PrepareAmazonDraftsResult>;
  saveAmazonDraft(input: SaveAmazonDraftInput): Promise<AmazonDraft>;
  validateAmazonDraft(input: DraftReference): Promise<AmazonDraft>;
  previewAmazonDraft(input: DraftReference): Promise<AmazonDraft>;
  submitAmazonDraft(input: DraftReference): Promise<AmazonDraft | null>;
  readAmazonListing(input: DraftReference): Promise<AmazonDraft>;
  listAmazonCalls(): Promise<AmazonCallEvent[]>;
  getAmazonDataPolicy(): Promise<AmazonDataPolicy>;
  saveAmazonDataPolicy(input: { retentionDays: number }): Promise<AmazonDataPolicy>;
  cleanupAmazonData(): Promise<CleanupResult>;
}
