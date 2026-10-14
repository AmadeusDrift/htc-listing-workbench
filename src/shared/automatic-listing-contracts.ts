import type { ItemLabelFormat } from './item-label-contracts.ts';
import type { ProductClassification } from './category-ai-contracts.ts';
import { INFERABLE_CATEGORY_FIELDS } from './listing-ai-contracts.ts';
export type AutomaticListingStatus = 'CREATED' | 'QUEUED' | 'RUNNING' | 'WAITING' | 'PAUSED' | 'NEEDS_ATTENTION' | 'COMPLETED' | 'CANCELLED';
export type AutomaticListingStage = 'PLAN' | 'SOURCES' | 'CLASSIFY' | 'DRAFT' | 'IMAGES' | 'PARENT' | 'EXECUTION' | 'READBACK' | 'LABELS' | 'COMPLETE';
export const FIELD_REPAIR_POLICY_VERSION = 'field-evidence/v2' as const;
export const FIELD_REPAIR_MIGRATION_FIELDS = ['theme','subject_character','color','target_audience','fabric_type','blade'] as const;
export type FieldRepairMigrationField = typeof FIELD_REPAIR_MIGRATION_FIELDS[number];
export const CATEGORY_FIELD_REPAIR_POLICY_VERSION = 'category-inference/v1' as const;
export const CATEGORY_FIELD_REPAIR_FIELDS = INFERABLE_CATEGORY_FIELDS;
export type CategoryFieldRepairField = typeof CATEGORY_FIELD_REPAIR_FIELDS[number];
export interface CategoryFieldRepairGrant { version:typeof CATEGORY_FIELD_REPAIR_POLICY_VERSION; grantedAttempts:1; grantedAt:string; fields:CategoryFieldRepairField[] }
export type AutomaticOutcomeKind = 'RULE_FILTERED' | 'SYSTEM_REPAIR' | 'NEEDS_INPUT' | 'UNKNOWN' | 'UNCLASSIFIED';
export interface AutomaticRuleEvidence {
  kind:'IP_PLAN_BLOCKED'|'IP_IMAGE_BLOCKED'; workflowId:string; resultId:string; callId:string; planResultId:string; candidateId:string|null;
  contextSha256:string; draftRevision:number; references:{id:string;sha256:string}[]; policyVersion:string; message:string;
}
export interface AutomaticListingOutcome {
  version:1; kind:AutomaticOutcomeKind; code:string; message:string; classifiedAt:string;
  scope:{mode:'demo'|'live';sellerId:string;marketplaceId:string;productId:string;recipeKey:string;recipeStamp:string;sourceStamp:string;rulesStamp:string;ruleRevision:number};
  draftId:string|null; draftRevision:number|null;
  /** Validated business profit evidence; SKU_SELECTION_FILTERED has no pricing report. */
  pricingReport?:import('./listing-rules.ts').BusinessRuleReport;
  image?:AutomaticRuleEvidence;
}
export type AutomaticQueueNotice = 'RULES_CHANGED'|'SOURCE_CHANGED'|'RECIPE_CHANGED'|'DRAFT_CHANGED'|'PRICING_CHANGED'|'IMAGE_EVIDENCE_CHANGED'|'UNKNOWN_RECONCILED'|'EVIDENCE_READ_FAILED';
export interface AutomaticQueueRow {
  noticeCode?:AutomaticQueueNotice;continuationRequired?:boolean;
  reasonCode?:string;
  key:string;productId:string;recipeKey:string;specification:string;sku:string|null;
  kind:AutomaticOutcomeKind|'PENDING'|'SUBMITTED'|'COMPLETED';eligible:boolean;message:string;reconsideration:string|null;taskId:string|null;
}
export interface AutomaticListingQueue {
  targetId:string; scope:{mode:'demo'|'live';sellerId:string;marketplaceId:string};ruleRevision:number;
  products:{productId:string;title:string;eligibleCount:number;pendingCount:number;filteredCount:number;profitFilteredCount?:number;notSelectedCount?:number;inputIssue?:string;rows:AutomaticQueueRow[]}[];
}
export interface AutomaticSchemaRetry {
  version: 1;
  scope: string;
  selection: import('./amazon-contracts.ts').SchemaSelection;
  originalStage: AutomaticListingStage;
  firstFailureAt: string;
  dueAt: string;
  deadlineAt: string;
  usedDelayedRounds: number;
  state: 'WAITING' | 'IN_FLIGHT' | 'SUCCEEDED' | 'EXHAUSTED';
  reason: 'SCHEMA_TRANSIENT';
}
export interface AutomaticListingItem {
  batchWait?:{operationId:string};
  schemaRetry?: AutomaticSchemaRetry;
  /** Written in the same SQLite transaction as the local pricing draft update. */
  pricingRefresh?: { draftRevision:number; draftStamp:string; previousDraftRevision:number; previousDraftStamp:string; previousReason:string|null };
  rejection?:{workflowId:string;detail:NonNullable<import('./image-workflow-contracts.ts').ImageWorkflowRun['rejection']>};
  key: string; productId: string; productRevision: number; sourceStamp: string; productTitle: string;
  variantId: string; sku: string; stockSets: number; sourcesPrepared: boolean;
  status: 'PENDING' | 'RUNNING' | 'WAITING' | 'DONE' | 'FAILED' | 'SCREENED';
  outcome?:AutomaticListingOutcome;
  observationFailureStamp?:string;
  stage: AutomaticListingStage; draftId: string | null; executionTaskIds: string[];
  imageStarted: boolean; imageAttempts: number; repairAttempts: number;
  repairPolicyVersion?: typeof FIELD_REPAIR_POLICY_VERSION;
  /** A one-time extra request for legacy exhausted tasks; the original attempts stay counted. */
  repairPolicyMigration?: { version: typeof FIELD_REPAIR_POLICY_VERSION; previousAttempts: 2; grantedAttempts: 1; grantedAt: string; fields: FieldRepairMigrationField[] };
  legacyThemeRepair?: { version: 'legacy-theme-parser/v1'; operationId:string; previousAttempts:4; grantedAttempts:1; grantedAt:string; fields:['theme'] };
  categoryFieldPolicyVersion?:typeof CATEGORY_FIELD_REPAIR_POLICY_VERSION;
  categoryFieldRepair?:CategoryFieldRepairGrant & {previousAttempts:2|3|4};
  /** Last confirmed source-color evidence actually used by a field repair request. */
  sourceColorEvidenceSha256?: string;
  /** One extra repair for newly available color evidence; old attempts remain counted. */
  sourceColorRepair?: { evidenceSha256: string; previousAttempts: 2 | 3 | 4; grantedAttempts: 1; grantedAt: string };
  repair: { businessAuthorityRefresh?: 'business-authority/v1'; operationId?: string; phase: 'FIELDS_PENDING' | 'FIELDS_STARTED' | 'RECHECK_PENDING' | 'READY'; sourceWorkflowId: string; draftRevision: number; draftStamp: string; remaining?: string[] } | null;
  batchId: string | null; error: string | null;
  classification?: ProductClassification;
  salesPlan?: import('./sales-plan-contracts.ts').SalesListingPlan;
  parentDraftId?: string;
  /** Durable same-SKU family conversion; old images and execution records remain traceable. */
  familyTransition?: { phase:'BIND'|'RECHECK'|'READY'; plan:import('./sales-plan-contracts.ts').SalesListingPlan; sourceWorkflowId:string; draftRevision:number; draftStamp:string };
}
export interface AutomaticListingTask {
  executionMode?:import('./ai-batch-contracts.ts').ListingExecutionMode;
  batchPlan?:import('./ai-batch-contracts.ts').TaskBatchPlan;
  adaptation?:{version:1;token:string;at:string;blockedKeys:string[];previousRules:{stamp:string;revision:number}[]};
  id: string; revision: number; status: AutomaticListingStatus;
  targetId: string; targetName: string; sellerId: string; marketplaceId: string; mode: 'demo' | 'live';
  targetStamp: string; profileId: string; profileStamp: string; rulesStamp: string; ruleRevision: number;
  productType: string; locale: string; labelFormat: ItemLabelFormat; items: AutomaticListingItem[];
  createdAt: string; updatedAt: string; error: string | null;
}
export interface StartAutomaticListingInput { workBatchId?:string; executionMode?:import('./ai-batch-contracts.ts').ListingExecutionMode; productIds: string[]; targetId: string; productType?: string; profileId: string }
export interface AutomaticListingApi {
  listAutomaticWorkBatches():Promise<import('./automatic-work-batches.ts').AutomaticWorkBatch[]>;
  archiveAutomaticWorkBatch(id:string):Promise<import('./automatic-work-batches.ts').AutomaticWorkBatch>;
  addAutomaticWorkBatchProducts(input:{batchId:string;productIds:string[]}):Promise<import('./automatic-work-batches.ts').AutomaticWorkBatch>;
  getAutomaticBatchSummary(id:string):Promise<import('./ai-batch-contracts.ts').TaskBatchSummary>;
  setAutomaticExecutionMode(input:{taskId:string;mode:import('./ai-batch-contracts.ts').ListingExecutionMode}):Promise<AutomaticListingTask>;
  getAutomaticBatchPlan():Promise<import('./ai-batch-contracts.ts').TaskBatchPlan>;
  previewAutomaticListingAdaptation(id:string):Promise<AutomaticAdaptationPreview>;
  applyAutomaticListingAdaptation(input:{taskId:string;token:string}):Promise<AutomaticListingTask>;
  getAutomaticListingQueue(input:{productIds:string[];targetId:string}):Promise<AutomaticListingQueue>;
  startAutomaticListing(input: StartAutomaticListingInput): Promise<AutomaticListingTask | null>;
  listAutomaticListingTasks(): Promise<AutomaticListingTask[]>;
  getAutomaticListingTask(id: string): Promise<AutomaticListingTask>;
  resumeAutomaticListingTask(id: string): Promise<AutomaticListingTask | null>;
  pauseAutomaticListingTask(id: string): Promise<AutomaticListingTask>;
  cancelAutomaticListingTask(id: string): Promise<AutomaticListingTask>;
}

export interface AutomaticAdaptationChange { key:string; productId:string; sku:string|null; kind:'SOURCE'|'RULES'|'SELECTED'|'NOT_SELECTED'|'NEW'|'DRAFT'|'RISK_RECHECK'|'PRESERVED'|'BLOCKED'; steps:string[]; fields:string[]; message:string }
export interface AutomaticAdaptationPreview { taskId:string; taskRevision:number; token:string; canApply:boolean; blockers:string[]; changes:AutomaticAdaptationChange[]; sources:import('./contracts.ts').ProductDetail[] }
