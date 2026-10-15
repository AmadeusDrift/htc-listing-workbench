import {reservePreparedImageReview,markImageReviewEffect,storeImageReviewResult,projectImageReviewOutcome} from './review-journal.ts';
import type {AiDurableRequestPort} from '../ai/durable-request.ts';
import type {ImageReviewRequestV2} from '../../shared/image-workflow-contracts.ts';
import { candidateRetryEvidence } from './retry-evidence.ts';
import {assertApprovalReviewsResolved} from './approval-pending.ts';
import { randomUUID as retryCommandId } from 'node:crypto';
import { imageSlotAttemptLimit } from '../../shared/image-workflow-contracts.ts';
import { planningRetryExhausted,assertRetryAllowanceRun,grantImageRetry,historicalRetryEligible,retryGrants,retryHistoryGap,saveRetryConsumption } from './retry-allowance.ts';
import { transaction } from '../application/transaction.ts';
import { appendAuditEvent } from '../storage/audit.ts';
import { registerGeneratedAsset } from '../assets/commands.ts';
import { confirmAssetBinding } from '../products/asset-bindings.ts';
import {imageSourceTrace} from './source-trace.ts';
import {readAppearanceReviewSettings,writeAppearanceReviewSettings,runAppearanceReview} from './appearance-review.ts';
import { BatchWaitingError } from '../ai/batch/task-context.ts';
import { isSchemaTransientError } from '../amazon/schema-retry.ts';
import { sameSchemaValidation } from '../amazon/schema-compatibility.ts';
import { assertImageWorkflowHistory } from './history.ts';
import { currentImageAdaptation,partialSourceBlocker,partialRiskModeBlocker,workflowHash } from './adaptation.ts';
import {missingWorkflowBudget} from './legacy-missing.ts';
import { resultHasOwner } from '../ai/result-owner.ts';
import {productReferenceImages} from './reference-purpose.ts';
import { evaluateImageRisk, describeImageRisk } from '../../shared/image-risk-policy.ts';
import { needsPlainColorRefresh } from '../listing-ai/plain-colors.ts';
import { isProductReference } from "../source-reference-query.ts";
import { imageListingCopyMatches } from './context-compatibility.ts';
import { LOCAL_LISTING_POLICY,currentPolicyRemaining,needsBusinessAuthorityRefresh } from './policy-reevaluation.ts';
import { presentRejection } from '../../shared/rejection-presentation.ts';
import { assertWorkflowRejectionOwner,readCompletionForRejection } from './rejection.ts';
import { allowSourceUnbound, readSourceImageReceipt } from '../source-images.ts';
import { createHash, randomUUID } from 'node:crypto';
import { withoutDeferredImageRemaining, withoutHistoricalPricingRemaining, legacyContentRepairFields, pricingBlockingReason, nonDeferredImageIssues, categoryRepairFields } from './deferred-fields.ts';
import { readListingRules } from '../listing-rules.ts';
import { FIELD_REPAIR_POLICY_VERSION, CATEGORY_FIELD_REPAIR_POLICY_VERSION } from '../../shared/automatic-listing-contracts.ts';
import { join } from 'node:path';
import { open, unlink } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { AmazonDraft, AmazonSchema } from '../../shared/amazon-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { imageEvidenceVersion, isFullSchema } from "../listing-ai/native-values.ts";
import type { ProductImageContext } from '../../shared/image-ai-contracts.ts';
import { PRODUCT_IMAGE_POLICY_VERSION, IMAGE_SET_POLICY, IMAGE_TEXT_REVIEW_POLICY_VERSION } from '../../shared/image-ai-contracts.ts';
import { assertCurrentListingReview, assertImageSetPlan, assertImagePlan, imageGenerationPrompt, imageRiskSourceSnapshot, validateProductImageContext } from '../ai/image-validation.ts';
import { assertCurrentCopyEvidence, assertCurrentImageCategoryExclusions, currentDraftEvidenceIssues } from '../listing-ai/current-evidence.ts';
import type { CompleteAutomaticProductResult, ImageWorkflowProgress, ImageWorkflowRun, ImageWorkflowSlot, ImageSlotAttempt } from '../../shared/image-workflow-contracts.ts';
import { hasSevenApprovedImages, needsImageTextPolicyReview } from '../../shared/image-workflow-contracts.ts';
import type { GeneratedImageCandidate } from '../../shared/image-generation-contracts.ts';
import type { WorkspaceStore } from '../store.ts';
import type { AmazonService } from '../amazon/service.ts';
import type { AiService } from '../ai/service.ts';
import type { ImageGenerationService } from '../image-generation/service.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { openDatabase } from '../database.ts';
import { CompletionJournal } from '../listing-ai/completion-journal.ts';
import { ListingAiService } from '../listing-ai/service.ts';
import { listingFingerprint } from "../json-fingerprint.ts";
import { buildListingContext } from '../listing-ai/context.ts';
import { currentImageListingSnapshot, referenceMeasurementEvidence, sourceDimensionEvidence, imageEvidence } from './image-facts.ts';
import { readManagedImage } from '../ai/source.ts';
import { AiError, throwIfAborted } from '../ai/errors.ts';
import { integer, keys, uuid } from "../ai/primitives.ts";
import { privateDirectory } from '../image-generation/vault.ts';

import { publicError } from '../security.ts';
import { inspectRaster } from '../image-format.ts';
import { approvedWorkflowAsset, approvedWorkflowAssets, currentWorkflowPlanIds, validateStoredImageWorkflowRun, workflowRuns } from "./records.ts";
import { imageWorkflowDraftStamp } from "./approval-reuse.ts";
import { selectImageReferences } from "../assets/reference-selection.ts";
import { parseAutomaticSources, prepareImageWorkflowSources } from './sources.ts';
import type { AutomaticImageSources, AutomaticSourcesResult } from './sources.ts';
import { currentSourceImageMeasurements } from './source-measurements.ts';
import { imageApprovalDraftSnapshot, assertApprovalReuseSource, compatibleApprovalRecipe } from './approval-reuse.ts';
import { readImageRiskSettings, writeImageRiskSettings, riskPolicyCompatible } from './risk-settings.ts';
import { readCopyReviewSettings, writeCopyReviewSettings, copyReviewPolicyCompatible } from '../listing-ai/review-settings.ts';
import { hasRecordedRecheckDraft } from './recheck-evidence.ts';
import { imageListingContextsMatch,imageActualInputsMatch } from './context-compatibility.ts';
import type { AutomaticRuleEvidence } from '../../shared/automatic-listing-contracts.ts';
import type { AiResult } from '../../shared/ai-contracts.ts';

function assertImageSchemaCurrent(schema:AmazonSchema,snapshot:ListingAiContext):void {
  const unchanged=schema.checksum===snapshot.schemaChecksum&&schema.version===snapshot.schemaVersion&&listingFingerprint({schema:schema.schema,metaSchema:schema.metaSchema})===snapshot.schemaSha256;
  const displayOnly=schema.version===snapshot.schemaVersion&&snapshot.fullSchema&&sameSchemaValidation(schema,snapshot.fullSchema);
  if(!unchanged&&!displayOnly)throw new UserFacingError('Amazon 字段规则已更新，当前图片依据与新 Schema 不兼容，请重新核对字段规则');
}
type ListingStage = Pick<ListingAiService, 'complete' | 'reviewCurrentForImages'> & Partial<Pick<ListingAiService,'hasSelectedFirmnessCorrection'|'hasRetainedFieldReferences'|'repairCurrentForImages'|'snapshotCurrentForImages'|'beginCompletion'|'currentAuthorizationContext'>> & {
  prepareSourceColors?(input:{draftId:string;draftRevision:number},signal?:AbortSignal):Promise<{aiCalls:number;evidenceChanged:boolean;evidenceSha256?:string}>;
  currentContext?(draft:AmazonDraft,product:ProductDetail,targetGeneration:number):ListingAiContext;
};
type AiStages = Pick<AiService, 'getProfile' | 'getResult' | 'getCall' | 'listResults' | 'recognize' | 'imagePlan' | 'recognizeGeneratedImage' | 'reviewGeneratedImage' | 'reviewGeneratedImageRisk'> & Partial<Pick<AiService,'reviewRequestJournalVersion'|'listCalls'|'hasPendingCopyReview'|'sourceObservationEvidence'|'purposeProfile'|'reviewGeneratedImageAppearance'>>;
type Generator = Pick<ImageGenerationService, 'getConnection' | 'configurationScope' | 'generate' | 'readCandidate' | 'generateForWorkflow' | 'reconcileWorkflowGeneration'>;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const remaining = (draft: AmazonDraft) => (draft.previewIssues.some(issue => issue.severity === 'ERROR') ? draft.previewIssues : draft.localIssues).filter(issue => issue.severity === 'ERROR').map(issue => issue.message);
const newSlots=():ImageWorkflowSlot[]=>Array.from({length:7},(_,i)=>({index:i+1,purpose:i===0?'main':'detail',status:'PENDING',contextSha256:null,attempts:[],approvedAssetId:null,approvedSha256:null,error:null}));

/** Main-process orchestration. It never accepts a prompt, reference path or review decision from the renderer. */
export class ImageWorkflowService {
  private db: DatabaseSync;
  private listing: ListingStage;
  private directory: string; private store: WorkspaceStore; private amazon: AmazonService; private ai: AiStages; private generation: Generator;
  private active = new Map<string, { operation: 'complete' | 'recheck'; controller: AbortController; promise: Promise<CompleteAutomaticProductResult> }>();
  private activeSources = new Map<string, { scope: string; controller: AbortController; promise: Promise<AutomaticSourcesResult> }>();
  private sources?: AutomaticImageSources;
  private closed = false;
  private retryPending=false;
  private workflowProfile(id:string){
    if(this.ai.purposeProfile&&id==='deepseek')return this.ai.purposeProfile('image_plan',true);
    if(this.ai.purposeProfile&&id==='deepseek-review')return this.ai.purposeProfile('image_text_review',false,true);
    return this.ai.getProfile(id);
  }
  constructor(directory: string, store: WorkspaceStore, amazon: AmazonService, ai: AiStages, generation: Generator, dependencies: { listing?: ListingStage; sources?: AutomaticImageSources } = {}) {
    this.directory = directory; this.store = store; this.amazon = amazon; this.ai = ai; this.generation = generation;
    this.listing = dependencies.listing ?? new ListingAiService(store, amazon, ai as AiService,()=>this.getCopyReviewSettings().enabled);
    this.sources = dependencies.sources;
    this.db = openDatabase(directory);
    try {
      for (const run of workflowRuns(this.db)) if (run.status === 'RUNNING') {
        run.status = 'INTERRUPTED'; run.error = '工作台曾中断；已通过图片与尝试次数已保留，未知生图结果须先核对，不自动重发'; this.save(run);
      }
    } catch (error) { this.db.close(); throw error; }
  }
  assertSourceConsistency(draftId:string):void {const draft=this.amazon.getDraft(draftId);this.store.assertSourceConsistency(draft.productId,draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId]);}
  private ensureOpen() { if (this.closed) throw new AiError('SERVICE_CLOSED'); }
  private currentContext(draft:AmazonDraft,product:ProductDetail,generation:number):ListingAiContext {
    return this.listing.currentContext?.(draft,product,generation)??buildListingContext(draft,product,generation);
  }
  private currentContextMatches(run:ImageWorkflowRun,draft:AmazonDraft):boolean {
    if(!this.listing.currentContext||!run.imageContext)return true;
    const context=this.currentContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation);
    return imageActualInputsMatch(run.imageContext,draft,this.store.getProduct(draft.productId),currentImageListingSnapshot(draft,context).context,run.imageRecipeSha256);
  }
  private reevaluatePolicy(run:ImageWorkflowRun,draft:AmazonDraft):void {
    // Completed source/reuse pairs are immutable backup proof. Their current
    // authorization is checked below on every use, without rewriting the pair.
    if(run.status==='COMPLETED'||run.approvalReuse)return;
    if(!this.listing.currentContext||!run.contentPreparation?.remaining.length&&(!run.imageContext||isFullSchema(run.imageContext.listing)))return;
    const context=this.listing.currentAuthorizationContext?.(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation,run.imageContext?.listing)??this.currentContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation);
    if(!isFullSchema(context)||run.contentPreparation?.state==='STARTED')return;
    if(run.referenceAssets.some(ref=>this.store.getAssetRecord(ref.id)?.sha256!==ref.sha256))throw new UserFacingError('来源图片内容已变化，已保留原图片和付费请求');
    if(run.imageContext&&!this.currentContextMatches(run,draft))throw new UserFacingError('来源规格、图片、店铺或站点已变化，已保留原图片和付费请求，请核对后重新复核');
    const inputSha256=listingFingerprint({context,draftStamp:imageWorkflowDraftStamp(draft)});
    if(run.policyReevaluation?.version===LOCAL_LISTING_POLICY&&run.policyReevaluation.inputSha256===inputSha256)return;
    const previousRemaining=run.policyReevaluation?.previousRemaining??[...(run.contentPreparation?.remaining??[])];
    if(run.contentPreparation?.state==='DONE'&&run.contentPreparation.draftRevision===draft.revision)run.contentPreparation.remaining=currentPolicyRemaining(draft,context,id=>this.ai.getResult(id));
    run.policyReevaluation={version:LOCAL_LISTING_POLICY,inputSha256,at:new Date().toISOString(),previousRemaining,...(run.policyReevaluation?.repairStarted?{repairStarted:true}:{})};this.save(run);
  }
  /** Current authorization only; never called by list/history/backup readers. */
  private assertCurrentEvidence(draft:AmazonDraft,base?:ProductImageContext,setPlan?:ImageWorkflowRun['setPlan'],planResultIds:string[]=[]):void {
    this.assertSourceConsistency(draft.id);
    const context=this.listing.currentAuthorizationContext?.(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation,base?.listing)??this.currentContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation);
    const issues=currentDraftEvidenceIssues(draft,context,this.listing.currentContext?id=>this.ai.getResult(id):undefined);
    if(issues.length)throw new UserFacingError(issues.join('；').slice(0,2000));
    assertCurrentImageCategoryExclusions(context,{base,setPlan,plans:planResultIds.flatMap(id=>{const result=this.ai.getResult(id);return result?[result]:[];})});
    if(!base)return;
    if(setPlan)assertImageSetPlan(setPlan,base);
    validateProductImageContext(base);
    assertCurrentCopyEvidence(base.currentListingCopy,context);
    if(base.copyReviewBypass)return;
    const review=base.listingReviewResultId?this.ai.getResult(base.listingReviewResultId):undefined;
    if(review?.output.kind!=='listing-current-review'||review.output.verdict!=='PASS')throw new UserFacingError('原文案复核记录不完整，已保留图片');
    assertCurrentListingReview({...review.output,kind:'amazon-fields-review'},base.currentListingCopy,base.listing,{storedVersion:'listing-evidence/v5'});
  }
  private canRecheckImageContent(run:ImageWorkflowRun,draft:AmazonDraft,remaining:string[]=run.contentPreparation?.remaining??[]):boolean {
    return !run.categoryFieldPolicyVersion&&!run.categoryFieldRepair&&run.contentPreparation?.state!=='STARTED'
      &&categoryRepairFields(draft,remaining).length>0&&!workflowRuns(this.db,draft.id).some(saved=>saved.productRevision===draft.productRevision&&saved.categoryFieldRepair);
  }
  private sourceRefusal(run:ImageWorkflowRun,result:AiResult):never {
    if(result.output.kind==='image-plan'&&result.output.productUnderstanding?.sufficient===false&&result.imageContext&&this.ai.getCall(result.callId))run.rejection={version:'rejection-presentation/v1',code:'SOURCE_OBSERVATION_INSUFFICIENT',callId:result.callId,resultId:result.id,contextSha256:listingFingerprint(result.imageContext),stage:'planning',slot:result.imageContext.slot?.index??0};
    throw new UserFacingError(presentRejection('SOURCE_OBSERVATION_INSUFFICIENT'));
  }
  private captureRejection(run:ImageWorkflowRun,error:unknown):void {
    if(!(error instanceof AiError)||!error.callId)return;
    const call=this.ai.getCall(error.callId),p=call?.presentationContext;
    if(!call?.rejection||!p||!['content','planning'].includes(run.stage)||p.draftId!==run.draftId||p.variantId!==run.variantId||call.productId!==run.productId||call.productRevision!==run.productRevision)return;
    const rejection:NonNullable<ImageWorkflowRun['rejection']>={...call.rejection,callId:call.id,resultId:null,contextSha256:p.sourceSha256,stage:p.kind==='image'?'planning':'content',slot:p.slot};
    try{assertWorkflowRejectionOwner({...run,rejection},id=>this.ai.getCall(id),id=>this.ai.getResult(id),id=>readCompletionForRejection(this.db,id));run.rejection=rejection;}catch{/* No exact persisted request scope: leave this error unattributed. */}
  }
  private save(run: ImageWorkflowRun): void {
    if(run.slots){const attempts=run.slots.flatMap(slot=>slot.attempts);run.attempt=attempts.length;
      for(const [plural,singular] of [['planResultIds','planResultId'],['candidateIds','candidateId'],['ipReviewResultIds','ipReviewResultId'],['ocrResultIds','ocrResultId'],['reviewResultIds','reviewResultId']] as const)run[plural]=[...new Set(attempts.flatMap(attempt=>attempt[singular]?[attempt[singular]!]:[]))];
      run.approvedAssetId=run.slots[0].approvedAssetId;run.approvedSha256=run.slots[0].approvedSha256;
    }
    run.updatedAt = new Date(Math.max(Date.now(), Date.parse(run.createdAt))).toISOString();
    const valid = validateStoredImageWorkflowRun(run);
    assertWorkflowRejectionOwner(valid,id=>this.ai.getCall(id),id=>this.ai.getResult(id),id=>readCompletionForRejection(this.db,id));
    transaction(this.db,()=>{assertRetryAllowanceRun(this.db,valid);saveRetryConsumption(this.db,valid);
    this.db.prepare('INSERT INTO image_workflow_runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(valid.id, JSON.stringify(valid));});
  }
  getAppearanceReviewSettings(){this.ensureOpen();return readAppearanceReviewSettings(this.db);}
  saveAppearanceReviewSettings(raw:unknown){this.ensureOpen();return writeAppearanceReviewSettings(this.db,raw);}
  get busy(): boolean { return this.retryPending || this.active.size > 0 || this.activeSources.size > 0; }
  getRiskSettings(){this.ensureOpen();return readImageRiskSettings(this.db);}
  saveRiskSettings(raw:unknown){
    this.ensureOpen();if(this.busy)throw new UserFacingError('请先暂停当前自动图片流程，再切换风险拦截');
    const previous=this.getRiskSettings(),value=writeImageRiskSettings(this.db,raw);
    if(JSON.stringify(previous)!==JSON.stringify(value))this.store.recordWorkspaceEvent('image.risk-interception.changed',value.enabled?'已开启图片风险拦截':'已关闭图片风险拦截；跳过风险检测，保留首图无字检查',value);
    return value;
  }
  isRiskPolicyCompatible(run:ImageWorkflowRun|null|undefined):boolean{return riskPolicyCompatible(run,this.getRiskSettings(),id=>{const result=this.ai.getResult(id);return result?.output.kind==='image-ip-review'?result.output:undefined;});}
  private assertApprovedRiskPolicy(prior:ImageWorkflowRun|null|undefined):void {
    if(!prior||!this.getRiskSettings().enabled||prior.riskInterceptionEnabled===false)return;
    if(!prior.slots&&prior.status==='COMPLETED'&&prior.imagePolicyVersion===PRODUCT_IMAGE_POLICY_VERSION){
      const id=prior.ipReviewResultIds?.at(-1),ip=id?this.ai.getResult(id):undefined;
      if(ip?.output.kind!=='image-ip-review'||ip.output.candidate.id!==prior.candidateIds.at(-1)||ip.output.candidate.sha256!==prior.approvedSha256||ip.output.planResultId!==prior.planResultIds.at(-1))throw new UserFacingError('旧单图风险检测依据缺失或归属不一致，原图片与历史记录已保留');
      if(evaluateImageRisk(ip.output,this.getRiskSettings()).verdict!=='PASS')throw new UserFacingError(describeImageRisk(ip.output,this.getRiskSettings(),prior.sku,1).slice(0,2000));
    }
    for(const slot of prior.slots??[]){if(slot.status!=='PASSED')continue;const id=slot.attempts.at(-1)?.ipReviewResultId,ip=id?this.ai.getResult(id):undefined;
      if(ip?.output.kind==='image-ip-review'&&evaluateImageRisk(ip.output,this.getRiskSettings()).verdict!=='PASS')throw new UserFacingError(describeImageRisk(ip.output,this.getRiskSettings(),prior.sku,slot.index).slice(0,2000));
    }
  }
  getCopyReviewSettings(){this.ensureOpen();return readCopyReviewSettings(this.db);}
  saveCopyReviewSettings(raw:unknown){
    this.ensureOpen();if(this.busy)throw new UserFacingError('请先暂停当前自动图片流程，再切换文案复核');
    const previous=this.getCopyReviewSettings(),value=writeCopyReviewSettings(this.db,raw);
    if(previous.enabled!==value.enabled)this.store.recordWorkspaceEvent('listing.copy-review.changed',value.enabled?'已开启文案复核':'已关闭文案复核；继续生成必要字段，保留首图无字检查',{enabled:value.enabled});return value;
  }
  isCopyReviewPolicyCompatible(run:ImageWorkflowRun|null|undefined):boolean{return copyReviewPolicyCompatible(run,this.getCopyReviewSettings().enabled);}
  /** Read-only recovery proof for automatic tasks interrupted after a copy repair. */
  canResumeRecheckDraft(input:{draftId:string;draftRevision:number;sourceWorkflowId:string}):boolean {
    this.ensureOpen();if(this.busy)return false;
    const draft=this.amazon.getDraft(input.draftId),runs=workflowRuns(this.db,input.draftId),target=this.amazon.executionTargetScope(draft.targetId);
    if(draft.revision!==input.draftRevision||!target.target.configured||target.target.paused)return false;
    const product=this.store.getProduct(draft.productId);
    return hasRecordedRecheckDraft({draft,product,targetGeneration:target.generation,context:this.currentContext(draft,product,target.generation),
      run:runs[0],source:runs.find(run=>run.id===input.sourceWorkflowId),getResult:id=>this.ai.getResult(id),getCall:id=>this.ai.getCall(id)});
  }

  private retryReason(run:ImageWorkflowRun,index:number):string {
    const slot=run.slots?.[index-1],last=slot?.attempts.at(-1);
    if(retryHistoryGap(this.db,run))return '旧备份早于后续付费尝试，请核对保留历史';
    if(run.contentPreparation?.state==='STARTED')return '先核对原文案请求';
    if(!slot||slot.status==='PASSED')return '已通过图位保留';
    if(run.slots?.some(s=>s.status==='BLOCKED'||s.attempts.some(a=>['UNKNOWN','GENERATING'].includes(a.state))))return '先核对进行中、未知请求或风险阻断';
    if(planningRetryExhausted(this.db,run,index))return '';
    if(slot.status!=='FAILED'||last?.state!=='RETRYABLE_FAILURE')return '不是明确失败图位';
    if(slot.attempts.length<imageSlotAttemptLimit(run,index))return '现有额度尚未耗尽';
    if(last.candidateId)return candidateRetryEvidence(run,index,last,this.getRiskSettings(),id=>this.ai.getResult(id))?'':'已有候选须优先核对或复核，风险不确定不能补额放行';
    if(!last.planResultId||this.ai.getResult(last.planResultId)?.output.kind!=='image-plan')return '原有效规划缺失，请先恢复原规划响应';
    if(last.failureProof?.kind==='provider-definitive')return '';
    const audit=this.db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed' AND json_extract(detail_json,'$.productId')=? AND json_extract(detail_json,'$.requestId')=? ORDER BY rowid DESC LIMIT 1").get(run.productId,last.requestId);
    if(audit){const evidence=JSON.parse(String(audit.detail_json));if(evidence.version===1&&evidence.productId===run.productId&&evidence.stage==='image-generation.request'&&evidence.requestOutcome==='DEFINITIVE_FAILURE'&&[400,401,402,403,404,405,413,415,422,429].includes(evidence.httpStatus))return '';}
    const receipt=this.db.prepare("SELECT record_json FROM ai_provider_receipts WHERE json_extract(record_json,'$.callId')=? ORDER BY rowid DESC LIMIT 1").get(last.requestId);
    const intent=this.db.prepare('SELECT record_json FROM ai_image_requests WHERE id=?').get(last.requestId);
    if(receipt&&intent){const r=JSON.parse(String(receipt.record_json)),i=JSON.parse(String(intent.record_json));if(i.productId===run.productId&&i.productRevision===run.productRevision&&[400,401,402,403,404,405,413,415,422,429].includes(r.status))return '';}
    return '旧失败缺少明确远端拒绝证据，先核对原请求';
  }
  private retryStatus(run:ImageWorkflowRun):NonNullable<ImageWorkflowProgress['retryAllowanceStatus']> {
    const gap=retryHistoryGap(this.db,run);
    return (run.slots??[]).map(slot=>{const reason=this.retryReason(run,slot.index);return {scope:slot.attempts.at(-1)?.state==='PLANNING'?'planning' as const:'generation' as const,slot:slot.index,manual:!reason,automatic:!reason&&historicalRetryEligible(this.db,run,slot.index),reason,...(gap?.slot===slot.index?{retainedAttempts:structuredClone(gap.savedAttempts)}:{})};});
  }
  hasHistoricalRetryAllowance(draftId:string):boolean {const run=this.getProgress(draftId);return !!run&&this.retryStatus(run).some(s=>s.automatic);}
  private async applyRetry(run:ImageWorkflowRun,index:number,commandId:string,mode:'manual'|'historical'):Promise<void> {
    const reason=this.retryReason(run,index);if(reason)throw new UserFacingError(reason);
    const slot=run.slots![index-1],last=slot.attempts.at(-1)!;
    if(planningRetryExhausted(this.db,run,index)){transaction(this.db,()=>{grantImageRetry(this.db,run,index,commandId,mode,'planning');this.save(run);});return;}
    let recovered:GeneratedImageCandidate|null=null;
    try{if(!last.candidateId)recovered=await this.generation.reconcileWorkflowGeneration(last.requestId);}catch(error){if(!(error instanceof AiError&&'definitive' in error&&error.definitive===true))throw error;}
    if(recovered){if(recovered.id!==last.requestId||recovered.productId!==run.productId||recovered.productRevision!==run.productRevision)throw new AiError('SOURCE_CHANGED');last.candidateId=recovered.id;last.state='GENERATED';last.error=null;delete last.failureProof;slot.status='PENDING';slot.error=null;this.save(run);return;}
    transaction(this.db,()=>{grantImageRetry(this.db,run,index,commandId,mode);this.save(run);});
  }
  /** Explicit local command adds capacity only. It never continues or sends a paid request. */
  async addRetryAllowance(raw:unknown):Promise<ImageWorkflowRun> {
    this.ensureOpen();const input=keys(raw,['draftId','slot','requestId','commandId']),draftId=uuid(input.draftId),index=integer(input.slot,1,7),requestId=uuid(input.requestId),commandId=uuid(input.commandId);
    const existing=retryGrants(this.db).find(g=>g.id===commandId),run=this.getProgress(draftId);
    if(existing){if(existing.draftId!==draftId||existing.slot!==index||existing.requestId!==requestId||existing.mode!=='manual')throw new UserFacingError('追加命令身份不一致');if(!run)throw new UserFacingError('原图片历史不存在');return run;}
    if(this.busy)throw new UserFacingError('请先暂停图片任务，再追加额度');
    if(!run||run.slots?.[index-1]?.attempts.at(-1)?.requestId!==requestId||this.amazon.getDraft(draftId).submittedAt)throw new UserFacingError('图位历史已变化，请刷新后重试');
    this.retryPending=true;try{await this.applyRetry(run,index,commandId,'manual');return structuredClone(run);}finally{this.retryPending=false;}
  }
  private async applyHistoricalRetries(run:ImageWorkflowRun,selectedSlots?:number[]):Promise<void> {
    for(const slot of run.slots??[])if((!selectedSlots||selectedSlots.includes(slot.index))&&!this.retryReason(run,slot.index)&&historicalRetryEligible(this.db,run,slot.index))await this.applyRetry(run,slot.index,retryCommandId(),'historical');
  }
  async approveUnknownRetry(raw:unknown):Promise<ImageWorkflowRun>{
    this.ensureOpen();if(this.busy)throw new UserFacingError('请先暂停自动任务，再处理未知生图结果');
    const input=keys(raw,['draftId','slot','requestId']),draftId=uuid(input.draftId),index=integer(input.slot,1,7),requestId=uuid(input.requestId);
    const before=this.getProgress(draftId),draft=this.amazon.getDraft(draftId),old=before?.slots?.[index-1]?.attempts.at(-1);
    if(!before||!old||old.requestId!==requestId||old.state!=='UNKNOWN'||draft.submittedAt)throw new UserFacingError('未知生图记录已变化，请刷新后处理');
    const recovered=await this.generation.reconcileWorkflowGeneration(requestId);
    const run=this.getProgress(draftId),slot=run?.slots?.[index-1],attempt=slot?.attempts.at(-1);
    if(this.busy||!run||run.updatedAt!==before.updatedAt||!slot||!attempt||attempt.requestId!==requestId||attempt.state!=='UNKNOWN')throw new UserFacingError('未知生图记录已变化，请刷新后处理');
    if(recovered){if(recovered.productId!==run.productId||recovered.productRevision!==run.productRevision)throw new AiError('SOURCE_CHANGED');attempt.candidateId=recovered.id;attempt.state='GENERATED';attempt.error=null;}
    else{
      if(slot.attempts.length>=imageSlotAttemptLimit(run,slot.index))throw new UserFacingError('该图片已用完尝试次数，请先核对服务商生成记录或导入已有图片');
      throw new UserFacingError('原生图结果仍未知；保留原请求和次数，请核对原响应或导入已有图片，不会重新发送');
    }
    slot.status='PENDING';slot.error=null;run.status='INTERRUPTED';run.error='已核对未知结果，等待继续任务';
    this.db.exec('BEGIN IMMEDIATE');try{this.save(run);appendAuditEvent(this.db,randomUUID(),run.productId,'image.workflow.unknown-result-recovered',`${run.sku} 图片 ${index} 找回本地候选，不重新生成`,JSON.stringify({workflowId:run.id,slot:index,requestId,recoveredCandidateId:recovered?.id??null}),new Date().toISOString());this.db.exec('COMMIT');}catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
    return structuredClone(run);
  }
  private derivePartialSource(prior:ImageWorkflowRun,draft:AmazonDraft):ImageWorkflowRun{
    if(hasSevenApprovedImages(prior))return prior;
    const riskModeBlock=partialRiskModeBlocker(prior,this.getRiskSettings().enabled);if(riskModeBlock)throw new UserFacingError(riskModeBlock);
    const product=this.store.getProduct(draft.productId);
    if(!currentImageAdaptation(this.db,prior,draft,product))throw new UserFacingError('来源已变化，请先显式适配；已完成图位和原请求保持不变');
    const blocked=partialSourceBlocker(prior);if(blocked)throw new UserFacingError(blocked);
    if(this.getCopyReviewSettings().enabled)throw new UserFacingError('文案复核设置已变化，保留原图待对应内容复核');
    const snapshot=currentImageListingSnapshot(draft,this.currentContext(draft,product,this.amazon.executionTargetScope(draft.targetId).generation));
    const now=new Date().toISOString(),derivationRunId=randomUUID(),base=validateProductImageContext({...structuredClone(prior.imageContext!),listing:snapshot.context,currentListingCopy:snapshot.currentListingCopy,listingReviewResultId:null,copyReviewBypass:{policy:'copy-review-disabled/v1',at:now,contextSha256:listingFingerprint(snapshot.context),copySha256:listingFingerprint(snapshot.currentListingCopy)}});
    const run:ImageWorkflowRun={...structuredClone(prior),id:derivationRunId,productRevision:product.revision,createdAt:now,updatedAt:now,status:'INTERRUPTED',error:prior.error,imageContext:base,contextSha256:listingFingerprint(base),draftSha256:imageWorkflowDraftStamp(draft),imageRecipeSha256:listingFingerprint(draft.salesPlan?.recipe??null),sourceReuse:{derivationRunId,sourceRunId:prior.id,sourceRunHash:workflowHash(prior),sourceProductRevision:prior.productRevision,sourceContext:structuredClone(prior.imageContext!),slotAttempts:prior.slots!.map(slot=>slot.attempts.length),slotContexts:prior.slots!.map(slot=>slot.contextSha256)}};
    for(const slot of run.slots!)if(!slot.attempts.length)slot.contextSha256=null;
    delete run.rejection;delete run.policyReevaluation;
    this.db.exec('BEGIN IMMEDIATE');try{
      if(workflowHash(this.getProgress(draft.id)!)!==workflowHash(prior)||!currentImageAdaptation(this.db,prior,this.amazon.getDraft(draft.id),this.store.getProduct(draft.productId)))throw new UserFacingError('图片派生期间来源或检查点发生变化');
      this.save(run);appendAuditEvent(this.db,randomUUID(),product.id,'image.workflow.partial-source-derived','成本变化后接续未完成图位；原上下文、已通过图片及尝试前缀保留',JSON.stringify({sourceRunId:prior.id,workflowId:run.id,sourceRunHash:workflowHash(prior),productRevision:product.revision,contextSha256:run.contextSha256}),now);this.db.exec('COMMIT');
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
    return run;
  }
  getProgress(rawId: unknown): ImageWorkflowRun | null { this.ensureOpen(); return workflowRuns(this.db, uuid(rawId))[0] ?? null; }
  getProgressPresentation(rawId:unknown):ImageWorkflowProgress|null {
    const run=this.getProgress(rawId);if(!run)return null;
    let resultUnknown=false;
    if(run.contentPreparation?.operationId){
      const journal=new CompletionJournal(this.db,this.directory),operation=journal.get(run.contentPreparation.operationId),owner=operation.safetyIdentity;
      if(operation.draftId!==run.draftId||owner.productId!==run.productId||owner.productRevision!==run.productRevision||owner.variantId!==run.variantId||owner.sku!==run.sku)throw new UserFacingError('字段请求进度归属不一致，请核对已有记录');
      resultUnknown=journal.unknown(operation.id);
    }else if(run.contentPreparation?.state==='STARTED')resultUnknown=true;
    const riskEvidence=(run.slots??[]).flatMap(slot=>{const id=slot.attempts.at(-1)?.ipReviewResultId,ip=id?this.ai.getResult(id):undefined;return ip?.output.kind==='image-ip-review'?[{slot:slot.index,summary:describeImageRisk(ip.output,this.getRiskSettings(),run.sku,slot.index)}]:[];});
    const sourceId=run.setPlanResultId??run.planResultIds.at(-1),source=sourceId?this.ai.getResult(sourceId):undefined;
    const sourceRiskSummary=source?.output.kind==='image-plan'&&source.output.ipRisk?`来源 AI 初筛 · SKU ${run.sku} · 原结论 ${source.output.ipRisk.verdict}（非阿里云等级，无数值评分）：${source.output.ipRisk.findings.map(item=>`${item.name}：${item.evidence}`).join('；')||'未报告明确风险'}${run.riskInterceptionEnabled===false?'；当时风险拦截关闭，不计审核通过':''}`:undefined;
    return {...run,retryAllowanceStatus:this.retryStatus(run),sourceTrace:imageSourceTrace(run,id=>this.ai.getResult(id),id=>this.ai.getCall(id)),resultUnknown,riskEvidence,...(sourceRiskSummary?{sourceRiskSummary}:{})};
  }
  /** Local, bounded proof. A workflow status alone is never a rule rejection. */
  async getRuleFilterEvidence(rawId:string):Promise<AutomaticRuleEvidence|null> {
    this.ensureOpen();const draftId=uuid(rawId);
    try{
      if(this.active.has(draftId)||!this.getRiskSettings().enabled)return null;
      const draft=this.amazon.getDraft(draftId),run=this.getProgress(draftId),base=run?.imageContext;
      if(!run||!base||run.status==='RUNNING'||run.contentPreparation?.state==='STARTED'||run.slots?.some(slot=>slot.status==='UNKNOWN'||slot.attempts.some(a=>['UNKNOWN','GENERATING'].includes(a.state)))
        ||run.riskInterceptionEnabled===false||run.imagePolicyVersion!==PRODUCT_IMAGE_POLICY_VERSION||!this.isRiskPolicyCompatible(run)||draft.submittedAt||!['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(draft.state)
        ||run.draftId!==draft.id||run.productId!==draft.productId||run.productRevision!==draft.productRevision||run.variantId!==draft.variantId||run.sku!==draft.sku
        ||base.listing.draftRevision!==draft.revision||run.draftSha256!==imageWorkflowDraftStamp(draft)||!compatibleApprovalRecipe(run,draft.salesPlan?.recipe??null)||!this.currentContextMatches(run,draft))return null;
      const product=this.store.getProduct(draft.productId),target=this.amazon.executionTargetScope(draft.targetId);
      if(product.revision!==run.productRevision||!target.target.configured||target.target.paused||target.generation!==base.listing.targetGeneration
        ||base.listing.targetId!==draft.targetId||base.listing.marketplaceId!==draft.marketplaceId
        ||listingFingerprint(imageRiskSourceSnapshot(product,draft.variantId))!==listingFingerprint(base.ipSource)
        ||listingFingerprint(currentSourceImageMeasurements(this.db,draft))!==listingFingerprint(base.sourceMeasurements??[]))return null;
      const confirmed=(id:string,variant:string)=>!!this.db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(id,variant);
      const saved=this.db.prepare("SELECT record_json FROM image_workflow_runs WHERE json_extract(record_json,'$.productId')=? LIMIT 1001").all(product.id);
      if(saved.length>1000)return null;
      const derived=new Set(saved.map(value=>validateStoredImageWorkflowRun(JSON.parse(String(value.record_json)))).flatMap(value=>value.slots?.flatMap(slot=>slot.approvedAssetId?[slot.approvedAssetId]:[])??(value.approvedAssetId?[value.approvedAssetId]:[])));
      const variants=[...new Set(draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId])];
      const refs=selectImageReferences(product,draft.variantId,derived,confirmed,allowSourceUnbound(product,readSourceImageReceipt(this.db,product.id)),variants,run.slotPolicy===IMAGE_SET_POLICY?10:undefined);
      const references=refs.map(ref=>({id:ref.id,sha256:this.store.getAssetRecord(ref.id)!.sha256}));
      if(listingFingerprint(references)!==listingFingerprint(run.referenceAssets)||listingFingerprint(variants)!==listingFingerprint(base.sourceVariantIds??[draft.variantId]))return null;
      const successful=(result:AiResult|undefined,context:ProductImageContext)=>{
        const call=result&&this.ai.getCall(result.callId);
        return !!result&&!!call&&resultHasOwner(result,call)
          &&result.productId===run.productId&&result.productRevision===run.productRevision&&result.variantId===run.variantId
          &&result.createdAt>=run.createdAt&&result.createdAt<=run.updatedAt&&result.sourceSha256===listingFingerprint(context)&&listingFingerprint(result.imageContext)===listingFingerprint(context);
      };
      let proof:AutomaticRuleEvidence|null=null;
      const resultProof=(result:AiResult,context:ProductImageContext,planResultId:string,candidateId:string|null,message:string):AutomaticRuleEvidence=>({kind:candidateId?'IP_IMAGE_BLOCKED':'IP_PLAN_BLOCKED',workflowId:run.id,resultId:result.id,callId:result.callId,planResultId,candidateId,contextSha256:listingFingerprint(context),draftRevision:draft.revision,references,policyVersion:PRODUCT_IMAGE_POLICY_VERSION,message:message.slice(0,2000)});
      const planProof=(id:string|undefined,context:ProductImageContext)=>{
        const plan=id?this.ai.getResult(id):undefined;
        if(!successful(plan,context)||plan?.output.kind!=='image-plan'||plan.output.ipRisk?.verdict!=='BLOCKED')return null;
        assertImagePlan(plan.output,context);
        return resultProof(plan,context,plan.id,null,'来源图片触发已启用的 IP 风险规则：'+plan.output.ipRisk.findings.map(f=>f.name+'：'+f.evidence).join('；'));
      };
      proof=planProof(run.setPlanResultId,base);
      for(const slot of run.slots??[]){
        if(proof)break;
        const attempt=slot.attempts.at(-1);if(!attempt)continue;
        const context=validateProductImageContext({...base,...(run.setPlan?{setPlan:run.setPlan}:{}),purpose:slot.purpose,slot:{index:slot.index,total:7,provisional:true}});
        if(slot.contextSha256!==listingFingerprint(context))continue;
        proof=planProof(attempt.planResultId??undefined,context);if(proof)break;
        const plan=attempt.planResultId?this.ai.getResult(attempt.planResultId):undefined,ip=attempt.ipReviewResultId?this.ai.getResult(attempt.ipReviewResultId):undefined;
        if(!successful(plan,context)||plan?.output.kind!=='image-plan'||!successful(ip,context)||ip?.output.kind!=='image-ip-review'||evaluateImageRisk(ip.output,this.getRiskSettings()).verdict!=='BLOCKED'
          ||ip.output.planResultId!==plan.id||ip.output.candidate.id!==attempt.candidateId||!attempt.candidateId)continue;
        const local=await this.generation.readCandidate(attempt.candidateId),candidate=local.candidate;
        if(candidate.id!==attempt.candidateId||candidate.productId!==run.productId||candidate.productRevision!==run.productRevision||candidate.mode!=='edit'||listingFingerprint(candidate.sourceAssets)!==listingFingerprint(references)
          ||digest(local.bytes)!==candidate.sha256||listingFingerprint({id:candidate.id,sha256:candidate.sha256,width:candidate.width,height:candidate.height})!==listingFingerprint(ip.output.candidate))continue;
        proof=resultProof(ip,context,plan.id,candidate.id,'生成图阿里云检测触发当前 IP 风险规则：'+ip.output.labels.map(label=>label.description||label.label).join('；'));
      }
      if(!proof)return null;
      for(const ref of references){const asset=this.store.getAssetRecord(ref.id);if(!asset||asset.productId!==product.id||asset.sha256!==ref.sha256)return null;await readManagedImage(this.directory,asset,new AbortController().signal);}
      if(!this.getRiskSettings().enabled||this.active.has(draftId)||listingFingerprint(this.getProgress(draftId))!==listingFingerprint(run)||listingFingerprint(this.amazon.getDraft(draftId))!==listingFingerprint(draft)
        ||listingFingerprint(this.store.getProduct(product.id))!==listingFingerprint(product)||listingFingerprint(this.amazon.executionTargetScope(draft.targetId))!==listingFingerprint(target))return null;
      return proof;
    }catch{return null;}
  }
  cancel(rawId: unknown): { cancelled: boolean } { this.ensureOpen(); const current = this.active.get(uuid(rawId)); current?.controller.abort(new AiError('CANCELLED')); return { cancelled: Boolean(current) }; }
  cancelSources(rawId: unknown): { cancelled: boolean } { this.ensureOpen(); const current=this.activeSources.get(uuid(rawId));current?.controller.abort(new AiError('CANCELLED'));return {cancelled:Boolean(current)}; }
  cancelAll(): void { for (const operation of [...this.active.values(),...this.activeSources.values()]) operation.controller.abort(new AiError('CANCELLED')); }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.cancelAll(); await Promise.allSettled([...this.active.values(),...this.activeSources.values()].map(a => a.promise)); this.db.close(); }
  prepareSources(raw: unknown): Promise<AutomaticSourcesResult> {
    this.ensureOpen();const input=parseAutomaticSources(raw),scope=listingFingerprint(input),pending=this.activeSources.get(input.productId);
    if(pending?.scope===scope)return pending.promise;
    if(this.busy)throw new UserFacingError('另一个商品正在自动准备，请等待完成');
    const controller=new AbortController();
    const promise=Promise.resolve().then(()=>prepareImageWorkflowSources(this.store,this.db,this.sources,input,controller.signal)).finally(()=>this.activeSources.delete(input.productId));
    this.activeSources.set(input.productId,{scope,controller,promise});return promise;
  }
  // Admission contract: synchronous checks send nothing. Accepted work is deferred
  // so the automatic coordinator can persist its intent before any async work runs.
  inspectApproval(draftId:string):{id:string;sha256:string}[]{this.ensureOpen();const draft=this.amazon.getDraft(draftId);return approvedWorkflowAssets(this.db,draft,this.store.getProduct(draft.productId))??[];}
  complete(raw: unknown, options: {maxImageAttempts?:1|2|3;legacyImageAttempts?:number;selectedSlots?:number[]} = {}): Promise<CompleteAutomaticProductResult> {
    this.ensureOpen(); const input = keys(raw, ['draftId','draftRevision']), draftId = uuid(input.draftId), revision = integer(input.draftRevision,1,Number.MAX_SAFE_INTEGER);
    if(options.selectedSlots&&(!Array.isArray(options.selectedSlots)||!options.selectedSlots.length||options.selectedSlots.some(slot=>!Number.isInteger(slot)||slot<1||slot>7)||new Set(options.selectedSlots).size!==options.selectedSlots.length))throw new UserFacingError('定向图位无效');
    if (this.active.has(draftId)) {
      if(options.selectedSlots)throw new UserFacingError('图片任务正在执行，不能合并其他图位授权');
      const active=this.active.get(draftId)!;
      if(active.operation!=='complete')throw new UserFacingError('当前商品正在复核已有图片，请等待完成');
      return active.promise;
    }
    if (this.busy) throw new UserFacingError('另一个商品正在自动准备，请等待完成');
    const draft = this.amazon.getDraft(draftId);
    this.assertSourceConsistency(draftId);
    if (draft.revision !== revision || draft.productRevision !== this.store.getProduct(draft.productId).revision) throw new AiError('SOURCE_CHANGED');
    if (draft.submittedAt || !['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(draft.state)) throw new UserFacingError('已提交的商品不能重新自动准备');
    let prior = this.getProgress(draftId);
    if(prior&&retryHistoryGap(this.db,prior))throw new UserFacingError('旧备份早于已付费图片尝试，请先核对保留的后续历史；未重复发送');
    if(options.selectedSlots&&(!prior?.setPlan||!prior.imageContext))throw new UserFacingError('尚无完整图片规划，请先接续 SKU 规划');
    if(!prior&&options.legacyImageAttempts!==undefined)options={...options,maxImageAttempts:missingWorkflowBudget(this.db,this.directory,draft,options.legacyImageAttempts)};
    if(prior?.referenceAssets.length){
      const product=this.store.getProduct(draft.productId),allowUnbound=allowSourceUnbound(product,readSourceImageReceipt(this.db,product.id)),variants=draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId];
      for(const ref of prior.referenceAssets){const asset=product.assets.find(a=>a.id===ref.id);
        if(!asset||!(allowUnbound&&!asset.variantIds.length||variants.some(id=>asset.variantIds.includes(id)&&this.db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(asset.id,id))))throw new AiError('SOURCE_CHANGED');
      }
    }
    if(prior?.sourceReuse){const riskModeBlock=partialRiskModeBlocker(prior,this.getRiskSettings().enabled);if(riskModeBlock)throw new UserFacingError(riskModeBlock);}
    if(prior&&(prior.sourceReuse||prior.productRevision!==draft.productRevision)){const results=this.ai.listResults(prior.productId);assertImageWorkflowHistory(this.db,new Map(results.map(result=>[result.id,result])),new Map(results.flatMap(result=>{const call=this.ai.getCall(result.callId);return call?[[call.id,call] as const]:[];})),draft.id);}
    this.assertApprovedRiskPolicy(prior);
    if(prior&&prior.productRevision!==draft.productRevision)prior=this.derivePartialSource(prior,draft);
    if(prior)this.reevaluatePolicy(prior,draft);
    if(prior?.imageContext)this.assertCurrentEvidence(draft,prior.imageContext,prior.setPlan,currentWorkflowPlanIds(prior));
    // Whole-set evidence is indivisible: a slot grant cannot approve paid reviews
    // for the remaining six slots or promote a global policy snapshot.
    const recheckWholeSet=()=>{
      if(options.selectedSlots)throw new UserFacingError('当前需要整套审核策略重新核验，请按SKU预览并确认范围');
      return this.recheck({draftId,draftRevision:revision,sourceWorkflowId:prior!.id});
    };
    if(hasSevenApprovedImages(prior)&&draft.listingProgram==='haul'&&prior!.draftSha256!==imageWorkflowDraftStamp(draft)&&this.currentContextMatches(prior!,draft))return recheckWholeSet();
    if(hasSevenApprovedImages(prior)&&this.canRecheckImageContent(prior!,draft))return recheckWholeSet();
    if(hasSevenApprovedImages(prior)&&this.listing.prepareSourceColors
      &&(nonDeferredImageIssues(draft).some(issue=>issue.attributeNames.includes('color'))||!this.currentContextMatches(prior!,draft)))return recheckWholeSet();
    if(hasSevenApprovedImages(prior)&&(!this.isRiskPolicyCompatible(prior)||!this.isCopyReviewPolicyCompatible(prior)))return recheckWholeSet();
    if(prior?.imageContext?.copyReviewBypass&&prior.status!=='COMPLETED'&&this.getCopyReviewSettings().enabled)throw new UserFacingError('这套未完成图片已跳过文案复核。请先关闭文案复核完成该套图片，再开启并复核已有图片；历史记录和图片均已保留');
    if(prior?.riskInterceptionEnabled===false&&prior.status!=='COMPLETED'&&this.getRiskSettings().enabled)throw new UserFacingError('这套未完成图片是在关闭风险拦截时开始的。请先关闭开关并完成该套图片，再开启并复核已有图片；历史记录和图片均已保留');
    if (hasSevenApprovedImages(prior)) {
      try { approvedWorkflowAsset(this.db, draft, this.store.getProduct(draft.productId)); return Promise.resolve({ draft, aiCalls:0, previewAttempts:0, remaining:remaining(draft), workflow:prior! }); }
      catch { /* Source or copy changed: the explicit preparation action creates a new snapshot. */ }
    }
    // A listing-only rule refresh must not discard already paid partial slots.
    // Preserve every frozen context/attempt; only rebind the mutable run checkpoint
    // after proving source, recipe, current copy and source measurements unchanged.
    if(prior?.slots&&prior.status!=='COMPLETED'&&prior.imageContext&&isFullSchema(prior.imageContext.listing)&&draft.listingProgram==='haul'&&prior.draftSha256!==imageWorkflowDraftStamp(draft)){
      const product=this.store.getProduct(draft.productId),context=this.currentContext(draft,product,this.amazon.executionTargetScope(draft.targetId).generation);
      const snapshot=currentImageListingSnapshot(draft,context),base=prior.imageContext;
      if(imageActualInputsMatch(base,draft,product,snapshot.context,prior.imageRecipeSha256)
        &&imageListingCopyMatches(base.listing,snapshot.context,base.currentListingCopy,snapshot.currentListingCopy)
        &&listingFingerprint(imageRiskSourceSnapshot(product,draft.variantId))===listingFingerprint(base.ipSource)
        &&listingFingerprint(currentSourceImageMeasurements(this.db,draft))===listingFingerprint(base.sourceMeasurements??[])){
        const previous=prior.draftSha256;prior.draftSha256=imageWorkflowDraftStamp(draft);this.save(prior);
        this.store.recordWorkspaceEvent('image.workflow.rule-rebound','业务填报规则更新；继续原图片流程，保留已完成图片、请求与尝试次数',{workflowId:prior.id,draftId:draft.id,previousDraftStamp:previous,draftStamp:prior.draftSha256});
      }
    }
    const now = new Date().toISOString();
    const reusable=prior?.slots&&prior.status!=='COMPLETED'&&prior.productId===draft.productId&&prior.productRevision===draft.productRevision&&prior.variantId===draft.variantId&&prior.sku===draft.sku&&(!prior.draftSha256||prior.draftSha256===imageWorkflowDraftStamp(draft));
    const run: ImageWorkflowRun = reusable?structuredClone(prior!):{ listingEvidenceContractVersion:imageEvidenceVersion(this.currentContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation)),id:randomUUID(),draftId,productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,
      appearanceReviewEnabled:this.getAppearanceReviewSettings().enabled,status:'RUNNING',stage:'content',attempt:0,maxAttempts:integer(options.maxImageAttempts??3,1,3),contextSha256:null,draftSha256:null,referenceAssets:[],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],ipReviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:null,imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION,slotPolicy:IMAGE_SET_POLICY,slots:newSlots(),categoryFieldPolicyVersion:CATEGORY_FIELD_REPAIR_POLICY_VERSION };
    if(!prior&&options.legacyImageAttempts!==undefined)run.legacyImageAttempts=options.legacyImageAttempts;
    if(!this.getRiskSettings().enabled)run.riskInterceptionEnabled=false;
    if(!this.getCopyReviewSettings().enabled)run.copyReviewEnabled=false;
    else if(!run.imageContext?.copyReviewBypass)delete run.copyReviewEnabled;
    if(!run.imageContext)run.listingEvidenceContractVersion=imageEvidenceVersion(this.currentContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation));
    run.status='RUNNING';run.error=null;delete run.rejection;
    this.save(run);
    const controller = new AbortController();
    // Defer until the operation is registered so even immediate cancellation observes it.
    const reuseSource=run.recheckedFromRunId?workflowRuns(this.db,draftId).find(record=>record.id===run.recheckedFromRunId):undefined;
    const promise = Promise.resolve().then(async () => {await this.applyHistoricalRetries(run,options.selectedSlots);if(run.recheckedFromRunId&&!reuseSource)throw new AiError('SOURCE_CHANGED');return this.runSeven(run, draft, controller.signal,reuseSource,options.selectedSlots);}).finally(() => this.active.delete(draftId));
    this.active.set(draftId, {operation:'complete',controller,promise}); return promise;
  }
  /** Internal repair path: review a previously approved image again, with zero generation calls. */
  recheck(raw: unknown): Promise<CompleteAutomaticProductResult> {
    this.ensureOpen();
    const input=keys(raw,['draftId','draftRevision','sourceWorkflowId']),draftId=uuid(input.draftId);
    integer(input.draftRevision,1,Number.MAX_SAFE_INTEGER);uuid(input.sourceWorkflowId);
    this.assertSourceConsistency(draftId);
    if(this.busy)throw new UserFacingError('另一个商品正在准备或复核，请等待完成');
    const controller=new AbortController();
    const promise=Promise.resolve().then(async()=>{
      const reused=await this.tryReuseApproval(draftId,Number(input.draftRevision),String(input.sourceWorkflowId),controller.signal);
      if(reused)return reused;
      throwIfAborted(controller.signal);this.active.delete(draftId);
      return this.recheckWithFreshEvidence(raw);
    }).finally(()=>this.active.delete(draftId));
    this.active.set(draftId,{operation:'recheck',controller,promise});return promise;
  }
  private async tryReuseApproval(draftId:string,revision:number,sourceId:string,signal:AbortSignal):Promise<CompleteAutomaticProductResult|undefined> {
    this.assertSourceConsistency(draftId);
    const runs=workflowRuns(this.db,draftId),requested=runs.find(run=>run.id===sourceId),prior=requested?.approvalReuse?runs.find(run=>run.id===requested.approvalReuse!.sourceRunId):requested;
    const draft=this.amazon.getDraft(draftId),base=prior?.imageContext;
    const originalRecheck=runs[0]?.recheckedFromRunId===prior?.id&&runs[0].status!=='COMPLETED'&&runs[0].draftSha256===imageWorkflowDraftStamp(draft)?runs[0]:undefined;
    if(prior)assertApprovalReviewsResolved(this.db,this.directory,prior,runs,this.ai.listCalls?.(),originalRecheck?.id);
    if(runs[0]?.recheckedFromRunId===prior?.id&&runs[0].status!=='COMPLETED'&&runs[0].reviewRequests?.some(r=>r.version===2&&r.state!=='RESULT_STORED'))return undefined;
    this.assertApprovedRiskPolicy(prior);
    if(prior)this.reevaluatePolicy(prior,draft);
    if(base&&prior)this.assertCurrentEvidence(draft,base,prior.setPlan,currentWorkflowPlanIds(prior));
    if(prior&&this.canRecheckImageContent(prior,draft))return undefined;
    if(this.listing.prepareSourceColors&&nonDeferredImageIssues(draft).some(issue=>issue.attributeNames.includes('color')))return undefined;
    if(!prior||!base||!hasSevenApprovedImages(prior)||!this.isRiskPolicyCompatible(prior)||!this.isCopyReviewPolicyCompatible(prior)||prior.imagePolicyVersion!==PRODUCT_IMAGE_POLICY_VERSION||prior.approvalReuse
      ||draft.revision!==revision||draft.submittedAt||!['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(draft.state)
      ||prior.productId!==draft.productId||prior.productRevision!==draft.productRevision||prior.variantId!==draft.variantId||prior.sku!==draft.sku
      ||!compatibleApprovalRecipe(prior,draft.salesPlan?.recipe??null))return undefined;
    const stamp=imageWorkflowDraftStamp(draft),product=this.store.getProduct(draft.productId),target=this.amazon.executionTargetScope(draft.targetId);
    const previous=runs[0];
    if(previous?.id!==prior.id&&previous?.approvalReuse?.sourceRunId!==prior.id){
      // Only resolved transport failures add no contrary evidence; unresolved requests were checked above.
      const copy=previous?.imageContext?.listingReviewResultId?this.ai.getResult(previous.imageContext.listingReviewResultId):undefined;
      if(!previous?.slots||previous.recheckedFromRunId!==prior.id||!['FAILED','CANCELLED','INTERRUPTED'].includes(previous.status)||previous.stage==='content'
        ||previous.productId!==prior.productId||previous.productRevision!==prior.productRevision||previous.variantId!==prior.variantId||previous.sku!==prior.sku
        ||previous.draftSha256!==stamp||listingFingerprint(previous.referenceAssets)!==listingFingerprint(prior.referenceAssets)
        ||copy?.output.kind!=='listing-current-review'||copy.output.verdict!=='PASS'||this.ai.getCall(copy.callId)?.status!=='SUCCEEDED'
        ||previous.slots.some(slot=>slot.status==='BLOCKED'||slot.attempts.some(attempt=>attempt.state==='BLOCKED'||attempt.candidateId!==null&&attempt.candidateId!==prior.slots![slot.index-1].attempts.at(-1)!.candidateId))
        ||previous.ipReviewResultIds?.some(id=>{const result=this.ai.getResult(id);return result?.output.kind!=='image-ip-review'||evaluateImageRisk(result.output,this.getRiskSettings()).verdict!=='PASS';}))return undefined;
    }
    const compatible=()=>{
      const current=this.amazon.getDraft(draftId),latest=this.store.getProduct(draft.productId),scope=this.amazon.executionTargetScope(draft.targetId);
      if(current.revision!==revision||!compatibleApprovalRecipe(prior,current.salesPlan?.recipe??null)||imageWorkflowDraftStamp(current)!==stamp||latest.revision!==prior.productRevision||scope.target.paused||!scope.target.configured||scope.generation!==target.generation)return false;
      const context=currentImageListingSnapshot(current,this.currentContext(current,latest,scope.generation)).context;
      // The unchanged schema can expose newly supported field metadata; keep the original proof unchanged.
      context.fields=context.fields.filter(field=>base.listing.fields.some(old=>old.name===field.name)||!['theme','subject_character','blade','target_audience'].includes(field.name));
      return imageActualInputsMatch(base,current,latest,context,prior.imageRecipeSha256)
        &&listingFingerprint(imageRiskSourceSnapshot(latest,prior.variantId))===listingFingerprint(base.ipSource)
        &&listingFingerprint(currentSourceImageMeasurements(this.db,current))===listingFingerprint(base.sourceMeasurements??[]);
    };
    if(!compatible())return undefined;
    const confirmed=(id:string,variant:string)=>!!this.db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(id,variant);
    const derived=new Set(workflowRuns(this.db).flatMap(run=>run.slots?.flatMap(slot=>slot.approvedAssetId?[slot.approvedAssetId]:[])??(run.approvedAssetId?[run.approvedAssetId]:[])));
    const sourceVariants=[...new Set(draft.salesPlan?.recipe.components.map(component=>component.variantId)??[prior.variantId])];
    if(listingFingerprint(sourceVariants)!==listingFingerprint(base.sourceVariantIds??[prior.variantId]))return undefined;
    const references=selectImageReferences(product,prior.variantId,derived,confirmed,allowSourceUnbound(product,readSourceImageReceipt(this.db,product.id)),sourceVariants,prior.slotPolicy===IMAGE_SET_POLICY?10:undefined);
    if(listingFingerprint(references.map(ref=>({id:ref.id,sha256:this.store.getAssetRecord(ref.id)!.sha256})))!==listingFingerprint(prior.referenceAssets))return undefined;
    for(const slot of prior.slots!){
      const attempt=slot.attempts.at(-1)!,ip=attempt.ipReviewResultId?this.ai.getResult(attempt.ipReviewResultId):undefined;
      const successful=(value:typeof ip)=>{const call=value&&this.ai.getCall(value.callId);return !!value&&resultHasOwner(value,call)&&value.productId===prior.productId&&value.productRevision===prior.productRevision&&value.variantId===prior.variantId&&value.sourceSha256===slot.contextSha256;};
      const plan=attempt.planResultId?this.ai.getResult(attempt.planResultId):undefined;
      if(!successful(plan)||plan?.output.kind!=='image-plan')return undefined;
      const bypass=prior.riskInterceptionEnabled===false&&!this.getRiskSettings().enabled?attempt.riskBypass:undefined;
      if(!bypass&&(!successful(ip)||ip?.output.kind!=='image-ip-review'||evaluateImageRisk(ip.output,this.getRiskSettings()).verdict!=='PASS'||ip.output.planResultId!==attempt.planResultId||ip.output.candidate.id!==attempt.candidateId||ip.output.candidate.sha256!==slot.approvedSha256))return undefined;
      const identity=bypass?.candidate??(ip?.output.kind==='image-ip-review'?ip.output.candidate:undefined);
      if(!identity||identity.id!==attempt.candidateId||identity.sha256!==slot.approvedSha256)return undefined;
      if(slot.index===1){const review=attempt.reviewResultId?this.ai.getResult(attempt.reviewResultId):undefined;
        const ocr=attempt.ocrResultId?this.ai.getResult(attempt.ocrResultId):undefined;
        if(!successful(ocr)||ocr?.output.kind!=='generated-image-ocr'||listingFingerprint(ocr.output.candidate)!==listingFingerprint(identity))return undefined;
        if(!successful(review)||attempt.textReviewPolicyVersion!==IMAGE_TEXT_REVIEW_POLICY_VERSION||review?.output.kind!=='image-text-review'||review.output.verdict!=='PASS'||review.output.noTextVerified!==true||review.output.planResultId!==plan.id||review.output.ocrResultId!==ocr.id||listingFingerprint(review.output.candidate)!==listingFingerprint(identity))return undefined;
      }
    }
    // Actual managed bytes, not only persisted hashes, must still match every approved/source image.
    const assets=[...prior.referenceAssets,...prior.slots!.map(slot=>({id:slot.approvedAssetId!,sha256:slot.approvedSha256!}))];
    for(const ref of assets){throwIfAborted(signal);const asset=this.store.getAssetRecord(ref.id);if(!asset||asset.productId!==prior.productId||asset.sha256!==ref.sha256)throw new AiError('SOURCE_CHANGED');await readManagedImage(this.directory,asset,signal);}
    const assertCurrent=()=>{throwIfAborted(signal);assertApprovalReviewsResolved(this.db,this.directory,prior,workflowRuns(this.db,draftId),this.ai.listCalls?.());if(!compatible()||prior.slots!.some(slot=>!confirmed(slot.approvedAssetId!,prior.variantId))||base.referenceAssets.some(ref=>ref.variantId!==null&&!confirmed(ref.assetId,ref.variantId)))throw new AiError('SOURCE_CHANGED');};
    assertCurrent();
    const latest=workflowRuns(this.db,draftId)[0];
    if(latest?.approvalReuse?.sourceRunId===prior.id&&latest.draftSha256===stamp)return {draft,aiCalls:0,previewAttempts:0,remaining:remaining(draft),workflow:latest};
    const now=new Date(Math.max(Date.now(),Date.parse(prior.updatedAt))).toISOString();
    const run:ImageWorkflowRun={...structuredClone(prior),id:randomUUID(),createdAt:now,updatedAt:now,draftSha256:stamp,approvalReuse:{sourceRunId:prior.id,draftRevision:revision,draftSnapshot:imageApprovalDraftSnapshot(draft),recipeSnapshot:JSON.stringify(draft.salesPlan?.recipe??null)}};
    delete run.reviewRequests;assertApprovalReuseSource(run,prior);
    this.db.exec('BEGIN IMMEDIATE');
    try{assertCurrent();this.save(run);appendAuditEvent(this.db,randomUUID(),run.productId,'image.workflow.approval-reused',`${run.sku} 原图和审核证据未变化，复用七图审核`,JSON.stringify({workflowId:run.id,sourceWorkflowId:prior.id,draftRevision:revision,draftSha256:stamp}),now);this.db.exec('COMMIT');}
    catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
    return {draft,aiCalls:0,previewAttempts:0,remaining:remaining(draft),workflow:run};
  }
  private recheckWithFreshEvidence(raw: unknown): Promise<CompleteAutomaticProductResult> {
    this.ensureOpen();
    const input=keys(raw,['draftId','draftRevision','sourceWorkflowId']),draftId=uuid(input.draftId),revision=integer(input.draftRevision,1,Number.MAX_SAFE_INTEGER);
    if(this.busy)throw new UserFacingError('另一个商品正在准备或复核，请等待完成');
    const runs=workflowRuns(this.db,draftId),prior=runs.find(value=>value.id===uuid(input.sourceWorkflowId)),draft=this.amazon.getDraft(draftId);
    const originalRecheck=runs[0]?.recheckedFromRunId===prior?.id&&runs[0].status!=='COMPLETED'&&runs[0].draftSha256===imageWorkflowDraftStamp(draft)?runs[0]:undefined;
    if(prior)assertApprovalReviewsResolved(this.db,this.directory,prior,runs,this.ai.listCalls?.(),originalRecheck?.id);
    this.assertApprovedRiskPolicy(prior);
    if(prior)this.reevaluatePolicy(prior,draft);
    if(prior)this.assertCurrentEvidence(draft,prior.imageContext,prior.setPlan,currentWorkflowPlanIds(prior));
    if(!prior||prior.status!=='COMPLETED'||prior.imagePolicyVersion!==PRODUCT_IMAGE_POLICY_VERSION||!prior.approvedAssetId||!prior.approvedSha256
      ||prior.productId!==draft.productId||prior.productRevision!==draft.productRevision||prior.variantId!==draft.variantId||prior.sku!==draft.sku
      ||draft.revision!==revision||draft.submittedAt||!['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(draft.state))throw new UserFacingError('原图片审核或当前草稿范围无法用于重新复核');
    const latest=runs[0],sameRecheckScope=latest?.slots&&latest.recheckedFromRunId===prior.id&&latest.productRevision===draft.productRevision
      &&latest.variantId===draft.variantId&&latest.sku===draft.sku&&(!latest.draftSha256||latest.draftSha256===imageWorkflowDraftStamp(draft));
    if(sameRecheckScope&&hasSevenApprovedImages(latest)&&this.isRiskPolicyCompatible(latest)&&this.isCopyReviewPolicyCompatible(latest)
      &&this.currentContextMatches(latest,draft)&&!(this.listing.prepareSourceColors&&nonDeferredImageIssues(draft).some(issue=>issue.attributeNames.includes('color')))){
      approvedWorkflowAsset(this.db,draft,this.store.getProduct(draft.productId));
      return Promise.resolve({draft,aiCalls:0,previewAttempts:0,remaining:remaining(draft),workflow:latest});
    }
    const reusable=sameRecheckScope&&latest.status!=='COMPLETED';
    if(reusable&&latest.imageContext?.copyReviewBypass&&this.getCopyReviewSettings().enabled)throw new UserFacingError('这套未完成图片已跳过文案复核。请先关闭文案复核完成该套图片，再开启并复核已有图片；历史记录和图片均已保留');
    if(reusable&&latest.riskInterceptionEnabled===false&&this.getRiskSettings().enabled)throw new UserFacingError('这套未完成图片是在关闭风险拦截时开始的。请先关闭开关并完成该套图片，再开启并复核已有图片；历史记录和图片均已保留');
    const now=new Date().toISOString(),run:ImageWorkflowRun=reusable?structuredClone(latest):{...prior,id:randomUUID(),status:'RUNNING',stage:'content',attempt:0,maxAttempts:1,contextSha256:null,draftSha256:null,
      referenceAssets:[],planResultIds:[],candidateIds:[],ipReviewResultIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:null,recheckedFromRunId:prior.id};
    if(!reusable)delete run.reviewRequests;
    if(prior.slots&&!reusable){run.slots=newSlots();delete run.imageContext;delete run.sourceReuse;delete run.activeSlot;delete run.copyRepairAttempts;delete run.approvalReuse;delete run.contentPreparation;delete run.copyReviewResultId;delete run.categoryFieldRepair;run.categoryFieldPolicyVersion=CATEGORY_FIELD_REPAIR_POLICY_VERSION;}
    if(prior.slots&&!this.getRiskSettings().enabled)run.riskInterceptionEnabled=false;else delete run.riskInterceptionEnabled;
    if(prior.slots&&!this.getCopyReviewSettings().enabled)run.copyReviewEnabled=false;else delete run.copyReviewEnabled;
    if(!reusable||!run.imageContext)run.listingEvidenceContractVersion=imageEvidenceVersion(this.currentContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation));
    run.status='RUNNING';run.error=null;delete run.rejection;
    this.save(run);const controller=new AbortController();
    const promise=Promise.resolve().then(()=>prior.slots?this.runSeven(run,draft,controller.signal,prior):this.run(run,draft,controller.signal,prior)).finally(()=>this.active.delete(draftId));
    this.active.set(draftId,{operation:'recheck',controller,promise});return promise;
  }
  private async reviewStep(run:ImageWorkflowRun,step:ImageReviewRequestV2['step'],context:ProductImageContext,plan:AiResult,candidate:import('../../shared/image-ai-contracts.ts').CandidateImageIdentity,ocr:AiResult|undefined,send:(owner?:AiDurableRequestPort)=>Promise<AiResult>):Promise<AiResult> {
    if(this.ai.reviewRequestJournalVersion!==2)return this.paid(run.draftId,()=>send());
    const slot=context.slot?.index??0,attempt=run.slots?.[slot-1]?.attempts.at(-1),number=attempt?.number??run.attempt;
    let request=run.reviewRequests?.findLast(r=>r.version===2&&r.slot===slot&&r.attempt===number&&r.step===step&&listingFingerprint(r.candidate)===listingFingerprint(candidate)) as ImageReviewRequestV2|undefined;
    if(!request){
      const profile=step==='text'?this.workflowProfile('deepseek-review'):this.ai.getProfile(step==='risk'?'aliyun-image-risk':'aliyun-ocr'),requestId=randomUUID(),now=new Date(Math.max(Date.now(),Date.parse(run.updatedAt))).toISOString(),kinds=step==='risk'?['token','upload','moderation'] as const:[step];
      request={version:2,requestId,step,runId:run.id,draftId:run.draftId,productId:run.productId,productRevision:run.productRevision,variantId:run.variantId,sku:run.sku,slot,attempt:number,generationRequestId:attempt?.requestId??candidate.id,candidate,planResultId:plan.id,ocrResultId:ocr?.id??null,contextSha256:listingFingerprint(context),requestFingerprint:null,execution:{providerId:profile.id,model:profile.model,generation:profile.generation,purposeSnapshot:profile.routing??null},preparedAt:now,reservedAt:null,state:'PREPARED',resultId:null,effects:kinds.map(kind=>({id:listingFingerprint({requestId,kind}),kind,state:'UNPERMITTED',permittedAt:null,receivedAt:null}))};
      run.reviewRequests??=[];run.reviewRequests.push(request);this.save(run);
    }
    if(request.state==='RECEIVED_INVALID'||request.state==='DEFINITIVE_REJECTION'){const error=new AiError(request.state==='RECEIVED_INVALID'?'OUTPUT_INVALID':'PROVIDER_ERROR');error.callId=request.requestId;error.certainty=request.state==='RECEIVED_INVALID'?'RECEIVED_INVALID':'DEFINITIVE_REJECTION';error.message='原图片审核已收到无效结果或明确拒绝；原响应、次数与费用保留，当前没有追加审核许可';throw error;}
    const id=request.requestId,owner:AiDurableRequestPort={fileId:id,reserve:(db,call)=>reservePreparedImageReview(this.db,db,run.id,call),resultStored:(db,result)=>storeImageReviewResult(this.db,db,run.id,result),effect:(db,kind,event,at)=>markImageReviewEffect(this.db,db,run.id,id,kind,event,at)};
    try{return await this.paid(run.draftId,()=>send(owner));}
    finally{transaction(this.db,()=>projectImageReviewOutcome(this.db,this.db,this.directory,run.id,id));const row=this.db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(run.id);if(row){const saved=validateStoredImageWorkflowRun(JSON.parse(String(row.record_json)));run.reviewRequests=saved.reviewRequests;for(const key of ['ipReviewResultIds','ocrResultIds','reviewResultIds'] as const)if(saved[key])run[key]=saved[key];if(run.slots&&saved.slots)for(const [i,s] of run.slots.entries())for(const [j,a] of s.attempts.entries())for(const key of ['ipReviewResultId','ocrResultId','reviewResultId'] as const)if(saved.slots[i]?.attempts[j]?.[key])a[key]=saved.slots[i].attempts[j][key];}}
  }
  private paid<T>(draftId:string,send:()=>Promise<T>):Promise<T>{ this.assertSourceConsistency(draftId);this.amazon.assertPricingForPaid(draftId); return send(); }
  private async runSeven(run:ImageWorkflowRun,initial:AmazonDraft,signal:AbortSignal,reuse?:ImageWorkflowRun,selectedSlots?:number[]):Promise<CompleteAutomaticProductResult>{
    this.assertSourceConsistency(run.draftId);
    let result={draft:initial,aiCalls:0,previewAttempts:0,remaining:remaining(initial)};
    const riskEnabled=run.riskInterceptionEnabled!==false;
    const copyReviewEnabled=this.getCopyReviewSettings().enabled;
    const stage=(value:ImageWorkflowRun['stage'])=>{throwIfAborted(signal);run.stage=value;this.save(run);};
    try{
      throwIfAborted(signal);
      this.reevaluatePolicy(run,initial);
      const cached=run.contentPreparation;
      if(!run.imageContext&&cached?.operationId&&(cached.state==='STARTED'||needsBusinessAuthorityRefresh(initial,cached.remaining)||needsPlainColorRefresh(initial,this.store.getProduct(initial.productId))||this.listing.hasRetainedFieldReferences?.(initial)||this.listing.hasSelectedFirmnessCorrection?.(initial))){
        const op=new CompletionJournal(this.db).get(cached.operationId);
        if(op.state==='DONE'){
          if(cached.state==='DONE'&&(cached.draftRevision!==initial.revision||cached.draftSha256&&cached.draftSha256!==imageWorkflowDraftStamp(initial)))throw new UserFacingError('旧事实恢复对应的草稿已变化，原记录保留');
          // Persist the existing owner's STARTED receipt before the local write.
          // A crash then resumes this same DONE completion, never a fresh budget.
          run.contentPreparation={...cached,state:'STARTED'};this.save(run);
          const refreshed=await this.listing.complete({draftId:initial.id,draftRevision:initial.revision},signal,cached.operationId);
          result={...refreshed,aiCalls:result.aiCalls+refreshed.aiCalls};initial=refreshed.draft;
          run.contentPreparation={...cached,state:'DONE',draftRevision:initial.revision,draftSha256:imageWorkflowDraftStamp(initial),remaining:refreshed.remaining};this.save(run);
          result.remaining=withoutHistoricalPricingRemaining(initial,refreshed.remaining,readListingRules(this.db));
          if(result.remaining.length)throw new UserFacingError(('商品字段尚未修复完成，停止生图：'+result.remaining.join('；')).slice(0,2000));
        }
      }
      if(run.imageContext)this.assertCurrentEvidence(initial,run.imageContext,run.setPlan,currentWorkflowPlanIds(run));
      if(!run.imageContext&&run.contentPreparation?.state!=='STARTED')this.amazon.assertPricingForPaid(initial.id);
      const pricing=pricingBlockingReason(initial,readListingRules(this.db));
      if(pricing){
        // Price changes block new spending, not recovery of a response already paid for.
        for(const slot of run.slots??[]){if(selectedSlots&&!selectedSlots.includes(slot.index))continue;const attempt=slot.attempts.at(-1);if(!attempt||!['GENERATING','UNKNOWN'].includes(attempt.state))continue;
          const candidate=await this.generation.reconcileWorkflowGeneration(attempt.requestId);
          if(candidate){if(candidate.id!==attempt.requestId||candidate.productId!==run.productId||candidate.productRevision!==run.productRevision||listingFingerprint(candidate.sourceAssets)!==listingFingerprint(run.referenceAssets))throw new AiError('SOURCE_CHANGED');attempt.candidateId=candidate.id;attempt.state='GENERATED';attempt.error=null;this.save(run);}
        }
        throw new UserFacingError(pricing);
      }
      const connection=reuse?null:this.generation.getConnection();
      if(!reuse&&(!connection?.configured||!connection.enabled))throw new UserFacingError('请在设置中配置并启用生图服务，然后继续自动准备');
      const generationScope=reuse?null:this.generation.configurationScope(),configStamp=listingFingerprint(connection);
      const profileIds=['deepseek','deepseek-review','aliyun-ocr',...(riskEnabled?['aliyun-image-risk']:[])];
      for(const id of profileIds){const profile=this.workflowProfile(id);if(!profile.configured||!profile.enabled)throw new UserFacingError('请在设置中配置并启用文案、图片侵权检测和 OCR 接口');}
      const profileStamp=listingFingerprint(profileIds.map(id=>this.workflowProfile(id))),product=this.store.getProduct(run.productId);
      const derived=new Set(workflowRuns(this.db).flatMap(record=>record.slots?record.slots.flatMap(slot=>slot.approvedAssetId?[slot.approvedAssetId]:[]):record.approvedAssetId?[record.approvedAssetId]:[]));
      const variantIds=[...new Set(initial.salesPlan?.recipe.components.map(component=>component.variantId)??[run.variantId])];
      const confirmed=(assetId:string,variantId:string)=>Boolean(this.db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(assetId,variantId));
      const referenceProduct=productReferenceImages(product,variantIds.flatMap(variantId=>this.ai.sourceObservationEvidence?.({productId:product.id,productRevision:product.revision,variantId})??[]));
      const refs=selectImageReferences(referenceProduct,run.variantId,derived,confirmed,allowSourceUnbound(product,readSourceImageReceipt(this.db,product.id)),variantIds,run.slotPolicy===IMAGE_SET_POLICY?10:undefined);
      const references=refs.map(ref=>({id:ref.id,sha256:this.store.getAssetRecord(ref.id)!.sha256}));
      if(run.referenceAssets.length&&listingFingerprint(references)!==listingFingerprint(run.referenceAssets))throw new AiError('SOURCE_CHANGED');
      run.referenceAssets=references;this.save(run);
      if(!run.imageContext&&run.contentPreparation?.state==='STARTED'&&!run.contentPreparation.operationId){
        const operation=this.listing.beginCompletion?.({draftId:run.draftId,draftRevision:initial.revision});
        if(!operation)throw new UserFacingError('旧字段准备恢复服务不可用，结果尚未确认，原进度已保留');
        run.contentPreparation.operationId=operation.id;this.save(run);
      }
      let sourceColorEvidenceSha256:string|undefined;
      if(this.listing.prepareSourceColors){
        const prepared=await this.listing.prepareSourceColors({draftId:run.draftId,draftRevision:initial.revision},signal);
        sourceColorEvidenceSha256=prepared.evidenceSha256;
        result.aiCalls+=prepared.aiCalls;throwIfAborted(signal);
      }
      if(run.imageContext&&!this.currentContextMatches(run,initial))throw new UserFacingError('来源颜色证据已变化，原图片上下文与已付费请求已保留；请复核现有图片，不能替换未完成的规划');
      if(!run.imageContext){
        if(run.contentPreparation?.draftRevision===initial.revision)result.remaining=run.contentPreparation.remaining;
        result.remaining=withoutHistoricalPricingRemaining(result.draft,result.remaining,readListingRules(this.db));
        const cachedCopy=()=>{
          const draft=this.amazon.getDraft(run.draftId),snapshot=currentImageListingSnapshot(draft,this.currentContext(draft,this.store.getProduct(run.productId),this.amazon.executionTargetScope(draft.targetId).generation));
          const candidates=this.ai.listResults(run.productId).filter(value=>value.output.kind==='listing-current-review'&&value.listingContext&&listingFingerprint(value.listingContext)===listingFingerprint(snapshot.context)&&listingFingerprint(value.output.currentListingCopy)===listingFingerprint(snapshot.currentListingCopy)&&this.ai.getCall(value.callId)?.status==='SUCCEEDED');
          const saved=candidates.at(-1);
          if(saved?.output.kind==='listing-current-review')assertCurrentListingReview({...saved.output,kind:'amazon-fields-review'},snapshot.currentListingCopy,snapshot.context);
          return saved&&!this.ai.hasPendingCopyReview?.(saved.id)?{context:snapshot.context,currentListingCopy:snapshot.currentListingCopy,review:saved}:undefined;
        };
        let copy=copyReviewEnabled?cachedCopy():undefined;
        const colorPending=nonDeferredImageIssues(initial).some(issue=>issue.attributeNames.includes('color'))
          ||run.contentPreparation?.remaining.some(message=>/\bcolor\b|颜色/i.test(message));
        const changedColorEvidence=!!sourceColorEvidenceSha256&&colorPending
          &&sourceColorEvidenceSha256!==(run.contentPreparation?.sourceColorEvidenceSha256??reuse?.contentPreparation?.sourceColorEvidenceSha256);
        const policyUpgrade=!!run.policyReevaluation&&!run.policyReevaluation.repairStarted&&run.policyReevaluation.previousRemaining.length>0&&run.contentPreparation?.state==='DONE'&&result.remaining.length>0;
        const categoryFields=categoryRepairFields(initial,run.contentPreparation?.remaining??reuse?.contentPreparation?.remaining);
        const categoryUpgrade=categoryFields.length>0&&this.canRecheckImageContent(reuse??run,initial,run.contentPreparation?.remaining??reuse?.contentPreparation?.remaining)
          &&(!!reuse||run.contentPreparation?.state==='DONE'&&run.contentPreparation.draftRevision===initial.revision);
        if(copyReviewEnabled&&!copy&&(run.copyRepairAttempts??0)>=2&&!categoryUpgrade&&!policyUpgrade)throw new UserFacingError('当前文案已用完两轮自动修复，保留失败原因与进度，请检查文案事实后再处理');
        if(run.contentPreparation?.state==='STARTED'||(!reuse||changedColorEvidence||categoryUpgrade||policyUpgrade)&&(!copyReviewEnabled||!(run.copyRepairAttempts??0)||categoryUpgrade||policyUpgrade)&&(!copy||withoutDeferredImageRemaining(result.draft,result.remaining).length)){
          const migratedFields=legacyContentRepairFields(run.contentPreparation,initial,product);
          const changedCopyPolicy=!copyReviewEnabled&&run.contentPreparation?.copyReviewEnabled!==false&&!!run.contentPreparation?.remaining.length;
          if(run.contentPreparation?.state!=='STARTED'&&run.contentPreparation?.draftRevision===initial.revision&&!migratedFields.length&&!changedCopyPolicy&&!changedColorEvidence&&!categoryUpgrade&&!policyUpgrade){result.remaining=run.contentPreparation.remaining;}
          else{
            const colorEvidence=sourceColorEvidenceSha256??run.contentPreparation?.sourceColorEvidenceSha256;
            run.categoryFieldPolicyVersion=CATEGORY_FIELD_REPAIR_POLICY_VERSION;
            if(categoryUpgrade)run.categoryFieldRepair={version:CATEGORY_FIELD_REPAIR_POLICY_VERSION,grantedAttempts:1,grantedAt:new Date().toISOString(),fields:categoryFields};
            if(run.contentPreparation?.state!=='STARTED')this.amazon.assertPricingForPaid(run.draftId);
            const operationId=run.contentPreparation?.state==='STARTED'?run.contentPreparation.operationId:this.listing.beginCompletion?.({draftId:run.draftId,draftRevision:initial.revision},policyUpgrade?run.contentPreparation?.operationId:undefined).id;
            if(policyUpgrade&&run.policyReevaluation)run.policyReevaluation.repairStarted=true;
            run.contentPreparation={...(operationId?{operationId}:{}),state:'STARTED',draftRevision:initial.revision,remaining:[],repairPolicyVersion:FIELD_REPAIR_POLICY_VERSION,...(colorEvidence?{sourceColorEvidenceSha256:colorEvidence}:{}),...(!copyReviewEnabled?{copyReviewEnabled:false}:{})};this.save(run);
            if(migratedFields.length)this.store.recordWorkspaceEvent('image.content-repair.policy-migrated',`${run.sku} 使用新增字段支持再修复一次`,{workflowId:run.id,fields:migratedFields,version:FIELD_REPAIR_POLICY_VERSION});
            const prepared=await this.listing.complete({draftId:run.draftId,draftRevision:initial.revision},signal,operationId);
            result={...prepared,aiCalls:result.aiCalls+prepared.aiCalls};
            run.contentPreparation={...(operationId?{operationId}:{}),state:'DONE',draftRevision:result.draft.revision,draftSha256:imageWorkflowDraftStamp(result.draft),remaining:result.remaining.slice(0,100).map(value=>value.slice(0,2000)),repairPolicyVersion:FIELD_REPAIR_POLICY_VERSION,...(colorEvidence?{sourceColorEvidenceSha256:colorEvidence}:{}),...(!copyReviewEnabled?{copyReviewEnabled:false}:{})};this.save(run);
            const currentPolicyContext=this.listing.currentAuthorizationContext?.(result.draft,this.store.getProduct(run.productId),this.amazon.executionTargetScope(result.draft.targetId).generation)??this.currentContext(result.draft,this.store.getProduct(run.productId),this.amazon.executionTargetScope(result.draft.targetId).generation);
            if(this.listing.currentContext&&isFullSchema(currentPolicyContext)){run.policyReevaluation={version:LOCAL_LISTING_POLICY,inputSha256:listingFingerprint({context:currentPolicyContext,draftStamp:imageWorkflowDraftStamp(result.draft)}),at:new Date().toISOString(),previousRemaining:run.policyReevaluation?.previousRemaining??[],repairStarted:true};this.save(run);}
            copy=copyReviewEnabled?cachedCopy():undefined;
          }
        }
        const pricingRules=readListingRules(this.db);
        result.remaining=withoutDeferredImageRemaining(result.draft,withoutHistoricalPricingRemaining(result.draft,result.remaining,pricingRules));
        const pricingAfter=pricingBlockingReason(result.draft,pricingRules);if(pricingAfter)throw new UserFacingError(pricingAfter);
        if(result.remaining.length)throw new UserFacingError(('商品字段尚未修复完成，停止生图：'+result.remaining.join('；')).slice(0,2000));
        if(copyReviewEnabled){
        if(!copy){copy=await this.listing.reviewCurrentForImages({draftId:run.draftId,draftRevision:result.draft.revision},signal);result.aiCalls++;}
        run.copyReviewResultId=copy.review.id;this.save(run);
        let feedbackResultId:string|undefined;
        while(copy.review.output.kind==='listing-current-review'&&copy.review.output.verdict==='NEEDS_CHANGES'&&(run.copyRepairAttempts??0)<2&&this.listing.repairCurrentForImages){
          run.copyRepairAttempts=(run.copyRepairAttempts??0)+1;this.save(run);
          const repair=await this.listing.repairCurrentForImages({draftId:run.draftId,draftRevision:result.draft.revision,reviewResultId:copy.review.id,...(feedbackResultId?{feedbackResultId}:{})},signal);
          result.draft=repair.draft;result.aiCalls+=repair.aiCalls;result.remaining=repair.remaining;
          feedbackResultId=repair.feedbackResultId;
          if(repair.review){copy=repair.review;feedbackResultId=undefined;run.copyReviewResultId=copy.review.id;this.save(run);}
          if(repair.blocked)break;
        }
        if(copy.review.output.kind!=='listing-current-review'||copy.review.output.verdict!=='PASS')throw new UserFacingError(('商品文案复核未通过，已停止后续生图'+(result.remaining.length?'：'+result.remaining.join('；'):'' )).slice(0,2000));
        }
        if(!copyReviewEnabled&&!this.listing.snapshotCurrentForImages)throw new UserFacingError('文案快照服务尚未初始化');
        const snapshot=copyReviewEnabled?copy!:await this.listing.snapshotCurrentForImages!({draftId:run.draftId,draftRevision:result.draft.revision},signal);
        const bypass=copyReviewEnabled?undefined:{policy:'copy-review-disabled/v1' as const,at:new Date().toISOString(),contextSha256:listingFingerprint(snapshot.context),copySha256:listingFingerprint(snapshot.currentListingCopy)};
        const base=validateProductImageContext({listing:snapshot.context,currentListingCopy:snapshot.currentListingCopy,listingReviewResultId:copyReviewEnabled?copy!.review.id:null,...(bypass?{copyReviewBypass:bypass}:{}),referenceAssets:references.map(ref=>({...(isProductReference(this.db,product.id,run.variantId,ref.id)?{scope:'product' as const}:{}),assetId:ref.id,sha256:ref.sha256,variantId:variantIds.find(id=>refs.find(asset=>asset.id===ref.id)!.variantIds.includes(id)&&confirmed(ref.id,id))??null})),purpose:'main',policyVersion:PRODUCT_IMAGE_POLICY_VERSION,ipSource:imageRiskSourceSnapshot(product,run.variantId),sourceVariantIds:variantIds});
        if(run.slotPolicy===IMAGE_SET_POLICY){
          base.setPolicy=IMAGE_SET_POLICY;base.referenceMeasurements=reuse?.imageContext?.referenceMeasurements??[];base.sourceMeasurements=currentSourceImageMeasurements(this.db,result.draft);
          if(!reuse&&!sourceDimensionEvidence(base).length){
            stage('planning');
            for(const ref of references){
              throwIfAborted(signal);
              const previous=this.ai.listResults(run.productId).findLast(value=>value.output.kind==='ocr'&&value.productRevision===run.productRevision&&value.assetId===ref.id&&value.assetSha256===ref.sha256&&this.ai.getCall(value.callId)?.status==='SUCCEEDED');
              const ocr=previous??await this.paid(run.draftId,()=>this.ai.recognize({productId:run.productId,productRevision:run.productRevision,assetId:ref.id},signal,()=>{this.assertSourceConsistency(run.draftId);this.amazon.assertPricingForPaid(run.draftId);}));
              if(!previous)result.aiCalls++;
              base.referenceMeasurements.push(...referenceMeasurementEvidence(ocr));
            }
          }
        }
        run.imageContext=validateProductImageContext(base);
        run.listingEvidenceContractVersion=imageEvidenceVersion(run.imageContext.listing);
        run.imageRecipeSha256=listingFingerprint(result.draft.salesPlan?.recipe??null);
        run.contextSha256=listingFingerprint(run.imageContext);run.draftSha256=imageWorkflowDraftStamp(result.draft);this.save(run);
      }
      const base=run.imageContext,operationRevision=result.draft.revision;
      this.assertCurrentEvidence(result.draft,base,run.setPlan,currentWorkflowPlanIds(run));
      const assertEquivalentDraft=(draft:AmazonDraft,targetGeneration:number)=>{
        if(draft.revision!==operationRevision)throw new AiError('SOURCE_CHANGED');
        if(draft.revision===base.listing.draftRevision&&!this.listing.currentContext)return;
        const snapshot=currentImageListingSnapshot(draft,this.currentContext(draft,this.store.getProduct(run.productId),targetGeneration));
        if(!imageActualInputsMatch(base,draft,this.store.getProduct(run.productId),snapshot.context,run.imageRecipeSha256)
          ||draft.revision!==base.listing.draftRevision&&!imageListingCopyMatches(base.listing,snapshot.context,base.currentListingCopy,snapshot.currentListingCopy))throw new AiError('SOURCE_CHANGED');
      };
      const fresh=async()=>{
        this.assertSourceConsistency(run.draftId);
        if(this.getRiskSettings().enabled!==riskEnabled||this.getCopyReviewSettings().enabled!==copyReviewEnabled)throw new AiError('CONFIG_CHANGED');
        throwIfAborted(signal);const current=this.store.getProduct(run.productId),draft=this.amazon.getDraft(run.draftId),target=this.amazon.executionTargetScope(draft.targetId);
        if(current.revision!==run.productRevision||imageWorkflowDraftStamp(draft)!==run.draftSha256||target.generation!==base.listing.targetGeneration||target.target.paused||!target.target.configured)throw new AiError('SOURCE_CHANGED');
        assertEquivalentDraft(draft,target.generation);
        if(base.setPolicy&&listingFingerprint(base.sourceMeasurements??[])!==listingFingerprint(currentSourceImageMeasurements(this.db,draft)))throw new AiError('SOURCE_CHANGED');
        if(!reuse&&(this.generation.configurationScope()!==generationScope||listingFingerprint(this.generation.getConnection())!==configStamp)||listingFingerprint(profileIds.map(id=>this.workflowProfile(id)))!==profileStamp)throw new AiError('CONFIG_CHANGED');
        const schema=await this.amazon.getSchema(draft.schema);throwIfAborted(signal);
        assertImageSchemaCurrent(schema,base.listing);
        for(const ref of run.referenceAssets){const asset=this.store.getAssetRecord(ref.id);if(!asset||asset.productId!==run.productId||asset.sha256!==ref.sha256)throw new AiError('SOURCE_CHANGED');await readManagedImage(this.directory,asset,signal);}
        const after=this.amazon.getDraft(run.draftId),latestTarget=this.amazon.executionTargetScope(after.targetId);
        if(this.store.getProduct(run.productId).revision!==run.productRevision||imageWorkflowDraftStamp(after)!==run.draftSha256||latestTarget.generation!==base.listing.targetGeneration||latestTarget.target.paused||!latestTarget.target.configured)throw new AiError('SOURCE_CHANGED');
        assertEquivalentDraft(after,latestTarget.generation);
        if(!reuse&&(this.generation.configurationScope()!==generationScope||listingFingerprint(this.generation.getConnection())!==configStamp)||listingFingerprint(profileIds.map(id=>this.workflowProfile(id)))!==profileStamp)throw new AiError('CONFIG_CHANGED');
        throwIfAborted(signal);
        this.assertSourceConsistency(run.draftId);
      };
      await fresh();
      if(base.setPolicy){
        if(!run.setPlanResultId){
          stage('planning');const plan=await this.paid(run.draftId,()=>this.ai.imagePlan(base,fresh,undefined,signal,run.id,()=>result.aiCalls++));
          if(plan.output.kind!=='image-plan'||!plan.output.setPlan)throw new AiError('OUTPUT_INVALID');
          assertImagePlan(plan.output,base);if(!plan.output.productUnderstanding?.sufficient)this.sourceRefusal(run,plan);run.listingEvidenceContractVersion=imageEvidenceVersion(base.listing);run.setPlan=plan.output.setPlan;run.setPlanResultId=plan.id;this.save(run);
        }
        const planned=this.ai.getResult(run.setPlanResultId);
        if(!planned||planned.output.kind!=='image-plan'||listingFingerprint(planned.output.setPlan)!==listingFingerprint(run.setPlan))throw new AiError('SOURCE_CHANGED');
        if(!planned.output.productUnderstanding?.sufficient)this.sourceRefusal(run,planned);
        if(riskEnabled&&planned.output.ipRisk?.verdict!=='PASS')throw new UserFacingError('来源 AI IP 初筛未通过（非阿里云评分）：'+(planned.output.ipRisk?.findings.map(item=>item.name+'：'+item.evidence).join('；')||'缺少初筛结论'));
        await fresh();
      }
      if(riskEnabled)for(const slot of run.slots!){const attempt=slot.attempts.at(-1),ip=attempt?.ipReviewResultId?this.ai.getResult(attempt.ipReviewResultId):undefined;
        if(slot.status==='BLOCKED'&&attempt?.candidateId&&ip?.output.kind==='image-ip-review'&&ip.output.candidate.id===attempt.candidateId&&ip.output.planResultId===attempt.planResultId&&evaluateImageRisk(ip.output,this.getRiskSettings()).verdict==='PASS'){slot.status='PENDING';slot.error=null;attempt.state='GENERATED';attempt.error=null;this.save(run);}
      }
      if(riskEnabled&&run.slots!.some(slot=>slot.status==='BLOCKED'))throw new UserFacingError('此销售 SKU 的来源或生成图存在 IP 风险，保留已通过图片，不自动修改规避风险');
      for(const slot of run.slots!){
        if(selectedSlots&&!selectedSlots.includes(slot.index))continue;
        if(slot.status==='PASSED')continue;run.activeSlot=slot.index;
        const context=validateProductImageContext({...base,...(run.setPlan?{setPlan:run.setPlan}:{}),purpose:slot.purpose,slot:{index:slot.index,total:7,provisional:true}});if(!run.sourceReuse||slot.attempts.length!==run.sourceReuse.slotAttempts[slot.index-1]||!slot.attempts.length)slot.contextSha256=listingFingerprint(context);
        let attempt=slot.attempts.at(-1);
        if(!riskEnabled&&attempt?.state==='BLOCKED'){attempt.state=attempt.candidateId?'GENERATED':'READY';attempt.error=null;slot.status='PENDING';slot.error=null;this.save(run);}
        // An old detail-text rejection is no longer a reason to regenerate the same image.
        if(slot.index>1&&attempt?.state==='RETRYABLE_FAILURE'&&attempt.candidateId&&attempt.ipReviewResultId&&attempt.reviewResultId){
          const oldIp=this.ai.getResult(attempt.ipReviewResultId),oldReview=this.ai.getResult(attempt.reviewResultId);
          if(oldIp?.output.kind==='image-ip-review'&&evaluateImageRisk(oldIp.output,this.getRiskSettings()).verdict==='PASS'&&oldIp.output.planResultId===attempt.planResultId&&oldIp.output.candidate.id===attempt.candidateId&&oldReview?.output.kind==='image-text-review'&&oldReview.output.planResultId===attempt.planResultId&&listingFingerprint(oldReview.output.candidate)===listingFingerprint(oldIp.output.candidate)){attempt.state='GENERATED';attempt.error=null;this.save(run);}
        }
        const reviewOnly=run.slotPolicy===IMAGE_SET_POLICY&&slot.attempts.length>=imageSlotAttemptLimit(run,slot.index)&&this.canRecheckTextPolicy(attempt);
        if(attempt?.state==='RETRYABLE_FAILURE'&&slot.attempts.length>=imageSlotAttemptLimit(run,slot.index)&&!reviewOnly){slot.status='FAILED';this.save(run);continue;}
        for(;;){
          throwIfAborted(signal);await fresh();
          if(!attempt||attempt.state==='RETRYABLE_FAILURE'&&!reviewOnly){
            if(slot.attempts.length>=imageSlotAttemptLimit(run,slot.index)){slot.status='FAILED';this.save(run);break;}
            const previous=attempt;
            attempt={number:slot.attempts.length+1,requestId:randomUUID(),state:'PLANNING',planResultId:null,candidateId:null,ipReviewResultId:null,ocrResultId:null,reviewResultId:null,error:null};if(previous?.planResultId&&!previous.candidateId&&slot.attempts.length>=run.maxAttempts&&(!run.sourceReuse||slot.attempts.length>run.sourceReuse.slotAttempts[slot.index-1])){attempt.planResultId=previous.planResultId;attempt.planReuse={version:1,fromRequestId:previous.requestId};}
            slot.attempts.push(attempt);slot.contextSha256=listingFingerprint(context);
          }
          slot.status='RUNNING';slot.error=null;this.save(run);
          if(!attempt.planResultId){
            stage('planning');const previous=slot.attempts.at(-2),prior=previous?.reviewResultId?this.ai.getResult(previous.reviewResultId):undefined;
            const issues=prior?.output.kind==='image-text-review'?this.repairIssues(prior.output,previous?.ocrResultId?this.ai.getResult(previous.ocrResultId):undefined,context):previous?.error?[previous.error]:undefined;
            const inheritedPrevious=!!run.sourceReuse&&slot.attempts.length-2<run.sourceReuse.slotAttempts[slot.index-1];
            const repair=!inheritedPrevious&&previous?.planResultId&&issues?.length?{previousPlanId:previous.planResultId,issues}:undefined;
            const plan=await this.paid(run.draftId,()=>this.ai.imagePlan(context,fresh,repair,signal,run.id,()=>result.aiCalls++));
            if(plan.output.kind!=='image-plan')throw new AiError('OUTPUT_INVALID');assertImagePlan(plan.output,context);
            attempt.planResultId=plan.id;this.save(run);
            if(!plan.output.productUnderstanding?.sufficient)this.sourceRefusal(run,plan);
            if(riskEnabled&&plan.output.ipRisk?.verdict!=='PASS'){slot.status='BLOCKED';attempt.state='BLOCKED';slot.error=attempt.error=`来源 AI IP 初筛未通过（非阿里云评分）：${plan.output.ipRisk?.findings.map(item=>`${item.name}：${item.evidence}`).join('；')||'缺少初筛结论'}`;this.save(run);throw new UserFacingError(slot.error);}
            attempt.state='READY';this.save(run);
          }
          const plan=this.ai.getResult(attempt.planResultId!);if(!plan||plan.output.kind!=='image-plan')throw new AiError('SOURCE_CHANGED');
          assertImagePlan(plan.output,context);
          if(!plan.output.productUnderstanding?.sufficient||riskEnabled&&plan.output.ipRisk?.verdict!=='PASS')throw new UserFacingError('原图片规划尚未通过来源或 IP 初筛');
          if(['GENERATING','UNKNOWN'].includes(attempt.state)){
            let recovered:GeneratedImageCandidate|null;
            try{recovered=await this.generation.reconcileWorkflowGeneration(attempt.requestId);}
            catch(error){
              if(error instanceof AiError&&'definitive' in error&&error.definitive===true){attempt.failureProof={version:1,kind:'provider-definitive',at:new Date().toISOString()};attempt.state='RETRYABLE_FAILURE';slot.status='FAILED';attempt.error=slot.error=`原收据明确拒绝 [DEFINITIVE_FAILURE]：${publicError(error)}`;this.save(run);continue;}
              throw error;
            }
            if(!recovered){
              attempt.state='UNKNOWN';slot.status='UNKNOWN';slot.error=attempt.error='原生图请求结果未知 [RESULT_UNKNOWN]，尚无可回收收据；保留原请求编号和费用，不创建新请求';this.save(run);throw new UserFacingError(slot.error);
            }
            attempt.candidateId=recovered.id;attempt.state='GENERATED';attempt.error=null;this.save(run);
          }
          let local:Awaited<ReturnType<Generator['readCandidate']>>;
          const priorSlot=reuse?.slots?.[slot.index-1];
          if(reuse){
            const asset=priorSlot?.approvedAssetId?this.store.getAssetRecord(priorSlot.approvedAssetId):undefined;
            if(!asset||asset.sha256!==priorSlot?.approvedSha256||asset.productId!==run.productId||!confirmed(asset.id,run.variantId))throw new AiError('SOURCE_CHANGED');
            const bytes=await readManagedImage(this.directory,asset,signal),candidateId=priorSlot!.attempts.at(-1)!.candidateId!;
            const candidate:GeneratedImageCandidate={id:candidateId,provider:'openai',model:'gpt-image-2.5-sunburst',mode:'edit',productId:run.productId,productRevision:run.productRevision,createdAt:run.createdAt,requestId:null,sourceAssets:run.referenceAssets,reviewState:'unreviewed',mimeType:'image/png',width:asset.width,height:asset.height,byteSize:asset.byteSize,sha256:asset.sha256,previewUrl:''};
            local={candidate,bytes,preview:bytes};attempt.candidateId=candidateId;attempt.state='GENERATED';this.save(run);
          }else{
            if(!attempt.candidateId){
              stage('generating');await fresh();this.amazon.assertPricingForPaid(run.draftId);attempt.state='GENERATING';this.save(run);
              const previous=slot.attempts.at(-2),editCandidateId=previous?.reviewResultId?previous.candidateId??undefined:undefined;
              try{
                const prompt=(editCandidateId?'The FIRST attached image is the failed candidate. Correct the reported text issue (including missing or unwanted text); the following images are the original product references. Preserve correct content. Do not treat the failed candidate as factual evidence.\n':'')+imageGenerationPrompt(plan.output,context,riskEnabled);
                const candidate=await this.generation.generateForWorkflow({productId:run.productId,productRevision:run.productRevision,prompt,referenceAssetIds:run.referenceAssets.map(ref=>ref.id),size:connection!.size,quality:connection!.quality,background:'opaque'},{requestId:attempt.requestId,...(editCandidateId?{editCandidateId}:{}),owner:{draftId:run.draftId,sku:run.sku,targetId:context.listing.targetId,marketplaceId:context.listing.marketplaceId,variantIds:[...new Set(context.listing.sourceProduct?.salesRecipe?.recipe.components.map(component=>component.variantId)??[run.variantId])].sort(),slot:slot.index}},signal,async()=>{await fresh();this.assertSourceConsistency(run.draftId);this.amazon.assertPricingForPaid(run.draftId);});
                attempt.candidateId=candidate.id;attempt.state='GENERATED';this.save(run);
              }catch(error){
                if(error instanceof AiError&&'notSent' in error&&error.notSent===true){
                  attempt.state='READY';attempt.error=`生图请求尚未发送 [NOT_SENT]：${publicError(error)}；本位置和原请求编号已保留，请处理后继续`;
                  slot.error=attempt.error;slot.status='FAILED';this.save(run);if(isSchemaTransientError(error))throw error;throw new UserFacingError(attempt.error);
                }
                const known=error instanceof AiError&&'definitive' in error&&error.definitive===true;
                if(known)attempt.failureProof={version:1,kind:'provider-definitive',at:new Date().toISOString()};attempt.state=known?'RETRYABLE_FAILURE':'UNKNOWN';attempt.error=`${known?'明确拒绝 [DEFINITIVE_FAILURE]':'结果未知 [RESULT_UNKNOWN]'}：${publicError(error)}`;slot.error=attempt.error;slot.status=known?'FAILED':'UNKNOWN';this.save(run);
                if(known&&!signal.aborted)continue;throw error;
              }
            }
            local=await this.generation.readCandidate(attempt.candidateId!);
          }
          const candidate=local.candidate;
          if(candidate.productId!==run.productId||candidate.productRevision!==run.productRevision||candidate.mode!=='edit'||listingFingerprint(candidate.sourceAssets)!==listingFingerprint(run.referenceAssets)||digest(local.bytes)!==candidate.sha256)throw new AiError('SOURCE_CHANGED');
          const identity={id:candidate.id,sha256:candidate.sha256,width:candidate.width,height:candidate.height};await fresh();
          if(riskEnabled){
          stage('ip-check');const ip=attempt.ipReviewResultId?this.ai.getResult(attempt.ipReviewResultId):await this.reviewStep(run,'risk',context,plan,identity,undefined,owner=>this.ai.reviewGeneratedImageRisk(context,plan,identity,local.bytes,fresh,signal,owner));
          if(!attempt.ipReviewResultId)result.aiCalls++;
          if(ip?.output.kind!=='image-ip-review'||ip.output.planResultId!==plan.id||listingFingerprint(ip.output.candidate)!==listingFingerprint(identity))throw new AiError('OUTPUT_INVALID');
          attempt.ipReviewResultId=ip.id;this.save(run);await fresh();
          const risk=evaluateImageRisk(ip.output,this.getRiskSettings());
          if(risk.verdict!=='PASS'){attempt.state=risk.verdict==='UNCERTAIN'?'RETRYABLE_FAILURE':'BLOCKED';slot.status=risk.verdict==='UNCERTAIN'?'FAILED':'BLOCKED';slot.error=attempt.error=describeImageRisk(ip.output,this.getRiskSettings(),run.sku,slot.index).slice(0,2000);this.save(run);throw new UserFacingError(slot.error);}
          attempt.riskPolicy=this.getRiskSettings();this.save(run);
          }else{attempt.riskBypass??={at:new Date().toISOString(),candidate:identity};if(listingFingerprint(attempt.riskBypass.candidate)!==listingFingerprint(identity))throw new AiError('SOURCE_CHANGED');this.save(run);}
          // Only workflows started under this policy receive the new check. History remains literal.
          if(run.appearanceReviewEnabled!==undefined){
            stage('reviewing');
            const verdict=await runAppearanceReview({enabled:run.appearanceReviewEnabled,attempt,candidate:identity,planResultId:plan.id,
              getSnapshot:()=>{const profile=this.ai.purposeProfile?.('appearance_review',true,true);if(!profile?.configured||!profile.enabled||!profile.routing)throw new UserFacingError('请配置外观复核用途及有视觉能力的模型');return profile.routing;},
              save:()=>this.save(run),beforeSend:()=>{this.assertSourceConsistency(run.draftId);this.amazon.assertPricingForPaid(run.draftId);},findResult:id=>this.ai.getResult(id),
              recover:previousResultId=>this.ai.listResults(run.productId).find(r=>r.output.kind==='image-appearance-review'&&r.output.planResultId===plan.id&&r.output.previousResultId===previousResultId&&listingFingerprint(r.output.candidate)===listingFingerprint(identity)&&r.sourceSha256===listingFingerprint(context)&&this.ai.getCall(r.callId)?.status==='SUCCEEDED'),
              send:async(snapshot,previous)=>{if(!this.ai.reviewGeneratedImageAppearance)throw Object.assign(new UserFacingError('外观复核服务未初始化'),{notSent:true});try{const review=await this.ai.reviewGeneratedImageAppearance(context,plan,identity,local.bytes,fresh,signal,snapshot,previous);result.aiCalls++;return review;}catch(error){if(error instanceof AiError&&!error.callId)Object.assign(error,{notSent:true});throw error;}}});
            await fresh();
            if(verdict==='MISMATCH'||verdict==='UNCERTAIN'){
              const review=this.ai.getResult(attempt.appearanceReview!.resultIds.at(-1)!);
              attempt.error=slot.error=`图片 ${slot.index} 外观${verdict==='MISMATCH'?'明确不一致':'无法判断'}：${review?.output.kind==='image-appearance-review'?review.output.checks.map(c=>`${c.aspect}: ${c.expected} / ${c.observed}；${c.reason}`).join('；'):'依据已保留'}`.slice(0,2000);
              // Unknown is not a redraw instruction. Clear mismatches use only this slot's existing budget.
              attempt.state=verdict==='MISMATCH'?'RETRYABLE_FAILURE':'BLOCKED';slot.status=verdict==='MISMATCH'?'FAILED':'BLOCKED';this.save(run);
              if(verdict==='MISMATCH'&&!reuse&&!reviewOnly)continue;
              break;
            }
          }
          if(slot.index>1){
            attempt.approvalPolicy=riskEnabled?'ip-only-detail/v1':'risk-disabled-detail/v1';this.save(run);
            stage('adopting');await this.adoptSlot(run,slot,attempt,local,fresh,signal,priorSlot?.approvedAssetId??undefined);break;
          }
          if(local.bytes.length>10*1024*1024)throw new UserFacingError('生成图超过 OCR 大小预算，候选和次数已保留');
          stage('ocr');const ocr=attempt.ocrResultId?this.ai.getResult(attempt.ocrResultId):await this.reviewStep(run,'ocr',context,plan,identity,undefined,owner=>this.ai.recognizeGeneratedImage(context,identity,local.bytes,fresh,signal,owner));if(!attempt.ocrResultId)result.aiCalls++;
          if(!ocr)throw new AiError('SOURCE_CHANGED');attempt.ocrResultId=ocr.id;this.save(run);await fresh();
          stage('reviewing');
          const sendReview=reviewOnly||!attempt.reviewResultId;
          if(sendReview){attempt.textReviewPolicyVersion=IMAGE_TEXT_REVIEW_POLICY_VERSION;this.save(run);}
          const review=sendReview?await this.reviewStep(run,'text',context,plan,identity,ocr,owner=>this.ai.reviewGeneratedImage(context,plan,ocr,identity,fresh,signal,owner)):this.ai.getResult(attempt.reviewResultId!);if(sendReview)result.aiCalls++;
          if(review?.output.kind!=='image-text-review'||review.output.planResultId!==plan.id||review.output.ocrResultId!==ocr.id||listingFingerprint(review.output.candidate)!==listingFingerprint(identity))throw new AiError('OUTPUT_INVALID');
          attempt.reviewResultId=review.id;if(reviewOnly&&review.output.verdict==='PASS')attempt.state='GENERATED';this.save(run);await fresh();
          if(review.output.verdict==='PASS'){
            stage('adopting');await this.adoptSlot(run,slot,attempt,local,fresh,signal,priorSlot?.approvedAssetId??undefined);break;
          }
          attempt.state='RETRYABLE_FAILURE';attempt.error=`图片 ${slot.index} 文字或内容规则未通过：${review.output.issues.join('；')}`.slice(0,2000);slot.status='FAILED';slot.error=attempt.error;this.save(run);
          if(reuse||reviewOnly)break;
        }
      }
      run.status=run.slots!.every(slot=>slot.status==='PASSED')?'COMPLETED':'BLOCKED';run.stage=run.status==='COMPLETED'?'complete':run.stage;
      run.error=run.status==='COMPLETED'?null:run.slots!.some(slot=>slot.status==='BLOCKED')?'部分图位存在明确阻断或外观无法判断，已保留候选、依据、次数与其他成功图片':(run.retryAllowance?'部分图片未通过或已用完本位置当前尝试额度；已通过图片保留，请处理失败位置':'部分图片未通过或已达到本位置最多 3 次尝试；已通过图片保留，请处理失败位置');this.save(run);
    }catch(error){
      if(error instanceof BatchWaitingError){run.status='WAITING_BATCH';run.error=error.message;this.save(run);throw error;}
      this.captureRejection(run,error);
      run.status=signal.aborted?'CANCELLED':error instanceof AiError&&!['NOT_CONFIGURED','DISABLED','SOURCE_CHANGED','CONFIG_CHANGED'].includes(error.code)?'FAILED':'BLOCKED';
      run.error=signal.aborted?'自动准备已停止，已通过图片和尝试次数保留':run.stage==='ip-check'&&error instanceof AiError?`阿里云图片侵权检测未完成：${publicError(error)}。请核对图片审核增强版开通状态、访问权限和额度；本商品已停止。`:publicError(error);this.save(run);
      if(isSchemaTransientError(error))throw error;
    }
    try{result.draft=this.amazon.getDraft(run.draftId);}catch{/* Preserve the last valid draft. */}
    return {...result,workflow:structuredClone(run)};
  }
  private canRecheckTextPolicy(attempt:ImageSlotAttempt|undefined):boolean {
    if(!needsImageTextPolicyReview(attempt))return false;
    const ip=this.ai.getResult(attempt!.ipReviewResultId!),ocr=this.ai.getResult(attempt!.ocrResultId!),review=this.ai.getResult(attempt!.reviewResultId!);
    return ip?.output.kind==='image-ip-review'&&evaluateImageRisk(ip.output,this.getRiskSettings()).verdict==='PASS'&&ip.output.planResultId===attempt!.planResultId
      &&ocr?.output.kind==='generated-image-ocr'&&ocr.output.candidate?.id===attempt!.candidateId
      &&review?.output.kind==='image-text-review'&&review.output.verdict==='NEEDS_CHANGES'&&review.output.planResultId===attempt!.planResultId&&review.output.ocrResultId===ocr.id
      &&listingFingerprint(ip.output.candidate)===listingFingerprint(ocr.output.candidate)&&listingFingerprint(review.output.candidate)===listingFingerprint(ocr.output.candidate);
  }
  private repairIssues(review:Extract<import('../../shared/ai-contracts.ts').AiOutput,{kind:'image-text-review'}>,ocr:import('../../shared/ai-contracts.ts').AiResult|undefined,context:ProductImageContext):string[]{
    const details=review.checks?.filter(check=>check.verdict==='CONTRADICTED').map(check=>{
      const line=ocr?.output.kind==='generated-image-ocr'&&check.source==='line'?ocr.output.lines[check.index]:undefined;
      const expected=imageEvidence(context).filter(fact=>check.evidenceIds.includes(fact.id)).map(fact=>`${fact.name}: ${fact.value}`).join('; ');
      return `Text: ${check.text}; location: ${check.source} ${check.index}${line?.box?` ${JSON.stringify(line.box)}`:''}; why: ${check.reason}; expected verified facts: ${expected}`;
    })??[];
    return [...details,...review.issues].slice(0,50).map(value=>value.slice(0,2000));
  }
  private async adoptSlot(run:ImageWorkflowRun,slot:ImageWorkflowSlot,attempt:ImageSlotAttempt,local:Awaited<ReturnType<Generator['readCandidate']>>,fresh:()=>Promise<void>,signal:AbortSignal,reusedAssetId?:string):Promise<void>{
    this.assertSourceConsistency(run.draftId);
    const {candidate}=local;await fresh();
    if(digest(local.bytes)!==candidate.sha256||candidate.byteSize!==local.bytes.length||inspectRaster(local.bytes).mimeType!=='image/png'||inspectRaster(local.preview).mimeType!=='image/png')throw new AiError('OUTPUT_INVALID');
    if(!reusedAssetId&&this.store.findAssetByHash(run.productId,candidate.sha256))throw new UserFacingError('生成结果与已有图片完全相同，未将重复图片计入七图');
    const id=reusedAssetId??randomUUID(),written:string[]=[];
    try{
      if(!reusedAssetId){const directory=privateDirectory(this.directory,'assets',true);for(const [suffix,bytes] of [['.png',local.bytes],['.preview.png',local.preview]] as const){throwIfAborted(signal);const path=join(directory,`${id}${suffix}`),file=await open(path,'wx');written.push(path);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}}
      await fresh();this.db.exec('BEGIN IMMEDIATE');
      try{
        this.assertSourceConsistency(run.draftId);
        if(this.store.getProduct(run.productId).revision!==run.productRevision||imageWorkflowDraftStamp(this.amazon.getDraft(run.draftId))!==run.draftSha256)throw new AiError('SOURCE_CHANGED');
        const now=new Date().toISOString();if(!reusedAssetId){registerGeneratedAsset(this.db,{id,productId:run.productId,fileName:`自动生成-${run.sku}-${slot.index}.png`,width:candidate.width,height:candidate.height,byteSize:candidate.byteSize,sha256:candidate.sha256,at:now});confirmAssetBinding(this.db,{productId:run.productId,assetId:id,variantId:run.variantId,at:now});}
        slot.approvedAssetId=id;slot.approvedSha256=candidate.sha256;slot.status='PASSED';slot.error=null;attempt.state='PASSED';attempt.error=null;this.save(run);
        appendAuditEvent(this.db,randomUUID(),run.productId,reusedAssetId?'image.workflow.rechecked':'image.workflow.adopted',`${run.sku} 图片 ${slot.index}/7 ${attempt.riskBypass?(slot.index===1?'风险拦截已关闭；首图无字检查通过':'风险拦截已关闭；详情图不检查文字'):attempt.approvalPolicy?'侵权风险检测通过，详情图不检查文字':'侵权与主图无字复核通过'}`,JSON.stringify({workflowId:run.id,slot:slot.index,attempt:attempt.number,assetId:id,candidateId:candidate.id,reviewResultId:attempt.reviewResultId,riskInterceptionEnabled:run.riskInterceptionEnabled!==false,approvalPolicy:attempt.approvalPolicy??'legacy-text-review',visualReview:attempt.appearanceReview?.state==='DONE'?'performed':'not_performed',appearanceReviewResultIds:attempt.appearanceReview?.resultIds??[],...(run.recheckedFromRunId?{sourceWorkflowId:run.recheckedFromRunId}:{})}),now);
        this.db.exec('COMMIT');
      }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');slot.approvedAssetId=null;slot.approvedSha256=null;slot.status='RUNNING';attempt.state='GENERATED';throw error;}
    }catch(error){for(const path of written)await unlink(path).catch(()=>{});throw error;}
  }
  private async run(run: ImageWorkflowRun, initial: AmazonDraft, signal: AbortSignal, reuse?:ImageWorkflowRun): Promise<CompleteAutomaticProductResult> {
    this.assertSourceConsistency(run.draftId);
    let result = { draft:initial, aiCalls:0, previewAttempts:0, remaining:[] as string[] };
    const stage = (value: ImageWorkflowRun['stage']) => { throwIfAborted(signal); run.stage=value; this.save(run); };
    try {
      throwIfAborted(signal);
      if(!reuse)this.amazon.assertPricingForPaid(initial.id);
      const connection = reuse ? null : this.generation.getConnection();
      if(reuse)this.assertCurrentEvidence(initial,reuse.imageContext,reuse.setPlan,currentWorkflowPlanIds(reuse));
      if (!reuse && (!connection?.configured || !connection.enabled)) throw new UserFacingError('请在设置中配置并启用生图服务，然后重新开始自动准备');
      const generationScope=reuse ? null : this.generation.configurationScope(), configStamp=listingFingerprint(connection);
      for (const [id,label] of [['deepseek','DeepSeek 内容生成'],['deepseek-review','DeepSeek 独立复核'],['aliyun-ocr','阿里云 OCR'],['aliyun-image-risk','阿里云图片侵权风险检测']] as const) {
        const profile = this.workflowProfile(id); if (!profile.configured || !profile.enabled) throw new UserFacingError(`请在设置中配置并启用${label}，然后重新开始自动准备`);
      }
      const profileIds=['deepseek','deepseek-review','aliyun-ocr','aliyun-image-risk'];
      const profileStamp=listingFingerprint(profileIds.map(id=>this.workflowProfile(id)));
      const derived = new Set(workflowRuns(this.db).flatMap(r => r.approvedAssetId ? [r.approvedAssetId] : []));
      const product = this.store.getProduct(run.productId);
      const referenceProduct=productReferenceImages(product,[run.variantId].flatMap(variantId=>this.ai.sourceObservationEvidence?.({productId:product.id,productRevision:product.revision,variantId})??[]));
      const refs = selectImageReferences(referenceProduct,run.variantId,derived,(assetId,variantId)=>Boolean(this.db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(assetId,variantId)),allowSourceUnbound(product,readSourceImageReceipt(this.db,product.id)));
      run.referenceAssets=refs.map(ref=>({id:ref.id,sha256:this.store.getAssetRecord(ref.id)!.sha256})); this.save(run);
      if(reuse){
        if(listingFingerprint(run.referenceAssets)!==listingFingerprint(reuse.referenceAssets))throw new AiError('SOURCE_CHANGED');
        const asset=this.store.getAssetRecord(reuse.approvedAssetId!);
        if(!asset||asset.productId!==run.productId||asset.sha256!==reuse.approvedSha256||!this.db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(asset.id,run.variantId))throw new AiError('SOURCE_CHANGED');
        await readManagedImage(this.directory,asset,signal);
      }else result = await this.listing.complete({draftId:run.draftId,draftRevision:initial.revision},signal);
      throwIfAborted(signal);
      const copy = await this.listing.reviewCurrentForImages({draftId:run.draftId,draftRevision:result.draft.revision},signal); result.aiCalls++;
      if (copy.review.output.kind !== 'listing-current-review' || copy.review.output.verdict !== 'PASS') throw new UserFacingError('商品文案复核未通过，已停止后续生图');
      assertCurrentListingReview({...copy.review.output,kind:'amazon-fields-review'},copy.currentListingCopy,copy.context);
      const context: ProductImageContext = validateProductImageContext({ listing:copy.context,currentListingCopy:copy.currentListingCopy,listingReviewResultId:copy.review.id,ipSource:imageRiskSourceSnapshot(product,run.variantId),
        referenceAssets:run.referenceAssets.map(ref=>({...(isProductReference(this.db,product.id,run.variantId,ref.id)?{scope:'product' as const}:{}),assetId:ref.id,sha256:ref.sha256,variantId:refs.find(a=>a.id===ref.id)!.variantIds.includes(run.variantId)?run.variantId:null})),purpose:'main',policyVersion:PRODUCT_IMAGE_POLICY_VERSION });
      if(reuse){
        const priorReview=this.ai.getResult(reuse.reviewResultIds.at(-1)!),call=priorReview&&this.ai.getCall(priorReview.callId),previous=priorReview?.imageContext;
        if(!previous||priorReview?.output.kind!=='image-text-review'||priorReview.output.verdict!=='PASS'||call?.status!=='SUCCEEDED'
          ||listingFingerprint(previous)!==reuse.contextSha256||priorReview.output.candidate.sha256!==reuse.approvedSha256
          ||!imageListingContextsMatch({...previous.listing,draftRevision:0},{...context.listing,draftRevision:0})
          ||listingFingerprint(previous.referenceAssets)!==listingFingerprint(context.referenceAssets)||listingFingerprint(previous.ipSource)!==listingFingerprint(context.ipSource))throw new AiError('SOURCE_CHANGED');
      }
      run.listingEvidenceContractVersion=imageEvidenceVersion(context.listing);
      run.contextSha256=listingFingerprint(context); run.draftSha256=imageWorkflowDraftStamp(result.draft); this.save(run);
      const fresh = async () => {
        this.assertSourceConsistency(run.draftId);
        throwIfAborted(signal);
        const draft=this.amazon.getDraft(run.draftId), current=this.store.getProduct(run.productId), target=this.amazon.executionTargetScope(draft.targetId);
        if (current.revision!==run.productRevision || draft.revision!==context.listing.draftRevision || imageWorkflowDraftStamp(draft)!==run.draftSha256 || target.generation!==context.listing.targetGeneration || target.target.paused || !target.target.configured) throw new AiError('SOURCE_CHANGED');
        if ((!reuse&&(this.generation.configurationScope()!==generationScope || listingFingerprint(this.generation.getConnection())!==configStamp)) || listingFingerprint(profileIds.map(id=>this.workflowProfile(id)))!==profileStamp) throw new AiError('CONFIG_CHANGED');
        const schema=await this.amazon.getSchema(draft.schema); throwIfAborted(signal);
        assertImageSchemaCurrent(schema,context.listing);
        for (const ref of run.referenceAssets) { const asset=this.store.getAssetRecord(ref.id); if (!asset || asset.productId!==run.productId || asset.sha256!==ref.sha256) throw new AiError('SOURCE_CHANGED'); await readManagedImage(this.directory,asset,signal); }
        if (this.store.getProduct(run.productId).revision!==run.productRevision || this.amazon.getDraft(run.draftId).revision!==context.listing.draftRevision) throw new AiError('SOURCE_CHANGED');
        const latestTarget=this.amazon.executionTargetScope(draft.targetId);
        if (latestTarget.generation!==context.listing.targetGeneration || latestTarget.target.paused || !latestTarget.target.configured) throw new AiError('SOURCE_CHANGED');
        if ((!reuse&&(this.generation.configurationScope()!==generationScope || listingFingerprint(this.generation.getConnection())!==configStamp)) || listingFingerprint(profileIds.map(id=>this.workflowProfile(id)))!==profileStamp) throw new AiError('CONFIG_CHANGED');
        throwIfAborted(signal);
        this.assertSourceConsistency(run.draftId);
      };
      let repair: {previousPlanId:string;issues:string[]} | undefined;
      for (let attempt=1;attempt<=run.maxAttempts;attempt++) {
        run.attempt=attempt; stage('planning'); await fresh();
        const plan=await this.paid(run.draftId,()=>this.ai.imagePlan(context,fresh,repair,signal,run.id,()=>result.aiCalls++));
        if (plan.output.kind!=='image-plan') throw new AiError('OUTPUT_INVALID');
        assertImagePlan(plan.output,context);
        run.planResultIds.push(plan.id); this.save(run);
        if (!plan.output.productUnderstanding?.sufficient) this.sourceRefusal(run,plan);
        if(plan.output.ipRisk?.verdict!=='PASS')throw new UserFacingError(`商品 IP 初筛${plan.output.ipRisk?.verdict==='BLOCKED'?'发现风险':'待确认'}：${plan.output.ipRisk?.findings.map(item=>`${item.name}：${item.evidence}`).join('；')||'缺少初筛结论'}。已停止生图。`.slice(0,2000));
        if(!reuse)stage('generating'); await fresh();
        if(!reuse)this.amazon.assertPricingForPaid(run.draftId);
        const candidate=reuse?(await this.generation.readCandidate(reuse.candidateIds.at(-1)!)).candidate
          :await this.generation.generate({productId:run.productId,productRevision:run.productRevision,prompt:imageGenerationPrompt(plan.output),referenceAssetIds:run.referenceAssets.map(ref=>ref.id),size:connection!.size,quality:connection!.quality,background:'opaque'},signal,async()=>{await fresh();this.assertSourceConsistency(run.draftId);this.amazon.assertPricingForPaid(run.draftId);});
        if(reuse&&(candidate.id!==reuse.candidateIds.at(-1)||candidate.sha256!==reuse.approvedSha256))throw new AiError('SOURCE_CHANGED');
        if (candidate.productId!==run.productId || candidate.productRevision!==run.productRevision || candidate.mode!=='edit' || listingFingerprint(candidate.sourceAssets)!==listingFingerprint(run.referenceAssets)) throw new AiError('SOURCE_CHANGED');
        run.candidateIds.push(candidate.id); this.save(run); await fresh();
        const identity={id:candidate.id,sha256:candidate.sha256,width:candidate.width,height:candidate.height};
        stage('ip-check'); const local=await this.generation.readCandidate(candidate.id);
        if (digest(local.bytes)!==candidate.sha256) throw new AiError('SOURCE_CHANGED');
        const ip=await this.reviewStep(run,'risk',context,plan,identity,undefined,owner=>this.ai.reviewGeneratedImageRisk(context,plan,identity,local.bytes,fresh,signal,owner)); result.aiCalls++;
        if(ip.output.kind!=='image-ip-review'||ip.output.planResultId!==plan.id||listingFingerprint(ip.output.candidate)!==listingFingerprint(identity))throw new AiError('OUTPUT_INVALID');
        run.ipReviewResultIds!.push(ip.id);this.save(run);await fresh();
        if(evaluateImageRisk(ip.output,this.getRiskSettings()).verdict!=='PASS')throw new UserFacingError(describeImageRisk(ip.output,this.getRiskSettings(),run.sku,1).slice(0,2000));
        run.riskPolicy=this.getRiskSettings();this.save(run);
        stage('ocr');
        if (local.bytes.length>10*1024*1024) throw new UserFacingError('生成的 PNG 超过 10 MB，已保留候选并停止 OCR；请调低全局尺寸后重新准备');
        const ocr=await this.reviewStep(run,'ocr',context,plan,identity,undefined,owner=>this.ai.recognizeGeneratedImage(context,identity,local.bytes,fresh,signal,owner)); result.aiCalls++;
        run.ocrResultIds.push(ocr.id); this.save(run); stage('reviewing'); await fresh();
        const review=await this.reviewStep(run,'text',context,plan,identity,ocr,owner=>this.ai.reviewGeneratedImage(context,plan,ocr,identity,fresh,signal,owner)); result.aiCalls++;
        if (review.output.kind!=='image-text-review' || listingFingerprint(review.output.candidate)!==listingFingerprint(identity) || review.output.planResultId!==plan.id || review.output.ocrResultId!==ocr.id) throw new AiError('OUTPUT_INVALID');
        run.reviewResultIds.push(review.id); this.save(run); await fresh();
        if (review.output.verdict==='PASS') {
          stage('adopting');
          if(reuse)await this.finishRecheck(run,reuse,candidate,fresh,signal);else await this.adopt(run,candidate,fresh,signal);
          return {...result,workflow:structuredClone(run)};
        }
        if (review.output.verdict==='BLOCKED' || attempt===run.maxAttempts) {
          run.status='BLOCKED'; run.error=`图片文字复核未通过：${review.output.issues.join('；') || '存在未获证据支持的文字'}。已停止自动重试。`.slice(0,2000); this.save(run);
          return {...result,workflow:structuredClone(run)};
        }
        repair={previousPlanId:plan.id,issues:review.output.issues};
      }
      throw new AiError('OUTPUT_INVALID');
    } catch (error) {
      if(error instanceof BatchWaitingError){run.status='WAITING_BATCH';run.error=error.message;this.save(run);throw error;}
      this.captureRejection(run,error);
      run.status=signal.aborted?'CANCELLED':error instanceof AiError && !['NOT_CONFIGURED','DISABLED','SOURCE_CHANGED','CONFIG_CHANGED'].includes(error.code)?'FAILED':'BLOCKED';
      run.error=signal.aborted?'自动准备已停止，未自动重发请求':run.stage==='ip-check' && error instanceof AiError?`阿里云图片侵权检测未完成：${publicError(error)}。请核对图片审核增强版开通状态、访问权限和额度；本商品已停止。`:publicError(error); this.save(run);
      if(isSchemaTransientError(error))throw error;
      try { result.draft=this.amazon.getDraft(run.draftId); } catch { /* Keep the last known draft. */ }
      return {...result,workflow:structuredClone(run)};
    }
  }
  private async finishRecheck(run:ImageWorkflowRun,prior:ImageWorkflowRun,candidate:GeneratedImageCandidate,fresh:()=>Promise<void>,signal:AbortSignal):Promise<void>{
    this.assertSourceConsistency(run.draftId);
    const asset=this.store.getAssetRecord(prior.approvedAssetId!);
    if(!asset||asset.productId!==run.productId||asset.sha256!==candidate.sha256)throw new AiError('SOURCE_CHANGED');
    await readManagedImage(this.directory,asset,signal);await fresh();this.db.exec('BEGIN IMMEDIATE');
    try{
      this.assertSourceConsistency(run.draftId);
      if(this.store.getProduct(run.productId).revision!==run.productRevision||imageWorkflowDraftStamp(this.amazon.getDraft(run.draftId))!==run.draftSha256
        ||!this.db.prepare('SELECT 1 FROM assets a JOIN variant_assets v ON a.id=v.asset_id WHERE a.id=? AND a.sha256=? AND v.variant_id=? AND v.confirmed=1').get(asset.id,candidate.sha256,run.variantId))throw new AiError('SOURCE_CHANGED');
      run.approvedAssetId=asset.id;run.approvedSha256=candidate.sha256;run.status='COMPLETED';run.stage='complete';run.error=null;this.save(run);
      appendAuditEvent(this.db,randomUUID(),run.productId,'image.workflow.rechecked',run.sku+' 原图片侵权与 OCR 复核通过，未再次生图',
        JSON.stringify({workflowId:run.id,sourceWorkflowId:prior.id,assetId:asset.id,candidateId:candidate.id,reviewResultId:run.reviewResultIds.at(-1),visualReview:'not_performed'}),new Date().toISOString());
      this.db.exec('COMMIT');
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');run.approvedAssetId=null;run.approvedSha256=null;run.status='RUNNING';run.stage='adopting';throw error;}
  }
  private async adopt(run: ImageWorkflowRun,candidate:GeneratedImageCandidate,fresh:()=>Promise<void>,signal:AbortSignal):Promise<void> {
    this.assertSourceConsistency(run.draftId);
    const local=await this.generation.readCandidate(candidate.id); await fresh();
    if (digest(local.bytes)!==candidate.sha256 || local.bytes.length!==candidate.byteSize) throw new AiError('SOURCE_CHANGED');
    const raster=inspectRaster(local.bytes), preview=inspectRaster(local.preview);
    if (raster.mimeType!=='image/png' || raster.width!==candidate.width || raster.height!==candidate.height || preview.mimeType!=='image/png') throw new AiError('OUTPUT_INVALID');
    if (this.store.findAssetByHash(run.productId,candidate.sha256)) throw new UserFacingError('生成结果与已有图片完全相同，未重复采用');
    const id=randomUUID(), directory=privateDirectory(this.directory,'assets',true), paths=[join(directory,`${id}.png`),join(directory,`${id}.preview.png`)];
    const written:string[]=[];
    try {
      for (const [index,bytes] of [local.bytes,local.preview].entries()) {
        throwIfAborted(signal); const file=await open(paths[index],'wx'); written.push(paths[index]);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      }
      await fresh();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.assertSourceConsistency(run.draftId);
        if (this.store.getProduct(run.productId).revision!==run.productRevision || imageWorkflowDraftStamp(this.amazon.getDraft(run.draftId))!==run.draftSha256) throw new AiError('SOURCE_CHANGED');
        const now=new Date().toISOString();
        registerGeneratedAsset(this.db,{id,productId:run.productId,fileName:`自动生成-${run.sku}.png`,width:candidate.width,height:candidate.height,byteSize:candidate.byteSize,sha256:candidate.sha256,at:now});
        confirmAssetBinding(this.db,{productId:run.productId,assetId:id,variantId:run.variantId,at:now});
        run.approvedAssetId=id; run.approvedSha256=candidate.sha256; run.status='COMPLETED'; run.stage='complete'; run.error=null; this.save(run);
        appendAuditEvent(this.db,randomUUID(),run.productId,'image.workflow.adopted',`自动采用 ${run.sku} 图片（文字复核通过）`,JSON.stringify({workflowId:run.id,assetId:id,candidateId:candidate.id,reviewResultId:run.reviewResultIds.at(-1),visualReview:'not_performed'}),now);
        this.db.exec('COMMIT');
      } catch(error) { if(this.db.isTransaction)this.db.exec('ROLLBACK'); run.approvedAssetId=null;run.approvedSha256=null;run.status='RUNNING';run.stage='adopting';throw error; }
    } catch(error) { for(const path of written) await unlink(path).catch(()=>{}); throw error; }
  }
}
