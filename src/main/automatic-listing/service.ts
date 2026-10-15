import type {UnitImageRecheckInput} from '../image-workflow/unit-review.ts';
import { queryTaskSummaries, queryTaskGroups, getTaskItem, queryResumeItems, taskQueryId } from './task-query.ts';
import { readItemDiagnostic } from './item-diagnostic.ts';
import {readRoundSpend} from './round-spend.ts';
import {planCancelledTaskRecovery} from './cancelled-recovery.ts';
import {ControlledRunScopes,ControlledRunError,readControlledRunScope,pauseControlledRunScopes,revokeControlledRunGrant,type ControlledRunGrant} from '../application/controlled-run-scope.ts';
import { AiError,AI_ERROR_CODES } from '../ai/errors.ts';
import {categoryUnknownCode,categoryFailureRequestId} from '../ai/category-knowledge.ts';
import {CategoryNoSuitableError} from '../catalog/classification.ts';
import { validateResumeSelection, rowSelected, rememberFailure, sanitizeFailureReason } from '../../shared/automatic-resume.ts';
import type { AutomaticResumeSelection } from '../../shared/automatic-resume.ts';
import { listWorkBatches, currentWorkBatch, archiveWorkBatch, addWorkBatchProducts, bindWorkBatchTask } from './work-batches.ts';
import { appendAuditEvent } from '../storage/audit.ts';
import { appendRunEvidence, evidenceSku } from '../diagnostics/run-evidence.ts';
import { taskAiContext,BatchWaitingError } from '../ai/batch/task-context.ts';
import type { TaskBatchRuntime } from '../ai/batch/task-runtime.ts';
import type { TaskBatchPlan } from '../../shared/ai-batch-contracts.ts';
import { isSchemaTransientError, type SchemaTransientError } from '../amazon/schema-retry.ts';
import { canResumeRiskAdaptation } from './risk-adaptation.ts';
import { adaptationSteps, applyAdaptationRows, assertTaskAdaptationHistory,onlyUnitAdaptationBlock } from './adaptation.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import { needsBusinessAuthorityRefresh, manualBrandIssues } from '../image-workflow/policy-reevaluation.ts';
import { automaticRuleOutcome } from '../../shared/automatic-status-projection.ts';
import { presentRejection } from '../../shared/rejection-presentation.ts';
import { assertAutomaticRejectionHistory } from './rejection-history.ts';
import { readSourceImageReceipt, sourceImageReceipt } from '../source-images.ts';
import {validateSourceImageProvenance,assertSourceImageProvenance} from '../source-image-provenance.ts';
import {validateConsistencyBinding} from '../source-image-consistency/history.ts';
import { assertProductConsistency,sourceConsistencyUnknown,sourceConsistencyPresentation,SourceConsistencyError } from '../source-image-consistency/proof.ts';
import { assertCurrentPricingForPaid } from './outcomes.ts';
import { pricingQualificationIssue } from '../pricing/qualification.ts';
import { freezeSourceForProduct,readSourceAdoption } from '../products/source-adoption.ts';
import { transaction } from '../application/transaction.ts';
import { readSchemaOperation, saveSchemaOperation, planSchemaAttempt, reserveSchemaAttempt } from '../catalog/schema-operations.ts';
import { FACT_AUTHORITY_REQUIRED, FACT_SOURCE_CONFLICT } from '../amazon/fact-authority.ts';
import { CompletionJournal, completionSafetyIdentity } from '../listing-ai/completion-journal.ts';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { AutomaticListingItem, AutomaticListingTask } from '../../shared/automatic-listing-contracts.ts';
import { FIELD_REPAIR_POLICY_VERSION, CATEGORY_FIELD_REPAIR_POLICY_VERSION } from '../../shared/automatic-listing-contracts.ts';
import type { ListingRules } from '../../shared/listing-rules.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { WorkspaceStore } from '../store.ts';
import type { AmazonService } from '../amazon/service.ts';
import type { HostingService } from '../hosting/service.ts';
import type { ImageWorkflowService } from '../image-workflow/service.ts';
import type { ExecutionService } from '../execution/service.ts';
import type { FollowupService } from '../followup/service.ts';
import type { ProcurementService } from '../procurement/service.ts';
import type { ItemLabelService } from '../item-labels/service.ts';
import type { ItemLabelFormat } from '../../shared/item-label-contracts.ts';
import { validateItemLabelFormat } from '../item-labels/adapter.ts';
import { openDatabase } from '../database.ts';
import { identifier, record, text } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { publicError } from '../security.ts';
import { recordErrorEvidence } from '../error-evidence.ts';
import { fingerprint } from '../execution/records.ts';
import {DIRECT_HOSTING_ROUTE,profileWithHostingRoute} from '../../shared/hosting-contracts.ts';
import { sourceStamp, validateAutomaticListingTask } from './records.ts';
import { imageWorkflowDraftStamp } from "../image-workflow/approval-reuse.ts";
import type { ProductClassification } from '../../shared/category-ai-contracts.ts';
import type { SalesListingPlan } from '../../shared/sales-plan-contracts.ts';
import { projectSalesProduct, validateSalesPlan, validateSalesRecipe } from '../sales-plans/records.ts';
import { DECLARATION_SOURCE_CONFLICT } from '../amazon/declaration-safety.ts';
import { reconcileSalesIdentity } from '../sales-plans/reconciliation.ts';
import { FAMILY_REBIND_EVENT_SUMMARY } from '../amazon/service.ts';
import { canResumeImageWorkflow, hasSevenApprovedImages, AUTOMATIC_SOURCE_ISSUES } from '../../shared/image-workflow-contracts.ts';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import type { MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import { sourceImageMappingDiagnosis } from '../image-workflow/sources.ts';
import { categoryRepairFields, newlyRepairableFields, nonDeferredImageIssues, pricingBlockingReason, withoutDeferredImageRemaining, withoutHistoricalPricingRemaining } from '../image-workflow/deferred-fields.ts';
import type { AutomaticListingOutcome, AutomaticListingQueue, AutomaticQueueRow, AutomaticRuleEvidence } from '../../shared/automatic-listing-contracts.ts';
import { outcomeScope, pricingOutcome, pricingEvidenceCurrent, qualifiedPricing, recipeKey } from './outcomes.ts';
import { previewSalesRecipes } from '../sales-plans/planning.ts';
import { selectSalesRecipes } from '../sales-plans/selection.ts';
import { AutomaticTaskCheckpoints,type TaskCheckpointChange } from './checkpoints.ts';

export interface AutomaticListingDependencies {
  /** Main-only controlled-window boundary; unrelated persisted tasks stay read-only. */
  canManageTask?: (taskId:string)=>boolean;
  admitTask?: (task:AutomaticListingTask)=>void;
  batch?:TaskBatchRuntime;batchPlan?:()=>TaskBatchPlan;
  store: Pick<WorkspaceStore, 'getProduct'> & Partial<Pick<WorkspaceStore,'getProductSnapshot'|'hasProducts'>>;
  rules(): ListingRules;
  amazon: Pick<AmazonService, 'executionTargetScope' | 'getDraft' | 'listDrafts' | 'prepareDrafts'> & Partial<Pick<AmazonService, 'getSchema' | 'applyBusinessDefaults' | 'previewPricing' | 'previewTaskAdaptation' | 'applyTaskAdaptation'|'previewSalesUnitAdoption'|'applySalesUnitAdoption'>>;
  hosting: Pick<HostingService, 'getProfile'> & Partial<Pick<HostingService,'listUploads'|'checkLocalAssets'>>;
  images: Pick<ImageWorkflowService, 'prepareSources' | 'complete' | 'getProgress' | 'cancel' | 'cancelSources'> & {
    inspectApproval?:ImageWorkflowService['inspectApproval'];
    getPlanningUnknown?:ImageWorkflowService['getPlanningUnknown'];
    canResumeUnitRecheckDraft?:ImageWorkflowService['canResumeUnitRecheckDraft'];
    hasHistoricalRetryAllowance?: (draftId:string)=>boolean;
    getRiskSettings?: () => {enabled:boolean};
    isRiskPolicyCompatible?: (run:ImageWorkflowRun) => boolean;
    getCopyReviewSettings?: () => {enabled:boolean};
    isCopyReviewPolicyCompatible?: (run:ImageWorkflowRun) => boolean;
    canResumeRecheckDraft?: ImageWorkflowService['canResumeRecheckDraft'];
    getRuleFilterEvidence?: (draftId:string)=>Promise<AutomaticRuleEvidence|null>;
  };
  execution: Pick<ExecutionService, 'create' | 'prepareStart' | 'startAuthorized' | 'get' | 'list' | 'pause' | 'cancel' | 'waitForIdle'> & Partial<Pick<ExecutionService,'hasPendingSubmission'>>;
  followup: Pick<FollowupService, 'get' | 'schedule'>;
  procurement: Pick<ProcurementService, 'candidates' | 'ensureAutomaticBatch'> & Partial<Pick<ProcurementService, 'candidatesForObservation'>>;
  labels: Pick<ItemLabelService, 'syncBatch' | 'list'> & Partial<Pick<ItemLabelService, 'pauseJob' | 'resumeJob' | 'cancelJob'>>;
  labelFormat?(): ItemLabelFormat;
  /** Main-only final field repair + re-review of the existing image; never generates another image. */
  beginLegacyThemeRepair?: (draftId:string,row:AutomaticListingItem,workflow:ImageWorkflowRun)=>string|undefined;
  beginFieldRepair?: (draftId:string)=>string;
  repairFields?: (draftId: string, signal: AbortSignal, operationId?:string) => Promise<AmazonDraft | { draft: AmazonDraft; remaining: string[] }>;
  prepareSourceColors?: (draftId: string, signal: AbortSignal) => Promise<{ aiCalls: number; evidenceChanged: boolean; evidenceSha256?: string }>;
  prepareSourceConsistency?: (input:{productId:string;productRevision:number;variantIds:string[]},signal:AbortSignal,assertFresh:()=>void)=>Promise<void>;
  recheckUnitImage?:(input:UnitImageRecheckInput,signal:AbortSignal,authorize:()=>boolean)=>Promise<AmazonDraft>;
  recheckImage?: (input: { draftId: string; draftRevision: number; sourceWorkflowId: string }, signal: AbortSignal) => Promise<AmazonDraft>;
  preflight?: () => void;
  sourceReceipt?: (productId: string) => MiaoshouReceipt | null;
  classify?: (input: { productId: string; productRevision: number; targetId: string }, signal: AbortSignal) => Promise<ProductClassification>;
  planSalesForAdaptation?: (source:ProductDetail,targetId:string,db:DatabaseSync)=>SalesListingPlan[];
  planSales?: (productId:string,targetId:string) => SalesListingPlan[];
  previewSales?: (productId:string) => SalesListingPlan['recipe'][];
  existingSale?: (productId:string,plan:SalesListingPlan,targetId:string) => AmazonDraft|undefined;
  resolveFamily?: (input:{plans:SalesListingPlan[];targetId:string;productType:string;locale:string},signal:AbortSignal) => Promise<SalesListingPlan[]>;
  ensureParent?: (child:AmazonDraft,profileId:string,signal:AbortSignal,hostingRoute?:import('../../shared/hosting-contracts.ts').HostingRoute) => Promise<{draftId:string;ready:boolean}>;
  rebindFamily?: (input:{id:string;revision:number;plan:SalesListingPlan},signal:AbortSignal) => Promise<AmazonDraft>;
}
const recoverableAiUnknown=(code:string|null):boolean=>code!==null&&['SOURCE_CONSISTENCY_SENT_UNKNOWN','FIELD_RESULT_UNKNOWN','IMAGE_RESULT_UNKNOWN','CATEGORY_RESULT_UNKNOWN','CATEGORY_EXPANSION_RESULT_UNKNOWN'].includes(code);
const adaptationBlocked=(task:AutomaticListingTask,key:string):boolean=>!!task.adaptation?.blockedKeys.includes(key)&&!task.adaptation.unitResolvedKeys?.includes(key);
const submitted = (draft: AmazonDraft): boolean => !!draft.submittedAt || ['SUBMITTING','SUBMITTED','PROCESSING','BUYABLE','DISCOVERABLE','UNKNOWN'].includes(draft.state);
const final = (task: AutomaticListingTask): boolean => ['COMPLETED','CANCELLED'].includes(task.status);
const imageReady = hasSevenApprovedImages;
const errorMessage = (error: unknown): string => publicError(error).slice(0, 2000);
const frozenSourcesMessage = '同商品已有就绪 SKU，来源版本已冻结。请在“来源图片”下载所需图片，并在“图片工作区 → 关联 SKU”确认对应关系；其他已就绪 SKU 全部提交后，可继续本任务恢复未开始的 SKU。若仍有未完成草稿，请先完成或取消原任务，再建立新任务。';
function fieldRepairRemaining(draft: AmazonDraft, rules: ListingRules, remaining: string[] = []): string[] {
  const issues = nonDeferredImageIssues(draft);
  const pricing=pricingBlockingReason(draft,rules);
  return [...new Set([...(pricing?[pricing]:[]), ...withoutDeferredImageRemaining(draft,withoutHistoricalPricingRemaining(draft,remaining,rules)), ...issues.map(issue => `${issue.attributeNames.join('、') || issue.code}：${issue.message}`)])].slice(0,100).map(message=>message.slice(0,2000));
}
const incompleteFields = (remaining: string[]) => new UserFacingError(`字段修复后仍有待处理项，已停止图片复核：${remaining.join('；')}`);
const repairLimit = (row: AutomaticListingItem): number => 2 + (row.repairPolicyMigration?.grantedAttempts ?? 0) + (row.sourceColorRepair?.grantedAttempts ?? 0) + (row.categoryFieldRepair?.grantedAttempts ?? 0) + (row.legacyThemeRepair?.grantedAttempts ?? 0);
const canMigrateCategory=(row:AutomaticListingItem,draft:AmazonDraft):boolean=>!row.categoryFieldPolicyVersion&&!row.categoryFieldRepair&&row.repair?.phase!=='FIELDS_STARTED'&&categoryRepairFields(draft,row.repair?.remaining).length>0;
const needsSourceColor = (draft: AmazonDraft, remaining: string[] = []): boolean =>
  [...nonDeferredImageIssues(draft),...draft.listingIssues.filter(issue=>issue.severity==='ERROR')].some(issue=>issue.attributeNames.includes('color'))
  || remaining.some(message=>/^(?:color\b|颜色)(?:\s|[:：、]|$)/iu.test(message.trim()));

/** Main-process state machine. Approval is volatile, while every costly/write intent is durable. */
export class AutomaticListingService {
  private directory:string;
  private db: DatabaseSync;
  private deps: AutomaticListingDependencies;
  private tasks = new Map<string, AutomaticListingTask>();
  private continuations=new Map<string,{at:string;fromStart:boolean;prepared:Set<string>}>();
  private rounds=new Map<string,{roundId:string;startedAt:string;mode:'continue'|'from-start';taskRevision:number}|null>();
  private checkpoints = new AutomaticTaskCheckpoints();
  private checkpointDataVersions=new Map<string,number>();
  private progressListeners=new Set<(value:ReturnType<AutomaticListingService['getOperationProgress']>)=>void>();
  private progressValue:{taskId:string|null;phase:'PREPARING'|'VERIFYING'|'SAVING';completed:number;total:number;message:string}|null=null;
  private progressNotifiedAt=0;
  private get operationProgress(){return this.progressValue;}
  private set operationProgress(value:typeof this.progressValue){
    const prior=this.progressValue;this.progressValue=value;const now=performance.now();
    if(value&&prior&&value.taskId===prior.taskId&&value.phase===prior.phase&&value.total===prior.total&&value.completed!==value.total&&now-this.progressNotifiedAt<100)return;
    this.progressNotifiedAt=now;for(const listener of this.progressListeners){try{listener(value?{...value}:null);}catch{/* UI subscribers cannot grant, block or roll back business writes. */}}
  }
  getOperationProgress(){return this.operationProgress?{...this.operationProgress}:null;}
  onOperationProgress(listener:(value:ReturnType<AutomaticListingService['getOperationProgress']>)=>void):()=>void{this.progressListeners.add(listener);try{listener(this.getOperationProgress());}catch{/* A closed window cannot change workflow authority. */}return ()=>{this.progressListeners.delete(listener);};}
  getItemChangeStamp(taskId:string,key:string):string|null{return this.checkpoints.itemStamp(taskId,key);}
  private grants = new Set<string>();
  private controlledRuns:ControlledRunScopes;
  private controlledGrants=new Map<string,ControlledRunGrant>();
  private confirming = new Set<string>();
  private worker: Promise<void> | null = null;
  private wakeRows?:()=>void;
  private observing: Promise<void> | null = null;
  private previewFlights = new Map<string, Promise<ReturnType<AutomaticListingService['previewAdaptation']>>>();
  private controller: AbortController | null = null;
  private activeId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private schedulingSuspended = false;
  private closing: Promise<void> | null = null;
  private archiving = false;
  constructor(directory: string, dependencies: AutomaticListingDependencies) {
    this.directory=directory;this.deps = dependencies; this.db = openDatabase(directory);
    this.controlledRuns=new ControlledRunScopes(this.db);
    try {
      this.pauseManagedControlledScope();
      for (const saved of this.db.prepare('SELECT id,record_json FROM automatic_listing_tasks ORDER BY rowid').all()) {
        const task = validateAutomaticListingTask(JSON.parse(String(saved.record_json)));
        for(const row of task.items)if(row.schemaRetry){const operation=readSchemaOperation(this.db,task.id,row.key,row.schemaRetry.scope);if(operation)Object.assign(row.schemaRetry,operation.budget);}
        assertAutomaticRejectionHistory(this.db,task);assertTaskAdaptationHistory(this.db,task);
        if (task.id !== saved.id) throw new UserFacingError('自动任务身份不一致');
        this.tasks.set(task.id, task);
        this.checkpoints.remember(task);
        if (this.canManage(task.id) && ['QUEUED','RUNNING','WAITING'].includes(task.status)) {
          this.deps.batch?.stop(task.id);task.status = 'PAUSED'; task.error = '工作台曾中断，已保留进度；继续任务前会核对范围，不会自动重发未知生图或提交。';
          for (const row of task.items) { if(row.schemaRetry?.state==='IN_FLIGHT')row.schemaRetry.state='WAITING'; if (row.status === 'RUNNING') row.status = 'PENDING'; }
          this.save(task);
        }
      }
    } catch (error) { this.db.close(); throw error; }
    const dataVersion=Number(this.db.prepare('PRAGMA data_version').get()!.data_version);for(const id of this.tasks.keys())this.checkpointDataVersions.set(id,dataVersion);
  }
  private pauseManagedControlledScope():void{const scope=readControlledRunScope(this.db);if(!scope||this.canManage(scope.taskId))pauseControlledRunScopes(this.db);}
  private canManage(id:string):boolean{return this.deps.canManageTask?.(id)??true;}
  private assertManaged(id:string):void{if(!this.canManage(id))throw new UserFacingError('受控验收窗口不能修改或调度其他任务');}
  private managedTasks():AutomaticListingTask[]{return [...this.tasks.values()].filter(task=>this.canManage(task.id));}
  private ensureOpen(): void { if (this.closed || this.closing) throw new UserFacingError('自动任务服务正在停止'); }
  private task(id: string): AutomaticListingTask { this.ensureOpen(); const result = this.tasks.get(identifier(id)); if (!result) throw new UserFacingError('自动任务不存在'); return result; }
  private save(task: AutomaticListingTask, db:DatabaseSync=this.db, completed: { key: string; stage: AutomaticListingItem['stage'] }[] = [], at?:string,changedKeys?:readonly string[]): void {
    if(this.tasks.has(task.id))this.assertManaged(task.id);
    const priorRevision=task.revision,priorUpdatedAt=task.updatedAt;
    let savedChange:TaskCheckpointChange|undefined;
    let partialPersistedCheck=false;
    try{transaction(db,()=>{
    const persisted=db.prepare("SELECT json_extract(record_json,'$.revision') revision FROM automatic_listing_tasks WHERE id=?").get(task.id);
    if(persisted&&persisted.revision!==task.revision)throw new UserFacingError('任务检查点已变化，未覆盖较新的暂停或执行结果');
    // Other owner connections may have committed while a request was awaiting.
    // Never reuse the in-memory proof over an unobserved persisted-task change,
    // even when an invalid writer forgot to advance the task revision.
    const dataVersion=Number(this.db.prepare('PRAGMA data_version').get()!.data_version);
    if(persisted&&(db!==this.db||this.checkpointDataVersions.get(task.id)!==dataVersion)){
      const scopedKeys=changedKeys===undefined?undefined:[...changedKeys,...completed.map(result=>result.key)];
      const indices=this.checkpoints.persistedIndices(task,scopedKeys);
      if(indices!==null){
        const columns=indices.map((index,offset)=>`,json_extract(record_json,'$.items[${index}]') item_${offset}`).join('');
        const saved=db.prepare(`SELECT json_remove(record_json,'$.items') metadata${columns} FROM automatic_listing_tasks WHERE id=?`).get(task.id)!;
        const metadata=JSON.parse(String(saved.metadata)),items=indices.map((_index,offset)=>JSON.parse(String(saved[`item_${offset}`])));
        if(!this.checkpoints.matchesPersistedParts(task.id,metadata,indices,items))throw new UserFacingError('任务检查点已变化，请重新读取原任务；未覆盖历史');
        // Only these SKU slots were checked. Keep the task-wide data version
        // dirty so another externally changed SKU is checked before its write.
        partialPersistedCheck=true;
      }else{
      const savedTask=JSON.parse(String(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id)!.record_json));
      // Unrelated AI/hosting commits invalidate SQLite's connection-wide version,
      // not this already validated immutable task. Exact equality needs no second
      // full task parser. A changed body still takes the original strict path.
      if(!this.checkpoints.matches(savedTask)){
        const durable=validateAutomaticListingTask(savedTask);
        if(this.checkpoints.revision(task.id)===durable.revision)throw new UserFacingError('任务检查点已变化，请重新读取原任务；未覆盖历史');
        // A caller explicitly reloaded a newer legitimate revision (or an outer
        // transaction rolled back). Rebuild the whole proof, never incrementally
        // validate against the stale in-memory checkpoint.
        assertAutomaticRejectionHistory(db,durable);assertTaskAdaptationHistory(db,durable);this.checkpoints.remember(durable);
      }
      }
    }
    task.revision++; task.updatedAt = at??new Date().toISOString();
    const change=savedChange=this.checkpoints.prepare(task,false,completed.map(result=>result.key),items=>{for(const row of items)if(row.schemaRetry)Object.assign(row.schemaRetry,saveSchemaOperation(db,task.id,row.key,row.schemaRetry));},changedKeys??(completed.length?completed.map(result=>result.key):undefined));
    this.controlledRuns.advanceTaskInTransaction(db,task,persisted?Number(persisted.revision):null);
    assertAutomaticRejectionHistory(db,{...task,items:change.items});assertTaskAdaptationHistory(db,task);
    this.checkpoints.write(db,task,change,persisted?Number(persisted.revision):null);
    for (const row of change.items) {
      const prior = change.priorStages.get(row.key), context = { version: 1 as const, at: task.updatedAt, taskId: task.id, itemKey: row.key, ...(evidenceSku(row.sku) ? { sku: row.sku } : {}), ...(row.draftId ? { draftId: row.draftId } : {}) };
      try {
        // Checkpoint movement can also mean reuse, rewind or unresolved submission.
        // Completion comes only from the service boundary that checked its result.
        for (const result of completed.filter(result => result.key === row.key)) appendRunEvidence(db, row.productId, { ...context, event: 'STAGE_COMPLETED', stage: result.stage });
        if ((!prior || prior.stage !== row.stage || prior.status !== 'RUNNING' && row.status === 'RUNNING') && row.status === 'RUNNING') appendRunEvidence(db, row.productId, { ...context, event: 'STAGE_STARTED', stage: row.stage });
        if (row.status === 'FAILED' && prior?.status !== 'FAILED') appendRunEvidence(db, row.productId, { ...context, event: 'STAGE_BLOCKED', stage: row.stage, ...(row.outcome?.kind === 'UNKNOWN' ? { certainty: 'SENT_UNKNOWN' as const } : {}) });
        if (row.status === 'DONE' && prior?.status !== 'DONE') appendRunEvidence(db, row.productId, { ...context, event: 'STAGE_COMPLETED', stage: row.stage });
      } catch { /* State remains authoritative; only actual changes append diagnostic events. */ }
    }
    });this.checkpoints.remember(task,savedChange);if(!partialPersistedCheck)this.checkpointDataVersions.set(task.id,Number(this.db.prepare('PRAGMA data_version').get()!.data_version));
    }catch(error){task.revision=priorRevision;task.updatedAt=priorUpdatedAt;throw error;}
    this.wakeRows?.();
  }
  private saveItem(task:AutomaticListingTask,row:AutomaticListingItem,db:DatabaseSync=this.db):void{this.save(task,db,[],undefined,[row.key]);}
  listWorkBatches() { this.ensureOpen(); return listWorkBatches(this.db); }
  addWorkBatchProducts(raw:unknown) {
    this.ensureOpen(); if(this.archiving)throw new UserFacingError('批次正在归档，请稍候');
    const input=record(raw,'批次商品',['batchId','productIds']),id=identifier(input.batchId);
    if(!Array.isArray(input.productIds)||!input.productIds.length||input.productIds.length>1000)throw new UserFacingError('请选择1–1000个商品');
    const ids=input.productIds.map(identifier);if(!this.deps.store.hasProducts?.(ids))throw new UserFacingError('加入批次的商品不存在，请刷新后重试');
    addWorkBatchProducts(this.db,id,ids);return currentWorkBatch(this.db,id);
  }
  async archiveWorkBatch(id:string) {
    this.ensureOpen(); if(this.archiving)throw new UserFacingError('批次正在归档，请稍候');
    const batch=currentWorkBatch(this.db,id);this.archiving=true;
    const release=this.holdForMaintenance();
    try {
      for(const taskId of batch.taskIds){const task=this.task(taskId);if(!final(task))this.pause(taskId);}
      await this.waitForIdle(); await this.deps.execution.waitForIdle();
      this.ensureOpen();
      for(const taskId of batch.taskIds)if(['RUNNING','QUEUED','WAITING'].includes(this.task(taskId).status))throw new UserFacingError('尚未确认停止本地调度，请稍后重试');
      return archiveWorkBatch(this.db,id);
    } finally {this.archiving=false;release();}
  }
  list(): AutomaticListingTask[] { this.ensureOpen(); return [...this.tasks.values()].reverse().map(task => structuredClone(task)); }
  get(id: string): AutomaticListingTask { return structuredClone(this.task(id)); }
  queryTaskSummaries(raw:unknown) { this.ensureOpen(); return queryTaskSummaries(this.tasks,raw,this.db,this.displayPresenter()); }
  queryTaskGroups(raw:unknown) { const {input,id}=taskQueryId(raw,['page','pageSize','search']); return queryTaskGroups(this.db,this.task(id),input,this.displayPresenter(),key=>this.getItemChangeStamp(id,key)); }
  getTaskItem(raw:unknown) { const {input,id}=taskQueryId(raw,['itemKey']),task=this.task(id),result=getTaskItem(task,input,(row,owner)=>this.displayItem(row,owner));return result.kind==='item'?{...result,diagnostic:readItemDiagnostic(this.db,task,result.item)}:result; }
  queryResumeItems(raw:unknown) { const {input,id}=taskQueryId(raw,['page','pageSize']); return queryResumeItems(this.task(id),input); }
  /** Owner query includes original rows whose draft was never created. */
  readSalesPlans(productId:string,targetId:string){
    this.ensureOpen();identifier(productId);identifier(targetId);
    return this.db.prepare("SELECT record_json FROM automatic_listing_tasks WHERE json_extract(record_json,'$.targetId')=? AND EXISTS(SELECT 1 FROM json_each(record_json,'$.items') i WHERE json_extract(i.value,'$.productId')=?)").all(targetId,productId).flatMap(saved=>{
      const task=validateAutomaticListingTask(JSON.parse(String(saved.record_json)));
      return task.items.filter(row=>row.productId===productId&&row.salesPlan).map(row=>({productId,targetId,sellerId:task.sellerId,marketplaceId:task.marketplaceId,mode:task.mode,plan:structuredClone(row.salesPlan!)}));
    });
  }
  private unitOwner(raw:unknown){
    const input=record(raw,'原任务计量采用',['taskId','taskRevision','itemKey','platformPieces','basis']),id=identifier(input.taskId),key=text(input.itemKey,'原任务行',200,true);
    if(!Number.isSafeInteger(input.taskRevision)||Number(input.taskRevision)<1)throw new UserFacingError('原任务版本无效');
    const memory=this.get(id),saved=this.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(id);
    if(!saved)throw new UserFacingError('原任务不存在');
    const task=validateAutomaticListingTask(JSON.parse(String(saved.record_json)));
    if(task.revision!==input.taskRevision||fingerprint(task)!==fingerprint(memory))throw new UserFacingError('原任务检查点已变化，请重新读取');
    if(!['PAUSED','NEEDS_ATTENTION'].includes(task.status)||this.activeId===id||this.confirming.has(id)||this.observing)throw new UserFacingError('原任务尚未安全暂停，请先等待在途处理结束');
    const row=task.items.find(r=>r.key===key);if(!row?.draftId||!row.salesPlan)throw new UserFacingError('原任务行缺少可采用的原草稿或销售配方');
    if(row.status==='RUNNING'||row.batchWait||row.schemaRetry?.state==='IN_FLIGHT'||row.familyTransition||row.repair?.phase==='FIELDS_STARTED'||['READBACK','LABELS','COMPLETE'].includes(row.stage)||this.unknownCode(row,task))throw new UserFacingError('原任务行有在途、提交或未知结果，请按原身份核对');
    const draft=this.deps.amazon.getDraft(row.draftId);
    const source=this.deps.store.getProductSnapshot?.(row.productId)??this.deps.store.getProduct(row.productId);
    if(!this.matching(task,row,draft)||draft.productRevision!==row.productRevision||source.revision!==row.productRevision||sourceStamp(source)!==row.sourceStamp||submitted(draft)||fingerprint(draft.salesPlan)!==fingerprint(row.salesPlan))throw new UserFacingError('原任务与草稿身份、冻结来源或销售配方不一致');
    return {input,task,row,draft};
  }
  previewSalesUnitAdoption(raw:unknown){
    const {input,task,row,draft}=this.unitOwner(raw),preview=this.deps.amazon.previewSalesUnitAdoption;
    if(!preview)throw new UserFacingError('计量预览服务不可用');
    const unitPreview=preview.call(this.deps.amazon,{id:draft.id,revision:draft.revision,taskId:task.id,...(input.platformPieces===undefined?{}:{platformPieces:input.platformPieces}),...(input.basis===undefined?{}:{basis:input.basis})});
    return {taskId:task.id,taskRevision:task.revision,itemKey:row.key,unitPreview,token:fingerprint({task,row,unitPreview})};
  }
  adoptSalesUnit(raw:unknown):AutomaticListingTask {
    const input=record(raw,'原任务计量确认',['taskId','taskRevision','itemKey','platformPieces','basis','token','confirmed']);
    if(input.confirmed!==true)throw new UserFacingError('请明确确认原销售单位差异');
    const request={taskId:input.taskId,taskRevision:input.taskRevision,itemKey:input.itemKey,platformPieces:input.platformPieces,basis:input.basis},token=text(input.token,'计量对照标识',64,true);
    const apply=this.deps.amazon.applySalesUnitAdoption;if(!apply)throw new UserFacingError('计量采用服务不可用');
    let committed:AutomaticListingTask|undefined;
    transaction(this.db,()=>{
      const preview=this.previewSalesUnitAdoption(request);if(preview.token!==token||!preview.unitPreview.canApply)throw new UserFacingError(preview.unitPreview.blockers.join('；')||'计量对照后原任务或资料已变化');
      const {task,row,draft}=this.unitOwner(request),before=structuredClone(task);
      const after=apply.call(this.deps.amazon,{id:draft.id,revision:draft.revision,platformPieces:input.platformPieces,basis:input.basis},preview.unitPreview.token,this.db,task.id);
      const images=this.deps.images.getProgress(draft.id);
      if(row.imageStarted||images?.slots?.some(slot=>slot.status==='PASSED')){
        if(!images)throw new UserFacingError('原图片记录缺失，不能修改计量后重新生图');
        row.imageStarted=true;row.unitRecheck={sourceWorkflowId:images.id,draftRevision:after.revision,draftStamp:imageWorkflowDraftStamp(after)};
      }
      rememberFailure(row,null);row.salesPlan=after.salesPlan;delete row.outcome;delete row.pricingRefresh;
      row.status='FAILED';row.error='已本地采用计量；保留原图片、费用和请求，继续前重新核对必要字段与图片';
      if(row.repair)row.repair={...row.repair,draftRevision:after.revision,draftStamp:imageWorkflowDraftStamp(after)};
      task.status='PAUSED';task.error=row.error;
      if(task.adaptation?.blockedKeys.includes(row.key)){
        const proof=this.db.prepare("SELECT detail_json FROM audit_events WHERE action='automatic-listing.adapted' AND json_extract(detail_json,'$.token')=?").get(task.adaptation.token);
        if(proof&&onlyUnitAdaptationBlock(JSON.parse(String(proof.detail_json)).changes,row.key))task.adaptation.unitResolvedKeys=[...new Set([...(task.adaptation.unitResolvedKeys??[]),row.key])];
      }
      const at=new Date().toISOString(),afterTask={...structuredClone(task),revision:task.revision+1,updatedAt:at};
      appendAuditEvent(this.db,randomUUID(),row.productId,'automatic-listing.sales-units.adopted','原任务显式采用计量，未启动后续调度',JSON.stringify({taskId:task.id,itemKey:row.key,token,before,afterPlan:after.salesPlan,afterDraftRevision:after.revision,afterTask}),at);
      this.save(task,this.db,[],at);committed=task;
    });
    this.tasks.set(committed!.id,committed!);return structuredClone(committed!);
  }
  private *adaptationStateSteps(task:AutomaticListingTask){
    const products=[...new Set(task.items.map(row=>row.productId))],drafts=task.items.flatMap(row=>row.draftId?[row.draftId]:[]);
    const calls=this.db.prepare("SELECT id,json_extract(record_json,'$.status') status,json_extract(record_json,'$.finishedAt') finishedAt,json_extract(record_json,'$.responseReceived') responseReceived FROM ai_calls WHERE json_extract(record_json,'$.productId') IN (SELECT value FROM json_each(?)) ORDER BY id").all(JSON.stringify(products));
    const operations=this.db.prepare("SELECT id,json_extract(record_json,'$.revision') revision,json_extract(record_json,'$.state') state,json_extract(record_json,'$.updatedAt') updatedAt FROM listing_completion_operations WHERE json_extract(record_json,'$.draftId') IN (SELECT value FROM json_each(?)) ORDER BY id").all(JSON.stringify(drafts));
    const state=yield* adaptationSteps(task,this.deps,this.busy||calls.some(call=>call.status==='RUNNING'),this.db);
    const naming={settings:this.db.prepare("SELECT value_json FROM amazon_settings WHERE key='sku_naming_v1'").get()??null,groups:this.db.prepare('SELECT record_json FROM sku_naming_groups ORDER BY id').all()};
    state.preview.token=fingerprint({base:state.preview.token,naming,calls:calls.map(call=>[call.id,call.status,call.finishedAt,call.responseReceived]),operations});
    return state;
  }
  private adaptationState(task:AutomaticListingTask){
    const steps=this.adaptationStateSteps(task);let result=steps.next();
    while(!result.done)result=steps.next();return result.value;
  }
  private previewScope(task:AutomaticListingTask):string {
    // data_version covers writes by other service connections; total_changes covers this one.
    return fingerprint({revision:task.revision,busy:this.busy,rules:this.deps.rules(),
      target:this.deps.amazon.executionTargetScope(task.targetId),profile:profileWithHostingRoute(this.deps.hosting.getProfile(task.profileId),task.hostingRoute),
      data:this.db.prepare('PRAGMA data_version').get(),local:this.db.prepare('SELECT total_changes() n').get()});
  }
  previewAdaptationForUi(id:string){
    const task=this.get(id),scope=this.previewScope(task),key=id+':'+scope;
    const existing=this.previewFlights.get(key);if(existing)return existing.then(value=>structuredClone(value));
    const flight=this.runUiPreview(task,scope).finally(()=>{if(this.previewFlights.get(key)===flight)this.previewFlights.delete(key);});
    this.previewFlights.set(key,flight);return flight.then(value=>structuredClone(value));
  }
  private async runUiPreview(task:AutomaticListingTask,scope:string){
    const steps=this.adaptationStateSteps(task);
    for(;;){
      await yieldToEventLoop();
      const current=this.task(task.id);
      if(this.previewScope(current)!==scope){
        steps.return(undefined as never);
        // Do not finish expensive projections of a superseded snapshot. Apply still
        // recomputes its full proof and rejects this deliberately obsolete token.
        return {taskId:task.id,taskRevision:task.revision,token:fingerprint({obsolete:scope}),canApply:false,
          blockers:['检查期间任务或资料已变化，请刷新任务后再适配'],changes:[],sources:[]};
      }
      const result=steps.next();if(result.done)return result.value.preview;
    }
  }
  previewAdaptation(id:string){return this.adaptationState(this.get(id)).preview;}
  applyAdaptation(raw:unknown):AutomaticListingTask {
    const input=record(raw,'旧任务适配',['taskId','token']),id=identifier(input.taskId),token=text(input.token,'适配检查标识',64,true);
    const prior=this.db.prepare("SELECT detail_json FROM audit_events WHERE action='automatic-listing.adapted' AND json_extract(detail_json,'$.token')=?").get(token);
    if(prior){const checkpoint=JSON.parse(String(prior.detail_json));if(checkpoint.taskId!==id)throw new UserFacingError('适配身份不一致');return this.get(id);}
    const before=this.get(id),state=this.adaptationState(before);
    if(state.preview.token!==token)throw new UserFacingError('检查后任务、来源、规则或请求发生变化，请重新检查');
    if(!state.preview.canApply)throw new UserFacingError(state.preview.blockers.join('；'));
    const next=structuredClone(before);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const persisted=this.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(id);
      if(!persisted)throw new UserFacingError('任务记录已变化，请重新检查');
      const current=this.adaptationState(validateAutomaticListingTask(JSON.parse(String(persisted.record_json))));
      if(current.preview.token!==token)throw new UserFacingError('应用前资料发生变化，请重新检查');
      next.adaptation={version:1,token,at:new Date().toISOString(),blockedKeys:state.preview.changes.filter(c=>c.kind==='BLOCKED').map(c=>c.key),previousRules:[...(before.adaptation?.previousRules??[]),{stamp:before.rulesStamp,revision:before.ruleRevision}].filter((r,i,a)=>a.findIndex(v=>v.stamp===r.stamp&&v.revision===r.revision)===i)};
      applyAdaptationRows(next,this.deps,state,this.db);
      appendAuditEvent(this.db,randomUUID(),null,'automatic-listing.adapted','用户显式适配当前规则；等待用户继续',JSON.stringify({taskId:id,token,before,changes:state.preview.changes,afterRevision:before.revision+1}),new Date().toISOString());
      this.save(next,this.db);this.db.exec('COMMIT');
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
    this.tasks.set(id,next);return structuredClone(next);
  }
  get busy(): boolean { return this.worker !== null || this.observing !== null; }
  private armObservationTimer():void {
    const active=this.managedTasks().some(task=>['QUEUED','RUNNING','WAITING'].includes(task.status)||task.items.some(row=>row.batchWait));
    this.timer=setTimeout(()=>{this.timer=null;void this.refreshWaiting().catch(()=>{}).finally(()=>{
      if(!this.closed&&!this.closing&&!this.schedulingSuspended&&!this.timer)this.armObservationTimer();
    });},active?10_000:30_000);this.timer.unref();
  }
  start(): void {
    this.schedulingSuspended = false;
    this.ensureOpen(); if (this.timer) return;
    this.armObservationTimer();
    void this.refreshWaiting().catch(() => {});
  }
  suspendScheduling(): void {
    this.schedulingSuspended = true;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
  }
  /** Freeze only scheduler timers; the caller blocks mutations for the lease lifetime. */
  holdForMaintenance(): () => void {
    this.ensureOpen();
    const suspended = this.schedulingSuspended, armed = this.timer !== null;
    this.suspendScheduling(); let released = false;
    return () => {
      if (released) return; released = true;
      if (this.closed || this.closing) return;
      this.schedulingSuspended = suspended;
      if (armed && !suspended && !this.timer) {
        this.armObservationTimer();
      }
    };
  }
  private assertConnections(task: AutomaticListingTask): void {
    const target = this.deps.amazon.executionTargetScope(task.targetId), profile = this.deps.hosting.getProfile(task.profileId);
    if (!target.target.configured || target.target.paused || fingerprint(target) !== task.targetStamp) throw new UserFacingError('目标店铺授权或范围发生变化，请重新建立任务');
    if (!profile.enabled || !profile.configured || fingerprint(profileWithHostingRoute(profile,task.hostingRoute)) !== task.profileStamp) throw new UserFacingError('图床配置发生变化，请重新建立任务');
    if (fingerprint(this.deps.rules()) !== task.rulesStamp) throw new UserFacingError('上架规则发生变化，请重新建立任务');
  }
  private canRebaseSources(task: AutomaticListingTask,row: AutomaticListingItem): boolean {
    if(row.status==='SCREENED'||row.sourcesPrepared||row.stage!=='SOURCES'||row.draftId||row.imageStarted||row.executionTaskIds.length)return false;
    return task.items.filter(sibling=>sibling.productId===row.productId&&sibling.sourcesPrepared).every(sibling=>
      ['READBACK','LABELS','COMPLETE'].includes(sibling.stage)&&!!sibling.draftId&&submitted(this.deps.amazon.getDraft(sibling.draftId)));
  }
  /** Narrow compatibility for the old partial sibling save after initial source
   * delivery. A sourceStamp alone cannot prove that original images are intact. */
  private canRebaseMaterializedSources(task:AutomaticListingTask,row:AutomaticListingItem,product:ProductDetail,proofs?:Map<string,boolean>):boolean {
    if(row.sourcesPrepared||row.stage!=='SOURCES'||row.draftId||row.imageStarted||row.executionTaskIds.length||row.outcome?.kind==='UNKNOWN'
      ||![1,product.revision].includes(row.productRevision)||product.revision<=1||sourceStamp(product)!==row.sourceStamp)return false;
    const variants=row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId];
    if(variants.some(id=>!product.assets.some(a=>a.variantIds.includes(id))))return false;
    if(proofs?.has(product.id))return proofs.get(product.id)!;
    const prove=()=>{
      try{
        const source=readSourceImageReceipt(this.db,product.id),adoption=readSourceAdoption(this.db,product.id);
        if(source?.kind!=='miaoshou'||!adoption?.frozen||adoption.productRevision!==1||adoption.adoptedSnapshotId!==adoption.latestSnapshotId)return false;
        const audits=this.db.prepare('SELECT action,detail_json,created_at FROM audit_events WHERE product_id=? ORDER BY rowid').all(product.id);
        const allowed=new Set(['miaoshou.imported','assets.imported','workspace.moved','run.evidence','operation.failed','automatic-listing.source-materialization-rebased']);
        if(audits.some(a=>!allowed.has(String(a.action))))return false;
        const imports=audits.filter(a=>a.action==='miaoshou.imported');if(imports.length!==1)return false;
        const initial=JSON.parse(String(imports[0].detail_json));
        if(initial.receiptId!==source.receipt.id||initial.sourceSnapshotId!==adoption.adoptedSnapshotId||initial.adopted!==true||String(imports[0].created_at)>task.createdAt)return false;
        const deliveries=audits.filter(a=>a.action==='assets.imported'),delivered=new Set<string>();
        if(!deliveries.length||product.revision!==1+2*deliveries.length||product.assets.length!==deliveries.length)return false;
        for(const event of deliveries){
          const ids=JSON.parse(String(event.detail_json)).assetIds;
          if(!Array.isArray(ids)||ids.length!==1||typeof ids[0]!=='string'||delivered.has(ids[0])||String(event.created_at)<task.createdAt)return false;
          delivered.add(ids[0]);
        }
        const anchors=this.db.prepare("SELECT id,record_json FROM source_image_provenance WHERE json_extract(record_json,'$.productId')=?").all(product.id)
          .map(a=>{const anchor=validateSourceImageProvenance(JSON.parse(String(a.record_json)));if(anchor.id!==a.id)throw Error('Invalid anchor');return anchor;});
        if(anchors.length!==product.assets.length||new Set(anchors.map(a=>a.assetId)).size!==anchors.length)return false;
        const epochs=this.db.prepare("SELECT id,record_json FROM source_consistency_bindings WHERE json_extract(record_json,'$.productId')=?").all(product.id)
          .map(b=>{const binding=validateConsistencyBinding(JSON.parse(String(b.record_json)));if(binding.id!==b.id)throw Error('Invalid binding');return binding;});
        const bindings=this.db.prepare('SELECT va.* FROM variant_assets va JOIN assets a ON a.id=va.asset_id WHERE a.product_id=?').all(product.id);
        if(bindings.length!==epochs.length)return false;
        for(const asset of product.assets){
          const anchor=anchors.find(a=>a.assetId===asset.id);
          if(!delivered.has(asset.id)||asset.createdAt<task.createdAt||!anchor||anchor.observedAt<asset.createdAt||!asset.variantIds.length)return false;
          assertSourceImageProvenance(this.db,anchor,this.directory);
          if(asset.variantIds.some(id=>!anchor.mappings.some(m=>m.localVariantId===id)))return false;
          for(const id of asset.variantIds){
            const current=bindings.filter(b=>b.asset_id===asset.id&&b.variant_id===id),history=epochs.filter(b=>b.assetId===asset.id&&b.variantId===id);
            if(current.length!==1||current[0].confirmed!==1||history.length!==1||history[0].createdAt<asset.createdAt)return false;
          }
        }
        // No request may be reassigned from the old pre-image scope, and a
        // sibling's unknown observation must remain bound to its original send.
        if(this.db.prepare("SELECT 1 FROM ai_calls WHERE json_extract(record_json,'$.productId')=? AND json_extract(record_json,'$.productRevision')=1 LIMIT 1").get(product.id)
          ||this.db.prepare("SELECT 1 FROM ai_image_requests WHERE json_extract(record_json,'$.productId')=? AND json_extract(record_json,'$.productRevision')=1 LIMIT 1").get(product.id)
          ||sourceConsistencyUnknown(this.db,product.id,product.variants.map(v=>v.id)))return false;
        return true;
      }catch{return false;}
    };
    const proved=prove();proofs?.set(product.id,proved);return proved;
  }
  private assertScope(task: AutomaticListingTask, row?: AutomaticListingItem, allowSourceRecovery=false,selection?:AutomaticResumeSelection): void {
    const selected=selection?task.items.filter(item=>rowSelected(selection,item.key)):task.items;
    const rows = row ? [row] : task.items.filter(value => (!selection||selected.some(item=>item.key===value.key||item.productId===value.productId||item.salesPlan?.sourceGroupKey&&item.salesPlan.sourceGroupKey===value.salesPlan?.sourceGroupKey))&&!adaptationBlocked(task,value.key)&&value.status!=='SCREENED'&&!['PLAN','READBACK','LABELS','COMPLETE'].includes(value.stage));
    if (!rows.length) return;
    this.assertConnections(task);
    const sources=new Map<string,{source:ProductDetail;stamp:string}>(),materializationProofs=new Map<string,boolean>();
    for (const item of rows) {
      if(!sources.has(item.productId)){const source=this.deps.store.getProduct(item.productId);sources.set(item.productId,{source,stamp:sourceStamp(source)});}
      const {source,stamp}=sources.get(item.productId)!,product=projectSalesProduct(source,item.salesPlan,item.variantId), variant = product.variants.find(value => value.id === item.variantId);
      if (!variant || variant.sku !== item.sku || stamp !== item.sourceStamp || product.revision !== item.productRevision&&!(allowSourceRecovery&&product.revision>item.productRevision&&(this.canRebaseSources(task,item)||this.canRebaseMaterializedSources(task,item,source,materializationProofs)))) throw new UserFacingError('来源商品或 SKU 发生变化，请重新建立任务');
    }
  }
  private unknownCode(row:AutomaticListingItem,task:AutomaticListingTask,categoryCache?:Map<string,string|null>):string|null {
    const draft=row.draftId?this.deps.amazon.getDraft(row.draftId):undefined;
    const pendingSubmission=!!draft&&(['UNKNOWN','SUBMITTING'].includes(draft.state)||!submitted(draft)&&(this.deps.execution.hasPendingSubmission?.(draft.id)??this.deps.execution.list().some(child=>child.items.some(item=>item.draftId===draft.id&&item.submitStarted))));
    if(pendingSubmission)return 'SUBMISSION_UNKNOWN';
    if(sourceConsistencyUnknown(this.db,row.productId,row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId]))return 'SOURCE_CONSISTENCY_SENT_UNKNOWN';
    return this.nonSourceUnknownCode(row,task,draft,categoryCache,pendingSubmission);
  }
  private categoryUnknown(row:AutomaticListingItem,task:AutomaticListingTask,cache?:Map<string,string|null>):string|null {
    const key=task.targetId+':'+row.productId;if(cache?.has(key))return cache.get(key)!;
    const code=categoryUnknownCode(this.db,this.directory,row.productId,()=>{const {target}=this.deps.amazon.executionTargetScope(task.targetId);return {targetId:target.id,sellerId:target.sellerId,marketplaceId:target.marketplaceId,region:target.region,locale:target.locale,mode:target.mode};});cache?.set(key,code);return code;
  }
  private nonSourceUnknownCode(row:AutomaticListingItem,task:AutomaticListingTask,draft:AmazonDraft|undefined=row.draftId?this.deps.amazon.getDraft(row.draftId):undefined,categoryCache?:Map<string,string|null>,pendingSubmission?:boolean):string|null {
    const journal=new CompletionJournal(this.db);
    // A retained guard without its old draft uses the same source sale identity as begin().
    const identity=completionSafetyIdentity(draft??{mode:task.mode,productId:row.productId,productRevision:row.productRevision,variantId:row.variantId,sku:row.sku,sellerId:task.sellerId,marketplaceId:task.marketplaceId,listingProgram:task.mode==='live'?'haul':'standard',salesPlan:row.salesPlan});
    if(journal.saleOperations(identity).some(op=>journal.unknown(op.id)))return 'FIELD_RESULT_UNKNOWN';
    if(row.repair?.phase==='FIELDS_STARTED'&&(!row.repair.operationId||journal.unknown(row.repair.operationId)))return 'FIELD_RESULT_UNKNOWN';
    if(!row.draftId)return row.imageStarted?'IMAGE_RESULT_UNKNOWN':this.categoryUnknown(row,task,categoryCache);
    if(!draft)throw new UserFacingError('字段草稿记录缺失');
    if(pendingSubmission??(['UNKNOWN','SUBMITTING'].includes(draft.state)||!submitted(draft)&&(this.deps.execution.hasPendingSubmission?.(draft.id)??this.deps.execution.list().some(child=>child.items.some(item=>item.draftId===draft.id&&item.submitStarted)))))return 'SUBMISSION_UNKNOWN';
    const run=this.deps.images.getProgress(row.draftId);
    if(run?.contentPreparation?.state==='STARTED'&&(!run.contentPreparation.operationId||journal.unknown(run.contentPreparation.operationId)))return 'FIELD_RESULT_UNKNOWN';
    if(run?.pendingRequest||run?.status==='RUNNING'||(this.deps.images.getPlanningUnknown?this.deps.images.getPlanningUnknown(row.draftId,run):run?.planningUnknown)||run?.slots?.some(slot=>slot.status==='UNKNOWN'||slot.attempts?.some(attempt=>['UNKNOWN','GENERATING'].includes(attempt.state))))return 'IMAGE_RESULT_UNKNOWN';
    if(row.imageStarted&&!run)return 'IMAGE_RESULT_UNKNOWN';
    return this.categoryUnknown(row,task,categoryCache);
  }
  /** Only failure presentation uses receipt certainty; send/admit/archive guards
   * continue to use unknownCode and the original source reservation guard. */
  private displayUnknownCode(row:AutomaticListingItem,task:AutomaticListingTask,categoryCache?:Map<string,string|null>):string|null {
    const original=this.unknownCode(row,task,categoryCache);
    if(original!=='SOURCE_CONSISTENCY_SENT_UNKNOWN'||sourceConsistencyPresentation(this.db,row.productId,row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId])!=='RECEIVED_INVALID')return original;
    return this.nonSourceUnknownCode(row,task,undefined,categoryCache);
  }
  private displayItem(row:AutomaticListingItem,task:AutomaticListingTask,categoryCache?:Map<string,string|null>):AutomaticListingItem {
    if(row.status!=='FAILED'||!row.outcome)return row;
    try{
      const unknown=this.displayUnknownCode(row,task,categoryCache);if(unknown)return row.outcome.kind==='UNKNOWN'&&row.outcome.code===unknown?row:{...row,outcome:{...row.outcome,kind:'UNKNOWN',code:unknown}};
      if(row.outcome.kind!=='UNKNOWN'||row.outcome.code!=='SOURCE_CONSISTENCY_SENT_UNKNOWN')return row;
      if(sourceConsistencyPresentation(this.db,row.productId,row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId])!=='RECEIVED_INVALID')return row;
      return {...row,outcome:{...row.outcome,kind:'SYSTEM_REPAIR',code:'SOURCE_CONSISTENCY_INVALID_OUTPUT'}};
    }catch{
      // Historical missing dependencies cannot prove the other safety states.
      // Preserve UNKNOWN in this read-only view, without changing the task/guard.
      return row.outcome.kind==='UNKNOWN'?{...row,outcome:{...row.outcome,code:'EVIDENCE_READ_FAILED'}}:row;
    }
  }
  private displayPresenter(){
    const cache=new WeakMap<AutomaticListingItem,AutomaticListingItem>();
    // One synchronous read only: siblings share a product lookup; a later query
    // always re-reads original receipts and never inherits time-based certainty.
    const categoryCache=new Map<string,string|null>();
    return (row:AutomaticListingItem,task:AutomaticListingTask)=>{let value=cache.get(row);if(!value){value=this.displayItem(row,task,categoryCache);cache.set(row,value);}return value;};
  }
  private async classifyFailure(task:AutomaticListingTask,row:AutomaticListingItem,failure?:unknown):Promise<void> {
    const protectedCode=failure instanceof AiError&&failure.code!=='OUTPUT_INVALID'?'AI_'+failure.code:row.outcome?.kind==='SYSTEM_REPAIR'&&(AI_ERROR_CODES.some(code=>code!=='OUTPUT_INVALID'&&row.outcome?.code==='AI_'+code)||['SOURCE_CONSISTENCY_REQUEST_FAILED','SOURCE_CONSISTENCY_UNAVAILABLE','SOURCE_CONSISTENCY_AUTH_FAILED'].includes(row.outcome.code))?row.outcome.code:null;
    let draft:AmazonDraft|undefined, classification:Pick<AutomaticListingOutcome,'kind'|'code'|'pricingReport'|'image'>={kind:'SYSTEM_REPAIR',code:'SYSTEM_FAILURE'};
    try {
      if(row.draftId)draft=this.deps.amazon.getDraft(row.draftId);
      // Confirmed submissions are already beyond source preparation, pricing and
      // image admission. Their readback/label failure must retain its actual cause.
      if(draft&&submitted(draft)&&!['UNKNOWN','SUBMITTING'].includes(draft.state)&&this.matching(task,row,draft)&&['READBACK','LABELS'].includes(row.stage)){
        const brandError = row.stage === 'READBACK' && draft.listingProgram === 'haul' && Array.isArray(draft.attributes.brand) && draft.attributes.brand.some(value => value && typeof value === 'object' && 'value' in value && value.value === 'Generic') && draft.listingIssues.some(issue => issue.source === 'amazon' && issue.severity === 'ERROR' && ['5665','5882'].includes(issue.code));
        row.outcome={version:1,kind:brandError?'NEEDS_INPUT':'SYSTEM_REPAIR',code:brandError?'READBACK_BRAND_REQUIRES_MANUAL':row.stage==='LABELS'?'LABELS_FAILED':'READBACK_FAILED',message:(row.error??'已提交商品的后续处理失败').slice(0,2000),classifiedAt:new Date().toISOString(),scope:outcomeScope(task,row),draftId:draft.id,draftRevision:draft.revision};
        return;
      }
      const unknown=this.displayUnknownCode(row,task)??(failure instanceof AiError&&failure.diagnosticReason==='IMAGE_PLAN_RESULT_UNKNOWN'?'IMAGE_RESULT_UNKNOWN':null);
      if(unknown)classification={kind:'UNKNOWN',code:unknown};
      else if(row.stage==='CLASSIFY'&&failure instanceof CategoryNoSuitableError)classification={kind:'NEEDS_INPUT',code:failure.code};
      else if(row.stage==='CLASSIFY'&&failure instanceof AiError&&failure.certainty==='DEFINITIVE_REJECTION'&&categoryFailureRequestId(this.db,row.productId,failure))classification={kind:'SYSTEM_REPAIR',code:'CATEGORY_EXPANSION_REJECTED'};
      else if(this.unknownCode(row,task)==='SOURCE_CONSISTENCY_SENT_UNKNOWN'&&sourceConsistencyPresentation(this.db,row.productId,row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId])==='RECEIVED_INVALID')classification={kind:'SYSTEM_REPAIR',code:'SOURCE_CONSISTENCY_INVALID_OUTPUT'};
      else if(failure instanceof AiError&&failure.certainty==='RECEIVED_INVALID')classification={kind:'SYSTEM_REPAIR',code:'AI_RECEIVED_INVALID_OUTPUT'};
      else if(protectedCode)classification={kind:'SYSTEM_REPAIR',code:protectedCode};
      else if(draft){
        const declarationConflict=draft.listingProgram==='haul'&&draft.localIssues.some(issue=>issue.code===DECLARATION_SOURCE_CONFLICT&&issue.severity==='ERROR'&&issue.category==='compliance'&&issue.source==='local');
        const factIssue=draft.listingProgram==='haul'?draft.localIssues.find(issue=>[FACT_AUTHORITY_REQUIRED,FACT_SOURCE_CONFLICT].includes(issue.code)&&issue.severity==='ERROR'&&['fact','compliance'].includes(issue.category)&&issue.source==='local'&&!issue.autoFixable):undefined;
        classification=pricingOutcome(draft,this.deps.rules())??(declarationConflict?{kind:'NEEDS_INPUT',code:DECLARATION_SOURCE_CONFLICT}:factIssue?{kind:'NEEDS_INPUT',code:factIssue.code}:classification);
        if(classification.kind!=='RULE_FILTERED'&&manualBrandIssues(draft,[...draft.previewIssues,...draft.listingIssues]).length)classification={kind:'NEEDS_INPUT',code:'AMAZON_BRAND_MANUAL'};
        if(classification.kind!=='RULE_FILTERED'&&this.deps.images.getRuleFilterEvidence){
          const image=await this.deps.images.getRuleFilterEvidence(draft.id);
          if(image)classification={kind:'RULE_FILTERED',code:image.kind,image};
        }
        if(!this.matching(task,row,draft)||draft.productRevision!==row.productRevision||sourceStamp(this.deps.store.getProduct(row.productId))!==row.sourceStamp||fingerprint(this.deps.rules())!==task.rulesStamp)
          classification={kind:'NEEDS_INPUT',code:'PRICING_EVIDENCE_STALE'};
        const after=this.deps.amazon.getDraft(draft.id);
        if(after.revision!==draft.revision||this.displayUnknownCode(row,task))classification={kind:'UNKNOWN',code:this.displayUnknownCode(row,task)??'EVIDENCE_READ_FAILED'};
      }else if(row.stage==='SOURCES'&&row.outcome&&Object.hasOwn(AUTOMATIC_SOURCE_ISSUES,row.outcome.code))classification={kind:row.outcome.kind,code:row.outcome.code};
      else if(row.stage==='PLAN'||row.outcome?.code==='SOURCE_INPUT_REQUIRED')classification={kind:'NEEDS_INPUT',code:'SOURCE_INPUT_REQUIRED'};
      if(!protectedCode&&classification.code!=='AI_RECEIVED_INVALID_OUTPUT'&&classification.kind!=='UNKNOWN'&&classification.kind!=='RULE_FILTERED'&&!(row.stage==='SOURCES'&&row.outcome&&(Object.hasOwn(AUTOMATIC_SOURCE_ISSUES,row.outcome.code)||row.outcome.code==='SOURCE_INPUT_REQUIRED'))){
        try{assertProductConsistency(this.db,this.deps.store.getProduct(row.productId),row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId]);}
        catch(error){if(error instanceof SourceConsistencyError)classification={kind:error.kind,code:error.code};else throw error;}
      }
    }catch{classification={kind:'SYSTEM_REPAIR',code:'EVIDENCE_READ_FAILED'};}
    if(classification.kind==='UNKNOWN'&&!row.error?.startsWith('上次结果尚未确认'))row.error=((recoverableAiUnknown(classification.code)?'上次结果尚未确认；继续任务仅核对或恢复已有结果；未确认结果前不重复发送该 AI 请求。上次错误：':'上次提交结果尚未确认，未自动重发。上次错误：')+(row.error??'请核对已有记录')).slice(0,2000);
    const priceIssue=draft&&classification.code.startsWith('ACTUAL_')?pricingQualificationIssue(draft,this.deps.rules()):null;
    row.outcome={version:1,...classification,message:(classification.image?.message??priceIssue?.message??(classification.pricingReport?(draft?.businessRules?.notices.join('；')||undefined):undefined)??row.error??'处理未完成').slice(0,2000),classifiedAt:new Date().toISOString(),scope:outcomeScope(task,row),draftId:row.draftId,draftRevision:draft?.revision??null};
    if(classification.kind==='RULE_FILTERED')row.status='SCREENED';
  }
  private selectedVariants(product: ProductDetail) {
    const rules=this.deps.rules();
    const selected=previewSalesRecipes(product,this.deps.sourceReceipt?.(product.id)??null,{...rules,pricing:{...rules.pricing,bundleEnabled:false}});
    const ids=new Set(selected.flatMap(r=>r.components.map(c=>c.variantId)));
    return product.variants.filter(v=>ids.has(v.id));
  }
  async queue(raw:unknown):Promise<AutomaticListingQueue> {
    this.ensureOpen();const input=record(raw,'待上架范围',['productIds','targetId']);
    if(!Array.isArray(input.productIds)||input.productIds.length>1000)throw new UserFacingError('最多读取 1000 个来源商品');
    const ids=input.productIds.map(identifier);if(new Set(ids).size!==ids.length)throw new UserFacingError('商品范围不能重复');
    const targetId=text(input.targetId,'店铺',100,true),target=this.deps.amazon.executionTargetScope(targetId),rules=this.deps.rules(),idSet=new Set(ids);
    const relevantTasks=()=>[...this.tasks.values()].filter(t=>t.mode===target.target.mode&&t.sellerId===target.target.sellerId&&t.marketplaceId===target.target.marketplaceId&&t.items.some(row=>ids.includes(row.productId)));
    const revisions=()=>relevantTasks().map(t=>[t.id,t.revision]);
    const evidenceState=()=>{
      const draftIds=[...new Set(relevantTasks().flatMap(t=>t.items.filter(row=>ids.includes(row.productId)&&row.draftId).map(row=>row.draftId!)))];

      // Scan historical operations once for this scope, retaining the original
      // product/row order used by the before/after evidence fingerprint.
      const operations=this.db.prepare("SELECT id,record_json,json_extract(record_json,'$.safetyIdentity.productId') product_id FROM listing_completion_operations WHERE json_extract(record_json,'$.safetyIdentity.productId') IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(JSON.stringify(ids));
      const byProduct=new Map<string,{id:unknown;record_json:unknown}[]>();
      for(const row of operations){const key=String(row.product_id),rows=byProduct.get(key)??[];rows.push({id:row.id,record_json:row.record_json});byProduct.set(key,rows);}
      return {fieldOperations:ids.flatMap(id=>byProduct.get(id)??[]),risk:this.deps.images.getRiskSettings?.()??null,drafts:draftIds.map(id=>{try{return {id,draft:this.deps.amazon.getDraft(id),workflow:this.deps.images.getProgress(id),fieldOperations:new CompletionJournal(this.db).list(id)};}catch{return {id,unavailable:true};}}),
        execution:this.deps.execution.list().flatMap(child=>child.items.filter(item=>draftIds.includes(item.draftId)).map(item=>({id:child.id,status:child.status,item})))};
    };
    const taskRevisions=fingerprint(revisions()),evidenceStamp=fingerprint(evidenceState()),receipts=new Map(ids.map(id=>[id,this.deps.sourceReceipt?.(id)??null]));
    const snapshot=this.deps.store.getProductSnapshot?.bind(this.deps.store);
    if(!snapshot)throw new UserFacingError('只读来源快照服务不可用，未执行历史修复');
    const snapshots=ids.map(id=>snapshot(id)),products:AutomaticListingQueue['products']=[];
    const historyIndex=()=>{
      const index=new Map<string,{task:AutomaticListingTask;item:AutomaticListingItem}[]>();
      for(const task of this.tasks.values())if(task.mode===target.target.mode&&task.sellerId===target.target.sellerId&&task.marketplaceId===target.target.marketplaceId)for(const item of task.items)if(idSet.has(item.productId)){const rows=index.get(item.productId)??[];rows.push({task,item});index.set(item.productId,rows);}
      return index;
    };
    let historiesByProduct=historyIndex();
    const categoryCache=new Map<string,string|null>(),displayCache=new Map<AutomaticListingItem,string|null>(),guardCache=new Map<AutomaticListingItem,string|null>();
    const display=(h:{task:AutomaticListingTask;item:AutomaticListingItem})=>{if(!displayCache.has(h.item))displayCache.set(h.item,this.displayUnknownCode(h.item,h.task,categoryCache));return displayCache.get(h.item)!;};
    const guard=(h:{task:AutomaticListingTask;item:AutomaticListingItem})=>{if(!guardCache.has(h.item))guardCache.set(h.item,this.unknownCode(h.item,h.task,categoryCache));return guardCache.get(h.item)!;};
    for(const product of snapshots){
      let recipes:{key:string;specification:string;stamp:string;legacyVariantId:string|null;value?:SalesListingPlan['recipe']}[],planningError:string|null=null;
      try{recipes=this.deps.planSales?selectSalesRecipes(product,this.deps.previewSales?.(product.id)??previewSalesRecipes(product,receipts.get(product.id)??null,rules),rules,receipts.get(product.id)??null).map(recipe=>({key:recipe.key,specification:recipe.specification,stamp:fingerprint(validateSalesRecipe(recipe)),value:recipe,legacyVariantId:recipe.components.length===1?recipe.components[0].variantId:null}))
        :this.selectedVariants(product).map(v=>({key:v.id,specification:v.normalizedSpec||v.originalSpec,stamp:fingerprint({variantId:v.id}),legacyVariantId:v.id}));}
      catch(error){planningError=errorMessage(error);recipes=[];}
      const rows:AutomaticQueueRow[]=[];
      for(const recipe of recipes){
        const histories=(historiesByProduct.get(product.id)??[]).filter(({item})=>((item.salesPlan?recipeKey(item)===recipe.key:item.variantId===recipe.legacyVariantId)||item.outcome?.pricingReport&&recipe.value&&fingerprint((item.salesPlan?.recipe.components.map(c=>c.variantId)??[item.variantId]).sort())===fingerprint(recipe.value.components.map(c=>c.variantId).sort()))).reverse();
        const latest=histories[0],view:AutomaticQueueRow={key:product.id+':'+recipe.key,productId:product.id,recipeKey:recipe.key,specification:recipe.specification,sku:latest?.item.sku??null,kind:'PENDING',eligible:true,message:'',reconsideration:null,taskId:latest?.task.id??null};
        try{
          const unsafe=histories.find(display)??histories.find(guard);
          if(unsafe){const unknown=display(unsafe);view.kind=unknown?'UNKNOWN':'SYSTEM_REPAIR';view.reasonCode=unknown??'SOURCE_CONSISTENCY_INVALID_OUTPUT';view.eligible=false;view.taskId=unsafe.task.id;view.message=unknown?(unsafe.item.error||'已有付费请求或提交记录需要核对，请继续核对原任务'):presentRejection(view.reasonCode);}
          else if(histories.some(h=>h.item.status==='DONE'||h.item.draftId&&submitted(this.deps.amazon.getDraft(h.item.draftId)))){view.kind=histories.some(h=>h.item.status==='DONE')?'COMPLETED':'SUBMITTED';view.eligible=false;view.message=view.kind==='COMPLETED'?'流程已完成':'已提交，等待平台回读';}
          else if(latest){
            const {task,item}=latest,outcome=item.outcome;
            if(outcome?.kind==='RULE_FILTERED'&&outcome.pricingReport){
              // A changed global stamp never grants another paid attempt. Only a
              // validated local quote can reopen a previously profit-blocked sale.
              const current=item.draftId&&this.deps.amazon.previewPricing?.(item.draftId,product,recipe.value);
              if(current){
                const pricing=pricingOutcome(current,rules);
                if(!pricing&&qualifiedPricing(current,rules)){view.noticeCode='PRICING_CHANGED';view.reconsideration='当前定价已在本地重算合格';view.message=view.reconsideration+'；原淘汰记录保留';}
                else {view.kind=pricing?.kind??'NEEDS_INPUT';view.reasonCode=pricing?.code??'PRICING_EVIDENCE_STALE';view.eligible=false;view.message=pricingBlockingReason(current,rules)||current.businessRules?.notices.join('；')||outcome.message;}
              }else{
                const draft=item.draftId?this.deps.amazon.getDraft(item.draftId):null;
                const unchanged=outcome.scope.rulesStamp===fingerprint(rules)&&outcome.scope.sourceStamp===sourceStamp(product)&&outcome.scope.recipeStamp===recipe.stamp&&draft&&pricingEvidenceCurrent(draft,rules);
                view.kind=unchanged?'RULE_FILTERED':'NEEDS_INPUT';view.reasonCode=unchanged?outcome.code:'PRICING_EVIDENCE_STALE';view.eligible=false;view.message=unchanged?outcome.message:'需要本地重算定价；原利润淘汰与成果保留';
              }
            }else if(outcome?.kind==='RULE_FILTERED'){
              let stale:AutomaticQueueRow['noticeCode']=outcome.scope.rulesStamp!==fingerprint(rules)?'RULES_CHANGED':outcome.scope.sourceStamp!==sourceStamp(product)?'SOURCE_CHANGED':outcome.scope.recipeStamp!==recipe.stamp?'RECIPE_CHANGED':undefined;
              if(!stale&&item.draftId){
                const draft=this.deps.amazon.getDraft(item.draftId);
                if(draft.revision!==outcome.draftRevision||!this.matching(task,item,draft))stale='DRAFT_CHANGED';
                else if(outcome.pricingReport&&!pricingEvidenceCurrent(draft,rules))stale='PRICING_CHANGED';
                else if(outcome.image){const proof=await Promise.resolve(this.deps.images.getRuleFilterEvidence?.(draft.id)).finally(()=>{categoryCache.clear();displayCache.clear();guardCache.clear();historiesByProduct=historyIndex();});if(!proof||fingerprint(proof)!==fingerprint(outcome.image))stale='IMAGE_EVIDENCE_CHANGED';}
              }
              if(stale){view.noticeCode=stale;view.reconsideration=({RULES_CHANGED:'上架规则已变化，重新评估',SOURCE_CHANGED:'来源资料已变化，重新评估',RECIPE_CHANGED:'销售配方已变化，重新评估',DRAFT_CHANGED:'草稿资料已变化，重新评估',PRICING_CHANGED:'定价输入已变化，重新评估',IMAGE_EVIDENCE_CHANGED:'图片证据或风险设置已变化，重新评估'} as const)[stale];view.message=view.reconsideration+'；原淘汰记录保留，旧任务不会自动重启';}
              else {view.kind='RULE_FILTERED';view.eligible=false;view.reasonCode=outcome.code;view.message=outcome.pricingReport?outcome.message:presentRejection(view.reasonCode);}
            }else if(outcome?.kind==='UNKNOWN'){
              // Live request/submit markers were checked above. Keep the old outcome as audit only.
              view.kind='SYSTEM_REPAIR';view.noticeCode='UNKNOWN_RECONCILED';view.reconsideration='原未知结果已核对，可重新准备';view.message=view.reconsideration+'；历史未知记录保留，不会自动重试';
            }else if(outcome){view.kind=outcome.kind;view.reasonCode=item.rejection?.detail.code??outcome.code;view.message=outcome.pricingReport?outcome.message:presentRejection(view.reasonCode);}
            else if(item.status==='FAILED'){view.kind='UNCLASSIFIED';view.reasonCode='LEGACY_FAILURE';view.message=presentRejection(view.reasonCode);}
            if(!final(task)&&view.kind!=='RULE_FILTERED'){view.continuationRequired=true;view.eligible=false;view.message=(view.message?view.message+'；':'')+'请继续或取消原任务';}
          }
        }catch{view.kind='SYSTEM_REPAIR';delete view.continuationRequired;view.noticeCode='EVIDENCE_READ_FAILED';view.message='暂无法核对已保存证据，记录保留待修复';view.eligible=false;}
        rows.push(view);
      }
      const selectedSourceIds=new Set(recipes.flatMap(recipe=>recipe.value?.components.map(c=>c.variantId)??(recipe.legacyVariantId?[recipe.legacyVariantId]:[])));
      if(!planningError)for(const variant of product.variants.filter(v=>!selectedSourceIds.has(v.id)))rows.push({key:product.id+':'+variant.id,productId:product.id,recipeKey:variant.id,specification:variant.originalSpec,sku:null,kind:'RULE_FILTERED',eligible:false,reasonCode:'SKU_SELECTION_FILTERED',message:'本次未选中此来源规格，原始资料与历史记录保留',reconsideration:null,taskId:null});
      products.push({productId:product.id,title:product.title,eligibleCount:rows.filter(r=>r.eligible).length,pendingCount:rows.filter(r=>!['RULE_FILTERED','SUBMITTED','COMPLETED'].includes(r.kind)).length,filteredCount:rows.filter(r=>r.kind==='RULE_FILTERED'&&r.reasonCode!=='SKU_SELECTION_FILTERED').length,profitFilteredCount:rows.filter(r=>r.kind==='RULE_FILTERED'&&automaticRuleOutcome(r.reasonCode)==='profitFiltered').length,notSelectedCount:rows.filter(r=>r.reasonCode==='SKU_SELECTION_FILTERED').length,...(planningError?{inputIssue:'销售配方待补资料：'+planningError}:{}),rows});
    }
    if(fingerprint(this.deps.amazon.executionTargetScope(targetId))!==fingerprint(target)||fingerprint(this.deps.rules())!==fingerprint(rules)||fingerprint(revisions())!==taskRevisions||fingerprint(evidenceState())!==evidenceStamp||snapshots.some(p=>fingerprint(snapshot(p.id))!==fingerprint(p)||fingerprint(this.deps.sourceReceipt?.(p.id)??null)!==fingerprint(receipts.get(p.id))))throw new UserFacingError('读取期间范围已变化，请刷新');
    return {targetId,scope:{mode:target.target.mode,sellerId:target.target.sellerId,marketplaceId:target.target.marketplaceId},ruleRevision:rules.revision,products};
  }
  async create(raw: unknown): Promise<AutomaticListingTask> {
    if(this.operationProgress)throw new UserFacingError('正在核对或保存任务，请稍候');
    this.operationProgress={taskId:null,phase:'PREPARING',completed:0,total:0,message:'正在核对销售范围与原请求记录'};
    try{return await this.createTask(raw);}finally{this.operationProgress=null;}
  }
  private async createTask(raw: unknown): Promise<AutomaticListingTask> {
    this.ensureOpen();
    const input = record(raw, '自动上架参数', ['productIds','targetId','productType','profileId','executionMode','workBatchId']);
    if(this.archiving)throw new UserFacingError('批次正在归档，请稍候');
    const workBatch=currentWorkBatch(this.db,input.workBatchId===undefined?undefined:identifier(input.workBatchId));
    if (!Array.isArray(input.productIds) || !input.productIds.length || input.productIds.length > 1000) throw new UserFacingError('请选择 1–1000 个商品');
    const executionMode=input.executionMode??'immediate';
    if(!['immediate','deferred_batch'].includes(String(executionMode)))throw new UserFacingError('执行模式无效');
    const batchPlan=this.deps.batchPlan?.();
    if(executionMode==='deferred_batch'&&(!this.deps.batch||!batchPlan?.coverage.some(c=>c.mode==='deferred_batch')))throw new UserFacingError('当前没有可用的 Batch 步骤，请使用即时执行并核对用途覆盖计划');
    const ids = input.productIds.map(identifier);
    if (new Set(ids).size !== ids.length) throw new UserFacingError('商品范围不能重复');
    const targetId = text(input.targetId, '店铺', 100, true), target = this.deps.amazon.executionTargetScope(targetId);
    const profileId = text(input.profileId, '图床', 30, true), profile = this.deps.hosting.getProfile(profileId), rules = this.deps.rules();
    if (!target.target.configured || target.target.paused) throw new UserFacingError('请选择已配置且启用的目标店铺');
    if (!profile.configured || !profile.enabled) throw new UserFacingError('请先在设置中配置并启用图片托管');
    if(input.workBatchId!==undefined&&ids.some(id=>!workBatch.productIds.includes(id)))throw new UserFacingError('商品不在当前批次，请刷新后选择');
    const queue=await this.queue({productIds:ids,targetId}),eligible=new Set(queue.products.flatMap(p=>p.rows.filter(r=>r.eligible).map(r=>r.key)));
    if(this.archiving)throw new UserFacingError('批次正在归档，请稍候');currentWorkBatch(this.db,workBatch.id);
    if(!eligible.size)throw new UserFacingError(queue.products.find(p=>p.inputIssue)?.inputIssue??'所选商品没有可启动的销售 SKU（说明性选项不入选，每来源最多 4 个代表规格）；请查看规则淘汰或待核对原因，已在自动任务中的销售 SKU 请继续原任务');
    if(fingerprint(this.deps.rules())!==fingerprint(rules)||fingerprint(this.deps.amazon.executionTargetScope(targetId))!==fingerprint(target)||fingerprint(this.deps.hosting.getProfile(profileId))!==fingerprint(profile))throw new UserFacingError('创建期间范围已变化，请刷新');
    this.deps.preflight?.();
    const regroupedSkus=new Set<string>();
    const saleChecks:{productId:string;plan:SalesListingPlan;stamp:string}[]=[];
    const sourceVersions=new Map(ids.map(id=>[id,fingerprint({product:this.deps.store.getProduct(id),receipt:this.deps.sourceReceipt?.(id)??null})]));
    const selectedSourceIds=new Set(ids);
    const relevantTaskVersions=()=>fingerprint([...this.tasks.values()].filter(task=>task.mode===target.target.mode&&task.sellerId===target.target.sellerId&&task.marketplaceId===target.target.marketplaceId&&task.items.some(row=>selectedSourceIds.has(row.productId))).map(task=>[task.id,task.revision]));
    const taskVersions=relevantTaskVersions();
    const items: AutomaticListingItem[] = [];
    const planSource=(id:string):AutomaticListingItem[] => {
      const projection=queue.products.find(p=>p.productId===id);
      if(!projection?.eligibleCount&&!projection?.inputIssue)return [];
      const product = this.deps.store.getProduct(id);
      let plans:SalesListingPlan[]|undefined;
      try{if(projection?.inputIssue)throw new UserFacingError(projection.inputIssue);plans=this.deps.planSales?.(id,targetId);}catch(error){
        const variant=product.variants[0];if(!variant)throw error;
        return [{key:product.id+':'+variant.id,productId:product.id,productRevision:product.revision,sourceStamp:sourceStamp(product),productTitle:product.title,
          variantId:variant.id,sku:variant.sku,stockSets:rules.product.stockSets,sourcesPrepared:false,status:'FAILED',stage:'PLAN',draftId:null,executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,batchId:null,error:errorMessage(error)} as AutomaticListingItem];
      }
      const selected=plans?plans.map(salesPlan=>({variant:product.variants.find(v=>v.id===salesPlan.recipe.components[0].variantId)!,salesPlan})):this.selectedVariants(product).map(variant=>({variant,salesPlan:undefined}));
      return selected.filter(({variant,salesPlan})=>eligible.has(product.id+':'+(salesPlan?.recipe.key??variant.id))).map(({variant,salesPlan}) => {
        const existing=salesPlan?this.deps.existingSale?.(product.id,salesPlan,targetId):undefined;
        if(salesPlan)saleChecks.push({productId:product.id,plan:salesPlan,stamp:fingerprint(existing??null)});
        const frozen=existing&&submitted(existing)?existing:undefined;
        const regrouped=!frozen&&existing?.salesPlan&&salesPlan&&existing.salesPlan.recipe.key===salesPlan.recipe.key
          &&existing.salesPlan.sourceGroupKey!==salesPlan.sourceGroupKey?existing:undefined;
        if(regrouped)regroupedSkus.add(regrouped.sku);
        const canonical=frozen??regrouped;
        const legacy=existing&&!existing.salesPlan&&existing.productId===product.id&&existing.variantId===variant.id&&existing.sku===variant.sku?existing:undefined;
        const source=canonical?this.deps.store.getProduct(canonical.productId):product;
        if(!sourceVersions.has(source.id))sourceVersions.set(source.id,fingerprint({product:source,receipt:this.deps.sourceReceipt?.(source.id)??null}));
        let plan=canonical?canonical.salesPlan:legacy?undefined:salesPlan;
        // Keep allocated identity, but recompute unsent costs/components from the current source.
        // A duplicate import may have new local variant IDs even for the same supplier recipe.
        if(!canonical&&plan&&existing?.salesPlan?.sourceGroupKey===plan.sourceGroupKey&&existing.salesPlan.recipe.key===plan.recipe.key){
          const prior=existing.salesPlan;
          plan={...plan,namingGroupId:prior.namingGroupId,sku:prior.sku,baseSku:prior.baseSku,namingChildKey:prior.namingChildKey,collectedAt:prior.collectedAt,collectionBasis:prior.collectionBasis};
        }
        const variantId=canonical?.variantId??variant.id;
        return {
        key: source.id + ':' + (plan?.unitAdoption?.originalRecipeKey??plan?.recipe.key??variantId), productId: source.id, productRevision: source.revision, sourceStamp: sourceStamp(source), productTitle: source.title,
        variantId, sku: canonical?.sku??legacy?.sku??plan?.sku??variant.sku, ...(plan?{salesPlan:plan}:{}), stockSets: rules.product.stockSets, sourcesPrepared: false,
        status: 'PENDING', stage: 'SOURCES', draftId: null, executionTaskIds: [], imageStarted: false, imageAttempts: 0, repairAttempts: 0, repairPolicyVersion: FIELD_REPAIR_POLICY_VERSION, categoryFieldPolicyVersion:CATEGORY_FIELD_REPAIR_POLICY_VERSION, repair: null, batchId: null, error: null,
      } as AutomaticListingItem;});
    };
    for(const [index,id] of ids.entries()){this.operationProgress={taskId:null,phase:'PREPARING',completed:index,total:ids.length,message:'正在逐商品规划；保留原SKU、历史和未知请求锁'};items.push(...planSource(id));await yieldToEventLoop();}
    this.ensureOpen();
    if(fingerprint(this.deps.rules())!==fingerprint(rules)||fingerprint(this.deps.amazon.executionTargetScope(targetId))!==fingerprint(target)||fingerprint(this.deps.hosting.getProfile(profileId))!==fingerprint(profile)
      ||relevantTaskVersions()!==taskVersions
      ||[...sourceVersions].some(([id,stamp])=>fingerprint({product:this.deps.store.getProduct(id),receipt:this.deps.sourceReceipt?.(id)??null})!==stamp)
      ||saleChecks.some(check=>fingerprint(this.deps.existingSale?.(check.productId,check.plan,targetId)??null)!==check.stamp))throw new UserFacingError('创建期间范围已变化，请刷新');
    this.deps.preflight?.();
    if(fingerprint(this.deps.batchPlan?.()??null)!==fingerprint(batchPlan??null))throw new UserFacingError('创建期间范围已变化，请刷新');
    // Repeated collection of the same source recipe uses the canonical saved listing once.
    for(let index=items.length-1;index>=0;index--)if(items[index].stage!=='PLAN'&&items.findIndex(row=>row.stage!=='PLAN'&&row.sku===items[index].sku)!==index)items.splice(index,1);
    if (!items.length || items.length > 5000) throw new UserFacingError('本次请选择 1–5000 个 SKU');
    for (const existing of this.tasks.values()) if (!final(existing) && existing.sellerId === target.target.sellerId && existing.marketplaceId === target.target.marketplaceId && existing.mode === target.target.mode
      && existing.items.some(row => row.stage!=='PLAN'&&items.some(item => item.stage!=='PLAN'&&item.sku === row.sku))) throw new UserFacingError('同一店铺 SKU 已在自动任务中，请继续或取消原任务');
    // A new task has no authority to reprepare sources for an old draft's paid images.
    // Active tasks conflict by the original SKU above; orphaned drafts need explicit recovery.
    if(regroupedSkus.size)throw new UserFacingError(`销售 SKU ${[...regroupedSkus].slice(0,5).join('、')} 已有旧分组草稿，请从原草稿或原自动任务继续；不能以新 SKU 建立重复任务`);
    const now = new Date().toISOString();
    const task: AutomaticListingTask = { executionMode:executionMode as 'immediate'|'deferred_batch',...(batchPlan?{batchPlan}:{}), id: randomUUID(), revision: 0, status: 'CREATED', targetId, targetName: target.target.name, sellerId: target.target.sellerId,
      marketplaceId: target.target.marketplaceId, mode: target.target.mode, targetStamp: fingerprint(target), profileId, hostingRoute:profile.route??DIRECT_HOSTING_ROUTE, profileStamp: fingerprint(profileWithHostingRoute(profile,profile.route??DIRECT_HOSTING_ROUTE)),
      rulesStamp: fingerprint(rules), ruleRevision: rules.revision, productType: input.productType ? text(input.productType, '商品类型', 100, true) : 'AUTO', locale: target.target.locale,
      labelFormat: validateItemLabelFormat(this.deps.labelFormat?.()), items, createdAt: now, updatedAt: now, error: null };
    for(const row of items)if(row.stage==='PLAN')row.outcome={version:1,kind:'NEEDS_INPUT',code:'SOURCE_INPUT_REQUIRED',message:row.error!,classifiedAt:now,scope:outcomeScope(task,row),draftId:null,draftRevision:null};
    this.operationProgress={taskId:task.id,phase:'SAVING',completed:0,total:items.length,message:'正在保存已核对的任务范围'};await yieldToEventLoop();
    // Yield happened before the atomic commit: recheck all frozen inputs, never
    // treat the earlier display/progress pass as permission to send or allocate.
    if(relevantTaskVersions()!==taskVersions||[...sourceVersions].some(([id,stamp])=>fingerprint({product:this.deps.store.getProduct(id),receipt:this.deps.sourceReceipt?.(id)??null})!==stamp)
      ||fingerprint(this.deps.rules())!==fingerprint(rules)||fingerprint(this.deps.amazon.executionTargetScope(targetId))!==fingerprint(target)||fingerprint(this.deps.hosting.getProfile(profileId))!==fingerprint(profile)
      ||saleChecks.some(check=>fingerprint(this.deps.existingSale?.(check.productId,check.plan,targetId)??null)!==check.stamp))throw new UserFacingError('创建期间范围已变化，请刷新');
    transaction(this.db,()=>{if(this.archiving)throw new UserFacingError('批次正在归档，请稍候');currentWorkBatch(this.db,workBatch.id);for(const id of new Set(items.map(item=>item.productId)))freezeSourceForProduct(this.db,id);this.save(task);addWorkBatchProducts(this.db,workBatch.id,[...ids,...items.map(item=>item.productId)]);bindWorkBatchTask(this.db,workBatch.id,task.id);});
    this.tasks.set(task.id, task); return structuredClone(task);
  }
  batchSummary(id:string){
    const task=this.task(id),batches=this.deps.batch?.batches(task.id)??[];
    const details=batches.map(batch=>{const summary=this.deps.batch!.summary(batch.id);return {...summary,items:summary.items.map(({productId,draftId,variantId,...item})=>({...item,skus:task.items.filter(row=>row.productId===productId&&(draftId?row.draftId===draftId:variantId?row.variantId===variantId:row.batchWait?.operationId===item.operationId)).map(row=>row.sku)}))};});
    return {mode:task.executionMode??'immediate' as const,plan:task.batchPlan??null,batches,details};
  }
  setExecutionMode(raw:unknown):AutomaticListingTask{
    const value=record(raw,'任务执行模式',['taskId','mode']),task=this.task(identifier(value.taskId));
    if(!['CREATED','PAUSED','NEEDS_ATTENTION'].includes(task.status)||!['immediate','deferred_batch'].includes(String(value.mode)))throw new UserFacingError('请先暂停任务后选择有效执行模式');
    const plan=task.batchPlan??this.getBatchPlan();
    if(value.mode==='deferred_batch'&&(!this.deps.batch||!plan.coverage.some(c=>c.mode==='deferred_batch')))throw new UserFacingError('当前没有可Batch步骤');
    task.batchPlan=plan;task.executionMode=value.mode as 'immediate'|'deferred_batch';this.save(task);return structuredClone(task);
  }
  getBatchPlan():TaskBatchPlan{if(!this.deps.batchPlan)throw new UserFacingError('Batch运行层未初始化');return structuredClone(this.deps.batchPlan());}
  prepareStart(id: string,selection?:AutomaticResumeSelection): AutomaticListingTask {
    if(this.archiving)throw new UserFacingError('批次正在归档，请稍候');
    this.assertManaged(id);const task = this.task(id);
    if (!['CREATED','PAUSED','NEEDS_ATTENTION'].includes(task.status) || this.activeId === id) throw new UserFacingError('此任务正在运行、等待平台或已经结束');
    this.assertScope(task,undefined,true,selection); return structuredClone(task);
  }
  private assertStartable(task:AutomaticListingTask):void{
    if(this.archiving)throw new UserFacingError('批次正在归档，请稍候');
    this.assertManaged(task.id);
    if(!['CREATED','PAUSED','NEEDS_ATTENTION'].includes(task.status)||this.activeId===task.id)throw new UserFacingError('此任务正在运行、等待平台或已经结束');
  }
  private prepareConfirmation(id:string,scope?:AutomaticResumeSelection):AutomaticListingTask{
    const task=this.task(id);this.assertStartable(task);this.assertConnections(task);
    if(scope)validateResumeSelection(scope,task.items.map(row=>row.key));
    return structuredClone(task);
  }
  getCurrentRound(id:string):{roundId:string;startedAt:string;mode:'continue'|'from-start';taskRevision:number}|null{
    const task=this.task(id);if(this.rounds.has(task.id)){const round=this.rounds.get(task.id);return round?{...round}:null;}
    const saved=this.db.prepare("SELECT detail_json FROM audit_events WHERE action='automatic-listing.round-started' AND json_extract(detail_json,'$.taskId')=? ORDER BY rowid DESC LIMIT 1").get(task.id);
    if(!saved){this.rounds.set(task.id,null);return null;}
    const value=JSON.parse(String(saved.detail_json));
    if(value.version!==1||value.taskId!==task.id||!['continue','from-start'].includes(value.mode)||!Number.isFinite(Date.parse(value.startedAt))||!Number.isSafeInteger(value.taskRevision)||value.taskRevision<1)throw new UserFacingError('本轮记录身份无效，原费用及任务保留');
    const round={roundId:identifier(value.roundId),startedAt:String(value.startedAt),mode:value.mode as 'continue'|'from-start',taskRevision:Number(value.taskRevision)};this.rounds.set(task.id,round);return {...round};
  }
  getRoundSummary(id:string):import('../../shared/automatic-listing-contracts.ts').AutomaticRoundSummary|null {const round=this.getCurrentRound(id);return round?{...round,fees:readRoundSpend(this.db,this.task(id),round)}:null;}
  async confirmStartOver(id:string,confirm:(task:AutomaticListingTask)=>Promise<boolean>):Promise<AutomaticListingTask|null>{
    const approved=this.prepareConfirmation(id);
    const scope:AutomaticResumeSelection={mode:'recheck',selections:approved.items.filter(row=>!['DONE','SCREENED'].includes(row.status)).map(row=>({key:row.key}))};
    if(!scope.selections.length)throw new UserFacingError('原任务没有未完成SKU；已提交成果仅保留原平台回读');
    if(this.confirming.has(id))throw new UserFacingError('此任务正在等待确认');this.confirming.add(id);
    try{
      if(!await confirm({...approved,resumeScope:scope,error:'从来源重新核对原SKU，只补缺失或失效步骤；复用有效字段、草稿和成功图片。本轮新增费用重新统计，原真实费用、次数及未知费用预留保持。'}))return null;
      return await this.startAuthorizedResponsive(approved,scope,true);
    }finally{this.confirming.delete(id);}
  }
  private async inspectResumeRow(task:AutomaticListingTask,row:AutomaticListingItem,allUploads=this.deps.hosting.listUploads?.()??[]){
    const source=(this.deps.store.getProductSnapshot??this.deps.store.getProduct).call(this.deps.store,row.productId);
    const draft=row.draftId?this.deps.amazon.getDraft(row.draftId):undefined,run=draft?this.deps.images.getProgress(draft.id):null;
    const executions=row.executionTaskIds.map(id=>this.deps.execution.get(id));
    const uploads=allUploads.filter(upload=>executions.some(child=>child.items.some(item=>item.uploads?.some(ref=>ref.uploadId===upload.id))))??[];
    const notes=[`当前步骤 ${row.stage}`],blockers:string[]=[],fields:string[]=[];
    if(sourceStamp(source)!==row.sourceStamp||source.revision!==row.productRevision)blockers.push('来源资料版本已变化，请先适配当前资料');
    if(task.rulesStamp!==fingerprint(this.deps.rules()))blockers.push('业务规则已变化，请先适配当前规则');
    try{assertProductConsistency(this.db,source,row.salesPlan?.recipe.components.map(component=>component.variantId)??[row.variantId]);notes.push('来源一致性证据可复用');}
    catch(error){notes.push('待恢复来源证据：'+errorMessage(error));}
    if(draft&&submitted(draft))blockers.push('已有提交身份；只允许原 SKU 回读/修正');
    if(executions.some(child=>child.items.some(item=>item.submitStarted)))blockers.push('原提交已有发送意图，先核对原请求');
    const unknown=this.unknownCode(row,task);if(unknown&&!recoverableAiUnknown(unknown))blockers.push('原请求结果待核对：'+unknown);
    let projected:AmazonDraft|undefined;
    if(draft){
      if(this.deps.amazon.previewTaskAdaptation){
        try{projected=this.deps.amazon.previewTaskAdaptation(draft.id,source,row.salesPlan?.recipe);
          fields.push(...nonDeferredImageIssues(projected).map(issue=>`${issue.attributeNames.join('、')||issue.code}：${issue.message}`));
          if(fingerprint(projected.attributes)!==fingerprint(draft.attributes)||fingerprint(projected.schema)!==fingerprint(draft.schema))blockers.push('本地重检发现规则字段或 Schema 需要适配；先应用当前规则，再接续原成果');
          notes.push(fields.length?'待修文案/事实及必要依赖：'+fields.join('；'):'当前本地字段与事实校验通过，文案可复用');
        }catch(error){blockers.push('字段重检：'+errorMessage(error));}
      }else blockers.push('缺少当前字段校验接口，不能判定旧文案有效');
      const pricing=pricingBlockingReason(projected??draft,this.deps.rules());if(pricing)blockers.push(pricing);
      if(this.imageReady(run)){
        try{if(!this.deps.images.inspectApproval||!this.deps.hosting.checkLocalAssets)throw new UserFacingError('缺少本地图片证据检查接口');
          const assets=this.deps.images.inspectApproval(draft.id);if(assets.length!==7)throw new UserFacingError('七图审核证据不完整');
          await this.deps.hosting.checkLocalAssets(assets.map(asset=>asset.id));notes.push('7 个已通过图位的当前审核、关联与本地文件可复用');
        }catch(error){blockers.push('已通过图位需要恢复/复核：'+errorMessage(error));}
      }else notes.push(`已保存 ${run?.slots?.filter(slot=>slot.status==='PASSED').length??0} 个通过图位；仅接续未通过图位的原响应、下载、规划或复核`);
      notes.push(uploads.length?`保留 ${uploads.filter(upload=>upload.status==='AVAILABLE').length} 个本地可用托管记录；执行时仍须远端 URL 核验，不提前请求`:'未核实可用托管记录；按原上传检查点恢复并核验 URL');
    }else notes.push('尚无草稿；需准备文案、图片及托管步骤');
    return {notes,blockers,fields,token:fingerprint({source,draft,projected,run,executions,uploads,notes,blockers,fields,rules:this.deps.rules()})};
  }
  async previewResume(raw:unknown):Promise<{taskRevision:number;token:string;lines:string[]}> {
    const input=record(raw,'定向接续',['taskId','scope']),id=identifier(input.taskId),task=this.prepareConfirmation(id),scope=validateResumeSelection(input.scope,task.items.map(row=>row.key));
    const rows=scope.selections.map(selection=>{const row=task.items.find(item=>item.key===selection.key)!;if(selection.slots&&(!row.draftId||!row.imageStarted))throw new UserFacingError(`${row.sku} 尚无图片处理记录，请先按SKU继续`);return row;});
    const lines=rows.map((row,index)=>sanitizeFailureReason(`${row.sku}：${scope.selections[index].slots?`仅处理图位 ${scope.selections[index].slots!.join('、')}，不提交商品`:scope.mode==='recheck'?'逐SKU从来源核对，复用成功成果':'继续未完成步骤'}；到该SKU时核对原请求及有效结果；未知结果不新发，原费用和次数保留。`));
    return {taskRevision:task.revision,token:fingerprint({scope,taskRevision:task.revision,rows}),lines};
  }
  async confirmResume(raw:unknown,confirm:(task:AutomaticListingTask)=>Promise<boolean>):Promise<AutomaticListingTask|null>{
    const input=record(raw,'执行定向接续',['taskId','taskRevision','token','scope']),id=identifier(input.taskId);
    const preview=await this.previewResume({taskId:id,scope:input.scope});
    if(input.taskRevision!==preview.taskRevision||input.token!==preview.token)throw new UserFacingError('处理预览已变化，请重新检查范围');
    const scope=validateResumeSelection(input.scope,this.get(id).items.map(row=>row.key)),approved=this.prepareConfirmation(id,scope);
    if(this.confirming.has(id))throw new UserFacingError('此任务正在等待确认');
    this.confirming.add(id);
    try{if(!await confirm({...approved,resumeScope:scope,items:approved.items.filter(row=>rowSelected(scope,row.key)),error:preview.lines.join('\n')}))return null;
      if(this.task(id).revision!==approved.revision)throw new UserFacingError('确认期间任务范围变化，请重新预览');
      return await this.startAuthorizedResponsive(approved,scope);
    }finally{this.confirming.delete(id);}
  }
  async confirmStart(id:string,confirm:(task:AutomaticListingTask)=>Promise<boolean>):Promise<AutomaticListingTask|null>{
    const approved=this.prepareConfirmation(id);
    if(this.confirming.has(approved.id))throw new UserFacingError('此任务正在等待启动确认');
    this.confirming.add(approved.id);
    try{
      const consent=structuredClone(approved);delete consent.resumeScope;
      if(!await confirm(consent))return null;
      return await this.startAuthorizedResponsive(approved);
    }finally{this.confirming.delete(approved.id);}
  }
  startAuthorized(approved: AutomaticListingTask, scope?:AutomaticResumeSelection): AutomaticListingTask {
    const steps=this.startAuthorizedSteps(approved,scope);let step=steps.next();
    while(!step.done)step=steps.next();return step.value;
  }
  private async startAuthorizedResponsive(approved:AutomaticListingTask,scope?:AutomaticResumeSelection,fromStart=false):Promise<AutomaticListingTask>{
    if(this.operationProgress)throw new UserFacingError('正在核对或保存任务，请稍候');
    this.operationProgress={taskId:approved.id,phase:'PREPARING',completed:0,total:approved.items.length,message:'正在准备原任务；逐SKU核对，不预扫整批历史'};await yieldToEventLoop();
    const steps=this.startAuthorizedSteps(approved,scope,fromStart);
    try{let step=steps.next();while(!step.done){this.operationProgress={taskId:approved.id,phase:'PREPARING',completed:step.value.completed,total:step.value.total,message:'正在逐SKU恢复原检查点；不会重发未知请求'};await yieldToEventLoop();step=steps.next();}return step.value;}
    finally{steps.return?.(undefined as never);this.operationProgress=null;}
  }
  private *startAuthorizedSteps(approved: AutomaticListingTask, scope?:AutomaticResumeSelection, fromStart=false):Generator<{completed:number;total:number},AutomaticListingTask,void> {
    this.assertManaged(approved.id);const task=this.task(approved.id);
    if(fingerprint(task)!==fingerprint(approved))throw new UserFacingError('确认期间任务范围发生变化');
    const revision=task.revision,status=task.status;
    yield {completed:0,total:task.items.length};
    if(task.revision!==revision||task.status!==status)throw new UserFacingError('准备期间任务已暂停或变化，请重新核对');
    this.assertStartable(task);this.assertConnections(task);this.deps.preflight?.();
    this.deps.admitTask?.(structuredClone(task));scope=this.controlledRuns.taskSelection(task.id,scope);
    const previousScope=task.resumeScope,previousStatus=task.status,previousError=task.error;
    const at=new Date().toISOString(),priorRound=this.getCurrentRound(task.id);
    const round=fromStart||!priorRound?{roundId:randomUUID(),startedAt:at,mode:fromStart?'from-start' as const:'continue' as const,taskRevision:task.revision+1}:priorRound;
    try{
      if(scope)task.resumeScope=validateResumeSelection(scope,task.items.map(row=>row.key));else delete task.resumeScope;
      task.status='QUEUED';task.error=null;
      const grant=transaction(this.db,()=>{
        this.save(task,this.db,[],at,[]);
        if(round!==priorRound)appendAuditEvent(this.db,round.roundId,null,'automatic-listing.round-started',fromStart?'从头核对原任务；保留已成功成果、次数及未知费用':'开始原任务首轮',JSON.stringify({version:1,taskId:task.id,...round}),at);
        return this.controlledRuns.activateQueuedTask(task.id);
      });
      if(grant)this.controlledGrants.set(task.id,grant);
      this.rounds.set(task.id,round);this.continuations.set(task.id,{at,fromStart,prepared:new Set()});
    }catch(error){task.status=previousStatus;task.error=previousError;if(previousScope)task.resumeScope=previousScope;else delete task.resumeScope;this.grants.delete(task.id);throw error;}
    this.deps.batch?.resume(task.id);this.grants.add(task.id);this.pump();return structuredClone(task);
  }
  /** Expensive owner reads happen only when this exact SKU gets its scheduler turn.
   * The authorization time is the user's continuation time, not a fresh retry grant
   * minted after a new error. Restarts lose this volatile scheduling authority. */
  private prepareContinuedRow(task:AutomaticListingTask,row:AutomaticListingItem):void {
    const continuation=this.continuations.get(task.id);if(!continuation||continuation.prepared.has(row.key))return;
    if(!rowSelected(task.resumeScope,row.key)||adaptationBlocked(task,row.key)||['DONE','SCREENED'].includes(row.status))return;
    if(row.status==='FAILED'){
      rememberFailure(row,null);
      if(row.draftId&&row.imageStarted)for(const slot of this.deps.images.getProgress(row.draftId)?.slots??[]){const attempt=slot.attempts?.at(-1);if(attempt?.error||slot.error){const snapshot={...row,error:attempt?.error??slot.error};rememberFailure(snapshot,attempt?.failureProof?.at??null,slot.index,attempt?.failureProof?'request-proof':undefined);row.failureHistory=snapshot.failureHistory;}}
    }
    row.lastContinuedAt=continuation.at;
    let materializedFrom:number|undefined,materializedOutcome:AutomaticListingItem['outcome'];
    if(row.outcome?.kind!=='UNKNOWN'&&!row.sourcesPrepared&&row.stage==='SOURCES'&&!row.draftId&&!row.imageStarted&&!row.executionTaskIds.length){
      const source=this.deps.store.getProduct(row.productId);
      if(source.revision!==row.productRevision){
        const materialized=this.canRebaseMaterializedSources(task,row,source);
        if(materialized||this.canRebaseSources(task,row)){if(materialized){materializedFrom=row.productRevision;materializedOutcome=row.outcome;}row.productRevision=source.revision;delete row.outcome;}
      }
    }
    this.migrateRepairPolicy(task,row);
    this.assertScope(task,row,true);
    // Persist this SKU's original-request permission before any costly owner work.
    // No other SKU timestamp or counter is changed here.
    if(materializedFrom!==undefined){
      const priorRevision=task.revision,priorUpdatedAt=task.updatedAt;
      try{transaction(this.db,()=>{
        appendAuditEvent(this.db,randomUUID(),row.productId,'automatic-listing.source-materialization-rebased','原SKU仅同步已证明的来源图片落地版本；历史与未知请求保留',JSON.stringify({version:1,taskId:task.id,itemKey:row.key,fromRevision:materializedFrom,toRevision:row.productRevision,sourceStamp:row.sourceStamp}),continuation.at);
        this.saveItem(task,row);
      });}catch(error){row.productRevision=materializedFrom;if(materializedOutcome)row.outcome=materializedOutcome;task.revision=priorRevision;task.updatedAt=priorUpdatedAt;throw error;}
    }else this.saveItem(task,row);
    continuation.prepared.add(row.key);
    if(row.draftId){const draft=this.deps.amazon.getDraft(row.draftId);if(submitted(draft)){row.stage='READBACK';row.status='WAITING';this.deps.followup.schedule(draft.id);this.saveItem(task,row);return;}}
    if((!row.schemaRetry||row.schemaRetry.state==='SUCCEEDED')&&row.status==='FAILED'&&row.stage!=='PLAN'&&!adaptationBlocked(task,row.key)) {

        const unknown=this.unknownCode(row,task);if(unknown&&!recoverableAiUnknown(unknown))return;
        if(row.draftId&&this.deps.amazon.applyBusinessDefaults&&!unknown&&row.repair?.phase!=='FIELDS_STARTED'){
          const old=this.deps.amazon.getDraft(row.draftId);
          const activeCompletion=new CompletionJournal(this.db).list(old.id).some(op=>!['DONE','RETIRED'].includes(op.state));
          if(!row.unitRecheck&&!activeCompletion&&old.listingProgram==='haul'&&!submitted(old)&&(row.pricingRefresh||old.businessRules?.quote===null&&(!old.businessRules.pricingDecision||old.businessRules.pricingDecision.status==='needs_input'))){
            let refreshed=old;
            if(!row.pricingRefresh){
              try{
                refreshed=this.deps.amazon.applyBusinessDefaults({id:old.id,revision:old.revision},undefined,true,(draft,db)=>{
                  row.pricingRefresh={draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft),previousDraftRevision:old.revision,previousDraftStamp:imageWorkflowDraftStamp(old),previousReason:pricingBlockingReason(old)};
                  this.saveItem(task,row,db);
                });
              }catch(error){
                // Either both writes committed or both rolled back. Reload the durable task
                // even when a caller interrupts immediately after the transaction returns.
                const saved=this.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id);
                if(saved)Object.assign(task,validateAutomaticListingTask(JSON.parse(String(saved.record_json))));
                throw error;
              }
            }
            const proof=row.pricingRefresh??{draftRevision:refreshed.revision,draftStamp:imageWorkflowDraftStamp(refreshed),previousDraftRevision:old.revision,previousDraftStamp:imageWorkflowDraftStamp(old),previousReason:pricingBlockingReason(old)};
            if(refreshed.revision!==proof.draftRevision||imageWorkflowDraftStamp(refreshed)!==proof.draftStamp)throw new UserFacingError('本地定价恢复后草稿已变化，保留原检查点待核对');
            if(row.repair&&row.repair.draftRevision===proof.previousDraftRevision&&row.repair.draftStamp===proof.previousDraftStamp){
              const remaining=fieldRepairRemaining(refreshed,this.deps.rules(),(row.repair.remaining??[]).filter(message=>message!==proof.previousReason));
              if(row.repair.phase==='FIELDS_PENDING'&&!remaining.length&&!row.repairAttempts){
                this.deps.execution.cancel(row.executionTaskIds.at(-1)!);row.repair=null;
              }else row.repair={...row.repair,remaining,draftRevision:refreshed.revision,draftStamp:imageWorkflowDraftStamp(refreshed),
                phase:row.repair.phase==='FIELDS_PENDING'&&!remaining.length?'READY':row.repair.phase};
            }
            delete row.pricingRefresh;
            const pricing=pricingOutcome(refreshed,this.deps.rules());
            if(pricing){
              row.outcome={version:1,...pricing,message:(pricingBlockingReason(refreshed,this.deps.rules())||refreshed.businessRules?.notices.join('；')||row.error||'定价资料待确认').slice(0,2000),classifiedAt:new Date().toISOString(),scope:outcomeScope(task,row),draftId:refreshed.id,draftRevision:refreshed.revision};
              row.error=row.outcome.message;row.status=pricing.kind==='RULE_FILTERED'?'SCREENED':'FAILED';this.saveItem(task,row);return;
            }
          }
        }
        row.status = 'PENDING';
        delete row.outcome;
        // Retain the precise source failure if a ready sibling has frozen this product's revision.
        if (row.stage !== 'SOURCES' && !row.repair) row.error = null;

    }
    if(row.status==='PENDING'&&!['PLAN','EXECUTION','READBACK','LABELS','COMPLETE'].includes(row.stage))this.reconcileCurrentSelection(task,row);
    this.saveItem(task,row);
  }
  private reconcileCurrentSelection(task:AutomaticListingTask,row:AutomaticListingItem):void {
    const unknown=this.unknownCode(row,task);if(unknown&&!recoverableAiUnknown(unknown))return;
    const draft=row.draftId?this.deps.amazon.getDraft(row.draftId):undefined;if(draft&&submitted(draft))return;
    const product=this.deps.store.getProduct(row.productId),rules=this.deps.rules();
    const recipes=row.salesPlan?selectSalesRecipes(product,this.deps.previewSales?.(row.productId)??previewSalesRecipes(product,this.deps.sourceReceipt?.(row.productId)??null,rules),rules,this.deps.sourceReceipt?.(row.productId)??null):null;
    const selected=recipes?recipes.some(recipe=>recipe.key===row.salesPlan?.recipe.key):this.selectedVariants(product).some(variant=>variant.id===row.variantId);
    if(!selected){row.status='SCREENED';row.error='SKU 选择规则淘汰：本次未选中；来源、草稿、已完成图片及历史保留';row.outcome={version:1,kind:'RULE_FILTERED',code:'SKU_SELECTION_FILTERED',message:row.error,classifiedAt:new Date().toISOString(),scope:outcomeScope(task,row),draftId:row.draftId,draftRevision:draft?.revision??null};}
  }
  private migrateRepairPolicy(task: AutomaticListingTask,row: AutomaticListingItem): void {
    if(row.repairPolicyVersion)return;
    row.repairPolicyVersion=FIELD_REPAIR_POLICY_VERSION;
    if(row.status!=='FAILED'||row.repairAttempts!==2||row.repair?.phase==='FIELDS_STARTED'||!row.draftId||!row.executionTaskIds.length)return;
    const draft=this.deps.amazon.getDraft(row.draftId),child=this.deps.execution.get(row.executionTaskIds.at(-1)!);
    if(!this.matching(task,row,draft)||submitted(draft)||child.items.some(item=>item.submitStarted)
      ||row.repair&&(draft.revision!==row.repair.draftRevision||imageWorkflowDraftStamp(draft)!==row.repair.draftStamp))return;
    const fields=newlyRepairableFields(draft,this.deps.store.getProduct(row.productId));
    if(!fields.length)return;
    row.repairPolicyMigration={version:FIELD_REPAIR_POLICY_VERSION,previousAttempts:2,grantedAttempts:1,grantedAt:new Date().toISOString(),fields};
  }
  /** Main-only relay for a delayed first/second-item readback; never serialized or
   * recreated after restart, and never grants a draft by lookup alone. */
  runControlledDraft<T>(draftId:string,work:()=>T):T{
    this.ensureOpen();const matches=this.managedTasks().flatMap(task=>task.items.filter(row=>row.draftId===draftId).map(row=>({task,row})));if(matches.length!==1)throw new ControlledRunError();const {task,row}=matches[0],grant=this.controlledGrants.get(task.id);if(!grant)throw new ControlledRunError();return this.controlledRuns.runTask(task.id,row.key,row.productId,grant,work);
  }
  private pump(): void {
    if (this.worker || this.closed || this.closing) return;
    this.worker = Promise.resolve().then(async () => {
      for (;;) {
        const task = this.managedTasks().find(value => value.status === 'QUEUED' && this.grants.has(value.id));
        if (!task || this.closed || this.closing) break;
        this.activeId = task.id; this.controller = new AbortController(); task.status = 'RUNNING'; this.save(task,this.db,[],undefined,[]);
        try {
          const pending=new Set(task.items.filter(row=>rowSelected(task.resumeScope,row.key)&&!task.adaptation?.blockedKeys.includes(row.key)&&!['DONE','SCREENED'].includes(row.status)&&!(row.schemaRetry&&['WAITING','IN_FLIGHT','EXHAUSTED'].includes(row.schemaRetry.state))));
          const active=new Map<AutomaticListingItem,Promise<void>>();
          let wake:Promise<void>,notify!:()=>void;
          const listen=()=>{wake=new Promise<void>(resolve=>{notify=resolve;});this.wakeRows=notify;};listen();
          const prepareRow=async(row:AutomaticListingItem)=>{
            try {
              this.prepareContinuedRow(task,row);
              if(['FAILED','DONE','SCREENED'].includes(row.status)||['READBACK','LABELS'].includes(row.stage))return;
              const execute=()=>rowSelected(task.resumeScope,row.key)?this.prepareItem(task,row):Promise.resolve();
              await this.runTaskAiScope(task,row,execute);
              delete row.batchWait;
            }
            catch (error) {
              if(error instanceof BatchWaitingError){row.batchWait={operationId:error.operationId};row.status='WAITING';row.error=error.message;this.saveItem(task,row);return;}
              if(row.batchWait&&this.deps.batch?.find(row.batchWait.operationId)?.adoption)delete row.batchWait;
              recordErrorEvidence(detail=>appendAuditEvent(this.db,randomUUID(),row.productId,'operation.failed','自动任务步骤失败（脱敏诊断）',JSON.stringify(detail),new Date().toISOString()),error,{stage:row.stage,requestId:row.stage==='CLASSIFY'?categoryFailureRequestId(this.db,row.productId,error):undefined,taskId:task.id,itemKey:row.key,sku:row.sku,operationId:row.repair?.operationId,variantId:row.variantId,draftId:row.draftId,executionTaskIds:row.executionTaskIds});
              if (!this.running(task)) { row.status = 'PENDING'; this.saveItem(task,row); return; }
              if(isSchemaTransientError(error)&&error.selection&&this.deferSchema(task,row,error))return;
              row.status = 'FAILED'; row.error = error instanceof UserFacingError?errorMessage(error):`${row.sku} · ${row.stage}：${errorMessage(error)}`.slice(0,2000);
              rememberFailure(row,new Date().toISOString(),undefined,'local-check');
              const classified=structuredClone(row);await this.classifyFailure(task,classified,error);
              if(!this.running(task))return;
              Object.assign(row,classified);this.saveItem(task,row);
              try { this.assertConnections(task); } catch (scopeError) { task.status = 'NEEDS_ATTENTION'; task.error = errorMessage(scopeError); this.saveItem(task,row); return; }
            }
          };
          try{
            while(this.running(task)&&(pending.size||active.size)){
              // A saved stage change can release a sibling without waiting for
              // seven images. Shared source/classification/family work stays one
              // owner at a time; each admitted SKU then owns its own workflow.
              await yieldToEventLoop();if(!this.running(task))break;
              for(const row of pending){
                if(active.size>=2)break;
                // The existing source downloader is single-owner. Start the next
                // SKU after shared preparation yields to its image phase.
                if([...active.keys()].some(other=>!['IMAGES','EXECUTION','READBACK','LABELS','COMPLETE'].includes(other.stage)))continue;
                const siblings=[...active.keys()].filter(other=>other.productId===row.productId);
                if(siblings.some(other=>!row.sourcesPrepared||!other.sourcesPrepared||!['IMAGES','EXECUTION','READBACK','LABELS','COMPLETE'].includes(other.stage)||row.salesPlan?.parentage==='CHILD'||other.salesPlan?.parentage==='CHILD'))continue;
                pending.delete(row);
                const work=prepareRow(row).finally(()=>{active.delete(row);notify();});active.set(row,work);
              }
              if(active.size){await Promise.race([...active.values(),wake!]);listen();}
              else break;
            }
          }finally{this.wakeRows=undefined;await Promise.allSettled(active.values());}
          if(this.running(task)&&this.deps.batch){try{await this.deps.batch.flush(task.id);}catch(error){for(const row of task.items.filter(r=>rowSelected(task.resumeScope,r.key)&&r.batchWait))row.error=errorMessage(error);}}
          if (this.running(task)) await this.summarize(task);
        } finally { if(!task.items.some(row=>rowSelected(task.resumeScope,row.key)&&row.status==='WAITING'))this.grants.delete(task.id); this.activeId = null; this.controller = null; }
      }
      await this.refreshWaiting();
    }).finally(() => { this.worker = null; if(this.managedTasks().some(task=>task.status==='QUEUED'&&this.grants.has(task.id)))this.pump(); });
  }
  private schemaScope(task:AutomaticListingTask,row:AutomaticListingItem,selected:NonNullable<AutomaticListingItem['schemaRetry']>['selection']):string {
    return fingerprint({taskId:task.id,key:row.key,productRevision:row.productRevision,sourceStamp:row.sourceStamp,targetStamp:task.targetStamp,rulesStamp:task.rulesStamp,profileStamp:task.profileStamp,selection:[selected.targetId,selected.productType,selected.requirements,selected.parentageLevel,selected.locale]});
  }
  private deferSchema(task:AutomaticListingTask,row:AutomaticListingItem,error:SchemaTransientError):boolean {
    const selected=error.selection;
    if(!selected||selected.targetId!==task.targetId||!this.deps.amazon.getSchema)return false;
    const scope=this.schemaScope(task,row,selected),now=Date.now();
    if(row.schemaRetry&&row.schemaRetry.scope!==scope)return false;
    row.schemaRetry??={version:1,scope,selection:{...selected},originalStage:row.stage,firstFailureAt:new Date(now).toISOString(),dueAt:new Date(now+30_000).toISOString(),deadlineAt:new Date(now+600_000).toISOString(),usedDelayedRounds:0,state:'WAITING',reason:'SCHEMA_TRANSIENT'};
    const retry=row.schemaRetry;
    if(retry.state==='SUCCEEDED'){retry.originalStage=row.stage;retry.dueAt=new Date(Math.min(Date.parse(retry.deadlineAt),now+([30_000,90_000,180_000][retry.usedDelayedRounds]??0))).toISOString();}
    if(retry.usedDelayedRounds>=3||now>=Date.parse(retry.deadlineAt)){retry.state='EXHAUSTED';row.status='FAILED';row.error='Schema 有限重试已用尽或超过 10 分钟，原进度和次数保留';}
    else {retry.state='WAITING';row.status='WAITING';row.error='等待 Schema GET 有限重试，已有图片和请求进度保留';}
    this.saveItem(task,row);return true;
  }
  private async retrySchema(task:AutomaticListingTask,row:AutomaticListingItem):Promise<boolean>{
    const retry=row.schemaRetry!;
    const eligible=()=>!this.closed&&!this.closing&&!this.schedulingSuspended&&!this.confirming.has(task.id)&&this.grants.has(task.id)&&['WAITING','NEEDS_ATTENTION'].includes(task.status);
    if(!eligible()||retry.state!=='WAITING')return false;
    const next=planSchemaAttempt(retry,Date.now());
    if(next.kind==='exhausted'){Object.assign(retry,next.budget);row.status='FAILED';row.error='Schema 有限重试已用尽或超过 10 分钟，原进度和次数保留';this.saveItem(task,row);return false;}
    if(next.kind==='waiting')return false;
    try {
      this.assertScope(task,row);
      if(retry.scope!==this.schemaScope(task,row,retry.selection))throw new UserFacingError('Schema 重试范围已变化，原进度保留');
      const reserved=reserveSchemaAttempt(this.db,task.id,row.key,retry,Date.now());Object.assign(retry,reserved.budget);
      if(reserved.kind!=='ready'){if(reserved.kind==='exhausted'){row.status='FAILED';row.error='Schema 有限重试已用尽，原进度和次数保留';this.saveItem(task,row);}return false;}
      this.saveItem(task,row);
      const revision=task.revision;
      try {await this.runTaskAiScope(task,row,()=>this.deps.amazon.getSchema!(retry.selection));}
      catch(error){
        if(!eligible()||task.revision!==revision){retry.state='WAITING';this.saveItem(task,row);return false;}
        this.assertScope(task,row);
        if(!isSchemaTransientError(error))throw error;
        retry.state='WAITING';retry.dueAt=new Date(Math.min(Date.parse(retry.deadlineAt),Date.now()+([30_000,90_000,180_000][retry.usedDelayedRounds]??0))).toISOString();
        if(retry.usedDelayedRounds>=3){retry.state='EXHAUSTED';row.status='FAILED';row.error='Schema 有限重试已用尽，原进度和次数保留';}
        this.saveItem(task,row);return false;
      }
      if(!eligible()||task.revision!==revision){retry.state='WAITING';this.saveItem(task,row);return false;}
      this.assertScope(task,row);
      if(retry.scope!==this.schemaScope(task,row,retry.selection))throw new UserFacingError('Schema 重试范围已变化');
      if(Date.now()>=Date.parse(retry.deadlineAt))throw new UserFacingError('Schema 重试超过 10 分钟，原进度和次数保留');
      retry.state='SUCCEEDED';row.stage=retry.originalStage;row.status='PENDING';row.error=null;this.saveItem(task,row);return true;
    }catch(error){retry.state='EXHAUSTED';row.status='FAILED';row.error=errorMessage(error);this.saveItem(task,row);return false;}
  }
  /** Source siblings have independent continuation grants and Batch operation ownership. */
  private runTaskAiScope<T>(task:AutomaticListingTask,row:AutomaticListingItem,action:()=>T):T {
    const scope={taskId:task.id,rowKey:row.key,explicitContinueAt:row.lastContinuedAt,
      get phase(){return row.stage.toLowerCase();},mode:task.executionMode??'immediate',
      get waitingOperationId(){return row.batchWait?.operationId;},credentialScope:task.batchPlan?.credentialScope,purposes:task.batchPlan?.purposes,
      authorize:()=>rowSelected(task.resumeScope,row.key)&&this.batchAuthorized(task)&&!['FAILED','DONE','SCREENED'].includes(row.status)};
    return this.controlledRuns.runTask(task.id,row.key,row.productId,this.controlledGrants.get(task.id),()=>this.deps.batch?this.deps.batch.run(scope,action):taskAiContext.run(scope,action));
  }
  private batchAuthorized(task:AutomaticListingTask):boolean{
    if(!this.running(task))return false;
    const saved=this.db.prepare("SELECT json_extract(record_json,'$.revision') revision,json_extract(record_json,'$.status') status FROM automatic_listing_tasks WHERE id=?").get(task.id);
    return saved?.status==='RUNNING'&&saved.revision===task.revision;
  }
  private running(task: AutomaticListingTask): boolean { return !this.closed && !this.closing && task.status === 'RUNNING' && this.grants.has(task.id); }
  private checkpoint(task: AutomaticListingTask, row: AutomaticListingItem): void {
    if (!this.running(task)) throw new UserFacingError('自动任务已暂停或取消');
    this.assertScope(task, row);
  }
  private matching(task: AutomaticListingTask, row: AutomaticListingItem, draft: AmazonDraft): boolean {
    return draft.productId === row.productId && draft.variantId === row.variantId && draft.sku === row.sku && draft.targetId === task.targetId
      && draft.sellerId === task.sellerId && draft.marketplaceId === task.marketplaceId && draft.mode === task.mode;
  }
  private imagePolicyCompatible(run:ImageWorkflowRun|null|undefined): boolean {return !!run&&(this.deps.images.isRiskPolicyCompatible?.(run)??true)&&(this.deps.images.isCopyReviewPolicyCompatible?.(run)??true);}
  /** Recheck original candidates; partial admission retains the original missing-slot budget. */
  private async finishUnitRecheck(task:AutomaticListingTask,row:AutomaticListingItem):Promise<AmazonDraft>{
    const proof=row.unitRecheck!,draft=this.deps.amazon.getDraft(row.draftId!),input={taskId:task.id,itemKey:row.key,draftId:draft.id,draftRevision:draft.revision,sourceWorkflowId:proof.sourceWorkflowId};
    if(!this.matching(task,row,draft)||submitted(draft)||(draft.revision!==proof.draftRevision||imageWorkflowDraftStamp(draft)!==proof.draftStamp)&&!this.deps.images.canResumeUnitRecheckDraft?.(input))throw new UserFacingError('计量采用后草稿检查点已变化，请核对原记录；未重新生图');
    const prior=this.deps.images.getProgress(draft.id);
    if(!prior||(!this.imageReady(prior)||prior.unitAdoptionReview)&&!this.deps.recheckUnitImage||this.imageReady(prior)&&!prior?.unitAdoptionReview&&!this.deps.recheckImage)throw new UserFacingError('计量变化需复核原成功图片；当前原七图或复核服务不完整，未重新生图');
    const signal=this.controller?.signal??new AbortController().signal,authorize=()=>{try{this.checkpoint(task,row);return true;}catch{return false;}};
    const after=this.deps.recheckUnitImage?await this.deps.recheckUnitImage(input,signal,authorize):await this.deps.recheckImage!({draftId:draft.id,draftRevision:draft.revision,sourceWorkflowId:proof.sourceWorkflowId},signal);
    const finalWorkflow=this.deps.images.getProgress(draft.id);if(!this.imageReady(finalWorkflow))throw new UserFacingError('计量复核尚未完成全部原图位；原标记与图片保留');
    this.checkpoint(task,row);
    if(!this.matching(task,row,after)||submitted(after))throw new UserFacingError('原图复核后的草稿身份变化');
    const next=structuredClone(task),checkpoint=next.items.find(item=>item.key===row.key)!;
    checkpoint.imageAttempts=Math.max(checkpoint.imageAttempts,finalWorkflow!.attempt+(finalWorkflow!.legacyImageAttempts??0));delete checkpoint.unitRecheck;this.save(next,this.db,[],undefined,[row.key]);
    // Publish the local checkpoint only after the SQLite write committed. A
    // failed task write keeps both memory and disk pointing at the saved result.
    row.imageAttempts=checkpoint.imageAttempts;delete row.unitRecheck;task.revision=next.revision;task.updatedAt=next.updatedAt;
    this.tasks.set(task.id,task);return after;
  }
  private imageReady(run:ImageWorkflowRun|null|undefined): boolean {return imageReady(run)&&this.imagePolicyCompatible(run);}
  private async prepareItem(task: AutomaticListingTask, row: AutomaticListingItem): Promise<void> {
    const unknown=this.unknownCode(row,task);
    if(unknown&&!recoverableAiUnknown(unknown)&&!(unknown==='SUBMISSION_UNKNOWN'&&row.draftId&&submitted(this.deps.amazon.getDraft(row.draftId))))throw new UserFacingError(row.error||'上次付费请求或提交结果尚未确认，请先核对；未自动重发');
    this.checkpoint(task, row);
    if(task.resumeScope?.mode==='recheck'&&!this.continuations.get(task.id)?.fromStart){
      const checked=await this.inspectResumeRow(task,row);this.checkpoint(task,row);
      if(checked.blockers.length)throw new UserFacingError('从头检查未通过，本次未执行后续请求：'+checked.blockers.join('；'));
      if(checked.fields.length&&row.draftId&&row.executionTaskIds.length&&!row.repair){
        const current=this.deps.amazon.getDraft(row.draftId),prior=this.deps.images.getProgress(row.draftId);
        if(!this.deps.repairFields||!this.deps.recheckImage||!this.imageReady(prior)||row.repairAttempts>=repairLimit(row))throw new UserFacingError('从头检查发现字段待处理，本次未执行：'+checked.fields.join('；'));
        row.repair={phase:'FIELDS_PENDING',sourceWorkflowId:prior!.id,draftRevision:current.revision,draftStamp:imageWorkflowDraftStamp(current),remaining:checked.fields};this.saveItem(task,row);
      }
    }
    let draft = row.draftId ? this.deps.amazon.getDraft(row.draftId) : undefined;
    if (!draft) {
      const existing = this.deps.amazon.listDrafts(row.productId).filter(value => this.matching(task, row, value));
      const sent = existing.find(submitted);
      if (sent) { row.draftId = sent.id; row.stage = 'READBACK'; row.status = 'WAITING'; this.deps.followup.schedule(sent.id); this.saveItem(task,row); return; }
    } else if (!this.matching(task, row, draft)) throw new UserFacingError('任务草稿归属发生变化');
    if (draft && submitted(draft)) { row.stage = 'READBACK'; row.status = 'WAITING'; this.deps.followup.schedule(draft.id); this.saveItem(task,row); return; }
    if (row.sourcesPrepared) {
      // Legacy tasks only recorded source delivery. Establish the current visual
      // proof without downloading again or changing the frozen product revision.
      const variantIds=row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId];
      try { assertProductConsistency(this.db,this.deps.store.getProduct(row.productId),variantIds); }
      catch(error) {
        if(!(error instanceof SourceConsistencyError)||!['SOURCE_CONSISTENCY_NEEDS_INPUT','SOURCE_CONSISTENCY_INVALID_OUTPUT','SOURCE_CONSISTENCY_SENT_UNKNOWN','SOURCE_CONSISTENCY_AUTH_FAILED'].includes(error.code))throw error;
        if(!this.deps.prepareSourceConsistency)throw new SourceConsistencyError('SYSTEM_REPAIR','SOURCE_CONSISTENCY_UNAVAILABLE','来源图与规格校验服务尚未初始化');
        await this.deps.prepareSourceConsistency({productId:row.productId,productRevision:row.productRevision,variantIds},this.controller!.signal,()=>this.checkpoint(task,row));
        this.checkpoint(task,row);
        assertProductConsistency(this.db,this.deps.store.getProduct(row.productId),variantIds);
      }
    }
    if (!row.sourcesPrepared) {
      // A new exact visual decision needs no source redelivery or sibling revision rebase.
      try {
        assertProductConsistency(this.db,this.deps.store.getProduct(row.productId),row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId]);
        row.sourcesPrepared=true;row.stage='DRAFT';row.error=null;delete row.outcome;this.save(task,this.db,[{key:row.key,stage:'SOURCES'}]);
      } catch(error) {
        if(!(error instanceof SourceConsistencyError))throw error;
        // A retained format failure already has its exact source scope. Recover it
        // before frozen-sibling delivery guards; recovery never needs another download.
        if(['SOURCE_CONSISTENCY_INVALID_OUTPUT','SOURCE_CONSISTENCY_SENT_UNKNOWN','SOURCE_CONSISTENCY_AUTH_FAILED'].includes(error.code)
          ||error.code==='SOURCE_CONSISTENCY_NEEDS_INPUT'&&this.canRebaseMaterializedSources(task,row,this.deps.store.getProduct(row.productId))){
          if(!this.deps.prepareSourceConsistency)throw error;
          const variantIds=row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId];
          await this.deps.prepareSourceConsistency({productId:row.productId,productRevision:row.productRevision,variantIds},this.controller!.signal,()=>this.checkpoint(task,row));
          this.checkpoint(task,row);assertProductConsistency(this.db,this.deps.store.getProduct(row.productId),variantIds);
          row.sourcesPrepared=true;row.stage='DRAFT';row.error=null;delete row.outcome;this.save(task,this.db,[{key:row.key,stage:'SOURCES'}]);
        }
      }
    }
    if (!row.sourcesPrepared) {
      // Only an explicit local SKU binding, after all ready siblings submitted, can
      // release the frozen source group. prepareSources verifies that binding itself.
      const sourceProduct=this.deps.store.getProduct(row.productId);
      const confirmedRecovery=this.canRebaseSources(task,row)&&(row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId]).every(id=>sourceProduct.assets.some(asset=>asset.variantIds.includes(id)));
      if (task.items.some(value => value.productId === row.productId && value.sourcesPrepared) && !confirmedRecovery) {
        const product=this.deps.store.getProduct(row.productId);
        const receipt=readSourceImageReceipt(this.db,row.productId)??sourceImageReceipt(null,this.deps.sourceReceipt?.(row.productId));
        const issue=receipt&&(row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId]).map(id=>sourceImageMappingDiagnosis(product,id,receipt)).find(Boolean);
        const bindingIssue=issue&&(!row.outcome||Object.hasOwn(AUTOMATIC_SOURCE_ISSUES,row.outcome.code));
        if(issue&&bindingIssue)row.outcome={version:1,kind:AUTOMATIC_SOURCE_ISSUES[issue.code],code:issue.code,message:issue.message.slice(0,2000),classifiedAt:new Date().toISOString(),scope:outcomeScope(task,row),draftId:null,draftRevision:null};
        const reason = (issue&&bindingIssue?issue.message:null) || row.error || '该 SKU 的来源图片尚未准备完成';
        throw new UserFacingError(!bindingIssue||reason.includes(frozenSourcesMessage) ? reason : `${reason}；${frozenSourcesMessage}`);
      }
      const siblings = task.items.filter(value => rowSelected(task.resumeScope,value.key)&&value.status!=='SCREENED'&&value.productId === row.productId && !value.sourcesPrepared && value.stage === 'SOURCES');
      row.status = 'RUNNING'; row.stage = 'SOURCES'; this.saveItem(task,row);
      const result = await this.deps.images.prepareSources({ productId: row.productId, productRevision: row.productRevision, variantIds: [...new Set(siblings.flatMap(value => value.salesPlan?.recipe.components.map(c=>c.variantId)??[value.variantId]))] });
      if (sourceStamp(result.product) !== row.sourceStamp) throw new UserFacingError('准备来源图期间商品资料变化');
      // One verified source delivery advances the whole frozen sibling group
      // before any one SKU can freeze it during consistency checking.
      for(const sibling of siblings)sibling.productRevision=result.product.revision;
      for (const sibling of siblings) {
        this.prepareContinuedRow(task,sibling);
        let missing = result.missing.find(value => (sibling.salesPlan?.recipe.components.map(c=>c.variantId)??[sibling.variantId]).includes(value.variantId));
        let consistencyError:SourceConsistencyError|undefined;
        if(!missing){
          try{
            this.checkpoint(task,sibling);
            if(!this.deps.prepareSourceConsistency)throw new SourceConsistencyError('SYSTEM_REPAIR','SOURCE_CONSISTENCY_UNAVAILABLE','来源图与规格校验服务尚未初始化');
            await this.runTaskAiScope(task,sibling,()=>this.deps.prepareSourceConsistency!({productId:sibling.productId,productRevision:sibling.productRevision,variantIds:sibling.salesPlan?.recipe.components.map(c=>c.variantId)??[sibling.variantId]},this.controller!.signal,()=>this.checkpoint(task,sibling)));
            this.checkpoint(task,sibling);assertProductConsistency(this.db,this.deps.store.getProduct(sibling.productId),sibling.salesPlan?.recipe.components.map(c=>c.variantId)??[sibling.variantId]);
          }catch(error){
            if(!this.running(task))throw error;
            consistencyError=error instanceof SourceConsistencyError?error:new SourceConsistencyError('SYSTEM_REPAIR',error instanceof AiError?'AI_'+error.code:'SOURCE_CONSISTENCY_REQUEST_FAILED',errorMessage(error));
            try{assertProductConsistency(this.db,this.deps.store.getProduct(sibling.productId),sibling.salesPlan?.recipe.components.map(c=>c.variantId)??[sibling.variantId]);}catch(proofError){if(proofError instanceof SourceConsistencyError&&proofError.kind==='UNKNOWN')consistencyError=proofError;}
            missing={variantId:sibling.variantId,message:consistencyError.message};
          }
        }
        // Finish the group download first, then require every component of this sales SKU.
        sibling.sourcesPrepared = !missing; sibling.stage = missing ? 'SOURCES' : 'DRAFT';
        sibling.status = missing ? 'FAILED' : 'PENDING'; sibling.error = missing?.message ?? null;
        if(missing)sibling.outcome={version:1,kind:missing.code?AUTOMATIC_SOURCE_ISSUES[missing.code]:'NEEDS_INPUT',code:missing.code??'SOURCE_INPUT_REQUIRED',message:missing.message.slice(0,2000),classifiedAt:new Date().toISOString(),scope:outcomeScope(task,sibling),draftId:null,draftRevision:null};
        else delete sibling.outcome;
        if(consistencyError)sibling.outcome={version:1,kind:consistencyError.kind,code:consistencyError.code,message:consistencyError.message,classifiedAt:new Date().toISOString(),scope:outcomeScope(task,sibling),draftId:null,draftRevision:null};
      }
      if (siblings.some(sibling => sibling.sourcesPrepared)) {
        for (const sibling of siblings) if (!sibling.sourcesPrepared&&sibling.outcome?.kind==='NEEDS_INPUT'&&(!sibling.outcome.code||Object.hasOwn(AUTOMATIC_SOURCE_ISSUES,sibling.outcome.code))) sibling.error = errorMessage(new UserFacingError(`${sibling.error}；${frozenSourcesMessage}`));
      }
      this.save(task,this.db,siblings.filter(sibling=>sibling.sourcesPrepared).map(sibling=>({key:sibling.key,stage:'SOURCES'})),undefined,siblings.map(sibling=>sibling.key)); this.checkpoint(task, row);
      if (!row.sourcesPrepared) throw new UserFacingError(row.error!);
    }
    row.status = 'RUNNING';
    if (task.productType === 'AUTO' && !row.classification) {
      if (!this.deps.classify) throw new UserFacingError('逐商品分类服务尚未初始化');
      row.stage = 'CLASSIFY'; this.saveItem(task,row);
      const classification = await this.deps.classify({ productId:row.productId,productRevision:row.productRevision,targetId:task.targetId }, this.controller!.signal);
      this.checkpoint(task,row);
      for (const sibling of task.items.filter(item=>item.productId===row.productId)) sibling.classification = structuredClone(classification);
      this.save(task,this.db,[{key:row.key,stage:'CLASSIFY'}],undefined,task.items.filter(item=>item.productId===row.productId).map(item=>item.key));
    }
    const productType = row.classification?.productType ?? task.productType;
    if(row.salesPlan&&!row.salesPlan.familyResolved){
      if(!this.deps.resolveFamily)throw new UserFacingError('销售组合类目规则尚未初始化');
      const siblings=task.items.filter(value=>value.salesPlan?.sourceGroupKey===row.salesPlan!.sourceGroupKey);
      const plans=await this.deps.resolveFamily({plans:siblings.map(value=>value.salesPlan!),targetId:task.targetId,productType,locale:task.locale},this.controller!.signal);
      this.checkpoint(task,row);
      for(const sibling of siblings){const plan=plans.find(value=>value.sku===sibling.sku);if(!plan)throw new UserFacingError('类目关系缺少销售 SKU');sibling.salesPlan=plan;}
      this.save(task,this.db,[],undefined,siblings.map(sibling=>sibling.key));
    }
    const parentage=row.salesPlan?.parentage??'NONE';
    if (!draft) {
      draft = this.deps.amazon.listDrafts(row.productId).find(value => this.matching(task, row, value) && value.productRevision === row.productRevision
        && !submitted(value) && ['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(value.state) && value.schema.productType === productType
        && value.schema.requirements === 'LISTING' && value.schema.parentageLevel === parentage && value.schema.locale === task.locale
        && value.listingProgram === (task.mode === 'live' ? 'haul' : 'standard'));
      if (draft) { row.draftId = draft.id; this.saveItem(task,row); }
    }
    if (!draft) {
      row.stage = 'DRAFT'; this.saveItem(task,row);
      // Preparation service reuses matching editable drafts and validates listing identity itself.
      const result = await this.deps.amazon.prepareDrafts({ targetId: task.targetId, productType, parentageLevel: parentage, requirements: 'LISTING', locale: task.locale,
        listingProgram: task.mode === 'live' ? 'haul' : 'standard', items: [{ productId: row.productId, productRevision: row.productRevision, variantId: row.variantId, attributes: {} }] },row.salesPlan?[row.salesPlan]:undefined);
      const prepared = result.items.find(value => value.productId === row.productId && value.variantId === row.variantId);
      if (!prepared?.draft || prepared.disposition === 'REJECTED') throw new UserFacingError(prepared?.error || prepared?.issues.map(value => value.message).join('；') || '草稿准备未返回有效结果');
      draft = prepared.draft; row.draftId = draft.id; this.saveItem(task,row); this.checkpoint(task, row);
    }
    if (!this.matching(task, row, draft) || draft.productRevision !== row.productRevision) throw new UserFacingError('准备后的草稿范围与任务不一致');
    if(draft.businessRules?.quote&&draft.businessRules.pricingDecision?.version!==3&&draft.businessRules.revision!==task.ruleRevision)throw new UserFacingError('上架规则已变化，请核对并重新计算已有草稿报价；未沿用旧报价');
    assertCurrentPricingForPaid(draft,this.deps.rules());
    const pricingIssue=pricingBlockingReason(draft,this.deps.rules());
    if(pricingIssue){row.stage='DRAFT';this.saveItem(task,row);throw new UserFacingError(pricingIssue);}
    if(row.unitRecheck)draft=await this.finishUnitRecheck(task,row);
    if(row.familyTransition)draft=await this.finishFamilyTransition(task,row);
    if (!row.executionTaskIds.length||this.deps.execution.get(row.executionTaskIds.at(-1)!).status==='CANCELLED') {
      const prior = this.deps.images.getProgress(draft.id);
      row.stage = 'IMAGES'; this.save(task,this.db,[{key:row.key,stage:'DRAFT'}]);
      if (!this.imageReady(prior)) {
        const changedRiskPolicy=canResumeRiskAdaptation(this.db,task,row,draft,prior,this.deps.store.getProduct(row.productId))||!!prior&&(!this.imagePolicyCompatible(prior)||prior.status==='BLOCKED'&&(this.deps.images.getRiskSettings?.().enabled===false||this.deps.images.getCopyReviewSettings?.().enabled===false));
        if (row.imageStarted && !canResumeImageWorkflow(prior) && !this.deps.images.hasHistoricalRetryAllowance?.(draft.id) && !changedRiskPolicy && !(unknown==='IMAGE_RESULT_UNKNOWN')) throw new UserFacingError(prior?.error || '上次图片请求未确认完成；未自动重新生图。请在异常商品中核对已有结果后继续。');
        // complete rejects local preflight synchronously and defers admitted work.
        // Save the conservative unknown marker before awaiting that work, not before
        // the no-send entry checks; a rejected entry must remain recoverable.
        const operation = this.deps.images.complete({ draftId: draft.id, draftRevision: draft.revision },{...(row.imageStarted&&!prior?{legacyImageAttempts:row.imageAttempts}:{}),...(task.resumeScope?.selections.find(selection=>selection.key===row.key)?.slots?{selectedSlots:task.resumeScope.selections.find(selection=>selection.key===row.key)!.slots}:{})});
        row.imageStarted = true; this.saveItem(task,row);
        const result = await operation;
        if(result.workflow.rejection)row.rejection={workflowId:result.workflow.id,detail:structuredClone(result.workflow.rejection)};else delete row.rejection;
        if(result.workflow.retryAllowance)row.imageRetryAllowance={workflowId:result.workflow.id,allowance:structuredClone(result.workflow.retryAllowance)};
        row.imageAttempts = result.workflow.attempt+(result.workflow.legacyImageAttempts??0); this.saveItem(task,row);
        const selectedSlots=task.resumeScope?.selections.find(selection=>selection.key===row.key)?.slots;
        if(selectedSlots){
          this.checkpoint(task,row);
          const selected=(result.workflow.slots??[]).filter(slot=>selectedSlots.includes(slot.index));
          const passed=selected.length===selectedSlots.length&&selected.every(slot=>slot.status==='PASSED');
          row.status=passed?'PENDING':'FAILED';
          row.error=selected.map(slot=>`图位 ${slot.index}：${slot.status==='PASSED'?'通过并保留':slot.error||'核对后仍待处理'}`).join('；')+'；未执行其他图位或上传提交，其他历史成果和失败保留';
          for(const slot of selected){const before=prior?.slots?.find(old=>old.index===slot.index);if(slot.status!=='PASSED'&&fingerprint(slot)!==fingerprint(before??null)){const snapshot={...row,error:slot.error??result.workflow.error??'所选图位处理未完成'};rememberFailure(snapshot,new Date().toISOString(),slot.index,'local-check');row.failureHistory=snapshot.failureHistory;}}
          this.saveItem(task,row);return;
        }
        if (!this.imageReady(result.workflow)){const pending=result.workflow.pendingRequest;const legacy=result.workflow.planningUnknown;if(pending||legacy){const error=new AiError('INTERRUPTED');error.callId=(pending??legacy)!.callId;error.certainty=(pending??legacy)!.certainty;error.diagnosticReason=legacy||pending?.step==='planning'?'IMAGE_PLAN_RESULT_UNKNOWN':'IMAGE_REVIEW_RESULT_UNKNOWN';error.message=result.workflow.error||'原图片操作结果待核对，未发送新请求';throw error;}throw new UserFacingError(result.workflow.error || '侵权检测或文字视觉复核未通过，尚无可用图片');}
        draft = result.draft;
      }
      this.checkpoint(task, row);
    }
    if(task.resumeScope?.selections.find(selection=>selection.key===row.key)?.slots){row.status='PENDING';row.error='所选图位处理结束；未执行其他图位或上传提交。需要继续时重新选择范围';this.saveItem(task,row);return;}
    if(row.repair){await this.finishRepair(task,row);draft=this.deps.amazon.getDraft(draft.id);}
    draft=await this.reconcileFamily(task,row,draft);
    if (!row.executionTaskIds.length||this.deps.execution.get(row.executionTaskIds.at(-1)!).status==='CANCELLED') {
      if(row.salesPlan?.parentage==='CHILD'){
        if(!this.deps.ensureParent)throw new UserFacingError('父体建档服务尚未初始化');
        row.stage='PARENT';this.save(task,this.db,[{key:row.key,stage:'IMAGES'}]);
        const parent=await this.deps.ensureParent(this.deps.amazon.getDraft(draft.id),task.profileId,this.controller!.signal,task.hostingRoute??DIRECT_HOSTING_ROUTE);
        row.parentDraftId=parent.draftId;this.checkpoint(task,row);
        if(!parent.ready){row.status='WAITING';this.saveItem(task,row);return;}
      }
      const child = this.childFor(task, draft);
      row.executionTaskIds.push(child.id); row.stage = 'EXECUTION'; this.save(task,this.db,[{key:row.key,stage:row.salesPlan?.parentage==='CHILD'?'PARENT':'IMAGES'}]);
    }
    for (;;) {
      this.checkpoint(task, row);
      if(!this.imagePolicyCompatible(this.deps.images.getProgress(draft.id)))throw new UserFacingError('图片与当前风险拦截或文案复核设置不一致，请先在异常商品复核已有图片后继续；尚未上传或提交。');
      if (row.repair) await this.finishRepair(task, row);
      const childId = row.executionTaskIds.at(-1)!;
      let child = this.deps.execution.get(childId);
      if (child.status !== 'COMPLETED') {
        this.deps.execution.startAuthorized(this.deps.execution.prepareStart(childId));
        await this.deps.execution.waitForIdle(); child = this.deps.execution.get(childId);
      }
      const current = this.deps.amazon.getDraft(draft.id);
      if (submitted(current)) {
        row.stage = 'READBACK'; row.status = 'WAITING'; row.error = null;
        this.deps.followup.schedule(current.id); this.save(task,this.db,child.status==='COMPLETED'&&current.submittedAt?[{key:row.key,stage:'EXECUTION'}]:[],undefined,[row.key]); return;
      }
      this.checkpoint(task, row);
      if (child.status === 'COMPLETED') throw new UserFacingError('执行结束但没有可核对的提交记录');
      const item = child.items[0], failed = item?.steps.find(step => step.status === 'FAILED');
      if (!this.deps.repairFields || !this.deps.recheckImage || item?.submitStarted || !failed || !['validate','preview','submit'].includes(failed.name)
        || row.repairAttempts >= repairLimit(row) && !canMigrateCategory(row,current) && (!this.deps.prepareSourceColors || row.sourceColorRepair || !needsSourceColor(current)))
        throw new UserFacingError(failed?.error || child.error || '执行未完成，请查看异常原因');
      const prior = this.deps.images.getProgress(draft.id);
      if (!this.imageReady(prior)) throw new UserFacingError('原图片复核记录不可用，未自动重生成');
      row.stage = 'IMAGES';
      row.repair = { phase: 'FIELDS_PENDING', sourceWorkflowId: prior!.id, draftRevision: current.revision, draftStamp: imageWorkflowDraftStamp(current) }; this.saveItem(task,row);
    }
  }
  private async reconcileFamily(task:AutomaticListingTask,row:AutomaticListingItem,draft:AmazonDraft):Promise<AmazonDraft>{
    if(!this.deps.rebindFamily||!this.deps.planSales||!this.deps.resolveFamily||!row.salesPlan||row.salesPlan.parentage!=='NONE'||submitted(draft))return draft;
    const image=this.deps.images.getProgress(draft.id);if(!this.imageReady(image))return draft;
    const selected=new Set(task.items.filter(i=>i.productId===row.productId).map(i=>i.salesPlan?.recipe.key));
    const fresh=this.deps.planSales(row.productId,task.targetId).filter(p=>selected.has(p.recipe.key)),proposed=fresh.find(p=>p.recipe.key===row.salesPlan!.recipe.key);
    if(!proposed)return draft;
    const siblings=fresh.filter(p=>p.sourceGroupKey===proposed.sourceGroupKey);if(siblings.length<2)return draft;
    const resolved=await this.deps.resolveFamily({plans:siblings,targetId:task.targetId,productType:draft.schema.productType,locale:task.locale},this.controller!.signal);
    this.checkpoint(task,row);
    const next=resolved.find(p=>p.recipe.key===row.salesPlan!.recipe.key);if(!next||next.parentage!=='CHILD')return draft;
    const plan=reconcileSalesIdentity(row.salesPlan,next);
    if(row.executionTaskIds.some(id=>this.deps.execution.get(id).items.some(i=>i.submitStarted)))throw new UserFacingError('已有提交意图，先按原任务核实结果后再调整父子关系');
    // Save intent before changing the draft. A restart continues with the original
    // seven-image source and never treats a changed schema as permission to regenerate.
    row.familyTransition={phase:'BIND',plan,sourceWorkflowId:image!.id,draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)};
    this.saveItem(task,row);return this.finishFamilyTransition(task,row);
  }
  private async finishFamilyTransition(task:AutomaticListingTask,row:AutomaticListingItem):Promise<AmazonDraft>{
    let change=row.familyTransition!,draft=this.deps.amazon.getDraft(row.draftId!);
    if(!this.deps.rebindFamily||!this.deps.recheckImage||submitted(draft))throw new UserFacingError('父子体转换需要可编辑草稿及原图复核服务');
    if(row.executionTaskIds.some(id=>this.deps.execution.get(id).items.some(i=>i.submitStarted)))throw new UserFacingError('已有提交意图，未继续转换草稿关系');
    this.checkpoint(task,row);
    if(change.phase==='BIND'){
      const saved=draft.revision===change.draftRevision+1&&draft.salesPlan&&fingerprint(validateSalesPlan(draft.salesPlan))===fingerprint(validateSalesPlan(change.plan))
        &&draft.events.at(-1)?.summary===FAMILY_REBIND_EVENT_SUMMARY&&draft.events.at(-1)?.at===draft.updatedAt;
      if(!saved){
        if(draft.revision!==change.draftRevision||imageWorkflowDraftStamp(draft)!==change.draftStamp)throw new UserFacingError('父子体转换前草稿已变化，保留原图等待核对');
        draft=await this.deps.rebindFamily({id:draft.id,revision:draft.revision,plan:change.plan},this.controller!.signal);
      }
      row.salesPlan=structuredClone(change.plan);
      row.familyTransition=change={...change,phase:'RECHECK',draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)};this.saveItem(task,row);
      this.checkpoint(task,row);
    }
    if(change.phase==='RECHECK'){
      if(draft.revision!==change.draftRevision||imageWorkflowDraftStamp(draft)!==change.draftStamp){
        if(draft.revision<=change.draftRevision||!this.deps.images.canResumeRecheckDraft?.({draftId:draft.id,draftRevision:draft.revision,sourceWorkflowId:change.sourceWorkflowId}))throw new UserFacingError('父子体转换后的草稿已变化，请核对原图复核进度');
        row.familyTransition=change={...change,draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)};this.saveItem(task,row);
      }
      draft=await this.deps.recheckImage({draftId:draft.id,draftRevision:draft.revision,sourceWorkflowId:change.sourceWorkflowId},this.controller!.signal);
      row.familyTransition=change={...change,phase:'READY',draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)};this.saveItem(task,row);
      this.checkpoint(task,row);
    }
    if(draft.revision!==change.draftRevision||imageWorkflowDraftStamp(draft)!==change.draftStamp)throw new UserFacingError('父子体转换后草稿发生变化');
    const active=row.executionTaskIds.map(id=>this.deps.execution.get(id));
    if(active.some(t=>t.items.some(i=>i.submitStarted)))throw new UserFacingError('已有提交意图，未替换执行任务');
    for(const prior of active)if(!['COMPLETED','CANCELLED'].includes(prior.status))this.deps.execution.cancel(prior.id);
    row.stage='IMAGES';delete row.familyTransition;this.saveItem(task,row);return draft;
  }
  private async finishRepair(task: AutomaticListingTask, row: AutomaticListingItem): Promise<void> {
    let repair = row.repair!;
    const before=this.deps.amazon.getDraft(row.draftId!);
    const localRefresh=!!repair.operationId&&(repair.businessAuthorityRefresh==='business-authority/v1'||needsBusinessAuthorityRefresh(before,repair.remaining))
      &&new CompletionJournal(this.db).get(repair.operationId).state==='DONE';
    if(localRefresh&&repair.phase==='FIELDS_PENDING'){
      if(!this.matching(task,row,before)||submitted(before)||before.revision!==repair.draftRevision||imageWorkflowDraftStamp(before)!==repair.draftStamp
        ||row.executionTaskIds.some(id=>this.deps.execution.get(id).items.some(i=>i.submitStarted||i.draftId!==before.id)))throw new UserFacingError('旧事实恢复范围或提交记录已变化，未修改草稿');
      row.repair=repair={...repair,phase:'FIELDS_STARTED',businessAuthorityRefresh:'business-authority/v1'};this.saveItem(task,row);
    }
    if(repair.phase==='FIELDS_STARTED'&&repair.operationId&&this.deps.repairFields){
      this.checkpoint(task,row);
      const current=this.deps.amazon.getDraft(row.draftId!);
      if(!this.matching(task,row,current)||submitted(current)||row.executionTaskIds.some(id=>{const child=this.deps.execution.get(id);return child.items.length!==1||child.items[0].draftId!==current.id||child.items[0].submitStarted;}))throw new UserFacingError('字段修复范围或提交记录已变化，未继续字段请求');
      const op=new CompletionJournal(this.db).get(repair.operationId);
      if(op.draftId!==row.draftId)throw new UserFacingError('字段操作身份不一致，未自动重发');
      let result:Awaited<ReturnType<NonNullable<AutomaticListingDependencies['repairFields']>>>;
      try{result=await this.deps.repairFields(row.draftId!,this.controller!.signal,repair.operationId);}
      catch(error){
        // A local brand or selected-firmness migration commits the owner checkpoint together
        // with the draft. Do not overwrite it with stale in-memory state if a
        // caller is interrupted immediately after that transaction returns.
        if(op.state==='DONE'){
          const saved=this.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id);
          if(saved){
            const durable=validateAutomaticListingTask(JSON.parse(String(saved.record_json))),items=task.items;
            // pump retains both this array's iterator and the current row. Sync
            // every row in place so its catch and later siblings save the same
            // objects, including newly persisted pause/cancel and checkpoints.
            const current=new Map(items.map(item=>[item.key,item]));
            const restored=durable.items.map(savedItem=>{
              const item=current.get(savedItem.key);if(!item)return savedItem;
              for(const key of Object.keys(item))if(!Object.hasOwn(savedItem,key))Reflect.deleteProperty(item,key);
              return Object.assign(item,savedItem);
            });
            items.splice(0,items.length,...restored);
            for(const key of Object.keys(task))if(!Object.hasOwn(durable,key))Reflect.deleteProperty(task,key);
            Object.assign(task,{...durable,items});
          }
        }
        throw error;
      }
      const draft='draft' in result?result.draft:result;
      const rules=this.deps.rules(),returnedRemaining='draft' in result?result.remaining:[];
      const remaining=localRefresh?[...new Set([...withoutHistoricalPricingRemaining(draft,returnedRemaining,rules),...fieldRepairRemaining(draft,rules)])]:fieldRepairRemaining(draft,rules,returnedRemaining);
      row.repair=repair={...repair,phase:remaining.length?'FIELDS_PENDING':'RECHECK_PENDING',remaining,draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)};this.saveItem(task,row);this.checkpoint(task,row);
    }
    if (repair.phase === 'FIELDS_STARTED') {
      const message = '上次字段修复结果尚未确认，请先核对异常草稿；未自动重发';
      throw new UserFacingError(row.error?.startsWith(message) ? row.error : `${message}${row.error ? `。上次错误：${row.error}` : ''}${repair.remaining?.length ? `。此前待处理：${repair.remaining.join('；')}` : ''}`);
    }
    let current = this.deps.amazon.getDraft(row.draftId!);
    if(repair.phase==='RECHECK_PENDING'&&current.revision>repair.draftRevision&&!submitted(current)
      &&this.deps.images.canResumeRecheckDraft?.({draftId:current.id,draftRevision:current.revision,sourceWorkflowId:repair.sourceWorkflowId})){
      // The recheck may repair copy before it fails or is paused. Adopt only a
      // version proven by that same recheck; keep its failure and pending review.
      row.repair=repair={...repair,draftRevision:current.revision,draftStamp:imageWorkflowDraftStamp(current)};this.saveItem(task,row);
    }
    if (!this.matching(task,row,current) || current.revision !== repair.draftRevision || imageWorkflowDraftStamp(current) !== repair.draftStamp || submitted(current)) throw new UserFacingError('字段修复后草稿发生变化，请核对异常商品');
    // Older checkpoints may have been saved without checking the field repair outcome.
    const currentPricingRules=this.deps.rules();
    const unresolved = fieldRepairRemaining(current, currentPricingRules, repair.remaining);
    if (!unresolved.length && repair.phase==='FIELDS_PENDING' && repair.remaining?.length
      && !withoutHistoricalPricingRemaining(current,repair.remaining,currentPricingRules).length) {
      row.repair=repair={...repair,phase:'RECHECK_PENDING',remaining:[]};this.saveItem(task,row);
    }
    if (unresolved.length && repair.phase !== 'FIELDS_PENDING') {
      row.repair = repair = { ...repair, phase: 'FIELDS_PENDING', remaining: unresolved }; this.saveItem(task,row);
    }
    while (repair.phase === 'FIELDS_PENDING') {
      const brandIssues=manualBrandIssues(current,[...current.previewIssues,...current.listingIssues]);
      if(brandIssues.length)throw incompleteFields(brandIssues);
      if(localRefresh&&row.repairAttempts>=repairLimit(row)&&!(row.repairAttempts===4&&row.repairPolicyMigration&&row.sourceColorRepair&&row.categoryFieldPolicyVersion&&!row.categoryFieldRepair&&!row.legacyThemeRepair))throw incompleteFields(repair.remaining??[]);
      assertCurrentPricingForPaid(current,this.deps.rules());
      const pricingIssue=pricingBlockingReason(current,this.deps.rules());if(pricingIssue)throw new UserFacingError(pricingIssue);
      if (!this.deps.repairFields) throw incompleteFields(repair.remaining?.length ? repair.remaining : fieldRepairRemaining(current,this.deps.rules()));
      this.checkpoint(task,row);
      const assertRepairScope=()=>{
        const latest=this.deps.amazon.getDraft(current.id);
        assertCurrentPricingForPaid(latest,this.deps.rules());
        if(!this.matching(task,row,latest)||submitted(latest)||latest.revision!==repair.draftRevision||imageWorkflowDraftStamp(latest)!==repair.draftStamp)
          throw new UserFacingError('字段修复后草稿发生变化，请核对异常商品');
        if(row.executionTaskIds.some(id=>{const child=this.deps.execution.get(id);return child.items.length!==1||child.items[0].draftId!==current.id||child.items[0].submitStarted;}))
          throw new UserFacingError('已有提交记录或执行范围变化，未继续字段修复');
      };
      assertRepairScope();
      let evidenceSha256:string|undefined;
      if(this.deps.prepareSourceColors&&needsSourceColor(current,repair.remaining)&&(!row.sourceColorRepair||row.repairAttempts<repairLimit(row))){
        const evidence=await this.deps.prepareSourceColors(current.id,this.controller!.signal);
        this.checkpoint(task,row);assertRepairScope();
        if(evidence.evidenceSha256!==undefined&&!/^[a-f0-9]{64}$/.test(evidence.evidenceSha256))throw new UserFacingError('来源颜色证据指纹无效，未继续字段修复');
        evidenceSha256=evidence.evidenceSha256;
      }
      let scopedOperationId:string|undefined;
      if(row.repairAttempts>=repairLimit(row)&&!row.legacyThemeRepair){
        const workflow=this.deps.images.getProgress(current.id);
        if(workflow&&workflow.id===repair.sourceWorkflowId)scopedOperationId=this.deps.beginLegacyThemeRepair?.(current.id,row,workflow);
      }
      if(row.repairAttempts>=repairLimit(row)&&!scopedOperationId){
        if(localRefresh)throw incompleteFields(repair.remaining??[]);
        if(canMigrateCategory(row,current))row.categoryFieldRepair={version:CATEGORY_FIELD_REPAIR_POLICY_VERSION,previousAttempts:row.repairAttempts as 2|3|4,grantedAttempts:1,grantedAt:new Date().toISOString(),fields:categoryRepairFields(current,repair.remaining)};
        else if(!evidenceSha256||evidenceSha256===row.sourceColorEvidenceSha256||row.sourceColorRepair)
          throw incompleteFields(repair.remaining?.length ? repair.remaining : fieldRepairRemaining(current,this.deps.rules()));
        else row.sourceColorRepair={evidenceSha256,previousAttempts:row.repairAttempts as 2|3|4,grantedAttempts:1,grantedAt:new Date().toISOString()};
      }
      row.categoryFieldPolicyVersion=CATEGORY_FIELD_REPAIR_POLICY_VERSION;
      if(evidenceSha256)row.sourceColorEvidenceSha256=evidenceSha256;
      assertRepairScope();
      const operationId=scopedOperationId??this.deps.beginFieldRepair?.(current.id);
      if(scopedOperationId)row.legacyThemeRepair={version:'legacy-theme-parser/v1',operationId:scopedOperationId,previousAttempts:4,grantedAttempts:1,grantedAt:new Date().toISOString(),fields:['theme']};
      row.repairAttempts++;
      // Grant, evidence and consumed attempt share the durable STARTED checkpoint.
      // A cached preparation can resume safely; an unknown field result cannot replay.
      row.repair = { ...repair, phase: 'FIELDS_STARTED',...(operationId?{operationId}:{}) }; this.saveItem(task,row);
      const result = await this.deps.repairFields(current.id,this.controller!.signal,operationId);
      current = 'draft' in result ? result.draft : result;
      const remaining = fieldRepairRemaining(current,this.deps.rules(),'draft' in result ? result.remaining : []);
      // A known incomplete result is safe to retry; an interrupted unknown result is not.
      row.repair = repair = { ...row.repair!, phase: remaining.length ? 'FIELDS_PENDING' : 'RECHECK_PENDING', remaining,
        draftRevision: current.revision, draftStamp: imageWorkflowDraftStamp(current) }; this.saveItem(task,row);
      this.checkpoint(task,row);
    }
    if (repair.phase === 'RECHECK_PENDING') {
      if (!this.deps.recheckImage) throw new UserFacingError('现有图片复核服务不可用');
      assertCurrentPricingForPaid(this.deps.amazon.getDraft(current.id),this.deps.rules());
      current = await this.deps.recheckImage({ draftId: current.id, draftRevision: current.revision, sourceWorkflowId: repair.sourceWorkflowId }, this.controller!.signal);
      row.repair = { ...repair, phase: 'READY', draftRevision: current.revision, draftStamp: imageWorkflowDraftStamp(current) }; this.saveItem(task,row);
      this.checkpoint(task, row);
    }
    const priorChildId = row.executionTaskIds.at(-1)!;
    const priorChild = this.deps.execution.get(priorChildId);
    if (priorChild.items.some(item => item.submitStarted)) throw new UserFacingError('已有提交记录，未重建执行任务');
    this.deps.execution.cancel(priorChildId);
    const replacement = this.childFor(task, current);
    row.executionTaskIds.push(replacement.id); row.repair = null; row.stage = 'EXECUTION'; this.saveItem(task,row);
  }
  private childFor(task: AutomaticListingTask, draft: AmazonDraft) {
    const existing = this.deps.execution.list().filter(child => !['CANCELLED','COMPLETED'].includes(child.status) && child.items.some(item => item.draftId === draft.id));
    if (existing.length) {
      const child = existing[0], item = child.items[0];
      const profile=this.deps.hosting.getProfile(task.profileId);
      if (existing.length !== 1 || !['CREATED','PAUSED','NEEDS_ATTENTION'].includes(child.status) || child.items.length !== 1 || child.profileId !== task.profileId
        ||fingerprint(child.hostingRoute??DIRECT_HOSTING_ROUTE)!==fingerprint(task.hostingRoute??DIRECT_HOSTING_ROUTE)
        ||child.profileStamp!==fingerprint(profileWithHostingRoute(profile,child.hostingRoute))||task.profileStamp!==fingerprint(profileWithHostingRoute(profile,task.hostingRoute))
        || item.draftId !== draft.id || item.draftRevision !== draft.revision || item.attributesHash !== fingerprint(draft.attributes) || item.schemaHash !== fingerprint(draft.schema)
        || item.productId !== draft.productId || item.productRevision !== draft.productRevision || item.variantId !== draft.variantId || item.sku !== draft.sku
        || item.targetStamp !== task.targetStamp || item.submitStarted) throw new UserFacingError('草稿已有不同范围的执行任务，请先核对原任务');
      return child;
    }
    return this.deps.execution.create({ draftIds: [draft.id], profileId: task.profileId, concurrency: 1, hostingRoute:task.hostingRoute??DIRECT_HOSTING_ROUTE });
  }
  private async summarize(task: AutomaticListingTask, observedBefore?: string): Promise<void> {
    if (['PAUSED','CANCELLED'].includes(task.status)) return;
    const completing=task.items.every(row=>['DONE','SCREENED'].includes(row.status));
    if(completing){const revision=task.revision,status=task.status;this.operationProgress={taskId:task.id,phase:'VERIFYING',completed:0,total:task.items.length,message:'商品已处理完，正在核对整份任务并保存最终结果'};await yieldToEventLoop();if(task.revision!==revision||task.status!==status){this.operationProgress=null;return;}}
    try{
    task.status = task.items.every(row => ['DONE','SCREENED'].includes(row.status)) ? 'COMPLETED'
      : task.items.some(row => row.status === 'WAITING') ? 'WAITING' : 'NEEDS_ATTENTION';
    task.error = task.items.find(row => row.status === 'FAILED')?.error ?? null;
    if (observedBefore === undefined || JSON.stringify(task) !== observedBefore) this.save(task);
    }finally{if(completing)this.operationProgress=null;}
  }
  refreshWaiting(): Promise<void> {
    if (this.closed || this.closing || this.schedulingSuspended) return Promise.resolve();
    if (this.observing) return this.observing;
    this.observing = Promise.resolve().then(async () => {
      if(this.deps.batch)for(const task of this.managedTasks())if(task.items.some(row=>row.batchWait)){
        try{const row=task.items.find(row=>row.batchWait)!;await this.controlledRuns.runTask(task.id,row.key,row.productId,this.controlledGrants.get(task.id),()=>this.deps.batch!.reconcile(task.id));}catch{/* Original Batch errors and identities remain available; never POST from observation. */}
      }
      // Global scan failures must stay outside per-SKU error classification.
      // Only observable submitted work can need this expensive view.
      const needsCandidates = this.managedTasks().some(task => !this.confirming.has(task.id)
        && ['WAITING', 'NEEDS_ATTENTION'].includes(task.status)
        && task.items.some(row => row.draftId && row.status !== 'DONE' && ['READBACK', 'LABELS'].includes(row.stage)));
      const versions = this.managedTasks().map(task => ({ id: task.id, revision: task.revision, status: task.status, confirming: this.confirming.has(task.id) }));
      const scanCurrent = () => !this.closed && !this.closing && !this.schedulingSuspended
        && versions.length === this.managedTasks().length && versions.every(before => {
          const task = this.tasks.get(before.id);
          return task?.revision === before.revision && task.status === before.status && this.confirming.has(before.id) === before.confirming;
        });
      const candidateRows = !needsCandidates ? [] : this.deps.procurement.candidatesForObservation
        ? await this.deps.procurement.candidatesForObservation(scanCurrent) : this.deps.procurement.candidates();
      if (candidateRows === null || !scanCurrent()) return;
      const candidates = new Map(candidateRows.map(value => [value.draftId, value]));
      for (const task of this.managedTasks()) {
        const canObserve=()=>!this.closed&&!this.closing&&!this.schedulingSuspended&&this.canManage(task.id)&&!this.confirming.has(task.id)&&['WAITING','NEEDS_ATTENTION'].includes(task.status);
        if (!canObserve()) continue;
        const observedBefore = JSON.stringify(task);
        let resumeParents=false,interrupted=false;
        for (const row of task.items) {
          if(!rowSelected(task.resumeScope,row.key))continue;
          const beforeYield = task.revision;
          await yieldToEventLoop();
          if (task.revision !== beforeYield) { interrupted = true; break; }
          if(!canObserve())break;
          if(row.batchWait){if(this.grants.has(task.id)&&this.deps.batch?.failed(row.batchWait.operationId)){row.status='FAILED';row.error='原Batch项目失败或缺失；身份、收据和费用保留，未自动重发';continue;}if(this.grants.has(task.id)&&this.deps.batch?.ready(row.batchWait.operationId)){row.status='PENDING';row.error=null;resumeParents=true;}continue;}
          if(row.schemaRetry?.state==='WAITING'){if(await this.retrySchema(task,row))resumeParents=true;continue;}
          if(row.stage==='PARENT'&&row.parentDraftId&&row.status==='WAITING'){
            const parent=this.deps.followup.get(row.parentDraftId);
            if(parent.status==='NEEDS_ATTENTION'){row.status='FAILED';row.error=parent.error||'父体建档失败，保留子体图片和进度';}
            else if(parent.status==='READY'&&this.grants.has(task.id)){row.status='PENDING';resumeParents=true;}
            continue;
          }
          if (!row.draftId || ['DONE','SCREENED'].includes(row.status) || !['READBACK','LABELS'].includes(row.stage)) continue;
          let savedFailureStamp:string|undefined, savedFailureTime:number|undefined;
          try {
            if(row.stage==='LABELS'&&(row.error||row.outcome))appendAuditEvent(this.db,randomUUID(),row.productId,'automatic-listing.labels-detached','保留旧标签错误；标签改为按需独立处理',JSON.stringify({taskId:task.id,draftId:row.draftId,error:row.error,outcome:row.outcome??null}),new Date().toISOString());
            if (!this.matching(task, row, this.deps.amazon.getDraft(row.draftId))) throw new UserFacingError('已提交草稿归属变化，请核对');
            if(row.stage==='LABELS')row.stage='READBACK';
            {
              const followup = task.mode === 'live' ? this.deps.followup.get(row.draftId) : { status: 'READY', error: null, checkedAt:null, lastAttemptAt:null };
              const observedTimes=[followup.checkedAt,followup.lastAttemptAt].map(value=>Date.parse(value??'')).filter(Number.isFinite);
              if(observedTimes.length)savedFailureTime=Math.max(...observedTimes);
              if (followup.status === 'NEEDS_ATTENTION') {
                savedFailureStamp=fingerprint({stage:row.stage,draft:this.deps.amazon.getDraft(row.draftId),followup});
                throw new UserFacingError(followup.error || '平台回读需要处理');
              }
              const candidate = candidates.get(row.draftId);
              if (followup.status !== 'READY' || !candidate?.eligible) {
                if (followup.status === 'READY' && candidate?.requiresAttention) {
                  savedFailureStamp=fingerprint({stage:row.stage,draft:this.deps.amazon.getDraft(row.draftId),followup,candidate});
                  throw new UserFacingError(candidate.reason);
                }
                row.status = 'WAITING';
                row.error = followup.status === 'READY'
                  ? `平台已建档；${candidate?.reason || '等待备货条件确认'}；可售状态单独以平台结果为准`
                  : followup.error || '等待 Amazon 处理原提交并确认建档（原提交后 24 小时内回读）';
                delete row.outcome; delete row.observationFailureStamp; continue;
              }
              row.error = null; delete row.outcome; delete row.observationFailureStamp;
              if(!this.grants.has(task.id)){row.status='WAITING';row.error='平台结果已保存，明确继续任务后再准备备货';continue;}
              const batches = this.deps.procurement.ensureAutomaticBatch(task.id, [row.draftId], { [row.draftId]: row.stockSets });
              const batch = batches.find(value => value.lines.some(line => line.draftId === row.draftId));
              if (!batch) throw new UserFacingError('回读已就绪，但备货批次未建立');
              row.batchId = batch.id;
            }
            row.status = 'DONE'; row.stage = 'COMPLETE'; row.error = null; delete row.outcome;
          } catch (error) {
            // Only errors synthesized from a saved observation can be deduplicated.
            // A thrown dependency/storage/network error is a new failure even when its text matches.
            if(savedFailureStamp&&row.observationFailureStamp===savedFailureStamp&&row.status==='FAILED'&&row.outcome&&['READBACK_FAILED','READBACK_BRAND_REQUIRES_MANUAL'].includes(row.outcome.code))continue;
            const legacyOutcome=!row.observationFailureStamp&&savedFailureStamp&&savedFailureTime!==undefined&&row.outcome
              &&savedFailureTime<=Date.parse(row.outcome.classifiedAt)?structuredClone(row.outcome):undefined;
            if(savedFailureStamp)row.observationFailureStamp=savedFailureStamp;else delete row.observationFailureStamp;
            recordErrorEvidence(detail=>appendAuditEvent(this.db,randomUUID(),row.productId,'operation.failed','自动任务步骤失败（脱敏诊断）',JSON.stringify(detail),new Date().toISOString()),error,{stage:row.stage,requestId:row.stage==='CLASSIFY'?categoryFailureRequestId(this.db,row.productId,error):undefined,taskId:task.id,itemKey:row.key,sku:row.sku,operationId:row.repair?.operationId,variantId:row.variantId,draftId:row.draftId,executionTaskIds:row.executionTaskIds});
            row.status = 'FAILED'; row.error = error instanceof UserFacingError?errorMessage(error):`${row.sku} · ${row.stage}：${errorMessage(error)}`.slice(0,2000);
            const revision=task.revision,classified=structuredClone(row);await this.classifyFailure(task,classified);
            if(!canObserve()||task.revision!==revision){interrupted=true;break;}
            if(legacyOutcome&&classified.outcome){
              const {classifiedAt:priorAt,...priorProof}=legacyOutcome,{classifiedAt:_newAt,...currentProof}=classified.outcome;
              if(fingerprint(priorProof)===fingerprint(currentProof))classified.outcome.classifiedAt=priorAt;
            }
            Object.assign(row,classified);
          }
        }
        if(interrupted||!canObserve())continue;
        if(resumeParents&&this.grants.has(task.id)){task.status='QUEUED';this.save(task);queueMicrotask(()=>this.pump());}
        else await this.summarize(task, observedBefore);
      }
    }).finally(() => { this.observing = null; });
    return this.observing;
  }
  pause(id: string): AutomaticListingTask {
    this.assertManaged(id);const task = this.task(id); if (final(task)) throw new UserFacingError('已结束任务不能暂停');
    task.status = 'PAUSED'; this.grants.delete(id); revokeControlledRunGrant(this.controlledGrants.get(id));this.controlledGrants.delete(id); this.deps.batch?.stop(id); this.stopChildren(task, false); this.save(task,this.db,[],undefined,[]); return structuredClone(task);
  }
  restoreCancelledTask(raw:unknown):AutomaticListingTask {
    const input=record(raw,'恢复已取消任务',['taskId','taskRevision']),id=identifier(input.taskId),task=this.task(id);
    this.assertManaged(id);
    const plan=planCancelledTaskRecovery(task,{taskId:id,expectedRevision:input.taskRevision as number},{workerActive:this.worker!==null||this.activeId!==null||this.grants.has(id),confirming:this.confirming.has(id),archiving:this.archiving,preparing:this.operationProgress!==null});
    const next={...task,...plan.patch},at=new Date().toISOString();
    try {transaction(this.db,()=>{
      appendAuditEvent(this.db,randomUUID(),null,plan.audit.action,plan.audit.summary,JSON.stringify(plan.audit.detail),at);
      this.save(next,this.db,[],at,[]);
    });}catch(error){this.checkpoints.remember(task);throw error;}
    this.tasks.set(id,next);
    return structuredClone(next);
  }
  cancel(id: string): AutomaticListingTask {
    this.assertManaged(id);const task = this.task(id); if (task.status === 'COMPLETED') throw new UserFacingError('已完成任务不能取消');
    task.status = 'CANCELLED'; this.grants.delete(id); revokeControlledRunGrant(this.controlledGrants.get(id));this.controlledGrants.delete(id); this.deps.batch?.stop(id); this.stopChildren(task, true); this.save(task); return structuredClone(task);
  }
  private stopChildren(task: AutomaticListingTask, cancel: boolean): void {
    if (this.activeId === task.id) this.controller?.abort();
    for (const row of task.items) {
      if (row.stage === 'SOURCES' && row.status === 'RUNNING') this.deps.images.cancelSources(row.productId);
      if (row.draftId && row.stage === 'IMAGES' && row.status === 'RUNNING') this.deps.images.cancel(row.draftId);
      for (const id of row.executionTaskIds) {
        const child = this.deps.execution.get(id);
        if (!['COMPLETED','CANCELLED'].includes(child.status)) cancel ? this.deps.execution.cancel(id) : this.deps.execution.pause(id);
      }
    }
  }
  async waitForIdle(): Promise<void> { await this.worker; await this.observing; }
  close(): Promise<void> {
    if (this.closing) return this.closing; if (this.closed) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    for(const grant of this.controlledGrants.values())revokeControlledRunGrant(grant);
    for (const task of this.managedTasks()) if (['RUNNING','QUEUED'].includes(task.status)) this.pause(task.id);
    this.grants.clear();
    this.controlledGrants.clear();this.pauseManagedControlledScope();
    this.closing = Promise.resolve().then(async () => { await this.worker; await this.observing; this.db.close(); this.closed = true; });
    return this.closing;
  }
}
