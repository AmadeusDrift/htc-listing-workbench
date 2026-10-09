import type { AmazonTarget, JsonObject } from '../../shared/amazon-contracts.ts';
import type { AcceptedAmazonSku, ProductDataJob, ProductDataObservation, ProductDataRow, ProductDataScope, ProductDataSnapshot, ProductInventoryData, ProductListingData } from '../../shared/product-data-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { ProductDataCache } from './cache.ts';
import { inventoryPage, listingsPage, object, pageToken, ProductDataFormatError, salesMetrics, salesWindows } from './normalize.ts';
import { currentLocalRow, dataScope, rowIdentity, scopeIdentity, trackProducts } from './tracking.ts';
import type { ProductDataStore } from './tracking.ts';

export interface ProductDataAmazon {
  executionTargetScope(targetId: string): { target: AmazonTarget; generation: number };
  listAcceptedSkus(targetId: string): AcceptedAmazonSku[];
  readProductData(targetId: string, kind: 'listings' | 'inventory' | 'sales', query: Record<string, string>, beforeSend?: () => void): Promise<{ data: JsonObject; status: number; requestId: string | null }>;
}
export interface ProductDataDependencies { now?: () => number }
interface Entry { snapshot: ProductDataSnapshot; run?: Run }
interface Run { entry: Entry; scope: ProductDataScope; end: number; cancelled: boolean }
class Cancelled extends Error {}
const SALES_TTL = 6 * 3_600_000;
function idle(): ProductDataJob { return { state: 'idle', phase: 'idle', completed: 0, total: 0, errors: 0, startedAt: null, finishedAt: null, message: null }; }
function chunks<T>(values: T[], size: number): T[][] { const result: T[][] = []; for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size)); return result; }
function failure(error: unknown): { message: string; systemic: boolean; forbidden: boolean } {
  if (error instanceof ProductDataFormatError) return { message: 'Amazon 返回的数据缺少所需字段或范围不匹配；保留上次成功数据', systemic: false, forbidden: false };
  const status = object(error) && typeof error.status === 'number' && Number.isInteger(error.status) ? error.status : null;
  if (status === 401 || status === 403) return { message: `Amazon 数据读取权限不足（HTTP ${status}），请检查该接口授权`, systemic: true, forbidden: true };
  if (status === 429) return { message: 'Amazon 数据读取已达到请求频率限制，请稍后重试（HTTP 429）', systemic: true, forbidden: false };
  return { message: status ? `Amazon 数据读取失败（HTTP ${status}）；保留上次成功数据` : 'Amazon 数据请求失败或超时；保留上次成功数据',
    systemic: status === null || status >= 500, forbidden: false };
}

export class ProductDataService {
  private store: ProductDataStore;
  private amazon: ProductDataAmazon;
  private now: () => number;
  private cache: ProductDataCache;
  private entries = new Map<string, Entry>();
  private pending = new Set<Run>();
  private closed = false;
  constructor(directory: string, store: ProductDataStore, amazon: ProductDataAmazon, dependencies: ProductDataDependencies = {}) {
    this.store = store; this.amazon = amazon; this.now = dependencies.now ?? Date.now; this.cache = new ProductDataCache(directory);
  }
  /** Includes stopped requests that are still draining, so database restore can wait safely. */
  get busy(): boolean { return this.pending.size > 0; }
  private at(): string { return new Date(this.now()).toISOString(); }
  private ensureOpen(): void { if (this.closed) throw new UserFacingError('商品数据服务已关闭'); }
  private reconcile(entry: Entry): void {
    const previous = new Map(entry.snapshot.rows.map(row => [rowIdentity(row), row]));
    entry.snapshot.rows = trackProducts(this.store, this.amazon.listAcceptedSkus(entry.snapshot.scope.targetId), entry.snapshot.scope, this.now()).map(row => {
      const prior = previous.get(rowIdentity(row)); if (!prior) return row;
      prior.title = row.title; prior.coverUrl = row.coverUrl; prior.trackingIssue = row.trackingIssue; return prior;
    });
  }
  private entry(targetId: string): Entry {
    this.ensureOpen();
    if (typeof targetId !== 'string' || !targetId || targetId.length > 100) throw new UserFacingError('店铺 ID 无效');
    const { target, generation } = this.amazon.executionTargetScope(targetId); const scope = dataScope(target, generation);
    let entry = this.entries.get(targetId);
    if (!entry || scopeIdentity(entry.snapshot.scope) !== scopeIdentity(scope)) {
      if (entry?.run) this.cancel(entry.run, '店铺配置已变化，已停止旧配置的数据读取');
      const rows = this.cache.read(scope, this.now());
      entry = { snapshot: { scope, rows, job: idle(), updatedAt: null, message: null } }; this.entries.set(targetId, entry);
    }
    this.reconcile(entry);
    entry.snapshot.message = target.mode !== 'live' ? '商品数据只跟踪本软件正式提交的商品，请连接正式店铺'
      : !entry.snapshot.rows.length ? '等待通过本软件首次正式提交商品；不会导入店铺历史商品或销量'
      : !target.configured ? '店铺尚未配置，暂时无法刷新商品数据' : target.paused ? '店铺已暂停，恢复连接后可以刷新商品数据'
      : entry.snapshot.rows.every(row => row.trackingIssue) ? '已提交商品的本地 SKU 对应关系需要处理后才能读取' : null;
    if (entry.run && (target.paused || !target.configured)) this.cancel(entry.run, '店铺连接已暂停或断开，数据读取已停止');
    return entry;
  }
  get(targetId: string): ProductDataSnapshot { return structuredClone(this.entry(targetId).snapshot); }
  start(targetId: string): ProductDataSnapshot {
    const entry = this.entry(targetId); if (entry.run) return structuredClone(entry.snapshot);
    const { target } = this.amazon.executionTargetScope(targetId); const rows = entry.snapshot.rows.filter(row => !row.trackingIssue);
    if (target.mode !== 'live' || !target.configured || target.paused || !rows.length) return structuredClone(entry.snapshot);
    const run: Run = { entry, scope: structuredClone(entry.snapshot.scope), end: this.now(), cancelled: false };
    entry.run = run; this.pending.add(run); entry.snapshot.job = { ...idle(), state: 'running', phase: 'listings',
      total: rows.length * 2 + rows.filter(row => row.listingProgram === 'haul').length, startedAt: this.at() };
    // Defer even the first read so IPC always receives an immediate running snapshot.
    setImmediate(() => { void this.execute(run, rows).finally(() => { this.pending.delete(run); }); });
    return structuredClone(entry.snapshot);
  }
  stop(targetId: string): ProductDataSnapshot {
    const entry = this.entry(targetId); if (entry.run) this.cancel(entry.run, '已停止后续读取；正在返回的请求将被丢弃');
    return structuredClone(entry.snapshot);
  }
  close(): void {
    if (this.closed) return;
    for (const entry of this.entries.values()) if (entry.run) this.cancel(entry.run, '软件正在关闭，已停止数据读取');
    this.closed = true;
  }
  private cancel(run: Run, message: string): void {
    run.cancelled = true;
    if (run.entry.run !== run) return;
    run.entry.run = undefined; Object.assign(run.entry.snapshot.job, { state: 'stopped', phase: 'idle', finishedAt: this.at(), message });
    if (!this.closed) this.cache.write(run.scope, run.entry.snapshot.rows);
  }
  private assertCurrent(run: Run): void {
    if (this.closed || run.cancelled || run.entry.run !== run) throw new Cancelled();
    let actual: { target: AmazonTarget; generation: number };
    try { actual = this.amazon.executionTargetScope(run.scope.targetId); } catch { this.cancel(run, '店铺已断开，数据读取已停止'); throw new Cancelled(); }
    if (scopeIdentity(dataScope(actual.target, actual.generation)) !== scopeIdentity(run.scope) || actual.target.paused || !actual.target.configured) {
      this.cancel(run, '店铺配置已变化，已停止旧配置的数据读取'); throw new Cancelled();
    }
  }
  private usable(run: Run, row: ProductDataRow): boolean {
    return run.entry.snapshot.rows.includes(row) && currentLocalRow(this.store, row);
  }
  private async read(run: Run, kind: 'listings' | 'inventory' | 'sales', query: Record<string, string>): Promise<JsonObject> {
    this.assertCurrent(run); const result = await this.amazon.readProductData(run.scope.targetId, kind, query, () => this.assertCurrent(run)); this.assertCurrent(run);
    if (result.status < 200 || result.status >= 300) throw { status: result.status };
    return result.data;
  }
  private success<T>(metric: ProductDataObservation<T>, value: T | null, missingMessage: string): void {
    const at = this.at(); Object.assign(metric, { value, status: value === null ? 'missing' : 'ok', fetchedAt: at, attemptedAt: at, error: value === null ? missingMessage : null });
  }
  private failed(metric: ProductDataObservation<unknown>, message: string): void { Object.assign(metric, { status: 'error', attemptedAt: this.at(), error: message }); }
  private completed(run: Run, count: number): void { run.entry.snapshot.job.completed += count; run.entry.snapshot.updatedAt = this.at(); }
  private persist(run: Run): void { this.assertCurrent(run); this.cache.write(run.scope, run.entry.snapshot.rows); }
  private async batch(run: Run, kind: 'listings' | 'inventory', group: ProductDataRow[]): Promise<void> {
    this.assertCurrent(run); const rows = group.filter(row => this.usable(run, row));
    if (!rows.length) { this.completed(run, group.length); return; }
    const allowed = new Set(rows.map(row => row.sku)); const query: Record<string, string> = kind === 'listings'
      ? { marketplaceIds: run.scope.marketplaceId, identifiersType: 'SKU', identifiers: [...allowed].join(','), includedData: 'summaries,attributes,issues', pageSize: '20' }
      : { marketplaceIds: run.scope.marketplaceId, granularityType: 'Marketplace', granularityId: run.scope.marketplaceId, details: 'true',
        ...(rows.length === 1 && rows[0].sku.includes(',') ? { sellerSku: rows[0].sku } : { sellerSkus: [...allowed].join(',') }) };
    const found = new Map<string, ProductListingData | ProductInventoryData>(); const seenTokens = new Set<string>(); let token: string | null = null;
    for (let page = 0; page < 100; page++) {
      if (rows.some(row => !this.usable(run, row))) throw new ProductDataFormatError('分页期间本地 SKU 对应关系已变化');
      const data = await this.read(run, kind, { ...query, ...(token ? { [kind === 'listings' ? 'pageToken' : 'nextToken']: token } : {}) });
      const values = kind === 'listings' ? listingsPage(data, allowed, run.scope.marketplaceId) : inventoryPage(data, allowed, run.scope.marketplaceId);
      for (const [sku, value] of values) found.set(sku, value);
      token = pageToken(data); if (!token) break;
      if (seenTokens.has(token) || page === 99) throw new ProductDataFormatError('分页未能结束'); seenTokens.add(token);
    }
    this.assertCurrent(run);
    for (const row of rows) if (this.usable(run, row)) {
      if (kind === 'listings') this.success(row.listing, found.get(row.sku) as ProductListingData | undefined ?? null, 'Amazon 未返回该 SKU 在当前站点的商品状态');
      else this.success(row.inventory, found.get(row.sku) as ProductInventoryData | undefined ?? null, 'Amazon 未返回该 SKU 的库存记录，数量未知');
    }
    this.completed(run, group.length);
  }
  private async batches(run: Run, kind: 'listings' | 'inventory', rows: ProductDataRow[]): Promise<void> {
    run.entry.snapshot.job.phase = kind;
    const ordinary = rows.filter(row => !row.sku.includes(',')); const comma = rows.filter(row => row.sku.includes(','));
    const groups = [...chunks(ordinary, kind === 'listings' ? 20 : 50), ...comma.map(row => [row])];
    let consecutive = 0; let halted: string | null = null;
    for (const group of groups) {
      this.assertCurrent(run);
      try {
        if (halted) throw new ProductDataFormatError(halted);
        if (kind === 'listings' && group.some(row => row.sku.includes(','))) throw new ProductDataFormatError('含逗号的 SKU 无法安全用于商品状态批量查询');
        await this.batch(run, kind, group); consecutive = 0;
      } catch (error) {
        this.assertCurrent(run); const issue = failure(error); if (issue.systemic) consecutive++; else consecutive = 0;
        const message = halted ?? (kind === 'listings' && group.some(row => row.sku.includes(',')) ? '含逗号的 SKU 暂不支持商品状态批量读取；库存和销量仍可读取' : issue.message);
        for (const row of group) if (this.usable(run, row)) this.failed(kind === 'listings' ? row.listing : row.inventory, message);
        run.entry.snapshot.job.errors += group.length; this.completed(run, group.length);
        if (issue.forbidden || consecutive >= 3) halted = '此接口连续读取失败，已停止该接口的后续请求；保留上次成功数据';
      }
    }
    this.persist(run);
  }
  private async sales(run: Run, rows: ProductDataRow[]): Promise<void> {
    run.entry.snapshot.job.phase = 'sales'; let consecutive = 0; let halted: string | null = null;
    for (const row of rows.filter(row => row.listingProgram === 'haul')) {
      this.assertCurrent(run); if (!this.usable(run, row)) { this.completed(run, 1); continue; }
      const metric = row.sales; const fetched = metric.fetchedAt ? Date.parse(metric.fetchedAt) : NaN;
      if (metric.status === 'ok' && metric.value
        && run.end >= fetched && run.end - fetched < SALES_TTL && metric.value.windowEnd.slice(0, 10) === new Date(run.end).toISOString().slice(0, 10)) {
        this.completed(run, 1); continue;
      }
      try {
        if (halted) throw new ProductDataFormatError(halted);
        const windows = salesWindows(row.salesSince, run.end);
        if (windows.window30dStart >= windows.windowEnd) throw new ProductDataFormatError('正式提交后的统计时间尚不足');
        const data = await this.read(run, 'sales', { marketplaceIds: run.scope.marketplaceId, sku: row.sku, amazonProgram: 'AmazonHaul', granularity: 'Day',
          granularityTimeZone: 'UTC', interval: `${windows.window30dStart}--${windows.windowEnd}` });
        if (this.usable(run, row)) this.success(metric, salesMetrics(data, windows), 'Amazon 未返回销量数据'); consecutive = 0;
      } catch (error) {
        this.assertCurrent(run); const issue = failure(error); if (issue.systemic) consecutive++; else consecutive = 0;
        if (this.usable(run, row)) this.failed(metric, halted ?? issue.message); run.entry.snapshot.job.errors++;
        if (issue.forbidden || consecutive >= 3) halted = '销量接口连续读取失败，已停止后续 SKU 请求；保留上次成功数据';
      }
      this.completed(run, 1);
    }
    this.persist(run);
  }
  private async execute(run: Run, rows: ProductDataRow[]): Promise<void> {
    try {
      this.assertCurrent(run); await this.batches(run, 'listings', rows); await this.batches(run, 'inventory', rows); await this.sales(run, rows);
      this.assertCurrent(run); const job = run.entry.snapshot.job;
      Object.assign(job, { state: 'completed', phase: 'idle', finishedAt: this.at(), message: job.errors ? '读取已结束，部分接口失败；请查看对应字段的错误和上次成功时间' : '商品数据读取完成' });
      run.entry.run = undefined;
    } catch (error) {
      if (error instanceof Cancelled || this.closed || run.cancelled || run.entry.run !== run) return;
      Object.assign(run.entry.snapshot.job, { state: 'failed', phase: 'idle', finishedAt: this.at(), message: failure(error).message }); run.entry.run = undefined;
    }
  }
}
