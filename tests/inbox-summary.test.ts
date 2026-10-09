import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProductDetail } from '../src/shared/contracts.ts';
import type { MiaoshouReceipt } from '../src/shared/miaoshou-contracts.ts';
import { inboxSummary, automaticMiaoshouMapping } from '../src/shared/inbox-summary.ts';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { detailFixture } from './helpers/miaoshou-fixture.ts';

function fixture() {
  const raw = detailFixture(), source = raw.data.editCommonCollectBoxDetail;
  const product: ProductDetail = { id: 'local', title: '商品', sourceUrl: '', description: '', status: 'draft', origin: 'import', revision: 1, createdAt: '', updatedAt: '', variants: [], facts: [], assets: [] };
  const make = () => {
    const snapshot = normalizeDetail(raw, '2026-10-08T00:00:00.000Z', 'live');
    return { snapshot, mapping: automaticMiaoshouMapping(snapshot) } as MiaoshouReceipt;
  };
  return { raw, source, product, make };
}

test('automatic 1688 import maps source price in CNY without another manual selection', () => {
  const f = fixture(), receipt = f.make();
  assert.equal(receipt.mapping.priceField, 'price');
  assert.equal(receipt.mapping.currency, 'CNY');
  receipt.snapshot.sources = [{source: 'other', sourceSite: '', sourceItemId: '', sourceItemUrl: ''}];
  assert.equal(automaticMiaoshouMapping(receipt.snapshot).currency, 'unknown');
});

test('source dimensions keep SKU-specific measurements instead of flattening common product facts', () => {
  const f = fixture();
  f.source.sourceAttrs = [{ name: '尺寸', value: '10×8×2 cm' }, { name: '材质', value: '棉布' }];
  f.source.skuMap = { ...f.source.skuMap, arbitraryA: { ...f.source.skuMap.arbitraryA, weight: '0.024' } } as typeof f.source.skuMap;
  f.source.sizeMap.medium.name = 'M 12×8×2 cm'; f.source.sizeMap.small.name = 'S 10×8×2 cm';
  const receipt = f.make();
  receipt.mapping.skus[0].dimensions.size = 'medium'; receipt.mapping.skus[1].dimensions.size = 'small';
  f.product.facts = [{ id: 'size', name: '尺寸', value: '10×8×2 cm', source: 'import', sourceRef: '', state: 'source_confirmed' }];
  const summary = inboxSummary(f.product, receipt);
  assert.equal(summary.size, '多规格'); assert.equal(summary.weight, '多规格');
  assert.ok(!summary.attributes.some(fact => fact.name === '尺寸'));
});

test('package sizes are labeled, source price keeps zero, and source keys are never guessed', () => {
  const f = fixture();
  f.source.skuMap = { arbitraryB: { ...f.source.skuMap.arbitraryB, packageWidth: 8 }, arbitraryA: { ...f.source.skuMap.arbitraryA, packageLength: 12, packageWidth: '8', packageHeight: 2 } } as typeof f.source.skuMap;
  const receipt = f.make(), summary = inboxSummary(f.product, receipt);
  assert.equal(summary.size, '包装 12×8×2 cm'); assert.equal(summary.price, '0–9.876543');
  assert.ok(receipt.mapping.skus.every(sku => Object.keys(sku.dimensions).length === 0));
});

test('manual product facts and prices display without a Miaoshou source; missing is not zero', () => {
  const f = fixture();
  assert.equal(inboxSummary(f.product, null).price, '—');
  f.product.facts = [
    { id: 'size', name: '产品尺寸', value: '15×8×3 cm', source: 'manual', sourceRef: '', state: 'human_confirmed' },
    { id: 'weight', name: '净重', value: '25 g', source: 'manual', sourceRef: '', state: 'human_confirmed' },
    { id: 'fake', name: '容量', value: '999 L', source: 'ai', sourceRef: '', state: 'ai_suggested' },
  ];
  const summary = inboxSummary(f.product, null);
  assert.equal(summary.size, '15×8×3 cm'); assert.equal(summary.weight, '25 g');
  assert.equal(summary.attributes.length, 0); assert.deepEqual(summary.missing, []);
});

test('manual package dimensions and gross weight remain visible with their scope', () => {
  const f = fixture();
  f.product.facts = [
    { id: 'size', name: '包装尺寸', value: '15×8×3 cm', source: 'manual', sourceRef: '', state: 'human_confirmed' },
    { id: 'weight', name: '毛重', value: '25 g', source: 'manual', sourceRef: '', state: 'human_confirmed' },
  ];
  const summary = inboxSummary(f.product, null);
  assert.equal(summary.size, '包装 15×8×3 cm'); assert.equal(summary.weight, '包装 25 g');
  assert.deepEqual(summary.missing, []);
});
