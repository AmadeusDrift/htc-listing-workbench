import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInboxSummaryPage } from '../src/renderer/inbox-summary-page.ts';
import type { MiaoshouInboxSummary } from '../src/shared/miaoshou-contracts.ts';
const ids = (count: number) => Array.from({ length: count }, (_, i) => String(i));
const rows = (productIds: string[]): MiaoshouInboxSummary[] => productIds.map(productId => ({ productId, imageId: null, price: productId, size: '1 cm', weight: '1 g', attributes: [], missing: [], hasSourceUpdate: false }));
for (const count of [0, 20, 50, 51, 100]) test(`loads ${count} summaries in sequential batches up to 50`, async () => {
  const calls: number[] = []; let pending = 0;
  const result = await loadInboxSummaryPage(ids(count), async ({ productIds }) => {
    assert.equal(pending++, 0); assert.ok(productIds.length <= 50); calls.push(productIds.length);
    await Promise.resolve(); pending--; return rows(productIds);
  }, () => true);
  assert.deepEqual(result, rows(ids(count)));
  assert.deepEqual(calls, count ? [Math.min(count, 50), ...(count > 50 ? [count - 50] : [])] : []);
});
for (const reason of ['page change', 'unmount', 'retry']) test(`ignores late result and stops old batches after ${reason}`, async () => {
  let active = true, calls = 0;
  let complete!: (value: MiaoshouInboxSummary[]) => void;
  const old = loadInboxSummaryPage(ids(100), async () => { calls++; return new Promise(resolve => { complete = resolve; }); }, () => active);
  active = false;
  const current = await loadInboxSummaryPage(['new'], async ({ productIds }) => rows(productIds), () => true);
  complete(rows(ids(50)));
  assert.equal(await old, null); assert.equal(calls, 1); assert.deepEqual(current, rows(['new']));
});
test('later batch failure rejects the whole page instead of publishing partial rows; retry starts fresh', async () => {
  await assert.rejects(loadInboxSummaryPage(ids(100), async ({ productIds }) => {
    if (productIds[0] === '50') throw Error('read failed'); return rows(productIds);
  }, () => true), /read failed/);
  assert.deepEqual(await loadInboxSummaryPage(['fresh'], async ({ productIds }) => rows(productIds), () => true), rows(['fresh']));
});
test('already obsolete page makes no requests', async () => {
  assert.equal(await loadInboxSummaryPage(ids(100), async () => { assert.fail('obsolete request'); }, () => false), null);
});
