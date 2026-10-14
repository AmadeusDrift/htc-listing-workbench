import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePageSize, pageWindow } from '../src/renderer/list-pagination.ts';
test('page sizes accept only 20/50/100; stale or all values return default', () => {
  for (const value of [null, '', 'all', '500', '8']) assert.equal(normalizePageSize(value), 20);
  assert.equal(normalizePageSize('50'), 50); assert.equal(normalizePageSize('100'), 100);
});
test('shrinking lists and page-size changes clamp to valid bounds', () => {
  assert.deepEqual(pageWindow(51, 50, 8), { page: 2, pages: 2, start: 50, end: 100 });
  assert.deepEqual(pageWindow(0, 20, 3), { page: 1, pages: 1, start: 0, end: 20 });
});
