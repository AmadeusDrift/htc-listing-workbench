import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import type { NewAsset } from '../src/main/store.ts';
import { parseImport } from '../src/main/import-export.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { toSaveInput } from '../src/renderer/utils.ts';

function fixture(t: test.TestContext) {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'workspace-examples-')), directory = join(root, 'source');
  let store: WorkspaceStore | null = new WorkspaceStore(directory);
  t.after(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, directory, get store() { return store!; }, close() { store!.close(); store = null; },
    reopen() { store!.close(); store = new WorkspaceStore(directory); return store; } };
}

function examples(prefix: string) {
  const products = parseImport(JSON.stringify({ format: 'red-product-data', version: 1, products: [0, 1].map(index => ({
    title: `本地示例 ${index}`, sourceUrl: '', description: '仅供本地体验', status: 'draft', facts: [],
    variants: [0, 1].map(variant => ({ sku: `${prefix}-${index}-${variant}`, originalSpec: `颜色 ${variant}`, normalizedSpec: '', purchasePrice: '1.20', inventory: null })),
  })) }), 'json');
  const bytes = new Map<string, Buffer>();
  const assets: NewAsset[][] = products.map((product, productIndex) => product.variants.map((_, index) => {
    const id = randomUUID(), data = Buffer.from(`local sample image ${productIndex}/${index}`); bytes.set(id, data);
    return { id, fileName: `本地示例-${productIndex}-${index}.png`, mimeType: 'image/png', width: 640, height: 640,
      byteSize: data.length, originalPath: `assets/${id}.png`, previewPath: `assets/${id}.preview.png`, sha256: createHash('sha256').update(data).digest('hex') };
  }));
  return { products, assets, bytes };
}

test('each local example group is inserted once with its own placement, images and SKU associations', t => {
  const f = fixture(t);
  assert.equal(typeof f.store.importSampleProducts, 'function', 'local samples need an atomic group import');
  const ids: string[] = [];
  for (const lane of ['manual', 'inbox', 'automatic'] as const) {
    const data = examples(lane), result = f.store.importSampleProducts(lane, data.products, data.assets);
    assert.equal(result.created, true); assert.equal(result.productIds.length, 2);
    assert.deepEqual(f.store.getSampleProductIds(lane), result.productIds);
    assert.deepEqual(f.store.importSampleProducts(lane, data.products, data.assets), { productIds: result.productIds, created: false });
    for (const id of result.productIds) {
      const product = f.store.getProduct(id);
      assert.equal(product.origin, 'sample'); assert.equal(product.assets.length, 2); assert.equal(product.variants.length, 2);
      assert.equal(f.store.listWorkspacePlacements().find(item => item.productId === id)?.lane, lane);
      assert.equal(product.assets[0].role, 'main');
      assert.deepEqual(product.assets.map(asset => asset.variantIds), product.variants.map(variant => [variant.id]));
    }
    ids.push(...result.productIds);
  }
  assert.equal(new Set(ids).size, 6); assert.equal(f.store.listProducts().length, 6);
});

test('sample identity survives renamed titles and SKUs, moved placement, old audit history and restart', t => {
  const f = fixture(t), data = examples('FIRST');
  assert.equal(typeof f.store.importSampleProducts, 'function');
  const { productIds } = f.store.importSampleProducts('inbox', data.products, data.assets);
  for (const [index, id] of productIds.entries()) {
    const product = toSaveInput(f.store.getProduct(id));
    f.store.saveProduct({ ...product, title: `我的商品 ${index}`, sourceUrl: 'https://example.com/product', description: '用户编辑的说明',
      variants: product.variants.map((variant, variantIndex) => ({ ...variant, sku: `RENAMED-${index}-${variantIndex}`, normalizedSpec: '已编辑规格' })) });
  }
  f.store.moveWorkspaceProducts({ productIds: [productIds[0]], destination: 'automatic' });
  f.store.moveWorkspaceProducts({ productIds: [productIds[1]], destination: 'ignored' });
  for (let index = 0; index < 250; index++) f.store.recordWorkspaceEvent('test.later-event', '后续记录');
  const before = productIds.map(id => f.store.getProduct(id)), placements = f.store.listWorkspacePlacements(), audit = f.store.listAudit();
  const store = f.reopen(), replacement = examples('REPLACEMENT');
  assert.deepEqual(store.getSampleProductIds('inbox'), productIds);
  assert.deepEqual(store.importSampleProducts('inbox', replacement.products, replacement.assets), { productIds, created: false });
  assert.deepEqual(productIds.map(id => store.getProduct(id)), before);
  assert.deepEqual(store.listWorkspacePlacements(), placements); assert.deepEqual(store.listAudit(), audit);
  assert.deepEqual(store.getSampleProductIds('automatic'), []);
});

test('legacy samples without group metadata remain the manual group after they are moved and edited', t => {
  const f = fixture(t), data = examples('LEGACY');
  const legacyIds = f.store.importProducts(data.products, 'sample');
  f.store.moveWorkspaceProducts({ productIds: legacyIds, destination: 'inbox' });
  for (const id of legacyIds) { const product = toSaveInput(f.store.getProduct(id)); f.store.saveProduct({ ...product, title: '已改名的旧示例' }); }
  const store = f.reopen();
  assert.equal(typeof store.getSampleProductIds, 'function');
  assert.deepEqual(store.getSampleProductIds('manual'), legacyIds);
  assert.deepEqual(store.getSampleProductIds('inbox'), []);
  assert.deepEqual(store.importSampleProducts('manual', data.products, data.assets), { productIds: legacyIds, created: false });
  const inbox = examples('INBOX'), imported = store.importSampleProducts('inbox', inbox.products, inbox.assets);
  assert.equal(imported.created, true); assert.equal(store.listProducts().length, 4);
  assert.ok(store.listWorkspacePlacements().every(item => item.lane === 'inbox'));
});

test('failure in the last sample asset rolls back the whole group and a retry creates complete samples', t => {
  const f = fixture(t), untouched = f.store.createProduct(), data = examples('RETRY');
  assert.equal(typeof f.store.importSampleProducts, 'function');
  const before = f.store.listWorkspacePlacements(), audit = f.store.listAudit();
  const broken = data.assets.map(assets => assets.map(asset => ({ ...asset })));
  broken[1][1].id = broken[0][0].id;
  assert.throws(() => f.store.importSampleProducts('automatic', data.products, broken), /UNIQUE/);
  assert.deepEqual(f.store.getSampleProductIds('automatic'), []);
  assert.deepEqual(f.store.listWorkspacePlacements(), before); assert.deepEqual(f.store.listAudit(), audit);
  assert.deepEqual(f.store.listProducts().map(product => product.id), [untouched.id]);
  const result = f.store.importSampleProducts('automatic', data.products, data.assets);
  assert.equal(result.created, true); assert.equal(result.productIds.length, 2);
  assert.ok(result.productIds.every(id => f.store.getProduct(id).assets.length === 2));
});

test('workspace backup restoration preserves sample group identity and user placement', async t => {
  const f = fixture(t), data = examples('BACKUP');
  assert.equal(typeof f.store.importSampleProducts, 'function');
  const { productIds } = f.store.importSampleProducts('automatic', data.products, data.assets);
  f.store.moveWorkspaceProducts({ productIds: [productIds[0]], destination: 'manual' });
  mkdirSync(join(f.directory, 'assets'));
  for (const asset of data.assets.flat()) {
    writeFileSync(join(f.directory, asset.originalPath), data.bytes.get(asset.id)!);
    writeFileSync(join(f.directory, asset.previewPath), data.bytes.get(asset.id)!);
  }
  const before = productIds.map(id => f.store.getProduct(id)), placements = f.store.listWorkspacePlacements();
  f.close();
  const backup = join(f.root, 'samples.htcbackup'), target = join(f.root, 'restored');
  await createWorkspaceBackup(f.directory, backup, 'local sample backup passphrase');
  await commitWorkspaceRestore(target, await prepareWorkspaceRestore(target, backup, 'local sample backup passphrase'));
  const restored = new WorkspaceStore(target);
  try {
    const again = examples('AFTER-RESTORE');
    assert.deepEqual(restored.getSampleProductIds('automatic'), productIds);
    assert.deepEqual(restored.importSampleProducts('automatic', again.products, again.assets), { productIds, created: false });
    assert.deepEqual(productIds.map(id => restored.getProduct(id)), before);
    assert.deepEqual(restored.listWorkspacePlacements(), placements); assert.equal(restored.listProducts().length, 2);
  } finally { restored.close(); }
});
