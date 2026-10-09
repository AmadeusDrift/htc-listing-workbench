import { randomUUID } from 'node:crypto';
import type { CollectionSnapshot } from '../../src/shared/collection-contracts.ts';

export function collectionSnapshot(): CollectionSnapshot {
  return { source: '1688', offerId: '123456789012', sourceUrl: 'https://detail.1688.com/offer/123456789012.html', capturedAt: '2026-09-30T00:00:00.000Z', title: '样本商品',
    skus: [{ providerSkuId: 'sku-1', originalSpec: '颜色:红色;尺寸:M', attributes: [{ name: '颜色', value: '红色' }, { name: '尺寸', value: 'M' }], purchasePrice: '0.0350' }],
    pricing: { currency: 'CNY', unitPrice: null, range: { min: '0.0350', max: '0.0500' }, tiers: [{ minQuantity: 2, unitPrice: '0.0350' }] },
    images: [{ id: 'image-1', url: 'https://cbu01.alicdn.com/img/ibank/source.jpg', role: 'main' }],
    skuImages: [{ providerSkuId: 'sku-1', imageId: 'image-1', basis: 'spec-value', specName: '颜色', specValue: '红色' }], warnings: [] };
}
export function collectionRequest(snapshot = collectionSnapshot(), captureId = randomUUID()) { return { version: 1, type: 'capture', requestId: randomUUID(), captureId, snapshot } as const; }
