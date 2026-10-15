import {recoverCategoryPhase,categoryCalls,claimCategoryRepair} from './category-recovery.ts';
import { assertConfirmedForbiddenRetry,claimConfirmedForbiddenRetry } from './confirmed-forbidden-retry.ts';
import { fieldGroupCallId,fieldGroupRetryScope,assertFieldGroupHistory } from './field-purpose-groups.ts';
import { appendAuditEvent } from '../storage/audit.ts';
import { appendRunEvidence, evidenceCode, evidenceSku, validateRunEvidence, validateTransportRunEvidence } from '../diagnostics/run-evidence.ts';
import type { RunEvidence } from '../../shared/run-evidence-contracts.ts';
import { imagePlanFailureConfirmed } from './image-plan-retry.ts';
import { imagePlanningAllowanceLimit } from '../image-workflow/retry-allowance.ts';
import { decideListingEnums } from './enum-decisions.ts';
import { factsForVariant, productFactEvidence } from '../../shared/fact-scopes.ts';
import { runCopyReview,readCopyReview,copyReviewReason,copyReviewResult } from './copy-review-upgrade.ts';
import {reviewProductAppearance} from './appearance-adapter.ts';
import {validatePurposeSnapshot as validateAppearancePurposeSnapshot} from './purpose-routing.ts';
import { AI_PURPOSE_IDS } from '../../shared/ai-purpose-contracts.ts';
import type { TaskBatchPlan } from '../../shared/ai-batch-contracts.ts';
import { TaskBatchRuntime } from './batch/task-runtime.ts';
import { taskAiContext,BatchWaitingError } from './batch/task-context.ts';
import type { BatchItem,BatchReference } from '../../shared/ai-batch-contracts.ts';
import { resolvePurpose,listPurposeProfiles,savePurposeProfile,inheritLegacyPurposeSettings,reviewPurpose } from './purpose-routing.ts';
import { fieldPurposeGroups,beginFieldGroup,findFieldGroup,readFieldGroup,saveFieldGroup,groupFields } from './field-purpose-groups.ts';
import type { FieldPurposeAssignment,FieldGroupOperation } from './field-purpose-groups.ts';
import { assembleFieldOutputs } from '../listing-ai/group-output.ts';
import { parseFullGeneration,retainValidNativeCandidates } from '../listing-ai/full-schema.ts';
import { transaction } from '../application/transaction.ts';
import type {AiDurableRequestPort} from './durable-request.ts';
import {types} from 'node:util';
import { readAiUsageReport } from './usage-report.ts';
import { TEXT_MODEL_CAPABILITIES } from './model-capabilities.ts';
import { saveProviderReceipt,readProviderReceipt,confirmedAuthenticationRejection,confirmedLegacyRegionRejection,confirmedForbiddenRejection } from './receipts.ts';
import type { AiPurposeId,SaveAiPurposeInput,AiPurposeSnapshot } from '../../shared/ai-purpose-contracts.ts';
import { freezeSourceForProduct } from '../products/public.ts';
import { isSchemaTransientError } from '../amazon/schema-retry.ts';
import {validateListingContext} from '../listing-ai/validation.ts';
import {replayReferenceCandidates,sameRecoverySource} from '../listing-ai/candidate-recovery.ts';
import { parseImagePlanRecovery } from './image-validation.ts';
import { parseFunctionSettings } from "./primitives.ts";
import { resultHasOwner } from './result-owner.ts';
import { evidenceVersion, imageEvidenceVersion, isFullSchema } from "../listing-ai/native-values.ts";
import { assertPresentationResultOwner } from './presentation-history.ts';
import { readManagedImageSync } from './source.ts';
import type { SourceConsistencyContext } from '../../shared/source-image-consistency-contracts.ts';
import { resolveConsistencyContext } from "../source-image-consistency/scope.ts";
import { validateConsistencyContext, consistencyScopeKey } from "../source-image-consistency/contracts.ts";
import { consistencyAttemptUnknown,listConsistencyAttempts,canRetryConsistencyAuthentication,reserveConsistencyAttempt,recordConsistencyAssessment,recordRecoveredConsistency,latestConsistencyAttempt,MAX_SOURCE_ATTEMPTS,assertConsistencyHistory } from '../source-image-consistency/history.ts';
import { requestSourceConsistency } from '../source-image-consistency/adapter.ts';
import { createSourceReferenceAliases } from '../source-image-consistency/reference-aliases.ts';
import { recoverableSourceReceipt, assertSourceReceiptRecovery } from '../source-image-consistency/receipt-recovery.ts';
import { assertConsistencyView,readConsistencyView,readSourceObservationEvidence,saveConsistencyDecision,assertProductConsistency } from '../source-image-consistency/proof.ts';
import { allowSourceUnbound, readSourceImageReceipt } from '../source-images.ts';
import { assertStoredPricingForPaid } from '../amazon/pricing-guard.ts';
import { CompletionJournal } from '../listing-ai/completion-journal.ts';
import { assertCurrentCopyEvidence,assertCurrentImageCopyEvidence } from '../listing-ai/current-evidence.ts';
import { assertCurrentListingReview } from './image-validation.ts';
import type { CompletionRequest } from '../listing-ai/completion-journal.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AI_PROVIDER_IDS, TEXT_REVIEW_POLICY_VERSION } from '../../shared/ai-contracts.ts';
import { AI_VENDOR_FUNCTIONS, AI_VENDOR_IDS, aiVendorFor } from '../../shared/ai-connection-contracts.ts';
import type { AiConnection, AiVendorId } from '../../shared/ai-connection-contracts.ts';
import { credentialStatus } from '../../shared/credential-status.ts';
import type { AiCall, AiCapabilityInfo, AiProfile, AiProviderId, AiResult, AiUsagePolicy, AiUsageSummary, ContentSuggestionOutput, RecognizeImageInput, ReviewContentInput, SuggestContentInput, TextReviewOutput } from '../../shared/ai-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { HostedAsset } from '../../shared/hosting-contracts.ts';
import type { SecretStorage } from '../amazon/vault.ts';
import { openDatabase } from '../database.ts';
import { RecordReader } from '../record-query.ts';
import type { HostingService } from '../hosting/service.ts';
import type { StoredAsset, WorkspaceStore } from '../store.ts';
import { recognizeWithAliyun,parseAliyunOcr, segmentWithAidge, suggestWithDeepSeek } from './adapters.ts';
import type { AdapterResult, TextPayload } from './adapters.ts';
import { AiError, ImagePlanningLimitError, abortable, safeError, throwIfAborted } from './errors.ts';
import { AiRequestControl, requestKey } from './request-control.ts';
import { requestScope,legacyRequestScope,sameRequestBusiness } from './request-identity.ts';
import type { AiRequestScope } from '../../shared/ai-request-identity-contracts.ts';
import { localAiRequestResolved } from './request-certainty.ts';
import { readCallReceiptSync } from './receipts.ts';
import { openRouterFailure } from './adapters/openrouter-http.ts';
import { assertReceiptRecovery,verifiedRecoveryReceipt } from './receipt-recovery.ts';
import { AiUsageLedger } from './usage.ts';
import { readManagedImage, sameAsset, validateImage } from './source.ts';
import { emptyUsage } from './transport.ts';
import type { AdapterContext, ProviderMetadata } from './transport.ts';
import { AiVault } from './vault.ts';
import { assertCandidateEvidence, assertReviewEvidence, reviewWithDeepSeek, sourceFingerprint, suggestionFingerprint } from './review.ts';
import type { ReviewPayload } from './review.ts';
import { CAPABILITIES, MAX_OCR_TEXT, MODELS, boundedText, integer, isDeepSeek, isChatProvider, isGenerationProvider, isReviewProvider, keys, object, parseConnectionInput, parseProfileImport, parseRecognizeInput, parseReviewInput, parseSegmentInput, parseSuggestInput, providerId, uuid, validateAiProfile, vendorId } from "./primitives.ts";
import { protectedAttribute } from "./basic-output-validation.ts";
import { validateAiCall, validateAiResult, validateStoredAiResult } from "./validation.ts";
import type { AiCredentials, AliyunCredentials, DeepSeekCredentials, DeepSeekModel } from "./primitives.ts";
import type { ListingAiContext, ListingFieldsOutput } from '../../shared/listing-ai-contracts.ts';
import { reviewListingFields, suggestListingFields } from './listing-adapters.ts';
import { listingFingerprint } from "../json-fingerprint.ts";
import type { CandidateImageIdentity, CurrentListingCopy, ProductImageContext } from '../../shared/image-ai-contracts.ts';
import { PRODUCT_IMAGE_POLICY_VERSION, imageCopySourceIds } from '../../shared/image-ai-contracts.ts';
import { planProductImage, reviewCurrentListing, reviewProductImageText } from './image-adapters.ts';
import { imageRiskSourceSnapshot, validateCandidateImageIdentity, validateCurrentListingCopy, validateProductImageContext } from './image-validation.ts';
import { inspectRaster } from '../image-format.ts';
import { MAX_IMAGE_BYTES } from "./primitives.ts";
import type { DeepSeekReferenceImage } from './vision.ts';
import { reviewImageWithAliyun,parseAliyunRiskReply } from './aliyun-image-risk.ts';
import { categoryDecision } from './category-adapter.ts';
import type { CategoryDecision } from '../../shared/category-ai-contracts.ts';
import type { ProductTypeOption } from '../../shared/amazon-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { projectSalesProduct, validateSalesPlan } from '../sales-plans/records.ts';
import { referenceMeasurementEvidence } from '../image-workflow/image-facts.ts';
import { currentSourceImageMeasurements } from '../image-workflow/source-measurements.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import { recordInvalidAiOutput,readInvalidAiOutputs,hasRetainedInvalidAiOutput,imagePlanRetryForbidden } from './output-diagnostics.ts';
import type { AiOutputRejectionStage } from './output-diagnostics.ts';
import { readCopyReviewSettings } from '../listing-ai/review-settings.ts';
import { SOURCE_COLOR_POLICY_VERSION } from '../../shared/source-color-contracts.ts';
import type { SourceColorContext, SourceColorOutput } from '../../shared/source-color-contracts.ts';
import { validateSourceColorContext } from './source-color-validation.ts';
import { observeSourceColor as requestSourceColor } from './source-color-adapter.ts';
import { selectImageReferences } from "../assets/reference-selection.ts";

export interface AiDependencies {
  /** M09 main-only pin adapter. No renderer URLs or inline images enter Batch directly. */
  batchReferences?:{
    prepare(body:Record<string,unknown>,owner:{taskId:string;operationId:string;productId:string;productRevision:number},signal?:AbortSignal):Promise<{body:Record<string,unknown>;references:BatchReference[]}>;
    validate(reference:BatchReference):boolean;
  };
  fetch?: typeof fetch; now?: () => Date; timeoutMs?: number; maxConcurrency?: number; maxResponseBytes?: number; nonce?: () => string;
  imageGenerationCapability?: () => AiCapabilityInfo;
}
interface PreparedRequest {
  categoryContext?:AiCall['categoryContext'];
  categoryRepairPriors?:AiCall[];
  categoryPriorSnapshot?:string;
  forbiddenRetry?:{prior:AiCall;scopeKey:string};
  imagePlanRequestSha256?:string;
  imagePlanRepair?:{previousPlanId:string;issues:string[]};
  workflowId?:string;
  variantId: string | null; assetId: string | null; assetSha256: string | null; sourceResultIds: string[];
  sourceSha256?: string;
  listingContext?: ListingAiContext;
  imageContext?: ProductImageContext;
  sourceColorContext?: SourceColorContext;
  sourceConsistencyContext?: SourceConsistencyContext;
  sourceReferenceAliases?: AiCall['sourceReferenceAliases'];
  recoverRequestBytes?:number;
  recoverReceipt?(body:unknown,context:AdapterContext):AdapterResult;
  invoke(credentials: AiCredentials, context: AdapterContext): Promise<AdapterResult>;
  assertFresh(): Promise<void>;
  assertBeforeSend?(): void;
}
interface DurableFieldCall {
  id?:string;assignments?:FieldPurposeAssignment[];part?:NonNullable<AiResult['fieldGroupPart']>;
  sent?:(call:AiCall)=>void;result?:(result:AiResult)=>void;
}
type TextSnapshot = { payload: TextPayload; sources: { result: AiResult; asset: StoredAsset }[] };
type StoredSuggestion = AiResult & { variantId: string; sourceSha256: string; output: ContentSuggestionOutput };
export interface ReviewedContentSource {
  suggestion: StoredSuggestion; review: AiResult & { output: TextReviewOutput };
  /** Synchronous revalidation for a local write transaction after the image-byte checks. */
  assertFresh(): void;
}

/** Main-process provider boundary. It persists suggestions and calls, never source facts or listing drafts. */
export class AiService {
  private batchReferences?:AiDependencies['batchReferences'];
  private pendingReceipts=new Set<Promise<unknown>>();
  readonly batchTasks:TaskBatchRuntime;
  readonly completionJournal: CompletionJournal;
  private directory: string;
  private store: WorkspaceStore;
  private hosting: HostingService;
  private vault: AiVault;
  private db: DatabaseSync;
  private records: RecordReader;
  private context: AdapterContext;
  private requests: AiRequestControl;
  private usage: AiUsageLedger;
  private closed = false;
  private closing?: Promise<void>;
  private imageGenerationCapability?: () => AiCapabilityInfo;
  private thinkingTimeoutMs: number;
  constructor(directory: string, store: WorkspaceStore, hosting: HostingService, storage: SecretStorage, dependencies: AiDependencies = {}) {
    this.imageGenerationCapability = dependencies.imageGenerationCapability;this.batchReferences=dependencies.batchReferences;
    this.thinkingTimeoutMs=integer(dependencies.timeoutMs??300000,1,600000);
    this.directory = directory; this.store = store; this.hosting = hosting; this.vault = new AiVault(directory, storage);
    this.requests = new AiRequestControl(integer(dependencies.maxConcurrency ?? 2, 1, 8), integer(dependencies.timeoutMs ?? 120000, 1, 600000));
    this.context = { fetch: dependencies.fetch ?? globalThis.fetch, now: dependencies.now ?? (() => new Date()), nonce: dependencies.nonce ?? randomUUID, maxResponseBytes: integer(dependencies.maxResponseBytes ?? 2 * 1024 * 1024, 1024, 16 * 1024 * 1024) };
    this.db = openDatabase(directory);
    this.completionJournal = new CompletionJournal(this.db,this.directory);
    this.batchTasks=new TaskBatchRuntime(this.db,directory,{validateReference:reference=>this.batchReferences?.validate(reference)===true,fetch:(...args)=>this.context.fetch(...args),credential:()=>({apiKey:this.openRouterApiKey()??'',scope:requestKey({provider:'openrouter',generation:this.getProfile('openrouter').generation})})});
    this.records = new RecordReader(this.db);
    this.usage = new AiUsageLedger(this.db, this.context.now);
    try {
      const addImageRisk=!this.db.prepare('SELECT id FROM ai_profiles WHERE id=?').get('aliyun-image-risk');
      for (const id of AI_PROVIDER_IDS) {
        if (!this.db.prepare('SELECT id FROM ai_profiles WHERE id=?').get(id)) this.saveProfile({ id, capability: CAPABILITIES[id], model: MODELS[id], enabled: false, configured: false, generation: 0 });
        // Validate metadata without persisting transient vault availability.
        this.storedProfile(id);
      }
      if(addImageRisk) {
        const source=this.getProfile('aliyun-ocr');
        if(source.configured) {
          const credentials=this.vault.read(source.id,source.generation),profile=this.storedProfile('aliyun-image-risk');
          this.commitProfiles([{profile:{...profile,configured:true,enabled:source.enabled,generation:1},credentials}]);
        }
      }
      for (const call of this.records.list('ai_calls', { status: 'RUNNING' }, validateAiCall)) this.saveCall({ ...call, status: 'FAILED', errorCode: 'INTERRUPTED', finishedAt: this.finishedAt(call.startedAt) });
      this.usage.recoverPending();
    } catch (error) { this.db.close(); throw safeError(error); }
  }
  private ensureOpen(): void { if (this.closed) throw new AiError('SERVICE_CLOSED'); }
  private timestamp(): string { return this.usage.timestamp(); }
  private finishedAt(start: string): string { try { return [this.timestamp(), start].sort()[1]; } catch { return start; } }
  getUsagePolicy(id: string): AiUsagePolicy { this.ensureOpen(); return this.usage.getPolicy(id); }
  setUsagePolicy(raw: unknown): AiUsagePolicy { this.ensureOpen(); return this.usage.setPolicy(raw); }
  getUsageSummary(id: string): AiUsageSummary { this.ensureOpen(); return this.usage.summary(id); }
  get busy(): boolean { return this.requests.busy; }
  private saveProfile(profile: AiProfile): void { const parsed = validateAiProfile(profile); try { this.db.prepare('INSERT INTO ai_profiles(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(parsed.id, JSON.stringify(parsed)); } catch { throw new AiError('INVALID_CONFIG'); } }
  private saveCall(call: AiCall): AiCall { const parsed = validateAiCall(call); try { this.db.prepare('INSERT INTO ai_calls(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(parsed.id, JSON.stringify(parsed)); return parsed; } catch { throw new AiError('PROVIDER_ERROR'); } }
  private storedProfile(rawId: string): AiProfile {
    this.ensureOpen(); const id = providerId(rawId);
    try {
      const row = this.db.prepare('SELECT record_json FROM ai_profiles WHERE id=?').get(id); if (!row) throw new AiError('INVALID_CONFIG');
      const profile = validateAiProfile(JSON.parse(String(row.record_json))); if (profile.id !== id) throw new AiError('INVALID_CONFIG');
      return profile;
    } catch (error) { throw error instanceof AiError ? error : new AiError('INVALID_CONFIG'); }
  }
  getProfile(rawId: string): AiProfile {
    const profile = this.storedProfile(rawId);
    // Runtime availability never replaces persisted user intent or restores disconnected credentials.
    const configured = profile.configured && this.vault.has(profile.id, profile.generation);
    return { ...profile, configured, enabled: profile.enabled && configured };
  }
  listProfiles(): AiProfile[] { this.ensureOpen(); return AI_PROVIDER_IDS.map(id => this.getProfile(id)); }
  private connection(id: AiVendorId): AiConnection {
    const stored = AI_VENDOR_FUNCTIONS[id].map(role => this.storedProfile(role));
    const inspected = stored.map(profile => this.vault.inspect(profile.id, profile.generation));
    const credentials = stored.map((profile, index) => ({ id: profile.id, ...credentialStatus(inspected[index].state, profile.configured, profile.enabled) }));
    const profiles = stored.map((profile, index) => { const configured = profile.configured && inspected[index].state === 'readable'; return { ...profile, configured, enabled: profile.enabled && configured }; });
    const configured = profiles.filter(profile => profile.configured);
    let state: AiConnection['state'] = configured.length ? 'partial' : 'unconfigured';
    if (configured.length === profiles.length) {
      // Compare normalized secrets only inside the main process; never expose them or a fingerprint.
      const values = inspected.map(result => result.state === 'readable' ? JSON.stringify(result.credentials) : null);
      state = values.every(value => value === values[0]) ? 'shared' : 'separate';
    }
    return { id, state, profiles, credentials };
  }
  listConnections(): AiConnection[] { this.ensureOpen(); return AI_VENDOR_IDS.map(id => this.connection(id)); }
  connectionTemplate(rawId: unknown): Record<string, string> {
    this.ensureOpen(); const id = vendorId(rawId);
    return id !== 'aliyun' ? { id, apiKey: '' } : { id, accessKeyId: '', accessKeySecret: '', securityToken: '' };
  }
  /** No asynchronous work can observe the intermediate vault/profile state. */
  private commitProfiles(changes: { profile: AiProfile; credentials?: AiCredentials | null }[],credentialUpdate?:readonly AiProviderId[]): void {
    const undo: (() => void)[] = []; let transaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      for (const { profile, credentials } of changes) {
        if (credentials !== undefined) undo.push(credentials === null ? this.vault.remove(profile.id) : this.vault.write(profile.id, credentials, profile.generation));
      }
      for (const { profile } of changes) this.saveProfile(profile);
      if(credentialUpdate!==undefined)appendAuditEvent(this.db,randomUUID(),null,'ai.credentials.updated','已更新供应商凭据（不含密钥）',JSON.stringify({changed:credentialUpdate.length>0,profiles:changes.map(({profile})=>({id:profile.id,generation:profile.generation,changed:credentialUpdate.includes(profile.id)}))}),this.timestamp());
      this.db.exec('COMMIT'); transaction = false;
    } catch (error) {
      let rollbackFailed = false;
      if (transaction) try { this.db.exec('ROLLBACK'); } catch { rollbackFailed = true; }
      for (const rollback of undo.reverse()) try { rollback(); } catch { rollbackFailed = true; }
      if (rollbackFailed) throw new AiError('INVALID_CONFIG');
      throw error instanceof AiError ? error : new AiError('INVALID_CONFIG');
    }
  }
  private saveSharedConnection(id: AiVendorId, credentials: AiCredentials, functionModel?: { id: AiProviderId; model: string }): AiConnection {
    const credentialChanged=AI_VENDOR_FUNCTIONS[id].filter(role=>{const previous=this.storedProfile(role),old=this.vault.inspect(role,previous.generation);return old.state!=='readable'||JSON.stringify(old.credentials)!==JSON.stringify(credentials);});
    const changes = AI_VENDOR_FUNCTIONS[id].map(role => {
      const previous = this.storedProfile(role), model = functionModel?.id === role ? functionModel.model : previous.model;
      // Check the same credential against each role's public fields before writing either file.
      const checked = parseProfileImport({ id: role, ...(isChatProvider(role) ? { model } : {}), ...credentials });
      const profile = { ...previous, model, configured: true, generation: integer(previous.generation + 1, 1, Number.MAX_SAFE_INTEGER - 1) };
      return { profile, credentials: checked.credentials };
    });
    this.commitProfiles(changes,credentialChanged);
    for (const { profile } of changes) this.cancel(profile.id, new AiError('CONFIG_CHANGED'));
    return this.connection(id);
  }
  saveConnection(raw: unknown): AiConnection {
    this.ensureOpen(); const input = parseConnectionInput(raw); return this.saveSharedConnection(input.id, input.credentials);
  }
  reuseConnection(raw: unknown): AiConnection {
    this.ensureOpen(); const o = keys(raw, ['id', 'sourceId']), id = vendorId(o.id), sourceId = providerId(o.sourceId);
    if (!AI_VENDOR_FUNCTIONS[id].includes(sourceId)) throw new AiError('INVALID_INPUT');
    const source = this.getProfile(sourceId); if (!source.configured) throw new AiError('NOT_CONFIGURED');
    return this.saveSharedConnection(id, this.vault.read(sourceId, source.generation));
  }
  importConnectionConfig(raw: unknown): AiConnection {
    this.ensureOpen(); const o = object(raw);
    if (o.id === 'aliyun' || (['deepseek','openrouter'].includes(String(o.id)) && !Object.hasOwn(o, 'model'))) return this.saveConnection(raw);
    const input = parseProfileImport(raw);
    return this.saveSharedConnection(aiVendorFor(input.id), input.credentials, { id: input.id, model: input.model });
  }
  saveFunctionSettings(raw: unknown): AiConnection {
    this.ensureOpen(); const o = parseFunctionSettings(raw), { id, model } = o;
    const previous = this.storedProfile(id); if (o.enabled && !this.getProfile(id).configured) throw new AiError('NOT_CONFIGURED');
    const thinking = o.thinking===undefined ? previous.thinking : o.thinking as boolean;
    const modelChanged = model !== previous.model || !!thinking !== !!previous.thinking;
    const profile = { ...previous, model, ...(thinking===undefined?{}:{thinking}), enabled: o.enabled, generation: modelChanged ? integer(previous.generation + 1, 1, Number.MAX_SAFE_INTEGER - 1) : previous.generation };
    let credentials: AiCredentials | undefined;
    if (modelChanged && previous.configured) {
      credentials = this.vault.read(id, previous.generation);
      parseProfileImport({ id, ...(isChatProvider(id) ? { model } : {}), ...credentials });
    }
    this.commitProfiles([{ profile, credentials }]);
    if(isDeepSeek(id)&&modelChanged)inheritLegacyPurposeSettings(this.db,id,model,!!thinking);
    if (modelChanged) this.cancel(id, new AiError('CONFIG_CHANGED')); else if (!profile.enabled) this.cancel(id, new AiError('DISABLED'));
    return this.connection(aiVendorFor(id));
  }
  disconnectConnection(rawId: unknown): AiConnection {
    this.ensureOpen(); const id = vendorId(rawId), changes = AI_VENDOR_FUNCTIONS[id].map(role => {
      const previous = this.storedProfile(role);
      return { profile: { ...previous, enabled: false, configured: false, generation: integer(previous.generation + 1, 1, Number.MAX_SAFE_INTEGER - 1) }, credentials: null };
    });
    this.commitProfiles(changes);
    for (const { profile } of changes) this.cancel(profile.id, new AiError('CONFIG_CHANGED'));
    return this.connection(id);
  }
  capabilities(): AiCapabilityInfo[] {
    return [...this.listProfiles().map(profile => ({ capability: profile.capability, providerId: profile.id, available: profile.configured && profile.enabled, reason: profile.configured && profile.enabled ? null : profile.configured ? '接口尚未启用' : '尚未配置有效凭据' })), this.imageGenerationCapability?.() ?? { capability: 'image-generation', providerId: null, available: false, reason: '图片生成接口尚未接入' }];
  }
  template(rawId: string): Record<string, string> {
    this.ensureOpen(); const id = providerId(rawId);
    return isChatProvider(id) ? { id, model: MODELS[id], apiKey: '' } : { id, accessKeyId: '', accessKeySecret: '', securityToken: '' };
  }
  importProfile(raw: unknown): AiProfile {
    this.ensureOpen(); const input = parseProfileImport(raw), previous = this.getProfile(input.id), generation = integer(previous.generation + 1, 1, Number.MAX_SAFE_INTEGER - 1);
    const rollback = this.vault.write(input.id, input.credentials, generation);
    try { this.saveProfile({ id: input.id, capability: CAPABILITIES[input.id], model: input.model, enabled: false, configured: true, generation }); }
    catch (error) { rollback(); throw safeError(error); }
    if(isDeepSeek(input.id))inheritLegacyPurposeSettings(this.db,input.id,input.model,false);
    this.cancel(input.id, new AiError('CONFIG_CHANGED')); return this.getProfile(input.id);
  }
  setEnabled(raw: unknown): AiProfile {
    this.ensureOpen(); const o = keys(raw, ['id', 'enabled']), id = providerId(o.id); if (typeof o.enabled !== 'boolean') throw new AiError('INVALID_INPUT');
    const profile = this.storedProfile(id); if (o.enabled && !this.getProfile(id).configured) throw new AiError('NOT_CONFIGURED');
    this.saveProfile({ ...profile, enabled: o.enabled }); if (!o.enabled) this.cancel(id, new AiError('DISABLED')); return this.getProfile(id);
  }
  disconnect(rawId: string): AiProfile {
    this.ensureOpen(); const id = providerId(rawId), profile = this.getProfile(id), generation = integer(profile.generation + 1, 1, Number.MAX_SAFE_INTEGER - 1), rollback = this.vault.remove(id);
    try { this.saveProfile({ ...profile, enabled: false, configured: false, generation }); } catch (error) { rollback(); throw safeError(error); }
    this.cancel(id, new AiError('CONFIG_CHANGED')); return this.getProfile(id);
  }
  private cancel(id: AiProviderId, reason: AiError): void { this.requests.cancel(id, reason); }
  private assertProfile(id: AiProviderId, generation?: number): AiProfile {
    const profile = this.getProfile(id);
    if (generation !== undefined && profile.generation !== generation) throw new AiError('CONFIG_CHANGED');
    if (!profile.configured) throw new AiError('NOT_CONFIGURED'); if (!profile.enabled) throw new AiError('DISABLED'); return profile;
  }
  listCalls(): AiCall[] { this.ensureOpen(); return this.records.list('ai_calls', {}, validateAiCall); }
  private readPresentationResult=(raw:unknown):AiResult=>{const result=validateStoredAiResult(raw);if(result.sourceConsistencyContext)assertSourceReceiptRecovery(this.db,this.directory,result,this.getCall(result.callId));assertReceiptRecovery(this.db,this.directory,result,this.getCall(result.callId));assertPresentationResultOwner(result,this.getCall(result.callId),this.db);return result;};
  listResults(rawProductId: string): AiResult[] { this.ensureOpen(); return this.records.list('ai_results', { productId: uuid(rawProductId) }, this.readPresentationResult); }
  getCall(id: string): AiCall | undefined { this.ensureOpen(); return this.records.get('ai_calls', id, validateAiCall); }
  /** Main-only local derivative of an already paid, retained field response. */
  recoverFieldCandidates(sourceId:string,rawContext:ListingAiContext):AiResult|undefined {
    const context=validateListingContext(rawContext),original=this.getResult(sourceId),call=original&&this.getCall(original.callId);
    if(!original||original.fieldCandidateRecovery||original.localRecovery||original.output.kind!=='amazon-fields'||!original.listingContext||call?.status!=='SUCCEEDED'||!resultHasOwner(original,call)||!sameRecoverySource(original.listingContext,context))return;
    const originalOutput=original.output,output=replayReferenceCandidates(originalOutput,context);
    if(!output.candidates.some(c=>!originalOutput.candidates.some(old=>old.field===c.field)))return;
    const sourceSha256=listingFingerprint(context),originalSha256=listingFingerprint(original);
    const prior=this.listResults(original.productId).find(r=>r.fieldCandidateRecovery?.originalSha256===originalSha256&&r.sourceSha256===sourceSha256);if(prior)return prior;
    const {fieldRejections:_r,fieldGroupAssembly:_assembly,...base}=original;
    const result=validateStoredAiResult({...base,id:randomUUID(),sourceResultIds:[original.id],output,listingContext:context,sourceSha256,fieldCandidateRecovery:{parserVersion:'field-reference-recovery/v1',originalResult:original,originalSha256,recoveredAt:new Date().toISOString()}});
    this.db.prepare('INSERT INTO ai_results(id,record_json) VALUES(?,?)').run(result.id,JSON.stringify(result));return result;
  }
  getResult(id: string): AiResult | undefined { this.ensureOpen(); return this.records.get('ai_results', id, this.readPresentationResult); }
  queryCalls(raw: unknown) { this.ensureOpen(); return this.records.query('ai_calls', raw, validateAiCall); }
  queryResults(raw: unknown) { this.ensureOpen(); return this.records.query('ai_results', raw, this.readPresentationResult); }
  private product(productId: string, revision: number): ProductDetail {
    try { const product = this.store.getProduct(productId); if (product.revision !== revision) throw new AiError('SOURCE_CHANGED'); return product; }
    catch { throw new AiError('SOURCE_CHANGED'); }
  }
  private source(input: RecognizeImageInput, segmentation = false): StoredAsset {
    const product = this.product(input.productId, input.productRevision), asset = this.store.getAssetRecord(input.assetId);
    if (!asset || asset.productId !== input.productId || !product.assets.some(image => image.id === input.assetId)) throw new AiError('SOURCE_CHANGED');
    validateImage(asset, segmentation); return asset;
  }
  private async readSource(input: RecognizeImageInput, asset: StoredAsset, signal: AbortSignal, segmentation = false): Promise<Buffer> {
    throwIfAborted(signal); if (!sameAsset(this.source(input, segmentation), asset)) throw new AiError('SOURCE_CHANGED');
    const bytes = await readManagedImage(this.directory, asset, signal); throwIfAborted(signal);
    if (!sameAsset(this.source(input, segmentation), asset)) throw new AiError('SOURCE_CHANGED'); return bytes;
  }
  async recognize(raw: unknown, signal?: AbortSignal, assertBeforeSend?:()=>void): Promise<AiResult> {
    this.ensureOpen(); const input = parseRecognizeInput(raw), profile = this.assertProfile('aliyun-ocr'), asset = this.source(input);
    return this.start(profile, input, { asset }, async activeSignal => {
      const bytes = await this.readSource(input, asset, activeSignal);
      return { variantId: null, assetId: asset.id, assetSha256: asset.sha256, sourceResultIds: [], assertBeforeSend, invoke: (credentials, context) => recognizeWithAliyun(bytes, asset, credentials as AliyunCredentials, activeSignal, context), assertFresh: async () => { await this.readSource(input, asset, activeSignal); } };
    }, signal);
  }
  private hosted(id: string, asset: StoredAsset, previous?: HostedAsset): HostedAsset {
    try {
      const row = this.hosting.listUploads().find(upload => upload.id === id); if (!row) throw new Error();
      const profile = this.hosting.getProfile(row.profileId);
      if (row.status !== 'AVAILABLE' || row.assetId !== asset.id || row.sha256 !== asset.sha256 || row.byteSize !== asset.byteSize || row.mimeType !== asset.mimeType || !profile.enabled || !profile.configured || profile.generation !== row.generation || (previous && (previous.profileId !== row.profileId || previous.generation !== row.generation || previous.publicUrl !== row.publicUrl))) throw new Error();
      return row;
    } catch { throw new AiError('HOSTED_IMAGE_REQUIRED'); }
  }
  async segment(raw: unknown, signal?: AbortSignal): Promise<AiResult> {
    this.ensureOpen(); const input = parseSegmentInput(raw), profile = this.assertProfile('aidge-segmentation'), asset = this.source(input, true), hosted = this.hosted(input.hostedAssetId, asset);
    return this.start(profile, input, { asset, hosted }, async activeSignal => {
      await this.readSource(input, asset, activeSignal, true); throwIfAborted(activeSignal);
      try { await abortable(this.hosting.verify(hosted.id, activeSignal), activeSignal); } catch { throwIfAborted(activeSignal); throw new AiError('HOSTED_IMAGE_REQUIRED'); }
      throwIfAborted(activeSignal); this.hosted(hosted.id, asset, hosted); await this.readSource(input, asset, activeSignal, true);
      throwIfAborted(activeSignal); this.hosted(hosted.id, asset, hosted);
      return { variantId: null, assetId: asset.id, assetSha256: asset.sha256, sourceResultIds: [], invoke: (credentials, context) => segmentWithAidge(hosted.publicUrl, asset, credentials as AliyunCredentials, activeSignal, context), assertFresh: async () => { await this.readSource(input, asset, activeSignal, true); throwIfAborted(activeSignal); this.hosted(hosted.id, asset, hosted); } };
    }, signal);
  }
  private textPayload(input: SuggestContentInput): TextSnapshot {
    const product = this.product(input.productId, input.productRevision), variant = product.variants.find(v => v.id === input.variantId);
    if (!variant) throw new AiError('SOURCE_CHANGED');
    const sources = input.ocrResultIds.map(id => {
      const result = this.getResult(id);
      if (!result || result.productId !== input.productId || result.output.kind !== 'ocr' || result.productRevision !== input.productRevision || !result.assetId || !result.assetSha256) throw new AiError('SOURCE_CHANGED');
      const asset = this.source({ ...input, assetId: result.assetId });
      const image = product.assets.find(image => image.id === asset.id), binding = this.db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=? AND variant_id=?').get(asset.id, variant.id);
      if (asset.sha256 !== result.assetSha256 || !image?.variantIds.includes(variant.id) || binding?.confirmed !== 1) throw new AiError('SOURCE_CHANGED');
      return { result, asset };
    });
    const payload: TextPayload = {
      productId: product.id, sourceTitle: boundedText(product.title, 500), variant: { id: variant.id, originalSpec: boundedText(variant.originalSpec, 2000, true), normalizedSpec: boundedText(variant.normalizedSpec, 2000, true) },
      confirmedFacts: factsForVariant(product,variant.id).filter(f => ['source_confirmed', 'human_confirmed'].includes(f.state) && f.value.trim() && !protectedAttribute(f.name)).map(f => ({ id: f.id, name: boundedText(f.name, 100), value: boundedText(f.value, 4000) })),
      unverifiedOcr: sources.map(({ result, asset }) => ({ resultId: result.id, assetId: asset.id, assetSha256: asset.sha256, text: result.output.kind === 'ocr' ? result.output.text : '', verified: false })),
    };
    if (payload.unverifiedOcr.reduce((size, row) => size + row.text.length, 0) > MAX_OCR_TEXT) throw new AiError('INVALID_INPUT');
    return { payload, sources };
  }
  async suggest(raw: unknown, signal?: AbortSignal): Promise<AiResult> {
    this.ensureOpen(); const input = parseSuggestInput(raw), profile = this.purposeProfile('listing_generation'), snapshot = this.textPayload(input);
    return this.start(profile, input, snapshot, async activeSignal => {
      const assertFresh = () => this.assertTextFresh(input, snapshot, activeSignal);
      await assertFresh();
      return { variantId: input.variantId, assetId: null, assetSha256: null, sourceResultIds: input.ocrResultIds, sourceSha256: sourceFingerprint(snapshot.payload), invoke: (credentials, context) => suggestWithDeepSeek(snapshot.payload, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, context), assertFresh };
    }, signal);
  }
  private async assertTextFresh(input: SuggestContentInput, snapshot: TextSnapshot, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (JSON.stringify(this.textPayload(input)) !== JSON.stringify(snapshot)) throw new AiError('SOURCE_CHANGED');
    for (const { asset } of snapshot.sources) await this.readSource({ productId: input.productId, productRevision: input.productRevision, assetId: asset.id }, asset, signal);
    throwIfAborted(signal); this.ensureOpen();
    if (JSON.stringify(this.textPayload(input)) !== JSON.stringify(snapshot)) throw new AiError('SOURCE_CHANGED');
  }
  private successfulResult(result: AiResult): void {
    const call = this.getCall(result.callId);
    if (!call || !resultHasOwner(result,call) || call.providerId !== result.providerId || call.productId !== result.productId || call.productRevision !== result.productRevision || call.model !== result.model) throw new AiError('SOURCE_CHANGED');
  }
  private reviewSnapshot(input: ReviewContentInput): { suggestion: StoredSuggestion; snapshot: TextSnapshot; textInput: SuggestContentInput; payload: ReviewPayload } {
    const result = this.getResult(input.suggestionResultId);
    if (!result || result.productId !== input.productId || !isGenerationProvider(result.providerId) || result.output.kind !== 'text' || !result.variantId || !result.sourceSha256 || result.productRevision !== input.productRevision) throw new AiError('SOURCE_CHANGED');
    this.successfulResult(result);
    const textInput = { productId: input.productId, productRevision: input.productRevision, variantId: result.variantId, ocrResultIds: result.sourceResultIds }, snapshot = this.textPayload(textInput);
    if (sourceFingerprint(snapshot.payload) !== result.sourceSha256) throw new AiError('SOURCE_CHANGED');
    assertCandidateEvidence(result.output, snapshot.payload);
    return { suggestion: result as StoredSuggestion, snapshot, textInput, payload: { ...snapshot.payload, suggestionId: result.id, suggestionSha256: suggestionFingerprint(result.output), policyVersion: TEXT_REVIEW_POLICY_VERSION, candidate: result.output } };
  }
  async review(raw: unknown, signal?: AbortSignal): Promise<AiResult> {
    this.ensureOpen(); const input = parseReviewInput(raw), profile = this.purposeProfile('copy_review',false,true), prepared = this.reviewSnapshot(input);
    return this.start(profile, input, prepared, async activeSignal => {
      const assertFresh = async () => {
        throwIfAborted(activeSignal);
        if (JSON.stringify(this.reviewSnapshot(input)) !== JSON.stringify(prepared)) throw new AiError('SOURCE_CHANGED');
        await this.assertTextFresh(prepared.textInput, prepared.snapshot, activeSignal);
        if (JSON.stringify(this.reviewSnapshot(input)) !== JSON.stringify(prepared)) throw new AiError('SOURCE_CHANGED');
      };
      await assertFresh();
      return { variantId: prepared.suggestion.variantId, assetId: null, assetSha256: null, sourceResultIds: [prepared.suggestion.id], invoke: (credentials, context) => reviewWithDeepSeek(prepared.payload, prepared.suggestion.sourceSha256, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, context), assertFresh };
    }, signal);
  }
  /** Local adoption gate. It performs no network calls and grants no source-fact or listing-draft writes. */
  async reviewedContent(raw: unknown): Promise<ReviewedContentSource> {
    this.ensureOpen();
    let input: { productId: string; productRevision: number; reviewResultId: string };
    try { const o = keys(raw, ['productId', 'productRevision', 'reviewResultId']); input = { productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), reviewResultId: uuid(o.reviewResultId) }; }
    catch { throw new AiError('INVALID_INPUT'); }
    const read = () => {
      this.ensureOpen();
      const review = this.getResult(input.reviewResultId);
      if (!review || review.productId !== input.productId || !isReviewProvider(review.providerId) || review.output.kind !== 'text-review' || review.productRevision !== input.productRevision || review.output.verdict !== 'PASS') throw new AiError('OUTPUT_INVALID');
      this.successfulResult(review);
      const prepared = this.reviewSnapshot({ productId: input.productId, productRevision: input.productRevision, suggestionResultId: review.output.suggestionId });
      if (review.variantId !== prepared.suggestion.variantId || review.sourceResultIds.length !== 1 || review.sourceResultIds[0] !== prepared.suggestion.id) throw new AiError('SOURCE_CHANGED');
      assertReviewEvidence(review.output, prepared.payload, prepared.suggestion.sourceSha256);
      return { review: review as AiResult & { output: TextReviewOutput }, ...prepared };
    };
    const prepared = read(), assertFresh = () => { if (JSON.stringify(read()) !== JSON.stringify(prepared)) throw new AiError('SOURCE_CHANGED'); };
    await this.assertTextFresh(prepared.textInput, prepared.snapshot, new AbortController().signal); assertFresh();
    return { suggestion: prepared.suggestion, review: prepared.review, assertFresh };
  }
  private assertListingSource(context:ListingAiContext):void {
    const row=this.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(context.draftId),draft=row?(JSON.parse(String(row.record_json)) as {draft:AmazonDraft}).draft:null;
    if(!draft||draft.productId!==context.productId||draft.variantId!==context.variantId)throw new AiError('SOURCE_CHANGED');
    this.product(context.productId,context.productRevision);this.store.assertSourceConsistency(context.productId,draft.salesPlan?.recipe.components.map(c=>c.variantId)??[context.variantId]);
  }
  /** Trusted main-process entry only. Shares credentials, request control and usage accounting. */
  async listingFields(context: ListingAiContext, assertContextFresh: () => Promise<void>, review?: { suggestionId: string; candidate: ListingFieldsOutput }, signal?: AbortSignal, completion?:CompletionRequest, freshCompleted=false): Promise<AiResult> {
    this.ensureOpen();this.assertListingSource(context);
    if(review){const source=this.getResult(review.suggestionId);if(!source||source.output.kind!=='amazon-fields'||source.sourceSha256!==listingFingerprint(context)||listingFingerprint(source.output)!==listingFingerprint(review.candidate))throw new AiError('SOURCE_CHANGED');}
    // Only an explicit standalone recheck starts a new completed chain; task and Completion replays keep their paid identity.
    if(review)return runCopyReview(this.db,{contextHash:listingFingerprint(context),scope:{suggestionId:review.suggestionId},completion,signal,freshCompleted:freshCompleted&&!completion&&!taskAiContext.getStore(),canResume:id=>this.canResumeCopyReview(id),fresh:assertContextFresh,snapshot:()=>this.activePurpose('copy_review',false,true).routing!,budget:()=>{if(completion)this.completionJournal.assertUpgradeBudget(completion);},link:result=>{if(completion)this.completionJournal.linkReviewUpgrade(completion,result);},invoke:(routing,hooks,request)=>this.listingFieldsOnce(context,assertContextFresh,this.frozenReviewProfile(routing),review,signal,request,hooks)});
    const groups=fieldPurposeGroups(this.db,context,!!completion),existing=findFieldGroup(this.db,context,completion?.callId);
    if(!existing&&groups.length===1)return this.listingFieldsOnce(context,assertContextFresh,this.frozenPurposeProfile(groups[0].purpose),undefined,signal,completion,{assignments:groups[0].assignments});
    if(!groups.length)throw new AiError('INVALID_INPUT');
    const operation=existing??beginFieldGroup(this.db,context,groups,completion?.callId);
    return this.runFieldGroups(operation,context,assertContextFresh,signal,completion);
  }
  hasListingFieldGroup(callId:string):boolean{return !!readFieldGroup(this.db,callId);}
  hasPendingCopyReview(resultId:string):boolean{const result=this.getResult(resultId);if(!result)return false;const op=readCopyReview(this.db,result.callId);if(!op)return false;if(copyReviewResult(this.db,op)?.id!==result.id)throw new UserFacingError('文案复核升级链归属不一致');return !!copyReviewReason(result)&&!copyReviewResult(this.db,op,true);}
  private canResumeCopyReview(callId:string):boolean{return !!(this as unknown as {batchTasks?:{find(id:string):unknown}}).batchTasks?.find(callId);}
  private frozenReviewProfile(routing:AiPurposeSnapshot):AiProfile{
    if(!routing.capability.json||routing.capability.endpoint==='decisions')throw new UserFacingError('本次冻结的文案升级目标不支持聊天JSON复核');
    const id:AiProviderId=routing.gateway==='openrouter'?'openrouter-review':'deepseek-review';let profile:AiProfile;try{profile=this.assertProfile(id);}catch{throw new UserFacingError(`本次冻结文案复核目标 ${routing.gateway} / ${routing.model} 未配置或未启用，未切换渠道`);}
    return {...profile,model:routing.model,thinking:!['none','not_applicable'].includes(routing.effectiveEffort),routing};
  }
  private frozenPurposeProfile(routing:AiPurposeSnapshot):AiProfile{
    const id:AiProviderId=routing.gateway==='openrouter'?'openrouter':'deepseek',profile=this.assertProfile(id);
    return{...profile,model:routing.model,thinking:!['none','not_applicable'].includes(routing.effectiveEffort),routing};
  }
  private async runFieldGroups(initial:FieldGroupOperation,context:ListingAiContext,assertFresh:()=>Promise<void>,signal?:AbortSignal,completion?:CompletionRequest):Promise<AiResult>{
    await assertFresh();signal?.throwIfAborted();
    let operation=readFieldGroup(this.db,initial.id)!;assertFieldGroupHistory(this.db,initial.id);
    if(operation.resultId){const result=this.getResult(operation.resultId);if(!result)throw new AiError('SOURCE_CHANGED');return result;}
    for(const member of operation.members)if(!member.sent)this.frozenPurposeProfile(member.purpose);
    const all=operation.members.flatMap(m=>m.assignments);
    for(let index=0;index<operation.members.length;index++){
      operation=readFieldGroup(this.db,initial.id)!;const member=operation.members[index];
      if(member.resultId){const saved=this.getResult(member.resultId);if(!saved)throw new AiError('SOURCE_CHANGED');continue;}
      let retryOf:AiCall|undefined;
      if(member.sent&&!this.batchTasks.find(fieldGroupCallId(member))){
        const recovered=await this.recoverGroupedField(operation,index,context);
        if(recovered)continue;
        const prior=this.getCall(fieldGroupCallId(member));
        if(!prior||!confirmedForbiddenRejection(this.db,prior)){const error=new AiError('INTERRUPTED');error.message=`字段分组 ${member.assignments.map(a=>a.field).join('、')} 的原请求尚未完成本地回收；已保留成果和费用，未复制重发`;throw error;}
        assertConfirmedForbiddenRetry(this.db,prior,fieldGroupRetryScope(operation,member));retryOf=prior;
      }
      const fields=groupFields(context,member.assignments,all),profile=this.frozenPurposeProfile(member.purpose);
      await this.listingFieldsOnce(context,assertFresh,profile,undefined,signal,undefined,{
        id:retryOf?randomUUID():fieldGroupCallId(member),assignments:member.assignments,part:{operationId:operation.id,fields},
        sent:call=>{
          const current=readFieldGroup(this.db,initial.id)!,part=current.members[index];
          if(retryOf){if(part.retryCallId||!part.sent||part.resultId||part.callId!==retryOf.id)throw new AiError('INTERRUPTED');claimConfirmedForbiddenRetry(this.db,retryOf,call,fieldGroupRetryScope(current,part));part.retryCallId=call.id;}
          else{if(part.sent)throw new AiError('INTERRUPTED');part.sent=true;}
          saveFieldGroup(this.db,current);
          if(index===0&&completion&&!retryOf)this.completionJournal.markSent(completion,call);
        },
        result:result=>{const current=readFieldGroup(this.db,initial.id)!;current.members[index].resultId=result.id;saveFieldGroup(this.db,current);},
      });
    }
    await assertFresh();signal?.throwIfAborted();
    return transaction(this.db,()=>{
      const current=readFieldGroup(this.db,initial.id)!;if(current.resultId)return this.getResult(current.resultId)!;
      const sources=current.members.map(m=>this.getResult(m.resultId!)!);if(sources.some(s=>!s||s.output.kind!=='amazon-fields'))throw new AiError('SOURCE_CHANGED');
      const {fieldGroupPart:_part,fieldRejections:_rejections,listingNormalization:_normalization,localRecovery:_recovery,providerReceiptRecovery:_receiptRecovery,...base}=sources[0];
      const result=validateAiResult({...base,id:randomUUID(),output:assembleFieldOutputs(sources.map(s=>s.output as ListingFieldsOutput),context),fieldGroupAssembly:{version:1,operationId:current.id,sources,assembledAt:this.timestamp()}});
      this.db.prepare('INSERT INTO ai_results VALUES(?,?)').run(result.id,JSON.stringify(result));current.resultId=result.id;saveFieldGroup(this.db,current);
      if(completion)this.completionJournal.recordResult(completion,result);return result;
    });
  }
  private async recoverGroupedField(operation:FieldGroupOperation,index:number,context:ListingAiContext):Promise<boolean>{
    const member=operation.members[index],call=this.getCall(fieldGroupCallId(member));
    if(!call||call.status!=='FAILED'||call.errorCode!=='OUTPUT_INVALID'||!call.finishedAt||!isFullSchema(context))return false;
    const fields=groupFields(context,member.assignments,operation.members.flatMap(m=>m.assignments));
    const rawOutputs=readInvalidAiOutputs(this.directory,call,'amazon-fields');
    const receipt=await readProviderReceipt(this.db,this.directory,call.id) as any,choice=receipt?.body?.choices?.[0];
    if(choice?.finish_reason==='stop'&&!choice.message?.refusal&&!choice.message?.tool_calls&&typeof choice.message?.content==='string')try{rawOutputs.push(JSON.parse(choice.message.content));}catch{/* Original bytes remain available for inspection. */}
    for(const rawOutput of rawOutputs){
      let result:AiResult;
      try{
        const output=retainValidNativeCandidates(parseFullGeneration(rawOutput,context),context);
        if([...output.candidates,...output.missing].some(f=>!fields.includes(f.field)))continue;
        const recoveredAt=this.finishedAt(call.finishedAt);
        result=validateAiResult({id:randomUUID(),callId:call.id,providerId:call.providerId,productId:call.productId,productRevision:call.productRevision,variantId:context.variantId,assetId:null,assetSha256:null,sourceResultIds:[],model:call.model,createdAt:recoveredAt,reviewState:'unreviewed',output,listingContext:context,sourceSha256:operation.contextHash,listingEvidenceContractVersion:'listing-evidence/v4',fieldGroupPart:{operationId:operation.id,fields},localRecovery:{parserVersion:'full-schema-recovery/v2',operationId:operation.id,contextSha256:operation.contextHash,rawSha256:listingFingerprint(rawOutput),rawOutput,recoveredAt}});
      }catch{continue;}
      return transaction(this.db,()=>{
        const current=readFieldGroup(this.db,operation.id)!;if(current.members[index].resultId)return true;
        this.db.prepare('INSERT INTO ai_results VALUES(?,?)').run(result.id,JSON.stringify(result));current.members[index].resultId=result.id;saveFieldGroup(this.db,current);return true;
      });
    }
    return false;
  }
  private async listingFieldsOnce(context:ListingAiContext,assertContextFresh:()=>Promise<void>,profile:AiProfile,review?:{suggestionId:string;candidate:ListingFieldsOutput},signal?:AbortSignal,completion?:CompletionRequest,durable?:DurableFieldCall):Promise<AiResult>{
    const providerContext=structuredClone(context);
    if(durable?.part){providerContext.fields=providerContext.fields.filter(f=>durable.part!.fields.includes(f.name));if(providerContext.repairRequest){providerContext.repairRequest.issues=providerContext.repairRequest.issues.filter(i=>durable.part!.fields.includes(i.field));providerContext.repairRequest.currentValues=Object.fromEntries(Object.entries(providerContext.repairRequest.currentValues).filter(([key])=>durable.part!.fields.includes(key)));}}
    return this.start(profile, { productId: context.productId, productRevision: context.productRevision }, { operation: review ? 'amazon-fields-review' : 'amazon-fields', context, review,...(durable?{assignments:durable.assignments,part:durable.part}:{} ) }, async activeSignal => {
      const assertFresh = async () => { throwIfAborted(activeSignal); await assertContextFresh(); throwIfAborted(activeSignal);this.assertListingSource(context); };
      await assertFresh();
      return { variantId: context.variantId, assetId: null, assetSha256: null, sourceResultIds: review ? [review.suggestionId] : [], sourceSha256: listingFingerprint(context), listingContext: context, assertFresh,
        invoke: (credentials, adapterContext) => review
          ? reviewListingFields(context, review.candidate, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, adapterContext)
          : profile.routing?.purposeId==='enum_decision' ? decideListingEnums(providerContext,credentials as DeepSeekCredentials,activeSignal,adapterContext)
          : suggestListingFields(providerContext, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, adapterContext) };
    }, signal, completion,durable);
  }
  /** Reviews a current copy snapshot directly; no synthetic generation or renderer entry point. */
  async reviewCurrentListing(context: ListingAiContext, copy: CurrentListingCopy[], assertContextFresh: () => Promise<void>, signal?: AbortSignal): Promise<AiResult> {
    this.ensureOpen();this.assertListingSource(context); const currentCopy = validateCurrentListingCopy(copy,isFullSchema(context));
    assertCurrentCopyEvidence(currentCopy,context);
    return runCopyReview(this.db,{contextHash:listingFingerprint(context),scope:{currentCopy},signal,freshCompleted:!taskAiContext.getStore(),canResume:id=>this.canResumeCopyReview(id),fresh:assertContextFresh,snapshot:()=>this.activePurpose('copy_review',false,true).routing!,invoke:(routing,hooks)=>{const profile=this.frozenReviewProfile(routing);return this.start(profile, context, { operation: 'listing-current-review', context, currentCopy }, async activeSignal => {
      const assertFresh = async () => { throwIfAborted(activeSignal); await assertContextFresh(); throwIfAborted(activeSignal);this.assertListingSource(context); };
      await assertFresh();
      return { variantId: context.variantId, assetId: null, assetSha256: null, sourceResultIds: [], sourceSha256: listingFingerprint(context), listingContext: context, assertFresh,
        invoke: (credentials, adapterContext) => reviewCurrentListing(context, currentCopy, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, adapterContext) };
    }, signal,undefined,hooks);}});
  }
  private imageSources(context: ProductImageContext): StoredAsset[] {
    const source = this.product(context.listing.productId, context.listing.productRevision);
    const saved=this.db.prepare('SELECT record_json FROM listing_drafts WHERE id=? AND product_id=?').get(context.listing.draftId,source.id);
    const planRaw=saved?.record_json?JSON.parse(String(saved.record_json)).draft?.salesPlan:undefined;
    if(context.setPolicy){
      const draft=saved?.record_json?JSON.parse(String(saved.record_json)).draft as AmazonDraft:undefined;
      if(!draft||listingFingerprint(context.sourceMeasurements??[])!==listingFingerprint(currentSourceImageMeasurements(this.db,draft)))throw new AiError('SOURCE_CHANGED');
    }
    const plan=planRaw?validateSalesPlan(planRaw):undefined,product=projectSalesProduct(source,plan,context.listing.variantId);
    const allowed=plan?.recipe.components.map(c=>c.variantId).sort()??[context.listing.variantId];
    assertProductConsistency(this.db,source,allowed);
    for(const measurement of context.referenceMeasurements??[]){
      const ocr=this.getResult(measurement.ocrResultId),ref=context.referenceAssets.find(ref=>ref.assetId===measurement.assetId);
      if(!ocr||!ref||ocr.output.kind!=='ocr'||ocr.providerId!=='aliyun-ocr'||ocr.productId!==source.id||ocr.productRevision!==source.revision||ocr.assetId!==ref.assetId||ocr.assetSha256!==ref.sha256||!referenceMeasurementEvidence(ocr).some(item=>listingFingerprint(item)===listingFingerprint(measurement)))throw new AiError('SOURCE_CHANGED');
      this.successfulResult(ocr);
    }
    if(allowed.length>1&&!context.sourceVariantIds||context.sourceVariantIds&&listingFingerprint([...context.sourceVariantIds].sort())!==listingFingerprint([...new Set(allowed)]))throw new AiError('SOURCE_CHANGED');
    if(context.policyVersion===PRODUCT_IMAGE_POLICY_VERSION && listingFingerprint(context.ipSource)!==listingFingerprint(imageRiskSourceSnapshot(source,context.listing.variantId)))throw new AiError('SOURCE_CHANGED');
    assertCurrentImageCopyEvidence(context.currentListingCopy,context.listing);
    if (context.copyReviewBypass) {
      validateProductImageContext(context);
      if (readCopyReviewSettings(this.db).enabled) throw new AiError('SOURCE_CHANGED');
    } else {
      const review = context.listingReviewResultId === null ? undefined : this.getResult(context.listingReviewResultId);
      if (!review || review.output.kind !== 'listing-current-review' || review.output.verdict !== 'PASS' || !isReviewProvider(review.providerId) || !review.listingContext || review.sourceSha256 !== listingFingerprint(context.listing) || listingFingerprint(review.listingContext) !== listingFingerprint(context.listing) || listingFingerprint(review.output.currentListingCopy) !== listingFingerprint(context.currentListingCopy)) throw new AiError('SOURCE_CHANGED');
      this.successfulResult(review);
      assertCurrentListingReview({...review.output,kind:'amazon-fields-review'},context.currentListingCopy,context.listing,{storedVersion:'listing-evidence/v5'});
      const latest = this.listResults(product.id).filter(result => result.output.kind === 'listing-current-review' && result.sourceSha256 === review.sourceSha256 && result.output.copySha256 === listingFingerprint(context.currentListingCopy)).at(-1);
      if (latest?.id !== review.id) throw new AiError('SOURCE_CHANGED');
    }
    if (!product.variants.some(variant => variant.id === context.listing.variantId && variant.sku === context.listing.sku)) throw new AiError('SOURCE_CHANGED');
    return context.referenceAssets.map(reference => {
      const asset = this.source({ productId: product.id, productRevision: product.revision, assetId: reference.assetId });
      const image = product.assets.find(image => image.id === asset.id);
      if (asset.sha256 !== reference.sha256 || !image) throw new AiError('SOURCE_CHANGED');
      if (reference.variantId === null ? image.variantIds.length > 0 || !allowSourceUnbound(source,readSourceImageReceipt(this.db,source.id)) : !image.variantIds.includes(reference.variantId) || this.db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=? AND variant_id=?').get(asset.id, reference.variantId)?.confirmed !== 1) throw new AiError('SOURCE_CHANGED');
      return asset;
    });
  }
  private async assertImageFresh(context: ProductImageContext, assertContextFresh: () => void | Promise<void>, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal); await assertContextFresh(); throwIfAborted(signal);
    for (const asset of this.imageSources(context)) await this.readSource({ productId: context.listing.productId, productRevision: context.listing.productRevision, assetId: asset.id }, asset, signal);
    throwIfAborted(signal); await assertContextFresh(); this.imageSources(context); throwIfAborted(signal);
  }
  /** Main-only classification role; reuses the existing provider, usage ledger and real source images. */
  async decideCategory(input: { productId: string; productRevision: number; phase: CategoryDecision['phase']; candidates: ProductTypeOption[]; keywords?: string[] }, assertContextFresh: () => void = () => {}, signal?: AbortSignal): Promise<AiResult & { output: CategoryDecision }> {
    this.ensureOpen();
    const product = this.product(input.productId, input.productRevision), variant = product.variants[0];
    if (!variant || input.candidates.length > 50 || !['keywords','select','judge'].includes(input.phase)) throw new AiError('INVALID_INPUT');
    const profile = this.activePurpose(input.phase==='select'?'category_decision':'category_analysis',true,input.phase==='judge');
    const generated = new Set(this.db.prepare("SELECT json_extract(record_json,'$.approvedAssetId') AS assetId FROM image_workflow_runs WHERE json_extract(record_json,'$.productId')=? UNION SELECT json_extract(s.value,'$.approvedAssetId') AS assetId FROM image_workflow_runs w, json_each(w.record_json,'$.slots') s WHERE json_extract(w.record_json,'$.productId')=?").all(product.id,product.id).map(row => row.assetId));
    const references = product.assets.filter(asset => !generated.has(asset.id)).slice(0, 3);
    if (!references.length) throw new UserFacingError('商品分类需要至少一张可用来源图片');
    const payload = { phase:input.phase, candidates:input.candidates, keywords:input.keywords ?? [], title:product.title, description:product.description.slice(0, 12000),
      ...productFactEvidence(product), specifications:product.variants.map(item=>item.originalSpec).slice(0,200) };
    const categoryContext={version:1 as const,phase:input.phase,requestSha256:listingFingerprint({payload,references:references.map(a=>({id:a.id,sha256:this.source({productId:product.id,productRevision:product.revision,assetId:a.id}).sha256})),model:profile.model,effort:profile.routing?.effectiveEffort})};
    const categoryScope=taskAiContext.getStore(),categoryBatch=categoryScope?.waitingOperationId?this.batchTasks.find(categoryScope.waitingOperationId):undefined;
    const originalBatchCallId=input.phase!=='select'&&categoryBatch&&categoryBatch.owner.productId===product.id&&categoryBatch.owner.productRevision===product.revision?categoryBatch.aiCallId:undefined;
    const recovery=await recoverCategoryPhase({originalBatchCallId,db:this.db,directory:this.directory,calls:this.listCalls(),results:this.listResults(product.id),productId:product.id,productRevision:product.revision,model:profile.model,effort:profile.routing?.effectiveEffort??'',context:categoryContext,payloadHash:listingFingerprint(payload)});
    assertContextFresh();if(signal)throwIfAborted(signal);this.product(input.productId,input.productRevision);
    if(recovery.saved&&recovery.saved.output.kind==='category-decision')return {...recovery.saved,output:recovery.saved.output};
    const priorSnapshot=listingFingerprint(recovery.calls);
    const result = await this.start(profile, input, { operation:'category-decision', payload, references:references.map(asset=>asset.id) }, async activeSignal => {
      const assertFresh = async () => { assertContextFresh(); this.product(input.productId,input.productRevision); throwIfAborted(activeSignal); };
      await assertFresh();
      const images: DeepSeekReferenceImage[] = [];
      for (const reference of references) {
        const source = { productId:product.id,productRevision:product.revision,assetId:reference.id }, asset = this.source(source), bytes = await this.readSource(source,asset,activeSignal);
        images.push({assetId:asset.id,sha256:asset.sha256,mimeType:asset.mimeType,width:asset.width,height:asset.height,bytes});
      }
      return {categoryContext,categoryPriorSnapshot:priorSnapshot,categoryRepairPriors:recovery.priors,assertBeforeSend:()=>{if(listingFingerprint(categoryCalls(this.listCalls(),product.id,product.revision))!==priorSnapshot)throw new AiError('CONFIG_CHANGED');}, variantId:variant.id, assetId:null,assetSha256:null,sourceResultIds:[],sourceSha256:listingFingerprint(payload),assertFresh,
        invoke:(credentials, context)=>categoryDecision(payload,credentials as DeepSeekCredentials,activeSignal,context,images) };
    }, signal);
    if (result.output.kind !== 'category-decision') throw new AiError('OUTPUT_INVALID');
    return { ...result, output:result.output };
  }
  /** Derive the original SKU snapshot without requiring a listing draft or provider call. */
  sourceConsistencyContext(input:{productId:string;productRevision:number;variantId:string}):SourceConsistencyContext {
    this.ensureOpen();return resolveConsistencyContext(this.db,this.store,this.directory,input);
  }
  getSourceConsistency(raw:unknown){const o=keys(raw,['productId','productRevision','variantId']);return readConsistencyView(this.db,this.sourceConsistencyContext({productId:uuid(o.productId),productRevision:integer(o.productRevision,1,Number.MAX_SAFE_INTEGER),variantId:uuid(o.variantId)}));}
  sourceObservationEvidence(input:{productId:string;productRevision:number;variantId:string}){return readSourceObservationEvidence(this.db,this.sourceConsistencyContext(input));}
  decideSourceConsistency(raw:unknown){return saveConsistencyDecision(this.db,this.store,this.directory,raw);}
  async prepareSourceConsistency(raw:unknown,signal?:AbortSignal,assertFresh:()=>void=()=>{}){
    const view=this.getSourceConsistency(raw);
    if(view.reasons.includes('EXPLICIT_RANDOM_FULFILLMENT'))assertConsistencyView(view);
    if(!['MATCH','MANUAL'].includes(view.status))await this.observeSourceConsistency(view.context,assertFresh,signal);
    assertFresh();return this.getSourceConsistency(raw);
  }
  private assertConsistencyPricing(context:SourceConsistencyContext):void {
    for(const row of this.db.prepare("SELECT id,record_json FROM listing_drafts WHERE json_extract(record_json,'$.draft.productId')=?").all(context.productId)){
      const {draft}=JSON.parse(String(row.record_json)) as {draft:AmazonDraft};
      if(draft.productRevision===context.productRevision&&!draft.submittedAt&&['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(draft.state)&&(draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId]).includes(context.variantId))assertStoredPricingForPaid(this.db,String(row.id));
    }
  }
  private assertConsistencyFresh(context:SourceConsistencyContext):void {
    if(listingFingerprint(this.sourceConsistencyContext(context))!==listingFingerprint(context))throw new AiError('SOURCE_CHANGED');
  }
  /** Explicit preparation only; unique durable send scope is reserved by the existing usage ledger. */
  async observeSourceConsistency(raw:SourceConsistencyContext,assertContextFresh:()=>void|Promise<void>,signal?:AbortSignal,assertBeforeSend?:()=>void):Promise<AiResult|{id:string;callId:string;recovered:true;output:import('../../shared/source-image-consistency-contracts.ts').SourceConsistencyOutput;sourceConsistencyRequestBytes?:number}> {
    this.ensureOpen();const context=validateConsistencyContext(raw);
    throwIfAborted(signal??new AbortController().signal);await assertContextFresh();this.assertConsistencyFresh(context);
    const attempt=latestConsistencyAttempt(this.db,context);
    if(attempt){
      const saved=this.db.prepare("SELECT record_json FROM ai_results WHERE json_extract(record_json,'$.callId')=?").get(attempt.callId);
      if(!saved){
        const row=this.db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(attempt.callId),call=row?validateAiCall(JSON.parse(String(row.record_json))):null;
        if(!call)throw new UserFacingError('来源观察请求归属记录缺失，历史次数保留；无法安全重试');
        const recovered=recoverableSourceReceipt(this.db,this.directory,call);
        if(recovered){
          const original=call.sourceConsistencyContext!;
          if(consistencyScopeKey(original)!==consistencyScopeKey(context))throw new AiError('SOURCE_CHANGED');
          const createdAt=this.finishedAt(call.finishedAt??call.startedAt);
          const result=validateAiResult({id:randomUUID(),callId:call.id,providerId:call.providerId,productId:call.productId,productRevision:call.productRevision,variantId:original.variantId,assetId:null,assetSha256:null,sourceResultIds:[],model:call.model,createdAt,reviewState:'unreviewed',sourceSha256:listingFingerprint(original),sourceConsistencyContext:original,output:recovered.output,providerReceiptRecovery:{version:1,receiptId:recovered.saved.record.id,requestFingerprint:call.requestFingerprint!,scopeSha256:listingFingerprint(call.requestScope!),recoveredAt:createdAt}});
          this.db.exec('BEGIN IMMEDIATE');
          try{
            if(JSON.stringify(this.getCall(call.id))!==JSON.stringify(call))throw new AiError('SOURCE_CHANGED');
            assertSourceReceiptRecovery(this.db,this.directory,result,call);this.assertConsistencyFresh(context);
            this.db.prepare('INSERT INTO ai_results(id,record_json) VALUES(?,?)').run(result.id,JSON.stringify(result));
            recordConsistencyAssessment(this.db,result);assertConsistencyHistory(this.db,this.directory);this.db.exec('COMMIT');return result;
          }catch(error){this.db.exec('ROLLBACK');throw error;}
        }
        const view=readConsistencyView(this.db,context);
        if(call?.errorCode==='OUTPUT_INVALID'){
          if(view.observations&&view.assessmentId)return{id:view.assessmentId,callId:call.id,recovered:true,output:view.observations};
          for(const output of readInvalidAiOutputs(this.directory,call,'source-image-consistency')){
            this.db.exec('BEGIN IMMEDIATE');
            try{
              const assessment=recordRecoveredConsistency(this.db,call,output);assertConsistencyHistory(this.db,this.directory);this.assertConsistencyFresh(context);this.db.exec('COMMIT');
              return{id:assessment.id,callId:call.id,recovered:true,output:assessment.recovery!.output};
            }catch{this.db.exec('ROLLBACK');}
          }
        }
        if(listConsistencyAttempts(this.db,context).some(previous=>consistencyAttemptUnknown(this.db,previous)))throw new AiError('INTERRUPTED');
        if(confirmedForbiddenRejection(this.db,call)){
          if((attempt.attemptNumber??1)>=MAX_SOURCE_ATTEMPTS){const exhausted=new AiError('QUOTA_EXCEEDED');exhausted.message='来源观察原重试次数已耗尽；历史次数和费用保留，本次未发送新请求';throw exhausted;}
          assertConfirmedForbiddenRetry(this.db,call,'source:'+consistencyScopeKey(context));
        }
        const current=this.activePurpose('source_understanding',true),authRetry=canRetryConsistencyAuthentication(this.db,call,{providerId:current.id,generation:current.generation});
        if(authRetry){const receipt=await readProviderReceipt(this.db,this.directory,call.id) as {status?:number}|null;if(!receipt||![401,403].includes(receipt.status??0))throw new AiError('AUTH_FAILED');}
        if(!call||call.status!=='FAILED'||!(call.errorCode==='OUTPUT_INVALID'||authRetry)||call.errorCode==='OUTPUT_INVALID'&&hasRetainedInvalidAiOutput(this.directory,call,'source-image-consistency')||(attempt.attemptNumber??1)>=MAX_SOURCE_ATTEMPTS)throw new AiError(call?.errorCode==='OUTPUT_INVALID'?'OUTPUT_INVALID':confirmedLegacyRegionRejection(this.db,call)?'MODEL_REGION_RESTRICTED':call?.errorCode==='MODEL_REGION_RESTRICTED'||call?.errorCode==='ROUTING_FORBIDDEN'?call.errorCode:confirmedAuthenticationRejection(this.db,call)?'AUTH_FAILED':'INTERRUPTED');
      }else{
      const result=validateStoredAiResult(JSON.parse(String(saved.record_json)));
      if(result.output.kind!=='source-image-consistency'||!result.sourceConsistencyContext||consistencyScopeKey(result.sourceConsistencyContext)!==consistencyScopeKey(context))throw new AiError('INVALID_CONFIG');
      this.successfulResult(result);this.db.exec('BEGIN IMMEDIATE');try{recordConsistencyAssessment(this.db,result);assertConsistencyHistory(this.db,this.directory);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
      await assertContextFresh();this.assertConsistencyFresh(context);throwIfAborted(signal??new AbortController().signal);return result;
      }
    }
    const profile=this.activePurpose('source_understanding',true);
    return this.start(profile,context,{operation:'source-image-consistency',context},async activeSignal=>{
      const assertFresh=async()=>{throwIfAborted(activeSignal);await assertContextFresh();throwIfAborted(activeSignal);this.assertConsistencyFresh(context);};
      await assertFresh();const images:DeepSeekReferenceImage[]=[];
      for(const ref of context.referenceAssets){
        const input={productId:context.productId,productRevision:context.productRevision,assetId:ref.assetId},asset=this.source(input),bytes=await this.readSource(input,asset,activeSignal);
        await assertFresh();images.push({assetId:asset.id,sha256:asset.sha256,mimeType:asset.mimeType,width:asset.width,height:asset.height,bytes});
      }
      const sourceReferenceAliases=createSourceReferenceAliases(context);
      return{variantId:context.variantId,assetId:null,assetSha256:null,sourceResultIds:[],sourceSha256:listingFingerprint(context),sourceConsistencyContext:context,sourceReferenceAliases,assertFresh,assertBeforeSend,
        invoke:async(credentials,adapter)=>{await assertFresh();return requestSourceConsistency(context,credentials as DeepSeekCredentials,activeSignal,adapter,images,sourceReferenceAliases);}};
    },signal);
  }
  sourceColorContext(input: {productId:string;productRevision:number;variantId:string}): SourceColorContext {
    this.ensureOpen();
    const product=this.product(uuid(input.productId),integer(input.productRevision,1,Number.MAX_SAFE_INTEGER)),variant=product.variants.find(item=>item.id===uuid(input.variantId));
    if(!variant)throw new AiError('SOURCE_CHANGED');
    const generated=new Set(this.db.prepare("SELECT json_extract(record_json,'$.approvedAssetId') AS assetId FROM image_workflow_runs WHERE json_extract(record_json,'$.productId')=? UNION SELECT json_extract(s.value,'$.approvedAssetId') AS assetId FROM image_workflow_runs w, json_each(w.record_json,'$.slots') s WHERE json_extract(w.record_json,'$.productId')=?").all(product.id,product.id).map(row=>String(row.assetId)));
    const refs=selectImageReferences(product,variant.id,generated,(assetId,variantId)=>this.db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=? AND variant_id=?').get(assetId,variantId)?.confirmed===1,allowSourceUnbound(product,readSourceImageReceipt(this.db,product.id)),[variant.id],10);
    return validateSourceColorContext({policyVersion:SOURCE_COLOR_POLICY_VERSION,productId:product.id,productRevision:product.revision,variantId:variant.id,sourceSpec:variant.normalizedSpec.trim()||variant.originalSpec.trim(),referenceAssets:refs.map(ref=>({assetId:ref.id,sha256:this.source({productId:product.id,productRevision:product.revision,assetId:ref.id}).sha256}))});
  }
  private assertSourceColorIdentity(context:SourceColorContext):void {
    try { if(listingFingerprint(this.sourceColorContext(context))!==listingFingerprint(context))throw new AiError('SOURCE_CHANGED'); }
    catch { throw new AiError('SOURCE_CHANGED'); }
  }
  /** Main-only, no network: recheck original bytes as well as the saved mapping and hashes. */
  async assertSourceColorFresh(rawContext:SourceColorContext,signal?:AbortSignal):Promise<void> {
    this.ensureOpen();const context=validateSourceColorContext(rawContext),activeSignal=signal??new AbortController().signal;
    throwIfAborted(activeSignal);this.assertSourceColorIdentity(context);
    for(const reference of context.referenceAssets){
      const input={productId:context.productId,productRevision:context.productRevision,assetId:reference.assetId},asset=this.source(input);
      if(asset.sha256!==reference.sha256)throw new AiError('SOURCE_CHANGED');
      await this.readSource(input,asset,activeSignal);this.assertSourceColorIdentity(context);
    }
    throwIfAborted(activeSignal);
  }
  /** Main-process-only observation, stored as AI provenance rather than a product fact. */
  async observeSourceColor(rawContext:SourceColorContext,assertContextFresh:()=>void|Promise<void>,signal?:AbortSignal,assertBeforeSend?:()=>void):Promise<AiResult & {output:SourceColorOutput;sourceColorContext:SourceColorContext}> {
    this.ensureOpen();const context=validateSourceColorContext(rawContext),profile=this.activePurpose('source_understanding',true);
    const result=await this.start(profile,context,{operation:'source-color',context},async activeSignal=>{
      const assertFresh=async()=>{throwIfAborted(activeSignal);await assertContextFresh();await this.assertSourceColorFresh(context,activeSignal);await assertContextFresh();throwIfAborted(activeSignal);};
      await assertFresh();
      const images:DeepSeekReferenceImage[]=[];
      for(const reference of context.referenceAssets){
        await assertContextFresh();throwIfAborted(activeSignal);this.assertSourceColorIdentity(context);
        const input={productId:context.productId,productRevision:context.productRevision,assetId:reference.assetId},asset=this.source(input),bytes=await this.readSource(input,asset,activeSignal);
        images.push({assetId:asset.id,sha256:asset.sha256,mimeType:asset.mimeType,width:asset.width,height:asset.height,bytes});
        await assertContextFresh();throwIfAborted(activeSignal);this.assertSourceColorIdentity(context);
      }
      return {variantId:context.variantId,assetId:null,assetSha256:null,sourceResultIds:[],sourceSha256:listingFingerprint(context),sourceColorContext:context,assertFresh,assertBeforeSend,
        invoke:async(credentials,adapterContext)=>{await assertFresh();return requestSourceColor(context,credentials as DeepSeekCredentials,activeSignal,adapterContext,images);}};
    },signal);
    if(result.output.kind!=='source-color'||!result.sourceColorContext)throw new AiError('OUTPUT_INVALID');
    return {...result,output:result.output,sourceColorContext:result.sourceColorContext};
  }
  private imageResult(result: AiResult, context: ProductImageContext, kind: 'image-plan' | 'generated-image-ocr'): AiResult {
    const stored = this.getResult(result.id);
    if (!stored || stored.output.kind !== kind || !stored.imageContext || stored.sourceSha256 !== listingFingerprint(context) || listingFingerprint(stored.imageContext) !== listingFingerprint(context) || listingFingerprint(stored) !== listingFingerprint(result)) throw new AiError('SOURCE_CHANGED');
    this.successfulResult(stored); return stored;
  }
  /** Revalidate one exact retained response, never alter the paid call or its usage. */
  async recoverImagePlan(callId:string,rawContext:ProductImageContext,assertContextFresh:()=>void|Promise<void>,signal?:AbortSignal,repair?:{previousPlanId:string;issues:string[]}):Promise<AiResult|undefined>{
    this.ensureOpen();const context=validateProductImageContext(rawContext),call=this.getCall(uuid(callId)),p=call?.presentationContext,hash=listingFingerprint(context);
    if(!call||call.status!=='FAILED'||call.errorCode!=='OUTPUT_INVALID'||!call.finishedAt||!isGenerationProvider(call.providerId)||(call.purposeSnapshot?!['image_plan','image_plan_repair'].includes(call.purposeSnapshot.purposeId):call.model!=='deepseek-flash')||call.productId!==context.listing.productId||call.productRevision!==context.listing.productRevision||p?.kind!=='image'||p.draftId!==context.listing.draftId||p.variantId!==context.listing.variantId||p.slot!==(context.slot?.index??0)||p.sourceSha256!==hash)return undefined;
    if(repair&&!p.imagePlanRequestSha256||p.imagePlanRequestSha256!==undefined&&p.imagePlanRequestSha256!==listingFingerprint({context,repair:repair??null}))return undefined;
    if(repair){const prior=this.getResult(repair.previousPlanId);if(!prior)throw new AiError('SOURCE_CHANGED');this.imageResult(prior,context,'image-plan');}
    const activeSignal=signal??new AbortController().signal;
    await this.assertImageFresh(context,assertContextFresh,activeSignal);
    for(const row of this.db.prepare("SELECT id FROM ai_results WHERE json_extract(record_json,'$.callId')=?").all(call.id)){
      const saved=this.getResult(String(row.id));if(saved?.imagePlanRecovery&&resultHasOwner(saved,call)&&saved.sourceSha256===hash)return saved;
    }
    for(const rawOutput of readInvalidAiOutputs(this.directory,call,'image-plan')){
      let output;try{output=parseImagePlanRecovery(rawOutput,context);}catch{continue;}
      await this.assertImageFresh(context,assertContextFresh,activeSignal);
      const createdAt=this.finishedAt(call.finishedAt),result=validateAiResult({id:randomUUID(),callId:call.id,providerId:call.providerId,productId:call.productId,productRevision:call.productRevision,variantId:context.listing.variantId,assetId:null,assetSha256:null,sourceResultIds:[...imageCopySourceIds(context),...(repair?[repair.previousPlanId]:[])],model:call.model,createdAt,reviewState:'unreviewed',output,sourceSha256:hash,listingEvidenceContractVersion:imageEvidenceVersion(context.listing),imageContext:context,imagePlanRecovery:{...(repair?{repair}:{}),parserVersion:'image-plan-recovery/v2',contextSha256:hash,rawSha256:listingFingerprint(rawOutput),rawOutput,recoveredAt:createdAt}});
      if(!resultHasOwner(result,call))throw new AiError('SOURCE_CHANGED');
      for(const row of this.db.prepare("SELECT id FROM ai_results WHERE json_extract(record_json,'$.callId')=?").all(call.id)){const saved=this.getResult(String(row.id));if(saved?.imagePlanRecovery&&resultHasOwner(saved,call)&&saved.sourceSha256===hash)return saved;}
      this.db.prepare('INSERT INTO ai_results(id,record_json) VALUES(?,?)').run(result.id,JSON.stringify(result));return result;
    }
    return undefined;
  }
  async imagePlan(rawContext:ProductImageContext,assertContextFresh:()=>void|Promise<void>,rawRepair?:{previousPlanId:string;issues:string[]},signal?:AbortSignal,workflowId?:string,onRequestSent?:()=>void):Promise<AiResult>{
    for(let attempt=0;;attempt++){
      throwIfAborted(signal??new AbortController().signal);
      try{return await this.imagePlanOnce(rawContext,assertContextFresh,rawRepair,signal,workflowId,onRequestSent);}
      catch(error){
        if(isSchemaTransientError(error)||!(error instanceof AiError)||error.code!=='OUTPUT_INVALID'||!error.callId||!workflowId||['RESPONSE_NOT_CONTENT','RESPONSE_SECRET_ECHO'].includes(error.diagnosticReason??''))throw error;
        const recovered=await this.recoverImagePlan(error.callId,rawContext,assertContextFresh,signal,rawRepair);
        if(recovered)return recovered;
        if(attempt>=2||this.imagePlanningAttempts(rawContext,workflowId)>=imagePlanningAllowanceLimit(this.db,workflowId,rawContext,rawRepair))throw new ImagePlanningLimitError(error.callId);
      }
    }
  }
  private imagePlanningAttempts(context:ProductImageContext,workflowId:string):number {
    // Count in SQLite, including legacy records without a request hash. During reserve this
    // uses the same connection/write transaction and includes the newly inserted call.
    const row=this.db.prepare(`SELECT count(*) AS attempts FROM ai_calls WHERE
      json_extract(record_json,'$.providerId') IN ('deepseek','openrouter')
      AND json_extract(record_json,'$.productId')=? AND json_extract(record_json,'$.productRevision')=?
      AND json_extract(record_json,'$.presentationContext.kind')='image'
      AND json_extract(record_json,'$.presentationContext.draftId')=? AND json_extract(record_json,'$.presentationContext.variantId')=?
      AND json_extract(record_json,'$.presentationContext.sourceSha256')=? AND json_extract(record_json,'$.presentationContext.slot')=?
      AND json_extract(record_json,'$.presentationContext.workflowId')=?`).get(context.listing.productId,context.listing.productRevision,context.listing.draftId,context.listing.variantId,listingFingerprint(context),context.slot?.index??0,workflowId);
    return Number(row!.attempts);
  }
  private async imagePlanOnce(rawContext: ProductImageContext, assertContextFresh: () => void | Promise<void>, rawRepair?: { previousPlanId: string; issues: string[] }, signal?: AbortSignal, workflowId?:string,onRequestSent?:()=>void): Promise<AiResult> {
    this.ensureOpen(); const context = validateProductImageContext(rawContext), profile = this.activePurpose(rawRepair?'image_plan_repair':'image_plan',true);
    if (context.policyVersion !== PRODUCT_IMAGE_POLICY_VERSION) throw new AiError('SOURCE_CHANGED');
    let repair: { previousPlanId: string; issues: string[] } | undefined;
    if (rawRepair) {
      const value = keys(rawRepair, ['previousPlanId','issues']);
      if (!Array.isArray(value.issues) || !value.issues.length || value.issues.length > 50) throw new AiError('INVALID_INPUT');
      repair = { previousPlanId: uuid(value.previousPlanId), issues: value.issues.map(issue => boundedText(issue, 2000)) };
    }
    let forbiddenRetry:PreparedRequest['forbiddenRetry'];
    const prior = repair ? this.getResult(repair.previousPlanId) : undefined;
    if (repair && !prior) throw new AiError('SOURCE_CHANGED');
    {
      const requestHash=listingFingerprint({context,repair:repair??null});
      const calls=this.listCalls().filter(call=>call.presentationContext?.sourceSha256===listingFingerprint(context)&&call.presentationContext?.workflowId===workflowId&&isGenerationProvider(call.providerId)&&(call.presentationContext?.imagePlanRequestSha256!==undefined||(call.purposeSnapshot?['image_plan','image_plan_repair'].includes(call.purposeSnapshot.purposeId):call.model==='deepseek-flash'))).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
      const call=calls.find(call=>call.presentationContext?.imagePlanRequestSha256===requestHash||!repair&&call.presentationContext?.imagePlanRequestSha256===undefined);
      if(call?.status==='SUCCEEDED'){
        const refusal=this.listResults(call.productId).find(result=>result.callId===call.id&&result.output.kind==='image-plan'&&(result.output.productUnderstanding?.sufficient===false||!!workflowId&&call.presentationContext?.imagePlanRequestSha256===requestHash)&&result.sourceSha256===listingFingerprint(context));
        if(refusal){await this.assertImageFresh(context,assertContextFresh,signal??new AbortController().signal);this.successfulResult(refusal);return refusal;}
      }
      if(call){
        const recovered=await this.recoverImagePlan(call.id,context,assertContextFresh,signal,repair);if(recovered)return recovered;
        if(imagePlanRetryForbidden(this.directory,call))throw new AiError('OUTPUT_INVALID');
      }
      // New repair wording cannot discard an unresolved request for the same source/workflow.
      for(const previous of calls.filter(previous=>previous.status!=='SUCCEEDED')){
        // Only the exact waiting Batch identity may enter start's guarded receipt replay.
        const waiting=taskAiContext.getStore()?.waitingOperationId===previous.id&&this.batchTasks.find(previous.id);
        const missingRejectionProof=previous.providerId.startsWith('openrouter')&&['AUTH_FAILED','MODEL_REGION_RESTRICTED','ROUTING_FORBIDDEN','SERVICE_PERMISSION_REQUIRED'].includes(previous.errorCode??'')&&!confirmedForbiddenRejection(this.db,previous)&&!confirmedAuthenticationRejection(this.db,previous);
        if((!imagePlanFailureConfirmed(this.directory,previous)||missingRejectionProof)&&!(waiting&&!waiting.adoption)){
          const unknown=new AiError('INTERRUPTED');unknown.callId=previous.id;unknown.diagnosticReason='IMAGE_PLAN_RESULT_UNKNOWN';
          unknown.message='图片规划原请求结果未知，已保留调用与费用记录；本次未发送新请求，请先核对原结果';throw unknown;
        }
      }
      const results=this.listResults(context.listing.productId);
      const resolvedIndex=calls.findIndex(previous=>previous.status==='SUCCEEDED'&&results.some(result=>result.callId===previous.id&&result.output.kind==='image-plan'&&resultHasOwner(result,previous)&&result.sourceSha256===listingFingerprint(context)));
      const unresolved=resolvedIndex<0?calls:calls.slice(0,resolvedIndex);
      const denied=unresolved.find(previous=>previous.status==='FAILED'&&(previous.errorCode==='MODEL_REGION_RESTRICTED'||previous.errorCode==='ROUTING_FORBIDDEN'||confirmedForbiddenRejection(this.db,previous)));
      if(denied){
        if(!confirmedForbiddenRejection(this.db,denied))throw new AiError(denied.errorCode as 'MODEL_REGION_RESTRICTED'|'ROUTING_FORBIDDEN');
        const scopeKey='image-plan:'+listingFingerprint({workflowId:workflowId??null,source:listingFingerprint(context)});
        assertConfirmedForbiddenRetry(this.db,denied,scopeKey);forbiddenRetry={prior:denied,scopeKey};
      }
    }
    return this.start(profile, context.listing, { operation: 'image-plan', context, repair, ...(workflowId?{workflowId:uuid(workflowId)}:{}) }, async activeSignal => {
      const assertFresh = async () => { await this.assertImageFresh(context, assertContextFresh, activeSignal); if (prior) this.imageResult(prior, context, 'image-plan'); };
      await assertFresh();
      const images: DeepSeekReferenceImage[] = [];
      for (const asset of this.imageSources(context)) {
        const bytes = await this.readSource({productId:context.listing.productId,productRevision:context.listing.productRevision,assetId:asset.id},asset,activeSignal);
        images.push({assetId:asset.id,sha256:asset.sha256,mimeType:asset.mimeType,width:asset.width,height:asset.height,bytes});
      }
      await assertFresh();
      return { ...(forbiddenRetry?{forbiddenRetry}:{}),...(repair?{imagePlanRepair:repair}:{}),imagePlanRequestSha256:listingFingerprint({context,repair:repair??null}),...(workflowId?{workflowId:uuid(workflowId)}:{}), variantId: context.listing.variantId, assetId: null, assetSha256: null, sourceResultIds: [...imageCopySourceIds(context), ...(prior ? [prior.id] : [])], sourceSha256: listingFingerprint(context), imageContext: context, assertFresh,
        assertBeforeSend:()=>{if(workflowId&&this.imagePlanningAttempts(context,workflowId)>=imagePlanningAllowanceLimit(this.db,workflowId,context,repair))throw new ImagePlanningLimitError();},
        invoke: (credentials, adapterContext) => planProductImage(context, repair?{...repair,previousPlan:prior?.output as import('../../shared/image-ai-contracts.ts').ImagePlanOutput}:undefined, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, {...adapterContext,imagePlanRetry:!!workflowId&&this.imagePlanningAttempts(context,workflowId)>0,beforeSend:body=>{adapterContext.beforeSend?.(body);onRequestSent?.();}}, images) };
    }, signal);
  }
  async recognizeGeneratedImage(rawContext: ProductImageContext, rawCandidate: CandidateImageIdentity, bytes: Buffer, assertContextFresh: () => void | Promise<void>, signal?: AbortSignal,owner?:AiDurableRequestPort): Promise<AiResult> {
    this.ensureOpen(); const context = validateProductImageContext(rawContext), candidate = validateCandidateImageIdentity(rawCandidate), profile = this.reviewProfile('aliyun-ocr',owner);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES || createHash('sha256').update(bytes).digest('hex') !== candidate.sha256) throw new AiError('IMAGE_INVALID');
    const image = Buffer.from(bytes), raster = inspectRaster(image);
    if (!['image/png','image/jpeg'].includes(raster.mimeType) || raster.width !== candidate.width || raster.height !== candidate.height) throw new AiError('IMAGE_INVALID');
    return this.start(profile, context.listing, { operation: 'generated-image-ocr', context, candidate }, async activeSignal => {
      const assertFresh = () => this.assertImageFresh(context, assertContextFresh, activeSignal); await assertFresh();
      return { variantId: context.listing.variantId, assetId: null, assetSha256: null, sourceResultIds: imageCopySourceIds(context), sourceSha256: listingFingerprint(context), imageContext: context, assertFresh,
        recoverRequestBytes:image.length,recoverReceipt:(body,adapterContext)=>{const reply=parseAliyunOcr(body,candidate,{accessKeyId:'local-only-recovery',accessKeySecret:'local-only-recovery'},adapterContext);return {...reply,output:{...reply.output,kind:'generated-image-ocr',candidate}};},
        invoke: async (credentials, adapterContext) => { const reply = await recognizeWithAliyun(image, candidate, credentials as AliyunCredentials, activeSignal, adapterContext); return { ...reply, output: { ...reply.output, kind: 'generated-image-ocr', candidate } }; } };
    }, signal,undefined,undefined,owner);
  }
  async reviewGeneratedImage(rawContext: ProductImageContext, rawPlan: AiResult, rawOcr: AiResult, rawCandidate: CandidateImageIdentity, assertContextFresh: () => void | Promise<void>, signal?: AbortSignal,owner?:AiDurableRequestPort): Promise<AiResult> {
    this.ensureOpen(); const context = validateProductImageContext(rawContext), candidate = validateCandidateImageIdentity(rawCandidate), profile = this.reviewProfile('text',owner);
    const plan = this.imageResult(rawPlan, context, 'image-plan'), ocr = this.imageResult(rawOcr, context, 'generated-image-ocr');
    if (ocr.output.kind !== 'generated-image-ocr' || listingFingerprint(ocr.output.candidate) !== listingFingerprint(candidate)) throw new AiError('SOURCE_CHANGED');
    return this.start(profile, context.listing, { operation: 'image-text-review', context, plan, ocr, candidate }, async activeSignal => {
      const assertFresh = async () => { await this.assertImageFresh(context, assertContextFresh, activeSignal); this.imageResult(plan, context, 'image-plan'); this.imageResult(ocr, context, 'generated-image-ocr'); };
      await assertFresh();
      return { variantId: context.listing.variantId, assetId: null, assetSha256: null, sourceResultIds: [...imageCopySourceIds(context), plan.id, ocr.id], sourceSha256: listingFingerprint(context), imageContext: context, assertFresh,
        invoke: (credentials, adapterContext) => reviewProductImageText(context, plan, ocr, candidate, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, adapterContext) };
    }, signal,undefined,undefined,owner);
  }
  async reviewGeneratedImageAppearance(rawContext:ProductImageContext,rawPlan:AiResult,rawCandidate:CandidateImageIdentity,bytes:Buffer,assertContextFresh:()=>void|Promise<void>,signal?:AbortSignal,snapshot?:import('../../shared/ai-purpose-contracts.ts').AiPurposeSnapshot,previousResultId?:string|null):Promise<AiResult> {
    this.ensureOpen(); const context=validateProductImageContext(rawContext),candidate=validateCandidateImageIdentity(rawCandidate),plan=this.imageResult(rawPlan,context,'image-plan');
    const routing=validateAppearancePurposeSnapshot(snapshot??this.activePurpose('appearance_review',true,true).routing);
    if(!routing.capability.vision||!routing.capability.json||!['appearance_review','appearance_review_difficult'].includes(routing.purposeId))throw new AiError('INVALID_CONFIG');
    const id=routing.gateway==='openrouter'?'openrouter-review':'deepseek-review',connection=this.assertProfile(id),profile={...connection,model:routing.model,thinking:!['none','not_applicable'].includes(routing.effectiveEffort),routing};
    const previous=previousResultId?this.getResult(uuid(previousResultId)):undefined;
    if(previousResultId&&(!previous||previous.output.kind!=='image-appearance-review'||previous.output.verdict!=='UNCERTAIN'||previous.output.previousResultId!==null||previous.output.planResultId!==plan.id||listingFingerprint(previous.output.candidate)!==listingFingerprint(candidate)||previous.sourceSha256!==listingFingerprint(context)))throw new AiError('SOURCE_CHANGED');
    const image=Buffer.from(bytes),raster=inspectRaster(image);if(createHash('sha256').update(image).digest('hex')!==candidate.sha256||raster.width!==candidate.width||raster.height!==candidate.height)throw new AiError('IMAGE_INVALID');
    return this.start(profile,context.listing,{operation:'image-appearance-review',context,plan,candidate,previousResultId:previous?.id??null},async activeSignal=>{
      const assertFresh=async()=>{await this.assertImageFresh(context,assertContextFresh,activeSignal);this.imageResult(plan,context,'image-plan');};await assertFresh();
      const images:DeepSeekReferenceImage[]=[];
      for(const asset of this.imageSources(context)){const data=await this.readSource({productId:context.listing.productId,productRevision:context.listing.productRevision,assetId:asset.id},asset,activeSignal);images.push({assetId:asset.id,sha256:asset.sha256,mimeType:asset.mimeType,width:asset.width,height:asset.height,bytes:data});}
      images.push({assetId:candidate.id,sha256:candidate.sha256,mimeType:raster.mimeType,width:candidate.width,height:candidate.height,bytes:image});await assertFresh();
      return{variantId:context.listing.variantId,assetId:null,assetSha256:null,sourceResultIds:[...imageCopySourceIds(context),plan.id,...(previous?[previous.id]:[])],sourceSha256:listingFingerprint(context),imageContext:context,assertFresh,
        invoke:(credentials,adapterContext)=>reviewProductAppearance(context,plan,candidate,images,previous,profile.model as DeepSeekModel,credentials as DeepSeekCredentials,activeSignal,adapterContext)};
    },signal);
  }
  async reviewGeneratedImageRisk(rawContext:ProductImageContext,rawPlan:AiResult,rawCandidate:CandidateImageIdentity,bytes:Buffer,assertContextFresh:()=>void|Promise<void>,signal?:AbortSignal,owner?:AiDurableRequestPort):Promise<AiResult> {
    this.ensureOpen(); const context=validateProductImageContext(rawContext),candidate=validateCandidateImageIdentity(rawCandidate),profile=this.reviewProfile('aliyun-image-risk',owner);
    const plan=this.imageResult(rawPlan,context,'image-plan');
    if(context.policyVersion!==PRODUCT_IMAGE_POLICY_VERSION||plan.output.kind!=='image-plan'||plan.output.ipRisk?.verdict!=='PASS'||!plan.output.productUnderstanding?.sufficient)throw new AiError('SOURCE_CHANGED');
    if(!bytes.length||bytes.length>20*1024*1024)throw new AiError('IMAGE_INVALID');
    const image=Buffer.from(bytes); if(createHash('sha256').update(image).digest('hex')!==candidate.sha256)throw new AiError('SOURCE_CHANGED');
    return this.start(profile,context.listing,{operation:'image-ip-review',context,plan,candidate},async activeSignal=>{
      const assertFresh=async()=>{await this.assertImageFresh(context,assertContextFresh,activeSignal);this.imageResult(plan,context,'image-plan');}; await assertFresh();
      return {variantId:context.listing.variantId,assetId:null,assetSha256:null,sourceResultIds:[...imageCopySourceIds(context),plan.id],sourceSha256:listingFingerprint(context),imageContext:context,assertFresh,
        recoverRequestBytes:image.length,recoverReceipt:(body,adapterContext)=>parseAliyunRiskReply(body,candidate,plan.id,{accessKeyId:'local-only-recovery',accessKeySecret:'local-only-recovery'},adapterContext),
        invoke:(credentials,adapterContext)=>reviewImageWithAliyun(image,candidate,plan.id,credentials as AliyunCredentials,activeSignal,adapterContext)};
    },signal,undefined,undefined,owner);
  }
  taskBatchPlan():TaskBatchPlan{
    const purposes=AI_PURPOSE_IDS.map(id=>resolvePurpose(this.db,id));
    return {version:1,credentialScope:requestKey({provider:'openrouter',generation:this.getProfile('openrouter').generation}),purposes,coverage:[...purposes.map(p=>{const vision=['source_understanding','category_analysis','image_plan','image_plan_repair','appearance_review','appearance_review_difficult'].includes(p.purposeId),connected=p.gateway==='openrouter'&&this.getProfile(reviewPurpose(p.purposeId)?'openrouter-review':'openrouter').enabled,supported=connected&&p.capability.batch&&p.capability.endpoint!=='decisions'&&(!vision||!!this.batchReferences);return {purposeId:p.purposeId,mode:supported?'deferred_batch' as const:'immediate' as const,reason:supported?'已就绪请求按任务、阶段、用途和模型组批':p.gateway==='openrouter'&&!connected?'OpenRouter用途连接未配置或未启用，需处理连接后重新准备任务':vision?'固定版本的参考图托管尚未就绪，按原配置普通调用':'该渠道或协议仅普通调用，不切换模型'};}),...['image_generation','aliyun_ocr','aliyun_image_risk'].map(purposeId=>({purposeId,mode:'immediate' as const,reason:'生图或阿里独立协议按原服务普通调用，不计入Batch优惠覆盖'}))]};
  }
  getPurposeProfiles(){this.ensureOpen();return listPurposeProfiles(this.db);}
  getUsageReport(input:unknown){this.ensureOpen();return readAiUsageReport(this.db,input);}
  /** Main-process connection port only; never exposed through IPC. */
  openRouterApiKey():string|null{
    this.ensureOpen();const profile=this.storedProfile('openrouter');if(!profile.configured)return null;
    const secret=this.vault.inspect('openrouter',profile.generation);return secret.state==='readable'&&'apiKey' in secret.credentials?secret.credentials.apiKey:null;
  }
  savePurposeProfile(input:unknown){this.ensureOpen();return savePurposeProfile(this.db,input as SaveAiPurposeInput);}
  getTextModelCapabilities(){return structuredClone(TEXT_MODEL_CAPABILITIES);}
  readProviderReceipt(callId:string){this.ensureOpen();const id=uuid(callId);return readProviderReceipt(this.db,this.directory,this.batchTasks.find(id)?.id??id);}
  purposeProfile(purpose:AiPurposeId,vision=false,review=false):AiProfile{
    const routing=resolvePurpose(this.db,purpose,{vision});
    const id:AiProviderId=routing.gateway==='openrouter'?(review?'openrouter-review':'openrouter'):(review?'deepseek-review':'deepseek');
    const profile=this.getProfile(id);return {...profile,model:routing.model,thinking:!['none','not_applicable'].includes(routing.effectiveEffort),routing};
  }
  private activePurpose(purpose:AiPurposeId,vision=false,review=false):AiProfile{
    const profile=this.purposeProfile(purpose,vision,review);this.assertProfile(profile.id,profile.generation);return profile;
  }
  private invocationFingerprint(profile:Pick<AiProfile,'id'|'model'|'generation'|'thinking'|'routing'>,input:{productId:string;productRevision:number},source:unknown):string {
    return requestKey({input,source,product:this.product(input.productId,input.productRevision),request:{providerId:profile.id,model:profile.model,generation:profile.generation,thinking:profile.thinking??false,purposeSnapshot:profile.routing??null}});
  }
  private originalProfile(call:AiCall):AiProfile {
    return {id:call.providerId,capability:CAPABILITIES[call.providerId],model:call.model,generation:call.generation,configured:true,enabled:true,...(call.thinking===undefined?{}:{thinking:call.thinking}),...(call.purposeSnapshot?{routing:call.purposeSnapshot}:{})};
  }
  private matchingInvocations(scope:AiRequestScope):AiCall[] {
    return this.db.prepare("SELECT record_json FROM ai_calls WHERE json_extract(record_json,'$.productId')=?").all(scope.productId).map(row=>validateAiCall(JSON.parse(String(row.record_json)))).filter(call=>sameRequestBusiness(scope,legacyRequestScope(call)));
  }
  private pendingInvocation(scope:AiRequestScope,ignoreId?:string):AiCall[] {
    return this.matchingInvocations(scope).filter(call=>call.id!==ignoreId&&!localAiRequestResolved(this.db,this.directory,call.id,call));
  }
  private unknownInvocation(call:AiCall):AiError {
    const error=new AiError('INTERRUPTED');error.callId=call.id;error.certainty='SENT_UNKNOWN';error.message=call.requestScope?'原业务步骤的请求尚未得到可采用结果；请按原调用核对或恢复，未发送新请求':'旧请求缺少完整业务身份；请按原调用核对，未把缺失身份当作未发送';return error;
  }
  private reviewProfile(id:'aliyun-ocr'|'aliyun-image-risk'|'text',owner:AiDurableRequestPort|undefined):AiProfile {
    const call=owner?this.getCall(uuid(owner.fileId)):undefined;
    if(call&&call.requestScope&&(id==='text'?call.requestScope.operation==='image-text-review':call.providerId===id))return this.originalProfile(call);
    return id==='text'?this.activePurpose('image_text_review',false,true):this.assertProfile(id);
  }
  get reviewRequestJournalVersion():2 {this.ensureOpen();return 2;}
  private linkDurableResult(owner:AiDurableRequestPort|undefined,result:AiResult):AiResult {
    if(owner){if(owner.fileId!==result.callId)throw new AiError('INVALID_CONFIG');try{transaction(this.db,()=>owner.resultStored(this.db,result));}catch{const error=new AiError('INTERRUPTED');error.callId=result.callId;error.certainty='RECEIVED_VALID';error.diagnosticReason='DURABLE_RESULT_LINK_FAILED';error.message='已收到原有效审核结果，本地关联未完成；保留原回执与费用，请按原请求恢复，未重发';throw error;}}return result;
  }
  private start(profile: AiProfile, input: { productId: string; productRevision: number }, source: unknown, prepare: (signal: AbortSignal) => Promise<PreparedRequest>, signal?: AbortSignal, completion?:CompletionRequest,durable?:DurableFieldCall,owner?:AiDurableRequestPort): Promise<AiResult> {
    this.ensureOpen();
    if(owner){uuid(owner.fileId);if(types.isAsyncFunction(owner.reserve)||types.isAsyncFunction(owner.resultStored)||types.isAsyncFunction(owner.effect))throw new AiError('INVALID_INPUT');}
    const scope=requestScope(profile,input,source);
    const key = requestKey({ profile, input, source, ...(completion?{completion}:{}), product: this.product(input.productId, input.productRevision) });
    const taskScope=taskAiContext.getStore(),hash=taskScope?requestKey({taskId:taskScope.taskId,rowKey:taskScope.rowKey,key}):null;
    // Sharing the input promise must not share another task row's adoption grant.
    const controlKey=taskScope?requestKey({key,taskId:taskScope.taskId,rowKey:taskScope.rowKey,phase:taskScope.phase,mode:taskScope.mode,waitingOperationId:taskScope.waitingOperationId??null,explicitContinueAt:taskScope.explicitContinueAt??null,credentialScope:taskScope.credentialScope??null,purposes:taskScope.purposes??null,authorized:taskScope.authorize()}):key;
    const ownerControlKey=owner?requestKey({controlKey,fileId:owner.fileId}):controlKey;
    return this.requests.run(ownerControlKey, profile.id, async (activeSignal, responseDeadlineAt) => {
      throwIfAborted(activeSignal);
      const waiting=taskScope?.waitingOperationId?this.batchTasks.find(taskScope.waitingOperationId):undefined;
      const waitingId=taskScope?.waitingOperationId&&!waiting?.adoption?taskScope.waitingOperationId:undefined;
      if(waitingId&&(waiting||this.batchTasks.pendingOperation(waitingId))&&(durable?.id??completion?.callId)&&(durable?.id??completion?.callId)!==waitingId)throw new UserFacingError('原Batch步骤身份尚未解决，不能替换请求编号');
      let id=owner?.fileId??durable?.id??completion?.callId??randomUUID();
      const batchOperationId = owner?.fileId??durable?.id??completion?.callId ?? waitingId?? (hash?`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`:id);
      const pending=this.pendingInvocation(scope),originalBatch=this.batchTasks.find(batchOperationId);
      const assertTaskAuthorized=(sent=false)=>{
        if(!taskScope||taskScope.authorize()===true)return;
        if(originalBatch||this.batchTasks.pendingOperation(batchOperationId))throw new BatchWaitingError(batchOperationId);
        const error=new AiError('CANCELLED');error.abortSource='USER';error.certainty=sent?'SENT_UNKNOWN':'NOT_SENT';throw error;
      };
      assertTaskAuthorized();
      let replay:ReturnType<typeof readCallReceiptSync>|undefined,replayCall:AiCall|undefined;
      if(owner){
        const original=this.getCall(owner.fileId);
        if(original){
          if(!original.requestScope||!sameRequestBusiness(scope,original.requestScope)||original.requestFingerprint!==this.invocationFingerprint(this.originalProfile(original),input,source))throw this.unknownInvocation(original);
          for(const result of this.listResults(original.productId).filter(result=>result.callId===original.id))if(resultHasOwner(result,original)){if(pending.some(call=>call.id!==original.id))throw this.unknownInvocation(pending.find(call=>call.id!==original.id)!);assertReceiptRecovery(this.db,this.directory,result,original);return this.linkDurableResult(owner,result);}
          if(localAiRequestResolved(this.db,this.directory,original.id,original)){const saved=original.errorCode==='OUTPUT_INVALID'?verifiedRecoveryReceipt(this.db,this.directory,original):null;if(saved){if(pending.some(call=>call.id!==original.id))throw this.unknownInvocation(pending.find(call=>call.id!==original.id)!);replay=saved;replayCall=original;Object.assign(profile,this.originalProfile(original));}else{const known=new AiError(original.errorCode??'OUTPUT_INVALID');known.callId=original.id;known.certainty=original.errorCode==='OUTPUT_INVALID'?'RECEIVED_INVALID':'DEFINITIVE_REJECTION';throw known;}}
        }
      }
      // An unresolved Batch call is still protected. Only its own immutable item
      // and transactional task-row reservation can enter the existing runtime's
      // original-receipt path; a waiting ID by itself grants no exception.
      if(taskScope&&originalBatch&&pending.some(call=>call.id===batchOperationId)){
        const original=this.getCall(batchOperationId)!;
        const rowBound=this.db.prepare("SELECT detail_json FROM audit_events WHERE action='run.evidence' AND product_id=? AND json_extract(detail_json,'$.event')='REQUEST_RESERVED' AND json_extract(detail_json,'$.callId')=?").all(input.productId,original.id).some(row=>{
          try{const evidence=validateRunEvidence(JSON.parse(String(row.detail_json)));return evidence.taskId===taskScope.taskId&&evidence.itemKey===taskScope.rowKey;}catch{return false;}
        });
        if(originalBatch.aiCallId!==original.id||originalBatch.taskId!==taskScope.taskId||originalBatch.phase!==taskScope.phase.toLowerCase()||originalBatch.inputFingerprint!==key
          ||originalBatch.owner.productId!==original.productId||originalBatch.owner.productRevision!==original.productRevision||originalBatch.owner.providerId!==original.providerId||originalBatch.owner.generation!==original.generation
          ||originalBatch.purpose.model!==original.model||requestKey(originalBatch.purpose)!==requestKey(original.purposeSnapshot)||!original.requestScope||!sameRequestBusiness(scope,original.requestScope)
          ||original.requestFingerprint!==this.invocationFingerprint(this.originalProfile(original),input,source)||!rowBound)throw this.unknownInvocation(original);
        this.batchTasks.assertCredentialIdentity(taskScope.taskId);
        if(!taskScope.authorize())throw new BatchWaitingError(batchOperationId);
        pending.splice(pending.findIndex(call=>call.id===original.id),1);
      }
      // Restore only an exactly bound original response. No hosting/preparation or
      // new credentials are needed to inspect a completed local recovery.
      for(const original of this.matchingInvocations(scope))if(original.status==='FAILED'&&original.requestScope&&original.requestFingerprint===this.invocationFingerprint(this.originalProfile(original),input,source)){
        const saved=verifiedRecoveryReceipt(this.db,this.directory,original);
        if(!saved||openRouterFailure(saved.record.status,saved.capture.body))continue;
        for(const row of this.db.prepare("SELECT record_json FROM ai_results WHERE json_extract(record_json,'$.callId')=?").all(original.id)){
          const result=validateStoredAiResult(JSON.parse(String(row.record_json)));
          if(result.providerReceiptRecovery&&resultHasOwner(result,original)&&result.providerReceiptRecovery.receiptId===saved.record.id){if(pending.length)throw this.unknownInvocation(pending[0]);assertReceiptRecovery(this.db,this.directory,result,original);return this.linkDurableResult(owner,result);}
        }
      }
      // This guard precedes preparation, reference hosting and paid reservation.

      if(pending.length){
        if(pending.length!==1)throw this.unknownInvocation(pending[0]);
        const original=pending[0],frozen=this.originalProfile(original);
        if(original.status!=='FAILED'||!original.requestScope||!original.requestFingerprint||original.requestFingerprint!==this.invocationFingerprint(frozen,input,source))throw this.unknownInvocation(original);
        const saved=verifiedRecoveryReceipt(this.db,this.directory,original);
        if(!saved||openRouterFailure(saved.record.status,saved.capture.body))throw this.unknownInvocation(original);
        replay=saved;replayCall=original;Object.assign(profile,frozen);
      }
      let call: AiCall | undefined=replayCall, metadata: ProviderMetadata = { requestId: null, usage: emptyUsage(), usageKnown: false }, finished = false, requestBytes = 0;
      if(replayCall)id=replayCall.id;
      let batchItem:BatchItem|undefined,reservingBatch=false,preserveStoredCall=false;let adapterContext:AdapterContext;
      let untrustedOutput: { value: unknown } | undefined, rejectionStage: AiOutputRejectionStage = 'operation-output-validation';
      let evidenceContext: Partial<RunEvidence> = {};
      const evidenceStage = profile.routing?.purposeId ?? (source && typeof source === 'object' && 'operation' in source && typeof source.operation === 'string' ? source.operation : profile.capability);
      const evidence = (patch: Partial<RunEvidence> & Pick<RunEvidence, 'event'>, required = false) => {
        const write = () => appendRunEvidence(this.db, input.productId, {
          version: 1, at: this.timestamp(), stage: evidenceStage,
          ...(taskScope ? { taskId: taskScope.taskId, itemKey: taskScope.rowKey } : {}),
          ...evidenceContext, ...(call ? { callId: call.id } : {}), ...patch,
        });
        if (required) write(); else try { write(); } catch { /* Diagnostics must not discard an already received response or settlement. */ }
      };
      try {
        evidence({ event: 'STAGE_STARTED' });
        throwIfAborted(activeSignal);
        const prepared = await abortable(prepare(activeSignal), activeSignal); throwIfAborted(activeSignal);assertTaskAuthorized(); if(!replay)this.assertProfile(profile.id, profile.generation);
        const draftId=(prepared.imageContext?.listing??prepared.listingContext)?.draftId;
        const listingEvidence = prepared.imageContext?.listing ?? prepared.listingContext;
        evidenceContext = {
          ...(draftId ? { draftId } : {}),
          ...(listingEvidence && evidenceSku(listingEvidence.sku) ? { sku: listingEvidence.sku } : {}),
          ...(completion ? { operationId: completion.operationId } : durable ? { operationId: durable.part?.operationId ?? durable.id } : {}),
          ...(prepared.imageContext ? { slot: prepared.imageContext.slot?.index ?? 0 } : {}),
        };
        if(draftId&&this.db.prepare("SELECT 1 FROM ai_calls c WHERE json_extract(c.record_json,'$.schemaResponseRetained')=1 AND json_extract(c.record_json,'$.providerId')=? AND json_extract(c.record_json,'$.presentationContext.draftId')=? AND NOT EXISTS(SELECT 1 FROM ai_results r WHERE json_extract(r.record_json,'$.callId')=c.id) LIMIT 1").get(profile.id,draftId)){
          const blocked=new AiError('OUTPUT_INVALID');blocked.message='已收到 AI 响应，Schema 检查曾中断；原响应和费用保留，当前步骤无法安全本地恢复，未重发付费请求';throw blocked;
        }
        const adopted=this.batchTasks.find(batchOperationId);
        if(adopted?.adoption){
          if(adopted.inputFingerprint!==key||!taskScope?.authorize())throw new BatchWaitingError(batchOperationId);
          await prepared.assertFresh();const saved=this.getResult(adopted.adoption.id);if(!saved)throw new AiError('INVALID_CONFIG');return this.linkDurableResult(owner,saved);
        }
        const credentials = replay?{apiKey:'local-receipt-read-only'}:this.vault.read(profile.id, profile.generation);
        adapterContext={ ...this.context, ...(replay?{fetch:async(url:any)=>{const expected='https://'+(replay!.record.gateway==='openrouter'?'openrouter.ai':'api.deepseek.com')+replay!.record.endpoint;if(String(url)!==expected)throw new AiError('INVALID_CONFIG');return Response.json(replay!.capture.body,{status:replay!.record.status});}}:{}), responseDeadlineAt, thinking:profile.thinking,gateway:profile.routing?.gateway,effectiveEffort:profile.routing?.effectiveEffort,purposeSnapshot:profile.routing,
          deferOpenRouter:async(endpoint,body)=>{
            if(replay)return null;
            if(!taskScope||endpoint!=='/api/v1/chat/completions'||profile.routing?.gateway!=='openrouter')return null;
            const {model,provider,stream,...ordinaryBody}=body;let requestBody=ordinaryBody,references:BatchReference[]=[];
            if(stream!==false||JSON.stringify(provider)!==JSON.stringify({allow_fallbacks:true,require_parameters:true}))throw new AiError('INVALID_CONFIG');
            if(model!==profile.model)throw new AiError('CONFIG_CHANGED');
            const existingBatch=this.batchTasks.find(batchOperationId)??this.batchTasks.pendingOperation(batchOperationId);
            if(existingBatch){requestBody=existingBatch.body;references=existingBatch.references;}
            else if(!this.batchReferences&&JSON.stringify(ordinaryBody).includes('image_url'))return null;
            else if(taskScope.mode==='deferred_batch'&&this.batchReferences&&JSON.stringify(ordinaryBody).includes('image_url')){
              const pinned=await this.batchReferences.prepare(ordinaryBody,{taskId:taskScope.taskId,operationId:batchOperationId,...input},activeSignal);requestBody=pinned.body;references=pinned.references;
            }
            const batchReplay=await this.batchTasks.request({operation:{aiCallId:batchOperationId,taskId:taskScope.taskId,operationId:batchOperationId,attempt:1,phase:taskScope.phase.toLowerCase(),inputFingerprint:key,schemaFingerprint:listingFingerprint(prepared.listingContext?.schemaSha256??{kind:profile.capability}),credentialScope:requestKey({provider:'openrouter',generation:this.getProfile('openrouter').generation}),owner:{productId:input.productId,productRevision:input.productRevision,providerId:profile.id as 'openrouter'|'openrouter-review',generation:profile.generation},purpose:profile.routing,body:requestBody,references},authorize:taskScope.authorize,reserve:()=>{id=batchOperationId;reservingBatch=true;try{adapterContext.beforeSend?.(JSON.stringify(body));}finally{reservingBatch=false;}}});
            if(!batchReplay)return null;
            id=batchOperationId;batchItem=batchReplay.item;call=this.getCall(id)??undefined;if(!call)throw new AiError('INVALID_CONFIG');
            requestBytes=Buffer.byteLength(JSON.stringify(body));return {body:batchReplay.body};
          },
          onReviewEffect:owner?(kind,event)=>{if(!replay&&owner.effect)transaction(this.db,()=>owner.effect!(this.db,kind,event,this.timestamp()));}:undefined,
          onProviderReceipt:async receipt=>{
            if(replay)return;
            if(!call)throw new AiError('INVALID_CONFIG');const callId=call.id;
            const pending=(async()=>{const saved=await saveProviderReceipt(this.db,this.directory,callId,receipt,profile.routing);evidence({event:'RECEIPT_SAVED',callId,receiptId:saved.id,at:saved.receivedAt,httpStatus:saved.status});if(!finished){call={...call!,providerReceiptId:saved.id};this.saveCall(call);}})();
            this.pendingReceipts.add(pending);try{await pending;}finally{this.pendingReceipts.delete(pending);}
          },
          onRunEvidence: event => {if(!replay)evidence(validateTransportRunEvidence(event));},
          beforeSend: body => {
            if(replay){requestBytes=Buffer.byteLength(body);return;}
            assertTaskAuthorized();
            if(!reservingBatch&&taskScope)this.batchTasks.assertCredentialIdentity(taskScope.taskId);
            if(!reservingBatch&&(this.batchTasks.find(batchOperationId)||this.batchTasks.pendingOperation(batchOperationId)))throw new UserFacingError('原Batch身份仍受保护，不能转为普通请求重发');
            requestBytes = Buffer.byteLength(body);
            throwIfAborted(activeSignal); this.assertProfile(profile.id, profile.generation); if (call) throw new AiError('INVALID_CONFIG');
            const draftId=prepared.listingContext?.draftId??prepared.imageContext?.listing.draftId;
            if(draftId)assertStoredPricingForPaid(this.db,draftId);
            if(prepared.listingContext)this.assertListingSource(prepared.listingContext);
            if(prepared.imageContext)for(const asset of this.imageSources(prepared.imageContext))readManagedImageSync(this.directory,asset);
            if(prepared.sourceColorContext){this.assertSourceColorIdentity(prepared.sourceColorContext);for(const reference of prepared.sourceColorContext.referenceAssets){const asset=this.source({productId:input.productId,productRevision:input.productRevision,assetId:reference.assetId});if(asset.sha256!==reference.sha256)throw new AiError('SOURCE_CHANGED');readManagedImageSync(this.directory,asset);}}
            if(prepared.sourceConsistencyContext){this.assertConsistencyFresh(prepared.sourceConsistencyContext);this.assertConsistencyPricing(prepared.sourceConsistencyContext);}
            prepared.assertBeforeSend?.();
            call = (reservingBatch?this.usage.attachBatch.bind(this.usage):this.usage.reserve.bind(this.usage))({ id, requestScope:scope,requestFingerprint:this.invocationFingerprint(profile,input,source), ...(prepared.categoryContext?{categoryContext:prepared.categoryContext}:{}), ...(durable?{purposeAssignments:durable.assignments}:{}), ...(profile.routing?{purposeSnapshot:profile.routing}:{}), ...(isChatProvider(profile.id)?{thinking:!!profile.thinking}:{}), providerId: profile.id, productId: input.productId, productRevision: input.productRevision, status: 'RUNNING', errorCode: null, requestId: null, model: profile.model, generation: profile.generation, startedAt: this.timestamp(), finishedAt: null, usage: emptyUsage(), ...(prepared.imageContext||prepared.listingContext?{presentationContext:{...(prepared.imagePlanRequestSha256?{imagePlanRequestSha256:prepared.imagePlanRequestSha256}:{}),...(prepared.workflowId?{workflowId:prepared.workflowId}:{}),kind:prepared.imageContext?'image' as const:'listing' as const,draftId:(prepared.imageContext?.listing??prepared.listingContext)!.draftId,variantId:prepared.variantId!,sourceSha256:prepared.sourceSha256!,slot:prepared.imageContext?.slot?.index??0}}:{}), ...(prepared.sourceColorContext?{sourceColorContext:prepared.sourceColorContext}:{}), ...(prepared.sourceConsistencyContext?{sourceConsistencyContext:prepared.sourceConsistencyContext}:{}), ...(prepared.sourceReferenceAliases?{sourceReferenceProtocol:prepared.sourceReferenceAliases.version,sourceReferenceAliases:prepared.sourceReferenceAliases}:{}) }, body, call => { assertTaskAuthorized(); const unresolved=this.pendingInvocation(scope,call.id);if(unresolved.length)throw this.unknownInvocation(unresolved[0]); if(prepared.categoryPriorSnapshot&&listingFingerprint(categoryCalls(this.listCalls().filter(c=>c.id!==call.id),input.productId,input.productRevision))!==prepared.categoryPriorSnapshot)throw new AiError('CONFIG_CHANGED'); if(prepared.categoryRepairPriors?.length)claimCategoryRepair(this.db,prepared.categoryRepairPriors,call); if(prepared.forbiddenRetry)claimConfirmedForbiddenRetry(this.db,prepared.forbiddenRetry.prior,call,prepared.forbiddenRetry.scopeKey); freezeSourceForProduct(this.db,input.productId); if(prepared.imagePlanRequestSha256&&prepared.workflowId&&prepared.imageContext&&this.imagePlanningAttempts(prepared.imageContext,prepared.workflowId)>imagePlanningAllowanceLimit(this.db,prepared.workflowId,prepared.imageContext,prepared.imagePlanRepair))throw new ImagePlanningLimitError(); if(completion)this.completionJournal.markSent(completion,call);durable?.sent?.(call); if(owner)transaction(this.db,()=>owner.reserve(this.db,call)); if(prepared.sourceConsistencyContext)reserveConsistencyAttempt(this.db,prepared.sourceConsistencyContext,call); evidence({ event: 'REQUEST_RESERVED', callId: call.id, at: call.startedAt, certainty: 'NOT_SENT' }, true); });
          },
          onMetadata: value => { if (!finished && (!metadata.usageKnown || value.usageKnown)) metadata = value; },
          onUntrustedOutput: (value,stage) => { if (call && !finished && !activeSignal.aborted) {untrustedOutput = { value };rejectionStage=stage??'operation-output-validation';} },
        };
        if(replay?.record.gateway==='aliyun')requestBytes=prepared.recoverRequestBytes??0;
        const reply=replay?.record.gateway==='aliyun'?(prepared.recoverReceipt?prepared.recoverReceipt(replay.capture.body,adapterContext):(()=>{throw new AiError('INVALID_CONFIG');})()):await prepared.invoke(credentials,adapterContext);
        if (!call) throw new AiError('PROVIDER_ERROR');
        metadata = { requestId: reply.requestId, usage: reply.usage, usageKnown: reply.usageKnown };
        rejectionStage = 'source-freshness';
        untrustedOutput ??= {value:reply.output};
        throwIfAborted(activeSignal); if(!replay)this.assertProfile(profile.id, profile.generation);
        await abortable(prepared.assertFresh(), activeSignal); throwIfAborted(activeSignal);assertTaskAuthorized(!!call); if(!replay)this.assertProfile(profile.id, profile.generation);
        rejectionStage = 'result-record-validation';
        if(durable?.part&&reply.output.kind==='amazon-fields'&&[...reply.output.candidates,...reply.output.missing].some(f=>!durable.part!.fields.includes(f.field)))throw new AiError('OUTPUT_INVALID');
        const resultAt=this.finishedAt(call.startedAt);
        const result = validateAiResult({ ...(replay?{providerReceiptRecovery:{...(call.providerReceiptId?{version:1 as const}:{version:2 as const,receiptSha256:replay.record.sha256}),receiptId:replay.record.id,requestFingerprint:call.requestFingerprint!,scopeSha256:listingFingerprint(call.requestScope!),recoveredAt:resultAt}}:{}), ...(durable?.part?{fieldGroupPart:durable.part}:{}), id: randomUUID(), callId: id, providerId: profile.id, productId: input.productId, productRevision: input.productRevision, variantId: prepared.variantId, assetId: prepared.assetId, assetSha256: prepared.assetSha256, sourceResultIds: prepared.sourceResultIds, model: profile.model, createdAt: resultAt, reviewState: 'unreviewed', output: reply.output, ...(reply.fieldRejections?{fieldRejections:reply.fieldRejections}:{}), ...(reply.listingNormalization ? { listingNormalization: reply.listingNormalization } : {}), ...(prepared.sourceSha256 === undefined ? {} : { sourceSha256: prepared.sourceSha256 }), ...(prepared.listingContext ? { listingEvidenceContractVersion:evidenceVersion(prepared.listingContext), listingContext: prepared.listingContext, listingRequestBytes: requestBytes } : {}), ...(prepared.imageContext ? { listingEvidenceContractVersion:imageEvidenceVersion(prepared.imageContext.listing), imageContext: prepared.imageContext, imageRequestBytes: requestBytes } : {}), ...(prepared.sourceColorContext?{sourceColorContext:prepared.sourceColorContext,sourceColorRequestBytes:requestBytes}:{}), ...(prepared.sourceConsistencyContext?{sourceConsistencyContext:prepared.sourceConsistencyContext,sourceConsistencyRequestBytes:requestBytes}:{}) });
        this.db.exec('BEGIN IMMEDIATE');
        try {
          assertTaskAuthorized(!!call);
          if(prepared.listingContext)this.assertListingSource(prepared.listingContext);
          if(replay){const current=this.getCall(call.id),saved=current?verifiedRecoveryReceipt(this.db,this.directory,current):null;if(!current||JSON.stringify(current)!==JSON.stringify(replayCall)||!saved||saved.record.id!==replay.record.id||saved.record.sha256!==replay.record.sha256||current.requestFingerprint!==this.invocationFingerprint(this.originalProfile(current),input,source))throw new AiError('SOURCE_CHANGED');evidence({event:'RECOVERY_LINKED',callId:call.id,receiptId:saved.record.id,certainty:'RECEIVED_VALID'});}
          if(batchItem){
            const adoptedId=this.batchTasks.service.adopt(batchItem.id,{inputFingerprint:key,authorize:()=>taskScope?.authorize()===true,apply:()=>result.id});
            if(adoptedId!==result.id){
              const saved=this.getResult(adoptedId);
              if(!saved||saved.callId!==call.id||saved.sourceSha256!==prepared.sourceSha256)throw new AiError('INVALID_CONFIG');
              // Another authorized context won this original item's CAS. Do not
              // create a second result or rewrite its call time and settlement.
              preserveStoredCall=!!owner;this.linkDurableResult(owner,saved);this.db.exec('COMMIT');return saved;
            }
          }
          this.db.prepare('INSERT INTO ai_results(id,record_json) VALUES(?,?)').run(result.id, JSON.stringify(result));
          evidence({ event: 'RESULT_STORED', at: result.createdAt, certainty: 'RECEIVED_VALID' });
          evidence({ event: 'STAGE_COMPLETED', at: result.createdAt, certainty: 'RECEIVED_VALID' });
          if(!replay){this.saveCall({ ...call, requestId: metadata.requestId, usage: metadata.usage, status: 'SUCCEEDED', finishedAt: result.createdAt });
          this.usage.settle(id, metadata.usageKnown, metadata.usage, result.createdAt);} if(result.sourceConsistencyContext)recordConsistencyAssessment(this.db,result); if(completion)this.completionJournal.recordResult(completion,result);durable?.result?.(result);this.linkDurableResult(owner,result); this.db.exec('COMMIT'); return result;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      } catch (error) {
        if(error instanceof BatchWaitingError)throw error;
        const schemaReceived=isSchemaTransientError(error)&&rejectionStage==='source-freshness'&&!!call;
        const safe = safeError(error, activeSignal);
        evidence({ event: safe.code === 'OUTPUT_INVALID' && untrustedOutput ? 'OUTPUT_REJECTED' : 'STAGE_BLOCKED',
          errorCode: evidenceCode(safe.diagnosticReason) ? safe.diagnosticReason : safe.code,
          abortSource: safe.abortSource ?? 'NONE',
          ...(safe.certainty ? { certainty: safe.certainty } : {}),
          ...(call ? {} : { certainty: 'NOT_SENT' as const }) });
        if(schemaReceived){safe.diagnosticReason='SCHEMA_TRANSIENT';rejectionStage='schema-freshness-transient';}
        if(call)safe.callId=call.id;
        if (call&&!replay&&!preserveStoredCall) {
          const finishedAt = this.finishedAt(call.startedAt); this.db.exec('BEGIN IMMEDIATE');
          try { this.saveCall({ ...call, requestId: metadata.requestId, usage: metadata.usage, status: 'FAILED', errorCode: safe.code, ...(schemaReceived?{schemaResponseRetained:true as const}:{}), ...(safe.code==='OUTPUT_INVALID'&&['RESPONSE_NOT_CONTENT','RESPONSE_SECRET_ECHO'].includes(safe.diagnosticReason??'')&&source&&typeof source==='object'&&'operation' in source&&source.operation==='image-plan'?{imagePlanRetryBlock:safe.diagnosticReason as AiCall['imagePlanRetryBlock']}:{}), ...(safe.code==='OUTPUT_INVALID'&&untrustedOutput?{responseReceived:true as const}:{}), ...(safe.rejection||safe.reason?{rejection:safe.rejection??{version:'rejection-presentation/v1',code:safe.reason!}}:{}), finishedAt }); this.usage.settle(id, metadata.usageKnown, metadata.usage, finishedAt); this.db.exec('COMMIT'); }
          catch { this.db.exec('ROLLBACK'); /* The durable pending reservation remains conservative. */ }
          if (safe.code === 'OUTPUT_INVALID' && (untrustedOutput||safe.responseDiagnostic)) {
            const operation = source && typeof source === 'object' && 'operation' in source && typeof source.operation === 'string' ? source.operation : profile.capability;
            recordInvalidAiOutput(this.directory,{call,operation,createdAt:finishedAt,rejectionStage:untrustedOutput?rejectionStage:'provider-response-validation',rejectionReason:safe.diagnosticReason??safe.reason,responseDiagnostic:safe.responseDiagnostic,output:untrustedOutput?.value??null});
          }
        }
        throw safe;
      } finally { finished = true; }
    }, signal, profile.thinking ? this.thinkingTimeoutMs : undefined);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => { await this.requests.close(); await Promise.allSettled([...this.pendingReceipts]);this.db.close(); })();
    return this.closing;
  }
}
