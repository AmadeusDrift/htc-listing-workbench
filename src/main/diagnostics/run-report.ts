import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RunCallReport, RunDiagnosticReport, RunReportContext, RunReportQuery } from '../../shared/run-report-contracts.ts';
import type { RunEvidence } from '../../shared/run-evidence-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { evidenceCode, evidenceId, evidenceItemKey, evidenceSku, evidenceTime, validateRunEvidence } from './run-evidence.ts';
import { readErrorEvidence } from '../error-evidence.ts';
import { classificationReferences } from './classification-references.ts';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = (code = 'RUN_REPORT_INVALID_RECORD'): never => { throw new UserFacingError(code); };
const time = (v: unknown): string | null => evidenceTime(v) ? v : null;
const id = (v: unknown): string | null => evidenceId(v) ? v : null;
const integer = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const sha = (v: unknown, size = 64): string | null => typeof v === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(v) ? v : null;
const http = (v: unknown) => integer(v) !== null && Number(v) >= 100 && Number(v) <= 599 ? Number(v) : null;
/** JSON paths and columns are internal constants, never supplied by renderer. Returns scalar fields only. */
function projection(path: string, column = 'record_json'): string { return `CASE WHEN json_valid(${column}) THEN json_extract(${column},'$.${path}') ELSE NULL END`; }
function parseQuery(raw: unknown): RunReportQuery & { pageSize: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return fail('RUN_REPORT_INVALID_QUERY');
  const q = raw as RunReportQuery;
  if (Reflect.ownKeys(q).some(k => typeof k !== 'string') || Object.values(Object.getOwnPropertyDescriptors(q)).some(d => !('value' in d))) return fail('RUN_REPORT_INVALID_QUERY');
  if (Object.keys(q).some(k => !['taskId','sku','pageSize','cursor'].includes(k)) || !evidenceId(q.taskId) || q.sku !== undefined && !evidenceSku(q.sku)
    || q.pageSize !== undefined && (!Number.isSafeInteger(q.pageSize) || q.pageSize < 1 || q.pageSize > 100)
    || q.cursor !== undefined && (typeof q.cursor !== 'string' || q.cursor.length > 2048 || !q.cursor.length)) return fail('RUN_REPORT_INVALID_QUERY');
  return { ...q, pageSize: q.pageSize ?? 20 };
}
interface ScopeItem { key: string; productId: string; sku: string; draftId: string | null }
/** Queries use the caller's actual open connection. No openDatabase, migration, recovery or write. */
export class RunReportReader {
  private readonly secret = randomBytes(32);
  private readonly db: DatabaseSync;
  private readonly context: RunReportContext;
  constructor(db: DatabaseSync, context: RunReportContext = {}) { this.db = db; this.context = context; }
  private cursor(value: { scope: string; after: number; signature: string }): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return body+'.'+createHmac('sha256', this.secret).update(body).digest('base64url');
  }
  private decode(cursor: string, scope: string): { after: number; signature: string } {
    try {
      const [body, sign, extra] = cursor.split('.');
      if (extra || !body || !/^[a-zA-Z0-9_-]+$/.test(body) || !/^[a-zA-Z0-9_-]{43}$/.test(sign ?? '')) return fail('RUN_REPORT_CURSOR_RELOAD');
      const actual = Buffer.from(sign, 'base64url'), expected = createHmac('sha256', this.secret).update(body).digest();
      if (!timingSafeEqual(actual, expected)) return fail('RUN_REPORT_CURSOR_RELOAD');
      const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (Object.keys(v).sort().join() !== 'after,scope,signature' || v.scope !== scope || integer(v.after) === null || !sha(v.signature)) return fail('RUN_REPORT_CURSOR_RELOAD');
      return v;
    } catch { return fail('RUN_REPORT_CURSOR_RELOAD'); }
  }
  query(raw: unknown, context = this.context): RunDiagnosticReport { return this.read(parseQuery(raw), false, context); }
  export(raw: unknown, context = this.context): RunDiagnosticReport {
    const q = parseQuery(raw); if (q.cursor !== undefined) return fail('RUN_REPORT_INVALID_QUERY');
    return this.read(q, true, context);
  }
  private read(q: RunReportQuery & { pageSize: number }, full: boolean, context: RunReportContext): RunDiagnosticReport {
    const scope = hash([q.taskId, q.sku ?? null]), cursor = q.cursor ? this.decode(q.cursor, scope) : null;
    // Synchronous read transaction guarantees one SQLite snapshot. No promise/file/network work inside.
    if (this.db.isTransaction) return fail('RUN_REPORT_CONNECTION_BUSY');
    this.db.exec('BEGIN');
    try { const result = this.snapshot(q, scope, cursor, full, context); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); if (error instanceof UserFacingError) throw error; return fail(); }
  }
  private snapshot(q: RunReportQuery & { pageSize: number }, scope: string, cursor: { after: number; signature: string } | null, full: boolean, context: RunReportContext): RunDiagnosticReport {
    const task = this.db.prepare(`SELECT ${projection('id')} id,${projection('revision')} revision FROM automatic_listing_tasks WHERE id=?`).get(q.taskId);
    if (!task || task.id !== q.taskId) return fail('RUN_REPORT_TASK_MISSING');
    const rawItems = this.db.prepare(`SELECT json_extract(i.value,'$.key') key,json_extract(i.value,'$.productId') productId,json_extract(i.value,'$.sku') sku,json_extract(i.value,'$.draftId') draftId,json_extract(i.value,'$.productRevision') productRevision,json_extract(i.value,'$.classification') classification
      FROM automatic_listing_tasks t,json_each(t.record_json,'$.items') i WHERE t.id=?`).all(q.taskId);
    const items: ScopeItem[] = rawItems.filter(row => q.sku === undefined || row.sku === q.sku).map(row => {
      if (!evidenceItemKey(row.key) || !evidenceId(row.productId) || !evidenceSku(row.sku) || row.draftId !== null && !evidenceId(row.draftId)) return fail();
      return { key: row.key, productId: row.productId, sku: row.sku, draftId: id(row.draftId) };
    });
    if (q.sku !== undefined && !items.length) return fail('RUN_REPORT_SKU_MISSING');
    const classification = classificationReferences(this.db,rawItems.filter(row=>q.sku===undefined||row.sku===q.sku).map(row=>({key:String(row.key),productId:String(row.productId),sku:String(row.sku),productRevision:row.productRevision,classification:row.classification})));
    const classifiedCalls = new Map(classification.map(ref=>[ref.callId,ref]));
    const drafts = new Set(items.flatMap(i => i.draftId ? [i.draftId] : [])), keys = new Set(items.map(i => i.key)), products = new Set(items.map(i => i.productId));
    const events: RunEvidence[] = this.db.prepare(`SELECT detail_json FROM audit_events WHERE action='run.evidence' AND ${projection('taskId','detail_json')}=? ORDER BY rowid`).all(q.taskId).map(row => {
      if (typeof row.detail_json !== 'string' || row.detail_json.length > 4096) return fail();
      return validateRunEvidence(JSON.parse(row.detail_json));
    }).filter(e => q.sku === undefined || e.sku === q.sku || e.itemKey !== undefined && keys.has(e.itemKey));
    const byCall = new Map<string, RunEvidence[]>();
    for (const e of events) if (e.callId) { const list = byCall.get(e.callId) ?? []; list.push(e); byCall.set(e.callId, list); }
    const journalCalls = new Map<string, { operationId: string; draftId: string }>();
    for (const draftId of drafts) for (const op of this.db.prepare(`SELECT o.id operationId,json_extract(r.value,'$.candidate.id') candidate,json_extract(r.value,'$.review.id') review
      FROM listing_completion_operations o,json_each(o.record_json,'$.rounds') r WHERE ${projection('draftId','o.record_json')}=?`).all(draftId)) {
      if (!evidenceId(op.operationId)) continue;
      for (const kind of ['candidate','review']) if (evidenceId(op[kind])) journalCalls.set(String(op[kind]), { operationId: op.operationId, draftId });
    }
    const allCalls = this.db.prepare(`SELECT rowid,id,${projection('id')} identity,${projection('productId')} productId,${projection('presentationContext.draftId')} draftId,
      ${projection('startedAt')} startedAt,${projection('status')} status,${projection('errorCode')} errorCode,${projection('responseReceived')} responseReceived FROM ai_calls ORDER BY rowid`).all();
    const selected = allCalls.filter(c => classifiedCalls.has(String(c.id)) || byCall.has(String(c.id)) || journalCalls.has(String(c.id)) || typeof c.draftId === 'string' && drafts.has(c.draftId));
    // Image calls also carry durable IDs in workflow attempts; inspect only the selected drafts.
    const imageIds = new Set<string>();
    const imageInfo = new Map<string, { draftId: string; candidateId: string | null; adopted: boolean }>();
    for (const draftId of drafts) {
      for (const row of this.db.prepare(`SELECT json_extract(a.value,'$.requestId') requestId,json_extract(a.value,'$.candidateId') candidateId,json_extract(a.value,'$.state') state,json_extract(s.value,'$.approvedAssetId') approvedAssetId
        FROM image_workflow_runs r,json_each(r.record_json,'$.slots') s,json_each(s.value,'$.attempts') a WHERE ${projection('draftId','r.record_json')}=?`).all(draftId)) if (evidenceId(row.requestId)) {
          imageIds.add(row.requestId); imageInfo.set(row.requestId, { draftId, candidateId: id(row.candidateId), adopted: row.state === 'PASSED' && evidenceId(row.approvedAssetId) });
        }
    }
    for (const e of events) if (e.callId && !selected.some(c => c.id === e.callId)) imageIds.add(e.callId);
    for (const callId of imageIds) if (!selected.some(c => c.id === callId)) {
      const row = this.db.prepare(`SELECT rowid,id,${projection('id')} identity,${projection('productId')} productId,${projection('createdAt')} startedAt FROM ai_image_requests WHERE id=?`).get(callId);
      if (row) selected.push({ ...row, draftId: null, status: null, errorCode: null, responseReceived: null });
    }
    const adoptedIds = new Set(classification.map(ref=>ref.resultId));
    let submittedSkus = 0, buyableSkus = 0, demoSubmittedSkus = 0;
    for (const draftId of drafts) {
      const d = this.db.prepare(`SELECT ${projection('draft.id')} id,${projection('draft.sku')} sku,${projection('draft.mode')} mode,${projection('draft.submittedAt')} submittedAt,
        ${projection('draft.submissionId')} submissionId,${projection('draft.checkedAt')} checkedAt,${projection('draft.statuses')} statuses FROM listing_drafts WHERE id=?`).get(draftId);
      if (d && d.id === draftId && items.some(i => i.draftId === draftId && i.sku === d.sku)) {
        if (time(d.submittedAt) && typeof d.submissionId === 'string' && d.submissionId.length > 0) { if (d.mode === 'live') submittedSkus++; else if (d.mode === 'demo') demoSubmittedSkus++; }
        if (d.mode === 'live' && time(d.checkedAt) && typeof d.statuses === 'string' && JSON.parse(d.statuses).includes('BUYABLE')) buyableSkus++;
        for (const a of this.db.prepare("SELECT json_extract(a.value,'$.suggestionResultId') suggestion,json_extract(a.value,'$.reviewResultId') review FROM listing_drafts d,json_each(d.record_json,'$.draft.fieldAdoptions') a WHERE d.id=?").all(draftId)) for (const key of ['suggestion','review']) if (evidenceId(a[key])) adoptedIds.add(String(a[key]));
      }
    }
    const calls: RunCallReport[] = [];
    let savedReceipts = 0, validResults = 0, adoptedResults = 0;
    for (const c of selected) {
      if (!evidenceId(c.id) || c.identity !== c.id) return fail();
      const evidence = byCall.get(c.id) ?? [], latest = <K extends keyof RunEvidence>(key: K): RunEvidence[K] | undefined => evidence.findLast(e => e[key] !== undefined)?.[key];
      const receipt = this.db.prepare(`SELECT id,${projection('id')} identity,${projection('callId')} callId,${projection('status')} status,${projection('receivedAt')} receivedAt,${projection('byteSize')} byteSize FROM ai_provider_receipts WHERE ${projection('callId')}=? ORDER BY rowid DESC LIMIT 1`).get(c.id);
      const retainedReceipt = receipt && receipt.identity === receipt.id && sha(receipt.id) && receipt.callId === c.id && http(receipt.status) !== null && time(receipt.receivedAt) && integer(receipt.byteSize) !== null && Number(receipt.byteSize) > 0 ? receipt : null;
      if (retainedReceipt) savedReceipts++;
      const results = this.db.prepare(`SELECT id,${projection('id')} identity FROM ai_results WHERE ${projection('callId')}=? ORDER BY rowid`).all(c.id);
      const resultIds = results.filter(r => evidenceId(r.id) && r.identity === r.id).map(r => String(r.id));
      const image = imageInfo.get(c.id); if (image?.candidateId && !resultIds.includes(image.candidateId)) resultIds.push(image.candidateId);
      validResults += resultIds.length;
      const adopted = resultIds.some(r => adoptedIds.has(r)) || evidence.some(e => e.event === 'RESULT_ADOPTED') || image?.adopted === true;
      // Recovery may derive multiple immutable results from one paid call. The
      // draft records the exact adopted result; a call-level event cannot adopt all.
      adoptedResults += resultIds.filter(r => adoptedIds.has(r) || resultIds.length === 1 && evidence.some(e => e.event === 'RESULT_ADOPTED') || image?.adopted && r === image.candidateId).length;
      let certainty = latest('certainty') ?? null;
      if (certainty === 'NOT_SENT' && !retainedReceipt && ['RUNNING','FAILED'].includes(String(c.status))) certainty = 'SENT_UNKNOWN';
      if (resultIds.length) certainty = 'RECEIVED_VALID';
      // The read-only report projects saved metadata, not verified private body
      // bytes. OUTPUT_INVALID/HTTP status cannot replace explicit transport
      // certainty or prove an omitted, empty or incomplete response resolved.
      else if (!certainty) certainty = 'SENT_UNKNOWN';
      const operation = journalCalls.get(c.id), classified = classifiedCalls.get(c.id), draftId = latest('draftId') ?? id(c.draftId) ?? operation?.draftId ?? image?.draftId ?? null, item = items.find(i => latest('itemKey') === i.key) ?? (draftId ? items.find(i => draftId === i.draftId) : undefined) ?? classified?.item;
      if (c.productId && item && c.productId !== item.productId || latest('itemKey') && !keys.has(latest('itemKey')!)) return fail();
      calls.push({ callId: c.id, operationId: latest('operationId') ?? operation?.operationId ?? classified?.operationId ?? null, receiptId: retainedReceipt ? String(retainedReceipt.id) : null, draftId,
        itemKey: item?.key ?? null, sku: item?.sku ?? null, stage: latest('stage') ?? (classified ? 'CLASSIFY' : image ? 'image-generation' : null), association: evidence.length ? 'TASK_EVENT' : classified ? 'CLASSIFICATION_REFERENCE' : 'DRAFT_REFERENCE',
        startedAt: time(c.startedAt), receivedAt: retainedReceipt ? time(retainedReceipt.receivedAt) : null, certainty,
        abortSource: latest('abortSource') ?? null, errorCode: latest('errorCode') ?? (evidenceCode(c.errorCode) ? c.errorCode : null),
        httpStatus: retainedReceipt ? http(retainedReceipt.status) : latest('httpStatus') ?? null, receivedBytes: latest('receivedBytes') ?? null, resultIds, adopted,
        nextAction: adopted ? 'CONTINUE_FROM_ADOPTED_RESULT' : certainty === 'SENT_UNKNOWN' ? 'VERIFY_ORIGINAL_REQUEST' : certainty === 'RECEIVED_VALID' ? 'INSPECT_SAVED_RESULT' : ['RECEIVED_INVALID','DEFINITIVE_REJECTION'].includes(certainty ?? '') ? 'INSPECT_REJECTION_AND_BUDGET' : 'INSPECT_LEGACY_EVIDENCE',
        missing: [...(!evidence.length && !classified ? ['LEGACY_TASK_CALL_LINK','LEGACY_STAGE'] : []), ...(!latest('operationId') && !operation?.operationId && !classified?.operationId ? ['LEGACY_OPERATION_ID'] : []), ...(!time(c.startedAt) ? ['LEGACY_REQUEST_TIME'] : [])], evidence });
    }
    const platform: RunDiagnosticReport['platform'] = [];
    for (const draftId of drafts) for (const row of this.db.prepare(`SELECT id,${projection('operation','exchange_json')} operation,${projection('at','exchange_json')} at,${projection('status','exchange_json')} status,${projection('requestId','exchange_json')} requestId FROM amazon_exchanges WHERE draft_id=? ORDER BY rowid`).all(draftId)) {
      if (evidenceId(row.id) && ['preview','submit','readback'].includes(String(row.operation))) platform.push({ id: row.id, draftId, stage: row.operation as 'preview'|'submit'|'readback', at: time(row.at), httpStatus: http(row.status), requestId: typeof row.requestId === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(row.requestId) && !/\bsk-/i.test(row.requestId) ? row.requestId : null });
    }
    const counts = { totalCalls: calls.length, savedReceipts, validResults, adoptedResults, submittedSkus, buyableSkus, demoSubmittedSkus,
      previewRequests: platform.filter(p => p.stage === 'preview').length, submissionRequests: platform.filter(p => p.stage === 'submit').length, readbackRequests: platform.filter(p => p.stage === 'readback').length, evidenceEvents: events.length };
    const errors: RunDiagnosticReport['errors'] = [];
    for (const row of this.db.prepare(`SELECT detail_json,created_at FROM audit_events WHERE action='operation.failed' AND (${projection('taskId','detail_json')}=? OR ${projection('draftId','detail_json')} IN (${[...drafts].map(() => '?').join(',') || 'NULL'})) ORDER BY rowid`).all(q.taskId, ...drafts)) {
      if (typeof row.detail_json !== 'string' || row.detail_json.length > 8192) continue;
      let e; try { e = readErrorEvidence(JSON.parse(row.detail_json)); } catch { continue; }
      if (!e || q.sku !== undefined && e.sku !== q.sku && !(e.itemKey && keys.has(e.itemKey)) && !(e.draftId && drafts.has(e.draftId))) continue;
      errors.push({ stage: e.stage, code: e.diagnosticReason ?? e.code, at: time(row.created_at),
        ...(e.callId ? { callId: e.callId } : {}), ...(e.requestId ? { requestId: e.requestId } : {}), ...(e.abortSource ? { abortSource: e.abortSource } : {}), ...(e.certainty ? { certainty: e.certainty } : {}),
        ...(e.draftId ? { draftId: e.draftId } : {}), ...(e.itemKey ? { itemKey: e.itemKey } : {}), ...(e.sku ? { sku: e.sku } : {}), ...(e.operationId ? { operationId: e.operationId } : {}) });
    }
    const signature = hash([task.revision, calls, events, platform, counts, errors]);
    if (cursor && (cursor.signature !== signature || cursor.after > calls.length)) return fail('RUN_REPORT_CURSOR_RELOAD');
    const after = cursor?.after ?? 0, pageCalls = full ? calls : calls.slice(after, after+q.pageSize), next = !full && after+q.pageSize < calls.length ? this.cursor({ scope, signature, after: after+q.pageSize }) : null;
    const unassigned = allCalls.filter(c => typeof c.productId === 'string' && products.has(c.productId) && !selected.some(s => s.id === c.id)).length;
    const file = this.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    return { reportVersion: 1, generatedAt: new Date().toISOString(), provenance: {
      appVersion: typeof context.appVersion === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(context.appVersion) ? context.appVersion : null,
      sourceCommit: sha(context.sourceCommit,40), sourceDigest: sha(context.sourceDigest), buildDigest: sha(context.buildDigest), workspaceId: hash(['main', file ?? '']), connection: 'CURRENT_PROCESS', consistentSnapshot: true },
      scope: { taskId: q.taskId, taskRevision: integer(task.revision), sku: q.sku ?? null }, counts,
      coverage: { missing: [...(unassigned || calls.some(c => c.association === 'DRAFT_REFERENCE') ? ['LEGACY_TASK_CALL_LINK'] : []), ...(!sha(context.sourceCommit,40) ? ['BUILD_SOURCE_NOT_SAVED'] : [])], unassignedProductCalls: unassigned, draftReferenceCalls: calls.filter(c => c.association === 'DRAFT_REFERENCE').length, receiptIntegrity: 'SAVED_METADATA_ONLY' },
      calls: pageCalls, events: full ? events : events.filter(e => !e.callId || pageCalls.some(c => c.callId === e.callId)), platform, errors, page: { total: calls.length, returned: pageCalls.length, nextCursor: next, complete: full || !next && after === 0 } };
  }
}
