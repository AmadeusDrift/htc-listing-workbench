import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceProductUrl } from '../src/shared/source-links.ts';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { detailFixture } from './helpers/miaoshou-fixture.ts';

test('1688 source links survive http and tracking parameters as canonical purchase links', () => {
  assert.equal(sourceProductUrl({ source: '1688', sourceItemId: '123456', sourceItemUrl: 'http://detail.1688.com/offer/123456.html?spm=tracking' }), 'https://detail.1688.com/offer/123456.html');
});
test('an explicit 1688 item ID recovers missing links, never invents a shop identity', () => {
  assert.equal(sourceProductUrl({ source: '1688', sourceItemId: '123456', sourceItemUrl: '' }), 'https://detail.1688.com/offer/123456.html');
  assert.equal(sourceProductUrl({ source: 'unknown', sourceItemId: '123456', sourceItemUrl: '' }), '');
  assert.equal(sourceProductUrl({ source: '1688', sourceItemId: 'a123456', sourceItemUrl: '' }), '');
});
test('ambiguous or unsafe source links are not silently associated with another product', () => {
  for (const sourceItemUrl of ['https://detail.1688.com.evil.com/offer/123456.html','https://detail.1688.com/offer/999999.html','javascript:alert(1)','https://user:pass@detail.1688.com/offer/123456.html']) {
    assert.equal(sourceProductUrl({ source: '1688', sourceItemId: '123456', sourceItemUrl }), '');
  }
});
test('Miaoshou imports retain a usable purchase URL even with HTTP source links', () => {
  const raw = detailFixture(); raw.data.editCommonCollectBoxDetail.sourceList[0].sourceItemUrl = 'http://detail.1688.com/offer/123456.html?spm=example';
  assert.equal(normalizeDetail(raw, '2026-10-07T00:00:00.000Z').sources[0].sourceItemUrl, 'https://detail.1688.com/offer/123456.html');
});

test('1688 normalization does not bypass offer identity validation through generic HTTPS fallback', () => {
  for (const url of ['https://detail.1688.com/offer/999999.html', 'https://detail.1688.com.evil.com/offer/123456.html']) {
    const raw = detailFixture(); raw.data.editCommonCollectBoxDetail.sourceList[0].sourceItemUrl = url;
    assert.equal(normalizeDetail(raw, '2026-10-07T00:00:00.000Z').sources[0].sourceItemUrl, '');
  }
});
