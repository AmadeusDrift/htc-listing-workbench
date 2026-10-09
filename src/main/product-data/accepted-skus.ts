import { createHash } from 'node:crypto';
import type { DraftRecord } from '../amazon/persistence.ts';
import type { AcceptedAmazonSku } from '../../shared/product-data-contracts.ts';
import { object } from './normalize.ts';

export const ACCEPTED_SKU_PREFIX = 'accepted_sku_v1:';
export function acceptedSkuKey(row: AcceptedAmazonSku): string {
  return ACCEPTED_SKU_PREFIX + createHash('sha256').update(JSON.stringify([row.targetId, row.sellerId, row.marketplaceId, row.mode, row.sku])).digest('hex');
}
function identifier(value: unknown, max = 100): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function acceptedSku(value: unknown): AcceptedAmazonSku | null {
  if (!object(value) || value.mode !== 'live' || !identifier(value.targetId) || !identifier(value.sellerId) || !identifier(value.marketplaceId)
    || !identifier(value.productId) || !identifier(value.variantId) || !identifier(value.sku, 200)
    || !['haul', 'standard'].includes(String(value.listingProgram)) || !timestamp(value.firstAcceptedAt) || !timestamp(value.lastAcceptedAt)
    || value.firstAcceptedAt > value.lastAcceptedAt) return null;
  return { targetId: value.targetId, sellerId: value.sellerId, marketplaceId: value.marketplaceId, mode: 'live', sku: value.sku,
    productId: value.productId, variantId: value.variantId, listingProgram: value.listingProgram as 'haul' | 'standard',
    firstAcceptedAt: value.firstAcceptedAt, lastAcceptedAt: value.lastAcceptedAt };
}
export function decodeAcceptedSku(raw: unknown, key: string): AcceptedAmazonSku | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
  try { const parsed = acceptedSku(JSON.parse(raw)); return parsed && acceptedSkuKey(parsed) === key ? parsed : null; } catch { return null; }
}
/** The durable entry requires proof of the same acceptance checks used by formal submission. */
export function acceptedSkuFromRecord(record: DraftRecord): AcceptedAmazonSku | null {
  const d = record.draft; const response = record.submitResponse;
  if (record.unresolvedWrite || !object(d) || !object(d.schema) || d.mode !== 'live' || d.schema.mode !== 'live'
    || !['NONE', 'CHILD'].includes(String(d.schema.parentageLevel)) || !timestamp(d.submittedAt)
    || !object(response) || response.status !== 'ACCEPTED' || response.sku !== d.sku || !identifier(response.submissionId, 300)
    || d.submissionId !== response.submissionId || !(response.issues === undefined || Array.isArray(response.issues))
    || Array.isArray(response.issues) && response.issues.some(issue => object(issue) && issue.severity === 'ERROR')) return null;
  return acceptedSku({ targetId: d.targetId, sellerId: d.sellerId, marketplaceId: d.marketplaceId, mode: 'live', sku: d.sku,
    productId: d.productId, variantId: d.variantId, listingProgram: d.listingProgram, firstAcceptedAt: d.submittedAt, lastAcceptedAt: d.submittedAt });
}
