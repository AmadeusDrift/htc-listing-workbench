import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiCapabilityInfo } from '../../shared/ai-contracts.ts';
import type { GenerateImageCandidateInput, GeneratedImageCandidate, ImageGenerationConnection, ImageGenerationProvider, ImageGenerationOwner } from '../../shared/image-generation-contracts.ts';
import type { WorkspaceStore, StoredAsset } from '../store.ts';
import type { SecretStorage } from '../amazon/vault.ts';
import { AiError, abortError, abortable, throwIfAborted } from '../ai/errors.ts';
import { readBounded } from '../ai/transport.ts';
import { keys, uuid } from "../ai/primitives.ts";
import { readManagedImage, sameAsset, validateImage } from '../ai/source.ts';
import { inspectRaster } from '../image-format.ts';
import { OpenRouterImageAdapter,decodeOpenRouterImage } from '../ai/adapters/openrouter-images.ts';
import { openRouterFailure,openRouterReceiptState } from '../ai/adapters/openrouter-http.ts';
import { OPENROUTER_IMAGE_MODELS } from '../../shared/image-generation-contracts.ts';
import { openDatabase } from '../database.ts';
import type { DatabaseSync } from 'node:sqlite';
import type {ImageRequestIntent} from '../ai/receipts.ts';
import { saveProviderReceipt,readProviderReceipt,saveImageRequestIntent,readImageRequestIntent,readImageReceiptSync,imageRequestFingerprint } from '../ai/receipts.ts';
import { ImageGenerationVault, imageApiKey, imageDefaults, imageModel, activeImageProvider as imageProvider, imageQuality, privateDirectory, validImageSize } from './vault.ts';
import type { ImageGenerationConfig } from './vault.ts';
import { readCandidateFiles,readCandidateFilesSync } from './candidate.ts';
import {validateRequestScope,sameRequestBusiness} from '../ai/request-identity.ts';
import type {AiRequestScope} from '../../shared/ai-request-identity-contracts.ts';
import {transaction} from '../application/transaction.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import type { RelayDownloadDependencies } from './download.ts';
import type { ImageModelCatalog } from '../../shared/image-generation-contracts.ts';
import { imageRequestNotSent, invalidImageOutput } from './errors.ts';
import { recordErrorEvidence } from '../error-evidence.ts';
import {AiSpendBudget} from '../ai/spend-budget.ts';
import {prepareImageSpendReceiptProof} from '../ai/spend-receipts.ts';
import {SpendBudgetError,priceEvidence,imageSpendBound,spendObject,spendDate,usdLimitMicros} from '../ai/spend-records.ts';
import type {ImageGenerationSpendStatus} from '../../shared/ai-spend-contracts.ts';
import type {ImagePriceEvidence} from '../../shared/ai-spend-contracts.ts';
import {ControlledRunScopes,ControlledRunError,readControlledRunScope,CONTROLLED_RUN_ID} from '../application/controlled-run-scope.ts';
import {sourceStamp} from '../automatic-listing/records.ts';

export interface ImageGenerationDependencies { requiredSpendScopeId?:string; beforeEffect?:(scope:Readonly<AiRequestScope>,db?:DatabaseSync)=>void; fetch?: typeof fetch; timeoutMs?: number; decodePreview: (bytes: Buffer) => Buffer; processPreview?: (bytes: Buffer) => Promise<Buffer>; normalizeImage?: (bytes: Buffer) => Buffer; downloadDependencies?: RelayDownloadDependencies }
function parseInput(raw: unknown, provider: ImageGenerationProvider, model: string): GenerateImageCandidateInput {
  const o = keys(raw, ['productId', 'productRevision', 'prompt', 'referenceAssetIds', 'size', 'quality', 'background']);
  if (!Number.isSafeInteger(o.productRevision) || Number(o.productRevision) < 1 || typeof o.prompt !== 'string' || !o.prompt.trim() || o.prompt.length > 32000 || o.prompt.includes('\0') ||
      !Array.isArray(o.referenceAssetIds) || o.referenceAssetIds.length > 16 || !validImageSize(o.size, provider, model) ||
      typeof o.quality !== 'string' || !['auto', 'low', 'medium', 'high'].includes(o.quality) || typeof o.background !== 'string' || !['auto', 'opaque', 'transparent'].includes(o.background)) throw new AiError('INVALID_INPUT');
  const refs = o.referenceAssetIds.map(uuid); if (new Set(refs).size !== refs.length) throw new AiError('INVALID_INPUT');
  return { productId: uuid(o.productId), productRevision: Number(o.productRevision), prompt: o.prompt.trim(), referenceAssetIds: refs,
    size: o.size as GenerateImageCandidateInput['size'], quality: o.quality as GenerateImageCandidateInput['quality'], background: o.background as GenerateImageCandidateInput['background'] };
}
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (config: ImageGenerationConfig) => digest(JSON.stringify(config));

/** Provider credentials and candidate artifacts stay separate from product source images. */
export class ImageGenerationService {
  private pendingReceipts=new Set<Promise<unknown>>();
  private sharedConnection?:{read():string|null;save(key:string):unknown;disconnect():unknown};
  private directory: string; private store: WorkspaceStore; private vault: ImageGenerationVault; private adapter: OpenRouterImageAdapter; private db:DatabaseSync;
  private processPreview: (bytes: Buffer) => Buffer | Promise<Buffer>; private decodePreview: (bytes: Buffer) => Buffer; private timeoutMs: number; private closed = false;
  private running = new Set<{ controller: AbortController; promise: Promise<unknown> }>();
  private queued: {controller:AbortController;start:()=>void;reject:(error:unknown)=>void}[]=[];
  private workflowRequests=new Map<string,{identity:string;promise:Promise<GeneratedImageCandidate>}>();
  private checked?: { fingerprint: string; result: 'accessible' | 'failed'; at: string };
  private scope?: { fingerprint: string; token: string };
  private fetcher: typeof fetch;
  private catalog?: { keyHash: string; value: ImageModelCatalog };
  private spend:AiSpendBudget;private controlledScopes:ControlledRunScopes;
  private requiredSpendScopeId?:string;
  private beforeEffect?:ImageGenerationDependencies['beforeEffect'];
  constructor(directory: string, store: WorkspaceStore, storage: SecretStorage, deps: ImageGenerationDependencies) {
    if(deps.requiredSpendScopeId!==undefined&&deps.requiredSpendScopeId!==CONTROLLED_RUN_ID||deps.beforeEffect?.constructor.name==='AsyncFunction')throw new AiError('INVALID_CONFIG');this.requiredSpendScopeId=deps.requiredSpendScopeId;this.beforeEffect=deps.beforeEffect;
    this.directory = directory; this.store = store; this.vault = new ImageGenerationVault(directory, storage);
    this.fetcher = deps.fetch ?? globalThis.fetch; this.db=openDatabase(directory);
    this.spend=new AiSpendBudget(this.db);this.controlledScopes=new ControlledRunScopes(this.db);
    this.adapter = new OpenRouterImageAdapter({ fetch: deps.fetch }); this.decodePreview = deps.decodePreview; this.processPreview = deps.processPreview ?? deps.decodePreview;
    this.timeoutMs = deps.timeoutMs ?? 660000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 1800000) throw new AiError('INVALID_CONFIG');
  }
  private ensureOpen(): void { if (this.closed) throw new AiError('SERVICE_CLOSED'); }
  private controlledImageBlocked():never{throw Object.assign(new ControlledRunError(),{certainty:'NOT_SENT' as const,notSent:true as const});}
  /** Local recovery needs original fixed ownership, but never a new dispatch grant, Key or quote. */
  private assertRequiredImageOwner(effect:AiRequestScope,intent?:ImageRequestIntent):void{
    if(this.requiredSpendScopeId===undefined)return;const scope=readControlledRunScope(this.db);
    if(!scope?.review||scope.id!==this.requiredSpendScopeId||!effect.draftId||!effect.sku||effect.slot===undefined||!effect.variantIds||effect.operation!=='image-generation')this.controlledImageBlocked();
    this.controlledScopes.taskSelection(scope.taskId);const item=scope.items.find(row=>row.itemKey===scope.activeItemKey)!;
    if(effect.productId!==item.productId||effect.sku!==item.sku||effect.targetId!==scope.targetId||effect.marketplaceId!==scope.marketplaceId||listingFingerprint(effect.variantIds)!==listingFingerprint([...item.variantIds].sort()))this.controlledImageBlocked();
    const saved=this.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(scope.taskId),task=saved?JSON.parse(String(saved.record_json)):null,row=task?.items?.find((row:{key:string})=>row.key===item.itemKey),stamp=scope.review.sourceStamps.find(row=>row.itemKey===item.itemKey)?.stamp;
    if(!row||row.draftId!==effect.draftId||row.sourceStamp!==stamp||sourceStamp(this.store.getProductSnapshot(item.productId))!==stamp)this.controlledImageBlocked();
    const stored=this.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(effect.draftId),draft=stored?JSON.parse(String(stored.record_json)).draft:null,variants=draft?.salesPlan?.recipe?.components?.map((component:{variantId:string})=>component.variantId)??(draft?.variantId?[draft.variantId]:[]);
    if(!draft||draft.id!==effect.draftId||draft.productId!==item.productId||draft.sku!==item.sku||draft.targetId!==scope.targetId||draft.sellerId!==scope.sellerId||draft.marketplaceId!==scope.marketplaceId||draft.mode!=='live'||draft.schema?.parentageLevel!=='NONE'||draft.salesPlan&&draft.salesPlan.parentage!=='NONE'||(draft.salesPlan?.recipe?.key??null)!==item.recipeKey||listingFingerprint([...new Set(variants)].sort())!==listingFingerprint([...item.variantIds].sort()))this.controlledImageBlocked();
    if(intent){const money=this.spend.list().find(row=>row.id===intent.id);if(intent.version!==2||intent.productId!==item.productId||intent.productRevision!==draft.productRevision||listingFingerprint(intent.requestScope)!==listingFingerprint(effect)||!money||money.scopeId!==scope.id)this.controlledImageBlocked();}
  }
  private authorizeImageScope(effect:AiRequestScope):string|null{
    try{this.assertRequiredImageOwner(effect);const scope=this.controlledScopes.authorizeImage(effect);if(this.requiredSpendScopeId!==undefined&&scope!==this.requiredSpendScopeId)this.controlledImageBlocked();const checked=this.beforeEffect?.(Object.freeze({...effect}),this.db.isTransaction?this.db:undefined) as unknown;if(checked&&typeof(checked as PromiseLike<unknown>).then==='function')throw new AiError('INVALID_CONFIG');return scope;}catch(error){if(this.requiredSpendScopeId!==undefined&&error instanceof ControlledRunError)Object.assign(error,{certainty:'NOT_SENT' as const,notSent:true as const});throw error;}
  }
  attachOpenRouterConnection(port:{read():string|null;save(key:string):unknown;disconnect():unknown}):void{
    if(this.sharedConnection)throw new AiError('INVALID_CONFIG');this.sharedConnection=port;
  }
  private readConnection(provider:ImageGenerationProvider='openrouter'):ReturnType<ImageGenerationVault['inspect']>{
    imageProvider(provider);const saved=this.vault.inspect(provider);
    if(!this.sharedConnection)return saved.state==='ready'&&saved.config.credentialRef?{state:'absent'}:saved;
    const apiKey=this.sharedConnection.read();if(!apiKey)return{state:'absent'};
    return{state:'ready',config:{...(saved.state==='ready'?saved.config:{provider:'openrouter' as const,...imageDefaults('openrouter'),enabled:false}),apiKey,credentialRef:'openrouter'}};
  }
  get busy(): boolean { return this.running.size>0||this.queued.length>0; }
  /** Local ledger observation only: never obtains pricing, models, credits or credentials. */
  getSpendStatus():ImageGenerationSpendStatus{this.ensureOpen();return{currency:'USD',unit:'microUSD',daily:this.spend.status('image-generation-daily'),controlledLifetime:this.spend.status('controlled-live-lifetime'),controlledRunStatus:readControlledRunScope(this.db)?.status??'not-registered',quoteStatus:'not-checked'};}
  setDailySpendLimit(raw:unknown):ImageGenerationSpendStatus{this.ensureOpen();const value=spendObject(raw,['limitUsd','expectedUpdatedAt']);if(value.expectedUpdatedAt!==null)spendDate(value.expectedUpdatedAt);this.spend.setImagePolicy(usdLimitMicros(value.limitUsd),value.expectedUpdatedAt);return this.getSpendStatus();}
  getModels(): ImageModelCatalog {
    this.ensureOpen(); const current = this.readConnection('openrouter');
    return structuredClone(current.state === 'ready' && this.catalog?.keyHash === digest(current.config.apiKey) ? this.catalog.value : ({source:'builtin' as const,fetchedAt:null,models:OPENROUTER_IMAGE_MODELS.map(id=>({id,protocol:'images' as const,endpoints:['/api/v1/images']}))}));
  }
  async refreshModels(): Promise<ImageModelCatalog> {
    this.ensureOpen(); const config = this.config(false, 'openrouter');
    return this.controlled(async signal => {
      const timeout = setTimeout(() => this.cancel(new AiError('TIMEOUT')), 20000);
      try {
        const response=await this.fetcher('https://openrouter.ai/api/v1/images/models',{headers:{authorization:'Bearer '+config.apiKey},signal,redirect:'error'});
        if(!response.ok)throw new AiError('SERVICE_PERMISSION_REQUIRED');const raw=await readBounded(response,4*1024*1024,signal) as any;if(!Array.isArray(raw?.data))throw new AiError('OUTPUT_INVALID');
        const value:ImageModelCatalog={source:'remote',fetchedAt:new Date().toISOString(),models:raw.data.filter((r:any)=>OPENROUTER_IMAGE_MODELS.includes(r.id)).map((r:any)=>({id:r.id,protocol:'images',endpoints:['/api/v1/images']}))}; throwIfAborted(signal);
        const current = this.readConnection('openrouter');
        if (current.state !== 'ready' || fingerprint(current.config) !== fingerprint(config)) throw new AiError('CONFIG_CHANGED');
        this.catalog = { keyHash: digest(config.apiKey), value }; return structuredClone(value);
      } finally { clearTimeout(timeout); }
    });
  }
  /** Main-process only. Random identity changes on any effective configuration/key change. */
  configurationScope(): string {
    this.ensureOpen(); const value=fingerprint(this.config(false));
    if (this.scope?.fingerprint!==value) this.scope={fingerprint:value,token:randomUUID()};
    return this.scope.token;
  }
  getConnection(rawProvider?: unknown): ImageGenerationConnection {
    this.ensureOpen(); const activeProvider = this.vault.activeProvider(), provider = rawProvider === undefined ? activeProvider : imageProvider(rawProvider);
    const read = this.readConnection(provider), config = read.state === 'ready' ? read.config : null, defaults = imageDefaults(provider);
    const check = config && this.checked?.fingerprint === fingerprint(config) ? this.checked : null;
    return { provider, activeProvider, model: config?.model ?? defaults.model, size: config?.size ?? defaults.size, quality: config?.quality ?? defaults.quality, configured: !!config, enabled: config?.enabled ?? false,
      credentialState: read.state, accessCheck: check?.result ?? 'not-checked', checkedAt: check?.at ?? null };
  }
  capability(): AiCapabilityInfo {
    const connection = this.getConnection();
    return { capability: 'image-generation', providerId: 'openrouter-images', available: connection.configured && connection.enabled,
      reason: !connection.configured ? '尚未保存 OpenRouter API Key' : !connection.enabled ? '生图接口尚未启用' : '已启用，实际生图待测试' };
  }
  saveConnection(raw: unknown): ImageGenerationConnection {
    this.ensureOpen(); const o = keys(raw, ['model', 'enabled'], ['apiKey', 'provider', 'size', 'quality']);
    const provider = o.provider === undefined ? this.vault.activeProvider() : imageProvider(o.provider), model = imageModel(o.model, provider);
    if (typeof o.enabled !== 'boolean' || (o.apiKey !== undefined && typeof o.apiKey !== 'string')) throw new AiError('INVALID_CONFIG');
    const previous = this.readConnection(provider), defaults = imageDefaults(provider);
    const sameModel = previous.state === 'ready' && previous.config.model === model;
    const size = o.size ?? (sameModel ? previous.config.size : defaults.size), quality = imageQuality(o.quality ?? (sameModel ? previous.config.quality : defaults.quality));
    if(!['auto','low','medium','high'].includes(quality))throw new AiError('INVALID_CONFIG');
    if (!validImageSize(size, provider, model)) throw new AiError('INVALID_CONFIG');
    const apiKey = typeof o.apiKey === 'string' && o.apiKey.trim() ? imageApiKey(o.apiKey) : previous.state === 'ready' ? previous.config.apiKey : null;
    if (!apiKey) throw new AiError('NOT_CONFIGURED');
    if(this.sharedConnection&&o.apiKey)this.sharedConnection.save(apiKey);
    this.vault.save({ provider, model, enabled: o.enabled, apiKey:this.sharedConnection?'':apiKey, size, quality,...(this.sharedConnection?{credentialRef:'openrouter' as const}:{}) }); this.checked = undefined; this.cancel(new AiError('CONFIG_CHANGED'));
    return this.getConnection();
  }
  disconnect(rawProvider?: unknown): ImageGenerationConnection {
    this.ensureOpen(); const provider = rawProvider === undefined ? this.vault.activeProvider() : imageProvider(rawProvider);
    this.sharedConnection?.disconnect();this.vault.remove(provider); this.checked = undefined; this.cancel(new AiError('CONFIG_CHANGED')); return this.getConnection(provider);
  }
  private config(requireEnabled: boolean, provider = this.vault.activeProvider()): ImageGenerationConfig {
    const value = this.readConnection(provider); if (value.state !== 'ready') throw new AiError('NOT_CONFIGURED');
    if (requireEnabled && !value.config.enabled) throw new AiError('DISABLED'); return value.config;
  }
  private assertConfig(config: ImageGenerationConfig): void {
    const value = this.readConnection(); if (value.state !== 'ready' || fingerprint(value.config) !== fingerprint(config)) throw new AiError('CONFIG_CHANGED');
  }
  private controlled<T>(task: (signal: AbortSignal, deadlineAt: number) => Promise<T>, callerSignal?: AbortSignal, beforeMap?:(error:unknown)=>void): Promise<T> {
    this.ensureOpen();
    if(this.queued.length>=16)return Promise.reject(imageRequestNotSent(new AiError('BUSY')));
    const controller=new AbortController();
    const cancel=()=>controller.abort(abortError(callerSignal?.reason));
    if(callerSignal?.aborted)cancel();else callerSignal?.addEventListener('abort',cancel,{once:true});
    let start!:()=>void;
    const admitted=new Promise<void>((resolve,reject)=>{start=resolve;const queued={controller,start:resolve,reject};this.queued.push(queued);});
    const abortQueued=()=>{const index=this.queued.findIndex(entry=>entry.controller===controller);if(index>=0){this.queued.splice(index,1)[0].reject(abortError(controller.signal.reason));}};
    controller.signal.addEventListener('abort',abortQueued,{once:true});
    const state={controller,promise:undefined as unknown as Promise<T>};
    // Queue admission owns no send intent or money hold. The existing
    // beforeSend transaction binds both to the original durable request ID.
    state.promise=admitted.then(async()=>{
      const timer=setTimeout(()=>controller.abort(Object.assign(new AiError('TIMEOUT'),{abortSource:'TOTAL_TIMEOUT' as const})),this.timeoutMs);
      try{throwIfAborted(controller.signal);return await task(controller.signal,Date.now()+this.timeoutMs);}
      finally{clearTimeout(timer);}
    }).catch(error=>{try{beforeMap?.(error);}catch{}throw error instanceof AiError?error:new AiError('PROVIDER_ERROR');})
      .finally(()=>{callerSignal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',abortQueued);this.running.delete(state);this.pumpQueue();});
    // The entry stores the actual work promise, including late receipt capture.
    const entry=this.queued.find(value=>value.controller===controller)!;
    entry.start=()=>{this.running.add(state);start();};
    if(controller.signal.aborted)abortQueued();this.pumpQueue();
    return abortable(state.promise,controller.signal);
  }
  private pumpQueue():void{while(!this.closed&&this.running.size<2&&this.queued.length){const next=this.queued.shift()!;if(next.controller.signal.aborted)next.reject(abortError(next.controller.signal.reason));else next.start();}}
  async checkConnection(rawProvider?: unknown): Promise<ImageGenerationConnection> {
    this.ensureOpen(); const provider = rawProvider === undefined ? this.vault.activeProvider() : imageProvider(rawProvider), config = this.config(false, provider);
    return this.controlled(async signal => {
      try { await this.adapter.checkModel(config.apiKey, config.model, signal); throwIfAborted(signal);
        const current = this.readConnection(provider); if (current.state !== 'ready' || fingerprint(current.config) !== fingerprint(config)) throw new AiError('CONFIG_CHANGED'); }
      catch (error) {
        if (!signal.aborted && this.readConnection().state === 'ready') { this.checked = { fingerprint: fingerprint(config), result: 'failed', at: new Date().toISOString() }; }
        throw error;
      }
      this.checked = { fingerprint: fingerprint(config), result: 'accessible', at: new Date().toISOString() }; return this.getConnection(provider);
    });
  }
  private assertProduct(input: GenerateImageCandidateInput, assets: StoredAsset[] = []): void {
    try {
      this.store.assertRevision({ productId: input.productId, revision: input.productRevision });
      for (const asset of assets) { const current = this.store.getAssetRecord(asset.id); if (!current || !sameAsset(asset, current)) throw new Error(); }
    } catch { throw new AiError('SOURCE_CHANGED'); }
  }
  async generate(raw: unknown, callerSignal?: AbortSignal, assertWorkflowFresh?: () => void | Promise<void>): Promise<GeneratedImageCandidate> {
    return this.generateInternal(raw,callerSignal,assertWorkflowFresh);
  }
  /** Internal workflow identity is persisted before sending. Renderer inputs cannot select candidates or paths. */
  async generateForWorkflow(raw:unknown,attempt:{requestId:string;editCandidateId?:string;owner?:ImageGenerationOwner},callerSignal?:AbortSignal,assertWorkflowFresh?:()=>void|Promise<void>):Promise<GeneratedImageCandidate>{
    this.ensureOpen();if(callerSignal)throwIfAborted(callerSignal);const id=uuid(attempt.requestId),identity=listingFingerprint({raw,attempt});
    const existing=this.workflowRequests.get(id);
    if(existing){if(existing.identity!==identity)return Promise.reject(imageRequestNotSent(new AiError('SOURCE_CHANGED')));return callerSignal?abortable(existing.promise,callerSignal):existing.promise;}
    if(this.workflowRequests.size>=18)return Promise.reject(imageRequestNotSent(new AiError('BUSY')));
    const promise=Promise.resolve().then(()=>this.generateWorkflowRequest(raw,attempt,callerSignal,assertWorkflowFresh)).finally(()=>this.workflowRequests.delete(id));
    this.workflowRequests.set(id,{identity,promise});return promise;
  }
  private async generateWorkflowRequest(raw:unknown,attempt:{requestId:string;editCandidateId?:string;owner?:ImageGenerationOwner},callerSignal?:AbortSignal,assertWorkflowFresh?:()=>void|Promise<void>):Promise<GeneratedImageCandidate>{
    let requestId:string,editCandidateId:string|undefined;
    try{requestId=uuid(attempt.requestId);editCandidateId=attempt.editCandidateId?uuid(attempt.editCandidateId):undefined;
      this.ensureOpen();if(callerSignal)throwIfAborted(callerSignal);
      const intent=readImageRequestIntent(this.db,requestId);
      if(intent){const input=parseInput(raw,'openrouter',intent.model);this.assertProduct(input);this.assertRequiredImageOwner(intent.version===2?intent.requestScope:{version:1,operation:'image-generation',productId:intent.productId},intent);this.assertImageRecoveryIdentity(input,this.generationScope(input,attempt.owner),intent,editCandidateId);const outcome=this.imageOutcome(intent);if(outcome.kind==='candidate')return outcome.candidate!;if(outcome.kind==='raw'){const known=await this.reconcileWorkflowGeneration(requestId);if(callerSignal)throwIfAborted(callerSignal);if(known)return known;}throw this.imageBlocked(intent);}
      if(existsSync(join(this.directory,'image-generation','candidates',requestId)))throw Object.assign(new AiError('SOURCE_CHANGED'),{requestId,message:'历史候选缺少原请求输入与业务身份；保留原图，请核对原请求，未重发'});
    }catch(error){throw imageRequestNotSent(error);}
    return this.generateInternal(raw,callerSignal,assertWorkflowFresh,{requestId,editCandidateId,...(attempt.owner?{owner:attempt.owner}:{})});
  }
  async reconcileWorkflowGeneration(rawId:string):Promise<GeneratedImageCandidate|null>{
    this.ensureOpen();const id=uuid(rawId);
    if(this.requiredSpendScopeId!==undefined){const original=readImageRequestIntent(this.db,id);if(!original)this.controlledImageBlocked();this.assertRequiredImageOwner(original.version===2?original.requestScope:{version:1,operation:'image-generation',productId:original.productId},original);}
    if(!existsSync(join(this.directory,'image-generation','candidates',id))){
      const intent=readImageRequestIntent(this.db,id);if(!intent)return null;
      const receipt=await readProviderReceipt(this.db,this.directory,id) as any;if(!receipt)return null;
      if(this.spend.list().some(r=>r.id===id)){const saved=readImageReceiptSync(this.db,this.directory,intent);if(saved){
        // A verified durable pointer can survive the receipt-index INSERT. Rebuild
        // only this original receipt through its owner, never a generation POST.
        if(!this.db.prepare('SELECT 1 FROM ai_provider_receipts WHERE id=?').get(saved.record.id)){const indexed=await saveProviderReceipt(this.db,this.directory,id,saved.capture,undefined);if(indexed.id!==saved.record.id||indexed.sha256!==saved.record.sha256)throw new SpendBudgetError('SPEND_IDENTITY_CONFLICT');}
        const proof=prepareImageSpendReceiptProof(saved.record,saved.capture),settled=transaction(this.db,()=>this.spend.settleReceiptInTransaction(this.db,id,saved.record.id,proof));if(settled.state==='COST_ANOMALY')throw Object.assign(new SpendBudgetError('SPEND_COST_ANOMALY'),{requestId:id,certainty:proof.certainty});}}
      const failure=openRouterFailure(receipt.status,receipt.body);if(failure)throw failure;
      const state=openRouterReceiptState(receipt.status,receipt.body);if(state==='unknown'||state==='invalid')throw Object.assign(new AiError('OUTPUT_INVALID'),{certainty:state==='unknown'?'SENT_UNKNOWN' as const:'RECEIVED_INVALID' as const,diagnosticReason:receipt.body?.encoding==='raw-utf8-invalid/v1'?'RESPONSE_UTF8_INVALID':receipt.body==='[omitted: credential echo]'?'RESPONSE_SECRET_ECHO':'RESPONSE_BODY_EMPTY'});
      let result:ReturnType<typeof decodeOpenRouterImage>;try{result=decodeOpenRouterImage(receipt.body);}catch(error){const verified=readImageReceiptSync(this.db,this.directory,intent);if(error instanceof AiError&&error.code==='OUTPUT_INVALID'&&verified&&listingFingerprint(verified.capture)===listingFingerprint(receipt))error.certainty??='RECEIVED_INVALID';throw error;}const preview=await this.processPreview(result.bytes);this.ensureOpen();
      const candidate:GeneratedImageCandidate={id:intent.id,provider:intent.provider,model:intent.model,productId:intent.productId,productRevision:intent.productRevision,createdAt:intent.createdAt,mode:intent.mode,sourceAssets:intent.sourceAssets,...(intent.editSource?{editSource:intent.editSource}:{}),requestId:result.requestId,reviewState:'unreviewed',mimeType:'image/png',width:result.width,height:result.height,byteSize:result.bytes.length,sha256:digest(result.bytes),previewUrl:'data:image/png;base64,'+preview.toString('base64')};
      delete (candidate as any).version;this.saveCandidate(candidate,result.bytes,preview,()=>{});
    }
    return (await this.readCandidate(id)).candidate;
  }
  private generationScope(input:GenerateImageCandidateInput,rawOwner?:ImageGenerationOwner):AiRequestScope {
    if(!rawOwner)return validateRequestScope({version:1,operation:'image-generation',productId:input.productId});
    const owner=keys(rawOwner,['draftId','sku','targetId','marketplaceId','variantIds','slot']);
    const scope=validateRequestScope({version:1,operation:'image-generation',productId:input.productId,...owner});
    const row=this.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(scope.draftId!),draft=row?JSON.parse(String(row.record_json)).draft:null;
    const variants=draft?.salesPlan?.recipe?.components?.map((c:{variantId:string})=>c.variantId)??(draft?.variantId?[draft.variantId]:[]);
    if(!draft||draft.id!==scope.draftId||draft.productId!==input.productId||draft.productRevision!==input.productRevision||draft.sku!==scope.sku||draft.targetId!==scope.targetId||draft.marketplaceId!==scope.marketplaceId||JSON.stringify([...new Set(variants)].sort())!==JSON.stringify(scope.variantIds))throw new AiError('SOURCE_CHANGED');
    return scope;
  }
  private imageIntents(scope:AiRequestScope):ImageRequestIntent[] {
    return this.db.prepare("SELECT id FROM ai_image_requests WHERE json_extract(record_json,'$.productId')=? ORDER BY rowid").all(scope.productId).map(row=>readImageRequestIntent(this.db,String(row.id))!).filter(intent=>sameRequestBusiness(scope,intent.version===2?intent.requestScope:{version:1,operation:'image-generation',productId:intent.productId}));
  }
  private imageOutcome(intent:ImageRequestIntent):{kind:'unknown'|'invalid'|'raw'|'candidate';candidate?:GeneratedImageCandidate} {
    if(existsSync(join(this.directory,'image-generation','candidates',intent.id))){const candidate=readCandidateFilesSync(this.directory,intent.id,this.decodePreview).candidate;if(candidate.productId!==intent.productId||candidate.productRevision!==intent.productRevision||candidate.model!==intent.model||listingFingerprint(candidate.sourceAssets)!==listingFingerprint(intent.sourceAssets)||listingFingerprint(candidate.editSource??null)!==listingFingerprint(intent.editSource??null))throw new AiError('SOURCE_CHANGED');return {kind:'candidate',candidate};}
    const saved=readImageReceiptSync(this.db,this.directory,intent);if(!saved)return {kind:'unknown'};
    const state=openRouterReceiptState(saved.record.status,saved.capture.body);if(state==='unknown'||state==='invalid')return {kind:state};
    const failure=openRouterFailure(saved.record.status,saved.capture.body);if(failure)return {kind:failure.definitive?'invalid':'unknown'};
    if(saved.capture.body==null)return {kind:'invalid'};
    if(saved.capture.body==='[omitted: credential echo]')return {kind:'unknown'};
    // A returned URL or valid pixels need original materialization, not another painting.
    if(typeof (saved.capture.body as any)?.data?.[0]?.url==='string')return {kind:'raw'};
    try{decodeOpenRouterImage(saved.capture.body);return {kind:'raw'};}catch{return {kind:'invalid'};}
  }
  private imageBlocked(intent:ImageRequestIntent):AiError {
    const error=new AiError('INTERRUPTED');error.requestId=intent.id;error.certainty='SENT_UNKNOWN';error.message=intent.version===1?'旧生图请求缺少完整业务身份；请按原请求核对，未新建生图请求':'原生图请求尚未解决；请按原请求恢复，未因提示词、Key、模型或新工作流再发送';return Object.assign(error,{notSent:true as const});
  }
  private imageInputSnapshot(input:GenerateImageCandidateInput){return {version:1 as const,promptSha256:digest(input.prompt),size:input.size,quality:input.quality,background:input.background};}
  private imageFingerprint(input:GenerateImageCandidateInput,intent:ImageRequestIntent,editCandidateId?:string):string {
    const assets=input.referenceAssetIds.map(id=>{const asset=this.store.getAssetRecord(id);if(!asset||asset.productId!==input.productId)throw new AiError('SOURCE_CHANGED');return {id:asset.id,sha256:asset.sha256};});
    return imageRequestFingerprint({...intent,productId:input.productId,productRevision:input.productRevision,mode:assets.length||editCandidateId?'edit':'generate',sourceAssets:assets,...(editCandidateId&&intent.editSource?.id===editCandidateId?{editSource:intent.editSource}:{editSource:undefined})},this.imageInputSnapshot(input));
  }
  private assertImageRecoveryIdentity(input:GenerateImageCandidateInput,scope:AiRequestScope,intent:ImageRequestIntent,editCandidateId?:string):void {
    if(intent.version!==2||listingFingerprint(scope)!==listingFingerprint(intent.requestScope)||(intent.editSource?.id??null)!==(editCandidateId??null)||this.imageFingerprint(input,intent,editCandidateId)!==intent.requestFingerprint){const error=new AiError('SOURCE_CHANGED');error.requestId=intent.id;error.message=intent.version===1?'历史生图请求缺少完整输入与业务身份；保留原图，请核对原请求，未重发':'当前输入、SKU或图片槽与原生图请求不一致；保留原回执与候选，未重发';throw error;}
  }
  private async recoverBeforeImageSend(input:GenerateImageCandidateInput,scope:AiRequestScope,requestId?:string,editCandidateId?:string):Promise<GeneratedImageCandidate|undefined> {
    const intents=this.imageIntents(scope),outcomes=intents.map(intent=>{this.assertRequiredImageOwner(scope,intent);return{intent,outcome:this.imageOutcome(intent)};}),pending=outcomes.filter(value=>['unknown','raw'].includes(value.outcome.kind));
    const connection=this.getConnection();
    if(pending.length){const item=pending[0];if(pending.length>1||item.outcome.kind==='unknown'||requestId&&requestId!==item.intent.id)throw this.imageBlocked(item.intent);this.assertImageRecoveryIdentity(input,scope,item.intent,editCandidateId);if(!requestId&&connection.configured&&connection.model!==item.intent.model)throw Object.assign(new AiError('SOURCE_CHANGED'),{requestId:item.intent.id,message:'当前选用模型与原生图请求不一致；请按原请求身份恢复，未重发'});const restored=await this.reconcileWorkflowGeneration(item.intent.id);if(!restored)throw this.imageBlocked(item.intent);return restored;}
    for(const item of outcomes)if(item.outcome.kind==='candidate'&&item.intent.version===2){if(listingFingerprint(scope)!==listingFingerprint(item.intent.requestScope)||(item.intent.editSource?.id??null)!==(editCandidateId??null))continue;const frozen={...item.intent,model:connection.configured?String(connection.model):item.intent.model};if(this.imageFingerprint(input,frozen,editCandidateId)===item.intent.requestFingerprint){
      if(requestId&&requestId!==item.intent.id){
        if(!scope.draftId||scope.slot===undefined)throw Object.assign(new AiError('SOURCE_CHANGED'),{requestId:item.intent.id,message:'已有候选结果已知；新生图尝试缺少可验证的原草稿和图位身份，未发送'});
        // A verified workflow's new bounded attempt is distinct from recovering
        // this known candidate. It still passes the existing freshness/budget
        // checks and reserves its own intent; unknown/raw requests above cannot.
        continue;
      }
      return item.outcome.candidate;
    }}
    return undefined;
  }
  private async generateInternal(raw:unknown,callerSignal?:AbortSignal,assertWorkflowFresh?:()=>void|Promise<void>,attempt?:{requestId:string;editCandidateId?:string;owner?:ImageGenerationOwner}):Promise<GeneratedImageCandidate>{
    let enteredAdapter=false,stage='validation',recorded=false,requiredEntryApproved=this.requiredSpendScopeId===undefined;let productId:string|undefined,activeRequestId:string|undefined;
    const record=(error:unknown)=>{recorded=true;try{recordErrorEvidence(detail=>this.store.recordWorkspaceEvent('operation.failed','生图步骤失败（脱敏诊断）',detail),error,{stage:`image-generation.${stage}`,productId,requestId:attempt?.requestId??(error instanceof AiError?error.requestId:undefined),requestOutcome:error instanceof AiError&&error.certainty==='SENT_UNKNOWN'?'RESULT_UNKNOWN':!enteredAdapter||error instanceof AiError&&'notSent' in error&&error.notSent===true?'NOT_SENT':error instanceof AiError&&['RECEIVED_VALID','RECEIVED_INVALID'].includes(error.certainty??'')?undefined:error instanceof AiError&&'definitive' in error&&error.definitive===true?'DEFINITIVE_FAILURE':'RESULT_UNKNOWN'});}catch{/* Diagnostic access must not replace the original failure. */}};
    try{
    this.ensureOpen(); if (callerSignal) throwIfAborted(callerSignal);
    const input=parseInput(raw,'openrouter',String(this.getConnection().model));productId=input.productId;this.assertProduct(input);const ownerScope=this.generationScope(input,attempt?.owner);
    this.assertRequiredImageOwner(ownerScope);requiredEntryApproved=true;
    stage='recovery';const reused=await this.recoverBeforeImageSend(input,ownerScope,attempt?.requestId,attempt?.editCandidateId);if(callerSignal)throwIfAborted(callerSignal);if(reused)return reused;
    if(this.requiredSpendScopeId!==undefined)this.authorizeImageScope(ownerScope);
    const config=this.config(true);this.assertProduct(input);
    stage='controlled-scope';const controlledScopeId=this.authorizeImageScope(ownerScope);
    return await this.controlled(async (signal,responseDeadlineAt) => {
      let evidence:ImagePriceEvidence|undefined;
      if(this.spend.needsBound(controlledScopeId)){
        stage='budget';
        try{const response=await this.fetcher(`https://openrouter.ai/api/v1/images/models/${config.model}/endpoints`,{method:'GET',redirect:'error',signal});if(!response.ok)throw new SpendBudgetError('SPEND_BOUND_UNAVAILABLE');evidence=priceEvidence(config.model,await readBounded(response,1024*1024,signal),new Date());}
        catch(error){throwIfAborted(signal);throw error instanceof SpendBudgetError?error:new SpendBudgetError('SPEND_BOUND_UNAVAILABLE');}
      }
      stage='references';
      const assets = input.referenceAssetIds.map(id => {
        const asset = this.store.getAssetRecord(id); if (!asset || asset.productId !== input.productId) throw new AiError('SOURCE_CHANGED');
        validateImage(asset, false); return asset;
      });
      if (assets.reduce((total, asset) => total + asset.byteSize, 0) > 23 * 1024 * 1024) throw new AiError('IMAGE_INVALID');
      const references: { mimeType: 'image/png' | 'image/jpeg'; bytes: Buffer }[] = [];
      for (const asset of assets) references.push({ mimeType: asset.mimeType as 'image/png' | 'image/jpeg', bytes: await readManagedImage(this.directory, asset, signal) });
      let editSource:GeneratedImageCandidate['editSource'];
      if(attempt?.editCandidateId){
        const previous=await this.readCandidate(attempt.editCandidateId),candidate=previous.candidate;
        if(candidate.productId!==input.productId||candidate.productRevision!==input.productRevision||JSON.stringify(candidate.sourceAssets)!==JSON.stringify(assets.map(asset=>({id:asset.id,sha256:asset.sha256}))))throw new AiError('SOURCE_CHANGED');
        if(previous.bytes.length>10*1024*1024||references.reduce((n,ref)=>n+ref.bytes.length,previous.bytes.length)>20*1024*1024||references.length>=14){
          const error=new AiError('IMAGE_INVALID');error.message='失败候选与原始参考图超出生图修复预算：合计最多 20 MiB、单张最多 10 MiB、合计最多 14 张；请求尚未发送';throw error;
        }
        // First image is the failed output to edit. Remaining images keep the original source evidence.
        references.unshift({mimeType:'image/png',bytes:previous.bytes});editSource={id:candidate.id,sha256:candidate.sha256};
      }
      if (assertWorkflowFresh) await abortable(Promise.resolve().then(assertWorkflowFresh), signal);
      throwIfAborted(signal); this.assertProduct(input, assets); this.assertConfig(config);
      const request = { apiKey: config.apiKey, prompt: input.prompt, size: input.size, quality: input.quality, background: input.background, references };
      if(this.requiredSpendScopeId!==undefined)this.authorizeImageScope(ownerScope);
      this.store.freezeSourceVersion(input.productId,input.productRevision);
      stage='request';enteredAdapter=true;
      const requestId=attempt?.requestId??randomUUID();
      activeRequestId=requestId;
      if(readImageRequestIntent(this.db,requestId)){const error=new AiError('INTERRUPTED');error.message='原生图请求已有发送意图；请回收原响应，未重发';throw error;}
      const intentBase={id:requestId,provider:'openrouter' as const,model:config.model,productId:input.productId,productRevision:input.productRevision,createdAt:new Date().toISOString(),mode:references.length?'edit' as const:'generate' as const,sourceAssets:assets.map(asset=>({id:asset.id,sha256:asset.sha256})),...(editSource?{editSource}:{})},requestInput=this.imageInputSnapshot(input);
      const intent:ImageRequestIntent={...intentBase,version:2,requestScope:ownerScope,requestInput,requestFingerprint:imageRequestFingerprint(intentBase,requestInput)};
      const result=await this.adapter.generate({...request,model:config.model},signal,{responseDeadlineAt,beforeSend:body=>{
        try{return transaction(this.db,()=>{throwIfAborted(signal);this.assertProduct(input,assets);this.generationScope(input,attempt?.owner);if(this.authorizeImageScope(ownerScope)!==controlledScopeId)throw new SpendBudgetError('SPEND_IDENTITY_CONFLICT');const pending=this.imageIntents(ownerScope).find(prior=>['unknown','raw'].includes(this.imageOutcome(prior).kind));if(pending)throw this.imageBlocked(pending);if(typeof body!=='string')throw new SpendBudgetError('SPEND_RECORD_INVALID');const bound=evidence?imageSpendBound(body,evidence,new Date().toISOString()):null;this.spend.reserveInTransaction(this.db,{id:requestId,businessKey:listingFingerprint(ownerScope),requestSha256:digest(body),model:config.model,purpose:'image_generation',scopeId:controlledScopeId},body,bound);saveImageRequestIntent(this.db,intent);});}
        catch(error){
          // This transaction never dispatched. Preserve an older UNKNOWN's
          // identity, but do not turn a rolled-back budget refusal into one.
          if(error instanceof AiError)throw error.certainty==='SENT_UNKNOWN'?error:Object.assign(error,{notSent:true as const,certainty:'NOT_SENT' as const});
          throw Object.assign(imageRequestNotSent(error),{certainty:'NOT_SENT' as const});
        }
      },onProviderReceipt:async receipt=>{
        const pending=saveProviderReceipt(this.db,this.directory,requestId,receipt,undefined);this.pendingReceipts.add(pending);try{const saved=await pending,proof=prepareImageSpendReceiptProof(saved,receipt),settled=transaction(this.db,()=>this.spend.settleReceiptInTransaction(this.db,requestId,saved.id,proof));if(settled.state==='COST_ANOMALY')throw Object.assign(new SpendBudgetError('SPEND_COST_ANOMALY'),{requestId,certainty:proof.certainty});}finally{this.pendingReceipts.delete(pending);}
      }});
      throwIfAborted(signal);
      let preview: Buffer;
      stage='preview';
      try { preview = await this.processPreview(result.bytes); const shape = inspectRaster(preview); if (shape.mimeType !== 'image/png' || preview.length > 4 * 1024 * 1024) throw new Error(); }
      catch(error) { record(error);throw invalidImageOutput('preview'); }
      // The provider and local image process both yield: validate once after both,
      // immediately before committing the candidate with the original scope.
      stage='revalidate';throwIfAborted(signal);this.ensureOpen();
      for(const asset of assets)await readManagedImage(this.directory,asset,signal);
      if(assertWorkflowFresh)await abortable(Promise.resolve().then(assertWorkflowFresh),signal);
      throwIfAborted(signal);this.assertProduct(input,assets);this.assertConfig(config);
      const candidate: GeneratedImageCandidate = { id: requestId, provider: config.provider, model: config.model, mode: assets.length||editSource ? 'edit' : 'generate',
        productId: input.productId, productRevision: input.productRevision, createdAt: new Date().toISOString(), requestId: result.requestId,
        sourceAssets: assets.map(asset => ({ id: asset.id, sha256: asset.sha256 })), reviewState: 'unreviewed', mimeType: 'image/png',
        width: result.width, height: result.height, byteSize: result.bytes.length, sha256: digest(result.bytes), previewUrl: `data:image/png;base64,${preview.toString('base64')}`,...(editSource?{editSource}:{}) };
      // Commit the candidate directory together; no event-loop gap after final freshness checks.
      stage='save';this.saveCandidate(candidate, result.bytes, preview,record);
      return candidate;
    }, callerSignal,error=>{if(!recorded)record(error);});
    }catch(error){if(this.requiredSpendScopeId!==undefined&&(!requiredEntryApproved||!enteredAdapter&&error instanceof ControlledRunError))throw imageRequestNotSent(error);try{if(activeRequestId&&this.spend.list().some(r=>r.id===activeRequestId))transaction(this.db,()=>this.spend.markUnknownInTransaction(this.db,activeRequestId!));}catch{/* Retain the original request failure and conservative committed hold. */}if(!recorded)record(error);throw enteredAdapter?error:error instanceof SpendBudgetError||error instanceof ControlledRunError?Object.assign(error,{notSent:true as const}):imageRequestNotSent(error);}
  }
  /** Main-process workflow entry point; never accepts or returns a caller-selected filesystem path. */
  async readCandidate(id: string): Promise<{ candidate: GeneratedImageCandidate; bytes: Buffer; preview: Buffer }> {
    this.ensureOpen(); return readCandidateFiles(this.directory, id, this.processPreview);
  }
  private saveCandidate(candidate: GeneratedImageCandidate, bytes: Buffer, preview: Buffer, record:(error:unknown)=>void): void {
    let temporary: string | undefined;
    try {
      const root = privateDirectory(this.directory, 'image-generation', true), candidates = privateDirectory(root, 'candidates', true);
      temporary = join(candidates, `.pending-${candidate.id}`); mkdirSync(temporary);
      writeFileSync(join(temporary, 'image.png'), bytes, { flag: 'wx' }); writeFileSync(join(temporary, 'preview.png'), preview, { flag: 'wx' });
      const { previewUrl: _preview, ...metadata } = candidate;
      writeFileSync(join(temporary, 'candidate.json'), JSON.stringify({ ...metadata, previewSha256: digest(preview) }, null, 2) + '\n', { flag: 'wx' });
      renameSync(temporary, join(candidates, candidate.id)); temporary = undefined;
    } catch(error) { record(error);throw invalidImageOutput('save'); }
    finally { if (temporary) { try { rmSync(temporary, { recursive: true, force: true }); } catch { /* Incomplete candidates have a pending name and are never adopted. */ } } }
  }
  cancel(reason:AiError = Object.assign(new AiError('CANCELLED'),{abortSource:'USER' as const})): void { for(const entry of [...this.queued])entry.controller.abort(reason);for(const entry of this.running)entry.controller.abort(reason); }
  async close(): Promise<void> { if(this.closed)return;this.closed = true; const running = [...this.running]; this.cancel(Object.assign(new AiError('SERVICE_CLOSED'), { abortSource: 'SHUTDOWN' as const })); await Promise.allSettled(running.map(entry=>entry.promise));await Promise.allSettled([...this.pendingReceipts]); this.db.close(); }
}
