import test from 'node:test';
import assert from 'node:assert/strict';
import { productsInLane, resultCounts } from '../src/renderer/workspace-model.ts';
import type { ProductSummary } from '../src/shared/contracts.ts';
import type { AmazonDraft } from '../src/shared/amazon-contracts.ts';

const product = (id: string, origin: ProductSummary['origin'] = 'import'): ProductSummary => ({ id, title: id, sourceUrl: '', status: 'draft', origin, variantCount: 2, assetCount: 3, coverUrl: null, updatedAt: '2026-09-30T00:00:00Z' });
test('旧商品默认在手动区，显式归属优先于商品来源，忽略不删除原商品', () => {
  const products = [product('legacy'), product('new'), product('automatic', 'manual'), product('ignored')];
  const placements = [{ productId: 'new', lane: 'inbox' as const }, { productId: 'automatic', lane: 'automatic' as const }, { productId: 'ignored', lane: 'ignored' as const }];
  assert.deepEqual(productsInLane(products, placements, 'manual').map(p => p.id), ['legacy']);
  assert.deepEqual(productsInLane(products, placements, 'inbox').map(p => p.id), ['new']);
  assert.deepEqual(productsInLane(products, placements, 'automatic').map(p => p.id), ['automatic']);
  assert.equal(products.length, 4);
});
const draft = (state: AmazonDraft['state'], mode: AmazonDraft['mode'] = 'live', statuses: string[] = []): AmazonDraft => ({ state, mode, statuses, submittedAt: ['SUBMITTED', 'BUYABLE'].includes(state) ? '2026-09-30T00:00:00Z' : null } as AmazonDraft);
test('结果统计不把本地演示、已接受或可见误算为真实可售', () => {
  const counts = resultCounts([draft('BUYABLE', 'demo', ['BUYABLE']), draft('SUBMITTED'), draft('DISCOVERABLE', 'live', ['DISCOVERABLE']), draft('UNKNOWN'), draft('BLOCKED'), draft('BUYABLE', 'live', ['BUYABLE'])]);
  assert.equal(counts.buyable, 1);
  assert.equal(counts.demo, 1);
  assert.equal(counts.attention, 2);
  assert.equal(counts.submitted, 2);
});
