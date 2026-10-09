import type { DatabaseSync } from 'node:sqlite';
import type { MiaoshouProduct } from '../../shared/miaoshou-contracts.ts';
import type { MiaoshouSyncItemState } from '../../shared/miaoshou-sync-contracts.ts';
import { exact, fail, hash, object, remoteId, text, timestamp, validateProduct } from './validation.ts';
import type { MiaoshouError } from './validation.ts';

export const MIAOSHOU_SYNC_INDEXES = [
  { name: 'miaoshou_sync_runs_status', table: 'miaoshou_sync_runs', expressions: 1, sql: "CREATE INDEX miaoshou_sync_runs_status ON miaoshou_sync_runs(json_extract(record_json,'$.status'))" },
  // Cover frequent progress totals so polling never rereads or reparses the large snapshots.
  { name: 'miaoshou_sync_items_scope_cycle_status', table: 'miaoshou_sync_items', expressions: 4, sql: "CREATE INDEX miaoshou_sync_items_scope_cycle_status ON miaoshou_sync_items(json_extract(record_json,'$.scopeId'),json_extract(record_json,'$.cycle'),json_extract(record_json,'$.status'),json_array_length(record_json,'$.snapshot.skus'))" },
  { name: 'miaoshou_receipts_remote_scope', table: 'miaoshou_receipts', expressions: 3, sql: "CREATE INDEX miaoshou_receipts_remote_scope ON miaoshou_receipts(json_extract(record_json,'$.accountScope'),json_extract(record_json,'$.mode'),json_extract(record_json,'$.snapshot.remoteId'))" },
] as const;
export interface SyncScope { accountScope: string; mode: 'demo' | 'live' }
export interface SyncRun extends SyncScope {
  importToInbox?: boolean; imported?: number; existing?: number;
  id: string; cycle: number; status: 'running' | 'paused' | 'completed'; stage: 'listing' | 'details';
  nextPage: number; pageSize: number; remoteTotal: number | null; updatedAt: string; errorCode: MiaoshouError['code'] | null;
}
export interface SyncItem {
  importResult?: 'added' | 'existing';
  id: string; scopeId: string; mode: 'demo' | 'live'; remoteId: string; title: string; remoteModified: string; fetchedModified: string;
  status: MiaoshouSyncItemState; cycle: number; snapshot: MiaoshouProduct | null; updatedAt: string; errorCode: MiaoshouError['code'] | null;
}
export const syncScopeId = (scope: SyncScope): string => hash(`${scope.mode}:${scope.accountScope}`);
export const syncItemId = (scopeId: string, id: string): string => hash(`${scopeId}:${id}`);
export function syncInteger(raw: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(raw) || Number(raw) < min || Number(raw) > max) return fail('INPUT'); return Number(raw); }
export function syncPageSize(raw: unknown): number { if (![20, 50, 100, 500].includes(syncInteger(raw, 1, 500))) return fail('INPUT'); return Number(raw); }
function digest(raw: unknown): string { const value = text(raw, 64, true); if (!/^[a-f0-9]{64}$/.test(value)) return fail(); return value; }
function mode(raw: unknown): SyncScope['mode'] { if (raw !== 'demo' && raw !== 'live') return fail(); return raw; }
const errorCodes: MiaoshouError['code'][] = ['INPUT', 'CONFIG', 'NOT_CONFIGURED', 'CRYPTO', 'STORAGE', 'AUTH', 'PERMISSION', 'LIMIT', 'NETWORK', 'TIMEOUT', 'RESPONSE', 'TOO_MANY_SKUS', 'TOO_LARGE', 'CHANGED', 'PREVIEW', 'CLOSED', 'BUSY'];
function errorCode(raw: unknown): MiaoshouError['code'] | null { if (raw === null) return null; if (!errorCodes.includes(raw as MiaoshouError['code'])) return fail(); return raw as MiaoshouError['code']; }
export function validateSyncRun(raw: unknown): SyncRun {
  const optional = ['importToInbox','imported','existing'].filter(key => Object.hasOwn(object(raw), key));
  const row = exact(raw, ['id','accountScope','mode','cycle','status','stage','nextPage','pageSize','remoteTotal','updatedAt','errorCode',...optional]);
  const result: SyncRun = { id: digest(row.id), accountScope: digest(row.accountScope), mode: mode(row.mode), cycle: syncInteger(row.cycle, 1), status: row.status as SyncRun['status'], stage: row.stage as SyncRun['stage'], nextPage: syncInteger(row.nextPage, 1), pageSize: syncPageSize(row.pageSize), remoteTotal: row.remoteTotal === null ? null : syncInteger(row.remoteTotal), updatedAt: timestamp(row.updatedAt), errorCode: errorCode(row.errorCode) };
  if (!['running','paused','completed'].includes(result.status) || !['listing','details'].includes(result.stage) || result.id !== syncScopeId(result)) return fail();
  if (row.importToInbox !== undefined) { if (typeof row.importToInbox !== 'boolean') return fail(); result.importToInbox = row.importToInbox; }
  for (const key of ['imported','existing'] as const) if (Object.hasOwn(row, key)) { if (!result.importToInbox) return fail(); result[key] = syncInteger(row[key]); }
  return result;
}
export function validateSyncItem(raw: unknown): SyncItem {
  const row = exact(raw, ['id','scopeId','mode','remoteId','title','remoteModified','fetchedModified','status','cycle','snapshot','updatedAt','errorCode',...(Object.hasOwn(object(raw), 'importResult') ? ['importResult'] : [])]);
  const item: SyncItem = { id: digest(row.id), scopeId: digest(row.scopeId), mode: mode(row.mode), remoteId: remoteId(row.remoteId), title: text(row.title, 500), remoteModified: text(row.remoteModified, 100), fetchedModified: text(row.fetchedModified, 100), status: row.status as SyncItem['status'], cycle: syncInteger(row.cycle, 1), snapshot: row.snapshot === null ? null : validateProduct(row.snapshot, mode(row.mode)), updatedAt: timestamp(row.updatedAt), errorCode: errorCode(row.errorCode) };
  if (!['pending','ready','unchanged','failed'].includes(item.status) || item.id !== syncItemId(item.scopeId, item.remoteId) || item.snapshot && item.snapshot.remoteId !== item.remoteId || ['ready','unchanged'].includes(item.status) && !item.snapshot || item.status === 'failed' && !item.errorCode || item.status !== 'failed' && item.errorCode !== null) return fail();
  if (row.importResult !== undefined) { if (!['added','existing'].includes(String(row.importResult)) || !['ready','unchanged'].includes(item.status)) return fail(); item.importResult = row.importResult as SyncItem['importResult']; }
  return item;
}
export function assertSyncHistory(db: DatabaseSync): void {
  for (const row of db.prepare('SELECT record_json FROM miaoshou_sync_items').iterate()) {
    const item = validateSyncItem(JSON.parse(String(row.record_json))), stored = db.prepare('SELECT record_json FROM miaoshou_sync_runs WHERE id=?').get(item.scopeId);
    if (!stored) return fail(); const run = validateSyncRun(JSON.parse(String(stored.record_json)));
    if (item.mode !== run.mode || item.cycle > run.cycle) return fail();
  }
}
