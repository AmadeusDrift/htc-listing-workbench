import type { DatabaseSync } from 'node:sqlite';
import type { AmazonDraft, AmazonTarget } from '../../shared/amazon-contracts.ts';
import type { FollowupReason, FollowupRecord, FollowupSummary, ListingObservation } from '../../shared/followup-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { identifier } from '../../shared/validation.ts';
import { openDatabase } from '../database.ts';
import { FOLLOWUP_OFFSETS, isPlatformReviewIssue, followupDraftFingerprint, validateFollowupRecord } from './records.ts';

/** Deliberately excludes every Amazon mutation operation. */
export interface FollowupAmazon {
  getDraft(id: string): AmazonDraft;
  executionTargetScope(id: string): { target: AmazonTarget; generation: number };
  readListing(input: { id: string; revision: number }, beforeSend?: () => void): Promise<AmazonDraft>;
  getListingObservation?(id: string): ListingObservation | null;
}
export interface FollowupDependencies {
  /** Main-only admission boundary; excluded historical records remain strictly read-only. */
  canManageDraft?: (draftId: string) => boolean;
  now?: () => number;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  getObservation?: (draftId: string) => ListingObservation | null;
}
class ScopeError extends UserFacingError {
  reason: FollowupReason;
  constructor(reason: FollowupReason, message: string) { super(message); this.reason = reason; }
}
const pending = (record: FollowupRecord) => ['WAITING','PROCESSING'].includes(record.status) && record.nextDueAt !== null;
const uncertain = (draft: AmazonDraft) => ['UNKNOWN','SUBMITTING'].includes(draft.state);
const timestamp = (value: number) => new Date(value).toISOString();
const identifierCode = (value: unknown): string | null => typeof value === 'string' && /^[A-Z0-9]{10}$/.test(value) ? value : null;

/** Accepted submission completion and delayed remote verification have separate lifecycles. */
export class FollowupService {
  private db: DatabaseSync;
  private amazon: FollowupAmazon;
  private now: () => number;
  private setTimer: NonNullable<FollowupDependencies['setTimeout']>;
  private clearTimer: NonNullable<FollowupDependencies['clearTimeout']>;
  private getObservation: NonNullable<FollowupDependencies['getObservation']> | undefined;
  private canManageDraft: (draftId: string) => boolean;
  private records = new Map<string, FollowupRecord>();
  private timer: unknown = undefined;
  private worker: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  private started = false;
  private paused = false;
  private activeDraftId: string | null = null;

  constructor(directory: string, amazon: FollowupAmazon, dependencies: FollowupDependencies = {}) {
    this.db = openDatabase(directory); this.amazon = amazon; this.now = dependencies.now ?? Date.now;
    this.setTimer = dependencies.setTimeout ?? ((callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); timer.unref(); return timer; });
    this.clearTimer = dependencies.clearTimeout ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.getObservation = dependencies.getObservation ?? (amazon.getListingObservation ? id => amazon.getListingObservation!(id) : undefined);
    this.canManageDraft = dependencies.canManageDraft ?? (() => true);
    try {
      for (const row of this.db.prepare('SELECT id,record_json FROM listing_followups ORDER BY rowid').all()) {
        const record = validateFollowupRecord(JSON.parse(String(row.record_json)));
        if (record.id !== row.id || this.records.has(record.draftId)) throw new UserFacingError('延迟回读记录身份不一致');
        this.records.set(record.draftId, record);
        if (!this.canManageDraft(record.draftId)) continue;
        // Migrate legacy 48h schedules and premature attempt-based expiry using the immutable submission clock.
        if (!record.requeryPending && record.submittedAt && (pending(record) || record.status === 'PROCESSING' || record.reason === 'EXPIRED')) {
          const deadline = Date.parse(record.submittedAt) + FOLLOWUP_OFFSETS.at(-1)!;
          if (this.now() >= deadline) this.attention(record, 'EXPIRED', '原提交已满 24 小时，仍未确认处理完成；可继续查询，禁止重复提交');
          else if (record.reason === 'EXPIRED' || record.nextDueAt === null || Date.parse(record.nextDueAt) > deadline) {
            record.status = record.attempts ? 'PROCESSING' : 'WAITING'; record.reason = null; record.error = null;
            record.nextDueAt = timestamp(FOLLOWUP_OFFSETS.map(offset => Date.parse(record.submittedAt!) + offset).find(time => time > this.now())!);
            this.save(record);
          }
        }
      }
    } catch (error) { this.db.close(); throw error; }
  }
  private ensureOpen(): void { if (this.closed || this.closing) throw new UserFacingError('延迟回读服务正在停止或已关闭'); }
  private find(draftId: string): FollowupRecord { this.ensureOpen(); const found = this.records.get(identifier(draftId)); if (!found) throw new UserFacingError('延迟回读记录不存在'); return found; }
  private save(record: FollowupRecord): void {
    this.assertManaged(record.draftId);
    record.revision++; record.updatedAt = timestamp(this.now()); validateFollowupRecord(record);
    this.db.prepare('INSERT INTO listing_followups(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(record.id, JSON.stringify(record));
  }
  private assertManaged(id: string): void { if (!this.canManageDraft(id)) throw new UserFacingError('受控验收窗口不能修改或调度其他草稿'); }
  private attention(record: FollowupRecord, reason: FollowupReason, error: string): void {
    delete record.requeryPending;
    record.status = 'NEEDS_ATTENTION'; record.reason = reason; record.error = error.slice(0, 500); record.nextDueAt = null; this.save(record);
  }
  list(): FollowupRecord[] { this.ensureOpen(); return [...this.records.values()].reverse().map(record => structuredClone(record)); }
  get(draftId: string): FollowupRecord { return structuredClone(this.find(draftId)); }
  get busy(): boolean { return this.worker !== null; }
  summary(): FollowupSummary {
    const records = this.list(), dates = records.filter(pending).map(record => record.nextDueAt!).sort();
    return { total: records.length, waiting: records.filter(record => record.status === 'WAITING').length, processing: records.filter(record => record.status === 'PROCESSING').length,
      ready: records.filter(record => record.status === 'READY').length, needsAttention: records.filter(record => record.status === 'NEEDS_ATTENTION').length, nextDueAt: dates[0] ?? null };
  }
  private scope(record: FollowupRecord, allowGenerationChange = false): AmazonDraft {
    let draft: AmazonDraft;
    try { draft = this.amazon.getDraft(record.draftId); } catch { throw new ScopeError('DRAFT_CHANGED', '原草稿不存在或已清理，请人工核对'); }
    if (draft.id !== record.draftId || draft.productId !== record.productId || draft.variantId !== record.variantId || draft.sku !== record.sku
      || draft.targetId !== record.targetId || draft.sellerId !== record.sellerId || draft.marketplaceId !== record.marketplaceId || draft.mode !== record.mode
      || draft.revision !== record.draftRevision || followupDraftFingerprint(draft) !== record.draftFingerprint) throw new ScopeError('DRAFT_CHANGED', '原草稿、SKU 或提交内容已变化；此回读计划已停止');
    if (uncertain(draft)) throw new ScopeError('UNKNOWN_WRITE', '提交结果未知；请人工核对，禁止自动重放提交');
    if (!draft.submittedAt) throw new ScopeError('DRAFT_CHANGED', '原草稿没有已接受的提交，不能自动回读');
    let scope: ReturnType<FollowupAmazon['executionTargetScope']>;
    try { scope = this.amazon.executionTargetScope(record.targetId); } catch { throw new ScopeError('TARGET_UNAVAILABLE', '原店铺授权不可用，请核对后重新安排回读'); }
    const target = scope.target;
    if (target.id !== record.targetId || target.mode !== record.mode || target.sellerId !== record.sellerId || target.marketplaceId !== record.marketplaceId
      || !allowGenerationChange && scope.generation !== record.targetGeneration) throw new ScopeError('TARGET_CHANGED', '店铺身份或授权配置已变化；请核对后重新安排回读');
    if (!target.configured || target.paused) throw new ScopeError('TARGET_UNAVAILABLE', '店铺授权不可用或已暂停；请核对后重新安排回读');
    return draft;
  }
  schedule(draftId: string): FollowupRecord {
    this.ensureOpen(); const id = identifier(draftId), existing = this.records.get(id); if (existing) return structuredClone(existing);
    this.assertManaged(id);
    const draft = this.amazon.getDraft(id);
    if (draft.mode !== 'live') throw new UserFacingError('演示草稿不使用正式店铺延迟回读');
    if (!draft.submittedAt && !uncertain(draft)) throw new UserFacingError('只有已提交的草稿可以安排回读');
    const at = timestamp(this.now()); let generation = 0;
    try { generation = this.amazon.executionTargetScope(draft.targetId).generation; } catch { /* Persist the unavailable target for attention. */ }
    const record: FollowupRecord = { id, draftId: id, revision: 0, productId: draft.productId, variantId: draft.variantId, sku: draft.sku,
      targetId: draft.targetId, targetName: draft.targetName, sellerId: draft.sellerId, marketplaceId: draft.marketplaceId, mode: draft.mode, targetGeneration: generation,
      draftRevision: draft.revision, draftFingerprint: followupDraftFingerprint(draft), submittedAt: draft.submittedAt, submissionId: draft.submissionId,
      status: 'WAITING', reason: null, attempts: 0, nextDueAt: draft.submittedAt ? timestamp(Date.parse(draft.submittedAt) + FOLLOWUP_OFFSETS[0]) : null,
      lastAttemptAt: null, checkedAt: null, listingState: draft.state, statuses: [], issues: [], asin: null, fnsku: null, error: null, createdAt: at, updatedAt: at };
    try { this.scope(record); this.save(record); }
    catch (error) { if (!(error instanceof ScopeError)) throw error; this.attention(record, error.reason, error.message); }
    this.records.set(id, record); this.arm(); return structuredClone(record);
  }
  /** Explicit user action is required to refresh a generation; schedule() can never silently do so. */
  reschedule(draftId: string): FollowupRecord {
    const record = this.find(draftId); if (this.activeDraftId === record.draftId) throw new UserFacingError('此回读正在处理，请等待完成');
    this.assertManaged(record.draftId);
    this.scope(record, true); record.targetGeneration = this.amazon.executionTargetScope(record.targetId).generation;
    record.status = record.attempts ? 'PROCESSING' : 'WAITING'; record.reason = null; record.error = null;
    record.requeryPending = true;
    record.nextDueAt = timestamp(Math.max(this.now(), Date.parse(record.submittedAt!) + FOLLOWUP_OFFSETS[0]));
    this.save(record); this.arm(); return structuredClone(record);
  }
  start(): void { this.ensureOpen(); this.paused = false; this.started = true; this.arm(); }
  /** Maintenance can pause before replacing the workspace; an existing request may only settle. */
  pause(): void { this.ensureOpen(); this.paused = true; this.cancelTimer(); }
  resume(): void { this.start(); }
  holdForMaintenance(): () => void {
    this.ensureOpen(); const paused = this.paused; this.pause(); let released = false;
    return () => {
      if (released) return; released = true;
      if (this.closed || this.closing) return;
      this.paused = paused; this.arm();
    };
  }
  private cancelTimer(): void { if (this.timer !== undefined) { this.clearTimer(this.timer); this.timer = undefined; } }
  private arm(): void {
    this.cancelTimer(); if (!this.started || this.paused || this.closing || this.closed || this.worker) return;
    const next = [...this.records.values()].filter(record => this.canManageDraft(record.draftId) && pending(record)).map(record => Date.parse(record.nextDueAt!)).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined; if (this.paused || this.closing || this.closed || !this.started) return;
      void this.runDue().catch(() => { this.started = false; this.cancelTimer(); });
    }, Math.min(2_147_483_647, Math.max(0, next - this.now())));
  }
  async runDue(): Promise<void> {
    this.ensureOpen(); if (this.paused) throw new UserFacingError('延迟回读已暂停'); if (this.worker) return this.worker;
    this.cancelTimer(); this.worker = this.processDue().finally(() => { this.worker = null; this.arm(); }); return this.worker;
  }
  private async processDue(): Promise<void> {
    const due = [...this.records.values()].filter(record => this.canManageDraft(record.draftId) && pending(record) && Date.parse(record.nextDueAt!) <= this.now()).sort((a, b) => a.nextDueAt!.localeCompare(b.nextDueAt!));
    for (const record of due) {
      if (this.paused || this.closing || this.closed) return;
      if (!this.canManageDraft(record.draftId)) continue;
      this.activeDraftId = record.draftId;
      try { await this.read(record); } finally { this.activeDraftId = null; }
    }
  }
  private async read(record: FollowupRecord): Promise<void> {
    let draft: AmazonDraft;
    try { draft = this.scope(record); }
    catch (error) { if (!(error instanceof ScopeError)) throw error; this.attention(record, error.reason, error.message); return; }
    const offsets = FOLLOWUP_OFFSETS;
    const started = this.now(), next = offsets.map(offset => Date.parse(record.submittedAt!) + offset).find(time => time > started);
    delete record.requeryPending;
    record.status = 'PROCESSING'; record.attempts++; record.lastAttemptAt = timestamp(started); record.reason = null; record.error = null;
    record.nextDueAt = next !== undefined ? timestamp(next) : null;
    this.save(record);
    try {
      const result = await this.amazon.readListing({ id: draft.id, revision: draft.revision }, () => {
        if (this.closing || this.closed) throw new UserFacingError('工作台正在停止，本次延迟回读尚未发送');
        if (this.paused) throw new UserFacingError('延迟回读已暂停，本次请求尚未发送');
        this.assertManaged(record.draftId);
        this.scope(record);
      });
      this.scope(record);
      if (result.id !== record.draftId || followupDraftFingerprint(result) !== record.draftFingerprint) throw new ScopeError('DRAFT_CHANGED', '回读返回的草稿身份已变化，请人工核对');
      record.listingState = result.state; record.issues = structuredClone(result.listingIssues); record.statuses = [...result.statuses]; record.checkedAt = result.checkedAt;
      record.asin = null; record.fnsku = null;
      if (uncertain(result)) { this.attention(record, 'UNKNOWN_WRITE', '提交结果未知；存在远端商品也不能证明上次写入结果，请人工核对'); return; }
      const observation = this.getObservation?.(record.draftId);
      if (observation) {
        if (observation.draftId !== record.draftId || observation.targetId !== record.targetId || observation.sellerId !== record.sellerId
          || observation.marketplaceId !== record.marketplaceId || observation.sku !== record.sku || observation.checkedAt !== result.checkedAt) throw new ScopeError('DRAFT_CHANGED', '回读凭据与原 SKU 或站点不一致，请人工核对');
        record.asin = identifierCode(observation.asin); record.fnsku = identifierCode(observation.fnsku);
        record.statuses = [...observation.statuses]; record.issues = structuredClone(observation.issues);
      }
      if (record.issues.some(issue => issue.severity === 'ERROR' && !isPlatformReviewIssue(issue))) { this.attention(record, 'LISTING_ERRORS', 'Amazon 返回需要处理的问题，请查看草稿问题列表'); return; }
      if (result.salesPlan?.parentage === 'CHILD' && observation?.familyRelationship?.status === 'MISMATCHED') { this.attention(record, 'LISTING_ERRORS', 'Amazon 返回的父 SKU 或变体主题与计划不一致'); return; }
      // DISCOVERABLE/ASIN can coexist with this review hold. Preserve the original ERROR,
      // defer only its exact code, and never promote it to READY while the hold remains.
      if (record.issues.some(isPlatformReviewIssue)) { this.continueLater(record, 'Amazon 正在审核此商品（100521），将在提交后最多 24 小时内继续回读；当前尚未确认完成', 'PLATFORM_REVIEW'); return; }
      if(result.salesPlan?.parentage==='CHILD'&&observation?.familyRelationship?.status!=='MATCHED'){
        this.continueLater(record,'等待 Amazon 确认父子体关联');
        return;
      }
      // A matched ASIN or explicit remote status establishes a listing, never inbound eligibility.
      if ((!this.getObservation || observation) && record.checkedAt && Date.parse(record.checkedAt) >= started && (record.asin || record.statuses.some(status => ['BUYABLE','DISCOVERABLE'].includes(status)))) {
        record.status = 'READY'; record.reason = null; record.error = null; record.nextDueAt = null; this.save(record); return;
      }
      this.continueLater(record, null);
    } catch (error) {
      if (error instanceof ScopeError) { this.attention(record, error.reason, error.message); return; }
      try { this.scope(record); } catch (scopeError) { if (!(scopeError instanceof ScopeError)) throw scopeError; this.attention(record, scopeError.reason, scopeError.message); return; }
      this.continueLater(record, error instanceof UserFacingError ? error.message.slice(0, 300) : '回读暂未完成，将按计划重试');
    }
  }
  private continueLater(record: FollowupRecord, error: string | null, reason: 'READ_FAILED' | 'PLATFORM_REVIEW' = 'READ_FAILED'): void {
    const offsets = FOLLOWUP_OFFSETS;
    if (record.nextDueAt === null || Date.parse(record.nextDueAt) <= this.now()) {
      const next = offsets.map(offset => Date.parse(record.submittedAt!) + offset).find(time => time > this.now());
      record.nextDueAt = next !== undefined ? timestamp(next) : null;
    }
    if (record.nextDueAt === null) { this.attention(record, 'EXPIRED', '已到自动回读检查期限，仍未得到明确建档状态；请人工核对或重新安排回读'); return; }
    record.status = 'PROCESSING'; record.reason = error ? reason : null; record.error = error; this.save(record);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing; if (this.closed) return Promise.resolve();
    this.started = false; this.cancelTimer();
    this.closing = (async () => { try { await this.worker; } finally { this.db.close(); this.closed = true; } })();
    return this.closing;
  }
}
