import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { AI_DAILY_CALL_MAX, AI_DAILY_TOKEN_MAX } from '../../shared/ai-contracts.ts';
import type { AiCall, AiProviderId, AiUsage, AiUsagePolicy, AiUsageSummary } from '../../shared/ai-contracts.ts';
import { AiError } from './errors.ts';
import { date, integer, isDeepSeek, keys, providerId, uuid, validateAiCall, validateUsage } from './validation.ts';

const zeroUsage = (): AiUsage => ({ promptTokens: 0, completionTokens: 0, processedImages: 0 });
export interface AiUsageRecord {
  id: string; providerId: AiProviderId; day: string; startedAt: string; finishedAt: string | null;
  state: 'PENDING' | 'REPORTED' | 'UNKNOWN'; reservedTokens: number | null; usage: AiUsage;
}
interface StoredPolicy { id: AiProviderId; dailyCallLimit: number | null; dailyTokenLimit: number | null; updatedAt: string }
function limit(value: unknown, max: number): number | null { return value === null ? null : integer(value, 0, max); }
export function validateAiUsagePolicy(raw: unknown): AiUsagePolicy {
  const o = keys(raw, ['providerId', 'dailyCallLimit', 'dailyTokenLimit']), id = providerId(o.providerId);
  const dailyCallLimit = limit(o.dailyCallLimit, AI_DAILY_CALL_MAX), dailyTokenLimit = limit(o.dailyTokenLimit, AI_DAILY_TOKEN_MAX);
  if (!isDeepSeek(id) && dailyTokenLimit !== null) throw new AiError('INVALID_INPUT');
  return { providerId: id, dailyCallLimit, dailyTokenLimit };
}
export function validateStoredAiUsagePolicy(raw: unknown): StoredPolicy {
  const o = keys(raw, ['id', 'dailyCallLimit', 'dailyTokenLimit', 'updatedAt']);
  const policy = validateAiUsagePolicy({ providerId: o.id, dailyCallLimit: o.dailyCallLimit, dailyTokenLimit: o.dailyTokenLimit });
  return { id: policy.providerId, dailyCallLimit: policy.dailyCallLimit, dailyTokenLimit: policy.dailyTokenLimit, updatedAt: date(o.updatedAt) };
}
export function validateAiUsageRecord(raw: unknown): AiUsageRecord {
  const o = keys(raw, ['id', 'providerId', 'day', 'startedAt', 'finishedAt', 'state', 'reservedTokens', 'usage']);
  const id = uuid(o.id), provider = providerId(o.providerId), startedAt = date(o.startedAt), finishedAt = o.finishedAt === null ? null : date(o.finishedAt), usage = validateUsage(o.usage);
  const reservedTokens = o.reservedTokens === null ? null : integer(o.reservedTokens, 0, Number.MAX_SAFE_INTEGER);
  if (o.day !== startedAt.slice(0, 10) || !['PENDING', 'REPORTED', 'UNKNOWN'].includes(String(o.state)) || typeof o.state !== 'string'
    || (o.state === 'PENDING' ? finishedAt !== null || reservedTokens === null : finishedAt === null || finishedAt < startedAt)
    || (o.state !== 'REPORTED' && (usage.promptTokens || usage.completionTokens || usage.processedImages))
    || (isDeepSeek(provider) ? usage.processedImages !== 0 : usage.promptTokens !== 0 || usage.completionTokens !== 0 || reservedTokens !== 0)
    || (isDeepSeek(provider) && o.state !== 'REPORTED' && reservedTokens !== null && reservedTokens < 512 + (provider === 'deepseek-review' ? 16384 : 4096))
    || (reservedTokens === null && o.state !== 'UNKNOWN')) throw new AiError('INVALID_CONFIG');
  return { id, providerId: provider, day: String(o.day), startedAt, finishedAt, state: o.state as AiUsageRecord['state'], reservedTokens, usage };
}
function readRows<T extends { id: string }>(db: DatabaseSync, table: 'ai_usage_ledger' | 'ai_usage_policies', validate: (raw: unknown) => T, filters: { providerId?: AiProviderId; day?: string; state?: AiUsageRecord['state'] } = {}): T[] {
  const fields = (['providerId', 'day', 'state'] as const).filter(field => filters[field] !== undefined);
  const condition = fields.map(field => `json_extract(record_json,'$.${field}')=?`).join(' AND ');
  return db.prepare(`SELECT id,record_json FROM ${table}${condition ? ` WHERE ${condition}` : ''}`).all(...fields.map(field => filters[field]!)).map(row => { const parsed = validate(JSON.parse(String(row.record_json))); if (parsed.id !== row.id) throw new AiError('INVALID_CONFIG'); return parsed; });
}
function saveRecord(db: DatabaseSync, record: AiUsageRecord): void { const parsed = validateAiUsageRecord(record); db.prepare('INSERT INTO ai_usage_ledger(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(parsed.id, JSON.stringify(parsed)); }
function add(a: number, b: number): number { return integer(a + b, 0, Number.MAX_SAFE_INTEGER); }
/** Text UTF-8 bytes + 1024 tokens per vision image + 512 framing + max_tokens. Base64 is transport, not text. */
export function requestTokenReservation(id: AiProviderId, body: string | Buffer): number {
  if (!isDeepSeek(id)) return 0;
  if (typeof body !== 'string') throw new AiError('INVALID_CONFIG');
  const parsed = JSON.parse(body) as { max_tokens?: unknown; thinking?: {type?:string}; messages?: {content?: unknown}[] };
  const thinking=parsed.thinking?.type==='enabled';
  const maximum = integer(parsed.max_tokens, 1, thinking?32768:16384);
  let setPlanning=false;
  let fullSchemaListing=false;
  if(id==='deepseek'&&maximum===16384)for(const message of parsed.messages??[])if(typeof message.content==='string'){
    try{const payload=JSON.parse(message.content);if(payload.operation==='amazon-fields'&&payload.contract==='listing-full-schema/v1'&&payload.fullSchema?.schema&&payload.fullSchema?.metaSchema)fullSchemaListing=true;}catch{/* Not a field generation payload. */}
  }
  if(id==='deepseek'&&maximum===16384){
    for(const message of parsed.messages??[])if(Array.isArray(message.content))for(const part of message.content)if(part.type==='text'&&typeof part.text==='string'){
      try{const payload=JSON.parse(part.text);if(payload.operation==='image-plan'&&payload.setPolicy==='seven-product-v2'&&!payload.slot)setPlanning=true;}catch{/* Ordinary text is not a planning request. */}
    }
  }
  if (maximum !== (thinking ? 32768 : id === 'deepseek-review'||setPlanning||fullSchemaListing ? 16384 : 4096)) throw new AiError('INVALID_CONFIG');
  let imageTokens = 0;
  for (const message of parsed.messages ?? []) if (Array.isArray(message.content)) {
    for (const part of message.content) if (part.type === 'image_url') {
      if (typeof part.image_url?.url !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url.url)) throw new AiError('INVALID_CONFIG');
      // DeepSeek's documented per-image upper bound, independent of base64 transfer size.
      imageTokens = add(imageTokens,1024); part.image_url.url = '[image]';
    }
  }
  return add(add(add(Buffer.byteLength(imageTokens ? JSON.stringify(parsed) : body,'utf8'), imageTokens),512),maximum);
}
/** Called inside the schema migration transaction. Failed legacy zero-usage calls have an unknown token liability. */
export function migrateLegacyAiUsage(db: DatabaseSync): void {
  for (const row of db.prepare('SELECT id,record_json FROM ai_calls').all()) {
    const call = validateAiCall(JSON.parse(String(row.record_json))); if (call.id !== row.id) throw new AiError('INVALID_CONFIG');
    const known = call.status === 'SUCCEEDED' || call.usage.promptTokens + call.usage.completionTokens + call.usage.processedImages > 0;
    const finishedAt = call.finishedAt ?? call.startedAt;
    saveRecord(db, { id: call.id, providerId: call.providerId, day: call.startedAt.slice(0, 10), startedAt: call.startedAt, finishedAt, state: known ? 'REPORTED' : 'UNKNOWN', reservedTokens: known || !isDeepSeek(call.providerId) ? 0 : null, usage: known ? call.usage : zeroUsage() });
  }
}
export class AiUsageLedger {
  private db: DatabaseSync;
  private now: () => Date;
  constructor(db: DatabaseSync, now: () => Date) { this.db = db; this.now = now; }
  timestamp(): string { try { return date(this.now().toISOString()); } catch { throw new AiError('INVALID_CONFIG'); } }
  getPolicy(rawId: string): AiUsagePolicy {
    const id = providerId(rawId), row = this.db.prepare('SELECT record_json FROM ai_usage_policies WHERE id=?').get(id);
    if (!row) return { providerId: id, dailyCallLimit: null, dailyTokenLimit: null };
    const stored = validateStoredAiUsagePolicy(JSON.parse(String(row.record_json))); if (stored.id !== id) throw new AiError('INVALID_CONFIG');
    return { providerId: id, dailyCallLimit: stored.dailyCallLimit, dailyTokenLimit: stored.dailyTokenLimit };
  }
  setPolicy(raw: unknown): AiUsagePolicy {
    let policy: AiUsagePolicy; try { policy = validateAiUsagePolicy(raw); } catch { throw new AiError('INVALID_INPUT'); }
    const at = this.timestamp(), row = this.db.prepare('SELECT record_json FROM ai_usage_policies WHERE id=?').get(policy.providerId);
    const previous = row ? validateStoredAiUsagePolicy(JSON.parse(String(row.record_json))) : undefined;
    const record: StoredPolicy = { id: policy.providerId, dailyCallLimit: policy.dailyCallLimit, dailyTokenLimit: policy.dailyTokenLimit, updatedAt: previous && previous.updatedAt > at ? previous.updatedAt : at };
    this.db.prepare('INSERT INTO ai_usage_policies(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(record.id, JSON.stringify(record)); return policy;
  }
  summary(rawId: string, at = this.timestamp()): AiUsageSummary {
    const id = providerId(rawId), day = date(at).slice(0, 10);
    const result: AiUsageSummary = { providerId: id, day, timeZone: 'UTC', attempts: 0, pendingCalls: 0, unknownCalls: 0, reportedTokens: 0, reservedTokens: 0, usedTokens: 0, processedImages: 0, unboundedCalls: 0, policy: this.getPolicy(id) };
    for (const record of readRows(this.db, 'ai_usage_ledger', validateAiUsageRecord, { providerId: id, day })) {
      result.attempts = add(result.attempts, 1);
      if (record.state === 'REPORTED') { result.reportedTokens = add(result.reportedTokens, record.usage.promptTokens + record.usage.completionTokens); result.processedImages = add(result.processedImages, record.usage.processedImages); }
      else { if (record.state === 'PENDING') result.pendingCalls++; else result.unknownCalls++; if (record.reservedTokens === null) result.unboundedCalls++; else result.reservedTokens = add(result.reservedTokens, record.reservedTokens); }
    }
    result.usedTokens = result.unboundedCalls ? null : add(result.reportedTokens, result.reservedTokens); return result;
  }
  /** Reservation and RUNNING call insertion share a SQLite write lock across service instances. */
  reserve(rawCall: AiCall, body: string | Buffer, recordSend?: (call:AiCall)=>void): AiCall {
    const call = validateAiCall(rawCall), reservation = requestTokenReservation(call.providerId, body);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const summary = this.summary(call.providerId, call.startedAt), policy = summary.policy;
      if ((policy.dailyCallLimit !== null && summary.attempts >= policy.dailyCallLimit)
        || (policy.dailyTokenLimit !== null && (summary.usedTokens === null || summary.usedTokens + reservation > policy.dailyTokenLimit))) throw new AiError('QUOTA_EXCEEDED');
      saveRecord(this.db, { id: call.id, providerId: call.providerId, day: call.startedAt.slice(0, 10), startedAt: call.startedAt, finishedAt: null, state: 'PENDING', reservedTokens: reservation, usage: zeroUsage() });
      this.db.prepare('INSERT INTO ai_calls(id,record_json) VALUES(?,?)').run(call.id, JSON.stringify(call)); recordSend?.(call); this.db.exec('COMMIT'); return call;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Caller includes this update in its result/call transaction. */
  settle(callId: string, known: boolean, usage: AiUsage, finishedAt: string): void {
    const row = this.db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(callId); if (!row) throw new AiError('INVALID_CONFIG');
    const record = validateAiUsageRecord(JSON.parse(String(row.record_json))); if (record.id !== callId) throw new AiError('INVALID_CONFIG');
    saveRecord(this.db, { ...record, state: known ? 'REPORTED' : 'UNKNOWN', usage: known ? usage : zeroUsage(), finishedAt });
  }
  recoverPending(): void {
    for (const record of readRows(this.db, 'ai_usage_ledger', validateAiUsageRecord, { state: 'PENDING' })) {
      let at: string; try { at = this.timestamp(); } catch { at = record.startedAt; }
      saveRecord(this.db, { ...record, state: 'UNKNOWN', finishedAt: at < record.startedAt ? record.startedAt : at });
    }
  }
}
/** A settled known report supersedes its earlier estimate; conflicts within known reports only increase usage. */
export function mergeAiUsageRecords(a: AiUsageRecord, b: AiUsageRecord): AiUsageRecord {
  if (a.id !== b.id || a.providerId !== b.providerId || a.day !== b.day || a.startedAt !== b.startedAt) throw new AiError('INVALID_CONFIG');
  const known = [a, b].filter(record => record.state === 'REPORTED');
  const state = known.length ? 'REPORTED' : 'UNKNOWN';
  const usage = known.reduce((sum, record) => ({ promptTokens: Math.max(sum.promptTokens, record.usage.promptTokens), completionTokens: Math.max(sum.completionTokens, record.usage.completionTokens), processedImages: Math.max(sum.processedImages, record.usage.processedImages) }), zeroUsage());
  const finishedAt = [a.finishedAt ?? a.startedAt, b.finishedAt ?? b.startedAt].sort()[1];
  const reservedTokens = state === 'REPORTED' ? Math.max(a.reservedTokens ?? 0, b.reservedTokens ?? 0) : a.reservedTokens === null || b.reservedTokens === null ? null : Math.max(a.reservedTokens, b.reservedTokens);
  return validateAiUsageRecord({ ...a, state, finishedAt, reservedTokens, usage });
}
/** Current local safety facts survive old backups even when their product/call rows no longer exist. */
export function retainAiUsage(current: DatabaseSync, snapshot: DatabaseSync): void {
  const has = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (has(current, 'ai_usage_ledger') && has(snapshot, 'ai_usage_ledger')) {
    for (const record of readRows(current, 'ai_usage_ledger', validateAiUsageRecord)) {
      const row = snapshot.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(record.id);
      const previous = row ? validateAiUsageRecord(JSON.parse(String(row.record_json))) : { ...record, state: 'UNKNOWN' as const, finishedAt: record.finishedAt ?? record.startedAt, usage: zeroUsage() };
      saveRecord(snapshot, mergeAiUsageRecords(previous, record));
    }
  }
  if (has(current, 'ai_usage_policies') && has(snapshot, 'ai_usage_policies')) for (const record of readRows(current, 'ai_usage_policies', validateStoredAiUsagePolicy)) {
    const row = snapshot.prepare('SELECT record_json FROM ai_usage_policies WHERE id=?').get(record.id), previous = row ? validateStoredAiUsagePolicy(JSON.parse(String(row.record_json))) : undefined;
    if (!previous || record.updatedAt >= previous.updatedAt) snapshot.prepare('INSERT INTO ai_usage_policies(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(record.id, JSON.stringify(record));
  }
}

/** Keep sent color requests across a restore, without importing their missing results as evidence.
 * The caller holds the same transaction as the usage-ledger merge. */
export function retainSourceColorAttempts(current: DatabaseSync, snapshot: DatabaseSync): void {
  const hasCalls=(db:DatabaseSync)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_calls'").get();
  if(!hasCalls(current)||!hasCalls(snapshot))return;
  const identity=(call:AiCall)=>({providerId:call.providerId,productId:call.productId,productRevision:call.productRevision,
    model:call.model,generation:call.generation,startedAt:call.startedAt,sourceColorContext:call.sourceColorContext});
  for(const row of current.prepare("SELECT id,record_json FROM ai_calls WHERE json_type(record_json,'$.sourceColorContext') IS NOT NULL").all()){
    const call=validateAiCall(JSON.parse(String(row.record_json)));
    if(call.id!==row.id||!call.sourceColorContext)throw new AiError('INVALID_CONFIG');
    const existing=snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id);
    if(existing){
      const previous=validateAiCall(JSON.parse(String(existing.record_json)));
      if(previous.id!==call.id||!isDeepStrictEqual(identity(previous),identity(call)))throw new AiError('INVALID_CONFIG');
      continue;
    }
    // Even a known success is only a no-resend marker when its result is absent
    // from the selected backup. Preserve its original usage and request metadata.
    const finishedAt=call.finishedAt??[call.startedAt,new Date().toISOString()].sort()[1];
    const retained=validateAiCall({...call,status:'FAILED',errorCode:call.errorCode??'INTERRUPTED',finishedAt});
    snapshot.prepare('INSERT INTO ai_calls(id,record_json) VALUES(?,?)').run(retained.id,JSON.stringify(retained));
  }
}

/** Retain paid planning budget across an older backup without importing missing image results.
 * The caller holds the same restore transaction as the usage-ledger merge. */
export function retainImagePlanningAttempts(current:DatabaseSync,snapshot:DatabaseSync):void {
  const hasCalls=(db:DatabaseSync)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_calls'").get();
  if(!hasCalls(current)||!hasCalls(snapshot))return;
  const identity=(call:AiCall)=>({providerId:call.providerId,productId:call.productId,productRevision:call.productRevision,
    model:call.model,generation:call.generation,startedAt:call.startedAt,presentationContext:call.presentationContext});
  for(const row of current.prepare(`SELECT id,record_json FROM ai_calls WHERE
    json_extract(record_json,'$.providerId')='deepseek' AND json_extract(record_json,'$.model')='deepseek-flash'
    AND json_extract(record_json,'$.presentationContext.kind')='image'
    AND json_type(record_json,'$.presentationContext.workflowId')='text'`).all()){
    const call=validateAiCall(JSON.parse(String(row.record_json)));
    if(call.id!==row.id)throw new AiError('INVALID_CONFIG');
    const existing=snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id);
    if(existing){
      const previous=validateAiCall(JSON.parse(String(existing.record_json)));
      if(previous.id!==call.id||!isDeepStrictEqual(identity(previous),identity(call)))throw new AiError('INVALID_CONFIG');
      if(call.imagePlanRetryBlock&&!previous.imagePlanRetryBlock){
        // An older RUNNING/INTERRUPTED snapshot cannot erase a later confirmed refusal.
        // Conflicting success evidence is not silently invalidated during restore.
        if(previous.status==='SUCCEEDED'||snapshot.prepare("SELECT id FROM ai_results WHERE json_extract(record_json,'$.callId')=? LIMIT 1").get(call.id))throw new AiError('INVALID_CONFIG');
        snapshot.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);
      }
      continue;
    }
    // The selected snapshot has no result for this newly retained call. A success is
    // only spent budget, never evidence authorizing generation or a fabricated result.
    const finishedAt=call.finishedAt??[call.startedAt,new Date().toISOString()].sort()[1];
    const retained=validateAiCall({...call,status:'FAILED',errorCode:call.errorCode??'INTERRUPTED',finishedAt});
    snapshot.prepare('INSERT INTO ai_calls(id,record_json) VALUES(?,?)').run(retained.id,JSON.stringify(retained));
  }
}

/** Keep the known received-response barrier even when restoring a snapshot predating it. */
export function retainSchemaResponseCalls(current:DatabaseSync,snapshot:DatabaseSync):void {
  const has=(db:DatabaseSync)=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_calls'").get();
  if(!has(current)||!has(snapshot))return;
  for(const row of current.prepare("SELECT id,record_json FROM ai_calls WHERE json_extract(record_json,'$.schemaResponseRetained')=1").all()){
    const call=validateAiCall(JSON.parse(String(row.record_json)));
    const old=snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id);
    if(old){
      const previous=validateAiCall(JSON.parse(String(old.record_json)));
      if(previous.productId!==call.productId||previous.providerId!==call.providerId||previous.startedAt!==call.startedAt||previous.model!==call.model)throw new AiError('INVALID_CONFIG');
      if(previous.status==='SUCCEEDED')throw new AiError('INVALID_CONFIG');
    }
    snapshot.prepare('INSERT INTO ai_calls(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(call.id,JSON.stringify(call));
  }
}
