import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { MiaoshouService } from '../src/main/miaoshou/service.ts';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { assertMiaoshouHistory, validateMiaoshouReceipt } from '../src/main/miaoshou/persistence.ts';
import { clearMiaoshouConfig } from '../src/main/miaoshou/vault.ts';
import { detailFixture, listFixture, mappingFor, testMiaoshouClock, testMiaoshouStorage } from './helpers/miaoshou-fixture.ts';

const at = new Date('2026-10-06T01:02:03.000Z');
const credentials = { appKey: 'test-app-key-012345', appSecret: 'SECRET-never-in-files-or-errors' };
const LIST_PATH = '/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list';
const DETAIL_PATH = '/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail';
function setup(options: ConstructorParameters<typeof MiaoshouService>[3] = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'htc-miaoshou-')), store = new WorkspaceStore(directory), storage = testMiaoshouStorage();
  const service = new MiaoshouService(directory, store, storage, { now: () => at, rateLimitClock: testMiaoshouClock(), ...options });
  return { directory, store, storage, service, async dispose() { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const response = (raw: unknown) => new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } });

test('live list and detail sign the exact sent body and use only fixed read endpoints', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const env = setup({ fetch: (async (url, init) => { calls.push({ url: String(url), init: init! }); return response(String(url).endsWith('_list') ? listFixture() : detailFixture()); }) as typeof fetch });
  try {
    assert.equal(env.service.getStatus().mode, 'unconfigured');
    assert.throws(() => env.service.setMode('live'), /配置/);
    const status = env.service.importConfig(credentials); assert.equal(status.mode, 'live'); assert.equal(status.configured, true);
    assert.ok(!JSON.stringify(status).includes(credentials.appKey));
    const list = await env.service.listProducts({ pageNo: 1, pageSize: 20 });
    assert.deepEqual(list.items[0], { id: '90071992547409931', title: '三维收纳袋', sourceUrl: 'https://detail.1688.com/offer/123456.html', sourceName: '1688', minPrice: '0', maxPrice: '9.876543', updatedAt: '2026-10-06 10:00:00', status: 'NORMAL' });
    const preview = await env.service.previewProduct({ id: list.items[0].id }); assert.equal(preview.product.remoteId, list.items[0].id);
    for (const [index, call] of calls.entries()) {
      const path = index === 0 ? LIST_PATH : DETAIL_PATH;
      assert.equal(call.url, `https://openapi-erp.91miaoshou.com${path}`); assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
      const headers = new Headers(call.init.headers), body = String(call.init.body), timestamp = '1791248523';
      assert.equal(headers.get('x-app-key'), credentials.appKey); assert.equal(headers.get('x-timestamp'), timestamp);
      assert.equal(headers.get('x-sign'), createHmac('sha256', credentials.appSecret).update(credentials.appSecret + path + timestamp + credentials.appKey + body + credentials.appSecret).digest('hex'));
      assert.equal(body, index === 0 ? '{"pageNo":1,"pageSize":20}' : '{"commonCollectBoxDetailId":90071992547409931}');
    }
    for (const name of readdirSync(join(env.directory, 'miaoshou-vault'))) {
      const file = readFileSync(join(env.directory, 'miaoshou-vault', name)); assert.ok(!file.includes(credentials.appSecret)); assert.ok(!file.includes(credentials.appKey));
    }
    assert.throws(() => env.service.importConfig({ ...credentials, endpoint: 'https://evil.test' }), /配置/);
  } finally { await env.dispose(); }
});

test('detail parser preserves numeric precision and third dimension while excluding account data and HTML', () => {
  const snapshot = normalizeDetail(detailFixture(), at.toISOString());
  assert.equal(snapshot.remoteId, '90071992547409931'); assert.equal(snapshot.dimensions.find(d => d.id === 'third')?.name, '包装');
  assert.equal(snapshot.skus.find(s => s.key === 'arbitraryB')?.price, '9.876543');
  assert.equal(snapshot.skus.find(s => s.key === 'arbitraryB')?.packageWidth, null);
  assert.equal(snapshot.skus.find(s => s.key === 'arbitraryA')?.price, '0');
  assert.equal(snapshot.skus.find(s => s.key === 'arbitraryA')?.stock, null);
  assert.ok(snapshot.description.includes('商品说明 & 尺寸')); assert.ok(!snapshot.description.includes('<')); assert.ok(!snapshot.description.includes('secret script'));
  assert.ok(!JSON.stringify(snapshot).includes('MUST_NOT_STORE')); assert.ok(!('dimensions' in snapshot.skus[0]));
});

test('live detail accepts empty arrays for absent specification and SKU maps', () => {
  for (const field of ['colorMap', 'sizeMap', 'saleProp3Map', 'skuMap']) {
    const emptyObject = detailFixture(), emptyArray = detailFixture();
    (emptyObject.data.editCommonCollectBoxDetail as Record<string, unknown>)[field] = {};
    (emptyArray.data.editCommonCollectBoxDetail as Record<string, unknown>)[field] = [];
    assert.deepEqual(normalizeDetail(emptyArray, at.toISOString()), normalizeDetail(emptyObject, at.toISOString()), field);
  }
});

test('live detail still rejects nonempty arrays in specification and SKU maps', () => {
  for (const field of ['colorMap', 'sizeMap', 'saleProp3Map', 'skuMap']) {
    const raw = detailFixture();
    (raw.data.editCommonCollectBoxDetail as Record<string, unknown>)[field] = [{ name: 'Unknown relation', price: '1.00' }];
    assert.throws(() => normalizeDetail(raw, at.toISOString()), { code: 'RESPONSE' }, field);
  }
});

test('parser refuses unsafe IDs, excess SKU/attributes/images/text and strips unsafe URLs', () => {
  const unsafeId = detailFixture(); (unsafeId.data.editCommonCollectBoxDetail as unknown as Record<string, unknown>).commonCollectBoxDetailId = 9007199254740992;
  assert.throws(() => normalizeDetail(unsafeId, at.toISOString()));
  const tooMany = detailFixture(); tooMany.data.editCommonCollectBoxDetail.skuMap = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`s${i}`, { price: 1 }])) as never;
  assert.throws(() => normalizeDetail(tooMany, at.toISOString()), /200/);
  const long = detailFixture(); long.data.editCommonCollectBoxDetail.title = 'x'.repeat(501); assert.throws(() => normalizeDetail(long, at.toISOString()));
  const attrs = detailFixture(); attrs.data.editCommonCollectBoxDetail.sourceAttrs = Array.from({ length: 101 }, () => ({ name: 'a', value: 'b' })); assert.throws(() => normalizeDetail(attrs, at.toISOString()));
  const images = detailFixture(); images.data.editCommonCollectBoxDetail.imgUrls = Array.from({ length: 201 }, (_, i) => `https://images.example.com/${i}.jpg`); assert.throws(() => normalizeDetail(images, at.toISOString()));
  const unsafe = detailFixture(); unsafe.data.editCommonCollectBoxDetail.imgUrls = ['https://127.0.0.1/a', 'https://user:pass@images.example.com/a', 'https://images.example.com/a?token=secret', 'http://images.example.com/a', 'https://[::1]/a'];
  unsafe.data.editCommonCollectBoxDetail.sourceList[0].sourceItemUrl = 'https://10.0.0.1/private';
  const parsed = normalizeDetail(unsafe, at.toISOString()); assert.equal(parsed.sources[0].sourceItemUrl, ''); assert.equal(parsed.images.length, 2); assert.ok(parsed.warnings.length);
});

test('three demo fixtures exercise the parser and never reach fetch or claim verified supplier facts', async () => {
  const env = setup({ fetch: (async () => { assert.fail('demo reached network'); }) as typeof fetch });
  try {
    env.service.setMode('demo'); const list = await env.service.listProducts({ pageNo: 1, pageSize: 20 }); assert.equal(list.total, 3);
    for (const item of list.items) {
      assert.match(item.title, /演示/); const preview = await env.service.previewProduct({ id: item.id }); assert.equal(preview.mode, 'demo');
      const imported = env.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) });
      const product = env.store.getProduct(imported.productId); assert.equal(product.origin, 'sample');
      assert.equal(env.store.listWorkspacePlacements().find(p => p.productId === product.id)?.lane, 'inbox');
      assert.ok(product.variants.every(v => v.inventory === null && !v.purchasePrice));
    }
    assert.throws(() => env.service.setMode('invalid'));
  } finally { await env.dispose(); }
});

test('imports are atomic, explicit, duplicate-safe and preserve manual changes', async () => {
  const env = setup({ fetch: (async () => response(detailFixture())) as typeof fetch });
  try {
    env.service.importConfig(credentials); const preview = await env.service.previewProduct({ id: '90071992547409931' });
    const mapping = mappingFor(preview.product, true); mapping.priceField = 'oriPrice'; mapping.currency = 'CNY';
    const imported = env.service.importProduct({ previewId: preview.previewId, mapping }); assert.equal(imported.duplicate, false);
    const product = env.store.getProduct(imported.productId); assert.equal(product.variants.length, 2); assert.ok(product.variants.every(v => v.inventory === null));
    assert.ok(product.variants.every(v => v.originalSpec === '颜色: 蓝色 / 尺寸: M / 包装: 3 件装'));
    assert.equal(product.variants.find(v => v.purchasePrice)?.purchasePrice, '8.90');
    assert.equal(product.facts[0].source, 'import'); assert.equal(product.facts[0].state, 'source_confirmed'); assert.match(product.facts[0].sourceRef, /123456/);
    const receipt = env.service.getReceipt(product.id)!; assert.deepEqual(validateMiaoshouReceipt(receipt), receipt);
    const blue = receipt.snapshot.images.find(i => i.url.endsWith('blue.jpg'))!;
    assert.ok(receipt.skuMappings.every(m => m.imageIds.length === 1 && m.imageIds[0] === blue.id));
    assert.ok(!JSON.stringify(receipt).includes('MUST_NOT_STORE')); assert.ok(!JSON.stringify(receipt).includes(credentials.appSecret));
    env.store.saveProduct({ id: product.id, revision: product.revision, title: '人工改过', sourceUrl: product.sourceUrl, description: product.description, status: product.status,
      facts: product.facts, variants: product.variants.map(({ sourceSpec: _s, sourcePurchasePrice: _p, ...v }) => v) });
    const again = env.service.importProduct({ previewId: preview.previewId, mapping }); assert.equal(again.productId, product.id); assert.equal(again.duplicate, true); assert.equal(env.store.getProduct(product.id).title, '人工改过');
    const next = env.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) }); assert.notEqual(next.productId, product.id);
    const unmapped = env.store.getProduct(next.productId); assert.ok(unmapped.variants.every(v => /待核对/.test(v.originalSpec))); assert.ok(next.warnings.some(w => /规格/.test(w)));
    const db = openDatabase(env.directory); try { assert.doesNotThrow(() => assertMiaoshouHistory(db)); } finally { db.close(); }
  } finally { await env.dispose(); }
});

test('mapping rejects unknown, duplicate, incomplete or renderer-supplied data and unsupported precision is left blank', async () => {
  const env = setup({ fetch: (async () => response(detailFixture())) as typeof fetch });
  try {
    env.service.importConfig(credentials); const preview = await env.service.previewProduct({ id: '90071992547409931' }); const mapping = mappingFor(preview.product);
    assert.throws(() => env.service.importProduct({ previewId: preview.previewId, mapping, snapshot: preview.product }));
    assert.throws(() => env.service.importProduct({ previewId: preview.previewId, mapping: { ...mapping, skus: [] } }));
    assert.throws(() => env.service.importProduct({ previewId: preview.previewId, mapping: { ...mapping, skus: [mapping.skus[0], mapping.skus[0]] } }));
    assert.throws(() => env.service.importProduct({ previewId: preview.previewId, mapping: { ...mapping, skus: mapping.skus.map(s => ({ ...s, dimensions: { color: 'missing' } })) } }));
    const input = { previewId: preview.previewId, mapping: { ...mapping, priceField: 'price', currency: 'CNY' } };
    const imported = env.service.importProduct(input); const product = env.store.getProduct(imported.productId);
    assert.equal(product.variants.find(v => v.sourceSpec.includes('arbitraryB'))?.purchasePrice, ''); assert.ok(imported.warnings.some(w => /精度/.test(w)));
  } finally { await env.dispose(); }
});

test('failed receipt write rolls back products, variants, facts, placements and audit rows', async () => {
  const env = setup({ fetch: (async () => response(detailFixture())) as typeof fetch });
  try {
    env.service.importConfig(credentials); const preview = await env.service.previewProduct({ id: '90071992547409931' });
    const db = openDatabase(env.directory);
    try {
      db.exec("CREATE TRIGGER reject_miaoshou BEFORE INSERT ON miaoshou_receipts BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
      assert.throws(() => env.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) }));
      for (const table of ['products', 'variants', 'facts', 'product_workspaces', 'audit_events', 'miaoshou_receipts']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
    } finally { db.close(); }
  } finally { await env.dispose(); }
});

test('backup validator rejects extra account blobs, modified fingerprint, wrong variant owner and incomplete mappings', async () => {
  const env = setup({ fetch: (async () => response(detailFixture())) as typeof fetch });
  try {
    env.service.importConfig(credentials); const preview = await env.service.previewProduct({ id: '90071992547409931' });
    const imported = env.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) }); const receipt = env.service.getReceipt(imported.productId)!;
    assert.throws(() => validateMiaoshouReceipt({ ...receipt, accountBlob: {} }));
    assert.throws(() => validateMiaoshouReceipt({ ...receipt, snapshot: { ...receipt.snapshot, sourceSupplierInfo: {} } }));
    assert.throws(() => validateMiaoshouReceipt({ ...receipt, fingerprint: '0'.repeat(64) }));
    assert.throws(() => validateMiaoshouReceipt({ ...receipt, skuMappings: [] }));
    assert.throws(() => validateMiaoshouReceipt({ ...receipt, skuMappings: receipt.skuMappings.map(m => ({ ...m, imageIds: ['unselected'] })) }));
    const db = openDatabase(env.directory);
    try {
      const other = env.store.createProduct(); db.prepare('UPDATE variants SET product_id=? WHERE id=?').run(other.id, receipt.skuMappings[0].localVariantId);
      assert.throws(() => assertMiaoshouHistory(db));
      db.prepare('DELETE FROM variants WHERE id=?').run(receipt.skuMappings[0].localVariantId); assert.doesNotThrow(() => assertMiaoshouHistory(db));
    } finally { db.close(); }
  } finally { await env.dispose(); }
});

test('upstream errors are redacted, timeout and close settle even a fetch that ignores cancellation', async () => {
  for (const code of ['appNoPermission', 'limit', 'signError']) {
    const env = setup({ fetch: (async () => response({ result: 'error', code, message: credentials.appSecret })) as typeof fetch });
    try { env.service.importConfig(credentials); await assert.rejects(env.service.listProducts({ pageNo: 1, pageSize: 20 }), e => e instanceof Error && !e.message.includes(credentials.appSecret) && /妙手/.test(e.message)); } finally { await env.dispose(); }
  }
  const env = setup({ timeoutMs: 20, fetch: (() => new Promise<Response>(() => {})) as typeof fetch });
  try {
    env.service.importConfig(credentials); await assert.rejects(env.service.listProducts({ pageNo: 1, pageSize: 20 }), /超时/); assert.equal(env.service.busy, false);
    const pending = env.service.previewProduct({ id: '123' }); const rejection = assert.rejects(pending, /关闭/); assert.equal(env.service.busy, true); await env.service.close(); await rejection; assert.equal(env.service.busy, false);
  } finally { await env.dispose(); }
});

test('mode and config changes cancel stale requests, invalidate previews, and account identity isolates imports', async () => {
  let resolve!: (response: Response) => void;
  const env = setup({ fetch: (() => new Promise<Response>(r => { resolve = r; })) as typeof fetch });
  try {
    env.service.importConfig(credentials); const pending = env.service.previewProduct({ id: '90071992547409931' }); const rejected = assert.rejects(pending, /配置|模式/);
    await new Promise<void>(ready => setImmediate(ready));
    env.service.setMode('demo'); resolve(response(detailFixture())); await rejected;
    const list = await env.service.listProducts({ pageNo: 1, pageSize: 20 }); const demo = await env.service.previewProduct({ id: list.items[0].id });
    env.service.importConfig(credentials); assert.throws(() => env.service.importProduct({ previewId: demo.previewId, mapping: mappingFor(demo.product) }), /预览/);
    const firstPromise = env.service.previewProduct({ id: '90071992547409931' });
    await new Promise<void>(ready => setImmediate(ready)); resolve(response(detailFixture())); const first = await firstPromise;
    const a = env.service.importProduct({ previewId: first.previewId, mapping: mappingFor(first.product) });
    env.service.importConfig({ ...credentials, appKey: 'second-app-key-99999' });
    const secondPromise = env.service.previewProduct({ id: '90071992547409931' });
    await new Promise<void>(ready => setImmediate(ready)); resolve(response(detailFixture())); const second = await secondPromise;
    const b = env.service.importProduct({ previewId: second.previewId, mapping: mappingFor(second.product) }); assert.notEqual(a.productId, b.productId);
    assert.notEqual(env.service.getReceipt(a.productId)?.accountScope, env.service.getReceipt(b.productId)?.accountScope);
    const status = env.service.disconnect(); assert.equal(status.mode, 'unconfigured'); assert.equal(status.configured, false);
  } finally { await env.dispose(); }
});

test('preview cache expires, bounds memory and keeps the trusted snapshot separate from returned objects', async () => {
  let date = at;
  const env = setup({ now: () => date, fetch: (async () => response(detailFixture())) as typeof fetch });
  try {
    env.service.importConfig(credentials); const first = await env.service.previewProduct({ id: '90071992547409931' }); const originalTitle = first.product.title;
    first.product.title = 'renderer attack'; const imported = env.service.importProduct({ previewId: first.previewId, mapping: mappingFor(first.product) }); assert.equal(env.store.getProduct(imported.productId).title, originalTitle);
    for (let i = 0; i < 20; i++) await env.service.previewProduct({ id: '90071992547409931' });
    assert.throws(() => env.service.importProduct({ previewId: first.previewId, mapping: mappingFor(first.product) }), /预览/);
    const recent = await env.service.previewProduct({ id: '90071992547409931' }); date = new Date(at.getTime() + 16 * 60_000);
    assert.throws(() => env.service.importProduct({ previewId: recent.previewId, mapping: mappingFor(recent.product) }), /预览/);
    assert.throws(() => env.service.importProduct({ previewId: randomUUID(), mapping: mappingFor(recent.product) }), /预览/);
  } finally { await env.dispose(); }
});

test('semantic map order and capture time do not duplicate an import; changed source data does', async () => {
  let raw = detailFixture(), date = at;
  const env = setup({ now: () => date, fetch: (async () => response(raw)) as typeof fetch });
  try {
    env.service.importConfig(credentials); const a = await env.service.previewProduct({ id: '90071992547409931' });
    const first = env.service.importProduct({ previewId: a.previewId, mapping: mappingFor(a.product, true) });
    raw.data.editCommonCollectBoxDetail.skuMap = Object.fromEntries(Object.entries(raw.data.editCommonCollectBoxDetail.skuMap).reverse()) as typeof raw.data.editCommonCollectBoxDetail.skuMap;
    raw.data.editCommonCollectBoxDetail.colorMap = Object.fromEntries(Object.entries(raw.data.editCommonCollectBoxDetail.colorMap).reverse()) as typeof raw.data.editCommonCollectBoxDetail.colorMap;
    date = new Date(at.getTime() + 1000); const b = await env.service.previewProduct({ id: '90071992547409931' }); const reordered = mappingFor(b.product, true); reordered.skus.reverse();
    const again = env.service.importProduct({ previewId: b.previewId, mapping: reordered }); assert.equal(again.duplicate, true); assert.equal(again.productId, first.productId);
    raw = detailFixture(); raw.data.editCommonCollectBoxDetail.title = '来源名称改变'; const c = await env.service.previewProduct({ id: '90071992547409931' });
    const changed = env.service.importProduct({ previewId: c.previewId, mapping: mappingFor(c.product, true) }); assert.notEqual(changed.productId, first.productId);
    assert.equal(env.store.getProduct(first.productId).title, a.product.title);
  } finally { await env.dispose(); }
});

test('configuration and explicit mode survive restart; restore clear prevents surviving vault reactivation', async () => {
  const env = setup(); let reopened: MiaoshouService | undefined;
  try {
    env.service.importConfig(credentials); env.service.setMode('demo'); await env.service.close();
    reopened = new MiaoshouService(env.directory, env.store, env.storage); assert.equal(reopened.getStatus().mode, 'demo'); assert.equal(reopened.getStatus().configured, true);
    reopened.setMode('live'); await reopened.close(); reopened = undefined; clearMiaoshouConfig(env.directory);
    reopened = new MiaoshouService(env.directory, env.store, env.storage); assert.equal(reopened.getStatus().mode, 'unconfigured'); assert.equal(reopened.getStatus().configured, false);
  } finally { await reopened?.close(); await env.dispose(); }
});

test('sensitive query names and reserved local domains never survive snapshot normalization', () => {
  const raw = detailFixture(); raw.data.editCommonCollectBoxDetail.imgUrls = [
    'https://images.example.com/a?key=leaked', 'https://router.home.arpa/image.jpg', 'https://nas.localdomain/image.jpg',
  ]; raw.data.editCommonCollectBoxDetail.colorMap = {} as never;
  assert.equal(normalizeDetail(raw, at.toISOString()).images.length, 0);
});

test('response limits cancel the stream and reject rather than silently truncate', async () => {
  let cancelled = false;
  const env = setup({ fetch: (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } })) as typeof fetch });
  try {
    env.service.importConfig(credentials); await assert.rejects(env.service.listProducts({ pageNo: 1, pageSize: 20 }), /过大/); assert.equal(cancelled, true); assert.equal(env.service.busy, false);
  } finally { await env.dispose(); }
});

test('duplicate JSON keys, mismatched detail IDs and invalid pagination are rejected', async () => {
  let reply = () => new Response('{"result":"success","result":"error","code":"success","data":{"detailList":[],"total":0}}');
  const env = setup({ fetch: (async () => reply()) as typeof fetch });
  try {
    env.service.importConfig(credentials); await assert.rejects(env.service.listProducts({ pageNo: 1, pageSize: 20 }));
    reply = () => response(detailFixture()); await assert.rejects(env.service.previewProduct({ id: 'other' }));
    for (const input of [{ pageNo: 0, pageSize: 20 }, { pageNo: 1, pageSize: 21 }, { pageNo: 1, pageSize: '20' }, { pageNo: 1, pageSize: 20, endpoint: 'evil' }]) await assert.rejects(env.service.listProducts(input));
  } finally { await env.dispose(); }
});

test('credential echoes in recognized product fields are scrubbed and missing OS encryption never stores plaintext', async () => {
  const raw = detailFixture(); raw.data.editCommonCollectBoxDetail.title = `${credentials.appKey} ${credentials.appSecret}`;
  const env = setup({ fetch: (async () => response(raw)) as typeof fetch }); let unavailable: MiaoshouService | undefined;
  try {
    env.service.importConfig(credentials); const preview = await env.service.previewProduct({ id: '90071992547409931' });
    assert.ok(!JSON.stringify(preview).includes(credentials.appKey)); assert.ok(!JSON.stringify(preview).includes(credentials.appSecret)); await env.service.close();
    unavailable = new MiaoshouService(env.directory, env.store, { isEncryptionAvailable: () => false, encryptString: () => { assert.fail('must not encrypt'); }, decryptString: () => { assert.fail('must not decrypt'); } });
    assert.equal(unavailable.getStatus().configured, false); assert.throws(() => unavailable!.importConfig(credentials), /加密/); unavailable.setMode('demo');
    assert.equal((await unavailable.listProducts({ pageNo: 1, pageSize: 20 })).total, 3);
  } finally { await unavailable?.close(); await env.dispose(); }
});

test('credentials reconstructed by entity decoding or tag removal cannot reach previews, facts or receipt history', async () => {
  const numeric = (value: string) => [...value].map(char => `&#${char.charCodeAt(0)};`).join('');
  const hexadecimal = (value: string) => [...value].map(char => `&#x${char.charCodeAt(0).toString(16)};`).join('');
  for (const field of ['notesText', 'notes'] as const) {
    const raw = detailFixture(), detail = raw.data.editCommonCollectBoxDetail;
    detail.notesText = ''; detail.notes = '';
    detail[field] = `保留说明 ${numeric(credentials.appSecret)} ${hexadecimal(credentials.appKey)} ${credentials.appSecret.slice(0, 6)}<b></b>${credentials.appSecret.slice(6)}`;
    detail.title = `标题 ${hexadecimal(credentials.appSecret)}`;
    detail.sourceAttrs = [{ name: '备注', value: `安全说明 ${numeric(credentials.appSecret)}` }];
    detail.colorMap.opaqueBlue.name = hexadecimal(credentials.appKey);
    detail.imgUrls.push(`https://images.example.com/${numeric(credentials.appSecret)}/leaked.jpg`);
    const env = setup({ fetch: (async () => response(raw)) as typeof fetch });
    try {
      env.service.importConfig(credentials); const preview = await env.service.previewProduct({ id: detail.commonCollectBoxDetailId });
      const serialized = JSON.stringify(preview);
      for (const secret of [credentials.appKey, credentials.appSecret, numeric(credentials.appSecret), hexadecimal(credentials.appSecret), hexadecimal(credentials.appKey)]) assert.ok(!serialized.includes(secret));
      assert.match(preview.product.description, /^保留说明 /); assert.match(preview.product.description, /已隐藏/);
      assert.equal(preview.product.images.length, 3); assert.ok(preview.product.images.every(image => !image.url.includes('leaked.jpg')));
      const imported = env.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product, true) });
      const product = env.store.getProduct(imported.productId), receipt = env.service.getReceipt(imported.productId)!;
      assert.equal(product.facts[0].value, '安全说明 已隐藏'); assert.deepEqual(validateMiaoshouReceipt(receipt), receipt);
      const persisted = JSON.stringify({ product, receipt }); assert.ok(!persisted.includes(credentials.appSecret)); assert.ok(!persisted.includes(credentials.appKey));
      const db = openDatabase(env.directory); try { assert.doesNotThrow(() => assertMiaoshouHistory(db)); } finally { db.close(); }
    } finally { await env.dispose(); }
  }
});

test('list text and normalized URL credentials are sanitized without producing altered remote URLs', async () => {
  const encoded = [...credentials.appSecret].map(char => `&#${char.charCodeAt(0)};`).join('');
  const raw = listFixture(); raw.data.detailList[0].title = `列表 ${encoded}`;
  raw.data.detailList[0].sourceList[0].source = `&#${credentials.appSecret.charCodeAt(0)};${credentials.appSecret.slice(1)}`;
  raw.data.detailList[0].sourceList[0].sourceItemUrl = `https://detail.1688.com/${credentials.appSecret}/offer.html`;
  const env = setup({ fetch: (async () => response(raw)) as typeof fetch });
  try {
    env.service.importConfig(credentials); const list = await env.service.listProducts({ pageNo: 1, pageSize: 20 });
    assert.equal(list.items[0].title, '列表 已隐藏'); assert.equal(list.items[0].sourceName, '已隐藏'); assert.equal(list.items[0].sourceUrl, '');
    assert.ok(!JSON.stringify(list).includes(credentials.appSecret));
  } finally { await env.dispose(); }
});

test('raw-wire numeric IDs and decimal tokens retain their exact values and details send signed numeric IDs', async () => {
  const id = '18446744073709551615', calls: { url: string; init: RequestInit }[] = [];
  const listWire = '{"result":"success","code":"success","data":{"detailList":[{"commonCollectBoxDetailId":18446744073709551615,"title":"原始数字商品","minSkuPrice":123456789012345678.123456789012345678,"maxSkuPrice":123456789012345678.123456789012345678}],"total":1}}';
  const detailWire = '{"result":"success","code":"success","data":{"editCommonCollectBoxDetail":{"commonCollectBoxDetailId":1.8446744073709551615e19,"title":"原始数字商品","skuMap":{"wire-sku":{"itemNum":"wire-item","price":9.876543210123456789,"oriPrice":12345678901234567.8901,"stock":9007199254740993,"oriStock":0,"weight":1.23456789e-7,"packageLength":1.2300e2,"packageWidth":1e-18,"packageHeight":0.000000000000000001e18}}}}}';
  const env = setup({ fetch: (async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(String(url).endsWith('_list') ? listWire : detailWire); }) as typeof fetch });
  try {
    env.service.importConfig(credentials); const list = await env.service.listProducts({ pageNo: 1, pageSize: 20 });
    assert.equal(list.items[0].id, id); assert.equal(list.items[0].minPrice, '123456789012345678.123456789012345678');
    const preview = await env.service.previewProduct({ id }); assert.equal(preview.product.remoteId, id);
    assert.deepEqual(preview.product.skus[0], { key: 'wire-sku', itemNum: 'wire-item', price: '9.876543210123456789', oriPrice: '12345678901234567.8901', stock: '9007199254740993', oriStock: '0', weight: '0.000000123456789', packageLength: '123.00', packageWidth: '0.000000000000000001', packageHeight: '1' });
    const sent = calls[1].init, body = `{"commonCollectBoxDetailId":${id}}`; assert.equal(sent.body, body);
    const headers = new Headers(sent.headers), expected = createHmac('sha256', credentials.appSecret).update(credentials.appSecret + DETAIL_PATH + '1791248523' + credentials.appKey + body + credentials.appSecret).digest('hex');
    assert.equal(headers.get('x-sign'), expected);
    const imported = env.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) });
    const receipt = env.service.getReceipt(imported.productId)!; assert.deepEqual(receipt.snapshot.skus, preview.product.skus); assert.deepEqual(validateMiaoshouReceipt(receipt), receipt);
  } finally { await env.dispose(); }
});

test('raw-wire number expansion rejects excessive precision, huge exponents, negative values and fractional IDs', async () => {
  let token = '1e1000000', idToken = '123';
  const env = setup({ fetch: (async () => new Response(`{"result":"success","code":"success","data":{"editCommonCollectBoxDetail":{"commonCollectBoxDetailId":${idToken},"title":"数字边界","skuMap":{"one":{"price":${token}}}}}}`)) as typeof fetch });
  try {
    env.service.importConfig(credentials);
    for (const value of ['1e1000000', '1e-1000000', '1e-19', '0.1234567890123456789', '-1']) { token = value; await assert.rejects(env.service.previewProduct({ id: '123' }), /妙手/); }
    token = '1'; idToken = '123.5'; await assert.rejects(env.service.previewProduct({ id: '123' }), /妙手/);
  } finally { await env.dispose(); }
});

test('lossless wire parsing retains duplicate-key, maximum-depth and strict UTF-8 rejection', async () => {
  let reply: string | Uint8Array = '{"result":"success","code":"success","data":{"editCommonCollectBoxDetail":{"commonCollectBoxDetailId":123,"skuMap":{"a":{"price":0.123456789012345678,"price":1}}}}}';
  const env = setup({ fetch: (async () => new Response(reply as BodyInit)) as typeof fetch });
  try {
    env.service.importConfig(credentials); await assert.rejects(env.service.previewProduct({ id: '123' }));
    reply = '{"ignored":'.repeat(40) + '0' + '}'.repeat(40); await assert.rejects(env.service.previewProduct({ id: '123' }));
    reply = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d]); await assert.rejects(env.service.previewProduct({ id: '123' }));
  } finally { await env.dispose(); }
});

test('invalid numeric tokens in discarded metadata do not block valid products, while consumed SKU fields still reject them', async () => {
  let skuPrice = '1.25', skuStock = '3';
  const env = setup({ fetch: (async () => new Response(`{"result":"success","code":"success","data":{"editCommonCollectBoxDetail":{"commonCollectBoxDetailId":123,"title":"允许丢弃附带信息","sourceMataInfo":{"stock":-1,"price":0.1234567890123456789,"account":"ignored-account-marker"},"sourceSupplierInfo":{"stock":-7,"price":1e1000000},"skuMap":{"one":{"price":${skuPrice},"stock":${skuStock}}}}}}`)) as typeof fetch });
  try {
    env.service.importConfig(credentials); const preview = await env.service.previewProduct({ id: '123' });
    assert.equal(preview.product.skus[0].price, '1.25'); assert.equal(preview.product.skus[0].stock, '3');
    const imported = env.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) });
    const receipt = env.service.getReceipt(imported.productId)!; assert.deepEqual(validateMiaoshouReceipt(receipt), receipt);
    assert.ok(!JSON.stringify(receipt).includes('ignored-account-marker')); assert.ok(!JSON.stringify(receipt).includes('sourceMataInfo'));
    skuStock = '-1'; await assert.rejects(env.service.previewProduct({ id: '123' }), /妙手/);
    skuStock = '3'; skuPrice = '0.1234567890123456789'; await assert.rejects(env.service.previewProduct({ id: '123' }), /妙手/);
  } finally { await env.dispose(); }
});
