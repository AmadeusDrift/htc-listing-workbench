import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { MiaoshouService } from '../src/main/miaoshou/service.ts';
import { openDatabase } from '../src/main/database.ts';
import { detailFixture, listFixture, mappingFor, testMiaoshouClock, testMiaoshouStorage } from './helpers/miaoshou-fixture.ts';
import type { MiaoshouDependencies } from '../src/main/miaoshou/service.ts';

const credentials = { appKey: 'SYNC_TEST_APP_KEY', appSecret: 'SYNC_TEST_APP_SECRET' };
async function setup(t: TestContext, count = 21, dependencies: MiaoshouDependencies = {}) {
  await mkdir(resolve('.test-data'), { recursive: true }); const directory = await mkdtemp(resolve('.test-data/miaoshou-sync-'));
  const store = new WorkspaceStore(directory), storage = testMiaoshouStorage(), calls: { operation: string; body: Record<string, unknown> }[] = [];
  let modified = '2026-10-07 10:00:00', failId = '', detailTitle = '原始商品', duplicatePages = false;
  let listTransform = (_value: ReturnType<typeof listFixture>, _page: number): void => {};
  const fetcher: typeof fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body)), operation = String(url).endsWith('_list') ? 'list' : 'detail'; calls.push({ operation, body });
    if (operation === 'list') {
      const page = duplicatePages ? 1 : Number(body.pageNo), size = Number(body.pageSize), value = listFixture(); value.data.total = count;
      value.data.detailList = Array.from({ length: Math.max(0, Math.min(size, count - (page - 1) * size)) }, (_, i) => ({ ...listFixture().data.detailList[0], commonCollectBoxDetailId: `product-${(page - 1) * size + i + 1}`, gmtModified: modified }));
      listTransform(value, page);
      return new Response(JSON.stringify(value));
    }
    if (body.commonCollectBoxDetailId === failId) return new Response('bad response', { status: 502 });
    const value = detailFixture(); value.data.editCommonCollectBoxDetail.commonCollectBoxDetailId = String(body.commonCollectBoxDetailId); value.data.editCommonCollectBoxDetail.title = detailTitle;
    const supplierId=String(100000+Number(String(body.commonCollectBoxDetailId).split('-').at(-1)));
    value.data.editCommonCollectBoxDetail.sourceList[0].sourceItemId=supplierId;
    value.data.editCommonCollectBoxDetail.sourceList[0].sourceItemUrl=`https://detail.1688.com/offer/${supplierId}.html`;
    return new Response(JSON.stringify(value));
  };
  const deps = { fetch: fetcher, rateLimitClock: testMiaoshouClock(), ...dependencies }; let service = new MiaoshouService(directory, store, storage, deps); service.importConfig(credentials);
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, calls, get service() { return service; }, change: () => { modified = '2026-10-07 11:00:00'; detailTitle = '来源更新后的商品'; }, noModified: () => { modified = ''; }, transformList: (transform: typeof listTransform) => { listTransform = transform; }, fail: (id: string) => { failId = id; }, repeatPages: () => { duplicatePages = true; }, restart: async () => { await service.close(); service = new MiaoshouService(directory, store, storage, deps); } };
}
async function settled(service: MiaoshouService) {
  for (let i = 0; i < 10000; i++) { const state = service.getSyncStatus(); if (state.status !== 'running') return state; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('sync did not settle');
}

test('inbox preference defaults on, preserves an explicit off value and only gates automatic entry', async t => {
  const f = await setup(t, 2);
  assert.equal(typeof f.service.getPreferences, 'function');
  assert.deepEqual(await f.service.getPreferences(), { autoSyncOnInbox: true });
  await f.service.savePreferences({autoSyncOnInbox:false});
  assert.equal(await f.service.syncInbox({ trigger: 'enter' }), null);
  assert.equal(f.calls.length, 0);
  await f.service.savePreferences({ autoSyncOnInbox: true }); await f.restart();
  assert.deepEqual(await f.service.getPreferences(), { autoSyncOnInbox: true });
  await f.service.syncInbox({ trigger: 'enter' }); await settled(f.service);
  assert.equal(f.store.listProducts().length, 2);
  await f.service.savePreferences({ autoSyncOnInbox: false });
  assert.equal(await f.service.syncInbox({ trigger: 'enter' }), null);
  const before = f.calls.length;
  await f.service.syncInbox({ trigger: 'manual' }); await settled(f.service);
  assert.ok(f.calls.length > before); assert.equal(f.store.listProducts().length, 2);
  await assert.rejects(f.service.savePreferences({ autoSyncOnInbox: 'yes' }));
  const callCount = f.calls.length;
  for (const trigger of [null, [], ['enter'], 5, 'silent']) await assert.rejects(f.service.syncInbox({ trigger }), { code: 'INPUT' });
  assert.equal(f.calls.length, callCount);
});

test('one-click inbox sync imports every page and SKU once, including older unchanged staging', async t => {
  const f = await setup(t, 21);
  await f.service.startSync({ pageSize: 20 }); await settled(f.service);
  assert.equal(f.store.listProducts().length, 0);
  assert.equal(typeof f.service.syncInbox, 'function');
  await Promise.all([f.service.syncInbox({ trigger: 'manual' }), f.service.syncInbox({ trigger: 'manual' })]);
  const imported = await settled(f.service);
  assert.equal(imported.imported, 21); assert.equal(imported.existing, 0);
  const products = f.store.listProducts(); assert.equal(products.length, 21);
  assert.ok(products.every(product => product.variantCount === 2));
  assert.equal(f.calls.filter(c => c.operation === 'detail').length, 21, 'reuse cached unchanged details');
  await f.service.syncInbox({ trigger: 'manual' }); const again = await settled(f.service);
  assert.equal(again.imported, 0); assert.equal(again.existing, 21);
  assert.deepEqual(f.store.listProducts().map(p => p.id).sort(), products.map(p => p.id).sort());
});

test('automatic import preserves manual changes and reports updated sources in row summaries', async t => {
  const f = await setup(t, 1);
  assert.equal(typeof f.service.syncInbox, 'function');
  await f.service.syncInbox({ trigger: 'manual' }); await settled(f.service);
  const original = f.store.getProduct(f.store.listProducts()[0].id), receipt = f.service.getReceipt(original.id);
  f.store.saveProduct({ id: original.id, revision: original.revision, title: '人工整理的标题', sourceUrl: original.sourceUrl, description: original.description, status: original.status, variants: original.variants.map(({ sourceSpec: _sourceSpec, sourcePurchasePrice: _sourcePrice, ...variant }) => variant), facts: original.facts });
  f.change(); await f.service.syncInbox({ trigger: 'manual' }); await settled(f.service);
  assert.equal(f.store.listProducts().length, 1); assert.equal(f.store.getProduct(original.id).title, '人工整理的标题');
  assert.deepEqual(f.service.getReceipt(original.id), receipt);
  const [summary] = f.service.inboxSummaries({ productIds: [original.id] });
  assert.equal(summary.hasSourceUpdate, true); assert.equal(summary.price, '0–9.876543');
  assert.equal(summary.imageId, receipt!.snapshot.images[0].id);
  assert.ok(summary.attributes.some(row => row.name === '材质' && row.value === '棉布'));
  assert.ok(summary.missing.includes('尺寸')); assert.equal(summary.weight, '多规格');
  assert.throws(() => f.service.inboxSummaries({ productIds: Array(51).fill(original.id) }));
  assert.equal(typeof f.service.getSourceUpdate, 'function');
  f.service.disconnect();
  assert.equal(f.service.getSourceUpdate(original.id)!.title, '来源更新后的商品');
  assert.deepEqual(f.service.getReceipt(original.id), receipt);
});

test('inbox import failures retry independently and entering the page respects a paused task', async t => {
  const f = await setup(t, 3);
  assert.equal(typeof f.service.syncInbox, 'function');
  f.fail('product-2'); await f.service.syncInbox({ trigger: 'manual' });
  const first = await settled(f.service); assert.equal(first.failed, 1); assert.equal(first.imported, 2);
  f.fail(''); await f.service.retrySyncFailures(); const retried = await settled(f.service);
  assert.equal(retried.failed, 0); assert.equal(f.store.listProducts().length, 3);
  await f.service.savePreferences({ autoSyncOnInbox: true });
  await f.service.syncInbox({ trigger: 'manual' }); f.service.pauseSync(); await settled(f.service);
  const calls = f.calls.length; const state = await f.service.syncInbox({ trigger: 'enter' });
  assert.equal(state!.status, 'paused'); assert.equal(f.calls.length, calls);
  await f.restart(); assert.equal(f.service.getSyncStatus().status, 'paused');
  await f.service.syncInbox({ trigger: 'manual' }); await settled(f.service);
  assert.equal(f.store.listProducts().length, 3);
});

test('joining a running legacy staging task retains the requested automatic import', async t => {
  const f = await setup(t, 3);
  await f.service.startSync({ pageSize: 500 });
  await f.service.syncInbox({ trigger: 'manual' });
  const state = await settled(f.service);
  assert.equal(state.importToInbox, true); assert.equal(f.store.listProducts().length, 3);
  assert.equal(f.calls.filter(call => call.operation === 'list').length, 1);
});

test('joined import intent survives listing errors and resumes without another staging-only run', async t => {
  let rejectList: (cause: Error) => void = () => {}, failing = true;
  const f = await setup(t, 1, { fetch: async url => {
    if (failing) return new Promise<Response>((_resolve, reject) => { rejectList = reject; });
    return new Response(JSON.stringify(String(url).endsWith('_list') ? listFixture() : detailFixture()));
  } });
  await f.service.startSync({ pageSize: 500 }); await f.service.syncInbox({ trigger: 'manual' });
  await new Promise(resolve => setImmediate(resolve)); failing = false; rejectList(new Error('offline'));
  const paused = await settled(f.service); assert.equal(paused.status, 'paused'); assert.equal(paused.importToInbox, true);
  await f.service.syncInbox({ trigger: 'manual' }); await settled(f.service);
  assert.equal(f.store.listProducts().length, 1);
});

for (const trigger of ['resume', 'manual']) test(`inbox ${trigger} promotes an older paused task and imports its cached and pending products`, async t => {
  let wake!: () => void, entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }); let now = 0, hold = true, sleeps = 0;
  const f = await setup(t, 3, { rateLimitClock: { now: () => now, sleep: async (ms, signal) => { if (++sleeps === 2 && hold) { entered(); await new Promise<void>((resolve, reject) => { wake = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); } now += ms; } } });
  await f.service.startSync({ pageSize: 500 }); await waiting; f.service.pauseSync(); hold = false; wake();
  assert.equal((await settled(f.service)).ready, 1); await f.restart();
  await f.service.syncInbox({ trigger }); const state = await settled(f.service);
  assert.equal(state.imported, 3); assert.equal(state.pending, 0); assert.equal(f.store.listProducts().length, 3);
  assert.equal(f.calls.filter(c => c.operation === 'detail').length, 3);
  assert.equal(f.calls.filter(c => c.operation === 'list').length, 1);
});

test('inbox retry promotes an older staging task and imports cached successes plus retried failures', async t => {
  const f = await setup(t, 3); f.fail('product-2'); await f.service.startSync({ pageSize: 500 }); await settled(f.service);
  assert.equal(f.store.listProducts().length, 0); f.fail('');
  await f.service.syncInbox({ trigger: 'retry' }); const state = await settled(f.service);
  assert.equal(state.failed, 0); assert.equal(state.imported, 3); assert.equal(f.store.listProducts().length, 3);
  assert.equal(f.calls.filter(c => c.operation === 'detail').length, 4);
});

test('sync stages every page and all SKUs with one detail per product; repeated sync skips unchanged details', async t => {
  const f = await setup(t); assert.equal(typeof f.service.startSync, 'function');
  await f.service.startSync({ pageSize: 20 }); const first = await settled(f.service);
  assert.equal(first.status, 'completed'); assert.equal(first.discovered, 21); assert.equal(first.ready, 21); assert.equal(first.skuCount, 42);
  assert.deepEqual(f.calls.filter(c => c.operation === 'list').map(c => c.body.pageNo), [1, 2]); assert.equal(f.calls.filter(c => c.operation === 'detail').length, 21);
  assert.equal(f.store.listProducts().length, 0, 'sync only stages data');
  const page = f.service.listSyncItems({ page: 2, pageSize: 20, filter: 'all' }); assert.equal(page.total, 21); assert.equal(page.items.length, 1);
  await f.service.startSync({ pageSize: 500 }); const second = await settled(f.service);
  assert.equal(second.skipped, 21); assert.equal(f.calls.filter(c => c.operation === 'detail').length, 21);
  assert.equal(f.calls.filter(c => c.operation === 'list').at(-1)!.body.pageSize, 500);
});

test('a detail failure is isolated and retry downloads only failed items', async t => {
  const f = await setup(t, 3); f.fail('product-2'); await f.service.startSync({ pageSize: 500 });
  const first = await settled(f.service); assert.equal(first.status, 'completed'); assert.equal(first.ready, 2); assert.equal(first.failed, 1);
  assert.equal(f.service.listSyncItems({ page: 1, pageSize: 20, filter: 'failed' }).items[0].remoteId, 'product-2');
  f.fail(''); await f.service.retrySyncFailures(); const retried = await settled(f.service);
  assert.equal(retried.failed, 0); assert.equal(retried.ready, 3); assert.equal(f.calls.filter(c => c.operation === 'detail').length, 4);
});

test('cached preview imports once and later changed versions preserve existing product edits and source receipts', async t => {
  const f = await setup(t, 1); await f.service.startSync({ pageSize: 500 }); await settled(f.service);
  const preview = f.service.previewSyncedProduct({ id: 'product-1' });
  const imported = f.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) });
  const product = f.store.getProduct(imported.productId), receipt = f.service.getReceipt(imported.productId);
  const edited = f.store.saveProduct({ id: product.id, revision: product.revision, title: '人工编辑保留', sourceUrl: product.sourceUrl, description: product.description, status: product.status, variants: product.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })), facts: product.facts });
  f.change(); await f.service.startSync({ pageSize: 500 }); await settled(f.service);
  const changed = f.service.previewSyncedProduct({ id: 'product-1' }); assert.equal(changed.product.title, '来源更新后的商品'); assert.equal(changed.existingProductId, imported.productId);
  const duplicate = f.service.importProduct({ previewId: changed.previewId, mapping: mappingFor(changed.product) });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.productId, imported.productId); assert.equal(f.store.listProducts().length, 1);
  assert.deepEqual(f.store.getProduct(imported.productId), edited); assert.deepEqual(f.service.getReceipt(imported.productId), receipt);
});

test('pause cancels a queued read and restart resumes pending products without redownloading completed ones', async t => {
  let wake!: () => void, entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }); let now = 0, hold = true, sleeps = 0;
  const f = await setup(t, 3, { rateLimitClock: { now: () => now, sleep: async (ms, signal) => { if (++sleeps === 2 && hold) { entered(); await new Promise<void>((resolve, reject) => { wake = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); } now += ms; } } });
  await f.service.startSync({ pageSize: 500 }); await waiting; f.service.pauseSync(); hold = false; wake();
  assert.equal((await settled(f.service)).status, 'paused'); assert.equal(f.service.getSyncStatus().ready, 1); await f.restart();
  assert.equal(f.service.getSyncStatus().status, 'paused'); await f.service.resumeSync();
  const result = await settled(f.service); assert.equal(result.ready, 3); assert.equal(result.status, 'completed'); assert.equal(f.calls.filter(c => c.operation === 'detail').length, 3);
});

test('account and mode changes isolate caches and invalidate cached previews', async t => {
  const f = await setup(t, 1); await f.service.startSync({ pageSize: 500 }); await settled(f.service);
  const preview = f.service.previewSyncedProduct({ id: 'product-1' });
  f.service.importConfig({ appKey: 'OTHER_SYNC_APP_KEY', appSecret: 'OTHER_SYNC_APP_SECRET' });
  assert.equal(f.service.getSyncStatus().discovered, 0); assert.equal(f.service.listSyncItems({ page: 1, pageSize: 20, filter: 'all' }).total, 0);
  assert.throws(() => f.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) }));
  f.service.importConfig(credentials); assert.equal(f.service.getSyncStatus().ready, 1);
  f.service.setMode('demo'); assert.equal(f.service.getSyncStatus().discovered, 0); await f.service.startSync({ pageSize: 500 }); assert.equal((await settled(f.service)).discovered, 3);
  f.service.setMode('live'); assert.equal(f.service.getSyncStatus().discovered, 1);
});

test('repeated pages never loop indefinitely or create duplicate cache records', async t => {
  const f = await setup(t, 21); f.repeatPages(); await f.service.startSync({ pageSize: 20 });
  const status = await settled(f.service); assert.equal(status.status, 'paused'); assert.equal(status.discovered, 20); assert.ok(status.lastError);
  assert.equal(f.calls.filter(c => c.operation === 'list').length, 2);
});

test('simultaneous starts launch one run and reject a competing start', async t => {
  const f = await setup(t, 1);
  const starts = await Promise.allSettled([f.service.startSync({ pageSize: 500 }), f.service.startSync({ pageSize: 500 })]);
  assert.equal(starts.filter(row => row.status === 'fulfilled').length, 1);
  assert.ok(starts.some(row => row.status === 'rejected' && row.reason.code === 'BUSY'));
  assert.equal((await settled(f.service)).ready, 1); assert.equal(f.calls.filter(c => c.operation === 'detail').length, 1);
});

test('duplicate IDs within and across pages keep one staged row and one detail per unique product', async t => {
  const f = await setup(t, 22);
  f.transformList((value, page) => {
    if (page === 1) value.data.detailList[1] = { ...value.data.detailList[0] };
    else value.data.detailList.unshift({ ...value.data.detailList[0], commonCollectBoxDetailId: 'product-2' }, { ...value.data.detailList[0], commonCollectBoxDetailId: 'product-20' });
  });
  await f.service.startSync({ pageSize: 20 }); const state = await settled(f.service);
  assert.equal(state.status, 'completed'); assert.equal(state.ready, 22);
  const details = f.calls.filter(c => c.operation === 'detail'); assert.equal(details.length, 22); assert.equal(new Set(details.map(c => c.body.commonCollectBoxDetailId)).size, 22);
});

test('missing source modified timestamps are fetched again and cached preview is a defensive copy', async t => {
  const f = await setup(t, 1); f.noModified(); await f.service.startSync({ pageSize: 500 }); await settled(f.service);
  const preview = f.service.previewSyncedProduct({ id: 'product-1' }); preview.product.title = 'renderer mutation';
  const fresh = f.service.previewSyncedProduct({ id: 'product-1' }); assert.equal(fresh.product.title, '原始商品');
  await f.service.startSync({ pageSize: 500 }); assert.equal((await settled(f.service)).skipped, 0); assert.equal(f.calls.filter(c => c.operation === 'detail').length, 2);
});

test('manual reads and sync share the same paced queue without parallel transport', async t => {
  let elapsed = 0, concurrent = 0, maximum = 0; const starts: number[] = [];
  const f = await setup(t, 1, { rateLimitClock: { now: () => elapsed, sleep: async ms => { elapsed += ms; } }, fetch: async (url, init) => {
    starts.push(elapsed); maximum = Math.max(maximum, ++concurrent); await new Promise(resolve => setImmediate(resolve));
    const value = String(url).endsWith('_list') ? listFixture() : detailFixture();
    if ('detailList' in value.data) value.data.detailList[0].commonCollectBoxDetailId = 'queued-product';
    if ('editCommonCollectBoxDetail' in value.data) value.data.editCommonCollectBoxDetail.commonCollectBoxDetailId = JSON.parse(String(init?.body)).commonCollectBoxDetailId;
    concurrent--; return new Response(JSON.stringify(value));
  } });
  await f.service.startSync({ pageSize: 500 }); await f.service.previewProduct({ id: 'manual-product' }); const state = await settled(f.service);
  assert.equal(state.ready, 1, JSON.stringify(state)); assert.equal(maximum, 1); assert.deepEqual(starts, [0, 1200, 2400]);
});

test('changing credentials during an in-flight list pauses the old account without caching its late response', async t => {
  let release!: (response: Response) => void;
  const f = await setup(t, 1, { fetch: async () => new Promise<Response>(resolve => { release = resolve; }) });
  await f.service.startSync({ pageSize: 500 }); while (!release) await new Promise(resolve => setImmediate(resolve));
  f.service.importConfig({ appKey: 'NEW_SYNC_APP_KEY', appSecret: 'NEW_SYNC_APP_SECRET' });
  release(new Response(JSON.stringify(listFixture()))); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.getSyncStatus().status, 'idle'); f.service.importConfig(credentials);
  assert.equal(f.service.getSyncStatus().status, 'paused'); assert.equal(f.service.getSyncStatus().discovered, 0);
});

test('sync LIMIT uses bounded shared retries then pauses pending work for a later resume', async t => {
  let attempts = 0, elapsed = 0; const starts: number[] = [];
  const f = await setup(t, 1, { rateLimitClock: { now: () => elapsed, sleep: async ms => { elapsed += ms; } }, fetch: async url => {
    starts.push(elapsed);
    if (String(url).endsWith('_list')) return new Response(JSON.stringify(listFixture()));
    return new Response(JSON.stringify(++attempts <= 3 ? { result: 'fail', code: 'accountApiQpsRateLimit' } : detailFixture()));
  } });
  await f.service.startSync({ pageSize: 500 }); const paused = await settled(f.service);
  assert.equal(paused.status, 'paused'); assert.equal(paused.pending, 1); assert.equal(paused.failed, 0); assert.equal(attempts, 3); assert.deepEqual(starts, [0, 1200, 4200, 10200]);
  await f.service.resumeSync(); const resumed = await settled(f.service); assert.equal(resumed.ready, 1); assert.equal(starts.at(-1), 22200);
});

test('pause during Retry-After backoff prevents the automatic retry and keeps the page cursor', async t => {
  let waiting!: () => void; const backoff = new Promise<void>(resolve => { waiting = resolve; }); let attempts = 0;
  const f = await setup(t, 1, { rateLimitClock: { now: () => 0, sleep: async (_ms, signal) => { waiting(); await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); } }, fetch: async () => { attempts++; return new Response('', { status: 429, headers: { 'retry-after': '5' } }); } });
  await f.service.startSync({ pageSize: 500 }); await backoff; f.service.pauseSync(); await f.restart();
  assert.equal(attempts, 1); assert.equal(f.service.getSyncStatus().status, 'paused'); assert.equal(f.service.getSyncStatus().nextPage, 1);
});

for (const allWritesFail of [false, true]) test(`a failed database checkpoint pauses visibly and retries from the last durable page (all writes fail: ${allWritesFail})`, async t => {
  const f = await setup(t, 1), db = openDatabase(f.directory);
  db.exec(`CREATE TRIGGER fail_sync_checkpoint BEFORE UPDATE ON miaoshou_sync_runs ${allWritesFail ? '' : "WHEN json_extract(NEW.record_json,'$.status')='running'"} BEGIN SELECT RAISE(ABORT,'simulated checkpoint failure'); END`);
  try {
    await f.service.startSync({ pageSize: 500 }); const status = await settled(f.service);
    assert.equal(status.status, 'paused'); assert.equal(status.discovered, 0); assert.equal(status.nextPage, 1); assert.ok(status.lastError);
    db.exec('DROP TRIGGER fail_sync_checkpoint'); await f.service.resumeSync(); assert.equal((await settled(f.service)).ready, 1);
  } finally { db.exec('DROP TRIGGER IF EXISTS fail_sync_checkpoint'); db.close(); }
});

test('one product-level detail request retains all sixteen SKUs for every staged product', async t => {
  let details = 0;
  const f = await setup(t, 12, { fetch: async (url, init) => {
    if (String(url).endsWith('_list')) { const value = listFixture(); value.data.total = 12; value.data.detailList = Array.from({ length: 12 }, (_, index) => ({ ...value.data.detailList[0], commonCollectBoxDetailId: `full-product-${index}` })); return new Response(JSON.stringify(value)); }
    details++; const value = detailFixture(), product = value.data.editCommonCollectBoxDetail;
    product.commonCollectBoxDetailId = JSON.parse(String(init?.body)).commonCollectBoxDetailId;
    Object.assign(product, { skuMap: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`source-sku-${index}`, { ...product.skuMap.arbitraryB, itemNum: `SKU-${index}` }])) });
    return new Response(JSON.stringify(value));
  } });
  await f.service.startSync({ pageSize: 500 }); const status = await settled(f.service);
  assert.equal(status.ready, 12); assert.equal(status.skuCount, 192); assert.equal(details, 12);
  assert.equal(f.service.previewSyncedProduct({ id: 'full-product-11' }).product.skus.length, 16);
});

test('failed explicit pause checkpoint stays visibly paused and can resume after storage recovers', async t => {
  let release!: (response: Response) => void, holding = true;
  const f = await setup(t, 1, { fetch: async url => {
    if (holding) return new Promise<Response>(resolve => { release = resolve; });
    return new Response(JSON.stringify(String(url).endsWith('_list') ? listFixture() : detailFixture()));
  } });
  await f.service.startSync({ pageSize: 500 }); while (!release) await new Promise(resolve => setImmediate(resolve));
  const db = openDatabase(f.directory); db.exec("CREATE TRIGGER fail_sync_pause BEFORE UPDATE ON miaoshou_sync_runs WHEN json_extract(NEW.record_json,'$.status')='paused' BEGIN SELECT RAISE(ABORT,'simulated pause failure'); END");
  try {
    const paused = f.service.pauseSync(); assert.equal(paused.status, 'paused'); assert.ok(paused.lastError);
    holding = false; release(new Response(JSON.stringify(listFixture()))); db.exec('DROP TRIGGER fail_sync_pause');
    await f.service.resumeSync(); assert.equal((await settled(f.service)).ready, 1);
  } finally { db.exec('DROP TRIGGER IF EXISTS fail_sync_pause'); db.close(); }
});

test('failed pause checkpoint cannot interrupt credential invalidation or reuse an old cached preview', async t => {
  let holding = false, release!: (response: Response) => void;
  const f = await setup(t, 1, { fetch: async url => {
    if (holding) return new Promise<Response>(resolve => { release = resolve; });
    return new Response(JSON.stringify(String(url).endsWith('_list') ? listFixture() : detailFixture()));
  } });
  await f.service.startSync({ pageSize: 500 }); await settled(f.service);
  const preview = f.service.previewSyncedProduct({ id: '90071992547409931' }); holding = true;
  await f.service.startSync({ pageSize: 500 }); while (!release) await new Promise(resolve => setImmediate(resolve));
  const db = openDatabase(f.directory); db.exec("CREATE TRIGGER fail_sync_pause BEFORE UPDATE ON miaoshou_sync_runs WHEN json_extract(NEW.record_json,'$.status')='paused' BEGIN SELECT RAISE(ABORT,'simulated pause failure'); END");
  try {
    assert.equal(f.service.importConfig({ appKey: 'NEW_SYNC_APP_KEY', appSecret: 'NEW_SYNC_APP_SECRET' }).configured, true);
    assert.equal(f.service.getSyncStatus().status, 'idle');
    assert.throws(() => f.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) }), { code: 'PREVIEW' });
    holding = false; release(new Response(JSON.stringify(listFixture()))); db.exec('DROP TRIGGER fail_sync_pause');
    f.service.importConfig(credentials); assert.equal(f.service.getSyncStatus().status, 'paused');
    await f.service.resumeSync(); assert.equal((await settled(f.service)).skipped, 1);
  } finally { db.exec('DROP TRIGGER IF EXISTS fail_sync_pause'); db.close(); }
});
