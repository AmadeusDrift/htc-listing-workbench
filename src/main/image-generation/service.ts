import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiCapabilityInfo } from '../../shared/ai-contracts.ts';
import type { GenerateImageCandidateInput, GeneratedImageCandidate, ImageGenerationConnection, ImageGenerationProvider, OpenAiImageModel, TyaiImageModel } from '../../shared/image-generation-contracts.ts';
import type { WorkspaceStore, StoredAsset } from '../store.ts';
import type { SecretStorage } from '../amazon/vault.ts';
import { AiError, abortable, throwIfAborted } from '../ai/errors.ts';
import { keys, uuid } from '../ai/validation.ts';
import { readManagedImage, sameAsset, validateImage } from '../ai/source.ts';
import { inspectRaster } from '../image-format.ts';
import { OpenAiImageAdapter } from './adapter.ts';
import { TyaiImageAdapter } from './tyai-adapter.ts';
import { ImageGenerationVault, imageApiKey, imageDefaults, imageModel, imageProvider, imageQuality, privateDirectory, validImageSize } from './vault.ts';
import type { ImageGenerationConfig } from './vault.ts';
import { readCandidateFiles } from './candidate.ts';
import type { RelayDownloadDependencies } from './download.ts';
import type { ImageModelCatalog } from '../../shared/image-generation-contracts.ts';
import { isGeminiImageModel, relayDefaultQuality } from '../../shared/image-models.ts';
import { builtInModels, fetchRelayModels } from './catalog.ts';
import { GeminiRelayAdapter } from './gemini-adapter.ts';
import { imageRequestNotSent, invalidImageOutput } from './errors.ts';
import { recordErrorEvidence } from '../error-evidence.ts';

export interface ImageGenerationDependencies { fetch?: typeof fetch; timeoutMs?: number; decodePreview: (bytes: Buffer) => Buffer; normalizeImage?: (bytes: Buffer) => Buffer; downloadDependencies?: RelayDownloadDependencies }
function parseInput(raw: unknown, provider: ImageGenerationProvider, model: string): GenerateImageCandidateInput {
  const o = keys(raw, ['productId', 'productRevision', 'prompt', 'referenceAssetIds', 'size', 'quality', 'background']);
  if (!Number.isSafeInteger(o.productRevision) || Number(o.productRevision) < 1 || typeof o.prompt !== 'string' || !o.prompt.trim() || o.prompt.length > 32000 || o.prompt.includes('\0') ||
      !Array.isArray(o.referenceAssetIds) || o.referenceAssetIds.length > (provider === 'tyai' && isGeminiImageModel(model) ? 14 : 16) || !validImageSize(o.size, provider, model) ||
      typeof o.quality !== 'string' || !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(o.quality) || typeof o.background !== 'string' || !['auto', 'opaque', 'transparent'].includes(o.background)) throw new AiError('INVALID_INPUT');
  const refs = o.referenceAssetIds.map(uuid); if (new Set(refs).size !== refs.length) throw new AiError('INVALID_INPUT');
  return { productId: uuid(o.productId), productRevision: Number(o.productRevision), prompt: o.prompt.trim(), referenceAssetIds: refs,
    size: o.size as GenerateImageCandidateInput['size'], quality: o.quality as GenerateImageCandidateInput['quality'], background: o.background as GenerateImageCandidateInput['background'] };
}
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (config: ImageGenerationConfig) => digest(JSON.stringify(config));

/** Provider credentials and candidate artifacts stay separate from product source images. */
export class ImageGenerationService {
  private directory: string; private store: WorkspaceStore; private vault: ImageGenerationVault; private adapter: OpenAiImageAdapter; private relay: TyaiImageAdapter;
  private decodePreview: (bytes: Buffer) => Buffer; private timeoutMs: number; private closed = false;
  private running?: { controller: AbortController; promise: Promise<unknown> };
  private checked?: { fingerprint: string; result: 'accessible' | 'failed'; at: string };
  private scope?: { fingerprint: string; token: string };
  private fetcher: typeof fetch; private gemini: GeminiRelayAdapter;
  private catalog?: { keyHash: string; value: ImageModelCatalog };
  constructor(directory: string, store: WorkspaceStore, storage: SecretStorage, deps: ImageGenerationDependencies) {
    this.directory = directory; this.store = store; this.vault = new ImageGenerationVault(directory, storage);
    this.fetcher = deps.fetch ?? globalThis.fetch; this.gemini = new GeminiRelayAdapter(deps);
    this.adapter = new OpenAiImageAdapter({ fetch: deps.fetch }); this.relay = new TyaiImageAdapter({ fetch: deps.fetch, downloadDependencies: deps.downloadDependencies }); this.decodePreview = deps.decodePreview;
    this.timeoutMs = deps.timeoutMs ?? 660000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 1800000) throw new AiError('INVALID_CONFIG');
  }
  private ensureOpen(): void { if (this.closed) throw new AiError('SERVICE_CLOSED'); }
  get busy(): boolean { return !!this.running; }
  getModels(): ImageModelCatalog {
    this.ensureOpen(); const current = this.vault.inspect('tyai');
    return structuredClone(current.state === 'ready' && this.catalog?.keyHash === digest(current.config.apiKey) ? this.catalog.value : builtInModels());
  }
  async refreshModels(): Promise<ImageModelCatalog> {
    this.ensureOpen(); const config = this.config(false, 'tyai');
    return this.controlled(async signal => {
      const timeout = setTimeout(() => this.cancel(new AiError('TIMEOUT')), 20000);
      try {
        const value = await fetchRelayModels(this.fetcher, config.apiKey, signal); throwIfAborted(signal);
        const current = this.vault.inspect('tyai');
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
    const read = this.vault.inspect(provider), config = read.state === 'ready' ? read.config : null, defaults = imageDefaults(provider);
    const check = config && this.checked?.fingerprint === fingerprint(config) ? this.checked : null;
    return { provider, activeProvider, model: config?.model ?? defaults.model, size: config?.size ?? defaults.size, quality: config?.quality ?? defaults.quality, configured: !!config, enabled: config?.enabled ?? false,
      credentialState: read.state, accessCheck: check?.result ?? 'not-checked', checkedAt: check?.at ?? null };
  }
  capability(): AiCapabilityInfo {
    const connection = this.getConnection();
    return { capability: 'image-generation', providerId: connection.provider === 'openai' ? 'openai-images' : 'tyai-images', available: connection.configured && connection.enabled,
      reason: !connection.configured ? `尚未保存 ${connection.provider === 'openai' ? 'OpenAI' : 'Tyai'} API Key` : !connection.enabled ? '生图接口尚未启用' : '已启用，实际生图待测试' };
  }
  saveConnection(raw: unknown): ImageGenerationConnection {
    this.ensureOpen(); const o = keys(raw, ['model', 'enabled'], ['apiKey', 'provider', 'size', 'quality']);
    const provider = o.provider === undefined ? this.vault.activeProvider() : imageProvider(o.provider), model = imageModel(o.model, provider);
    if (typeof o.enabled !== 'boolean' || (o.apiKey !== undefined && typeof o.apiKey !== 'string')) throw new AiError('INVALID_CONFIG');
    const previous = this.vault.inspect(provider), defaults = imageDefaults(provider);
    const sameModel = previous.state === 'ready' && previous.config.model === model;
    const size = o.size ?? (sameModel ? previous.config.size : defaults.size), quality = imageQuality(o.quality ?? (sameModel ? previous.config.quality : provider === 'tyai' ? relayDefaultQuality(model) : defaults.quality));
    if (!validImageSize(size, provider, model)) throw new AiError('INVALID_CONFIG');
    const apiKey = typeof o.apiKey === 'string' && o.apiKey.trim() ? imageApiKey(o.apiKey) : previous.state === 'ready' ? previous.config.apiKey : null;
    if (!apiKey) throw new AiError('NOT_CONFIGURED');
    this.vault.save({ provider, model, enabled: o.enabled, apiKey, size, quality }); this.checked = undefined; this.cancel(new AiError('CONFIG_CHANGED'));
    return this.getConnection();
  }
  disconnect(rawProvider?: unknown): ImageGenerationConnection {
    this.ensureOpen(); const provider = rawProvider === undefined ? this.vault.activeProvider() : imageProvider(rawProvider);
    this.vault.remove(provider); this.checked = undefined; this.cancel(new AiError('CONFIG_CHANGED')); return this.getConnection(provider);
  }
  private config(requireEnabled: boolean, provider = this.vault.activeProvider()): ImageGenerationConfig {
    const value = this.vault.inspect(provider); if (value.state !== 'ready') throw new AiError('NOT_CONFIGURED');
    if (requireEnabled && !value.config.enabled) throw new AiError('DISABLED'); return value.config;
  }
  private assertConfig(config: ImageGenerationConfig): void {
    const value = this.vault.inspect(); if (value.state !== 'ready' || fingerprint(value.config) !== fingerprint(config)) throw new AiError('CONFIG_CHANGED');
  }
  private controlled<T>(task: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal, beforeMap?:(error:unknown)=>void): Promise<T> {
    this.ensureOpen(); if (this.running) return Promise.reject(new AiError('BUSY'));
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new AiError('TIMEOUT')), this.timeoutMs);
    const cancel = () => controller.abort(callerSignal?.reason instanceof AiError ? callerSignal.reason : new AiError('CANCELLED'));
    if (callerSignal?.aborted) cancel(); else callerSignal?.addEventListener('abort', cancel, { once: true });
    const state = { controller, promise: undefined as unknown as Promise<T> }; this.running = state;
    state.promise = abortable(Promise.resolve().then(() => { throwIfAborted(controller.signal); return task(controller.signal); }), controller.signal)
      .catch(error => { try{beforeMap?.(error);}catch{/* Keep original failure mapping. */} throw error instanceof AiError ? error : new AiError('PROVIDER_ERROR'); })
      .finally(() => { clearTimeout(timer); callerSignal?.removeEventListener('abort', cancel); if (this.running === state) this.running = undefined; });
    return state.promise;
  }
  async checkConnection(rawProvider?: unknown): Promise<ImageGenerationConnection> {
    this.ensureOpen(); const provider = rawProvider === undefined ? this.vault.activeProvider() : imageProvider(rawProvider), config = this.config(false, provider);
    if (provider === 'tyai') return this.getConnection(provider);
    return this.controlled(async signal => {
      try { await this.adapter.checkModel(config.apiKey, config.model as OpenAiImageModel, signal); throwIfAborted(signal);
        const current = this.vault.inspect(provider); if (current.state !== 'ready' || fingerprint(current.config) !== fingerprint(config)) throw new AiError('CONFIG_CHANGED'); }
      catch (error) {
        if (!signal.aborted && this.vault.inspect().state === 'ready') { this.checked = { fingerprint: fingerprint(config), result: 'failed', at: new Date().toISOString() }; }
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
  async generateForWorkflow(raw:unknown,attempt:{requestId:string;editCandidateId?:string},callerSignal?:AbortSignal,assertWorkflowFresh?:()=>void|Promise<void>):Promise<GeneratedImageCandidate>{
    let requestId:string,editCandidateId:string|undefined;
    try{requestId=uuid(attempt.requestId);editCandidateId=attempt.editCandidateId?uuid(attempt.editCandidateId):undefined;
      if(await this.reconcileWorkflowGeneration(requestId))throw new AiError('INVALID_INPUT');
    }catch(error){throw imageRequestNotSent(error);}
    return this.generateInternal(raw,callerSignal,assertWorkflowFresh,{requestId,editCandidateId});
  }
  async reconcileWorkflowGeneration(rawId:string):Promise<GeneratedImageCandidate|null>{
    this.ensureOpen();const id=uuid(rawId);
    if(!existsSync(join(this.directory,'image-generation','candidates',id)))return null;
    return (await this.readCandidate(id)).candidate;
  }
  private async generateInternal(raw:unknown,callerSignal?:AbortSignal,assertWorkflowFresh?:()=>void|Promise<void>,attempt?:{requestId:string;editCandidateId?:string}):Promise<GeneratedImageCandidate>{
    let enteredAdapter=false,stage='validation',recorded=false;let productId:string|undefined;
    const record=(error:unknown)=>{recorded=true;try{recordErrorEvidence(detail=>this.store.recordWorkspaceEvent('operation.failed','生图步骤失败（脱敏诊断）',detail),error,{stage:`image-generation.${stage}`,productId,requestId:attempt?.requestId,requestOutcome:!enteredAdapter||error instanceof AiError&&'notSent' in error&&error.notSent===true?'NOT_SENT':error instanceof AiError&&'definitive' in error&&error.definitive===true?'DEFINITIVE_FAILURE':'RESULT_UNKNOWN'});}catch{/* Diagnostic access must not replace the original failure. */}};
    try{
    this.ensureOpen(); if (callerSignal) throwIfAborted(callerSignal);
    const config = this.config(true), input = parseInput(raw, config.provider, config.model);productId=input.productId; this.assertProduct(input);
    return await this.controlled(async signal => {
      stage='references';
      const assets = input.referenceAssetIds.map(id => {
        const asset = this.store.getAssetRecord(id); if (!asset || asset.productId !== input.productId) throw new AiError('SOURCE_CHANGED');
        validateImage(asset, false); return asset;
      });
      if (assets.reduce((total, asset) => total + asset.byteSize, 0) > (config.provider === 'tyai' ? 20 : 23) * 1024 * 1024) throw new AiError('IMAGE_INVALID');
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
      stage='request';enteredAdapter=true;
      const result = config.provider === 'tyai' ? await (isGeminiImageModel(config.model) ? this.gemini : this.relay).generate({ ...request, model: config.model as TyaiImageModel }, signal)
        : await this.adapter.generate({ ...request, model: config.model as OpenAiImageModel }, signal);
      throwIfAborted(signal);
      // The provider may have been processing while local files changed.
      stage='revalidate';
      for (const asset of assets) await readManagedImage(this.directory, asset, signal);
      throwIfAborted(signal); this.assertProduct(input, assets); this.assertConfig(config);
      let preview: Buffer;
      stage='preview';
      try { preview = this.decodePreview(result.bytes); const shape = inspectRaster(preview); if (shape.mimeType !== 'image/png' || preview.length > 4 * 1024 * 1024) throw new Error(); }
      catch(error) { record(error);throw invalidImageOutput('preview'); }
      const candidate: GeneratedImageCandidate = { id: attempt?.requestId??randomUUID(), provider: config.provider, model: config.model, mode: assets.length ? 'edit' : 'generate',
        productId: input.productId, productRevision: input.productRevision, createdAt: new Date().toISOString(), requestId: result.requestId,
        sourceAssets: assets.map(asset => ({ id: asset.id, sha256: asset.sha256 })), reviewState: 'unreviewed', mimeType: 'image/png',
        width: result.width, height: result.height, byteSize: result.bytes.length, sha256: digest(result.bytes), previewUrl: `data:image/png;base64,${preview.toString('base64')}`,...(editSource?{editSource}:{}) };
      // Commit the candidate directory together; no event-loop gap after final freshness checks.
      stage='save';this.saveCandidate(candidate, result.bytes, preview,record);
      return candidate;
    }, callerSignal,error=>{if(!recorded)record(error);});
    }catch(error){if(!recorded)record(error);throw enteredAdapter?error:imageRequestNotSent(error);}
  }
  /** Main-process workflow entry point; never accepts or returns a caller-selected filesystem path. */
  async readCandidate(id: string): Promise<{ candidate: GeneratedImageCandidate; bytes: Buffer; preview: Buffer }> {
    this.ensureOpen(); return readCandidateFiles(this.directory, id, this.decodePreview);
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
  cancel(reason = new AiError('CANCELLED')): void { this.running?.controller.abort(reason); }
  async close(): Promise<void> { this.closed = true; const running = this.running; this.cancel(new AiError('SERVICE_CLOSED')); if (running) await running.promise.catch(() => {}); }
}
