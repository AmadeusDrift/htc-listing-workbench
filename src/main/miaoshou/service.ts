import { randomUUID } from 'node:crypto';
import { readSourceAdoption, previewSourceAdoption, adoptSource } from '../products/public.ts';
import { readSourceSnapshot } from './source-snapshots.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { SecretStorage } from '../amazon/vault.ts';
import { openDatabase } from '../database.ts';
import type { WorkspaceStore } from '../store.ts';
import type { MiaoshouImportResult, MiaoshouList, MiaoshouMapping, MiaoshouMode, MiaoshouPreview, MiaoshouProduct, MiaoshouReceipt, MiaoshouStatus } from '../../shared/miaoshou-contracts.ts';
import { demoDetail, demoList } from './demo.ts';
import { normalizeDetail, normalizeList } from './normalize.ts';
import type { TextSanitizer } from './normalize.ts';
import { getReceipt, persistImport, assertMiaoshouFactHistory } from './persistence.ts';
import { MIAOSHOU_ENDPOINT, readMiaoshou } from './protocol.ts';
import { MiaoshouReadScheduler } from './rate-limit.ts';
import type { MiaoshouRateClock } from './rate-limit.ts';
import { MiaoshouVault, parseCredentials, redactCredentials } from './vault.ts';
import type { MiaoshouCredentials } from './vault.ts';
import { exact, fail, hash, MiaoshouError, parseMapping, remoteId, timestamp, uuid, validateMiaoshouReceipt } from './validation.ts';
import { MiaoshouSync } from './sync.ts';
import { syncPageSize } from './sync-records.ts';
import type { SyncScope } from './sync-records.ts';
import { syncItemId, syncScopeId, validateSyncItem } from './sync-records.ts';
import type { MiaoshouSyncStatus } from '../../shared/miaoshou-sync-contracts.ts';
import { MiaoshouPreferenceStore } from './preferences.ts';
import { automaticMiaoshouMapping, inboxSummary } from '../../shared/inbox-summary.ts';

export { MIAOSHOU_CONFIG_TEMPLATE } from './vault.ts';
export interface MiaoshouDependencies { fetch?: typeof fetch; now?: () => Date; timeoutMs?: number; rateLimitClock?: MiaoshouRateClock }
interface TrustedPreview { product: MiaoshouProduct; generation: number; mode: 'demo' | 'live'; accountScope: string; expires: number; synced?: boolean }
interface RequestResult<T> { value: T; generation: number; mode: 'demo' | 'live'; accountScope: string }
const PREVIEW_TTL = 15 * 60_000;

export class MiaoshouService {
  private store: WorkspaceStore;
  private vault: MiaoshouVault;
  private db: DatabaseSync;
  private transport: typeof fetch;
  private now: () => Date;
  private timeoutMs: number;
  private readScheduler: MiaoshouReadScheduler;
  private sync: MiaoshouSync;
  private mode: MiaoshouMode;
  private credentials: MiaoshouCredentials | null;
  private generation = 0;
  private previews = new Map<string, TrustedPreview>();
  private active = new Set<AbortController>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  private preferences: MiaoshouPreferenceStore;
  private inboxStart?: Promise<MiaoshouSyncStatus | null>;
  constructor(directory: string, store: WorkspaceStore, storage: SecretStorage, dependencies: MiaoshouDependencies = {}) {
    this.readScheduler = new MiaoshouReadScheduler(dependencies.rateLimitClock);
    this.timeoutMs = dependencies.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120000) throw new MiaoshouError('INPUT');
    this.store = store; this.preferences = new MiaoshouPreferenceStore(directory); this.vault = new MiaoshouVault(directory, storage); const loaded = this.vault.load(); this.mode = loaded.mode; this.credentials = loaded.credentials;
    this.transport = dependencies.fetch ?? globalThis.fetch; this.now = dependencies.now ?? (() => new Date()); this.db = openDatabase(directory);
    this.sync = new MiaoshouSync(this.db, { scope: () => this.syncScope(), now: () => this.date().toISOString(),
      importProduct: (product, scope) => {
        const current = this.syncScope(); if (current.accountScope !== scope.accountScope || current.mode !== scope.mode) return fail('CHANGED');
        return this.persistProduct(product, automaticMiaoshouMapping(product), scope).duplicate ? 'existing' : 'added';
      },
      list: async (pageNo, pageSize, signal) => (await this.request('list', { pageNo, pageSize }, (raw, mode, sanitize) => normalizeList(raw, pageNo, pageSize, mode, sanitize, true), signal)).value,
      detail: async (id, signal) => { const result = await this.request('detail', { commonCollectBoxDetailId: id }, (raw, mode, sanitize) => normalizeDetail(raw, this.date().toISOString(), mode, sanitize), signal); if (result.value.remoteId !== id) return fail('RESPONSE'); return result.value; } });
  }
  private ensureOpen(): void { if (this.closed) fail('CLOSED'); }
  private date(): Date { const now = this.now(); timestamp(now.toISOString()); return now; }
  get busy(): boolean { return this.active.size > 0 || this.sync.running; }
  getStatus(): MiaoshouStatus {
    this.ensureOpen(); return { mode: this.mode, configured: this.credentials !== null, appKeyHint: this.credentials ? `****${this.credentials.appKey.slice(-4)}` : '', endpoint: MIAOSHOU_ENDPOINT };
  }
  private invalidate(reason: 'CHANGED' | 'CLOSED' = 'CHANGED'): void {
    this.sync.pauseActive();
    this.generation++; this.previews.clear(); for (const controller of this.active) controller.abort(new MiaoshouError(reason));
  }
  importConfig(raw: unknown): MiaoshouStatus {
    this.ensureOpen(); const credentials = parseCredentials(raw); this.vault.write(credentials);
    this.credentials = credentials; this.mode = 'live'; this.invalidate(); return this.getStatus();
  }
  setMode(raw: unknown): MiaoshouStatus {
    this.ensureOpen(); if (raw !== 'demo' && raw !== 'live') return fail('INPUT'); if (raw === 'live' && !this.credentials) return fail('NOT_CONFIGURED');
    if (this.mode !== raw) { this.vault.setMode(raw); this.mode = raw; this.invalidate(); } return this.getStatus();
  }
  disconnect(): MiaoshouStatus {
    this.ensureOpen(); this.invalidate(); this.credentials = null; this.mode = 'unconfigured'; this.vault.disconnect(); return this.getStatus();
  }
  private assertGeneration(generation: number): void { this.ensureOpen(); if (generation !== this.generation) fail('CHANGED'); }
  private request<T>(operation: 'list' | 'detail', body: Record<string, unknown>, parse: (raw: unknown, mode: 'demo' | 'live', sanitize: TextSanitizer) => T, signal?: AbortSignal): Promise<RequestResult<T>> {
    this.ensureOpen(); if (this.mode === 'unconfigured' || this.mode === 'live' && !this.credentials) return Promise.reject(new MiaoshouError('NOT_CONFIGURED'));
    if (this.active.size >= 100) return Promise.reject(new MiaoshouError('BUSY'));
    const generation = this.generation, mode = this.mode, credentials = this.credentials;
    const accountScope = mode === 'demo' ? hash('miaoshou-demo-v1') : hash(credentials!.appKey), controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new MiaoshouError('CHANGED'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    const perform = async () => {
      this.assertGeneration(generation);
      const timeout = setTimeout(() => controller.abort(new MiaoshouError('TIMEOUT')), this.timeoutMs);
      try {
        const raw = mode === 'demo' ? operation === 'list' ? demoList(Number(body.pageNo), Number(body.pageSize)) : demoDetail(String(body.commonCollectBoxDetailId))
          : await readMiaoshou(operation, body, credentials!, this.transport, this.date(), controller.signal);
        this.assertGeneration(generation); if (controller.signal.aborted) throw controller.signal.reason;
        const sanitize: TextSanitizer = value => mode === 'live' ? redactCredentials(value, credentials!) : value;
        const value = parse(raw, mode, sanitize); this.assertGeneration(generation);
        // Fail closed if any future normalization introduces a credential after the text boundary.
        // Do not mutate a validated snapshot here: that could break URL-derived IDs and mappings.
        if (mode === 'live' && JSON.stringify(redactCredentials(value, credentials!)) !== JSON.stringify(value)) return fail('RESPONSE');
        return { value, generation, mode, accountScope };
      } catch (error) { if (error instanceof MiaoshouError) throw error; return fail('RESPONSE'); }
      finally { clearTimeout(timeout); }
    };
    // Only actual transport attempts consume the timeout; waiting in the queue or backoff does not.
    const task = (mode === 'demo' ? perform() : this.readScheduler.run(perform, controller.signal))
      .finally(() => { this.active.delete(controller); signal?.removeEventListener('abort', abort); });
    this.pending.add(task); task.then(() => this.pending.delete(task), () => this.pending.delete(task)); return task;
  }
  async listProducts(raw: unknown): Promise<MiaoshouList> {
    const input = exact(raw, ['pageNo', 'pageSize'], 'INPUT');
    if (!Number.isSafeInteger(input.pageNo) || Number(input.pageNo) < 1) return fail('INPUT');
    const pageNo = Number(input.pageNo), pageSize = syncPageSize(input.pageSize);
    const result = await this.request('list', { pageNo, pageSize }, (raw, mode, sanitize) => normalizeList(raw, pageNo, pageSize, mode, sanitize)); this.assertGeneration(result.generation); return result.value;
  }
  async previewProduct(raw: unknown): Promise<MiaoshouPreview> {
    const input = exact(raw, ['id'], 'INPUT'), id = remoteId(input.id);
    const result = await this.request('detail', { commonCollectBoxDetailId: id }, (raw, mode, sanitize) => normalizeDetail(raw, this.date().toISOString(), mode, sanitize));
    this.assertGeneration(result.generation); if (result.value.remoteId !== id) return fail('RESPONSE');
    const date = this.date(), expires = date.getTime() + PREVIEW_TTL, previewId = randomUUID(); this.prune(date.getTime());
    while (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(previewId, { product: structuredClone(result.value), generation: result.generation, accountScope: result.accountScope, mode: result.mode, expires });
    return { previewId, mode: result.mode, expiresAt: new Date(expires).toISOString(), product: structuredClone(result.value) };
  }
  private prune(now: number): void { for (const [id, preview] of this.previews) if (preview.expires <= now) this.previews.delete(id); }
  importProduct(raw: unknown): MiaoshouImportResult {
    this.ensureOpen(); const input = exact(raw, ['previewId', 'mapping'], 'INPUT'), previewId = uuid(input.previewId); this.prune(this.date().getTime());
    const preview = this.previews.get(previewId); if (!preview || preview.generation !== this.generation || preview.mode !== this.mode) return fail('PREVIEW');
    const mapping = parseMapping(input.mapping, preview.product);
    return this.persistProduct(preview.product, mapping, preview);
  }
  private persistProduct(product: MiaoshouProduct, mapping: MiaoshouMapping, scope: SyncScope): MiaoshouImportResult {
    const current = this.syncScope(); if (current.accountScope !== scope.accountScope || current.mode !== scope.mode) return fail('CHANGED');
    // All public and cached/sync imports share this trusted, synchronous pre-write guard.
    // Credentials stay in the service closure and never become receipt/audit fields.
    return persistImport(this.db, this.store, product, mapping, scope.accountScope, scope.mode, this.date().toISOString(), value => {
      if (scope.mode === 'live' && JSON.stringify(redactCredentials(value, this.credentials!)) !== JSON.stringify(value)) fail('RESPONSE');
    });
  }
  private syncScope(): SyncScope { this.ensureOpen(); if (this.mode === 'unconfigured' || this.mode === 'live' && !this.credentials) return fail('NOT_CONFIGURED'); return { mode: this.mode, accountScope: this.mode === 'demo' ? hash('miaoshou-demo-v1') : hash(this.credentials!.appKey) }; }
  private existingImport(id: string, scope: SyncScope): MiaoshouReceipt | null {
    const row = this.db.prepare("SELECT record_json FROM miaoshou_receipts WHERE json_extract(record_json,'$.accountScope')=? AND json_extract(record_json,'$.mode')=? AND json_extract(record_json,'$.snapshot.remoteId')=? ORDER BY rowid LIMIT 1").get(scope.accountScope, scope.mode, id);
    if (!row) return null; const receipt = validateMiaoshouReceipt(JSON.parse(String(row.record_json))); assertMiaoshouFactHistory(this.db, receipt); this.store.getProduct(receipt.productId); return receipt;
  }
  getSyncStatus() { return this.sync.status(); }
  getPreferences() { this.ensureOpen(); return this.preferences.get(); }
  savePreferences(raw: unknown) { this.ensureOpen(); return this.preferences.save(raw); }
  async syncInbox(raw: unknown): Promise<MiaoshouSyncStatus | null> {
    this.ensureOpen(); const input = exact(raw, ['trigger'], 'INPUT');
    if (typeof input.trigger !== 'string' || !['manual', 'enter', 'resume', 'retry'].includes(input.trigger)) return fail('INPUT');
    if (input.trigger === 'enter' && (!(await this.preferences.get()).autoSyncOnInbox || this.mode === 'unconfigured')) return null;
    this.ensureOpen(); if (this.inboxStart) return this.inboxStart;
    const operation = (async () => {
      const state = this.getSyncStatus();
      if (state.status === 'running') return this.sync.enableInboxImport();
      if (input.trigger === 'resume' || input.trigger === 'retry') return this.sync.resume(input.trigger === 'retry', true);
      if (state.status === 'paused' && input.trigger === 'enter') return state;
      if (state.status === 'paused') return this.sync.resume(false, true);
      return this.sync.start({ pageSize: 500 }, true);
    })();
    this.inboxStart = operation;
    try { return await operation; } finally { if (this.inboxStart === operation) this.inboxStart = undefined; }
  }
  inboxSummaries(raw: unknown) {
    this.ensureOpen(); const input = exact(raw, ['productIds'], 'INPUT');
    if (!Array.isArray(input.productIds) || input.productIds.length > 50 || new Set(input.productIds).size !== input.productIds.length) return fail('INPUT');
    return input.productIds.map(rawId => {
      const id = uuid(rawId), product = this.store.getProduct(id), receipt = this.getReceipt(id);
      let updated = false;
      if (receipt) updated = this.sourceUpdate(receipt) !== null;
      return inboxSummary(product, receipt, updated);
    });
  }
  private sourceUpdate(receipt: MiaoshouReceipt): MiaoshouProduct | null {
    const adopted=readSourceAdoption(this.db,receipt.productId);
    if(adopted&&adopted.latestSnapshotId!==adopted.adoptedSnapshotId)return readSourceSnapshot(this.db,adopted.latestSnapshotId)!.receipt.snapshot;
    const row = this.db.prepare('SELECT record_json FROM miaoshou_sync_items WHERE id=?').get(syncItemId(syncScopeId(receipt), receipt.snapshot.remoteId));
    const snapshot = row ? validateSyncItem(JSON.parse(String(row.record_json))).snapshot : null;
    const content = ({ capturedAt: _capturedAt, ...value }: MiaoshouProduct) => JSON.stringify(value);
    return snapshot && content(snapshot) !== content(receipt.snapshot) ? snapshot : null;
  }
  getSourceUpdate(rawId: unknown): MiaoshouProduct | null {
    this.ensureOpen(); const id = uuid(rawId); this.store.getProduct(id);
    const receipt = this.getReceipt(id); return receipt ? this.sourceUpdate(receipt) : null;
  }
  previewSourceAdoption(rawId:unknown){this.ensureOpen();return previewSourceAdoption(this.db,uuid(rawId));}
  adoptSource(raw:unknown){
    this.ensureOpen();const input=exact(raw,['productId','expectedRevision','snapshotId','confirmReplaceManual'],'INPUT');
    if(!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<1||typeof input.snapshotId!=='string'||!/^[a-f0-9]{64}$/.test(input.snapshotId)||typeof input.confirmReplaceManual!=='boolean')return fail('INPUT');
    adoptSource(this.db,{productId:uuid(input.productId),expectedRevision:Number(input.expectedRevision),snapshotId:input.snapshotId,confirmReplaceManual:input.confirmReplaceManual});
    return this.store.getProduct(String(input.productId));
  }
  startSync(raw: unknown) { return this.sync.start(raw); }
  pauseSync() { return this.sync.pause(); }
  resumeSync() { return this.sync.resume(); }
  retrySyncFailures() { return this.sync.resume(true); }
  listSyncItems(raw: unknown) { return this.sync.items(raw); }
  previewSyncedProduct(raw: unknown): MiaoshouPreview {
    const scope = this.syncScope(), product = this.sync.cached(raw), date = this.date(), expires = date.getTime() + PREVIEW_TTL, previewId = randomUUID(); this.prune(date.getTime());
    while (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(previewId, { product, generation: this.generation, ...scope, expires, synced: true });
    const existing = this.existingImport(product.remoteId, scope);
    return { previewId, mode: scope.mode, expiresAt: new Date(expires).toISOString(), product: structuredClone(product), ...(existing ? { existingProductId: existing.productId } : {}) };
  }
  getReceipt(productId: unknown): MiaoshouReceipt | null { this.ensureOpen(); return getReceipt(this.db, productId); }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.closed = true; this.invalidate('CLOSED'); this.credentials = null;
    this.closing = (async () => { await this.sync.close(); await Promise.allSettled([...this.pending]); this.db.close(); })(); return this.closing;
  }
}
