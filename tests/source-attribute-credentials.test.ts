import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { MiaoshouService } from '../src/main/miaoshou/service.ts';
import type { MiaoshouDependencies } from '../src/main/miaoshou/service.ts';
import { persistImport } from '../src/main/miaoshou/persistence.ts';
import { hash } from '../src/main/miaoshou/validation.ts';
import { mappingFor, testMiaoshouClock, testMiaoshouStorage } from './helpers/miaoshou-fixture.ts';

const date = '2026-10-10T00:00:00.000Z';
const credentials = { appKey: 'SYNTHETIC_SOURCE_KEY_123', appSecret: 'SYNTHETIC_SOURCE_SECRET_456' };
const wide = (value: string) => value.replace(/[!-~]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0));
const tables = ['products', 'variants', 'facts', 'product_workspaces', 'miaoshou_receipts', 'audit_events'];
const leakingAttributes = [{ name: 'material', value: wide(credentials.appSecret) }, { name: 'color', value: wide(credentials.appKey) }];

function fixture(t: TestContext, attributes = leakingAttributes, config = credentials, count = 1, rateLimitClock = testMiaoshouClock()) {
  const root = resolve('.test-data'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, 'source-credentials-')), store = new WorkspaceStore(directory), db = openDatabase(directory), storage = testMiaoshouStorage();
  const calls: string[] = [];
  const dependencies: MiaoshouDependencies = { now: () => new Date(date), rateLimitClock, fetch: async (url, options) => {
    const operation = String(url).endsWith('_list') ? 'list' : 'detail'; calls.push(operation);
    const id = JSON.parse(String(options?.body)).commonCollectBoxDetailId;
    const data = operation === 'list' ? { total: count, detailList: Array.from({ length: count }, (_, i) => ({ commonCollectBoxDetailId: String(700 + i), title: 'Synthetic source', gmtModified: '2026-10-10 00:00:00' })) }
      : { editCommonCollectBoxDetail: { commonCollectBoxDetailId: id, title: 'Synthetic source', sourceAttrs: attributes, skuMap: { one: {} } } };
    return new Response(JSON.stringify({ result: 'success', code: 'success', data }));
  } };
  let service = new MiaoshouService(directory, store, storage, dependencies); service.importConfig(config);
  t.after(async () => { await service.close(); db.close(); store.close(); const path = relative(root, resolve(directory)); assert.ok(path.startsWith('source-credentials-') && !path.includes('..')); rmSync(directory, { recursive: true, force: true }); });
  const businessRows = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  const assertNoCredentials = (value: unknown) => { const text = JSON.stringify(value); for (const secret of Object.values(config)) assert.equal(text.includes(secret), false, 'ASCII credentials must not enter imported business records'); };
  const assertEmpty = () => { const rows = businessRows(); assert.deepEqual(rows, Object.fromEntries(tables.map(table => [table, []]))); assertNoCredentials(rows); assertNoCredentials(db.prepare('SELECT record_json FROM miaoshou_sync_items').all()); };
  return { store, db, calls, businessRows, assertNoCredentials, assertEmpty, get service() { return service; }, restart: async () => { await service.close(); service = new MiaoshouService(directory, store, storage, dependencies); } };
}
async function settled(service: MiaoshouService) {
  for (let i = 0; i < 10000; i++) { const state = service.getSyncStatus(); if (state.status !== 'running') return state; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('synthetic source sync did not settle');
}
function assertImportRejected(f: ReturnType<typeof fixture>, preview: Awaited<ReturnType<MiaoshouService['previewProduct']>>) {
  f.assertNoCredentials(preview);
  assert.throws(() => f.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) }), { code: 'RESPONSE' });
  f.assertEmpty();
}

for (const location of ['value', 'name'] as const) {
  const config = location === 'name' ? { ...credentials, appKey: 'material' } : credentials;
  const attributes = location === 'name' ? [{ name: wide(config.appKey), value: 'Silicone' }] : leakingAttributes;
  test(`public import rejects credentials reconstructed in attribute ${location} before all business writes`, async t => {
    const f = fixture(t, attributes, config), preview = await f.service.previewProduct({ id: '700' });
    assert.equal(f.calls.length, 1); assertImportRejected(f, preview);
    assertImportRejected(f, preview); // The rolled-back connection remains usable; no partial duplicate exists.
    assert.equal(f.calls.length, 1);
  });
  test(`inbox sync rejects credentials reconstructed in attribute ${location} without partial import`, async t => {
    const f = fixture(t, attributes, config); await f.service.syncInbox({ trigger: 'manual' });
    const status = await settled(f.service); assert.equal(status.failed, 1); assert.equal(status.imported, 0); f.assertEmpty();
    const item = JSON.parse(String(f.db.prepare('SELECT record_json FROM miaoshou_sync_items').get()!.record_json));
    assert.equal(item.errorCode, 'RESPONSE'); assert.equal(item.importResult, undefined);
  });
}

test('cached source preview cannot bypass the post-conversion credential guard', async t => {
  const f = fixture(t); await f.service.startSync({ pageSize: 20 }); assert.equal((await settled(f.service)).ready, 1);
  await f.restart(); assertImportRejected(f, f.service.previewSyncedProduct({ id: '700' }));
  assert.equal(f.calls.filter(operation => operation === 'detail').length, 1);
});

test('unchanged cached inbox import cannot bypass the post-conversion credential guard', async t => {
  const f = fixture(t); await f.service.startSync({ pageSize: 20 }); await settled(f.service); await f.restart();
  await f.service.syncInbox({ trigger: 'manual' }); const status = await settled(f.service);
  assert.equal(status.failed, 1); assert.equal(status.imported, 0); f.assertEmpty();
  assert.equal(f.calls.filter(operation => operation === 'detail').length, 1, 'cached snapshot was reused without a new request sanitizer');
});

test('resuming a persisted staging run guards both cached and newly fetched source attributes', async t => {
  let elapsed = 0, sleeps = 0, hold = true, entered!: () => void, wake!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(t, leakingAttributes, credentials, 2, { now: () => elapsed, sleep: async (ms, signal) => {
    if (++sleeps === 2 && hold) { entered(); await new Promise<void>((resolve, reject) => { wake = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); }
    elapsed += ms;
  } });
  await f.service.startSync({ pageSize: 20 }); await waiting; f.service.pauseSync(); hold = false; wake();
  const paused = await settled(f.service); assert.equal(paused.status, 'paused'); assert.equal(paused.ready, 1);
  await f.restart(); await f.service.syncInbox({ trigger: 'resume' }); const resumed = await settled(f.service);
  assert.equal(resumed.failed, 2); assert.equal(resumed.imported, 0); f.assertEmpty();
  assert.equal(f.calls.filter(operation => operation === 'detail').length, 2, 'the first detail is reused from the saved staging snapshot');
});

test('legitimate fullwidth conversion and existing ASCII credential redaction still import successfully', async t => {
  const f = fixture(t, [{ name: 'ｍａｔｅｒｉａｌ', value: 'Ｓｉｌｉｃｏｎｅ' }, { name: 'color', value: credentials.appSecret }, { name: '备注', value: credentials.appKey }]);
  const preview = await f.service.previewProduct({ id: '700' }); f.assertNoCredentials(preview);
  const result = f.service.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) });
  const product = f.store.getProduct(result.productId), receipt = f.service.getReceipt(result.productId)!;
  assert.deepEqual(product.facts.map(({ name, value }) => ({ name, value })), [{ name: 'material', value: 'Silicone' }, { name: 'color', value: '已隐藏' }, { name: '备注', value: '已隐藏' }]);
  assert.equal(receipt.factNormalizations!.entries.length, 1); assert.equal(receipt.factNormalizations!.entries[0].value, 'Silicone');
  f.assertNoCredentials(f.businessRows());
});

test('duplicate pre-normalization receipt and original fullwidth facts remain byte-for-byte unchanged', async t => {
  const f = fixture(t), preview = await f.service.previewProduct({ id: '700' }), mapping = mappingFor(preview.product);
  // Construct an isolated legacy receipt: old ingestion stored the sanitized snapshot values verbatim.
  const first = persistImport(f.db, f.store, preview.product, mapping, hash(credentials.appKey), 'live', date);
  const receipt = f.service.getReceipt(first.productId)!; delete receipt.factNormalizations;
  f.db.prepare('UPDATE miaoshou_receipts SET record_json=? WHERE id=?').run(JSON.stringify(receipt), receipt.id);
  f.store.getProduct(first.productId).facts.forEach((fact, index) => f.db.prepare('UPDATE facts SET name=?,value=? WHERE id=?').run(preview.product.attributes[index].name, preview.product.attributes[index].value, fact.id));
  const before = f.businessRows(); f.assertNoCredentials(before);
  const duplicate = f.service.importProduct({ previewId: preview.previewId, mapping });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.productId, first.productId); assert.deepEqual(f.businessRows(), before);
});
