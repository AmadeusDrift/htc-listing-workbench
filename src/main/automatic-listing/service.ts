import { isSchemaTransientError, type SchemaTransientError } from '../amazon/schema-retry.ts';
import { canResumeRiskAdaptation } from './risk-adaptation.ts';
import { adaptationSteps, applyAdaptationRows, assertTaskAdaptationHistory } from './adaptation.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import { needsBusinessAuthorityRefresh, manualBrandIssues } from '../image-workflow/policy-reevaluation.ts';
import { presentRejection } from '../../shared/rejection-presentation.ts';
import { assertAutomaticRejectionHistory } from './rejection-history.ts';
import { readSourceImageReceipt, sourceImageReceipt } from '../source-images.ts';
import { assertProductConsistency,sourceConsistencyUnknown,SourceConsistencyError } from '../source-image-consistency/proof.ts';
import { assertCurrentPricingForPaid } from './outcomes.ts';
import { pricingQualificationIssue } from '../pricing/qualification.ts';
import { freezeSourceForProduct } from '../products/source-adoption.ts';
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

export interface AutomaticListingDependencies {
  store: Pick<WorkspaceStore, 'getProduct'> & Partial<Pick<WorkspaceStore,'getProductSnapshot'>>;
  rules(): ListingRules;
  amazon: Pick<AmazonService, 'executionTargetScope' | 'getDraft' | 'listDrafts' | 'prepareDrafts'> & Partial<Pick<AmazonService, 'getSchema' | 'applyBusinessDefaults' | 'previewPricing' | 'previewTaskAdaptation' | 'applyTaskAdaptation'>>;
  hosting: Pick<HostingService, 'getProfile'>;
  images: Pick<ImageWorkflowService, 'prepareSources' | 'complete' | 'getProgress' | 'cancel' | 'cancelSources'> & {
    getRiskSettings?: () => {enabled:boolean};
    isRiskPolicyCompatible?: (run:ImageWorkflowRun) => boolean;
    getCopyReviewSettings?: () => {enabled:boolean};
    isCopyReviewPolicyCompatible?: (run:ImageWorkflowRun) => boolean;
    canResumeRecheckDraft?: ImageWorkflowService['canResumeRecheckDraft'];
    getRuleFilterEvidence?: (draftId:string)=>Promise<AutomaticRuleEvidence|null>;
  };
  execution: Pick<ExecutionService, 'create' | 'prepareStart' | 'startAuthorized' | 'get' | 'list' | 'pause' | 'cancel' | 'waitForIdle'>;
  followup: Pick<FollowupService, 'get' | 'schedule'>;
  procurement: Pick<ProcurementService, 'candidates' | 'ensureAutomaticBatch'>;
  labels: Pick<ItemLabelService, 'syncBatch' | 'list'> & Partial<Pick<ItemLabelService, 'pauseJob' | 'resumeJob' | 'cancelJob'>>;
  labelFormat?(): ItemLabelFormat;
  /** Main-only final field repair + re-review of the existing image; never generates another image. */
  beginLegacyThemeRepair?: (draftId:string,row:AutomaticListingItem,workflow:ImageWorkflowRun)=>string|undefined;
  beginFieldRepair?: (draftId:string)=>string;
  repairFields?: (draftId: string, signal: AbortSignal, operationId?:string) => Promise<AmazonDraft | { draft: AmazonDraft; remaining: string[] }>;
  prepareSourceColors?: (draftId: string, signal: AbortSignal) => Promise<{ aiCalls: number; evidenceChanged: boolean; evidenceSha256?: string }>;
  prepareSourceConsistency?: (input:{productId:string;productRevision:number;variantIds:string[]},signal:AbortSignal,assertFresh:()=>void)=>Promise<void>;
  recheckImage?: (input: { draftId: string; draftRevision: number; sourceWorkflowId: string }, signal: AbortSignal) => Promise<AmazonDraft>;
  preflight?: () => void;
  sourceReceipt?: (productId: string) => MiaoshouReceipt | null;
  classify?: (input: { productId: string; productRevision: number; targetId: string }, signal: AbortSignal) => Promise<ProductClassification>;
  planSalesForAdaptation?: (source:ProductDetail,targetId:string,db:DatabaseSync)=>SalesListingPlan[];
  planSales?: (productId:string,targetId:string) => SalesListingPlan[];
  previewSales?: (productId:string) => SalesListingPlan['recipe'][];
  existingSale?: (productId:string,plan:SalesListingPlan,targetId:string) => AmazonDraft|undefined;
  resolveFamily?: (input:{plans:SalesListingPlan[];targetId:string;productType:string;locale:string},signal:AbortSignal) => Promise<SalesListingPlan[]>;
  ensureParent?: (child:AmazonDraft,profileId:string,signal:AbortSignal) => Promise<{draftId:string;ready:boolean}>;
  rebindFamily?: (input:{id:string;revision:number;plan:SalesListingPlan},signal:AbortSignal) => Promise<AmazonDraft>;
}
const retryableAiUnknown=(code:string|null):boolean=>code!==null&&['SOURCE_CONSISTENCY_SENT_UNKNOWN','FIELD_RESULT_UNKNOWN','IMAGE_RESULT_UNKNOWN'].includes(code);
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
  private db: DatabaseSync;
  private deps: AutomaticListingDependencies;
  private tasks = new Map<string, AutomaticListingTask>();
  private grants = new Set<string>();
  private confirming = new Set<string>();
  private worker: Promise<void> | null = null;
  private observing: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private activeId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private schedulingSuspended = false;
  private closing: Promise<void> | null = null;
  constructor(directory: string, dependencies: AutomaticListingDependencies) {
    this.deps = dependencies; this.db = openDatabase(directory);
    try {
      for (const saved of this.db.prepare('SELECT id,record_json FROM automatic_listing_tasks ORDER BY rowid').all()) {
        const task = validateAutomaticListingTask(JSON.parse(String(saved.record_json)));
        for(const row of task.items)if(row.schemaRetry){const operation=readSchemaOperation(this.db,task.id,row.key,row.schemaRetry.scope);if(operation)Object.assign(row.schemaRetry,operation.budget);}
        assertAutomaticRejectionHistory(this.db,task);assertTaskAdaptationHistory(this.db,task);
        if (task.id !== saved.id) throw new UserFacingError('自动任务身份不一致');
        this.tasks.set(task.id, task);
        if (['QUEUED','RUNNING'].includes(task.status)||task.status==='WAITING'&&task.items.some(row=>row.stage==='PARENT'||row.schemaRetry&&['WAITING','IN_FLIGHT'].includes(row.schemaRetry.state))) {
          task.status = 'PAUSED'; task.error = '工作台曾中断，已保留进度；继续任务前会核对范围，不会自动重发未知生图或提交。';
          for (const row of task.items) { if(row.schemaRetry?.state==='IN_FLIGHT')row.schemaRetry.state='WAITING'; if (row.status === 'RUNNING') row.status = 'PENDING'; }
          this.save(task);
        }
      }
    } catch (error) { this.db.close(); throw error; }
  }
  private ensureOpen(): void { if (this.closed || this.closing) throw new UserFacingError('自动任务服务正在停止'); }
  private task(id: string): AutomaticListingTask { this.ensureOpen(); const result = this.tasks.get(identifier(id)); if (!result) throw new UserFacingError('自动任务不存在'); return result; }
  private save(task: AutomaticListingTask, db:DatabaseSync=this.db): void {
    transaction(db,()=>{
    for(const row of task.items)if(row.schemaRetry)Object.assign(row.schemaRetry,saveSchemaOperation(db,task.id,row.key,row.schemaRetry));
    task.revision++; task.updatedAt = new Date().toISOString();
    validateAutomaticListingTask(task);
    assertAutomaticRejectionHistory(this.db,task);assertTaskAdaptationHistory(db,task);
    db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(task.id, JSON.stringify(task));
    });
  }
  list(): AutomaticListingTask[] { this.ensureOpen(); return [...this.tasks.values()].reverse().map(task => structuredClone(task)); }
  get(id: string): AutomaticListingTask { return structuredClone(this.task(id)); }
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
  async previewAdaptationForUi(id:string){
    const task=this.get(id),steps=this.adaptationStateSteps(task);
    for(;;){
      await yieldToEventLoop();
      const current=this.task(id); // Also rejects shutdown before another DB read.
      const result=steps.next();
      if(result.done){
        const preview=result.value.preview;
        // An active task can advance while its readonly source view is loading.
        // Preserve that view, but never present an obsolete proof as applicable.
        if(current.revision!==task.revision){preview.canApply=false;preview.blockers.push('检查期间任务已变化，请刷新任务后再适配');}
        return preview;
      }
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
      this.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),null,'automatic-listing.adapted','用户显式适配当前规则；等待用户继续',JSON.stringify({taskId:id,token,before,changes:state.preview.changes,afterRevision:before.revision+1}),new Date().toISOString());
      this.save(next,this.db);this.db.exec('COMMIT');
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
    this.tasks.set(id,next);return structuredClone(next);
  }
  get busy(): boolean { return this.worker !== null || this.observing !== null; }
  start(): void {
    this.schedulingSuspended = false;
    this.ensureOpen(); if (this.timer) return;
    this.timer = setInterval(() => { void this.refreshWaiting().catch(() => {}); }, 5000); this.timer.unref();
    void this.refreshWaiting().catch(() => {});
  }
  suspendScheduling(): void {
    this.schedulingSuspended = true;
    if (this.timer) clearInterval(this.timer); this.timer = null;
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
        this.timer = setInterval(() => { void this.refreshWaiting().catch(() => {}); }, 5000); this.timer.unref();
      }
    };
  }
  private assertConnections(task: AutomaticListingTask): void {
    const target = this.deps.amazon.executionTargetScope(task.targetId), profile = this.deps.hosting.getProfile(task.profileId);
    if (!target.target.configured || target.target.paused || fingerprint(target) !== task.targetStamp) throw new UserFacingError('目标店铺授权或范围发生变化，请重新建立任务');
    if (!profile.enabled || !profile.configured || fingerprint(profile) !== task.profileStamp) throw new UserFacingError('图床配置发生变化，请重新建立任务');
    if (fingerprint(this.deps.rules()) !== task.rulesStamp) throw new UserFacingError('上架规则发生变化，请重新建立任务');
  }
  private canRebaseSources(task: AutomaticListingTask,row: AutomaticListingItem): boolean {
    if(row.status==='SCREENED'||row.sourcesPrepared||row.stage!=='SOURCES'||row.draftId||row.imageStarted||row.executionTaskIds.length)return false;
    return task.items.filter(sibling=>sibling.productId===row.productId&&sibling.sourcesPrepared).every(sibling=>
      ['READBACK','LABELS','COMPLETE'].includes(sibling.stage)&&!!sibling.draftId&&submitted(this.deps.amazon.getDraft(sibling.draftId)));
  }
  private assertScope(task: AutomaticListingTask, row?: AutomaticListingItem, allowSourceRecovery=false): void {
    const rows = row ? [row] : task.items.filter(value => !task.adaptation?.blockedKeys.includes(value.key)&&value.status!=='SCREENED'&&!['PLAN','READBACK','LABELS','COMPLETE'].includes(value.stage));
    if (!rows.length) return;
    this.assertConnections(task);
    for (const item of rows) {
      const source=this.deps.store.getProduct(item.productId),product=projectSalesProduct(source,item.salesPlan,item.variantId), variant = product.variants.find(value => value.id === item.variantId);
      if (!variant || variant.sku !== item.sku || sourceStamp(source) !== item.sourceStamp || product.revision !== item.productRevision&&!(allowSourceRecovery&&product.revision>item.productRevision&&this.canRebaseSources(task,item))) throw new UserFacingError('来源商品或 SKU 发生变化，请重新建立任务');
    }
  }
  private unknownCode(row:AutomaticListingItem,task:AutomaticListingTask):string|null {
    const draft=row.draftId?this.deps.amazon.getDraft(row.draftId):undefined;
    if(draft&&(['UNKNOWN','SUBMITTING'].includes(draft.state)||!submitted(draft)&&this.deps.execution.list().some(child=>child.items.some(item=>item.draftId===draft.id&&item.submitStarted))))return 'SUBMISSION_UNKNOWN';
    if(sourceConsistencyUnknown(this.db,row.productId,row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId]))return 'SOURCE_CONSISTENCY_SENT_UNKNOWN';
    const journal=new CompletionJournal(this.db);
    // A retained guard without its old draft uses the same source sale identity as begin().
    const identity=completionSafetyIdentity(draft??{mode:task.mode,productId:row.productId,productRevision:row.productRevision,variantId:row.variantId,sku:row.sku,sellerId:task.sellerId,marketplaceId:task.marketplaceId,listingProgram:task.mode==='live'?'haul':'standard',salesPlan:row.salesPlan});
    if(journal.saleOperations(identity).some(op=>journal.unknown(op.id)))return 'FIELD_RESULT_UNKNOWN';
    if(row.repair?.phase==='FIELDS_STARTED'&&(!row.repair.operationId||journal.unknown(row.repair.operationId)))return 'FIELD_RESULT_UNKNOWN';
    if(!row.draftId)return row.imageStarted?'IMAGE_RESULT_UNKNOWN':null;
    if(!draft)throw new UserFacingError('字段草稿记录缺失');
    if(['UNKNOWN','SUBMITTING'].includes(draft.state)||!submitted(draft)&&this.deps.execution.list().some(child=>child.items.some(item=>item.draftId===draft.id&&item.submitStarted)))return 'SUBMISSION_UNKNOWN';
    const run=this.deps.images.getProgress(row.draftId);
    if(run?.contentPreparation?.state==='STARTED'&&(!run.contentPreparation.operationId||journal.unknown(run.contentPreparation.operationId)))return 'FIELD_RESULT_UNKNOWN';
    if(run?.status==='RUNNING'||run?.slots?.some(slot=>slot.status==='UNKNOWN'||slot.attempts?.some(attempt=>['UNKNOWN','GENERATING'].includes(attempt.state))))return 'IMAGE_RESULT_UNKNOWN';
    if(row.imageStarted&&!run)return 'IMAGE_RESULT_UNKNOWN';
    return null;
  }
  private async classifyFailure(task:AutomaticListingTask,row:AutomaticListingItem):Promise<void> {
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
      const unknown=this.unknownCode(row,task);
      if(unknown)classification={kind:'UNKNOWN',code:unknown};
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
        if(after.revision!==draft.revision||this.unknownCode(row,task))classification={kind:'UNKNOWN',code:this.unknownCode(row,task)??'EVIDENCE_READ_FAILED'};
      }else if(row.stage==='SOURCES'&&row.outcome&&Object.hasOwn(AUTOMATIC_SOURCE_ISSUES,row.outcome.code))classification={kind:row.outcome.kind,code:row.outcome.code};
      else if(row.stage==='PLAN'||row.outcome?.code==='SOURCE_INPUT_REQUIRED')classification={kind:'NEEDS_INPUT',code:'SOURCE_INPUT_REQUIRED'};
      if(classification.kind!=='UNKNOWN'&&classification.kind!=='RULE_FILTERED'&&!(row.stage==='SOURCES'&&row.outcome&&(Object.hasOwn(AUTOMATIC_SOURCE_ISSUES,row.outcome.code)||row.outcome.code==='SOURCE_INPUT_REQUIRED'))){
        try{assertProductConsistency(this.db,this.deps.store.getProduct(row.productId),row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId]);}
        catch(error){if(error instanceof SourceConsistencyError)classification={kind:error.kind,code:error.code};else throw error;}
      }
    }catch{classification={kind:'SYSTEM_REPAIR',code:'EVIDENCE_READ_FAILED'};}
    if(classification.kind==='UNKNOWN'&&!row.error?.startsWith('上次结果尚未确认'))row.error=((retryableAiUnknown(classification.code)?'上次结果尚未确认；继续任务时先恢复已有结果，确实缺失则按原次数上限自动重试该 AI 步骤。上次错误：':'上次提交结果尚未确认，未自动重发。上次错误：')+(row.error??'请核对已有记录')).slice(0,2000);
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
    const targetId=text(input.targetId,'店铺',100,true),target=this.deps.amazon.executionTargetScope(targetId),rules=this.deps.rules();
    const relevantTasks=()=>[...this.tasks.values()].filter(t=>t.mode===target.target.mode&&t.sellerId===target.target.sellerId&&t.marketplaceId===target.target.marketplaceId&&t.items.some(row=>ids.includes(row.productId)));
    const revisions=()=>relevantTasks().map(t=>[t.id,t.revision]);
    const evidenceState=()=>{
      const draftIds=[...new Set(relevantTasks().flatMap(t=>t.items.filter(row=>ids.includes(row.productId)&&row.draftId).map(row=>row.draftId!)))];

      return {fieldOperations:ids.flatMap(id=>this.db.prepare("SELECT id,record_json FROM listing_completion_operations WHERE json_extract(record_json,'$.safetyIdentity.productId')=?").all(id)),risk:this.deps.images.getRiskSettings?.()??null,drafts:draftIds.map(id=>{try{return {id,draft:this.deps.amazon.getDraft(id),workflow:this.deps.images.getProgress(id),fieldOperations:new CompletionJournal(this.db).list(id)};}catch{return {id,unavailable:true};}}),
        execution:this.deps.execution.list().flatMap(child=>child.items.filter(item=>draftIds.includes(item.draftId)).map(item=>({id:child.id,status:child.status,item})))};
    };
    const taskRevisions=fingerprint(revisions()),evidenceStamp=fingerprint(evidenceState()),receipts=new Map(ids.map(id=>[id,this.deps.sourceReceipt?.(id)??null]));
    const snapshots=ids.map(id=>this.deps.store.getProduct(id)),products:AutomaticListingQueue['products']=[];
    for(const product of snapshots){
      let recipes:{key:string;specification:string;stamp:string;legacyVariantId:string|null;value?:SalesListingPlan['recipe']}[],planningError:string|null=null;
      try{recipes=this.deps.planSales?selectSalesRecipes(product,this.deps.previewSales?.(product.id)??previewSalesRecipes(product,receipts.get(product.id)??null,rules),rules,receipts.get(product.id)??null).map(recipe=>({key:recipe.key,specification:recipe.specification,stamp:fingerprint(validateSalesRecipe(recipe)),value:recipe,legacyVariantId:recipe.components.length===1?recipe.components[0].variantId:null}))
        :this.selectedVariants(product).map(v=>({key:v.id,specification:v.normalizedSpec||v.originalSpec,stamp:fingerprint({variantId:v.id}),legacyVariantId:v.id}));}
      catch(error){planningError=errorMessage(error);recipes=[];}
      const rows:AutomaticQueueRow[]=[];
      for(const recipe of recipes){
        const histories=[...this.tasks.values()].filter(t=>t.mode===target.target.mode&&t.sellerId===target.target.sellerId&&t.marketplaceId===target.target.marketplaceId)
          .flatMap(task=>task.items.filter(item=>item.productId===product.id&&((item.salesPlan?recipeKey(item)===recipe.key:item.variantId===recipe.legacyVariantId)||item.outcome?.pricingReport&&recipe.value&&fingerprint((item.salesPlan?.recipe.components.map(c=>c.variantId)??[item.variantId]).sort())===fingerprint(recipe.value.components.map(c=>c.variantId).sort()))).map(item=>({task,item}))).reverse();
        const latest=histories[0],view:AutomaticQueueRow={key:product.id+':'+recipe.key,productId:product.id,recipeKey:recipe.key,specification:recipe.specification,sku:latest?.item.sku??null,kind:'PENDING',eligible:true,message:'',reconsideration:null,taskId:latest?.task.id??null};
        try{
          const unsafe=histories.find(h=>this.unknownCode(h.item,h.task));
          if(unsafe){view.kind='UNKNOWN';view.eligible=false;view.taskId=unsafe.task.id;view.message=unsafe.item.error||'已有付费请求或提交记录需要核对，请继续核对原任务';}
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
                else if(outcome.image){const proof=await this.deps.images.getRuleFilterEvidence?.(draft.id);if(!proof||fingerprint(proof)!==fingerprint(outcome.image))stale='IMAGE_EVIDENCE_CHANGED';}
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
      products.push({productId:product.id,title:product.title,eligibleCount:rows.filter(r=>r.eligible).length,pendingCount:rows.filter(r=>!['RULE_FILTERED','SUBMITTED','COMPLETED'].includes(r.kind)).length,filteredCount:rows.filter(r=>r.kind==='RULE_FILTERED'&&r.reasonCode!=='SKU_SELECTION_FILTERED').length,profitFilteredCount:rows.filter(r=>r.kind==='RULE_FILTERED'&&['ROI_MAX_PRICE','ROI_PROMOTION_OR_MARGIN','DIMENSIONAL_WEIGHT_LIMIT'].includes(r.reasonCode??'')).length,notSelectedCount:rows.filter(r=>r.reasonCode==='SKU_SELECTION_FILTERED').length,...(planningError?{inputIssue:'销售配方待补资料：'+planningError}:{}),rows});
    }
    if(fingerprint(this.deps.amazon.executionTargetScope(targetId))!==fingerprint(target)||fingerprint(this.deps.rules())!==fingerprint(rules)||fingerprint(revisions())!==taskRevisions||fingerprint(evidenceState())!==evidenceStamp||snapshots.some(p=>fingerprint(this.deps.store.getProduct(p.id))!==fingerprint(p)||fingerprint(this.deps.sourceReceipt?.(p.id)??null)!==fingerprint(receipts.get(p.id))))throw new UserFacingError('读取期间范围已变化，请刷新');
    return {targetId,scope:{mode:target.target.mode,sellerId:target.target.sellerId,marketplaceId:target.target.marketplaceId},ruleRevision:rules.revision,products};
  }
  async create(raw: unknown): Promise<AutomaticListingTask> {
    this.ensureOpen();
    const input = record(raw, '自动上架参数', ['productIds','targetId','productType','profileId']);
    if (!Array.isArray(input.productIds) || !input.productIds.length || input.productIds.length > 1000) throw new UserFacingError('请选择 1–1000 个商品');
    const ids = input.productIds.map(identifier);
    if (new Set(ids).size !== ids.length) throw new UserFacingError('商品范围不能重复');
    const targetId = text(input.targetId, '店铺', 100, true), target = this.deps.amazon.executionTargetScope(targetId);
    const profileId = text(input.profileId, '图床', 30, true), profile = this.deps.hosting.getProfile(profileId), rules = this.deps.rules();
    if (!target.target.configured || target.target.paused) throw new UserFacingError('请选择已配置且启用的目标店铺');
    if (!profile.configured || !profile.enabled) throw new UserFacingError('请先在设置中配置并启用图片托管');
    const queue=await this.queue({productIds:ids,targetId}),eligible=new Set(queue.products.flatMap(p=>p.rows.filter(r=>r.eligible).map(r=>r.key)));
    if(!eligible.size)throw new UserFacingError(queue.products.find(p=>p.inputIssue)?.inputIssue??'所选商品没有可启动的销售 SKU（说明性选项不入选，每来源最多 4 个代表规格）；请查看规则淘汰或待核对原因，已在自动任务中的销售 SKU 请继续原任务');
    if(fingerprint(this.deps.rules())!==fingerprint(rules)||fingerprint(this.deps.amazon.executionTargetScope(targetId))!==fingerprint(target)||fingerprint(this.deps.hosting.getProfile(profileId))!==fingerprint(profile))throw new UserFacingError('创建期间范围已变化，请刷新');
    this.deps.preflight?.();
    const regroupedSkus=new Set<string>();
    const items: AutomaticListingItem[] = ids.flatMap(id => {
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
        const frozen=existing&&submitted(existing)?existing:undefined;
        const regrouped=!frozen&&existing?.salesPlan&&salesPlan&&existing.salesPlan.recipe.key===salesPlan.recipe.key
          &&existing.salesPlan.sourceGroupKey!==salesPlan.sourceGroupKey?existing:undefined;
        if(regrouped)regroupedSkus.add(regrouped.sku);
        const canonical=frozen??regrouped;
        const legacy=existing&&!existing.salesPlan&&existing.productId===product.id&&existing.variantId===variant.id&&existing.sku===variant.sku?existing:undefined;
        const source=canonical?this.deps.store.getProduct(canonical.productId):product;
        let plan=canonical?canonical.salesPlan:legacy?undefined:salesPlan;
        // Keep allocated identity, but recompute unsent costs/components from the current source.
        // A duplicate import may have new local variant IDs even for the same supplier recipe.
        if(!canonical&&plan&&existing?.salesPlan?.sourceGroupKey===plan.sourceGroupKey&&existing.salesPlan.recipe.key===plan.recipe.key){
          const prior=existing.salesPlan;
          plan={...plan,namingGroupId:prior.namingGroupId,sku:prior.sku,baseSku:prior.baseSku,namingChildKey:prior.namingChildKey,collectedAt:prior.collectedAt,collectionBasis:prior.collectionBasis};
        }
        const variantId=canonical?.variantId??variant.id;
        return {
        key: source.id + ':' + (plan?.recipe.key??variantId), productId: source.id, productRevision: source.revision, sourceStamp: sourceStamp(source), productTitle: source.title,
        variantId, sku: canonical?.sku??legacy?.sku??plan?.sku??variant.sku, ...(plan?{salesPlan:plan}:{}), stockSets: rules.product.stockSets, sourcesPrepared: false,
        status: 'PENDING', stage: 'SOURCES', draftId: null, executionTaskIds: [], imageStarted: false, imageAttempts: 0, repairAttempts: 0, repairPolicyVersion: FIELD_REPAIR_POLICY_VERSION, categoryFieldPolicyVersion:CATEGORY_FIELD_REPAIR_POLICY_VERSION, repair: null, batchId: null, error: null,
      } as AutomaticListingItem;});
    });
    // Repeated collection of the same source recipe uses the canonical saved listing once.
    for(let index=items.length-1;index>=0;index--)if(items[index].stage!=='PLAN'&&items.findIndex(row=>row.stage!=='PLAN'&&row.sku===items[index].sku)!==index)items.splice(index,1);
    if (!items.length || items.length > 5000) throw new UserFacingError('本次请选择 1–5000 个 SKU');
    for (const existing of this.tasks.values()) if (!final(existing) && existing.sellerId === target.target.sellerId && existing.marketplaceId === target.target.marketplaceId && existing.mode === target.target.mode
      && existing.items.some(row => row.stage!=='PLAN'&&items.some(item => item.stage!=='PLAN'&&item.sku === row.sku))) throw new UserFacingError('同一店铺 SKU 已在自动任务中，请继续或取消原任务');
    // A new task has no authority to reprepare sources for an old draft's paid images.
    // Active tasks conflict by the original SKU above; orphaned drafts need explicit recovery.
    if(regroupedSkus.size)throw new UserFacingError(`销售 SKU ${[...regroupedSkus].slice(0,5).join('、')} 已有旧分组草稿，请从原草稿或原自动任务继续；不能以新 SKU 建立重复任务`);
    const now = new Date().toISOString();
    const task: AutomaticListingTask = { id: randomUUID(), revision: 0, status: 'CREATED', targetId, targetName: target.target.name, sellerId: target.target.sellerId,
      marketplaceId: target.target.marketplaceId, mode: target.target.mode, targetStamp: fingerprint(target), profileId, profileStamp: fingerprint(profile),
      rulesStamp: fingerprint(rules), ruleRevision: rules.revision, productType: input.productType ? text(input.productType, '商品类型', 100, true) : 'AUTO', locale: target.target.locale,
      labelFormat: validateItemLabelFormat(this.deps.labelFormat?.()), items, createdAt: now, updatedAt: now, error: null };
    for(const row of items)if(row.stage==='PLAN')row.outcome={version:1,kind:'NEEDS_INPUT',code:'SOURCE_INPUT_REQUIRED',message:row.error!,classifiedAt:now,scope:outcomeScope(task,row),draftId:null,draftRevision:null};
    transaction(this.db,()=>{for(const id of new Set(items.map(item=>item.productId)))freezeSourceForProduct(this.db,id);this.save(task);});
    this.tasks.set(task.id, task); return structuredClone(task);
  }
  prepareStart(id: string): AutomaticListingTask {
    const task = this.task(id);
    if (!['CREATED','PAUSED','NEEDS_ATTENTION'].includes(task.status) || this.activeId === id) throw new UserFacingError('此任务正在运行、等待平台或已经结束');
    this.assertScope(task,undefined,true); return structuredClone(task);
  }
  async confirmStart(id:string,confirm:(task:AutomaticListingTask)=>Promise<boolean>):Promise<AutomaticListingTask|null>{
    const approved=this.prepareStart(id);
    if(this.confirming.has(approved.id))throw new UserFacingError('此任务正在等待启动确认');
    this.confirming.add(approved.id);
    try{
      if(!await confirm(approved))return null;
      return this.startAuthorized(approved);
    }finally{this.confirming.delete(approved.id);}
  }
  startAuthorized(approved: AutomaticListingTask): AutomaticListingTask {
    const task = this.task(approved.id);
    if (fingerprint(task) !== fingerprint(approved)) throw new UserFacingError('确认期间任务范围发生变化');
    this.prepareStart(task.id);
    const previous=structuredClone(task);
    try {
      // A user-confirmed image binding may advance only untouched source rows. Submitted
      // siblings retain their exact draft/product revision and never repeat paid work.
      for(const row of task.items)if(this.canRebaseSources(task,row))row.productRevision=this.deps.store.getProduct(row.productId).revision;
      for(const row of task.items)this.migrateRepairPolicy(task,row);
      for (const row of task.items) if ((!row.schemaRetry||row.schemaRetry.state==='SUCCEEDED')&&row.status === 'FAILED'&&row.stage!=='PLAN'&&!task.adaptation?.blockedKeys.includes(row.key)) {
        if(row.outcome?.kind==='UNKNOWN'){const code=this.unknownCode(row,task);if(code&&!retryableAiUnknown(code))continue;}
        if(row.draftId&&this.deps.amazon.applyBusinessDefaults&&!this.unknownCode(row,task)&&row.repair?.phase!=='FIELDS_STARTED'){
          const old=this.deps.amazon.getDraft(row.draftId);
          const activeCompletion=new CompletionJournal(this.db).list(old.id).some(op=>!['DONE','RETIRED'].includes(op.state));
          if(!activeCompletion&&old.listingProgram==='haul'&&!submitted(old)&&(row.pricingRefresh||old.businessRules?.quote===null&&(!old.businessRules.pricingDecision||old.businessRules.pricingDecision.status==='needs_input'))){
            let refreshed=old;
            if(!row.pricingRefresh){
              try{
                refreshed=this.deps.amazon.applyBusinessDefaults({id:old.id,revision:old.revision},undefined,true,(draft,db)=>{
                  row.pricingRefresh={draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft),previousDraftRevision:old.revision,previousDraftStamp:imageWorkflowDraftStamp(old),previousReason:pricingBlockingReason(old)};
                  this.save(task,db);
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
              row.error=row.outcome.message;row.status=pricing.kind==='RULE_FILTERED'?'SCREENED':'FAILED';continue;
            }
          }
        }
        row.status = 'PENDING';
        delete row.outcome;
        // Retain the precise source failure if a ready sibling has frozen this product's revision.
        if (row.stage !== 'SOURCES' && !row.repair) row.error = null;
      }
      this.reconcileSelection(task);
      task.status = 'QUEUED'; task.error = null; this.save(task);
    } catch(error) {
      // Preparation can commit an atomic pricing checkpoint before a later
      // admission failure. Restore the latest durable record, not the queued
      // in-memory mutations, and never grant a worker after a failed save.
      let restored=previous;
      try {
        const saved=this.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id);
        if(saved)restored=validateAutomaticListingTask(JSON.parse(String(saved.record_json)));
      } catch { /* Keep the last known valid pre-start state if storage is unreadable. */ }
      this.tasks.set(task.id,restored);this.grants.delete(task.id);
      throw error;
    }
    this.grants.add(task.id);this.pump();return structuredClone(task);
  }
  private reconcileSelection(task: AutomaticListingTask): void {
    for(const productId of new Set(task.items.map(row=>row.productId))){
      const rows=task.items.filter(row=>row.productId===productId);
      const candidates=rows.flatMap(row=>{
        if(row.status!=='PENDING'||['PLAN','EXECUTION','READBACK','LABELS','COMPLETE'].includes(row.stage))return [];
        const unknown=this.unknownCode(row,task);
        if(unknown&&!retryableAiUnknown(unknown))return [];
        const draft=row.draftId?this.deps.amazon.getDraft(row.draftId):this.deps.amazon.listDrafts(productId).find(d=>this.matching(task,row,d));
        return draft&&submitted(draft)?[]:[{row,draft}];
      });
      // A pricing/input failure is already classified; no row here needs new selection.
      if(!candidates.length)continue;
      const product=this.deps.store.getProduct(productId),rules=this.deps.rules();
      const recipes=rows.some(row=>row.salesPlan)?selectSalesRecipes(product,this.deps.previewSales?.(productId)??previewSalesRecipes(product,this.deps.sourceReceipt?.(productId)??null,rules),rules,this.deps.sourceReceipt?.(productId)??null):null;
      const keys=new Set(recipes?recipes.map(r=>r.key):this.selectedVariants(product).map(v=>v.id));
      for(const {row,draft} of candidates){
        if(keys.has(row.salesPlan?.recipe.key??row.variantId))continue;
        row.status='SCREENED';row.error='SKU 选择规则淘汰：说明性选项或未入选本来源最多 4 个代表规格；来源、草稿、已完成图片及历史保留';
        row.outcome={version:1,kind:'RULE_FILTERED',code:'SKU_SELECTION_FILTERED',message:row.error,classifiedAt:new Date().toISOString(),scope:outcomeScope(task,row),draftId:row.draftId,draftRevision:row.draftId?draft?.revision??null:null};
      }
    }
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
  private pump(): void {
    if (this.worker || this.closed || this.closing) return;
    this.worker = Promise.resolve().then(async () => {
      for (;;) {
        const task = [...this.tasks.values()].find(value => value.status === 'QUEUED' && this.grants.has(value.id));
        if (!task || this.closed || this.closing) break;
        this.activeId = task.id; this.controller = new AbortController(); task.status = 'RUNNING'; this.save(task);
        try {
          for (const row of task.items) {
            // Immediately settled promises do not service Electron's window/IPC loop.
            // Yield between SKUs, then recheck pause/cancel before touching the next one.
            await yieldToEventLoop();
            if (!this.running(task)) break;
            if (task.adaptation?.blockedKeys.includes(row.key)||['DONE','FAILED','SCREENED'].includes(row.status) || ['READBACK','LABELS'].includes(row.stage)||row.schemaRetry&&['WAITING','IN_FLIGHT','EXHAUSTED'].includes(row.schemaRetry.state)) continue;
            try { await this.prepareItem(task, row); }
            catch (error) {
              recordErrorEvidence(detail=>this.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),row.productId,'operation.failed','自动任务步骤失败（脱敏诊断）',JSON.stringify(detail),new Date().toISOString()),error,{stage:row.stage,taskId:task.id,variantId:row.variantId,draftId:row.draftId,executionTaskIds:row.executionTaskIds});
              if (!this.running(task)) { row.status = 'PENDING'; this.save(task); break; }
              if(isSchemaTransientError(error)&&error.selection&&this.deferSchema(task,row,error))continue;
              row.status = 'FAILED'; row.error = error instanceof UserFacingError?errorMessage(error):`${row.sku} · ${row.stage}：${errorMessage(error)}`.slice(0,2000);
              const classified=structuredClone(row);await this.classifyFailure(task,classified);
              if(!this.running(task))break;
              Object.assign(row,classified);this.save(task);
              try { this.assertConnections(task); } catch (scopeError) { task.status = 'NEEDS_ATTENTION'; task.error = errorMessage(scopeError); this.save(task); break; }
            }
          }
          if (this.running(task)) this.summarize(task);
        } finally { if(!task.items.some(row=>row.status==='WAITING'&&(row.stage==='PARENT'||row.schemaRetry&&['WAITING','IN_FLIGHT'].includes(row.schemaRetry.state))))this.grants.delete(task.id); this.activeId = null; this.controller = null; }
      }
      await this.refreshWaiting();
    }).finally(() => { this.worker = null; if([...this.tasks.values()].some(task=>task.status==='QUEUED'&&this.grants.has(task.id)))this.pump(); });
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
    this.save(task);return true;
  }
  private async retrySchema(task:AutomaticListingTask,row:AutomaticListingItem):Promise<boolean>{
    const retry=row.schemaRetry!;
    const eligible=()=>!this.closed&&!this.closing&&!this.schedulingSuspended&&!this.confirming.has(task.id)&&this.grants.has(task.id)&&['WAITING','NEEDS_ATTENTION'].includes(task.status);
    if(!eligible()||retry.state!=='WAITING')return false;
    const next=planSchemaAttempt(retry,Date.now());
    if(next.kind==='exhausted'){Object.assign(retry,next.budget);row.status='FAILED';row.error='Schema 有限重试已用尽或超过 10 分钟，原进度和次数保留';this.save(task);return false;}
    if(next.kind==='waiting')return false;
    try {
      this.assertScope(task,row);
      if(retry.scope!==this.schemaScope(task,row,retry.selection))throw new UserFacingError('Schema 重试范围已变化，原进度保留');
      const reserved=reserveSchemaAttempt(this.db,task.id,row.key,retry,Date.now());Object.assign(retry,reserved.budget);
      if(reserved.kind!=='ready'){if(reserved.kind==='exhausted'){row.status='FAILED';row.error='Schema 有限重试已用尽，原进度和次数保留';this.save(task);}return false;}
      this.save(task);
      const revision=task.revision;
      try {await this.deps.amazon.getSchema!(retry.selection);}
      catch(error){
        if(!eligible()||task.revision!==revision){retry.state='WAITING';this.save(task);return false;}
        this.assertScope(task,row);
        if(!isSchemaTransientError(error))throw error;
        retry.state='WAITING';retry.dueAt=new Date(Math.min(Date.parse(retry.deadlineAt),Date.now()+([30_000,90_000,180_000][retry.usedDelayedRounds]??0))).toISOString();
        if(retry.usedDelayedRounds>=3){retry.state='EXHAUSTED';row.status='FAILED';row.error='Schema 有限重试已用尽，原进度和次数保留';}
        this.save(task);return false;
      }
      if(!eligible()||task.revision!==revision){retry.state='WAITING';this.save(task);return false;}
      this.assertScope(task,row);
      if(retry.scope!==this.schemaScope(task,row,retry.selection))throw new UserFacingError('Schema 重试范围已变化');
      if(Date.now()>=Date.parse(retry.deadlineAt))throw new UserFacingError('Schema 重试超过 10 分钟，原进度和次数保留');
      retry.state='SUCCEEDED';row.stage=retry.originalStage;row.status='PENDING';row.error=null;this.save(task);return true;
    }catch(error){retry.state='EXHAUSTED';row.status='FAILED';row.error=errorMessage(error);this.save(task);return false;}
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
  private imageReady(run:ImageWorkflowRun|null|undefined): boolean {return imageReady(run)&&this.imagePolicyCompatible(run);}
  private async prepareItem(task: AutomaticListingTask, row: AutomaticListingItem): Promise<void> {
    const unknown=this.unknownCode(row,task);
    if(unknown&&!retryableAiUnknown(unknown)&&!(unknown==='SUBMISSION_UNKNOWN'&&row.draftId&&submitted(this.deps.amazon.getDraft(row.draftId))))throw new UserFacingError(row.error||'上次付费请求或提交结果尚未确认，请先核对；未自动重发');
    this.checkpoint(task, row);
    let draft = row.draftId ? this.deps.amazon.getDraft(row.draftId) : undefined;
    if (!draft) {
      const existing = this.deps.amazon.listDrafts(row.productId).filter(value => this.matching(task, row, value));
      const sent = existing.find(submitted);
      if (sent) { row.draftId = sent.id; row.stage = 'READBACK'; row.status = 'WAITING'; this.deps.followup.schedule(sent.id); this.save(task); return; }
    } else if (!this.matching(task, row, draft)) throw new UserFacingError('任务草稿归属发生变化');
    if (draft && submitted(draft)) { row.stage = 'READBACK'; row.status = 'WAITING'; this.deps.followup.schedule(draft.id); this.save(task); return; }
    if (row.sourcesPrepared) {
      // Legacy tasks only recorded source delivery. Establish the current visual
      // proof without downloading again or changing the frozen product revision.
      const variantIds=row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId];
      try { assertProductConsistency(this.db,this.deps.store.getProduct(row.productId),variantIds); }
      catch(error) {
        if(!(error instanceof SourceConsistencyError)||!['SOURCE_CONSISTENCY_NEEDS_INPUT','SOURCE_CONSISTENCY_INVALID_OUTPUT','SOURCE_CONSISTENCY_SENT_UNKNOWN'].includes(error.code))throw error;
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
        row.sourcesPrepared=true;row.stage='DRAFT';row.error=null;delete row.outcome;this.save(task);
      } catch(error) {
        if(!(error instanceof SourceConsistencyError))throw error;
        // A retained format failure already has its exact source scope. Recover it
        // before frozen-sibling delivery guards; recovery never needs another download.
        if(['SOURCE_CONSISTENCY_INVALID_OUTPUT','SOURCE_CONSISTENCY_SENT_UNKNOWN'].includes(error.code)){
          if(!this.deps.prepareSourceConsistency)throw error;
          const variantIds=row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId];
          await this.deps.prepareSourceConsistency({productId:row.productId,productRevision:row.productRevision,variantIds},this.controller!.signal,()=>this.checkpoint(task,row));
          this.checkpoint(task,row);assertProductConsistency(this.db,this.deps.store.getProduct(row.productId),variantIds);
          row.sourcesPrepared=true;row.stage='DRAFT';row.error=null;delete row.outcome;this.save(task);
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
        if(issue)row.outcome={version:1,kind:AUTOMATIC_SOURCE_ISSUES[issue.code],code:issue.code,message:issue.message.slice(0,2000),classifiedAt:new Date().toISOString(),scope:outcomeScope(task,row),draftId:null,draftRevision:null};
        const reason = issue?.message || row.error || '该 SKU 的来源图片尚未准备完成';
        throw new UserFacingError(reason.includes(frozenSourcesMessage) ? reason : `${reason}；${frozenSourcesMessage}`);
      }
      const siblings = task.items.filter(value => value.status!=='SCREENED'&&value.productId === row.productId && !value.sourcesPrepared && value.stage === 'SOURCES');
      row.status = 'RUNNING'; row.stage = 'SOURCES'; this.save(task);
      const result = await this.deps.images.prepareSources({ productId: row.productId, productRevision: row.productRevision, variantIds: [...new Set(siblings.flatMap(value => value.salesPlan?.recipe.components.map(c=>c.variantId)??[value.variantId]))] });
      if (sourceStamp(result.product) !== row.sourceStamp) throw new UserFacingError('准备来源图期间商品资料变化');
      for (const sibling of siblings) {
        sibling.productRevision = result.product.revision;
        let missing = result.missing.find(value => (sibling.salesPlan?.recipe.components.map(c=>c.variantId)??[sibling.variantId]).includes(value.variantId));
        let consistencyError:SourceConsistencyError|undefined;
        if(!missing){
          try{
            this.checkpoint(task,sibling);
            if(!this.deps.prepareSourceConsistency)throw new SourceConsistencyError('SYSTEM_REPAIR','SOURCE_CONSISTENCY_UNAVAILABLE','来源图与规格校验服务尚未初始化');
            await this.deps.prepareSourceConsistency({productId:sibling.productId,productRevision:sibling.productRevision,variantIds:sibling.salesPlan?.recipe.components.map(c=>c.variantId)??[sibling.variantId]},this.controller!.signal,()=>this.checkpoint(task,sibling));
            this.checkpoint(task,sibling);assertProductConsistency(this.db,this.deps.store.getProduct(sibling.productId),sibling.salesPlan?.recipe.components.map(c=>c.variantId)??[sibling.variantId]);
          }catch(error){
            if(!this.running(task))throw error;
            consistencyError=error instanceof SourceConsistencyError?error:new SourceConsistencyError('SYSTEM_REPAIR','SOURCE_CONSISTENCY_REQUEST_FAILED',errorMessage(error));
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
        for (const sibling of siblings) if (!sibling.sourcesPrepared) sibling.error = errorMessage(new UserFacingError(`${sibling.error}；${frozenSourcesMessage}`));
      }
      this.save(task); this.checkpoint(task, row);
      if (!row.sourcesPrepared) throw new UserFacingError(row.error!);
    }
    row.status = 'RUNNING';
    if (task.productType === 'AUTO' && !row.classification) {
      if (!this.deps.classify) throw new UserFacingError('逐商品分类服务尚未初始化');
      row.stage = 'CLASSIFY'; this.save(task);
      const classification = await this.deps.classify({ productId:row.productId,productRevision:row.productRevision,targetId:task.targetId }, this.controller!.signal);
      this.checkpoint(task,row);
      for (const sibling of task.items.filter(item=>item.productId===row.productId)) sibling.classification = structuredClone(classification);
      this.save(task);
    }
    const productType = row.classification?.productType ?? task.productType;
    if(row.salesPlan&&!row.salesPlan.familyResolved){
      if(!this.deps.resolveFamily)throw new UserFacingError('销售组合类目规则尚未初始化');
      const siblings=task.items.filter(value=>value.salesPlan?.sourceGroupKey===row.salesPlan!.sourceGroupKey);
      const plans=await this.deps.resolveFamily({plans:siblings.map(value=>value.salesPlan!),targetId:task.targetId,productType,locale:task.locale},this.controller!.signal);
      this.checkpoint(task,row);
      for(const sibling of siblings){const plan=plans.find(value=>value.sku===sibling.sku);if(!plan)throw new UserFacingError('类目关系缺少销售 SKU');sibling.salesPlan=plan;}
      this.save(task);
    }
    const parentage=row.salesPlan?.parentage??'NONE';
    if (!draft) {
      draft = this.deps.amazon.listDrafts(row.productId).find(value => this.matching(task, row, value) && value.productRevision === row.productRevision
        && !submitted(value) && ['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(value.state) && value.schema.productType === productType
        && value.schema.requirements === 'LISTING' && value.schema.parentageLevel === parentage && value.schema.locale === task.locale
        && value.listingProgram === (task.mode === 'live' ? 'haul' : 'standard'));
      if (draft) { row.draftId = draft.id; this.save(task); }
    }
    if (!draft) {
      row.stage = 'DRAFT'; this.save(task);
      // Preparation service reuses matching editable drafts and validates listing identity itself.
      const result = await this.deps.amazon.prepareDrafts({ targetId: task.targetId, productType, parentageLevel: parentage, requirements: 'LISTING', locale: task.locale,
        listingProgram: task.mode === 'live' ? 'haul' : 'standard', items: [{ productId: row.productId, productRevision: row.productRevision, variantId: row.variantId, attributes: {} }] },row.salesPlan?[row.salesPlan]:undefined);
      const prepared = result.items.find(value => value.productId === row.productId && value.variantId === row.variantId);
      if (!prepared?.draft || prepared.disposition === 'REJECTED') throw new UserFacingError(prepared?.error || prepared?.issues.map(value => value.message).join('；') || '草稿准备未返回有效结果');
      draft = prepared.draft; row.draftId = draft.id; this.save(task); this.checkpoint(task, row);
    }
    if (!this.matching(task, row, draft) || draft.productRevision !== row.productRevision) throw new UserFacingError('准备后的草稿范围与任务不一致');
    if(draft.businessRules?.quote&&draft.businessRules.pricingDecision?.version!==3&&draft.businessRules.revision!==task.ruleRevision)throw new UserFacingError('上架规则已变化，请核对并重新计算已有草稿报价；未沿用旧报价');
    assertCurrentPricingForPaid(draft,this.deps.rules());
    const pricingIssue=pricingBlockingReason(draft,this.deps.rules());
    if(pricingIssue){row.stage='DRAFT';this.save(task);throw new UserFacingError(pricingIssue);}
    if(row.familyTransition)draft=await this.finishFamilyTransition(task,row);
    if (!row.executionTaskIds.length||this.deps.execution.get(row.executionTaskIds.at(-1)!).status==='CANCELLED') {
      const prior = this.deps.images.getProgress(draft.id);
      row.stage = 'IMAGES'; this.save(task);
      if (!this.imageReady(prior)) {
        const changedRiskPolicy=canResumeRiskAdaptation(this.db,task,row,draft,prior,this.deps.store.getProduct(row.productId))||!!prior&&(!this.imagePolicyCompatible(prior)||prior.status==='BLOCKED'&&(this.deps.images.getRiskSettings?.().enabled===false||this.deps.images.getCopyReviewSettings?.().enabled===false));
        if (row.imageStarted && !canResumeImageWorkflow(prior) && !changedRiskPolicy && !(unknown==='IMAGE_RESULT_UNKNOWN')) throw new UserFacingError(prior?.error || '上次图片请求未确认完成；未自动重新生图。请在异常商品中核对已有结果后继续。');
        // complete rejects local preflight synchronously and defers admitted work.
        // Save the conservative unknown marker before awaiting that work, not before
        // the no-send entry checks; a rejected entry must remain recoverable.
        const operation = this.deps.images.complete({ draftId: draft.id, draftRevision: draft.revision },row.imageStarted&&!prior?{legacyImageAttempts:row.imageAttempts}:undefined);
        row.imageStarted = true; this.save(task);
        const result = await operation;
        if(result.workflow.rejection)row.rejection={workflowId:result.workflow.id,detail:structuredClone(result.workflow.rejection)};else delete row.rejection;
        row.imageAttempts = result.workflow.attempt+(result.workflow.legacyImageAttempts??0); this.save(task);
        if (!this.imageReady(result.workflow)) throw new UserFacingError(result.workflow.error || '侵权检测或 OCR 复核未通过，尚无可用图片');
        draft = result.draft;
      }
      this.checkpoint(task, row);
    }
    if(row.repair){await this.finishRepair(task,row);draft=this.deps.amazon.getDraft(draft.id);}
    draft=await this.reconcileFamily(task,row,draft);
    if (!row.executionTaskIds.length||this.deps.execution.get(row.executionTaskIds.at(-1)!).status==='CANCELLED') {
      if(row.salesPlan?.parentage==='CHILD'){
        if(!this.deps.ensureParent)throw new UserFacingError('父体建档服务尚未初始化');
        row.stage='PARENT';this.save(task);
        const parent=await this.deps.ensureParent(this.deps.amazon.getDraft(draft.id),task.profileId,this.controller!.signal);
        row.parentDraftId=parent.draftId;this.checkpoint(task,row);
        if(!parent.ready){row.status='WAITING';this.save(task);return;}
      }
      const child = this.childFor(task, draft);
      row.executionTaskIds.push(child.id); row.stage = 'EXECUTION'; this.save(task);
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
        this.deps.followup.schedule(current.id); this.save(task); return;
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
      row.repair = { phase: 'FIELDS_PENDING', sourceWorkflowId: prior!.id, draftRevision: current.revision, draftStamp: imageWorkflowDraftStamp(current) }; this.save(task);
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
    this.save(task);return this.finishFamilyTransition(task,row);
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
      row.familyTransition=change={...change,phase:'RECHECK',draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)};this.save(task);
      this.checkpoint(task,row);
    }
    if(change.phase==='RECHECK'){
      if(draft.revision!==change.draftRevision||imageWorkflowDraftStamp(draft)!==change.draftStamp){
        if(draft.revision<=change.draftRevision||!this.deps.images.canResumeRecheckDraft?.({draftId:draft.id,draftRevision:draft.revision,sourceWorkflowId:change.sourceWorkflowId}))throw new UserFacingError('父子体转换后的草稿已变化，请核对原图复核进度');
        row.familyTransition=change={...change,draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)};this.save(task);
      }
      draft=await this.deps.recheckImage({draftId:draft.id,draftRevision:draft.revision,sourceWorkflowId:change.sourceWorkflowId},this.controller!.signal);
      row.familyTransition=change={...change,phase:'READY',draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)};this.save(task);
      this.checkpoint(task,row);
    }
    if(draft.revision!==change.draftRevision||imageWorkflowDraftStamp(draft)!==change.draftStamp)throw new UserFacingError('父子体转换后草稿发生变化');
    const active=row.executionTaskIds.map(id=>this.deps.execution.get(id));
    if(active.some(t=>t.items.some(i=>i.submitStarted)))throw new UserFacingError('已有提交意图，未替换执行任务');
    for(const prior of active)if(!['COMPLETED','CANCELLED'].includes(prior.status))this.deps.execution.cancel(prior.id);
    row.stage='IMAGES';delete row.familyTransition;this.save(task);return draft;
  }
  private async finishRepair(task: AutomaticListingTask, row: AutomaticListingItem): Promise<void> {
    let repair = row.repair!;
    const before=this.deps.amazon.getDraft(row.draftId!);
    const localRefresh=!!repair.operationId&&(repair.businessAuthorityRefresh==='business-authority/v1'||needsBusinessAuthorityRefresh(before,repair.remaining))
      &&new CompletionJournal(this.db).get(repair.operationId).state==='DONE';
    if(localRefresh&&repair.phase==='FIELDS_PENDING'){
      if(!this.matching(task,row,before)||submitted(before)||before.revision!==repair.draftRevision||imageWorkflowDraftStamp(before)!==repair.draftStamp
        ||row.executionTaskIds.some(id=>this.deps.execution.get(id).items.some(i=>i.submitStarted||i.draftId!==before.id)))throw new UserFacingError('旧事实恢复范围或提交记录已变化，未修改草稿');
      row.repair=repair={...repair,phase:'FIELDS_STARTED',businessAuthorityRefresh:'business-authority/v1'};this.save(task);
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
      row.repair=repair={...repair,phase:remaining.length?'FIELDS_PENDING':'RECHECK_PENDING',remaining,draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)};this.save(task);this.checkpoint(task,row);
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
      row.repair=repair={...repair,draftRevision:current.revision,draftStamp:imageWorkflowDraftStamp(current)};this.save(task);
    }
    if (!this.matching(task,row,current) || current.revision !== repair.draftRevision || imageWorkflowDraftStamp(current) !== repair.draftStamp || submitted(current)) throw new UserFacingError('字段修复后草稿发生变化，请核对异常商品');
    // Older checkpoints may have been saved without checking the field repair outcome.
    const currentPricingRules=this.deps.rules();
    const unresolved = fieldRepairRemaining(current, currentPricingRules, repair.remaining);
    if (!unresolved.length && repair.phase==='FIELDS_PENDING' && repair.remaining?.length
      && !withoutHistoricalPricingRemaining(current,repair.remaining,currentPricingRules).length) {
      row.repair=repair={...repair,phase:'RECHECK_PENDING',remaining:[]};this.save(task);
    }
    if (unresolved.length && repair.phase !== 'FIELDS_PENDING') {
      row.repair = repair = { ...repair, phase: 'FIELDS_PENDING', remaining: unresolved }; this.save(task);
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
      row.repair = { ...repair, phase: 'FIELDS_STARTED',...(operationId?{operationId}:{}) }; this.save(task);
      const result = await this.deps.repairFields(current.id,this.controller!.signal,operationId);
      current = 'draft' in result ? result.draft : result;
      const remaining = fieldRepairRemaining(current,this.deps.rules(),'draft' in result ? result.remaining : []);
      // A known incomplete result is safe to retry; an interrupted unknown result is not.
      row.repair = repair = { ...row.repair!, phase: remaining.length ? 'FIELDS_PENDING' : 'RECHECK_PENDING', remaining,
        draftRevision: current.revision, draftStamp: imageWorkflowDraftStamp(current) }; this.save(task);
      this.checkpoint(task,row);
    }
    if (repair.phase === 'RECHECK_PENDING') {
      if (!this.deps.recheckImage) throw new UserFacingError('现有图片复核服务不可用');
      assertCurrentPricingForPaid(this.deps.amazon.getDraft(current.id),this.deps.rules());
      current = await this.deps.recheckImage({ draftId: current.id, draftRevision: current.revision, sourceWorkflowId: repair.sourceWorkflowId }, this.controller!.signal);
      row.repair = { ...repair, phase: 'READY', draftRevision: current.revision, draftStamp: imageWorkflowDraftStamp(current) }; this.save(task);
      this.checkpoint(task, row);
    }
    const priorChildId = row.executionTaskIds.at(-1)!;
    const priorChild = this.deps.execution.get(priorChildId);
    if (priorChild.items.some(item => item.submitStarted)) throw new UserFacingError('已有提交记录，未重建执行任务');
    this.deps.execution.cancel(priorChildId);
    const replacement = this.childFor(task, current);
    row.executionTaskIds.push(replacement.id); row.repair = null; row.stage = 'EXECUTION'; this.save(task);
  }
  private childFor(task: AutomaticListingTask, draft: AmazonDraft) {
    const existing = this.deps.execution.list().filter(child => !['CANCELLED','COMPLETED'].includes(child.status) && child.items.some(item => item.draftId === draft.id));
    if (existing.length) {
      const child = existing[0], item = child.items[0];
      if (existing.length !== 1 || !['CREATED','PAUSED','NEEDS_ATTENTION'].includes(child.status) || child.items.length !== 1 || child.profileId !== task.profileId || child.profileStamp !== task.profileStamp
        || item.draftId !== draft.id || item.draftRevision !== draft.revision || item.attributesHash !== fingerprint(draft.attributes) || item.schemaHash !== fingerprint(draft.schema)
        || item.productId !== draft.productId || item.productRevision !== draft.productRevision || item.variantId !== draft.variantId || item.sku !== draft.sku
        || item.targetStamp !== task.targetStamp || item.submitStarted) throw new UserFacingError('草稿已有不同范围的执行任务，请先核对原任务');
      return child;
    }
    return this.deps.execution.create({ draftIds: [draft.id], profileId: task.profileId, concurrency: 1 });
  }
  private summarize(task: AutomaticListingTask, observedBefore?: string): void {
    if (['PAUSED','CANCELLED'].includes(task.status)) return;
    task.status = task.items.every(row => ['DONE','SCREENED'].includes(row.status)) ? 'COMPLETED'
      : task.items.some(row => row.status === 'WAITING') ? 'WAITING' : 'NEEDS_ATTENTION';
    task.error = task.items.find(row => row.status === 'FAILED')?.error ?? null;
    if (observedBefore === undefined || JSON.stringify(task) !== observedBefore) this.save(task);
  }
  refreshWaiting(): Promise<void> {
    if (this.closed || this.closing || this.schedulingSuspended) return Promise.resolve();
    if (this.observing) return this.observing;
    this.observing = Promise.resolve().then(async () => {
      // Global scan failures must stay outside per-SKU error classification.
      // Only observable submitted work can need this expensive view.
      const needsCandidates = [...this.tasks.values()].some(task => !this.confirming.has(task.id)
        && ['WAITING', 'NEEDS_ATTENTION'].includes(task.status)
        && task.items.some(row => row.draftId && row.status !== 'DONE' && ['READBACK', 'LABELS'].includes(row.stage)));
      const candidates = new Map((needsCandidates ? this.deps.procurement.candidates() : []).map(value => [value.draftId, value]));
      for (const task of this.tasks.values()) {
        const canObserve=()=>!this.closed&&!this.closing&&!this.schedulingSuspended&&!this.confirming.has(task.id)&&['WAITING','NEEDS_ATTENTION'].includes(task.status);
        if (!canObserve()) continue;
        const observedBefore = JSON.stringify(task);
        let resumeParents=false,interrupted=false;
        for (const row of task.items) {
          const beforeYield = task.revision;
          await yieldToEventLoop();
          if (task.revision !== beforeYield) { interrupted = true; break; }
          if(!canObserve())break;
          if(row.schemaRetry?.state==='WAITING'){if(await this.retrySchema(task,row))resumeParents=true;continue;}
          if(row.stage==='PARENT'&&row.parentDraftId&&row.status==='WAITING'){
            const parent=this.deps.followup.get(row.parentDraftId);
            if(parent.status==='NEEDS_ATTENTION'){row.status='FAILED';row.error=parent.error||'父体建档失败，保留子体图片和进度';}
            else if(parent.status==='READY'&&this.grants.has(task.id)){row.status='PENDING';resumeParents=true;}
            continue;
          }
          if (!row.draftId || ['DONE','SCREENED'].includes(row.status) || !['READBACK','LABELS'].includes(row.stage)) continue;
          try {
            if(row.stage==='LABELS'&&(row.error||row.outcome))this.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),row.productId,'automatic-listing.labels-detached','保留旧标签错误；标签改为按需独立处理',JSON.stringify({taskId:task.id,draftId:row.draftId,error:row.error,outcome:row.outcome??null}),new Date().toISOString());
            if (!this.matching(task, row, this.deps.amazon.getDraft(row.draftId))) throw new UserFacingError('已提交草稿归属变化，请核对');
            if(row.stage==='LABELS')row.stage='READBACK';
            {
              const followup = task.mode === 'live' ? this.deps.followup.get(row.draftId) : { status: 'READY', error: null };
              if (followup.status === 'NEEDS_ATTENTION') throw new UserFacingError(followup.error || '平台回读需要处理');
              const candidate = candidates.get(row.draftId);
              if (followup.status !== 'READY' || !candidate?.eligible) {
                if (followup.status === 'READY' && candidate?.requiresAttention) throw new UserFacingError(candidate.reason);
                row.status = 'WAITING';
                row.error = followup.status === 'READY'
                  ? `平台已建档；${candidate?.reason || '等待备货条件确认'}；可售状态单独以平台结果为准`
                  : followup.error || '等待 Amazon 处理原提交并确认建档（原提交后 24 小时内回读）';
                delete row.outcome; continue;
              }
              row.error = null; delete row.outcome;
              const batches = this.deps.procurement.ensureAutomaticBatch(task.id, [row.draftId], { [row.draftId]: row.stockSets });
              const batch = batches.find(value => value.lines.some(line => line.draftId === row.draftId));
              if (!batch) throw new UserFacingError('回读已就绪，但备货批次未建立');
              row.batchId = batch.id;
            }
            row.status = 'DONE'; row.stage = 'COMPLETE'; row.error = null; delete row.outcome;
          } catch (error) {
            recordErrorEvidence(detail=>this.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),row.productId,'operation.failed','自动任务步骤失败（脱敏诊断）',JSON.stringify(detail),new Date().toISOString()),error,{stage:row.stage,taskId:task.id,variantId:row.variantId,draftId:row.draftId,executionTaskIds:row.executionTaskIds});
            row.status = 'FAILED'; row.error = error instanceof UserFacingError?errorMessage(error):`${row.sku} · ${row.stage}：${errorMessage(error)}`.slice(0,2000);
            const revision=task.revision,classified=structuredClone(row);await this.classifyFailure(task,classified);
            if(!canObserve()||task.revision!==revision){interrupted=true;break;}
            Object.assign(row,classified);
          }
        }
        if(interrupted||!canObserve())continue;
        if(resumeParents&&this.grants.has(task.id)){task.status='QUEUED';this.save(task);queueMicrotask(()=>this.pump());}
        else this.summarize(task, observedBefore);
      }
    }).finally(() => { this.observing = null; });
    return this.observing;
  }
  pause(id: string): AutomaticListingTask {
    const task = this.task(id); if (final(task)) throw new UserFacingError('已结束任务不能暂停');
    task.status = 'PAUSED'; this.grants.delete(id); this.stopChildren(task, false); this.save(task); return structuredClone(task);
  }
  cancel(id: string): AutomaticListingTask {
    const task = this.task(id); if (task.status === 'COMPLETED') throw new UserFacingError('已完成任务不能取消');
    task.status = 'CANCELLED'; this.grants.delete(id); this.stopChildren(task, true); this.save(task); return structuredClone(task);
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
    if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const task of this.tasks.values()) if (['RUNNING','QUEUED'].includes(task.status)) this.pause(task.id);
    this.grants.clear();
    this.closing = Promise.resolve().then(async () => { await this.worker; await this.observing; this.db.close(); this.closed = true; });
    return this.closing;
  }
}
