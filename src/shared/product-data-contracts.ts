import type { AmazonMode, ListingProgram } from './amazon-contracts.ts';

/** Durable accepted submission identity, independent of drafts, credentials and derived API caches. */
export interface AcceptedAmazonSku {
  targetId: string;
  sellerId: string;
  marketplaceId: string;
  mode: 'live';
  sku: string;
  productId: string;
  variantId: string;
  listingProgram: ListingProgram;
  firstAcceptedAt: string;
  lastAcceptedAt: string;
}

export interface ProductDataScope {
  targetId: string;
  sellerId: string;
  marketplaceId: string;
  mode: AmazonMode;
  generation: number;
}
export type ProductDataStatus = 'pending' | 'ok' | 'missing' | 'error' | 'not_applicable';
/** A failed refresh retains the last successful value and its original timestamp. */
export interface ProductDataObservation<T> {
  value: T | null;
  status: ProductDataStatus;
  fetchedAt: string | null;
  attemptedAt: string | null;
  error: string | null;
}
export interface ProductDataIssue {
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
}
export interface ProductListingData {
  asin: string | null;
  title: string | null;
  statuses: string[] | null;
  issues: ProductDataIssue[];
  errorCount: number | null;
  warningCount: number | null;
}
export interface ProductInventoryData {
  fulfillable: number | null;
  reserved: number | null;
  inbound: number | null;
  unfulfillable: number | null;
  total: number | null;
}
export interface ProductSalesData {
  units7d: number | null;
  units30d: number | null;
  window7dStart: string;
  window30dStart: string;
  windowEnd: string;
  timeZone: 'UTC';
  program: 'AmazonHaul';
}
export interface ProductDataRow {
  sku: string;
  productId: string;
  variantId: string;
  title: string;
  coverUrl: string | null;
  listingProgram: ListingProgram;
  /** Earliest accepted live submission for this tracked SKU in this seller/marketplace. */
  salesSince: string;
  /** A changed/missing local variant must be resolved before querying the old SKU. */
  trackingIssue: string | null;
  listing: ProductDataObservation<ProductListingData>;
  inventory: ProductDataObservation<ProductInventoryData>;
  sales: ProductDataObservation<ProductSalesData>;
}
export interface ProductDataJob {
  state: 'idle' | 'running' | 'completed' | 'stopped' | 'failed';
  phase: 'idle' | 'listings' | 'inventory' | 'sales';
  /** Completed SKU/interface pairs, including reused sales observations. */
  completed: number;
  total: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
}
export interface ProductDataSnapshot {
  scope: ProductDataScope;
  rows: ProductDataRow[];
  job: ProductDataJob;
  updatedAt: string | null;
  message: string | null;
}
export interface ProductDataApi {
  getAmazonProductData(targetId: string): Promise<ProductDataSnapshot>;
  syncAmazonProductData(targetId: string): Promise<ProductDataSnapshot>;
  stopAmazonProductDataSync(targetId: string): Promise<ProductDataSnapshot>;
}
