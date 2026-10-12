import { retireCompletionDrafts } from '../listing-ai/completion-journal.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { AmazonCallEvent, AmazonDataPolicy, AmazonDraft, AmazonSchema, AmazonTarget, CleanupResult, JsonObject } from '../../shared/amazon-contracts.ts';
import { openDatabase } from '../database.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { listingProgram } from './listing-program.ts';
import type { AcceptedAmazonSku } from '../../shared/product-data-contracts.ts';
import { ACCEPTED_SKU_PREFIX, acceptedSkuFromRecord, acceptedSkuKey, decodeAcceptedSku } from '../product-data/accepted-skus.ts';

export interface PreviewProof { revision: number; productRevision: number; checksum: string; version: string; generation: number; at: string }
export interface ExchangeSnapshot { id: string; at: string; operation: 'preview' | 'submit' | 'readback'; revision: number; request: JsonObject; response: JsonObject | null; status: number | null; requestId: string | null; schemaChecksum: string; schemaVersion: string }
export interface DraftRecord { draft: AmazonDraft; preview: PreviewProof | null; request: JsonObject; previewResponse: JsonObject | null; submitResponse: JsonObject | null; readResponse: JsonObject | null; unresolvedWrite: boolean; exchanges?: ExchangeSnapshot[] }
function parseRecord(raw: unknown): DraftRecord {
  const record = JSON.parse(String(raw)) as DraftRecord;
  record.draft.listingProgram = listingProgram(record.draft.listingProgram);
  return record;
}
export class AmazonPersistence {
  db: DatabaseSync;
  constructor(directory: string) { this.db = openDatabase(directory); }
  close(): void { this.db.close(); }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  targets(): AmazonTarget[] { return this.db.prepare('SELECT target_json FROM amazon_targets WHERE target_json IS NOT NULL ORDER BY rowid').all().map(row => JSON.parse(String(row.target_json))); }
  target(id: string): AmazonTarget {
    const row = this.db.prepare('SELECT target_json FROM amazon_targets WHERE id=?').get(id);
    if (!row?.target_json) throw new UserFacingError('Amazon 店铺不存在');
    return JSON.parse(String(row.target_json));
  }
  generation(id: string): number { return Number(this.db.prepare('SELECT credential_generation FROM amazon_targets WHERE id=?').get(id)?.credential_generation ?? 0); }
  putTarget(target: AmazonTarget, rotate = false): void {
    this.db.prepare(`INSERT INTO amazon_targets(id,name,seller_id,marketplace_id,product_type,parentage_level,credential_ref,target_json,credential_generation)
      VALUES(?,?,?,?,'','NONE',NULL,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,seller_id=excluded.seller_id,marketplace_id=excluded.marketplace_id,
      target_json=excluded.target_json,credential_generation=amazon_targets.credential_generation+?`).run(target.id, target.name, target.sellerId, target.marketplaceId, JSON.stringify(target), rotate ? 1 : 0, rotate ? 1 : 0);
  }
  schema(key: string): AmazonSchema | null { const row = this.db.prepare('SELECT snapshot_json FROM schema_cache WHERE cache_key=?').get(key); return row?.snapshot_json ? JSON.parse(String(row.snapshot_json)) : null; }
  putSchema(schema: AmazonSchema): void {
    this.db.prepare(`INSERT INTO schema_cache(cache_key,target_id,schema_json,meta_schema_json,checksum,requirements,parentage_level,fetched_at,expires_at,snapshot_json)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET schema_json=excluded.schema_json,meta_schema_json=excluded.meta_schema_json,checksum=excluded.checksum,
      fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,snapshot_json=excluded.snapshot_json`).run(schema.key, schema.targetId, JSON.stringify(schema.schema), JSON.stringify(schema.metaSchema), schema.checksum, schema.requirements, schema.parentageLevel, schema.fetchedAt, schema.expiresAt, JSON.stringify(schema));
  }
  records(productId?: string): DraftRecord[] {
    const rows = productId ? this.db.prepare('SELECT record_json FROM listing_drafts WHERE product_id=? AND record_json IS NOT NULL ORDER BY created_at DESC,rowid DESC').all(productId)
      : this.db.prepare('SELECT record_json FROM listing_drafts WHERE record_json IS NOT NULL').all();
    return rows.map(row => parseRecord(row.record_json));
  }
  record(id: string): DraftRecord {
    const row = this.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(id);
    if (!row?.record_json) throw new UserFacingError('上架草稿不存在或已按保留期限清理');
    return parseRecord(row.record_json);
  }
  putRecord(record: DraftRecord): void {
    const persist = () => {
    const d = record.draft;
    this.db.prepare(`INSERT INTO listing_drafts(id,product_id,target_id,request_json,schema_checksum,validation_json,preview_json,state,created_at,record_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET request_json=excluded.request_json,schema_checksum=excluded.schema_checksum,validation_json=excluded.validation_json,
      preview_json=excluded.preview_json,state=excluded.state,record_json=excluded.record_json,updated_at=excluded.updated_at`).run(d.id, d.productId, d.targetId, JSON.stringify(record.request), d.schema.checksum, JSON.stringify(d.localIssues), record.previewResponse ? JSON.stringify(record.previewResponse) : null, d.state, d.createdAt, JSON.stringify(record), d.updatedAt);
    for (const exchange of record.exchanges ?? []) this.db.prepare('INSERT OR IGNORE INTO amazon_exchanges(id,draft_id,created_at,exchange_json) VALUES(?,?,?,?)').run(exchange.id, d.id, exchange.at, JSON.stringify(exchange));
    };
    if (this.db.isTransaction) persist(); else this.transaction(persist);
  }
  locked(hash: string): boolean { return !!this.db.prepare('SELECT 1 FROM amazon_write_locks WHERE listing_hash=?').get(hash); }
  lock(hash: string): { draftId: string; state: string; ownerKind:string;ownerId:string } | null {
    const row = this.db.prepare('SELECT draft_id,state,owner_kind,owner_id FROM amazon_write_locks WHERE listing_hash=?').get(hash);
    return row ? { draftId: String(row.draft_id), state: String(row.state),ownerKind:String(row.owner_kind),ownerId:String(row.owner_id)||String(row.draft_id) } : null;
  }
  beginWrite(hash: string, record: DraftRecord): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.locked(hash)) throw new UserFacingError('此 SKU 有结果未知或尚未确认的提交，请先回读并人工核对；禁止重放');
      this.db.prepare('INSERT INTO amazon_write_locks(listing_hash,draft_id,state,created_at,owner_kind,owner_id) VALUES(?,?,?,?,?,?)').run(hash, record.draft.id, 'SUBMITTING', record.draft.updatedAt, 'draft', record.draft.id);
      this.putRecord(record); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finishWrite(hash: string, record: DraftRecord, invalidated: DraftRecord[] = []): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner=this.lock(hash);
      // A delayed ordinary PUT must not mutate either a correction lock or its original receipt.
      if(owner&&(owner.ownerKind!=='draft'||owner.ownerId!==record.draft.id||owner.draftId!==record.draft.id)
        ||!owner&&this.db.prepare("SELECT 1 FROM listing_correction_attempts WHERE json_extract(record_json,'$.listingHash')=?").get(hash)) {
        for(const exchange of record.exchanges??[])this.db.prepare('INSERT OR IGNORE INTO amazon_exchanges(id,draft_id,created_at,exchange_json) VALUES(?,?,?,?)').run(exchange.id,record.draft.id,exchange.at,JSON.stringify(exchange));
        this.db.exec('COMMIT');return;
      }

      if (record.unresolvedWrite) this.db.prepare("UPDATE amazon_write_locks SET state='UNKNOWN' WHERE listing_hash=? AND owner_kind='draft' AND draft_id=? AND (owner_id=? OR owner_id='')").run(hash, record.draft.id, record.draft.id);
      else if (record.draft.state === 'SUBMITTED') this.db.prepare("UPDATE amazon_write_locks SET state='SUBMITTED' WHERE listing_hash=? AND owner_kind='draft' AND draft_id=? AND (owner_id=? OR owner_id='')").run(hash, record.draft.id, record.draft.id);
      else this.db.prepare('DELETE FROM amazon_write_locks WHERE listing_hash=? AND draft_id=? AND owner_kind=\'draft\' AND (owner_id=? OR owner_id=\'\')').run(hash, record.draft.id,record.draft.id);
      this.putRecord(record); this.rememberAcceptedSku(record); for (const other of invalidated) this.putRecord(other); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private rememberAcceptedSku(record: DraftRecord): void {
    const next = acceptedSkuFromRecord(record); if (!next) return;
    const product = this.db.prepare('SELECT origin FROM products WHERE id=?').get(next.productId);
    if (!product || !['manual', 'import'].includes(String(product.origin))) return;
    const key = acceptedSkuKey(next); const existing = this.db.prepare('SELECT value_json FROM amazon_settings WHERE key=?').get(key);
    const previous = existing ? decodeAcceptedSku(existing.value_json, key) : null;
    const row = previous ? { ...(previous.lastAcceptedAt > next.lastAcceptedAt ? previous : next),
      firstAcceptedAt: previous.firstAcceptedAt < next.firstAcceptedAt ? previous.firstAcceptedAt : next.firstAcceptedAt,
      lastAcceptedAt: previous.lastAcceptedAt > next.lastAcceptedAt ? previous.lastAcceptedAt : next.lastAcceptedAt } : next;
    this.db.prepare('INSERT INTO amazon_settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key, JSON.stringify(row));
  }
  listAcceptedSkus(targetId: string): AcceptedAmazonSku[] {
    const entries = this.db.prepare('SELECT key,value_json FROM amazon_settings WHERE key GLOB ? AND length(value_json)<=4096 LIMIT 20001').all(`${ACCEPTED_SKU_PREFIX}*`);
    if (entries.length > 20_000) throw new UserFacingError('已接受 SKU 记录超过安全读取上限');
    return entries.flatMap(entry => { const row = decodeAcceptedSku(entry.value_json, String(entry.key)); return row?.targetId === targetId ? [row] : []; });
  }
  releaseAccepted(hash: string, draftId: string): void { this.db.prepare("DELETE FROM amazon_write_locks WHERE listing_hash=? AND draft_id=? AND state='SUBMITTED' AND owner_kind='draft' AND (owner_id=? OR owner_id='')").run(hash, draftId, draftId); }
  recover(at: string): void {
    const rows = this.db.prepare("SELECT record_json FROM listing_drafts WHERE state='SUBMITTING' AND record_json IS NOT NULL").all();
    for (const row of rows) {
      const r = parseRecord(row.record_json); r.unresolvedWrite = true; r.preview = null; r.draft.state = 'UNKNOWN'; r.draft.previewedAt = null;
      r.draft.events.push({ at, operation: 'submit', state: 'UNKNOWN', requestId: null, summary: '上次提交被中断，结果未知；禁止自动重放，请回读核对' }); this.putRecord(r);
    }
    this.db.prepare("UPDATE amazon_write_locks SET state='UNKNOWN' WHERE state IN ('SUBMITTING','SENDING')").run();
    for(const row of this.db.prepare("SELECT id,record_json FROM listing_corrections WHERE json_extract(record_json,'$.state')='SENDING'").all()){
      const c=JSON.parse(String(row.record_json));c.state='UNKNOWN';c.revision++;c.message='上次修正发送被中断，结果未知；禁止重发';
      this.db.prepare('UPDATE listing_corrections SET record_json=? WHERE id=?').run(JSON.stringify(c),row.id);
      this.db.prepare("UPDATE listing_correction_attempts SET record_json=json_set(record_json,'$.state','UNKNOWN') WHERE correction_id=?").run(row.id);
    }
  }
  addCall(event: AmazonCallEvent): void { this.db.prepare('INSERT INTO amazon_calls(id,target_id,created_at,event_json) VALUES(?,?,?,?)').run(event.id, event.targetId, event.at, JSON.stringify(event)); }
  calls(): AmazonCallEvent[] { return this.db.prepare('SELECT event_json FROM amazon_calls ORDER BY created_at DESC,rowid DESC LIMIT 500').all().map(row => JSON.parse(String(row.event_json))); }
  policy(): AmazonDataPolicy {
    const row = this.db.prepare("SELECT value_json FROM amazon_settings WHERE key='data_policy'").get();
    return row ? JSON.parse(String(row.value_json)) : { retentionDays: 180, logRetentionDays: 365, lastCleanupAt: null };
  }
  savePolicy(policy: AmazonDataPolicy): void { this.db.prepare("INSERT INTO amazon_settings(key,value_json) VALUES('data_policy',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(JSON.stringify(policy)); }
  cleanup(now: number): CleanupResult {
    const policy = this.policy(); const cutoff = new Date(now - policy.retentionDays * 86_400_000).toISOString();
    const logCutoff = new Date(now - Math.max(365, policy.logRetentionDays) * 86_400_000).toISOString();
    this.db.exec('BEGIN IMMEDIATE'); let result: CleanupResult;
    try {
      // Preserve only minimal accepted identities before retention removes their full drafts and exchanges.
      for (const row of this.db.prepare('SELECT record_json FROM listing_drafts WHERE record_json IS NOT NULL').iterate()) {
        let record: DraftRecord; try { record = parseRecord(row.record_json); } catch { continue; }
        this.rememberAcceptedSku(record);
      }
      this.db.prepare('DELETE FROM amazon_exchanges WHERE created_at < ?').run(cutoff);
      this.db.prepare('DELETE FROM issues WHERE draft_id IN (SELECT id FROM listing_drafts WHERE created_at < ?)').run(cutoff);
      retireCompletionDrafts(this.db,cutoff);
      const removedDrafts = Number(this.db.prepare('DELETE FROM listing_drafts WHERE created_at < ?').run(cutoff).changes);
      const removedSchemas = Number(this.db.prepare('DELETE FROM schema_cache WHERE fetched_at < ?').run(cutoff).changes);
      const removedCalls = Number(this.db.prepare('DELETE FROM amazon_calls WHERE created_at < ?').run(logCutoff).changes);
      this.savePolicy({ ...policy, logRetentionDays: Math.max(365, policy.logRetentionDays), lastCleanupAt: new Date(now).toISOString() });
      this.db.exec('COMMIT'); result = { removedDrafts, removedSchemas, removedCalls };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // secure_delete clears freed pages; a successful checkpoint also removes
    // their previous WAL versions. Active readers may safely defer truncation.
    this.db.exec('PRAGMA busy_timeout = 0');
    try { this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); }
    finally { this.db.exec('PRAGMA busy_timeout = 5000'); }
    return result;
  }
}
