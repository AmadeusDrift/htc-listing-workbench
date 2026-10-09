import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductDataObservation, ProductDataRow, ProductDataScope, ProductDataStatus, ProductInventoryData, ProductListingData, ProductSalesData } from '../../shared/product-data-contracts.ts';
import { object, quantity } from './normalize.ts';
import { scopeIdentity } from './tracking.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const STATES: ProductDataStatus[] = ['pending', 'ok', 'missing', 'error', 'not_applicable'];
function string(value: unknown, limit = 1000): value is string { return typeof value === 'string' && value.length <= limit; }
function nullableString(value: unknown, limit = 1000): value is string | null { return value === null || string(value, limit); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function count(value: unknown): value is number | null { return value === null || quantity(value) !== null; }
function listing(value: unknown): ProductListingData | null {
  if (!object(value) || !nullableString(value.asin, 40) || !nullableString(value.title, 500) || !count(value.errorCount) || !count(value.warningCount)
    || !(value.statuses === null || Array.isArray(value.statuses) && value.statuses.length <= 30 && value.statuses.every(s => string(s, 60)))
    || !Array.isArray(value.issues) || value.issues.length > 100) return null;
  const issues: ProductListingData['issues'] = [];
  for (const issue of value.issues) {
    if (!object(issue) || !string(issue.code, 100) || !string(issue.message, 1200) || !['ERROR', 'WARNING', 'INFO'].includes(String(issue.severity))) return null;
    issues.push({ code: issue.code, message: issue.message, severity: issue.severity as 'ERROR' | 'WARNING' | 'INFO' });
  }
  return { asin: value.asin, title: value.title, statuses: value.statuses as string[] | null, issues, errorCount: value.errorCount, warningCount: value.warningCount };
}
function inventory(value: unknown): ProductInventoryData | null {
  if (!object(value) || !count(value.fulfillable) || !count(value.reserved) || !count(value.inbound) || !count(value.unfulfillable) || !count(value.total)) return null;
  return { fulfillable: value.fulfillable, reserved: value.reserved, inbound: value.inbound, unfulfillable: value.unfulfillable, total: value.total };
}
function sales(value: unknown): ProductSalesData | null {
  if (!object(value) || !count(value.units7d) || !count(value.units30d) || !timestamp(value.window7dStart) || !timestamp(value.window30dStart)
    || !timestamp(value.windowEnd) || value.timeZone !== 'UTC' || value.program !== 'AmazonHaul') return null;
  const start = Date.parse(value.window30dStart); const end = Date.parse(value.windowEnd); const start7 = Date.parse(value.window7dStart);
  if (start > start7 || start7 > end || end - start > 31 * 86_400_000
    || value.units7d !== null && value.units30d !== null && value.units7d > value.units30d) return null;
  return { units7d: value.units7d, units30d: value.units30d, window7dStart: value.window7dStart, window30dStart: value.window30dStart,
    windowEnd: value.windowEnd, timeZone: 'UTC', program: 'AmazonHaul' };
}
function metric<T>(value: unknown, parse: (value: unknown) => T | null, now: number): ProductDataObservation<T> | null {
  if (!object(value) || !STATES.includes(value.status as ProductDataStatus) || !nullableString(value.error, 500)
    || !(value.fetchedAt === null || timestamp(value.fetchedAt) && Date.parse(value.fetchedAt) <= now)
    || !(value.attemptedAt === null || timestamp(value.attemptedAt) && Date.parse(value.attemptedAt) <= now)) return null;
  const data = value.value === null ? null : parse(value.value);
  if (value.value !== null && data === null || data !== null && value.fetchedAt === null) return null;
  return { value: data, status: value.status as ProductDataStatus, fetchedAt: value.fetchedAt as string | null,
    attemptedAt: value.attemptedAt as string | null, error: value.error };
}

/** Disposable, size-bounded derived cache; never touches the workspace database or backups. */
export class ProductDataCache {
  private directory: string;
  constructor(directory: string) { this.directory = join(directory, 'product-data-cache'); }
  private file(scope: ProductDataScope): string { return join(this.directory, `${createHash('sha256').update(scope.targetId).digest('hex')}.json`); }
  read(scope: ProductDataScope, now: number): ProductDataRow[] {
    let fd: number | undefined;
    try {
      if (lstatSync(this.directory).isSymbolicLink() || lstatSync(this.file(scope)).isSymbolicLink()) return [];
      fd = openSync(this.file(scope), 'r'); const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES || stat.size < 1) return [];
      const bytes = Buffer.alloc(stat.size); if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return [];
      const saved: unknown = JSON.parse(bytes.toString('utf8'));
      if (!object(saved) || saved.version !== 1 || saved.scopeKey !== scopeIdentity(scope) || !Array.isArray(saved.rows) || saved.rows.length > 10_000) return [];
      const rows: ProductDataRow[] = [];
      for (const row of saved.rows) {
        if (!object(row) || !string(row.sku, 200) || !string(row.productId, 100) || !string(row.variantId, 100) || !timestamp(row.salesSince)
          || !['haul', 'standard'].includes(String(row.listingProgram))) return [];
        const l = metric(row.listing, listing, now); const i = metric(row.inventory, inventory, now); const s = metric(row.sales, sales, now);
        if (!l || !i || !s || Date.parse(row.salesSince) > now || s.value && (Date.parse(s.value.window30dStart) < Date.parse(row.salesSince)
          || Date.parse(s.value.windowEnd) > now)) return [];
        rows.push({ sku: row.sku, productId: row.productId, variantId: row.variantId, salesSince: row.salesSince,
          listingProgram: row.listingProgram as 'haul' | 'standard', title: '', coverUrl: null, trackingIssue: null, listing: l, inventory: i, sales: s });
      }
      return rows;
    } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
  }
  write(scope: ProductDataScope, rows: ProductDataRow[]): void {
    let temporary: string | undefined;
    try {
      if (rows.length > 10_000) return;
      const json = JSON.stringify({ version: 1, scopeKey: scopeIdentity(scope), rows: rows.map(row => ({ sku: row.sku, productId: row.productId,
        variantId: row.variantId, salesSince: row.salesSince, listingProgram: row.listingProgram, listing: row.listing, inventory: row.inventory, sales: row.sales })) });
      if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) return;
      mkdirSync(this.directory, { recursive: true }); if (lstatSync(this.directory).isSymbolicLink()) return;
      temporary = join(this.directory, `${randomUUID()}.tmp`); writeFileSync(temporary, json, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.file(scope)); temporary = undefined;
    } catch { /* Derived cache I/O must not prevent reading product data. */ }
    finally { if (temporary) try { unlinkSync(temporary); } catch { /* Best-effort cleanup of this exact temporary file. */ } }
  }
}
