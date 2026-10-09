import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { collectionRequest, collectionSnapshot } from './helpers/collection-fixture.ts';
import { COLLECTION_MAX_MESSAGE_BYTES } from '../src/shared/collection-contracts.ts';

const subject = await import('../src/main/collection/validation.ts').catch(() => null);
function validation() { assert.ok(subject, 'collection validation is required'); return subject; }
const code = (expected: string) => (error: unknown) => { assert.equal((error as { code?: unknown }).code, expected); return true; };

test('source prices retain decimals and only immutable content changes its fingerprint', () => {
  const v = validation(), original = v.validateCollectionSnapshot(collectionSnapshot());
  assert.equal(original.skus[0].purchasePrice, '0.0350');
  assert.deepEqual(original.warnings, ['REMOTE_IMAGES_ONLY']);
  const later = { ...original, capturedAt: '2026-10-01T00:00:00.000Z' };
  assert.equal(v.collectionFingerprint(original), v.collectionFingerprint(later));
  assert.notEqual(v.collectionFingerprint(original), v.collectionFingerprint({ ...later, title: '变化后的商品' }));
});

test('missing fields remain an explicit draft and excessive local price precision is preserved with a warning', () => {
  const v = validation(), empty = collectionSnapshot(); empty.title = ''; empty.skus = []; empty.images = []; empty.skuImages = []; empty.pricing = { currency: 'CNY', unitPrice: null, range: null, tiers: [] };
  assert.deepEqual(v.validateCollectionSnapshot(empty).warnings, ['MISSING_TITLE', 'MISSING_SKUS', 'MISSING_PRICE', 'MISSING_IMAGES']);
  const precise = collectionSnapshot(); precise.skus[0].purchasePrice = '0.123456789012';
  const result = v.validateCollectionSnapshot(precise); assert.equal(result.skus[0].purchasePrice, '0.123456789012'); assert.ok(result.warnings.includes('PRICE_PRECISION_UNSUPPORTED'));
});

test('source, SKU and image relations reject invented ownership, foreign hosts and extra secrets', () => {
  const v = validation();
  const mutations: ((s: ReturnType<typeof collectionSnapshot>) => void)[] = [
    s => { s.images[0].url = 'https://cbu01.alicdn.com.attacker.test/a.jpg'; },
    s => { s.images[0].url = 'https://user:pass@cbu01.alicdn.com/a.jpg'; },
    s => { s.images[0].url = 'https://cbu01.alicdn.com/a.jpg?token=secret'; },
    s => { s.skuImages[0].specValue = '蓝色'; }, s => { s.skuImages[0].imageId = 'absent'; },
    s => { s.skuImages.push({ ...s.skuImages[0] }); }, s => { s.skus.push({ ...s.skus[0] }); },
    s => { s.images.push({ ...s.images[0] }); }, s => { s.skus[0].purchasePrice = '1e-5'; },
    s => { Object.assign(s, { cookie: 'secret' }); }, s => { Object.assign(s.skus[0], { rawPage: 'secret' }); },
    s => { s.warnings.push('free text' as never); }, s => { s.pricing.range = { min: '2', max: '1' }; },
  ];
  for (const mutate of mutations) { const snapshot = collectionSnapshot(); mutate(snapshot); assert.throws(() => v.validateCollectionSnapshot(snapshot), code('INVALID_SNAPSHOT')); }
  for (const sourceUrl of ['https://detail.1688.com/offer/999.html', 'https://detail.1688.com/offer/123456789012.html?cookie=x', 'http://detail.1688.com/offer/123456789012.html']) assert.throws(() => v.validateCollectionSnapshot({ ...collectionSnapshot(), sourceUrl }), code('INVALID_SOURCE'));
});

test('more than 200 provider SKUs are rejected rather than truncated', () => {
  const v = validation(), snapshot = collectionSnapshot(); snapshot.skus = Array.from({ length: 201 }, (_, i) => ({ ...snapshot.skus[0], providerSkuId: `sku-${i}` }));
  assert.throws(() => v.validateCollectionSnapshot(snapshot), code('TOO_MANY_SKUS'));
});

test('source identifiers and nested collections remain bounded', () => {
  const v = validation();
  for (const mutate of [
    (s: ReturnType<typeof collectionSnapshot>) => { s.skus[0].providerSkuId = 'path/with/slash'; },
    (s: ReturnType<typeof collectionSnapshot>) => { s.images = Array.from({ length: 201 }, (_, i) => ({ ...s.images[0], id: `image-${i}`, url: `https://cbu01.alicdn.com/${i}.jpg` })); },
    (s: ReturnType<typeof collectionSnapshot>) => { s.skus[0].attributes = Array.from({ length: 21 }, (_, i) => ({ name: `name${i}`, value: 'value' })); },
  ]) { const snapshot = collectionSnapshot(); mutate(snapshot); assert.throws(() => v.validateCollectionSnapshot(snapshot), code('INVALID_SNAPSHOT')); }
});

test('wire decoding enforces byte size, UTF-8, exact version/type, IDs and duplicate JSON keys', () => {
  const v = validation(), request = collectionRequest();
  assert.equal(v.parseCollectionRequest(Buffer.from(JSON.stringify(request))).type, 'capture');
  assert.deepEqual(v.parseCollectionRequest(Buffer.from(JSON.stringify({ version: 1, type: 'status', requestId: randomUUID() }))).type, 'status');
  assert.throws(() => v.parseCollectionRequest(Buffer.alloc(COLLECTION_MAX_MESSAGE_BYTES + 1)), code('TOO_LARGE'));
  assert.throws(() => v.parseCollectionRequest(Buffer.from([0xff])), code('INVALID_MESSAGE'));
  assert.throws(() => v.parseCollectionRequest(Buffer.from(JSON.stringify({ ...request, version: 2 }))), code('UNSUPPORTED_VERSION'));
  for (const invalid of [{ ...request, type: 'exec' }, { ...request, requestId: '../../etc' }, { ...request, secret: 'raw' }]) assert.throws(() => v.parseCollectionRequest(Buffer.from(JSON.stringify(invalid))), code('INVALID_MESSAGE'));
  const raw = JSON.stringify(request);
  for (const duplicate of [raw.replace('"version":1', '"version":1,"version":1'), raw.replace('"title":', '"tit\\u006ce":"spoof","title":')]) assert.throws(() => v.parseCollectionRequest(Buffer.from(duplicate)), code('INVALID_MESSAGE'));
});
