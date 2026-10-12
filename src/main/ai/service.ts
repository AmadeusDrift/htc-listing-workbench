import {validateListingContext} from '../listing-ai/validation.ts';
import {replayReferenceCandidates,sameRecoverySource} from '../listing-ai/candidate-recovery.ts';
import { parseImagePlanRecovery } from './image-validation.ts';
import { parseFunctionSettings } from './validation.ts';
import { resultHasOwner } from './result-owner.ts';
import { evidenceVersion,imageEvidenceVersion,isFullSchema } from '../listing-ai/full-schema.ts';
import { assertPresentationResultOwner } from './presentation-history.ts';
import { readManagedImageSync } from './source.ts';
import type { SourceConsistencyContext } from '../../shared/source-image-consistency-contracts.ts';
import { validateConsistencyContext,resolveConsistencyContext,consistencyScopeKey } from '../source-image-consistency/scope.ts';
import { reserveConsistencyAttempt,recordConsistencyAssessment,recordRecoveredConsistency,latestConsistencyAttempt,MAX_SOURCE_ATTEMPTS,assertConsistencyHistory } from '../source-image-consistency/history.ts';
import { requestSourceConsistency } from '../source-image-consistency/adapter.ts';
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
import { recognizeWithAliyun, segmentWithAidge, suggestWithDeepSeek } from './adapters.ts';
import type { AdapterResult, TextPayload } from './adapters.ts';
import { AiError, abortable, safeError, throwIfAborted } from './errors.ts';
import { AiRequestControl, requestKey } from './request-control.ts';
import { AiUsageLedger } from './usage.ts';
import { readManagedImage, sameAsset, validateImage } from './source.ts';
import { emptyUsage } from './transport.ts';
import type { AdapterContext, ProviderMetadata } from './transport.ts';
import { AiVault } from './vault.ts';
import { assertCandidateEvidence, assertReviewEvidence, reviewWithDeepSeek, sourceFingerprint, suggestionFingerprint } from './review.ts';
import type { ReviewPayload } from './review.ts';
import { CAPABILITIES, MAX_OCR_TEXT, MODELS, boundedText, integer, isDeepSeek, keys, object, parseConnectionInput, parseProfileImport, parseRecognizeInput, parseReviewInput, parseSegmentInput, parseSuggestInput, protectedAttribute, providerId, uuid, validateAiCall, validateAiProfile, validateAiResult, validateStoredAiResult, vendorId } from './validation.ts';
import type { AiCredentials, AliyunCredentials, DeepSeekCredentials, DeepSeekModel } from './validation.ts';
import type { ListingAiContext, ListingFieldsOutput } from '../../shared/listing-ai-contracts.ts';
import { reviewListingFields, suggestListingFields } from './listing-adapters.ts';
import { listingFingerprint } from '../listing-ai/validation.ts';
import type { CandidateImageIdentity, CurrentListingCopy, ProductImageContext } from '../../shared/image-ai-contracts.ts';
import { PRODUCT_IMAGE_POLICY_VERSION, imageCopySourceIds } from '../../shared/image-ai-contracts.ts';
import { planProductImage, reviewCurrentListing, reviewProductImageText } from './image-adapters.ts';
import { imageRiskSourceSnapshot, validateCandidateImageIdentity, validateCurrentListingCopy, validateProductImageContext } from './image-validation.ts';
import { inspectRaster } from '../image-format.ts';
import { MAX_IMAGE_BYTES } from './validation.ts';
import type { DeepSeekReferenceImage } from './vision.ts';
import { reviewImageWithAliyun } from './aliyun-image-risk.ts';
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
import { selectImageReferences } from '../image-workflow/records.ts';

export interface AiDependencies {
  fetch?: typeof fetch; now?: () => Date; timeoutMs?: number; maxConcurrency?: number; maxResponseBytes?: number; nonce?: () => string;
  imageGenerationCapability?: () => AiCapabilityInfo;
}
interface PreparedRequest {
  imagePlanRequestSha256?:string;
  workflowId?:string;
  variantId: string | null; assetId: string | null; assetSha256: string | null; sourceResultIds: string[];
  sourceSha256?: string;
  listingContext?: ListingAiContext;
  imageContext?: ProductImageContext;
  sourceColorContext?: SourceColorContext;
  sourceConsistencyContext?: SourceConsistencyContext;
  invoke(credentials: AiCredentials, context: AdapterContext): Promise<AdapterResult>;
  assertFresh(): Promise<void>;
  assertBeforeSend?(): void;
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
    this.imageGenerationCapability = dependencies.imageGenerationCapability;
    this.thinkingTimeoutMs=integer(dependencies.timeoutMs??300000,1,600000);
    this.directory = directory; this.store = store; this.hosting = hosting; this.vault = new AiVault(directory, storage);
    this.requests = new AiRequestControl(integer(dependencies.maxConcurrency ?? 2, 1, 8), integer(dependencies.timeoutMs ?? 120000, 1, 600000));
    this.context = { fetch: dependencies.fetch ?? globalThis.fetch, now: dependencies.now ?? (() => new Date()), nonce: dependencies.nonce ?? randomUUID, maxResponseBytes: integer(dependencies.maxResponseBytes ?? 2 * 1024 * 1024, 1024, 16 * 1024 * 1024) };
    this.db = openDatabase(directory);
    this.completionJournal = new CompletionJournal(this.db,this.directory);
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
    return id === 'deepseek' ? { id, apiKey: '' } : { id, accessKeyId: '', accessKeySecret: '', securityToken: '' };
  }
  /** No asynchronous work can observe the intermediate vault/profile state. */
  private commitProfiles(changes: { profile: AiProfile; credentials?: AiCredentials | null }[]): void {
    const undo: (() => void)[] = []; let transaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      for (const { profile, credentials } of changes) {
        if (credentials !== undefined) undo.push(credentials === null ? this.vault.remove(profile.id) : this.vault.write(profile.id, credentials, profile.generation));
      }
      for (const { profile } of changes) this.saveProfile(profile);
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
    const changes = AI_VENDOR_FUNCTIONS[id].map(role => {
      const previous = this.storedProfile(role), model = functionModel?.id === role ? functionModel.model : previous.model;
      // Check the same credential against each role's public fields before writing either file.
      const checked = parseProfileImport({ id: role, ...(isDeepSeek(role) ? { model } : {}), ...credentials });
      const profile = { ...previous, model, configured: true, generation: integer(previous.generation + 1, 1, Number.MAX_SAFE_INTEGER - 1) };
      return { profile, credentials: checked.credentials };
    });
    this.commitProfiles(changes);
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
    if (o.id === 'aliyun' || (o.id === 'deepseek' && !Object.hasOwn(o, 'model'))) return this.saveConnection(raw);
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
      parseProfileImport({ id, ...(isDeepSeek(id) ? { model } : {}), ...credentials });
    }
    this.commitProfiles([{ profile, credentials }]);
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
    return isDeepSeek(id) ? { id, model: MODELS[id], apiKey: '' } : { id, accessKeyId: '', accessKeySecret: '', securityToken: '' };
  }
  importProfile(raw: unknown): AiProfile {
    this.ensureOpen(); const input = parseProfileImport(raw), previous = this.getProfile(input.id), generation = integer(previous.generation + 1, 1, Number.MAX_SAFE_INTEGER - 1);
    const rollback = this.vault.write(input.id, input.credentials, generation);
    try { this.saveProfile({ id: input.id, capability: CAPABILITIES[input.id], model: input.model, enabled: false, configured: true, generation }); }
    catch (error) { rollback(); throw safeError(error); }
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
  private readPresentationResult=(raw:unknown):AiResult=>{const result=validateStoredAiResult(raw);assertPresentationResultOwner(result,this.getCall(result.callId),this.db);return result;};
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
    const {fieldRejections:_r,...base}=original;
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
      confirmedFacts: product.facts.filter(f => ['source_confirmed', 'human_confirmed'].includes(f.state) && f.value.trim() && !protectedAttribute(f.name)).map(f => ({ id: f.id, name: boundedText(f.name, 100), value: boundedText(f.value, 4000) })),
      unverifiedOcr: sources.map(({ result, asset }) => ({ resultId: result.id, assetId: asset.id, assetSha256: asset.sha256, text: result.output.kind === 'ocr' ? result.output.text : '', verified: false })),
    };
    if (payload.unverifiedOcr.reduce((size, row) => size + row.text.length, 0) > MAX_OCR_TEXT) throw new AiError('INVALID_INPUT');
    return { payload, sources };
  }
  async suggest(raw: unknown, signal?: AbortSignal): Promise<AiResult> {
    this.ensureOpen(); const input = parseSuggestInput(raw), profile = this.assertProfile('deepseek'), snapshot = this.textPayload(input);
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
    if (!result || result.productId !== input.productId || result.providerId !== 'deepseek' || result.output.kind !== 'text' || !result.variantId || !result.sourceSha256 || result.productRevision !== input.productRevision) throw new AiError('SOURCE_CHANGED');
    this.successfulResult(result);
    const textInput = { productId: input.productId, productRevision: input.productRevision, variantId: result.variantId, ocrResultIds: result.sourceResultIds }, snapshot = this.textPayload(textInput);
    if (sourceFingerprint(snapshot.payload) !== result.sourceSha256) throw new AiError('SOURCE_CHANGED');
    assertCandidateEvidence(result.output, snapshot.payload);
    return { suggestion: result as StoredSuggestion, snapshot, textInput, payload: { ...snapshot.payload, suggestionId: result.id, suggestionSha256: suggestionFingerprint(result.output), policyVersion: TEXT_REVIEW_POLICY_VERSION, candidate: result.output } };
  }
  async review(raw: unknown, signal?: AbortSignal): Promise<AiResult> {
    this.ensureOpen(); const input = parseReviewInput(raw), profile = this.assertProfile('deepseek-review'), prepared = this.reviewSnapshot(input);
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
      if (!review || review.productId !== input.productId || review.providerId !== 'deepseek-review' || review.output.kind !== 'text-review' || review.productRevision !== input.productRevision || review.output.verdict !== 'PASS') throw new AiError('OUTPUT_INVALID');
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
  async listingFields(context: ListingAiContext, assertContextFresh: () => Promise<void>, review?: { suggestionId: string; candidate: ListingFieldsOutput }, signal?: AbortSignal, completion?:CompletionRequest): Promise<AiResult> {
    this.ensureOpen();this.assertListingSource(context); const profile = this.assertProfile(review ? 'deepseek-review' : 'deepseek');
    return this.start(profile, { productId: context.productId, productRevision: context.productRevision }, { operation: review ? 'amazon-fields-review' : 'amazon-fields', context, review }, async activeSignal => {
      const assertFresh = async () => { throwIfAborted(activeSignal); await assertContextFresh(); throwIfAborted(activeSignal);this.assertListingSource(context); };
      await assertFresh();
      return { variantId: context.variantId, assetId: null, assetSha256: null, sourceResultIds: review ? [review.suggestionId] : [], sourceSha256: listingFingerprint(context), listingContext: context, assertFresh,
        invoke: (credentials, adapterContext) => review
          ? reviewListingFields(context, review.candidate, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, adapterContext)
          : suggestListingFields(context, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, adapterContext) };
    }, signal, completion);
  }
  /** Reviews a current copy snapshot directly; no synthetic generation or renderer entry point. */
  async reviewCurrentListing(context: ListingAiContext, copy: CurrentListingCopy[], assertContextFresh: () => Promise<void>, signal?: AbortSignal): Promise<AiResult> {
    this.ensureOpen();this.assertListingSource(context); const profile = this.assertProfile('deepseek-review'), currentCopy = validateCurrentListingCopy(copy,isFullSchema(context));
    assertCurrentCopyEvidence(currentCopy,context);
    return this.start(profile, context, { operation: 'listing-current-review', context, currentCopy }, async activeSignal => {
      const assertFresh = async () => { throwIfAborted(activeSignal); await assertContextFresh(); throwIfAborted(activeSignal);this.assertListingSource(context); };
      await assertFresh();
      return { variantId: context.variantId, assetId: null, assetSha256: null, sourceResultIds: [], sourceSha256: listingFingerprint(context), listingContext: context, assertFresh,
        invoke: (credentials, adapterContext) => reviewCurrentListing(context, currentCopy, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, adapterContext) };
    }, signal);
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
      if (!review || review.output.kind !== 'listing-current-review' || review.output.verdict !== 'PASS' || review.providerId !== 'deepseek-review' || !review.listingContext || review.sourceSha256 !== listingFingerprint(context.listing) || listingFingerprint(review.listingContext) !== listingFingerprint(context.listing) || listingFingerprint(review.output.currentListingCopy) !== listingFingerprint(context.currentListingCopy)) throw new AiError('SOURCE_CHANGED');
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
    const profile = { ...this.assertProfile(input.phase === 'judge' ? 'deepseek-review' : 'deepseek'), model: 'deepseek-flash' };
    const generated = new Set(this.db.prepare("SELECT json_extract(record_json,'$.approvedAssetId') AS assetId FROM image_workflow_runs WHERE json_extract(record_json,'$.productId')=? UNION SELECT json_extract(s.value,'$.approvedAssetId') AS assetId FROM image_workflow_runs w, json_each(w.record_json,'$.slots') s WHERE json_extract(w.record_json,'$.productId')=?").all(product.id,product.id).map(row => row.assetId));
    const references = product.assets.filter(asset => !generated.has(asset.id)).slice(0, 3);
    if (!references.length) throw new UserFacingError('商品分类需要至少一张可用来源图片');
    const payload = { phase:input.phase, candidates:input.candidates, keywords:input.keywords ?? [], title:product.title, description:product.description.slice(0, 12000),
      facts:product.facts.filter(fact => ['source_confirmed','human_confirmed'].includes(fact.state)).map(({name,value})=>({name,value})), specifications:product.variants.map(item=>item.originalSpec).slice(0,200) };
    const result = await this.start(profile, input, { operation:'category-decision', payload, references:references.map(asset=>asset.id) }, async activeSignal => {
      const assertFresh = async () => { assertContextFresh(); this.product(input.productId,input.productRevision); throwIfAborted(activeSignal); };
      await assertFresh();
      const images: DeepSeekReferenceImage[] = [];
      for (const reference of references) {
        const source = { productId:product.id,productRevision:product.revision,assetId:reference.id }, asset = this.source(source), bytes = await this.readSource(source,asset,activeSignal);
        images.push({assetId:asset.id,sha256:asset.sha256,mimeType:asset.mimeType,width:asset.width,height:asset.height,bytes});
      }
      return { variantId:variant.id, assetId:null,assetSha256:null,sourceResultIds:[],sourceSha256:listingFingerprint(payload),assertFresh,
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
        if(!call||call.status!=='FAILED'||!['OUTPUT_INVALID','INTERRUPTED','TIMEOUT','PROVIDER_ERROR','NETWORK_ERROR','CANCELLED'].includes(call.errorCode??'')||call.errorCode==='OUTPUT_INVALID'&&hasRetainedInvalidAiOutput(this.directory,call,'source-image-consistency')||(attempt.attemptNumber??1)>=MAX_SOURCE_ATTEMPTS)throw new AiError(call?.errorCode==='OUTPUT_INVALID'?'OUTPUT_INVALID':'INTERRUPTED');
      }else{
      const result=validateStoredAiResult(JSON.parse(String(saved.record_json)));
      if(result.output.kind!=='source-image-consistency'||!result.sourceConsistencyContext||consistencyScopeKey(result.sourceConsistencyContext)!==consistencyScopeKey(context))throw new AiError('INVALID_CONFIG');
      this.successfulResult(result);this.db.exec('BEGIN IMMEDIATE');try{recordConsistencyAssessment(this.db,result);assertConsistencyHistory(this.db,this.directory);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
      await assertContextFresh();this.assertConsistencyFresh(context);throwIfAborted(signal??new AbortController().signal);return result;
      }
    }
    const profile={...this.assertProfile('deepseek'),model:'deepseek-flash'};
    return this.start(profile,context,{operation:'source-image-consistency',context},async activeSignal=>{
      const assertFresh=async()=>{throwIfAborted(activeSignal);await assertContextFresh();throwIfAborted(activeSignal);this.assertConsistencyFresh(context);};
      await assertFresh();const images:DeepSeekReferenceImage[]=[];
      for(const ref of context.referenceAssets){
        const input={productId:context.productId,productRevision:context.productRevision,assetId:ref.assetId},asset=this.source(input),bytes=await this.readSource(input,asset,activeSignal);
        await assertFresh();images.push({assetId:asset.id,sha256:asset.sha256,mimeType:asset.mimeType,width:asset.width,height:asset.height,bytes});
      }
      return{variantId:context.variantId,assetId:null,assetSha256:null,sourceResultIds:[],sourceSha256:listingFingerprint(context),sourceConsistencyContext:context,assertFresh,assertBeforeSend,
        invoke:async(credentials,adapter)=>{await assertFresh();return requestSourceConsistency(context,credentials as DeepSeekCredentials,activeSignal,adapter,images);}};
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
    this.ensureOpen();const context=validateSourceColorContext(rawContext),profile={...this.assertProfile('deepseek'),model:'deepseek-flash'};
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
    if(!call||call.status!=='FAILED'||call.errorCode!=='OUTPUT_INVALID'||!call.finishedAt||call.providerId!=='deepseek'||call.model!=='deepseek-flash'||call.productId!==context.listing.productId||call.productRevision!==context.listing.productRevision||p?.kind!=='image'||p.draftId!==context.listing.draftId||p.variantId!==context.listing.variantId||p.slot!==(context.slot?.index??0)||p.sourceSha256!==hash)return undefined;
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
        if(!(error instanceof AiError)||error.code!=='OUTPUT_INVALID'||!error.callId||!workflowId||['RESPONSE_NOT_CONTENT','RESPONSE_SECRET_ECHO'].includes(error.diagnosticReason??''))throw error;
        const recovered=await this.recoverImagePlan(error.callId,rawContext,assertContextFresh,signal,rawRepair);
        if(recovered)return recovered;
        if(attempt>=2)throw error;
      }
    }
  }
  private imagePlanningAttempts(context:ProductImageContext,workflowId:string):number {
    // Count in SQLite, including legacy records without a request hash. During reserve this
    // uses the same connection/write transaction and includes the newly inserted call.
    const row=this.db.prepare(`SELECT count(*) AS attempts FROM ai_calls WHERE
      json_extract(record_json,'$.providerId')='deepseek' AND json_extract(record_json,'$.model')='deepseek-flash'
      AND json_extract(record_json,'$.productId')=? AND json_extract(record_json,'$.productRevision')=?
      AND json_extract(record_json,'$.presentationContext.kind')='image'
      AND json_extract(record_json,'$.presentationContext.draftId')=? AND json_extract(record_json,'$.presentationContext.variantId')=?
      AND json_extract(record_json,'$.presentationContext.sourceSha256')=? AND json_extract(record_json,'$.presentationContext.slot')=?
      AND json_extract(record_json,'$.presentationContext.workflowId')=?`).get(context.listing.productId,context.listing.productRevision,context.listing.draftId,context.listing.variantId,listingFingerprint(context),context.slot?.index??0,workflowId);
    return Number(row!.attempts);
  }
  private async imagePlanOnce(rawContext: ProductImageContext, assertContextFresh: () => void | Promise<void>, rawRepair?: { previousPlanId: string; issues: string[] }, signal?: AbortSignal, workflowId?:string,onRequestSent?:()=>void): Promise<AiResult> {
    this.ensureOpen(); const context = validateProductImageContext(rawContext), profile = { ...this.assertProfile('deepseek'), model: 'deepseek-flash' };
    if (context.policyVersion !== PRODUCT_IMAGE_POLICY_VERSION) throw new AiError('SOURCE_CHANGED');
    let repair: { previousPlanId: string; issues: string[] } | undefined;
    if (rawRepair) {
      const value = keys(rawRepair, ['previousPlanId','issues']);
      if (!Array.isArray(value.issues) || !value.issues.length || value.issues.length > 50) throw new AiError('INVALID_INPUT');
      repair = { previousPlanId: uuid(value.previousPlanId), issues: value.issues.map(issue => boundedText(issue, 2000)) };
    }
    const prior = repair ? this.getResult(repair.previousPlanId) : undefined;
    if (repair && !prior) throw new AiError('SOURCE_CHANGED');
    {
      const requestHash=listingFingerprint({context,repair:repair??null});
      const call=this.listCalls().filter(call=>(call.presentationContext?.imagePlanRequestSha256===requestHash||!repair&&call.presentationContext?.imagePlanRequestSha256===undefined)&&call.presentationContext?.sourceSha256===listingFingerprint(context)&&call.presentationContext?.workflowId===workflowId).sort((a,b)=>b.startedAt.localeCompare(a.startedAt))[0];
      if(call?.status==='SUCCEEDED'){
        const refusal=this.listResults(call.productId).find(result=>result.callId===call.id&&result.output.kind==='image-plan'&&(result.output.productUnderstanding?.sufficient===false||!!workflowId&&call.presentationContext?.imagePlanRequestSha256===requestHash)&&result.sourceSha256===listingFingerprint(context));
        if(refusal){await this.assertImageFresh(context,assertContextFresh,signal??new AbortController().signal);this.successfulResult(refusal);return refusal;}
      }
      if(call){const recovered=await this.recoverImagePlan(call.id,context,assertContextFresh,signal,repair);if(recovered)return recovered;if(imagePlanRetryForbidden(this.directory,call))throw new AiError('OUTPUT_INVALID');}
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
      return { imagePlanRequestSha256:listingFingerprint({context,repair:repair??null}),...(workflowId?{workflowId:uuid(workflowId)}:{}), variantId: context.listing.variantId, assetId: null, assetSha256: null, sourceResultIds: [...imageCopySourceIds(context), ...(prior ? [prior.id] : [])], sourceSha256: listingFingerprint(context), imageContext: context, assertFresh,
        assertBeforeSend:()=>{if(workflowId&&this.imagePlanningAttempts(context,workflowId)>=3)throw new AiError('OUTPUT_INVALID');},
        invoke: (credentials, adapterContext) => planProductImage(context, repair?{...repair,previousPlan:prior?.output as import('../../shared/image-ai-contracts.ts').ImagePlanOutput}:undefined, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, {...adapterContext,imagePlanRetry:!!workflowId&&this.imagePlanningAttempts(context,workflowId)>0,beforeSend:body=>{adapterContext.beforeSend?.(body);onRequestSent?.();}}, images) };
    }, signal);
  }
  async recognizeGeneratedImage(rawContext: ProductImageContext, rawCandidate: CandidateImageIdentity, bytes: Buffer, assertContextFresh: () => void | Promise<void>, signal?: AbortSignal): Promise<AiResult> {
    this.ensureOpen(); const context = validateProductImageContext(rawContext), candidate = validateCandidateImageIdentity(rawCandidate), profile = this.assertProfile('aliyun-ocr');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES || createHash('sha256').update(bytes).digest('hex') !== candidate.sha256) throw new AiError('IMAGE_INVALID');
    const image = Buffer.from(bytes), raster = inspectRaster(image);
    if (!['image/png','image/jpeg'].includes(raster.mimeType) || raster.width !== candidate.width || raster.height !== candidate.height) throw new AiError('IMAGE_INVALID');
    return this.start(profile, context.listing, { operation: 'generated-image-ocr', context, candidate }, async activeSignal => {
      const assertFresh = () => this.assertImageFresh(context, assertContextFresh, activeSignal); await assertFresh();
      return { variantId: context.listing.variantId, assetId: null, assetSha256: null, sourceResultIds: imageCopySourceIds(context), sourceSha256: listingFingerprint(context), imageContext: context, assertFresh,
        invoke: async (credentials, adapterContext) => { const reply = await recognizeWithAliyun(image, candidate, credentials as AliyunCredentials, activeSignal, adapterContext); return { ...reply, output: { ...reply.output, kind: 'generated-image-ocr', candidate } }; } };
    }, signal);
  }
  async reviewGeneratedImage(rawContext: ProductImageContext, rawPlan: AiResult, rawOcr: AiResult, rawCandidate: CandidateImageIdentity, assertContextFresh: () => void | Promise<void>, signal?: AbortSignal): Promise<AiResult> {
    this.ensureOpen(); const context = validateProductImageContext(rawContext), candidate = validateCandidateImageIdentity(rawCandidate), profile = this.assertProfile('deepseek-review');
    const plan = this.imageResult(rawPlan, context, 'image-plan'), ocr = this.imageResult(rawOcr, context, 'generated-image-ocr');
    if (ocr.output.kind !== 'generated-image-ocr' || listingFingerprint(ocr.output.candidate) !== listingFingerprint(candidate)) throw new AiError('SOURCE_CHANGED');
    return this.start(profile, context.listing, { operation: 'image-text-review', context, plan, ocr, candidate }, async activeSignal => {
      const assertFresh = async () => { await this.assertImageFresh(context, assertContextFresh, activeSignal); this.imageResult(plan, context, 'image-plan'); this.imageResult(ocr, context, 'generated-image-ocr'); };
      await assertFresh();
      return { variantId: context.listing.variantId, assetId: null, assetSha256: null, sourceResultIds: [...imageCopySourceIds(context), plan.id, ocr.id], sourceSha256: listingFingerprint(context), imageContext: context, assertFresh,
        invoke: (credentials, adapterContext) => reviewProductImageText(context, plan, ocr, candidate, profile.model as DeepSeekModel, credentials as DeepSeekCredentials, activeSignal, adapterContext) };
    }, signal);
  }
  async reviewGeneratedImageRisk(rawContext:ProductImageContext,rawPlan:AiResult,rawCandidate:CandidateImageIdentity,bytes:Buffer,assertContextFresh:()=>void|Promise<void>,signal?:AbortSignal):Promise<AiResult> {
    this.ensureOpen(); const context=validateProductImageContext(rawContext),candidate=validateCandidateImageIdentity(rawCandidate),profile=this.assertProfile('aliyun-image-risk');
    const plan=this.imageResult(rawPlan,context,'image-plan');
    if(context.policyVersion!==PRODUCT_IMAGE_POLICY_VERSION||plan.output.kind!=='image-plan'||plan.output.ipRisk?.verdict!=='PASS'||!plan.output.productUnderstanding?.sufficient)throw new AiError('SOURCE_CHANGED');
    if(!bytes.length||bytes.length>20*1024*1024)throw new AiError('IMAGE_INVALID');
    const image=Buffer.from(bytes); if(createHash('sha256').update(image).digest('hex')!==candidate.sha256)throw new AiError('SOURCE_CHANGED');
    return this.start(profile,context.listing,{operation:'image-ip-review',context,plan,candidate},async activeSignal=>{
      const assertFresh=async()=>{await this.assertImageFresh(context,assertContextFresh,activeSignal);this.imageResult(plan,context,'image-plan');}; await assertFresh();
      return {variantId:context.listing.variantId,assetId:null,assetSha256:null,sourceResultIds:[...imageCopySourceIds(context),plan.id],sourceSha256:listingFingerprint(context),imageContext:context,assertFresh,
        invoke:(credentials,adapterContext)=>reviewImageWithAliyun(image,candidate,plan.id,credentials as AliyunCredentials,activeSignal,adapterContext)};
    },signal);
  }
  private start(profile: AiProfile, input: { productId: string; productRevision: number }, source: unknown, prepare: (signal: AbortSignal) => Promise<PreparedRequest>, signal?: AbortSignal, completion?:CompletionRequest): Promise<AiResult> {
    this.ensureOpen();
    const key = requestKey({ profile, input, source, ...(completion?{completion}:{}), product: this.product(input.productId, input.productRevision) });
    return this.requests.run(key, profile.id, async activeSignal => {
      const id = completion?.callId ?? randomUUID(); let call: AiCall | undefined, metadata: ProviderMetadata = { requestId: null, usage: emptyUsage(), usageKnown: false }, finished = false, requestBytes = 0;
      let untrustedOutput: { value: unknown } | undefined, rejectionStage: AiOutputRejectionStage = 'operation-output-validation';
      try {
        throwIfAborted(activeSignal);
        const prepared = await abortable(prepare(activeSignal), activeSignal); throwIfAborted(activeSignal); this.assertProfile(profile.id, profile.generation);
        const credentials = this.vault.read(profile.id, profile.generation);
        const reply = await abortable(prepared.invoke(credentials, { ...this.context, thinking:profile.thinking,
          beforeSend: body => {
            requestBytes = Buffer.byteLength(body);
            throwIfAborted(activeSignal); this.assertProfile(profile.id, profile.generation); if (call) throw new AiError('INVALID_CONFIG');
            const draftId=prepared.listingContext?.draftId??prepared.imageContext?.listing.draftId;
            if(draftId)assertStoredPricingForPaid(this.db,draftId);
            if(prepared.listingContext)this.assertListingSource(prepared.listingContext);
            if(prepared.imageContext)for(const asset of this.imageSources(prepared.imageContext))readManagedImageSync(this.directory,asset);
            if(prepared.sourceColorContext){this.assertSourceColorIdentity(prepared.sourceColorContext);for(const reference of prepared.sourceColorContext.referenceAssets){const asset=this.source({productId:input.productId,productRevision:input.productRevision,assetId:reference.assetId});if(asset.sha256!==reference.sha256)throw new AiError('SOURCE_CHANGED');readManagedImageSync(this.directory,asset);}}
            if(prepared.sourceConsistencyContext){this.assertConsistencyFresh(prepared.sourceConsistencyContext);this.assertConsistencyPricing(prepared.sourceConsistencyContext);}
            prepared.assertBeforeSend?.();
            call = this.usage.reserve({ id, ...(isDeepSeek(profile.id)?{thinking:!!profile.thinking}:{}), providerId: profile.id, productId: input.productId, productRevision: input.productRevision, status: 'RUNNING', errorCode: null, requestId: null, model: profile.model, generation: profile.generation, startedAt: this.timestamp(), finishedAt: null, usage: emptyUsage(), ...(prepared.imageContext||prepared.listingContext?{presentationContext:{...(prepared.imagePlanRequestSha256?{imagePlanRequestSha256:prepared.imagePlanRequestSha256}:{}),...(prepared.workflowId?{workflowId:prepared.workflowId}:{}),kind:prepared.imageContext?'image' as const:'listing' as const,draftId:(prepared.imageContext?.listing??prepared.listingContext)!.draftId,variantId:prepared.variantId!,sourceSha256:prepared.sourceSha256!,slot:prepared.imageContext?.slot?.index??0}}:{}), ...(prepared.sourceColorContext?{sourceColorContext:prepared.sourceColorContext}:{}), ...(prepared.sourceConsistencyContext?{sourceConsistencyContext:prepared.sourceConsistencyContext}:{}) }, body, call => { if(prepared.imagePlanRequestSha256&&prepared.workflowId&&prepared.imageContext&&this.imagePlanningAttempts(prepared.imageContext,prepared.workflowId)>3)throw new AiError('OUTPUT_INVALID'); if(completion)this.completionJournal.markSent(completion,call); if(prepared.sourceConsistencyContext)reserveConsistencyAttempt(this.db,prepared.sourceConsistencyContext,call); });
          },
          onMetadata: value => { if (!finished && !activeSignal.aborted && (!metadata.usageKnown || value.usageKnown)) metadata = value; },
          onUntrustedOutput: (value,stage) => { if (call && !finished && !activeSignal.aborted) {untrustedOutput = { value };rejectionStage=stage??'operation-output-validation';} },
        }), activeSignal);
        if (!call) throw new AiError('PROVIDER_ERROR');
        metadata = { requestId: reply.requestId, usage: reply.usage, usageKnown: reply.usageKnown };
        rejectionStage = 'source-freshness';
        throwIfAborted(activeSignal); this.assertProfile(profile.id, profile.generation);
        await abortable(prepared.assertFresh(), activeSignal); throwIfAborted(activeSignal); this.assertProfile(profile.id, profile.generation);
        rejectionStage = 'result-record-validation';
        const result = validateAiResult({ id: randomUUID(), callId: id, providerId: profile.id, productId: input.productId, productRevision: input.productRevision, variantId: prepared.variantId, assetId: prepared.assetId, assetSha256: prepared.assetSha256, sourceResultIds: prepared.sourceResultIds, model: profile.model, createdAt: this.finishedAt(call.startedAt), reviewState: 'unreviewed', output: reply.output, ...(reply.fieldRejections?{fieldRejections:reply.fieldRejections}:{}), ...(reply.listingNormalization ? { listingNormalization: reply.listingNormalization } : {}), ...(prepared.sourceSha256 === undefined ? {} : { sourceSha256: prepared.sourceSha256 }), ...(prepared.listingContext ? { listingEvidenceContractVersion:evidenceVersion(prepared.listingContext), listingContext: prepared.listingContext, listingRequestBytes: requestBytes } : {}), ...(prepared.imageContext ? { listingEvidenceContractVersion:imageEvidenceVersion(prepared.imageContext.listing), imageContext: prepared.imageContext, imageRequestBytes: requestBytes } : {}), ...(prepared.sourceColorContext?{sourceColorContext:prepared.sourceColorContext,sourceColorRequestBytes:requestBytes}:{}), ...(prepared.sourceConsistencyContext?{sourceConsistencyContext:prepared.sourceConsistencyContext,sourceConsistencyRequestBytes:requestBytes}:{}) });
        this.db.exec('BEGIN IMMEDIATE');
        try {
          if(prepared.listingContext)this.assertListingSource(prepared.listingContext);
          this.db.prepare('INSERT INTO ai_results(id,record_json) VALUES(?,?)').run(result.id, JSON.stringify(result));
          this.saveCall({ ...call, requestId: metadata.requestId, usage: metadata.usage, status: 'SUCCEEDED', finishedAt: result.createdAt });
          this.usage.settle(id, metadata.usageKnown, metadata.usage, result.createdAt); if(result.sourceConsistencyContext)recordConsistencyAssessment(this.db,result); if(completion)this.completionJournal.recordResult(completion,result); this.db.exec('COMMIT'); return result;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      } catch (error) {
        const safe = safeError(error, activeSignal);
        if (call) {
          safe.callId=call.id;
          const finishedAt = this.finishedAt(call.startedAt); this.db.exec('BEGIN IMMEDIATE');
          try { this.saveCall({ ...call, requestId: metadata.requestId, usage: metadata.usage, status: 'FAILED', errorCode: safe.code, ...(safe.code==='OUTPUT_INVALID'&&untrustedOutput?{responseReceived:true as const}:{}), ...(safe.rejection||safe.reason?{rejection:safe.rejection??{version:'rejection-presentation/v1',code:safe.reason!}}:{}), finishedAt }); this.usage.settle(id, metadata.usageKnown, metadata.usage, finishedAt); this.db.exec('COMMIT'); }
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
    this.closing = (async () => { await this.requests.close(); this.db.close(); })();
    return this.closing;
  }
}
