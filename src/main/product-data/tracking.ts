import type { AmazonTarget } from '../../shared/amazon-contracts.ts';
import type { ProductDetail, ProductSummary } from '../../shared/contracts.ts';
import type { AcceptedAmazonSku, ProductDataObservation, ProductDataRow, ProductDataScope } from '../../shared/product-data-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { acceptedSku } from './accepted-skus.ts';

export interface ProductDataStore { listProducts(): ProductSummary[]; getProduct(id: string): ProductDetail }
export function dataScope(target: AmazonTarget, generation: number): ProductDataScope {
  return { targetId: target.id, sellerId: target.sellerId, marketplaceId: target.marketplaceId, mode: target.mode, generation };
}
export function scopeIdentity(scope: ProductDataScope): string {
  return JSON.stringify([scope.targetId, scope.sellerId, scope.marketplaceId, scope.mode, scope.generation]);
}
export function observation<T>(): ProductDataObservation<T> {
  return { value: null, status: 'pending', fetchedAt: null, attemptedAt: null, error: null };
}
export function rowIdentity(row: ProductDataRow): string {
  return JSON.stringify([row.sku, row.productId, row.variantId, row.salesSince, row.listingProgram]);
}
export function trackProducts(store: ProductDataStore, accepted: AcceptedAmazonSku[], scope: ProductDataScope, now: number): ProductDataRow[] {
  if (scope.mode !== 'live') return [];
  const rows = new Map<string, ProductDataRow>(); const submitted = new Map<string, number>();
  const products = store.listProducts();
  if (products.length > 20_000) throw new UserFacingError('本地商品数量超过商品数据安全读取上限');
  const summaries = new Map(products.map(product => [product.id, product]));
  for (const raw of accepted) {
    const entry = acceptedSku(raw);
    if (!entry || entry.targetId !== scope.targetId || entry.sellerId !== scope.sellerId || entry.marketplaceId !== scope.marketplaceId
      || Date.parse(entry.lastAcceptedAt) > now) continue;
    const summary = summaries.get(entry.productId); if (!summary || summary.origin === 'sample') continue;
    let product: ProductDetail;
    try { product = store.getProduct(summary.id); } catch { continue; }
    if (product.origin === 'sample') continue;
    const sku = entry.sku;
    const acceptedAt = Date.parse(entry.lastAcceptedAt); const prior = rows.get(sku);
    const earliest = Math.min(Date.parse(entry.firstAcceptedAt), prior ? Date.parse(prior.salesSince) : Date.parse(entry.firstAcceptedAt));
    const variant = product.variants.find(v => v.id === entry.variantId);
    const trackingIssue = !variant ? '原提交变体已不存在，请处理本地商品与 SKU 的对应关系'
      : variant.sku !== sku ? '本地变体 SKU 已变更，请处理后再读取原提交 SKU 的数据' : null;
    // Prefer a still-matching local owner; among equally valid owners the latest acceptance identifies the program.
    if (!prior || (prior.trackingIssue !== null && trackingIssue === null)
      || (Boolean(prior.trackingIssue) === Boolean(trackingIssue) && acceptedAt > submitted.get(sku)!)) {
      rows.set(sku, { sku, productId: product.id, variantId: entry.variantId, title: summary.title, coverUrl: summary.coverUrl,
        listingProgram: entry.listingProgram, salesSince: new Date(earliest).toISOString(), trackingIssue,
        listing: observation(), inventory: observation(), sales: entry.listingProgram === 'haul' ? observation()
          : { ...observation(), status: 'not_applicable', error: '标准项目商品不适用 Amazon Haul 销量' } });
      submitted.set(sku, acceptedAt);
    } else prior.salesSince = new Date(earliest).toISOString();
  }
  if (rows.size > 10_000) throw new UserFacingError('跟踪 SKU 数量超过商品数据安全读取上限');
  return [...rows.values()];
}

export function currentLocalRow(store: ProductDataStore, row: ProductDataRow): boolean {
  try {
    const product = store.getProduct(row.productId);
    return product.origin !== 'sample' && product.variants.some(v => v.id === row.variantId && v.sku === row.sku);
  } catch { return false; }
}
