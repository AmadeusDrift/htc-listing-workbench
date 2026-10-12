import { createHash } from 'node:crypto';
import type { AmazonDraft, ListingIssue } from '../../shared/amazon-contracts.ts';
import type { FollowupRecord } from '../../shared/followup-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { identifier, record } from '../../shared/validation.ts';

export const FOLLOWUP_OFFSETS = [30 * 60_000, 60 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000] as const;
/** All unresolved platform processing uses the original 24-hour deadline. */
export const PLATFORM_REVIEW_OFFSETS = FOLLOWUP_OFFSETS;
export const isPlatformReviewIssue = (issue: ListingIssue): boolean => issue.source === 'amazon' && issue.code === '100521';
const states = ['DRAFT','LOCAL_VALIDATED','AMAZON_VALIDATED','SUBMITTING','SUBMITTED','PROCESSING','BUYABLE','DISCOVERABLE','BLOCKED','UNKNOWN'];
const reasons = ['UNKNOWN_WRITE','TARGET_CHANGED','TARGET_UNAVAILABLE','DRAFT_CHANGED','LISTING_ERRORS','READ_FAILED','PLATFORM_REVIEW','EXPIRED'];
const string = (value: unknown, max: number, required = false): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0') && (!required || !!value.trim());
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && Number(value) >= min;
const date = (value: unknown): value is string => string(value, 30, true) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nullableDate = (value: unknown) => value === null || date(value);
const code = (value: unknown) => value === null || typeof value === 'string' && /^[A-Z0-9]{10}$/.test(value);
function exact(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  const result = record(value, '延迟回读记录', [...keys, ...optional]);
  if (keys.some(key => !Object.hasOwn(result, key))) throw new UserFacingError('延迟回读记录不完整');
  return result;
}

/** Readback changes do not invalidate the immutable submitted-content snapshot. */
export function followupDraftFingerprint(draft: AmazonDraft): string {
  const { id, productId, productRevision, variantId, sku, targetId, sellerId, marketplaceId, mode, revision, schema, attributes, submittedAt, submissionId } = draft;
  return createHash('sha256').update(JSON.stringify({ id, productId, productRevision, variantId, sku, targetId, sellerId, marketplaceId, mode, revision, schema, attributes, submittedAt, submissionId })).digest('hex');
}

/** Exact shape validation also prevents credentials or unbounded response bodies entering backups. */
export function validateFollowupRecord(value: unknown): FollowupRecord {
  const o = exact(value, ['id','draftId','revision','productId','variantId','sku','targetId','targetName','sellerId','marketplaceId','mode','targetGeneration','draftRevision','draftFingerprint',
    'submittedAt','submissionId','status','reason','attempts','nextDueAt','lastAttemptAt','checkedAt','listingState','statuses','issues','asin','fnsku','error','createdAt','updatedAt'], ['requeryPending']);
  for (const key of ['id','draftId','productId','variantId','targetId']) identifier(o[key]);
  if (o.id !== o.draftId || !integer(o.revision, 1) || !integer(o.targetGeneration) || !integer(o.draftRevision, 1)
    || !['sku','targetName','sellerId','marketplaceId'].every(key => string(o[key], 500, true)) || o.mode !== 'live'
    || typeof o.draftFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(o.draftFingerprint)
    || !['WAITING','PROCESSING','READY','NEEDS_ATTENTION'].includes(String(o.status)) || !(o.reason === null || reasons.includes(String(o.reason)))
    || !integer(o.attempts) || !states.includes(String(o.listingState))
    || ![o.submittedAt,o.nextDueAt,o.lastAttemptAt,o.checkedAt].every(nullableDate) || ![o.createdAt,o.updatedAt].every(date)
    || !(o.submissionId === null || string(o.submissionId, 500, true)) || !(o.error === null || string(o.error, 500)) || !code(o.asin) || !code(o.fnsku)
    || !Array.isArray(o.statuses) || o.statuses.length > 30 || o.statuses.some(v => !string(v, 100, true)) || new Set(o.statuses).size !== o.statuses.length
    || !Array.isArray(o.issues) || o.issues.length > 100) throw new UserFacingError('延迟回读记录格式不正确');
  for (const raw of o.issues) {
    const issue = exact(raw, ['code','message','severity','attributeNames','category','source','autoFixable']);
    if (!string(issue.code, 100, true) || !string(issue.message, 1200) || !['ERROR','WARNING','INFO'].includes(String(issue.severity))
      || !Array.isArray(issue.attributeNames) || issue.attributeNames.length > 100 || issue.attributeNames.some(v => !string(v, 100))
      || !['field','fact','qualification','compliance','image','network','rate_limit'].includes(String(issue.category))
      || !['local','amazon','demo'].includes(String(issue.source)) || typeof issue.autoFixable !== 'boolean') throw new UserFacingError('延迟回读问题记录格式不正确');
  }
  if (Object.hasOwn(o, 'requeryPending') && (o.requeryPending !== true || !['WAITING','PROCESSING'].includes(String(o.status)) || o.nextDueAt === null)
    || (o.status === 'READY' || o.status === 'NEEDS_ATTENTION') && o.nextDueAt !== null
    || o.status === 'WAITING' && (o.nextDueAt === null || o.attempts !== 0)
    || (o.status === 'WAITING' || o.status === 'PROCESSING') && o.submittedAt === null
    || o.status === 'PROCESSING' && Number(o.attempts) < 1
    || o.nextDueAt !== null && o.submittedAt !== null && Date.parse(String(o.nextDueAt)) < Date.parse(String(o.submittedAt)) + FOLLOWUP_OFFSETS[0]
    || o.status === 'READY' && (o.checkedAt === null || o.reason !== null || o.issues.some(issue => issue.severity === 'ERROR') || !(o.asin || o.statuses.some(status => ['BUYABLE','DISCOVERABLE'].includes(status))))
    || o.status === 'NEEDS_ATTENTION' && o.reason === null) throw new UserFacingError('延迟回读记录状态不一致');
  return structuredClone(o) as unknown as FollowupRecord;
}
