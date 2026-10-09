import { createHash } from 'node:crypto';
import { record, identifier } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import type { ExecutionTask } from '../../shared/execution-contracts.ts';

export const stepNames = ['upload', 'images', 'validate', 'preview', 'submit', 'readback'] as const;
export function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const string = (value: unknown, max = 500) => typeof value === 'string' && value.length <= max && !value.includes('\0');
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const result = record(value, '任务记录', keys);
  if (Object.keys(result).length !== keys.length) throw new UserFacingError('任务记录不完整'); return result;
}
export function validateExecutionTask(value: unknown): ExecutionTask {
  const raw = record(value, '任务记录');
  const keys = ['id','revision','status','profileId','profileGeneration','profileStamp','items','createdAt','updatedAt','error'];
  const o = exact(raw, Object.hasOwn(raw, 'concurrency') ? [...keys, 'concurrency'] : keys);
  const concurrency = Object.hasOwn(o, 'concurrency') ? o.concurrency : 1;
  if (concurrency !== 1 && concurrency !== 3 && concurrency !== 5) throw new UserFacingError('任务并发数必须为 1、3 或 5');
  identifier(o.id);
  if (!positive(o.revision) || !['CREATED','QUEUED','RUNNING','PAUSED','NEEDS_ATTENTION','COMPLETED','CANCELLED'].includes(String(o.status))
    || !['alpha','beta','gamma','delta','epsilon'].includes(String(o.profileId)) || !positive(o.profileGeneration) || !hash(o.profileStamp)
    || ![o.createdAt,o.updatedAt].every(v => string(v) && Number.isFinite(Date.parse(String(v)))) || !(o.error === null || string(o.error))
    || !Array.isArray(o.items) || o.items.length < 1 || o.items.length > 50) throw new UserFacingError('任务记录格式不正确');
  for (const value of o.items) {
    const i = exact(value, ['draftId','productId','productRevision','variantId','sku','targetId','targetName','sellerId','marketplaceId','mode','targetStamp',
      'schemaHash','attributesHash','intendedAttributesHash','draftRevision','assets','uploads','steps','status','listingState','submitStarted']);
    for (const key of ['draftId','productId','variantId','targetId']) identifier(i[key]);
    if (!positive(i.productRevision) || !positive(i.draftRevision) || !['sku','targetName','sellerId','marketplaceId'].every(k => string(i[k]) && i[k])
      || !['demo','live'].includes(String(i.mode)) || !['targetStamp','schemaHash','attributesHash'].every(k => hash(i[k]))
      || !(i.intendedAttributesHash === null || hash(i.intendedAttributesHash)) || !['PENDING','RUNNING','DONE','FAILED'].includes(String(i.status))
      || typeof i.submitStarted !== 'boolean' || !(i.listingState === null || string(i.listingState, 40)) || !Array.isArray(i.assets) || i.assets.length < 1 || i.assets.length > 200
      || !Array.isArray(i.uploads) || i.uploads.length > i.assets.length || !Array.isArray(i.steps) || i.steps.length !== stepNames.length) throw new UserFacingError('任务 SKU 记录不正确');
    for (const a of i.assets) { const asset = exact(a, ['id','sha256','role']); identifier(asset.id); if (!hash(asset.sha256) || !['main','gallery'].includes(String(asset.role))) throw new UserFacingError('任务图片记录不正确'); }
    for (const u of i.uploads) {
      const upload = exact(u, ['assetId','uploadId','publicUrl','sha256']); identifier(upload.assetId); identifier(upload.uploadId);
      if (!hash(upload.sha256) || !string(upload.publicUrl, 2048) || !String(upload.publicUrl).startsWith('https://')) throw new UserFacingError('任务外链记录不正确');
    }
    for (const [index, s] of i.steps.entries()) {
      const step = exact(s, ['name','status','attempts','error']);
      if (step.name !== stepNames[index] || !['PENDING','RUNNING','DONE','FAILED','SKIPPED'].includes(String(step.status)) || !Number.isSafeInteger(step.attempts) || Number(step.attempts) < 0
        || !(step.error === null || string(step.error))) throw new UserFacingError('任务步骤记录不正确');
    }
  }
  if (new Set(o.items.map(i => i.draftId)).size !== o.items.length) throw new UserFacingError('任务 SKU 重复');
  return structuredClone({ ...o, concurrency }) as unknown as ExecutionTask;
}
