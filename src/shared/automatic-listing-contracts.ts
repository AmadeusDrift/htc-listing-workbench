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
export interface AutomaticListingItem {
  key: string; productId: string; productRevision: number; sourceStamp: string; productTitle: string;
  variantId: string; sku: string; stockSets: number; sourcesPrepared: boolean;
  status: 'PENDING' | 'RUNNING' | 'WAITING' | 'DONE' | 'FAILED';
  stage: AutomaticListingStage; draftId: string | null; executionTaskIds: string[];
  imageStarted: boolean; imageAttempts: number; repairAttempts: number;
  repairPolicyVersion?: typeof FIELD_REPAIR_POLICY_VERSION;
  /** A one-time extra request for legacy exhausted tasks; the original attempts stay counted. */
  repairPolicyMigration?: { version: typeof FIELD_REPAIR_POLICY_VERSION; previousAttempts: 2; grantedAttempts: 1; grantedAt: string; fields: FieldRepairMigrationField[] };
  categoryFieldPolicyVersion?:typeof CATEGORY_FIELD_REPAIR_POLICY_VERSION;
  categoryFieldRepair?:CategoryFieldRepairGrant & {previousAttempts:2|3|4};
  /** Last confirmed source-color evidence actually used by a field repair request. */
  sourceColorEvidenceSha256?: string;
  /** One extra repair for newly available color evidence; old attempts remain counted. */
  sourceColorRepair?: { evidenceSha256: string; previousAttempts: 2 | 3 | 4; grantedAttempts: 1; grantedAt: string };
  repair: { phase: 'FIELDS_PENDING' | 'FIELDS_STARTED' | 'RECHECK_PENDING' | 'READY'; sourceWorkflowId: string; draftRevision: number; draftStamp: string; remaining?: string[] } | null;
  batchId: string | null; error: string | null;
  classification?: ProductClassification;
  salesPlan?: import('./sales-plan-contracts.ts').SalesListingPlan;
  parentDraftId?: string;
  /** Durable same-SKU family conversion; old images and execution records remain traceable. */
  familyTransition?: { phase:'BIND'|'RECHECK'|'READY'; plan:import('./sales-plan-contracts.ts').SalesListingPlan; sourceWorkflowId:string; draftRevision:number; draftStamp:string };
}
export interface AutomaticListingTask {
  id: string; revision: number; status: AutomaticListingStatus;
  targetId: string; targetName: string; sellerId: string; marketplaceId: string; mode: 'demo' | 'live';
  targetStamp: string; profileId: string; profileStamp: string; rulesStamp: string; ruleRevision: number;
  productType: string; locale: string; labelFormat: ItemLabelFormat; items: AutomaticListingItem[];
  createdAt: string; updatedAt: string; error: string | null;
}
export interface StartAutomaticListingInput { productIds: string[]; targetId: string; productType?: string; profileId: string }
export interface AutomaticListingApi {
  startAutomaticListing(input: StartAutomaticListingInput): Promise<AutomaticListingTask | null>;
  listAutomaticListingTasks(): Promise<AutomaticListingTask[]>;
  getAutomaticListingTask(id: string): Promise<AutomaticListingTask>;
  resumeAutomaticListingTask(id: string): Promise<AutomaticListingTask | null>;
  pauseAutomaticListingTask(id: string): Promise<AutomaticListingTask>;
  cancelAutomaticListingTask(id: string): Promise<AutomaticListingTask>;
}
