import test from 'node:test';
import assert from 'node:assert/strict';
import { salesMetrics, salesWindows } from '../src/main/product-data/normalize.ts';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';

const end = Date.parse('2026-10-07T13:54:01.930Z');
const windows = salesWindows('2026-09-25T13:54:02.053Z', end);
function daily(count = 2): JsonObject[] {
  return Array.from({ length: 13 }, (_, index) => {
    const day = Date.parse('2026-09-25T00:00:00Z') + index * 86400000;
    return { interval: new Date(day).toISOString() + '--' + new Date(day + 86400000).toISOString(), unitCount: count };
  });
}
test('live Amazon daily labels cover entire UTC days while boundary quantities represent only the requested partial interval', () => {
  const result = salesMetrics({ payload: daily() }, windows);
  assert.equal(result.units30d, 26); assert.equal(result.units7d, 14);
  assert.equal(result.window30dStart, '2026-09-25T13:54:02.053Z');
  assert.equal(result.windowEnd, '2026-10-07T13:54:01.930Z');
});
test('same-day first upload includes its API partial-day quantity without moving the query start backwards', () => {
  const range = salesWindows('2026-10-07T10:13:22.315Z', end);
  const result = salesMetrics({ payload: [daily(3).at(-1)!] }, range);
  assert.equal(result.units7d, 3); assert.equal(result.units30d, 3);
  assert.equal(result.window30dStart, '2026-10-07T10:13:22.315Z');
});
test('old full days outside the query are excluded and legitimate explicit zero remains zero', () => {
  const payload = [{ interval: '2026-09-24T00:00:00Z--2026-09-25T00:00:00Z', unitCount: 999 }, ...daily(0)];
  const result = salesMetrics({ payload }, windows);
  assert.equal(result.units7d, 0); assert.equal(result.units30d, 0);
});
test('missing and duplicate day buckets remain unknown instead of making partial sums look complete', () => {
  const payload = daily(); payload.splice(10, 1);
  const result = salesMetrics({ payload }, windows);
  assert.equal(result.units7d, null); assert.equal(result.units30d, null);
  const duplicate = daily(); duplicate.push(duplicate.at(-1)!);
  assert.equal(salesMetrics({ payload: duplicate }, windows).units7d, null);
});
test('unexpected multi-day buckets cannot be clamped into valid daily metrics', () => {
  assert.throws(() => salesMetrics({ payload: [{ interval: '2026-09-24T00:00:00Z--2026-10-08T00:00:00Z', unitCount: 999 }] }, windows));
});
