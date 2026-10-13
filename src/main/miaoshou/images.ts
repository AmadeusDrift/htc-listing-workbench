import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { MiaoshouDownloadResult, MiaoshouProduct, MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { parseMutation, record } from '../../shared/validation.ts';
import { importImageFiles } from '../assets.ts';
import type { PreviewDecoder } from '../assets.ts';
import type { WorkspaceStore } from '../store.ts';
import { isPublicIp } from '../hosting/public-probe.ts';
import { publicError } from '../security.ts';
import { inspectRaster } from '../image-format.ts';
import { uuid } from './validation.ts';
import { sourceImageReceipt, sourceImageMappings } from '../source-images.ts';
import type { SourceImageReceipt } from '../source-images.ts';
import { listingFingerprint } from "../json-fingerprint.ts";

interface DownloadBudget { remainingBytes: number }
/** Main-process-only scope; never accepted through IPC or stored across automatic runs. */
export interface SourceImageDownloadSession { createdAssets: Set<string>; variantIds?: string[] }
type Downloader = (url: string, signal: AbortSignal, budget?: DownloadBudget) => Promise<Buffer>;
interface DownloadDependencies {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /** Electron net.fetch, used only for the exact trusted CDN's Fake-IP answers. */
  nativeFetch?: (url: string, init: RequestInit) => Promise<Response>;
  request?: typeof httpsRequest; timeoutMs?: number; maxBytes?: number;
}
function imageUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !url.hostname.includes('.') || /[\\\s]/.test(value)
      || [...url.searchParams.keys()].some(key => /token|cookie|auth|secret|signature|credential|session|password|key/i.test(key))) throw new Error();
    return url;
  } catch { throw new UserFacingError('来源图片地址不符合要求'); }
}
function aborted(signal: AbortSignal): void { if (signal.aborted) throw new UserFacingError('来源图片下载已取消或超时'); }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(new UserFacingError('来源图片下载已取消或超时'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function fakeIpv4(address: { address: string; family: number }): boolean {
  if (address.family !== 4 || isIP(address.address) !== 4) return false;
  const [first, second] = address.address.split('.').map(Number);
  return first === 198 && (second === 18 || second === 19);
}
async function nativeSourceImage(url: URL, signal: AbortSignal, limit: number, budget: DownloadBudget | undefined, fetcher: NonNullable<DownloadDependencies['nativeFetch']>): Promise<Buffer> {
  aborted(signal);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const pending = fetcher(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal,
      headers: { Accept: 'image/png,image/jpeg', 'Accept-Encoding': 'identity' } }).then(value => {
      // Retain the response before the abortable handoff so every cancellation closes it.
      response = value;
      if (signal.aborted) { void value.body?.cancel().catch(() => {}); aborted(signal); }
      return value;
    });
    response = await abortable(pending, signal);
    aborted(signal);
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href)) throw new UserFacingError('来源图片不可访问，未接受跳转或错误响应');
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
    if (!['image/png', 'image/jpeg'].includes(mime) || (encoding && encoding !== 'identity')
      || (length !== null && (!/^\d+$/.test(length) || Number(length) < 1 || Number(length) > limit))) throw new UserFacingError('来源图片格式不支持，或超过单图与本批剩余大小限制');
    if (!response.body) throw new UserFacingError('来源图片下载不完整');
    reader = response.body.getReader();
    const chunks: Buffer[] = []; let size = 0;
    while (true) {
      const next = await abortable(reader.read(), signal); aborted(signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (budget) budget.remainingBytes = Math.max(0, budget.remainingBytes - next.value.byteLength);
      if (size > limit) throw new UserFacingError('来源图片超过大小限制');
      chunks.push(Buffer.from(next.value));
    }
    if (!size || (length !== null && size !== Number(length))) throw new UserFacingError('来源图片下载不完整');
    return Buffer.concat(chunks, size);
  } finally {
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else void response?.body?.cancel().catch(() => {});
  }
}
/** Public HTTPS is DNS-pinned; only the exact trusted CDN may use the proxy's Fake-IP transport. */
export function createSourceImageDownloader(dependencies: DownloadDependencies = {}): Downloader {
  const lookup = dependencies.lookup ?? (host => dnsLookup(host, { all: true })), request = dependencies.request ?? httpsRequest;
  const maxBytes = dependencies.maxBytes ?? 20 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024) throw new Error('Invalid image limit');
  return async (value, callerSignal, budget) => {
    const url = imageUrl(value); aborted(callerSignal);
    const limit = Math.min(maxBytes, budget?.remainingBytes ?? maxBytes);
    if (limit <= 0) throw new UserFacingError('本批来源图片已达到 80 MB 下载上限');
    const controller = new AbortController(), signal = controller.signal, cancel = () => controller.abort();
    callerSignal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, dependencies.timeoutMs ?? 20000);
    try {
      const addresses = await abortable(lookup(url.hostname), signal);
      // Do not widen this to *.alicdn.com or mixed public/private DNS answers.
      if (dependencies.nativeFetch && url.hostname === 'cbu01.alicdn.com' && addresses.length && addresses.every(fakeIpv4)) {
        return await nativeSourceImage(url, signal, limit, budget, dependencies.nativeFetch);
      }
      if (!addresses.length || addresses.some(address => !isPublicIp(address.address) || isIP(address.address) !== address.family)) throw new UserFacingError('来源图片域名解析到非公开网络，下载已阻止');
      const pinned = addresses[0], pinnedLookup: LookupFunction = (_host, options, callback) => {
        if (options.all) (callback as unknown as (error: null, results: typeof addresses) => void)(null, [pinned]); else callback(null, pinned.address, pinned.family);
      };
      aborted(signal);
      return await new Promise<Buffer>((resolveBytes, reject) => {
        let finished = false, req: ReturnType<typeof httpsRequest> | undefined;
        const finish = (error: Error | null, bytes?: Buffer) => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); if (error) reject(error); else resolveBytes(bytes!); };
        const abort = () => { finish(new UserFacingError('来源图片下载已取消或超时')); req?.destroy(); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          req = request(url, { method: 'GET', agent: false, lookup: pinnedLookup, rejectUnauthorized: true, maxHeaderSize: 8192, headers: { Accept: 'image/png,image/jpeg', 'Accept-Encoding': 'identity' } }, response => {
            if (finished) { response.destroy(); return; }
            const fail = (message: string) => { finish(new UserFacingError(message)); response.destroy(); req?.destroy(); };
            if (response.statusCode !== 200) { fail('来源图片不可访问，未接受跳转或错误响应'); return; }
            const mime = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), length = response.headers['content-length'];
            if (!['image/png', 'image/jpeg'].includes(mime) || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
              || (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) < 1 || Number(length) > limit))) { fail('来源图片格式不支持，或超过单图与本批剩余大小限制'); return; }
            let size = 0; const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => {
              if (finished) return; size += chunk.length;
              if (budget) budget.remainingBytes = Math.max(0, budget.remainingBytes - chunk.length);
              if (size > limit) { fail('来源图片超过大小限制'); return; } chunks.push(chunk);
            });
            response.once('error', () => finish(new UserFacingError('来源图片下载中断')));
            response.once('aborted', () => finish(new UserFacingError('来源图片下载中断')));
            response.once('end', () => { if (!size || (length !== undefined && size !== Number(length))) { fail('来源图片下载不完整'); return; } finish(null, Buffer.concat(chunks, size)); });
          });
          req.once('error', () => finish(new UserFacingError('来源图片网络请求未完成'))); req.end(); if (signal.aborted) abort();
        } catch { finish(new UserFacingError('来源图片网络请求未完成')); req?.destroy(); }
      });
    } catch (error) { aborted(signal); if (error instanceof UserFacingError) throw error; throw new UserFacingError('来源图片下载未完成'); }
    finally { clearTimeout(timer); callerSignal.removeEventListener('abort', cancel); }
  };
}

interface ImageDependencies { download?: Downloader; demoImage?: (id: string) => Buffer; getSourceUpdate?: (id: string) => MiaoshouProduct | null }
export class MiaoshouImageService {
  private previewCache = new Map<string, string>();
  private previewRequests = new Map<string, Promise<string>>();
  private previewSlots = 3;
  private previewQueue: (() => void)[] = [];
  private operation?: Promise<MiaoshouDownloadResult>;
  private controller = new AbortController();
  private closed = false;
  private readonly downloader: Downloader;
  private readonly directory: string;
  private readonly store: WorkspaceStore;
  private readonly getReceipt: (id: string) => MiaoshouReceipt | null;
  private readonly decode: PreviewDecoder;
  private readonly dependencies: ImageDependencies;
  constructor(directory: string, store: WorkspaceStore, getReceipt: (id: string) => MiaoshouReceipt | null, decode: PreviewDecoder, dependencies: ImageDependencies = {}) {
    this.directory = directory; this.store = store; this.getReceipt = getReceipt; this.decode = decode; this.dependencies = dependencies;
    this.downloader = dependencies.download ?? createSourceImageDownloader();
  }
  get busy(): boolean { return Boolean(this.operation) || this.previewRequests.size > 0; }
  async preview(raw: unknown): Promise<string> {
    if (this.closed) throw new UserFacingError('来源图片服务已关闭');
    const input = record(raw, '来源图片预览', ['productId', 'imageId', 'version']), productId = uuid(input.productId);
    if (typeof input.imageId !== 'string' || input.imageId.length > 100) throw new UserFacingError('来源图片选择无效');
    if (input.version !== undefined && !['imported','latest'].includes(String(input.version))) throw new UserFacingError('来源图片版本无效');
    const receipt = this.getReceipt(productId), source = input.version === 'latest' ? this.dependencies.getSourceUpdate?.(productId) : receipt?.snapshot;
    const image = source?.images.find(item => item.id === input.imageId);
    if (!receipt || receipt.productId !== productId || !image) throw new UserFacingError('来源图片不属于该商品');
    const key = `${productId}:${image.id}:${image.url}`, cached = this.previewCache.get(key);
    if (cached) return cached;
    const pending = this.previewRequests.get(key); if (pending) return pending;
    if (this.previewRequests.size >= 100) throw new UserFacingError('图片正在加载，请稍后重试');
    const operation = (async () => {
      if (this.previewSlots > 0) this.previewSlots--; else await new Promise<void>(resolve => this.previewQueue.push(resolve));
      try {
        aborted(this.controller.signal);
        const bytes = receipt.mode === 'demo' ? this.dependencies.demoImage?.(image.id) : await this.downloader(image.url, this.controller.signal, { remainingBytes: 20 * 1024 * 1024 });
        aborted(this.controller.signal);
        if (!bytes || bytes.length > 20 * 1024 * 1024) throw new UserFacingError('来源图片无法预览');
        inspectRaster(bytes); const preview = this.decode(bytes);
        if (!preview.length || preview.length > 4 * 1024 * 1024) throw new UserFacingError('来源图片预览过大');
        const result = `data:image/png;base64,${preview.toString('base64')}`;
        while (this.previewCache.size >= 48) this.previewCache.delete(this.previewCache.keys().next().value!);
        this.previewCache.set(key, result); return result;
      } finally { const next = this.previewQueue.shift(); if (next) next(); else this.previewSlots++; }
    })();
    this.previewRequests.set(key, operation);
    try { return await operation; } finally { this.previewRequests.delete(key); }
  }
  async download(raw: unknown, callerSignal?: AbortSignal, session?: SourceImageDownloadSession): Promise<MiaoshouDownloadResult> {
    if (this.closed) throw new UserFacingError('来源图片服务已关闭');
    if (this.operation) throw new UserFacingError('还有来源图片正在下载，请稍后重试');
    const input = record(raw, '来源图片下载', ['productId', 'revision', 'imageIds']), mutation = parseMutation(input);
    this.store.assertRevision(mutation);
    if (!Array.isArray(input.imageIds) || !input.imageIds.length || input.imageIds.length > 20 || input.imageIds.some(id => typeof id !== 'string') || new Set(input.imageIds).size !== input.imageIds.length) throw new UserFacingError('每次请选择 1–20 张不同的来源图片');
    const source = sourceImageReceipt(this.store.getCollectionReceipt(mutation.productId),this.getReceipt(mutation.productId));
    const receipt=source?.receipt;
    if (!source || !receipt || receipt.productId !== mutation.productId || input.imageIds.some(id => !receipt.snapshot.images.some(image => image.id === id))) throw new UserFacingError('来源图片不属于该商品');
    const signal = callerSignal ? AbortSignal.any([this.controller.signal, callerSignal]) : this.controller.signal;
    aborted(signal);
    this.operation = this.perform(mutation, source, input.imageIds as string[], signal, session);
    try { return await this.operation; } finally { this.operation = undefined; }
  }
  private async perform(input: { productId: string; revision: number }, source: SourceImageReceipt, imageIds: string[], signal: AbortSignal, session?: SourceImageDownloadSession): Promise<MiaoshouDownloadResult> {
    const receipt=source.receipt, stamp=listingFingerprint(source);
    const fresh=()=>{aborted(signal);if(listingFingerprint(sourceImageReceipt(this.store.getCollectionReceipt(input.productId),this.getReceipt(input.productId)))!==stamp)throw new UserFacingError('来源记录已变化');};
    await mkdir(this.directory, { recursive: true });
    fresh();
    const temporary = await mkdtemp(join(this.directory, '.miaoshou-images-'));
    let downloaded = 0, existing = 0;
    const budget: DownloadBudget = { remainingBytes: 80 * 1024 * 1024 };
    const createdAssets = session?.createdAssets ?? new Set<string>();
    const failures: MiaoshouDownloadResult['failures'] = [];
    try {
      let product = this.store.assertRevision(input);
      for (const imageId of imageIds) {
        if (budget.remainingBytes <= 0) {
          failures.push(...imageIds.slice(imageIds.indexOf(imageId)).map(id => ({ imageId: id, message: '本批已达到 80 MB 下载上限，请另选一批图片' })));
          break;
        }
        const image = receipt.snapshot.images.find(row => row.id === imageId)!;
        try {
          aborted(signal);
          const remaining = budget.remainingBytes;
          const bytes = source.kind==='miaoshou'&&source.receipt.mode === 'demo' ? this.dependencies.demoImage?.(imageId) : await this.downloader(image.url, signal, budget);
          if (!bytes) throw new UserFacingError('演示图片生成不可用');
          fresh();
          // Network streams consume this budget even if they later fail. Local/demo decoders also count.
          budget.remainingBytes = Math.min(budget.remainingBytes, Math.max(0, remaining - bytes.length));
          if (bytes.length > 20 * 1024 * 1024 || bytes.length > remaining) throw new UserFacingError('每张图片最多 20 MB，每批最多 80 MB');
          this.store.assertRevision({ productId: product.id, revision: product.revision });
          const raster = inspectRaster(bytes), hash = createHash('sha256').update(bytes).digest('hex');
          const variants = sourceImageMappings(source).filter(row => row.images.some(i=>i.imageId===imageId) && product.variants.some(variant => variant.id === row.localVariantId)&&(!session?.variantIds||session.variantIds.includes(row.localVariantId))).map(row => row.localVariantId);
          const previous = this.store.findAssetByHash(product.id, hash);
          const anchor=(assetId:string,bindings:string[],newlyImported=false)=>this.store.anchorSourceImage({productId:product.id,revision:product.revision},{
            version:'source-image-provenance/v1',id:randomUUID(),productId:product.id,receiptKind:source.kind,receiptId:receipt.id,receiptFingerprint:receipt.fingerprint,
            imageId,url:image.url,mappings:sourceImageMappings(source).flatMap(m=>m.images.filter(i=>i.imageId===imageId).map(({imageId,...i})=>({localVariantId:m.localVariantId,sourceSku:m.sourceSku,...i}))),
            assetId,sha256:hash,byteSize:bytes.length,mimeType:raster.mimeType,width:raster.width,height:raster.height,observedAt:new Date().toISOString(),
          },bindings,newlyImported?image.role:undefined);
          if (previous) {
            // CDN aliases can be the same photo. Merge only this operation's new bindings;
            // assets that existed before it may have been deliberately edited by the user.
            product=anchor(previous.id,createdAssets.has(previous.id)?variants:[]);
            existing++; continue;
          }
          const sourcePath = join(temporary, `source-${imageIds.indexOf(imageId)}.${raster.extension}`); await writeFile(sourcePath, bytes, { flag: 'wx' });
          fresh();this.store.assertRevision({productId:product.id,revision:product.revision});
          product = await importImageFiles(this.store, this.directory, { productId: product.id, revision: product.revision }, [sourcePath], this.decode,()=>{fresh();this.store.assertRevision({productId:product.id,revision:product.revision});});
          fresh();this.store.assertRevision({productId:product.id,revision:product.revision});
          const asset = this.store.findAssetByHash(product.id, hash);
          if (asset) {
            product=anchor(asset.id,variants,true);
            createdAssets.add(asset.id);
          }
          downloaded++;
        } catch (error) { failures.push({ imageId, message: publicError(error) }); if (signal.aborted) break; }
      }
      aborted(signal);
      return { product: this.store.assertRevision({ productId: product.id, revision: product.revision }), downloaded, existing, failures };
    } finally {
      const path = resolve(temporary), root = resolve(this.directory);
      if (path.startsWith(root + sep) && /^\.miaoshou-images-[A-Za-z0-9]+$/.test(path.slice(root.length + 1))) await rm(path, { recursive: true, force: true });
    }
  }
  async close(): Promise<void> { this.closed = true; this.controller.abort(); await Promise.allSettled([...this.previewRequests.values(), ...(this.operation ? [this.operation] : [])]); this.previewCache.clear(); }
}
