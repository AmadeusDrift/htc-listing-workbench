import type { JsonObject } from '../../shared/amazon-contracts.ts';
import type { ProductInventoryData, ProductListingData, ProductSalesData } from '../../shared/product-data-contracts.ts';

export function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function text(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit) : null;
}
export function quantity(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
export class ProductDataFormatError extends Error {}
function malformed(): never { throw new ProductDataFormatError('Amazon 返回的数据缺少所需字段或范围不匹配'); }
function hasErrors(data: JsonObject): boolean { return Array.isArray(data.errors) && data.errors.length > 0; }
export function pageToken(data: JsonObject): string | null {
  if (data.pagination === undefined) return null;
  if (!object(data.pagination)) return malformed();
  const value = data.pagination.nextToken;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096) return malformed();
  return value;
}
export function listingsPage(data: JsonObject, allowed: Set<string>, marketplaceId: string): Map<string, ProductListingData> {
  if (hasErrors(data) || !Array.isArray(data.items) || data.items.length > 1000) return malformed();
  const found = new Map<string, ProductListingData>();
  for (const item of data.items) {
    if (!object(item) || typeof item.sku !== 'string' || !allowed.has(item.sku)) continue;
    if (!Array.isArray(item.summaries)) continue;
    const summary = item.summaries.find(s => object(s) && s.marketplaceId === marketplaceId);
    if (!object(summary)) continue;
    const validIssues = Array.isArray(item.issues) ? (item.issues as unknown[]).filter(object).filter(issue => !Array.isArray(issue.marketplaceIds)
      || issue.marketplaceIds.includes(marketplaceId)) : null;
    const countsKnown = Array.isArray(item.issues) && item.issues.every(issue => object(issue) && ['ERROR', 'WARNING', 'INFO'].includes(String(issue.severity)));
    const issues = (validIssues ?? []).slice(0, 100).map(issue => ({ code: text(issue.code, 100) ?? 'AMAZON_ISSUE',
      message: text(issue.message, 1200) ?? 'Amazon 返回了需要核对的问题',
      severity: issue.severity === 'WARNING' ? 'WARNING' as const : issue.severity === 'INFO' ? 'INFO' as const : 'ERROR' as const }));
    found.set(item.sku, { asin: text(summary.asin, 40), title: text(summary.itemName, 500),
      statuses: Array.isArray(summary.status) && summary.status.every(s => typeof s === 'string') ? summary.status.slice(0, 30).map(s => String(s).slice(0, 60)) : null,
      issues, errorCount: !countsKnown || validIssues === null ? null : validIssues.filter(i => i.severity === 'ERROR').length,
      warningCount: !countsKnown || validIssues === null ? null : validIssues.filter(i => i.severity === 'WARNING').length });
  }
  return found;
}
export function inventoryPage(data: JsonObject, allowed: Set<string>, marketplaceId: string): Map<string, ProductInventoryData> {
  if (hasErrors(data) || !object(data.payload)) return malformed();
  const payload = data.payload;
  if (!object(payload.granularity) || payload.granularity.granularityType !== 'Marketplace' || payload.granularity.granularityId !== marketplaceId
    || !Array.isArray(payload.inventorySummaries) || payload.inventorySummaries.length > 1000) return malformed();
  const found = new Map<string, ProductInventoryData>();
  for (const item of payload.inventorySummaries) {
    if (!object(item) || typeof item.sellerSku !== 'string' || !allowed.has(item.sellerSku)) continue;
    if (item.marketplaceId !== undefined && item.marketplaceId !== marketplaceId) continue;
    const details = object(item.inventoryDetails) ? item.inventoryDetails : {};
    const inbound = [details.inboundWorkingQuantity, details.inboundShippedQuantity, details.inboundReceivingQuantity].map(quantity);
    const inboundSum = inbound.every(n => n !== null) ? inbound.reduce<number>((sum, n) => sum + n!, 0) : null;
    found.set(item.sellerSku, { fulfillable: quantity(details.fulfillableQuantity), total: quantity(item.totalQuantity),
      reserved: object(details.reservedQuantity) ? quantity(details.reservedQuantity.totalReservedQuantity) : null,
      unfulfillable: object(details.unfulfillableQuantity) ? quantity(details.unfulfillableQuantity.totalUnfulfillableQuantity) : null,
      inbound: quantity(inboundSum) });
  }
  return found;
}

export function salesWindows(salesSince: string, now: number): Omit<ProductSalesData, 'units7d' | 'units30d'> {
  const date = new Date(now); date.setUTCHours(0, 0, 0, 0); const today = date.getTime(); const since = Date.parse(salesSince);
  return { window7dStart: new Date(Math.max(today - 6 * 86_400_000, since)).toISOString(),
    window30dStart: new Date(Math.max(today - 29 * 86_400_000, since)).toISOString(), windowEnd: new Date(now).toISOString(), timeZone: 'UTC', program: 'AmazonHaul' };
}
export function salesMetrics(data: JsonObject, windows: ReturnType<typeof salesWindows>): ProductSalesData {
  if (hasErrors(data) || !Array.isArray(data.payload) || data.payload.length > 1000) return malformed();
  const start = Date.parse(windows.window30dStart); const end = Date.parse(windows.windowEnd);
  const buckets: { from: number; to: number; units: number | null }[] = [];
  for (const entry of data.payload) {
    if (!object(entry) || typeof entry.interval !== 'string') return malformed();
    const interval = entry.interval.split('--'); if (interval.length !== 2) return malformed();
    const [from, to] = interval.map(Date.parse);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return malformed();
    if (to <= start || from >= end) continue;
    // Amazon labels Day buckets with full UTC days, even when the requested
    // head/tail is partial. Its unitCount already respects the query interval.
    // Accept only daily labels (or precisely clipped boundary labels), then
    // verify complete coverage without expanding the actual sales query.
    const day = Math.floor(from / 86_400_000) * 86_400_000;
    const clippedFrom = Math.max(day, start), clippedTo = Math.min(day + 86_400_000, end);
    if ((from !== day && from !== clippedFrom) || (to !== day + 86_400_000 && to !== clippedTo) || clippedFrom >= clippedTo) return malformed();
    buckets.push({ from: clippedFrom, to: clippedTo, units: quantity(entry.unitCount) });
  }
  buckets.sort((a, b) => a.from - b.from);
  function sumSince(since: number): number | null {
    let cursor = since; let total = 0;
    for (const bucket of buckets) {
      if (bucket.to <= since) continue;
      if (bucket.from !== cursor || bucket.units === null) return null;
      total += bucket.units; if (!Number.isSafeInteger(total)) return null; cursor = bucket.to;
    }
    return cursor === end && since < end ? total : null;
  }
  return { ...windows, units7d: sumSince(Date.parse(windows.window7dStart)), units30d: sumSince(start) };
}
