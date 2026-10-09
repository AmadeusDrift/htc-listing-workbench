import test from 'node:test';
import assert from 'node:assert/strict';
import type { AmazonDraft, AmazonTarget } from '../src/shared/amazon-contracts.ts';
import type { ProductSummary } from '../src/shared/contracts.ts';
import type { ProcurementCandidate } from '../src/shared/procurement-contracts.ts';

const implementation = await import('../src/renderer/product-insights.ts').catch(() => null);
const target = { id: 'shop', sellerId: 'seller', marketplaceId: 'US', mode: 'live' } as AmazonTarget;
const product = { id: 'product', title: '收纳袋', variantCount: 2, coverUrl: null } as ProductSummary;
function draft(id: string, update: string, patch: Partial<AmazonDraft> = {}): AmazonDraft {
  return { id, productId: 'product', variantId: 'variant', targetId: 'shop', targetName: 'U2', sellerId: 'seller', marketplaceId: 'US', mode: 'live', sku: 'BAG-BLUE',
    schema: { parentageLevel: 'NONE' }, state: 'BUYABLE', submittedAt: update, updatedAt: update, checkedAt: update, statuses: ['BUYABLE'], listingIssues: [], ...patch } as AmazonDraft;
}
const confirmed = (d: AmazonDraft) => ({ draftId: d.id, productId: d.productId, variantId: d.variantId, targetId: d.targetId, sellerId: d.sellerId, marketplaceId: d.marketplaceId, mode: d.mode, sku: d.sku, eligible: true, checkedAt: d.checkedAt, asin: 'B012345678', reason: '' } as ProcurementCandidate);
test('product insights count one latest submitted SKU, exclude parents and isolate the selected live shop', () => {
  assert.ok(implementation);
  const old = draft('old', '2026-10-01T00:00:00Z'), current = draft('current', '2026-10-02T00:00:00Z');
  const data = implementation.productInsights([product], [old,current,draft('pending-edit', '2026-10-03T00:00:00Z', { submittedAt: null, state: 'DRAFT' }),
    draft('parent','2026-10-02T00:00:00Z',{sku:'BAG',schema:{parentageLevel:'PARENT'} as AmazonDraft['schema']}),
    draft('demo','2026-10-02T00:00:00Z',{mode:'demo'}), draft('other','2026-10-02T00:00:00Z',{targetId:'other'})], [confirmed(current)], [target], 'shop');
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].draftId, current.id); assert.equal(data.counts.products, 1); assert.equal(data.counts.buyable, 1);
  assert.equal(data.rows[0].sales30d, null); assert.equal(data.rows[0].availableInventory, null); assert.equal(data.rows[0].replenishment, null);
  assert.equal(data.metricsState, 'not_connected');
});
test('unknown newer submissions and obsolete shop identities never appear sellable in analytics', () => {
  assert.ok(implementation);
  const old = draft('old','2026-10-01T00:00:00Z'), unknown = draft('unknown','2026-10-02T00:00:00Z',{state:'UNKNOWN',submittedAt:null});
  const data = implementation.productInsights([product], [old,unknown], [confirmed(old)], [target], 'shop');
  assert.equal(data.rows[0].draftId, unknown.id); assert.equal(data.counts.buyable, 0); assert.equal(data.counts.attention, 1);
  const changed = implementation.productInsights([product], [old], [confirmed(old)], [{...target,sellerId:'new-seller'}], 'shop');
  assert.equal(changed.counts.buyable, 0); assert.equal(changed.counts.attention, 1);
});
test('a cached BUYABLE flag without a matching trustworthy observation stays unconfirmed', () => {
  assert.ok(implementation);
  const d = draft('old','2026-10-01T00:00:00Z');
  const data = implementation.productInsights([product], [d], [{...confirmed(d),eligible:false,reason:'等待平台回读确认建档'}], [target], 'shop');
  assert.equal(data.counts.buyable, 0); assert.equal(data.rows[0].status, 'waiting');
});

test('local SKU identity changes require attention instead of waiting for Amazon', () => {
  assert.ok(implementation);
  const d = draft('changed','2026-10-01T00:00:00Z');
  const candidate = { ...confirmed(d), eligible: false, requiresAttention: true, reason: '本地 SKU 已变化，请核对商品' };
  const data = implementation.productInsights([product], [d], [candidate], [target], 'shop');
  assert.equal(data.rows[0].status, 'attention'); assert.equal(data.counts.attention, 1); assert.equal(data.counts.buyable, 0);
});
