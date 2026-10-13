import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../src/main/database.ts';
import { WorkspaceStore } from '../src/main/store.ts';

async function subject() {
  const value = await import('../src/main/sku-naming/service.ts').catch(() => null);
  assert.ok(value, 'persistent SKU naming service must exist');
  return value;
}
async function fixture(t: test.TestContext) {
  mkdirSync(resolve('.test-data'), { recursive: true });
  const directory = mkdtempSync(join(resolve('.test-data'), 'sku-naming-'));
  const { SkuNamingService } = await subject();
  const service = new SkuNamingService(directory);
  const cleanup: (() => void | Promise<unknown>)[] = [() => service.close()];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return { directory, service, SkuNamingService, cleanup };
}
const input = (sourceGroupKey: string, extra: Record<string, unknown> = {}) => ({
  storeScope: 'live:seller-2', storeCode: 'U2', sourceGroupKey,
  collectedAt: '2026-10-08T01:23:45.000Z', childKeys: [] as string[], ...extra,
});

test('default prefixes and collection-day date produce parent and stable child SKUs', async t => {
  const { service } = await fixture(t);
  assert.equal(service.getSettings().templates[0].sequencePadding, 1);
  const group = service.allocate(input('source-one', { childKeys: ['red', 'blue'] }));
  assert.equal(group.baseSku, 'H2-261008-1');
  assert.deepEqual(group.children.map(c => [c.key, c.sku]), [['red', 'H2-261008-1-A'], ['blue', 'H2-261008-1-B']]);
  assert.equal(group.collectionDate, '2026-10-08');
  assert.equal(service.allocate(input('six', { storeScope: 'live:seller-6', storeCode: 'U6' })).baseSku, 'H6-261008-1');
  assert.equal(service.allocate(input('eight', { storeScope: 'live:seller-8', storeCode: 'U8' })).baseSku, 'H8-261008-1');
});

test('two batches of 100 then 50 share the same per-store collection-day sequence', async t => {
  const { service } = await fixture(t);
  const first = Array.from({ length: 100 }, (_, i) => service.allocate(input(`first-${i}`)));
  const second = Array.from({ length: 50 }, (_, i) => service.allocate(input(`second-${i}`)));
  assert.equal(first[99].baseSku, 'H2-261008-100');
  assert.equal(second[0].baseSku, 'H2-261008-101');
  assert.equal(second[49].baseSku, 'H2-261008-150');
  assert.equal(new Set([...first, ...second].map(g => g.baseSku)).size, 150);
});

test('Shanghai midnight and actual store scope isolate sequences', async t => {
  const { service } = await fixture(t);
  assert.equal(service.allocate(input('before', { collectedAt: '2026-10-07T15:59:59Z' })).baseSku, 'H2-261007-1');
  assert.equal(service.allocate(input('after', { collectedAt: '2026-10-07T16:00:00Z' })).baseSku, 'H2-261008-1');
  assert.equal(service.allocate(input('same-day', { collectedAt: '2026-10-08T23:59:00+08:00' })).baseSku, 'H2-261008-2');
  assert.equal(service.allocate(input('other-seller', { storeScope: 'live:different-seller' })).baseSku, 'H2-261008-1');
  assert.equal(service.allocate(input('demo', { storeScope: 'demo:seller-2' })).baseSku, 'H2-261008-1');
});

test('retry, duplicate collection and reordered children preserve identities and append new letters', async t => {
  const { service } = await fixture(t);
  const first = service.allocate(input('stable-source', { childKeys: ['blue', 'red', 'blue'] }));
  const retry = service.allocate(input('stable-source', { collectedAt: '2026-10-09T12:00:00Z', childKeys: ['red', 'blue', 'green'] }));
  assert.equal(retry.id, first.id);
  assert.equal(retry.baseSku, first.baseSku);
  assert.equal(retry.collectedAt, first.collectedAt);
  assert.deepEqual(retry.children.map(c => [c.key, c.suffix]), [['blue', 'A'], ['red', 'B'], ['green', 'C']]);
  assert.deepEqual(service.allocate(input('stable-source', { childKeys: ['red'] })).children, retry.children);
  assert.equal(service.allocate(input('after-cancelled-consumer')).sequence, 2);
});

test('child letters continue after Z and ZZ', async t => {
  const { service } = await fixture(t);
  const group = service.allocate(input('many-colours', { childKeys: Array.from({ length: 703 }, (_, i) => `colour-${i}`) }));
  assert.equal(group.children[25].suffix, 'Z');
  assert.equal(group.children[26].suffix, 'AA');
  assert.equal(group.children[701].suffix, 'ZZ');
  assert.equal(group.children[702].suffix, 'AAA');
  assert.equal(new Set(group.children.map(c => c.sku)).size, 703);
});

test('template edits affect future groups while old groups append using their immutable snapshot', async t => {
  const { service } = await fixture(t);
  const first = service.allocate(input('old', { childKeys: ['a'] }));
  const settings = service.getSettings();
  settings.templates[0].prefixes.U2 = 'NEW';
  settings.templates[0].childPattern = '{parent}_{child}';
  settings.templates[0].sequencePadding = 5;
  service.saveSettings(settings);
  const future = service.allocate(input('new', { childKeys: ['a'] }));
  assert.equal(future.baseSku, 'NEW-261008-00002');
  assert.equal(future.children[0].sku, 'NEW-261008-00002_A');
  const old = service.allocate(input('old', { childKeys: ['a', 'b'] }));
  assert.deepEqual(old.templateSnapshot, first.templateSnapshot);
  assert.equal(old.children[1].sku, 'H2-261008-1-B');
});

test('saved copies and target/store bindings choose templates without rewriting older groups', async t => {
  const { service } = await fixture(t);
  const settings = service.getSettings();
  const copy = structuredClone(settings.templates[0]);
  copy.id = 'sku-copy'; copy.name = '自定义模板'; copy.prefixes.U2 = 'COPY'; copy.dateFormat = 'yyyymmdd';
  settings.templates.push(copy);
  settings.bindings = [{ storeCode: 'U2', targetId: 'target-2', templateId: copy.id }];
  service.saveSettings(settings);
  assert.equal(service.allocate(input('bound', { targetId: 'target-2' })).baseSku, 'COPY-20261008-1');
  assert.equal(service.allocate(input('default')).baseSku, 'H2-261008-2');
  const next = service.getSettings(); next.defaultTemplateId = copy.id; service.saveSettings(next);
  assert.equal(service.allocate(input('new-default')).baseSku, 'COPY-20261008-3');
});

test('stale settings revisions cannot overwrite a concurrent edit', async t => {
  const { service, directory, SkuNamingService, cleanup } = await fixture(t);
  const second = new SkuNamingService(directory); cleanup.push(() => second.close());
  const stale = second.getSettings(); const current = service.getSettings();
  current.templates[0].name = '新版';
  const saved = service.saveSettings(current);
  assert.equal(saved.revision, 1);
  stale.templates[0].name = '过期';
  assert.throws(() => second.saveSettings(stale), /已.*更改|版本|刷新/);
  assert.equal(second.getSettings().templates[0].name, '新版');
});

test('preview uses supplied collection time and sequence without consuming any allocation', async t => {
  const { service, directory } = await fixture(t);
  const settings = service.getSettings(); settings.templates[0].prefixes.U2 = 'PREVIEW';
  const preview = service.preview({ settings, storeCode: 'U2', collectedAt: '2026-10-07T16:00:00Z', sequence: 101, childCount: 2 });
  assert.equal(preview.baseSku, 'PREVIEW-261008-101');
  assert.deepEqual(preview.childSkus, ['PREVIEW-261008-101-A', 'PREVIEW-261008-101-B']);
  const db = openDatabase(directory);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sku_naming_groups').get()!.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sku_naming_sequences').get()!.n, 0);
  } finally { db.close(); }
  assert.equal(service.getSettings().templates[0].prefixes.U2, 'H2');
  assert.equal(service.allocate(input('real')).baseSku, 'H2-261008-1');
});

test('allocation and settings survive reopen, and draft identity rejects unrelated keys', async t => {
  const { service, directory, SkuNamingService, cleanup } = await fixture(t);
  const group = service.allocate(input('persist', { childKeys: ['red'] }));
  service.close();
  const reopened = new SkuNamingService(directory); cleanup.push(() => reopened.close());
  assert.deepEqual(reopened.lookup(group.storeScope, group.sourceGroupKey), group);
  assert.equal(reopened.allocate(input('next')).sequence, 2);
  assert.doesNotThrow(() => reopened.assertIdentity({ storeScope: group.storeScope, sourceGroupKey: group.sourceGroupKey, childKey: 'red', sku: group.children[0].sku }));
  assert.throws(() => reopened.assertIdentity({ storeScope: group.storeScope, sourceGroupKey: group.sourceGroupKey, childKey: 'blue', sku: group.children[0].sku }), /SKU|身份/);
  assert.throws(() => reopened.assertIdentity({ storeScope: 'wrong', sourceGroupKey: group.sourceGroupKey, sku: group.baseSku }), /SKU|身份/);
});

test('unsafe templates, unknown placeholders, long SKUs and invalid dates fail before allocation', async t => {
  const { service } = await fixture(t);
  for (const pattern of ['{prefix}-{date}-{sequence}-{code}', '{prefix}-{date}-{sequence}/x', '{prefix}-{date}-{sequence}${process}', '{prefix}-{date}', '{prefix}-{date}-{sequence}'.repeat(5)]) {
    const settings = service.getSettings(); settings.templates[0].basePattern = pattern;
    assert.throws(() => service.saveSettings(settings), /SKU|模板|占位|长度/);
  }
  const long = service.getSettings(); long.templates[0].prefixes.U2 = 'X'.repeat(35);
  assert.throws(() => service.saveSettings(long), /SKU|长度|前缀/);
  for (const collectedAt of ['', '2026-10-08T12:00:00', '2026-02-30T12:00:00Z', 'invalid']) {
    assert.throws(() => service.allocate(input('invalid', { collectedAt })), /日期|时间/);
  }
  assert.throws(() => service.allocate(input('unknown-store', { storeCode: 'U99' })), /前缀|店铺/);
  assert.equal(service.allocate(input('valid')).sequence, 1);
});

test('a naming collision rolls back the sequence and the entire group', async t => {
  const { service, directory } = await fixture(t);
  const settings = service.getSettings();
  settings.templates[0].dateFormat = 'yymmdd'; service.saveSettings(settings);
  const occupied = service.allocate(input('occupied', { collectedAt: '2026-10-08T00:00:00Z' }));
  assert.throws(() => service.allocate(input('collision', { collectedAt: '2126-10-08T00:00:00Z', childKeys: ['a'] })), /冲突|占用/);
  assert.equal(service.lookup(occupied.storeScope, 'collision'), null);
  const db = openDatabase(directory);
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sku_naming_sequences WHERE collection_date='2126-10-08'").get()!.n, 0); }
  finally { db.close(); }
});

test('allocating publication SKUs never changes the original internal variant SKU', async t => {
  const { service, directory, cleanup } = await fixture(t);
  const store = new WorkspaceStore(directory); cleanup.push(() => store.close());
  const product = store.createProduct(), original = product.variants[0].sku;
  service.allocate(input(product.id, { childKeys: [product.variants[0].id] }));
  assert.equal(store.getProduct(product.id).variants[0].sku, original);
});

test('an appended child collision rolls back every new child without relabeling the original group', async t => {
  const { service } = await fixture(t);
  const initial = service.getSettings(); initial.templates[0].basePattern = '{sequence}{date}{prefix}'; initial.templates[0].childPattern = '{parent}{child}';
  initial.templates[0].sequencePadding = 1; service.saveSettings(initial);
  const original = service.allocate(input('original'));
  const changed = service.getSettings(); changed.templates[0].prefixes.U2 = 'H2B'; service.saveSettings(changed);
  const reserved = service.allocate(input('reserved', { collectedAt: '2126-10-08T00:00:00Z' }));
  assert.equal(reserved.baseSku, original.baseSku + 'B');
  assert.throws(() => service.allocate(input('original', { childKeys: ['blue', 'red'] })), /占用|冲突/);
  assert.deepEqual(service.lookup(original.storeScope, original.sourceGroupKey), original);
  const successful = service.allocate(input('original', { childKeys: ['blue'] }));
  assert.equal(successful.children[0].suffix, 'A');
});

test('aggregate child and malformed allocation limits reject atomically', async t => {
  const { service } = await fixture(t);
  const first = service.allocate(input('bounded', { childKeys: Array.from({ length: 4096 }, (_, i) => `child-${i}`) }));
  assert.throws(() => service.allocate(input('bounded', { childKeys: ['extra'] })), /数量/);
  assert.deepEqual(service.lookup(first.storeScope, first.sourceGroupKey), first);
  for (const change of [{ childKeys: [''] }, { sourceGroupKey: 'a'.repeat(1025) }, { storeScope: 'x\n' }, { childKeys: Array(4097).fill('same') }, { execute: true }]) {
    assert.throws(() => service.allocate(input('invalid', change)));
  }
  assert.equal(service.allocate(input('next')).sequence, 2);
});

test('v16 migration adds naming state while leaving original variants untouched', async t => {
  const { directory, service, SkuNamingService, cleanup } = await fixture(t);
  const store = new WorkspaceStore(directory), product = store.createProduct(); store.close(); service.close();
  const old = openDatabase(directory);
  old.exec('DROP TABLE sku_naming_identities; DROP TABLE sku_naming_groups; DROP TABLE sku_naming_sequences; DROP TABLE IF EXISTS listing_completion_operations; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; DROP TABLE IF EXISTS schema_fetch_operations; DROP TABLE IF EXISTS ai_purpose_profiles; DROP TABLE IF EXISTS ai_provider_receipts; DROP TABLE IF EXISTS ai_image_requests; DROP TABLE IF EXISTS ai_batches; DROP TABLE IF EXISTS ai_batch_items; DROP TABLE IF EXISTS ai_field_groups; PRAGMA user_version=16'); old.close();
  const migrated = new SkuNamingService(directory); cleanup.push(() => migrated.close());
  const reopened = new WorkspaceStore(directory); cleanup.push(() => reopened.close());
  assert.deepEqual(reopened.getProduct(product.id), product);
  assert.equal(migrated.allocate(input('after-upgrade')).baseSku, 'H2-261008-1');
});

test('two real database connections allocate concurrent groups without duplicate numbers', async t => {
  const { directory, cleanup } = await fixture(t);
  const barrier = new SharedArrayBuffer(4);
  const moduleUrl = new URL('../src/main/sku-naming/service.ts', import.meta.url).href;
  const workers = [0, 1].map(worker => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { SkuNamingService } = await import(workerData.moduleUrl);
      const service = new SkuNamingService(workerData.directory);
      parentPort.postMessage('ready'); Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try {
        const values = Array.from({ length: 25 }, (_, i) => service.allocate({
          storeScope: 'live:concurrent', storeCode: 'U2', sourceGroupKey: workerData.worker + '-' + i,
          collectedAt: '2026-10-08T00:00:00Z', childKeys: ['red', 'blue']
        }).sequence);
        parentPort.postMessage(values);
      } finally { service.close(); }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { directory, moduleUrl, barrier, worker } }));
  cleanup.push(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  let ready = 0;
  const results = workers.map(worker => new Promise<number[]>((resolveResult, reject) => {
    worker.on('error', reject);
    worker.on('message', value => {
      if (value === 'ready') { if (++ready === 2) { Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0); } }
      else resolveResult(value);
    });
  }));
  const sequences = (await Promise.all(results)).flat().sort((a, b) => a - b);
  assert.deepEqual(sequences, Array.from({ length: 50 }, (_, i) => i + 1));
});
