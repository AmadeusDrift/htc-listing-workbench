import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ABORT_SOURCES, REQUEST_CERTAINTIES, RUN_EVIDENCE_EVENTS } from '../../shared/run-evidence-contracts.ts';
import type { RunEvidence, TransportRunEvidence } from '../../shared/run-evidence-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { appendAuditEvent } from '../storage/audit.ts';

const fields = ['version','at','event','stage','taskId','itemKey','sku','operationId','callId','receiptId','draftId','slot','certainty','abortSource','errorCode','httpStatus','receivedBytes'];
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const evidenceId = (v: unknown): v is string => typeof v === 'string' && idPattern.test(v);
export const evidenceTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export const evidenceSku = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]|https?:\/\/|bearer\s|\bsk-[a-z0-9]|(?:api.?key|authorization|access.?token)\s*[:=]/i.test(v);
export const evidenceItemKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 110 && evidenceId(v.slice(0,36)) && v[36] === ':' && (evidenceId(v.slice(37)) || /^[a-f0-9]{64}$/i.test(v.slice(37)));
export const RUN_ERROR_CODES = ['UNKNOWN_LOCAL_ERROR','INVALID_INPUT','INVALID_CONFIG','NOT_CONFIGURED','DISABLED','CONFIG_CHANGED','SOURCE_CHANGED','IMAGE_INVALID','HOSTED_IMAGE_REQUIRED','ENCRYPTION_UNAVAILABLE','AUTH_FAILED','MODEL_REGION_RESTRICTED','ROUTING_FORBIDDEN','SERVICE_PERMISSION_REQUIRED','QUOTA_EXCEEDED','RATE_LIMITED','TIMEOUT','NETWORK_ERROR','PROVIDER_ERROR','OUTPUT_INVALID','BUSY','CANCELLED','INTERRUPTED','SERVICE_CLOSED','CATEGORY_SELECTION_MISSING','SOURCE_ASSET_REFERENCE_INVALID','IMAGE_PLAN_RESULT_UNKNOWN','IMAGE_PLAN_ATTEMPTS_EXHAUSTED','SCHEMA_TRANSIENT','RESPONSE_NOT_CONTENT','RESPONSE_SECRET_ECHO','RESPONSE_SIZE_LIMIT','RESPONSE_LENGTH_INVALID','RESPONSE_BODY_MISSING','RESPONSE_BODY_EMPTY','RESPONSE_UTF8_INVALID','RESPONSE_ENVELOPE_JSON_INVALID','RESPONSE_READ_FAILED','EACCES','EPERM','ENOENT','ENOSPC','EIO','EROFS','EMFILE','ENFILE','ENOMEM','SQLITE_BUSY','SQLITE_FULL','SQLITE_IOERR'] as const;
export function evidenceCode(v: unknown): v is string { return typeof v === 'string' && RUN_ERROR_CODES.includes(v as typeof RUN_ERROR_CODES[number]); }
const invalid = (): never => { throw new UserFacingError('RUN_EVIDENCE_INVALID'); };
/** Strict reader: no arbitrary payloads, accessor properties or unknown versions enter reports. */
export function validateRunEvidence(raw: unknown): RunEvidence {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).some(k => typeof k !== 'string') || Object.keys(descriptors).some(k => !fields.includes(k) || !('value' in descriptors[k]))) invalid();
  const r = raw as RunEvidence;
  if (r.version !== 1 || !evidenceTime(r.at) || !RUN_EVIDENCE_EVENTS.includes(r.event) || typeof r.stage !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(r.stage)) invalid();
  for (const key of ['taskId','operationId','callId','draftId'] as const) if (r[key] !== undefined && !evidenceId(r[key])) invalid();
  if (r.itemKey !== undefined && !evidenceItemKey(r.itemKey) || r.sku !== undefined && !evidenceSku(r.sku) || r.receiptId !== undefined && !(evidenceId(r.receiptId) || /^[a-f0-9]{64}$/.test(r.receiptId))) invalid();
  if (r.certainty !== undefined && !REQUEST_CERTAINTIES.includes(r.certainty) || r.abortSource !== undefined && !ABORT_SOURCES.includes(r.abortSource) || r.errorCode !== undefined && !evidenceCode(r.errorCode)) invalid();
  for (const [key,max,min] of [['slot',7,0],['httpStatus',599,100],['receivedBytes',Number.MAX_SAFE_INTEGER,0]] as const) if (r[key] !== undefined && (!Number.isSafeInteger(r[key]) || r[key]! < min || r[key]! > max)) invalid();
  return Object.fromEntries(Object.entries(r).filter(([,v]) => v !== undefined)) as unknown as RunEvidence;
}
export function validateTransportRunEvidence(raw: unknown): TransportRunEvidence {
  if (!raw || typeof raw !== 'object' || Reflect.ownKeys(raw).some(k => typeof k !== 'string' || !['at','event','certainty','abortSource','errorCode','httpStatus','receivedBytes'].includes(k))) return invalid();
  if (Object.getPrototypeOf(raw) !== Object.prototype || Object.values(Object.getOwnPropertyDescriptors(raw)).some(d => !('value' in d))) return invalid();
  const safe = validateRunEvidence({ version: 1, stage: 'transport', ...raw });
  if (!['DISPATCH_ATTEMPTED','HEADERS_RECEIVED','BODY_COMPLETED','STAGE_BLOCKED'].includes(safe.event)) invalid();
  const { version: _version, stage: _stage, ...event } = safe;
  return event as TransportRunEvidence;
}
/** The caller owns transaction timing; this tiny audit record rolls back with its reservation. */
export function appendRunEvidence(db: DatabaseSync, productId: string | null, raw: RunEvidence): void {
  const value = validateRunEvidence(raw);
  if (productId !== null && !evidenceId(productId)) invalid();
  appendAuditEvent(db, randomUUID(), productId, 'run.evidence', '运行阶段证据', JSON.stringify(value), value.at);
}
export function readRunEvidence(db: DatabaseSync): RunEvidence[] {
  return db.prepare("SELECT detail_json FROM audit_events WHERE action='run.evidence' ORDER BY rowid").all().map(row => {
    if (typeof row.detail_json !== 'string' || row.detail_json.length > 4096) invalid();
    return validateRunEvidence(JSON.parse(String(row.detail_json)));
  });
}
