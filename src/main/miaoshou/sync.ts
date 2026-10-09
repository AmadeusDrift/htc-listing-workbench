import type { DatabaseSync } from 'node:sqlite';
import type { MiaoshouList, MiaoshouProduct } from '../../shared/miaoshou-contracts.ts';
import type { MiaoshouSyncPage, MiaoshouSyncStatus } from '../../shared/miaoshou-sync-contracts.ts';
import { exact, fail, MiaoshouError, remoteId } from './validation.ts';
import { syncInteger, syncItemId, syncPageSize, syncScopeId, validateSyncItem, validateSyncRun } from './sync-records.ts';
import type { SyncItem, SyncRun, SyncScope } from './sync-records.ts';

interface Dependencies {
  scope(): SyncScope; now(): string;
  importProduct?(product: MiaoshouProduct, scope: SyncScope): 'added' | 'existing';
  list(page: number, size: number, signal: AbortSignal): Promise<MiaoshouList>;
  detail(id: string, signal: AbortSignal): Promise<MiaoshouProduct>;
}
const scopeWhere = "json_extract(record_json,'$.scopeId')=? AND json_extract(record_json,'$.cycle')=?";
const stateWhere = (state: string) => `json_extract(record_json,'$.status')='${state}'`;
export class MiaoshouSync {
  private db: DatabaseSync;
  private deps: Dependencies;
  private active?: { run: SyncRun; controller: AbortController; done: Promise<void> };
  private failedCheckpoint?: string;
  constructor(db: DatabaseSync, deps: Dependencies) {
    this.db = db; this.deps = deps;
    // An interrupted process never silently resumes network activity.
    for (const row of db.prepare(`SELECT record_json FROM miaoshou_sync_runs WHERE ${stateWhere('running')}`).all()) {
      const run = validateSyncRun(JSON.parse(String(row.record_json))); this.saveRun({ ...run, status: 'paused', errorCode: null });
    }
  }
  get running(): boolean { return this.active !== undefined && !this.active.controller.signal.aborted; }
  private run(id = syncScopeId(this.deps.scope())): SyncRun | null {
    const row = this.db.prepare('SELECT record_json FROM miaoshou_sync_runs WHERE id=?').get(id); if (!row) return null;
    const run = validateSyncRun(JSON.parse(String(row.record_json)));
    return id === this.failedCheckpoint ? { ...run, status: 'paused', errorCode: 'STORAGE' } : run;
  }
  private item(id: string): SyncItem | null { const row = this.db.prepare('SELECT record_json FROM miaoshou_sync_items WHERE id=?').get(id); return row ? validateSyncItem(JSON.parse(String(row.record_json))) : null; }
  private saveRun(run: SyncRun): void { const parsed = validateSyncRun(run); this.db.prepare('INSERT INTO miaoshou_sync_runs(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(parsed.id, JSON.stringify(parsed)); if (this.failedCheckpoint === run.id) this.failedCheckpoint = undefined; }
  private saveItem(item: SyncItem): void { const parsed = validateSyncItem(item), json = JSON.stringify(parsed); if (Buffer.byteLength(json) > 4 * 1024 * 1024) return fail('TOO_LARGE'); this.db.prepare('INSERT INTO miaoshou_sync_items(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(parsed.id, json); }
  status(): MiaoshouSyncStatus {
    const run = this.run();
    if (!run) return { status: 'idle', stage: 'listing', pageSize: 500, nextPage: 1, remoteTotal: null, discovered: 0, ready: 0, skipped: 0, failed: 0, pending: 0, skuCount: 0, updatedAt: null, lastError: null };
    const counts = this.db.prepare(`SELECT COUNT(*) AS total, SUM(${stateWhere('ready')}) AS ready, SUM(${stateWhere('unchanged')}) AS skipped, SUM(${stateWhere('failed')}) AS failed, SUM(${stateWhere('pending')}) AS pending, SUM(CASE WHEN ${stateWhere('ready')} OR ${stateWhere('unchanged')} THEN json_array_length(record_json,'$.snapshot.skus') ELSE 0 END) AS skus FROM miaoshou_sync_items WHERE ${scopeWhere}`).get(run.id, run.cycle)!;
    return { status: run.status, stage: run.stage, pageSize: run.pageSize, nextPage: run.nextPage, remoteTotal: run.remoteTotal, discovered: Number(counts.total), ready: Number(counts.ready ?? 0), skipped: Number(counts.skipped ?? 0), failed: Number(counts.failed ?? 0), pending: Number(counts.pending ?? 0), skuCount: Number(counts.skus ?? 0), updatedAt: run.updatedAt, lastError: run.errorCode ? new MiaoshouError(run.errorCode).message : null, ...(run.importToInbox ? { importToInbox: true, imported: run.imported ?? 0, existing: run.existing ?? 0 } : {}) };
  }
  items(raw: unknown): MiaoshouSyncPage {
    const input = exact(raw, ['page','pageSize','filter'], 'INPUT'), page = syncInteger(input.page, 1, 1000000), pageSize = syncInteger(input.pageSize, 1, 100);
    if (!['all','pending','ready','unchanged','failed'].includes(String(input.filter))) return fail('INPUT');
    const run = this.run(); if (!run) return { page, pageSize, total: 0, items: [] };
    const where = scopeWhere + (input.filter === 'all' ? '' : ` AND json_extract(record_json,'$.status')=?`), args = input.filter === 'all' ? [run.id, run.cycle] : [run.id, run.cycle, String(input.filter)];
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM miaoshou_sync_items WHERE ${where}`).get(...args)!.n);
    const items = this.db.prepare(`SELECT record_json FROM miaoshou_sync_items WHERE ${where} ORDER BY rowid LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize).map(row => {
      const item = validateSyncItem(JSON.parse(String(row.record_json))); return { remoteId: item.remoteId, title: item.title, remoteModified: item.remoteModified, status: item.status, skuCount: item.snapshot?.skus.length ?? 0, updatedAt: item.updatedAt, error: item.errorCode ? new MiaoshouError(item.errorCode).message : null, ...(item.importResult ? { importResult: item.importResult } : {}) };
    }); return { page, pageSize, total, items };
  }
  cached(raw: unknown): MiaoshouProduct {
    const input = exact(raw, ['id'], 'INPUT'), run = this.run(); if (!run) return fail('PREVIEW');
    const item = this.item(syncItemId(run.id, remoteId(input.id)));
    if (!item || item.cycle !== run.cycle || !['ready','unchanged'].includes(item.status) || !item.snapshot) return fail('PREVIEW');
    return structuredClone(item.snapshot);
  }
  async start(raw: unknown, importToInbox = false): Promise<MiaoshouSyncStatus> {
    const input = exact(raw, ['pageSize'], 'INPUT'), pageSize = syncPageSize(input.pageSize); if (this.running) return fail('BUSY'); await this.active?.done; if (this.running) return fail('BUSY');
    const scope = this.deps.scope(), id = syncScopeId(scope), prior = this.run(id);
    const run: SyncRun = { ...scope, id, cycle: (prior?.cycle ?? 0) + 1, status: 'running', stage: 'listing', nextPage: 1, pageSize, remoteTotal: null, updatedAt: this.deps.now(), errorCode: null, ...(importToInbox ? { importToInbox: true, imported: 0, existing: 0 } : {}) };
    this.saveRun(run); this.launch(run); return this.status();
  }
  pauseActive(): void {
    if (!this.active) return; this.active.controller.abort(new MiaoshouError('CHANGED'));
    const id = this.active.run.id;
    try { const run = this.run(id); if (run?.status === 'running') this.saveRun({ ...run, status: 'paused', updatedAt: this.deps.now(), errorCode: null }); }
    // Stopping requests and invalidating credentials must still finish if disk writes fail.
    // Expose the stopped state through status(); startup pauses a durable running record.
    catch { this.failedCheckpoint = id; }
  }
  pause(): MiaoshouSyncStatus { this.pauseActive(); return this.status(); }
  enableInboxImport(): MiaoshouSyncStatus {
    const run = this.run(); if (!run || !this.running) return fail('INPUT');
    if (!run.importToInbox) this.saveRun({ ...run, importToInbox: true, imported: 0, existing: 0 });
    return this.status();
  }
  async resume(retry = false, importToInbox = false): Promise<MiaoshouSyncStatus> {
    if (this.running) return fail('BUSY'); await this.active?.done; if (this.running) return fail('BUSY'); const run = this.run(); if (!run) return fail('INPUT');
    if (retry) this.db.prepare(`UPDATE miaoshou_sync_items SET record_json=json_set(record_json,'$.status','pending','$.errorCode',NULL) WHERE ${scopeWhere} AND ${stateWhere('failed')}`).run(run.id, run.cycle);
    else if (run.status !== 'paused') return fail('INPUT');
    const next = { ...run, ...(importToInbox && !run.importToInbox ? { importToInbox: true, imported: 0, existing: 0 } : {}), status: 'running' as const, updatedAt: this.deps.now(), errorCode: null }; this.saveRun(next); this.launch(next); return this.status();
  }
  async close(): Promise<void> { this.pauseActive(); await this.active?.done; }
  private launch(run: SyncRun): void {
    const controller = new AbortController(), active = { run, controller, done: Promise.resolve() };
    this.active = active;
    // If even the pause checkpoint cannot be written, expose the stopped state in this
    // process; the last durable cursor remains intact and startup will pause it again.
    active.done = this.execute(run, controller.signal).catch(() => { this.failedCheckpoint = run.id; }).finally(() => { if (this.active === active) this.active = undefined; });
  }
  private assertActive(signal: AbortSignal): void { if (signal.aborted) throw signal.reason; }
  private async execute(initial: SyncRun, signal: AbortSignal): Promise<void> {
    let run = initial;
    try {
      while (run.stage === 'listing') {
        this.assertActive(signal); const page = await this.deps.list(run.nextPage, run.pageSize, signal); this.assertActive(signal);
        run = this.run(run.id)!;
        let added = 0; this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const listed of page.items) {
            const id = syncItemId(run.id, listed.id), old = this.item(id); if (!old || old.cycle !== run.cycle) added++;
            const unchanged = old?.snapshot && listed.updatedAt !== '' && old.fetchedModified === listed.updatedAt;
            this.saveItem({ id, scopeId: run.id, mode: run.mode, remoteId: listed.id, title: listed.title, remoteModified: listed.updatedAt, fetchedModified: old?.fetchedModified ?? '', status: unchanged ? 'unchanged' : 'pending', cycle: run.cycle, snapshot: old?.snapshot ?? null, updatedAt: this.deps.now(), errorCode: null });
          }
          if (run.nextPage > 1 && page.items.length > 0 && added === 0 || page.items.length === 0 && (run.nextPage - 1) * run.pageSize < page.total) return fail('RESPONSE');
          const next: SyncRun = { ...run, remoteTotal: page.total, nextPage: run.nextPage + 1, stage: page.items.length === 0 || run.nextPage * run.pageSize >= page.total ? 'details' : 'listing', updatedAt: this.deps.now() };
          this.saveRun(next); this.db.exec('COMMIT'); run = next;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      for (;;) {
        this.assertActive(signal);
        run = this.run(run.id)!;
        const needsImport = run.importToInbox ? ` OR ((${stateWhere('ready')} OR ${stateWhere('unchanged')}) AND json_extract(record_json,'$.importResult') IS NULL)` : '';
        const row = this.db.prepare(`SELECT record_json FROM miaoshou_sync_items WHERE ${scopeWhere} AND (${stateWhere('pending')}${needsImport}) ORDER BY rowid LIMIT 1`).get(run.id, run.cycle); if (!row) break;
        const item = validateSyncItem(JSON.parse(String(row.record_json)));
        try {
          const snapshot = ['ready','unchanged'].includes(item.status) && item.snapshot ? item.snapshot : await this.deps.detail(item.remoteId, signal); this.assertActive(signal);
          run = this.run(run.id)!;
          const importResult = run.importToInbox ? this.deps.importProduct?.(snapshot, run) : undefined;
          if (run.importToInbox && !importResult) return fail('STORAGE');
          const completed: SyncItem = { ...item, snapshot, fetchedModified: item.remoteModified, title: snapshot.title || item.title, status: item.status === 'unchanged' ? 'unchanged' : 'ready', updatedAt: this.deps.now(), errorCode: null, ...(importResult ? { importResult } : {}) };
          if (importResult) {
            const next = { ...run, imported: (run.imported ?? 0) + (importResult === 'added' ? 1 : 0), existing: (run.existing ?? 0) + (importResult === 'existing' ? 1 : 0), updatedAt: this.deps.now() };
            this.db.exec('BEGIN IMMEDIATE');
            try { this.saveItem(completed); this.saveRun(next); this.db.exec('COMMIT'); run = next; }
            catch (error) { this.db.exec('ROLLBACK'); throw error; }
          } else this.saveItem(completed);
          if (run.importToInbox) await new Promise<void>(resolve => setImmediate(resolve));
        } catch (error) {
          this.assertActive(signal);
          const code = error instanceof MiaoshouError ? error.code : 'STORAGE';
          if (['LIMIT','AUTH','PERMISSION','NOT_CONFIGURED','STORAGE'].includes(code)) throw error;
          this.saveItem({ ...item, status: 'failed', updatedAt: this.deps.now(), errorCode: code });
        }
      }
      this.saveRun({ ...run, status: 'completed', updatedAt: this.deps.now(), errorCode: null });
    } catch (error) {
      if (!signal.aborted) this.saveRun({ ...(this.run(run.id) ?? run), status: 'paused', updatedAt: this.deps.now(), errorCode: error instanceof MiaoshouError ? error.code : 'STORAGE' });
    }
  }
}
