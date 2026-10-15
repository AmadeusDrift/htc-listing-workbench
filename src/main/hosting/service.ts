import {transaction} from '../application/transaction.ts';
import {sourceStamp} from '../automatic-listing/records.ts';
import { createHash, randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { HostedAsset, HostingProfile, HostingProfileId, HostingUploadInput, HostingRoute, HostingStage, HostingDelivery } from '../../shared/hosting-contracts.ts';
import { DIRECT_HOSTING_ROUTE, HOSTING_PROFILE_IDS } from '../../shared/hosting-contracts.ts';
import type { SecretStorage } from '../amazon/vault.ts';
import { openDatabase } from '../database.ts';
import { inspectRaster } from '../image-format.ts';
import { managedAssetPath } from '../security.ts';
import type { StoredAsset, WorkspaceStore } from '../store.ts';
import { BasicFtpTransport } from './ftp.ts';
import type { HostingTransport } from './ftp.ts';
import { createPublicImageProbe } from './public-probe.ts';
import type { PublicImageProbe } from './public-probe.ts';
import { HostingError, abortable, classifyHostingError, isTransient, sleepWithSignal, throwIfAborted } from './errors.ts';
import { HostingVault } from './vault.ts';
import { MAX_IMAGE_BYTES, PROFILE_NAMES, objectKeys, parseHostingRoute, parseProfileImport, parseUploadInput, profileId, uuid, validatePersistedProfile, validatePersistedUpload } from './validation.ts';

export interface HostingEffectIdentity {
 productId:string|null;assetId:string;variantIds:string[];skus:string[];sourceStamp:string|null;profile:Pick<HostingProfile,'id'|'generation'|'host'|'port'|'secure'|'remoteRoot'|'publicBaseUrl'>;uploadId:string|null;batchId:string|null;sha256:string;byteSize:number;mimeType:string;remotePath:string;publicUrl:string;mayUpload:boolean;
}
export interface HostingDependencies {
  /** Main-only quote preparation, outside SQLite. The returned synchronous permit
   * rechecks authority and reserves in the original upload intent transaction. */
  prepareUpload?: (identity:Readonly<HostingEffectIdentity>,bytes:Buffer,signal:AbortSignal)=>Promise<(db:DatabaseSync)=>void>;
  beforeEffect?: (identity:Readonly<HostingEffectIdentity>,kind:'intent'|'size'|'upload'|'public-get',db?:DatabaseSync)=>void;
  transport?: HostingTransport;
  probe?: PublicImageProbe;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  maxAttempts?: number;
  retryBaseMs?: number;
  totalTimeoutMs?: number;
}
interface ActiveOperation { profileId: HostingProfileId; controller: AbortController; promise: Promise<HostedAsset> }

export class HostingService {
  private directory: string;
  private store: WorkspaceStore;
  private db: DatabaseSync;
  private vault: HostingVault;
  private transport: HostingTransport;
  private probe: PublicImageProbe;
  private sleep: NonNullable<HostingDependencies['sleep']>;
  private now: () => Date;
  private random: () => number;
  private maxAttempts: number;
  private retryBaseMs: number;
  private totalTimeoutMs: number;
  private prepareUpload:HostingDependencies['prepareUpload'];private beforeEffect:HostingDependencies['beforeEffect'];
  private operations = new Map<string, ActiveOperation>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(directory: string, store: WorkspaceStore, storage: SecretStorage, dependencies: HostingDependencies = {}) {
    this.prepareUpload=dependencies.prepareUpload;this.beforeEffect=dependencies.beforeEffect;
    this.directory = directory; this.store = store; this.vault = new HostingVault(directory, storage);
    this.transport = dependencies.transport ?? new BasicFtpTransport(); this.probe = dependencies.probe ?? createPublicImageProbe();
    this.sleep = dependencies.sleep ?? sleepWithSignal; this.now = dependencies.now ?? (() => new Date()); this.random = dependencies.random ?? Math.random;
    this.maxAttempts = dependencies.maxAttempts ?? 3; this.retryBaseMs = dependencies.retryBaseMs ?? 500; this.totalTimeoutMs = dependencies.totalTimeoutMs ?? 120000;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 5 || !Number.isFinite(this.retryBaseMs) || this.retryBaseMs < 0 || this.retryBaseMs > 30000 || !Number.isFinite(this.totalTimeoutMs) || this.totalTimeoutMs < 1 || this.totalTimeoutMs > 600000) throw new HostingError('INVALID_CONFIG');
    this.db = openDatabase(directory);
    try {
      HOSTING_PROFILE_IDS.forEach((id, index) => {
        if (!this.db.prepare('SELECT id FROM hosting_profiles WHERE id=?').get(id)) this.saveProfile({ id, name: PROFILE_NAMES[index], host: '', port: 2121, secure: false, remoteRoot: '/', publicBaseUrl: `https://htc.185858.xyz/${['AAA', 'BBB', 'CCC', 'DDD', 'EEE'][index]}/`, enabled: false, configured: false, generation: 0 });
      });
      this.listProfiles();
      for (const record of this.listUploads()) if (record.status === 'UPLOADING' || record.status === 'VERIFYING') this.saveUpload({ ...record, status: 'PENDING', errorCode: null, updatedAt: this.timestamp() });
    } catch (error) { this.db.close(); throw error; }
  }
  private timestamp(): string { return this.now().toISOString(); }
  private ensureOpen(): void { if (this.closed) throw new HostingError('SERVICE_CLOSED'); }
  private saveProfile(profile: HostingProfile): void {
    const record = validatePersistedProfile(profile);
    this.db.prepare('INSERT INTO hosting_profiles(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(record.id, JSON.stringify(record));
  }
  private saveUpload(record: HostedAsset): HostedAsset {
    const parsed = validatePersistedUpload(record);
    this.db.prepare('INSERT INTO hosting_uploads(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(parsed.id, JSON.stringify(parsed));
    return parsed;
  }
  listProfiles(): HostingProfile[] { this.ensureOpen(); return HOSTING_PROFILE_IDS.map(id => this.getProfile(id)); }
  private storedProfile(rawId: string): HostingProfile {
    this.ensureOpen(); const id = profileId(rawId), row = this.db.prepare('SELECT record_json FROM hosting_profiles WHERE id=?').get(id);
    if (!row) throw new HostingError('INVALID_CONFIG');
    const profile = validatePersistedProfile(JSON.parse(String(row.record_json)));
    if (profile.id !== id) throw new HostingError('INVALID_CONFIG');
    return profile;
  }
  getProfile(rawId: string): HostingProfile {
    const profile = this.storedProfile(rawId), configured = profile.configured && this.vault.has(profile.id, profile.generation);
    return { ...profile, configured, enabled: profile.enabled && configured };
  }
  importProfile(input: unknown): HostingProfile {
    this.ensureOpen(); const parsed = parseProfileImport(input), before = this.getProfile(parsed.id), generation = before.generation + 1;
    const rollback = this.vault.write(parsed.id, { username: parsed.username, password: parsed.password }, generation);
    const next: HostingProfile = { id: parsed.id, name: before.name, host: parsed.host, port: parsed.port, secure: parsed.secure, remoteRoot: parsed.remoteRoot, publicBaseUrl: parsed.publicBaseUrl, configured: true, enabled: false, generation, ...(before.route ? { route: before.route } : {}) };
    try { this.saveProfile(next); } catch (error) { rollback(); throw error; }
    this.cancelProfile(parsed.id, new HostingError('PROFILE_CHANGED'));
    return this.getProfile(parsed.id);
  }
  setRoute(input: unknown): HostingProfile {
    this.ensureOpen(); const o = objectKeys(input, ['id', 'route']), id = profileId(o.id), route = parseHostingRoute(o.route);
    const before = this.storedProfile(id);
    // Existing operations keep their captured route. Credentials and generation do not rotate.
    this.saveProfile({ ...before, route });
    return this.getProfile(id);
  }
  setEnabled(input: unknown): HostingProfile {
    this.ensureOpen(); const o = objectKeys(input, ['id', 'enabled']), id = profileId(o.id);
    if (typeof o.enabled !== 'boolean') throw new HostingError('INVALID_INPUT');
    const profile = this.storedProfile(id);
    if (o.enabled && !this.getProfile(id).configured) throw new HostingError('CREDENTIAL_NOT_FOUND');
    this.saveProfile({ ...profile, enabled: o.enabled });
    if (!o.enabled) this.cancelProfile(id, new HostingError('PROFILE_DISABLED'));
    return this.getProfile(id);
  }
  private cancelProfile(id: HostingProfileId, error: HostingError): void { for (const active of this.operations.values()) if (active.profileId === id) active.controller.abort(error); }
  private assertProfile(id: string, generation: number): HostingProfile {
    const profile = this.getProfile(id);
    if (generation !== profile.generation) throw new HostingError('PROFILE_CHANGED');
    if (!profile.enabled) throw new HostingError('PROFILE_DISABLED');
    if (!profile.configured) throw new HostingError('CREDENTIAL_NOT_FOUND');
    return profile;
  }
  async checkLocalAssets(ids:string[]):Promise<void>{for(const id of ids)await this.readAsset(this.eligibleAsset(id));}
  listUploads(): HostedAsset[] {
    this.ensureOpen(); return this.db.prepare('SELECT id,record_json FROM hosting_uploads ORDER BY rowid').all().map(row => {
      const record = validatePersistedUpload(JSON.parse(String(row.record_json))); if (record.id !== row.id) throw new HostingError('INVALID_CONFIG'); return record;
    });
  }
  private eligibleAsset(assetId: string): StoredAsset {
    const asset = this.store.getAssetRecord(assetId);
    if (!asset) throw new HostingError('LOCAL_FILE_MISSING');
    const product = this.store.getProduct(asset.productId), image = product.assets.find(image => image.id === assetId);
    if (!image || !['main', 'gallery'].includes(image.role) || !image.variantIds.length || image.variantIds.some(id => !product.variants.some(variant => variant.id === id))) throw new HostingError('ASSET_NOT_CONFIRMED');
    const bindings = this.db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=?').all(assetId);
    if (!bindings.length || bindings.some(binding => binding.confirmed !== 1)) throw new HostingError('ASSET_NOT_CONFIRMED');
    return asset;
  }
  private async readAsset(asset: StoredAsset): Promise<Buffer> {
    let path: string;
    try {
      path = managedAssetPath(this.directory, asset.originalPath);
      const [root, actual] = await Promise.all([realpath(this.directory), realpath(path)]);
      const below = relative(root, actual);
      if (!below || below === '..' || below.startsWith(`..${sep}`) || resolve(root, below) !== actual || actual === root) throw new HostingError('LOCAL_FILE_CHANGED');
      // Resolve both the managed path and its parents before opening. Never follow a caller-supplied file path.
      const handle = await open(actual, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_BYTES || info.size !== asset.byteSize) throw new HostingError('LOCAL_FILE_CHANGED');
        const buffer = Buffer.alloc(info.size); let position = 0;
        while (position < buffer.length) { const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position); if (!bytesRead) throw new HostingError('LOCAL_FILE_CHANGED'); position += bytesRead; }
        const after = await handle.stat();
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || createHash('sha256').update(buffer).digest('hex') !== asset.sha256) throw new HostingError('LOCAL_FILE_CHANGED');
        let raster; try { raster = inspectRaster(buffer); } catch { throw new HostingError('LOCAL_FILE_CHANGED'); }
        if (raster.mimeType !== asset.mimeType || raster.width !== asset.width || raster.height !== asset.height) throw new HostingError('LOCAL_FILE_CHANGED');
        return buffer;
      } finally { await handle.close(); }
    } catch (error) { if (error instanceof HostingError) throw error; throw new HostingError('LOCAL_FILE_MISSING'); }
  }
  private checkEffect(identity:Readonly<HostingEffectIdentity>,kind:'intent'|'size'|'upload'|'public-get',db?:DatabaseSync):void{if(this.beforeEffect?.constructor.name==='AsyncFunction')throw new HostingError('INVALID_CONFIG');const result=this.beforeEffect?.(identity,kind,db) as unknown;if(result&&typeof(result as PromiseLike<unknown>).then==='function')throw new HostingError('INVALID_CONFIG');}
  private effectIdentity(assetId:string,profile:HostingProfile,sha256:string,byteSize:number,mimeType:string,remotePath:string,publicUrl:string,uploadId:string|null,batchId:string|null,mayUpload:boolean):Readonly<HostingEffectIdentity>{
    const asset=this.store.getAssetRecord(assetId),product=asset?this.store.getProduct(asset.productId):null,image=product?.assets.find(a=>a.id===assetId),variantIds=[...(image?.variantIds??[])].sort();
    return Object.freeze({productId:product?.id??null,assetId,variantIds:Object.freeze(variantIds) as unknown as string[],skus:Object.freeze(variantIds.map(id=>product!.variants.find(v=>v.id===id)!.sku)) as unknown as string[],sourceStamp:product?sourceStamp(product):null,profile:Object.freeze({id:profile.id,generation:profile.generation,host:profile.host,port:profile.port,secure:profile.secure,remoteRoot:profile.remoteRoot,publicBaseUrl:profile.publicBaseUrl}),uploadId,batchId,sha256,byteSize,mimeType,remotePath,publicUrl,mayUpload});
  }
  /** Internal M09 port for source/candidate references. It never adopts an asset for listing. */
  async uploadReferenceVersion(profileId: string, generation: number, version: import('./reference-pins.ts').ReferenceVersion, bytes: Buffer, signal = new AbortController().signal, route?: HostingRoute): Promise<string> {
    this.ensureOpen(); const profile = { ...this.assertProfile(profileId, generation), ...(route ? { route: parseHostingRoute(route) } : {}) };
    if (bytes.length !== version.byteSize || createHash('sha256').update(bytes).digest('hex') !== version.sha256) throw new HostingError('LOCAL_FILE_CHANGED');
    const raster = inspectRaster(bytes); if (raster.mimeType !== version.mimeType) throw new HostingError('LOCAL_FILE_CHANGED');
    const relativePath = `references/${version.sha256}.${version.mimeType === 'image/png' ? 'png' : 'jpg'}`;
    const remotePath = `${profile.remoteRoot === '/' ? '' : profile.remoteRoot}/${relativePath}`, url = new URL(relativePath, profile.publicBaseUrl).href;
    const credentials = this.vault.read(profile.id, profile.generation);
    throwIfAborted(signal);
    const identity=this.effectIdentity(version.assetId,profile,version.sha256,version.byteSize,version.mimeType,remotePath,url,null,null,true);
    this.checkEffect(identity,'size');
    const size = await abortable(this.transport.size(profile, credentials, remotePath, signal), signal);
    // An existing immutable version is never overwritten, even if it is damaged.
    if (size !== null && size !== bytes.length) throw new HostingError('SIZE_MISMATCH');
    if(size===null){this.checkEffect(identity,'upload');if(await abortable(this.transport.upload(profile,credentials,remotePath,bytes,signal),signal)!==bytes.length)throw new HostingError('SIZE_MISMATCH');}
    this.checkEffect(identity,'public-get');
    await abortable(this.probe({url,sha256:version.sha256,byteSize:version.byteSize,mimeType:version.mimeType}, signal), signal);
    this.assertProfile(profile.id, generation); throwIfAborted(signal); return url;
  }
  async upload(raw: HostingUploadInput, signal?: AbortSignal): Promise<HostedAsset> {
    this.ensureOpen(); const input = parseUploadInput(raw), profile = this.assertProfile(input.profileId, input.generation), asset = this.eligibleAsset(input.assetId);
    return this.start(input, profile, asset, true, signal);
  }
  async verify(uploadId: string, signal?: AbortSignal): Promise<HostedAsset> {
    this.ensureOpen(); const id = uuid(uploadId), record = this.listUploads().find(record => record.id === id);
    if (!record) throw new HostingError('INVALID_INPUT');
    const profile = this.assertProfile(record.profileId, record.generation), asset = this.eligibleAsset(record.assetId);
    if (asset.sha256 !== record.sha256 || asset.byteSize !== record.byteSize || asset.mimeType !== record.mimeType) throw new HostingError('LOCAL_FILE_CHANGED');
    return this.start({ assetId: record.assetId, profileId: record.profileId, generation: record.generation, batchId: record.batchId }, profile, asset, false, signal);
  }
  private start(input: HostingUploadInput, profile: HostingProfile, asset: StoredAsset, mayUpload: boolean, signal?: AbortSignal): Promise<HostedAsset> {
    const key = `${profile.id}:${profile.generation}:${asset.id}:${asset.sha256}`;
    const existing = this.operations.get(key); if (existing) return existing.promise;
    const controller = new AbortController(), cancel = () => controller.abort(signal?.reason instanceof HostingError ? signal.reason : new HostingError('CANCELLED'));
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(new HostingError('CONNECT_TIMEOUT')), this.totalTimeoutMs);
    const promise = this.run(input, profile, asset, mayUpload, controller.signal).finally(() => {
      clearTimeout(timeout); signal?.removeEventListener('abort', cancel); this.operations.delete(key);
    });
    this.operations.set(key, { profileId: profile.id, controller, promise }); return promise;
  }
  private async run(input: HostingUploadInput, profile: HostingProfile, asset: StoredAsset, mayUpload: boolean, signal: AbortSignal): Promise<HostedAsset> {
    throwIfAborted(signal);
    const bytes = await this.readAsset(asset); throwIfAborted(signal);
    this.assertProfile(profile.id, profile.generation);
    const credentials = this.vault.read(profile.id, profile.generation);
    let record = this.listUploads().find(row => row.profileId === profile.id && row.generation === profile.generation && row.assetId === asset.id && row.sha256 === asset.sha256);
    if (!record) {
      const date = this.timestamp(), directory = `${date.slice(0, 10).replaceAll('-', '')}/${input.batchId}`;
      const relativePath = `${directory}/${asset.id}-${asset.sha256.slice(0, 16)}.${asset.mimeType === 'image/png' ? 'png' : 'jpg'}`;
      record = { id: randomUUID(), assetId: asset.id, profileId: profile.id, batchId: input.batchId, generation: profile.generation, sha256: asset.sha256,
        byteSize: asset.byteSize, mimeType: asset.mimeType as HostedAsset['mimeType'], remotePath: `${profile.remoteRoot === '/' ? '' : profile.remoteRoot}/${relativePath}`, publicUrl: new URL(relativePath, profile.publicBaseUrl).href,
        status: 'PENDING', attempts: 0, history: [], route: input.route ?? profile.route ?? DIRECT_HOSTING_ROUTE, errorCode: null, createdAt: date, updatedAt: date };
    }
    profile = { ...profile, route: record.route ?? DIRECT_HOSTING_ROUTE };
    // The persisted path and profile generation remain fixed for retries and restart recovery.
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const identity=this.effectIdentity(asset.id,profile,asset.sha256,asset.byteSize,asset.mimeType,record.remotePath,record.publicUrl,record.id,record.batchId,mayUpload),permit=await this.prepareUpload?.(identity,Buffer.from(bytes),signal);
      throwIfAborted(signal);this.assertProfile(profile.id,profile.generation);
      if(JSON.stringify(identity)!==JSON.stringify(this.effectIdentity(asset.id,profile,asset.sha256,asset.byteSize,asset.mimeType,record.remotePath,record.publicUrl,record.id,record.batchId,mayUpload)))throw new HostingError('LOCAL_FILE_CHANGED');
      const startedAt = this.timestamp();
      record=transaction(this.db,()=>{if(permit?.constructor.name==='AsyncFunction')throw new HostingError('INVALID_CONFIG');const permitted=permit?.(this.db) as unknown;if(permitted&&typeof(permitted as PromiseLike<unknown>).then==='function')throw new HostingError('INVALID_CONFIG');this.checkEffect(identity,'intent',this.db);return this.saveUpload({...record!,status:'UPLOADING',attempts:record!.attempts+1,errorCode:null,updatedAt:startedAt});});
      let stage: HostingStage = 'size', delivery: HostingDelivery = 'not-sent';
      try {
        throwIfAborted(signal); this.assertProfile(profile.id, profile.generation);
        this.checkEffect(identity,'size');
        let size = await abortable(this.transport.size(profile, credentials, record.remotePath, signal), signal);
        if (size !== bytes.length) {
          if (!mayUpload) throw new HostingError(size === null ? 'REMOTE_SIZE_UNAVAILABLE' : 'SIZE_MISMATCH');
          this.checkEffect(identity,'upload');
          stage = 'upload'; delivery = 'unknown';
          size = await abortable(this.transport.upload(profile, credentials, record.remotePath, bytes, signal), signal);
        }
        if (size !== bytes.length) throw new HostingError('SIZE_MISMATCH');
        throwIfAborted(signal); this.assertProfile(profile.id, profile.generation);
        delivery = 'confirmed'; stage = 'public-get';
        record = this.saveUpload({ ...record, status: 'VERIFYING', updatedAt: this.timestamp() });
        this.checkEffect(identity,'public-get');
        await abortable(this.probe({ url: record.publicUrl, sha256: record.sha256, byteSize: record.byteSize, mimeType: record.mimeType }, signal), signal);
        throwIfAborted(signal); this.assertProfile(profile.id, profile.generation);
        const current = this.eligibleAsset(asset.id);
        if (current.sha256 !== asset.sha256 || current.originalPath !== asset.originalPath || current.byteSize !== asset.byteSize) throw new HostingError('LOCAL_FILE_CHANGED');
        await this.readAsset(current); throwIfAborted(signal);
        this.assertProfile(profile.id, profile.generation);
        const finishedAt = this.timestamp();
        return this.saveUpload({ ...record, status: 'AVAILABLE', errorCode: null, updatedAt: finishedAt,
          history: [...record.history, { attempt: record.attempts, status: 'AVAILABLE', errorCode: null, startedAt, finishedAt, stage, delivery }] });
      } catch (error) {
        const safe = signal.aborted && signal.reason instanceof HostingError ? signal.reason : classifyHostingError(error);
        const status = safe.code === 'CANCELLED' || safe.code === 'SERVICE_CLOSED' ? 'CANCELLED' : 'FAILED';
        const finishedAt = this.timestamp();
        record = this.saveUpload({ ...record, status, errorCode: safe.code, updatedAt: finishedAt,
          history: [...record.history, { attempt: record.attempts, status, errorCode: safe.code, startedAt, finishedAt, stage: safe.stage ?? stage, delivery: safe.delivery ?? delivery }] });
        if (signal.aborted || !isTransient(safe) || attempt + 1 >= this.maxAttempts) return record;
        try { await abortable(this.sleep(this.retryBaseMs * 2 ** attempt + Math.floor(Math.max(0, Math.min(1, this.random())) * this.retryBaseMs), signal), signal); }
        catch (waitError) {
          const wait = signal.reason instanceof HostingError ? signal.reason : classifyHostingError(waitError);
          return this.saveUpload({ ...record, status: wait.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED', errorCode: wait.code, updatedAt: this.timestamp() });
        }
      }
    }
    return record;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const active of this.operations.values()) active.controller.abort(new HostingError('CANCELLED'));
      await Promise.allSettled([...this.operations.values()].map(active => active.promise));
      try { await this.transport.close(); } finally { this.db.close(); }
    })();
    return this.closing;
  }
}
