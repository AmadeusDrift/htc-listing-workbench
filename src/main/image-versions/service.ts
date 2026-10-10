import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AiResult } from '../../shared/ai-contracts.ts';
import type { ImageSelection, ImageVersion } from '../../shared/image-version-contracts.ts';
import type { ImageWriteRecoveryStatus } from '../../shared/image-write-contracts.ts';
import { AiError, abortable, throwIfAborted } from '../ai/errors.ts';
import { integer, keys, uuid, validateStoredAiResult } from '../ai/validation.ts';
import { readManagedImage } from '../ai/source.ts';
import { openDatabase } from '../database.ts';
import { RecordReader } from '../record-query.ts';
import { inspectRaster } from '../image-format.ts';
import { managedAssetPath } from '../security.ts';
import type { WorkspaceStore } from '../store.ts';
import { createArtifactDownloader } from './download.ts';
import type { ArtifactDownloader } from './download.ts';
import { validateImageSelection, validateImageVersion } from './validation.ts';
import { ImageWriteRecovery } from './recovery.ts';
import type { ImageWriteCheckpoint } from './recovery.ts';

export interface DecodedArtifact { width: number; height: number; transparentPixels: number; subjectPixels: number; preview: Buffer }
export interface ImageVersionDependencies {
  decode: (bytes: Buffer) => DecodedArtifact; download?: ArtifactDownloader; timeoutMs?: number;
  /** Main-process fault injection only; it is never exposed through IPC. */
  checkpoint?: (point: ImageWriteCheckpoint, candidate: ImageVersion) => void | Promise<void>;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

export class ImageVersionService {
  private db;
  private records: RecordReader;
  private operations = new Map<string, { controller: AbortController; promise: Promise<ImageVersion> }>();
  private closed = false;
  private closing?: Promise<void>;
  private download: ArtifactDownloader;
  private root: string;
  private store: WorkspaceStore;
  private ai: { listResults(productId: string): AiResult[]; getResult?(id: string): AiResult | undefined };
  private dependencies: ImageVersionDependencies;
  private recovery: ImageWriteRecovery;
  constructor(root: string, store: WorkspaceStore, ai: { listResults(productId: string): AiResult[]; getResult?(id: string): AiResult | undefined }, dependencies: ImageVersionDependencies) {
    this.root = root; this.store = store; this.ai = ai; this.dependencies = dependencies;
    this.db = openDatabase(root); this.download = dependencies.download ?? createArtifactDownloader();
    this.records = new RecordReader(this.db);
    this.recovery = new ImageWriteRecovery(root, this.db);
    try { this.recovery.recover(); } catch (error) { this.db.close(); throw error; }
  }
  get busy(): boolean { return this.operations.size > 0; }
  private ensureOpen() { if (this.closed) throw new AiError('SERVICE_CLOSED'); }
  recoveryStatus(limit = 20): ImageWriteRecoveryStatus { this.ensureOpen(); return this.recovery.status(limit); }
  recover(): ImageWriteRecoveryStatus { this.ensureOpen(); if (this.busy) throw new AiError('BUSY'); return this.recovery.recover(); }
  private async checkpoint(point: ImageWriteCheckpoint, candidate: ImageVersion): Promise<void> { await this.dependencies.checkpoint?.(point, structuredClone(candidate)); }
  list(rawProductId: string): ImageVersion[] { this.ensureOpen(); return this.records.list('image_versions', { productId: uuid(rawProductId) }, validateImageVersion); }
  selections(rawProductId: string): ImageSelection[] { this.ensureOpen(); return this.records.list('image_selections', { productId: uuid(rawProductId) }, validateImageSelection); }
  queryVersions(raw: unknown) { this.ensureOpen(); return this.records.query('image_versions', raw, validateImageVersion); }
  querySelections(raw: unknown) { this.ensureOpen(); return this.records.query('image_selections', raw, validateImageSelection); }
  private source(productId: string, productRevision: number, assetId: string) {
    const product = this.store.assertRevision({ productId, revision: productRevision }), asset = this.store.getAssetRecord(assetId);
    if (!asset || asset.productId !== productId || !product.assets.some(a => a.id === assetId)) throw new AiError('SOURCE_CHANGED');
    return asset;
  }
  private result(productId: string, revision: number, id: string): AiResult {
    const raw = this.ai.getResult ? this.ai.getResult(id) : this.ai.listResults(productId).find(r => r.id === id); if (!raw) throw new AiError('SOURCE_CHANGED');
    const result = validateStoredAiResult(raw);
    if (result.id !== id || result.productId !== productId || result.productRevision !== revision || result.providerId !== 'aidge-segmentation' || result.output.kind !== 'segmentation' || !result.assetId) throw new AiError('SOURCE_CHANGED');
    const asset = this.source(productId, revision, result.assetId);
    if (asset.sha256 !== result.assetSha256 || result.output.width !== asset.width || result.output.height !== asset.height) throw new AiError('SOURCE_CHANGED');
    return result;
  }
  private async bytes(path: string, expectedHash: string, expectedSize: number): Promise<Buffer> {
    const destination = managedAssetPath(this.root, path);
    if (canonical(await realpath(destination)) !== canonical(resolve(destination)) || (await lstat(destination)).isSymbolicLink()) throw new AiError('SOURCE_CHANGED');
    const file = await open(destination, 'r');
    try {
      const before = await file.stat(); if (!before.isFile() || before.size !== expectedSize) throw new AiError('SOURCE_CHANGED');
      const data = Buffer.alloc(expectedSize); let offset = 0;
      while (offset < data.length) { const { bytesRead } = await file.read(data, offset, data.length - offset, offset); if (!bytesRead) throw new AiError('SOURCE_CHANGED'); offset += bytesRead; }
      const after = await file.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || hash(data) !== expectedHash) throw new AiError('SOURCE_CHANGED'); return data;
    } finally { await file.close(); }
  }
  private async verify(version: ImageVersion): Promise<void> { await this.bytes(version.originalPath, version.sha256, version.byteSize); await this.bytes(version.previewPath, version.previewSha256, version.previewByteSize); }
  private async verifyAssetDirectory(): Promise<void> {
    for (const path of [resolve(this.root), resolve(this.root, 'assets')]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(await realpath(path)) !== canonical(path)) throw new AiError('SOURCE_CHANGED');
    }
  }
  async preview(rawId: string): Promise<string> {
    this.ensureOpen(); const version = this.records.get('image_versions', rawId, validateImageVersion); if (!version) throw new AiError('INVALID_INPUT');
    return `data:image/png;base64,${(await this.bytes(version.previewPath, version.previewSha256, version.previewByteSize)).toString('base64')}`;
  }
  async save(raw: unknown): Promise<ImageVersion> {
    this.ensureOpen(); const o = keys(raw, ['productId','productRevision','resultId']);
    const productId = uuid(o.productId), revision = integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), resultId = uuid(o.resultId);
    const result = this.result(productId, revision, resultId), key = `${productId}:${resultId}`;
    if (this.operations.has(key)) return this.operations.get(key)!.promise;
    if (this.operations.size >= 2) throw new AiError('BUSY');
    const controller = new AbortController(), signal = controller.signal, timer = setTimeout(() => controller.abort(new AiError('TIMEOUT')), this.dependencies.timeoutMs ?? 60000);
    const work = Promise.resolve().then(async () => {
      const asset = this.source(productId, revision, result.assetId!), fresh = async () => {
        throwIfAborted(signal); if (JSON.stringify(this.result(productId, revision, resultId)) !== JSON.stringify(result)) throw new AiError('SOURCE_CHANGED');
        await readManagedImage(this.root, asset, signal); throwIfAborted(signal);
        if (JSON.stringify(this.result(productId, revision, resultId)) !== JSON.stringify(result)) throw new AiError('SOURCE_CHANGED');
      };
      await fresh(); const existing = this.list(productId).find(v => v.resultId === resultId);
      if (existing) { await this.verify(existing); await fresh(); return existing; }
      const bytes = await abortable(this.download((result.output as { imageUrl: string }).imageUrl, signal), signal); throwIfAborted(signal);
      if (bytes.length < 1 || bytes.length > 20 * 1024 * 1024) throw new AiError('IMAGE_INVALID');
      const raster = inspectRaster(bytes); if (raster.mimeType !== 'image/png' || raster.width !== asset.width || raster.height !== asset.height) throw new AiError('IMAGE_INVALID');
      let decoded: DecodedArtifact; try { decoded = this.dependencies.decode(bytes); } catch { throw new AiError('IMAGE_INVALID'); }
      if (decoded.width !== asset.width || decoded.height !== asset.height || !Buffer.isBuffer(decoded.preview)) throw new AiError('IMAGE_INVALID');
      const id = randomUUID(), candidate = validateImageVersion({ id, productId, productRevision: revision, sourceAssetId: asset.id, sourceSha256: asset.sha256, resultId,
        version: 1, width: decoded.width, height: decoded.height, byteSize: bytes.length, sha256: hash(bytes), originalPath: `assets/${id}.png`, previewPath: `assets/${id}.preview.png`, previewSha256: hash(decoded.preview), previewByteSize: decoded.preview.length,
        createdAt: new Date().toISOString(), reviewState: 'unreviewed', checks: { transparentPixels: decoded.transparentPixels, subjectPixels: decoded.subjectPixels } });
      let version: ImageVersion | undefined;
      try {
        await fresh(); await mkdir(join(this.root, 'assets'), { recursive: true });
        await this.verifyAssetDirectory();
        version = this.recovery.begin(candidate); await this.checkpoint('intent', version);
        for (const [path, contents] of [[version.originalPath, bytes], [version.previewPath, decoded.preview]] as const) {
          await this.verifyAssetDirectory();
          throwIfAborted(signal); const destination = managedAssetPath(this.root, path), file = await open(destination, 'wx');
          try {
            await this.verifyAssetDirectory();
            const opened = await file.stat(), atPath = await lstat(destination);
            if (!opened.isFile() || opened.nlink !== 1 || !atPath.isFile() || atPath.isSymbolicLink() || opened.dev !== atPath.dev || opened.ino !== atPath.ino
              || canonical(await realpath(destination)) !== canonical(resolve(destination))) throw new AiError('SOURCE_CHANGED');
            await file.writeFile(contents); await file.sync();
          } finally { await file.close(); }
          await this.checkpoint(path === version.originalPath ? 'original-written' : 'preview-written', version);
        }
        await this.verify(version); await fresh(); this.ensureOpen();
        this.recovery.commit(version); await this.checkpoint('committed', version); return version;
      } catch (error) {
        if (version) try { this.recovery.recoverOne(version.id); } catch { /* Keep the durable intent when SQLite cannot record recovery; retry on restart. */ }
        throw error;
      }
    }).finally(() => { clearTimeout(timer); this.operations.delete(key); });
    this.operations.set(key, { controller, promise: work }); return work;
  }
  async select(raw: unknown): Promise<ImageSelection> {
    this.ensureOpen(); const o = keys(raw, ['productId','productRevision','sourceAssetId','versionId']);
    const productId = uuid(o.productId), revision = integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), sourceAssetId = uuid(o.sourceAssetId), versionId = o.versionId === null ? null : uuid(o.versionId);
    const source = this.source(productId, revision, sourceAssetId); await readManagedImage(this.root, source, new AbortController().signal);
    if (versionId) { const version = this.records.get('image_versions', versionId, validateImageVersion); if (!version || version.productId !== productId || version.sourceAssetId !== source.id || version.sourceSha256 !== source.sha256) throw new AiError('SOURCE_CHANGED'); await this.verify(version); }
    await readManagedImage(this.root, source, new AbortController().signal);
    this.ensureOpen(); if (this.source(productId, revision, sourceAssetId).sha256 !== source.sha256) throw new AiError('SOURCE_CHANGED');
    const selection = validateImageSelection({ id: randomUUID(), productId, sourceAssetId, sourceSha256: source.sha256, versionId, selectedAt: new Date().toISOString(), reviewState: 'human-selected' });
    this.db.prepare('INSERT INTO image_selections VALUES(?,?)').run(selection.id, JSON.stringify(selection)); return selection;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.closed = true;
    this.closing = (async () => { for (const work of this.operations.values()) work.controller.abort(new AiError('CANCELLED')); await Promise.allSettled([...this.operations.values()].map(w => w.promise)); this.db.close(); })(); return this.closing;
  }
}
