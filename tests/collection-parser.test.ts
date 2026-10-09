import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePage } from '../extension/normalize.ts';

function page(overrides: Record<string, unknown> = {}) {
  return { url: 'https://detail.1688.com/offer/123456789.html?source=private', title: '收纳盒', offerId: '123456789', blocked: false,
    skus: [{ skuId: 'sku-a', specAttrs: [{ propName: '颜色', valueName: '蓝色' }], price: '0.123456789012', imageUrl: '//cbu01.alicdn.com/img/a.jpg' }],
    prices: [{ beginAmount: '2', price: '12.3400' }, { beginAmount: 10, price: '11.20' }], priceDisplay: '11.20-12.3400',
    images: ['//cbu01.alicdn.com/img/main.jpg'], ...overrides };
}
const time = '2026-09-30T00:00:00.000Z';
test('collection parser preserves explicit SKU identities, exact decimal prices and source image mappings', () => {
  const result = normalizePage(page(), time);
  assert.equal(result.sourceUrl, 'https://detail.1688.com/offer/123456789.html');
  assert.equal(result.skus[0].providerSkuId, 'sku-a');
  assert.equal(result.skus[0].purchasePrice, '0.123456789012');
  assert.deepEqual(result.skus[0].attributes, [{ name: '颜色', value: '蓝色' }]);
  assert.deepEqual(result.pricing.tiers, [{ minQuantity: 2, unitPrice: '12.3400' }, { minQuantity: 10, unitPrice: '11.20' }]);
  assert.deepEqual(result.pricing.range, { min: '11.20', max: '12.3400' });
  assert.equal(result.skuImages[0].basis, 'provider-sku-id');
  assert.equal(result.images.find(i => i.id === result.skuImages[0].imageId)?.url, 'https://cbu01.alicdn.com/img/a.jpg');
  assert.ok(result.warnings.includes('PRICE_PRECISION_UNSUPPORTED'));
  assert.ok(result.warnings.includes('REMOTE_IMAGES_ONLY'));
  assert.deepEqual(normalizePage(page(), time), result);
});
test('unknown SKU structures stay partial and never invent identity, stock or mapping', () => {
  const result = normalizePage(page({ title: '', skus: { strange: true }, prices: [], priceDisplay: '', images: [] }), time);
  assert.deepEqual(result.skus, []); assert.deepEqual(result.skuImages, []);
  assert.equal(result.pricing.unitPrice, null);
  for (const code of ['MISSING_TITLE', 'MISSING_SKUS', 'SKU_STRUCTURE_UNRECOGNIZED', 'MISSING_PRICE', 'MISSING_IMAGES']) assert.ok(result.warnings.includes(code as never));
  assert.equal('inventory' in result, false);
});
test('multiple SKUs do not inherit tier prices or match images by position', () => {
  const result = normalizePage(page({ skus: [{ skuId: 'b', specAttrs: [{ propName: '颜色', valueName: '白' }] }, { skuId: 'a', specAttrs: [{ propName: '颜色', valueName: '蓝' }], imageUrl: '//cbu01.alicdn.com/img/blue.jpg' }] }), time);
  assert.equal(result.skus[0].purchasePrice, null);
  assert.equal(result.skus[1].purchasePrice, null);
  assert.equal(result.skuImages.length, 1); assert.equal(result.skuImages[0].providerSkuId, 'a');
  assert.ok(result.warnings.includes('INCOMPLETE_SKU_IMAGES'));
});
test('challenge, wrong product identity, untrusted sources and excessive variants are refused', () => {
  for (const bad of [page({ blocked: true }), page({ offerId: '999' }), page({ url: 'https://detail.1688.com.evil.test/offer/123456789.html' }), page({ url: 'http://detail.1688.com/offer/123456789.html' }), page({ url: 'https://user:secret@detail.1688.com/offer/123456789.html' })]) assert.throws(() => normalizePage(bad, time));
  assert.throws(() => normalizePage(page({ skus: Array.from({ length: 201 }, (_, i) => ({ skuId: `${i}` })) }), time), /TOO_MANY_SKUS/);
  assert.throws(() => normalizePage(page({ skus: [{ skuId: 'a' }, { skuId: 'a' }] }), time), /INVALID_SNAPSHOT/);
});
test('unsafe images and ambiguous numeric prices are excluded without reading arbitrary properties', () => {
  const result = normalizePage(page({ skus: [{ skuId: 'a', price: 0.1, imageUrl: 'https://127.0.0.1/a.jpg' }], prices: [], priceDisplay: '', images: ['https://evil-alicdn.com/a.jpg', 'https://name:password@cbu01.alicdn.com/a.jpg', 'data:text/html,bad', 'https://cbu01.alicdn.com/a.jpg#secret'], secret: 'not copied' }), time);
  assert.equal(result.skus[0].purchasePrice, null); assert.deepEqual(result.images, []);
  assert.equal(JSON.stringify(result).includes('not copied'), false);
});
test('conflicting price tiers are never silently dropped and unreadable tiers remain visible as missing prices', () => {
  assert.throws(() => normalizePage(page({ prices: [{ beginAmount: '2', price: '12.3400' }, { beginAmount: '2', price: '99.00' }] }), time), /INVALID_SNAPSHOT/);
  assert.throws(() => normalizePage(page({ prices: [{ beginAmount: '2', price: '联系客服' }, { beginAmount: '2', price: '99.00' }] }), time), /INVALID_SNAPSHOT/);
  const result = normalizePage(page({ prices: [{ beginAmount: '2', price: '12.3400' }, { beginAmount: '10', price: '联系客服' }] }), time);
  assert.ok(result.warnings.includes('MISSING_PRICE'));
});
