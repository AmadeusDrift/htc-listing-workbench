import type { AutomaticListingItem, AutomaticListingTask } from './automatic-listing-contracts.ts';
import type { AutomaticItemOutcome } from './automatic-status-projection.ts';
export type AutomaticPageSize = 20 | 50 | 100;
export interface AutomaticPageInput { page:number; pageSize:AutomaticPageSize }
export interface AutomaticTaskQuery extends AutomaticPageInput { taskId:string; revision:number }
export interface AutomaticRevisionConflict { kind:'revision-conflict'; taskId:string; revision:number }
export interface AutomaticTaskSummary extends Pick<AutomaticListingTask,'id'|'revision'|'status'|'targetName'|'mode'|'productType'|'ruleRevision'|'createdAt'|'updatedAt'|'error'> {
 sourceProductIds:string[]; sourceProductCount:number; salesSkuCount:number; counts:Record<AutomaticItemOutcome,number>;
}
/** workBatchId reads current persisted membership; it cannot be combined with taskIds. */
export interface AutomaticTaskSummariesInput extends AutomaticPageInput { taskIds?:string[]; workBatchId?:string }
export interface AutomaticTaskSummariesPage extends AutomaticPageInput { rows:AutomaticTaskSummary[]; total:number; active:boolean; lifecycleSignature:string }
export interface AutomaticTaskItemSummary extends Pick<AutomaticListingItem,'key'|'productId'|'variantId'|'sku'|'status'|'stage'|'draftId'|'stockSets'|'imageStarted'|'imageAttempts'|'batchId'> {
 specification:string; color:string; sourceVariantIds:string[]; parentSku:string|null; familyKey:string; familyResolved:boolean; independent:boolean;
 outcome:AutomaticItemOutcome; reason:string; hasError:boolean;
}
export interface AutomaticTaskGroupSummary {
 productId:string; title:string; items:AutomaticTaskItemSummary[];
 counts:Record<AutomaticItemOutcome,number>;
}
/** Groups preserve first occurrence in the original task. Search filters whole groups before paging. */
export interface AutomaticTaskGroupsPage extends AutomaticPageInput { kind:'page'; task:AutomaticTaskSummary; groups:AutomaticTaskGroupSummary[]; total:number }
export interface AutomaticResumeItemsPage extends AutomaticPageInput { kind:'page'; rows:Pick<AutomaticListingItem,'key'|'sku'|'stage'|'draftId'>[]; total:number }
export type AutomaticTaskItemResult = {kind:'item';taskId:string;revision:number;item:AutomaticListingItem}|AutomaticRevisionConflict;
export interface AutomaticTaskQueryApi {
 queryAutomaticTaskSummaries(input:AutomaticTaskSummariesInput):Promise<AutomaticTaskSummariesPage>;
 queryAutomaticTaskGroups(input:AutomaticTaskQuery&{search:string}):Promise<AutomaticTaskGroupsPage|AutomaticRevisionConflict>;
 getAutomaticTaskItem(input:{taskId:string;revision:number;itemKey:string}):Promise<AutomaticTaskItemResult>;
 queryAutomaticResumeItems(input:AutomaticTaskQuery):Promise<AutomaticResumeItemsPage|AutomaticRevisionConflict>;
}
