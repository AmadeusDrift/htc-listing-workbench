import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { WorkspaceStore } from '../src/main/store.ts';
import type { ProductDetail, SaveProductInput } from '../src/shared/contracts.ts';

function fixture(t: test.TestContext) {
  const parent = resolve('.test-data');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'store-'));
  let store = new WorkspaceStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen() { store.close(); store = new WorkspaceStore(directory); return store; } };
}
function input(p: ProductDetail, changes: Partial<SaveProductInput> = {}): SaveProductInput {
  return { id: p.id, revision: p.revision, title: p.title, sourceUrl: p.sourceUrl, description: p.description, status: p.status,
    variants: p.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })),
    facts: p.facts, ...changes };
}
function imageFile() {
  const id = randomUUID();
  return { id, fileName: '商品原图.png', mimeType: 'image/png', width: 800, height: 800, byteSize: 512,
    originalPath: `assets/${id}.png`, previewPath: `assets/${id}.preview.png`, sha256: id.replaceAll('-', '').padEnd(64, '0') };
}

test('商品、多 SKU、十进制采购价和来源事实在关闭重开后保持一致', t => {
  const f = fixture(t);
  const created = f.store.createProduct();
  const draft = input(created, { title: '收纳袋', sourceUrl: 'https://detail.1688.com/offer/123.html', variants: [
    { ...created.variants[0], originalSpec: '白色 大号', normalizedSpec: 'White / Large', purchasePrice: '0.0350', inventory: 0 },
    { id: randomUUID(), sku: 'RED-SECOND', originalSpec: '蓝色 小号', normalizedSpec: 'Blue / Small', purchasePrice: '1.20', inventory: null },
  ].map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })), facts: [
    { id: randomUUID(), name: '材质', value: '棉', source: '1688', sourceRef: '商品详情参数', state: 'source_confirmed' },
  ] });
  const saved = f.store.saveProduct(draft);
  const reopened = f.reopen().getProduct(created.id);
  assert.deepEqual(reopened, saved);
  assert.equal(reopened.variants[0].purchasePrice, '0.0350');
  assert.equal(reopened.variants[1].inventory, null);
  assert.equal(reopened.facts[0].sourceRef, '商品详情参数');
  assert.equal(f.store.listProducts()[0].variantCount, 2);
});

test('更正规格/价格与调整顺序不覆盖首次来源值或稳定 SKU 身份', t => {
  const { store } = fixture(t);
  const created = store.createProduct();
  const first = input(created);
  first.variants[0].originalSpec = '供应商蓝色'; first.variants[0].purchasePrice = '1.50';
  const saved = store.saveProduct(first);
  const update = input(saved); update.variants[0].originalSpec = '蓝色'; update.variants[0].purchasePrice = '1.60';
  const result = store.saveProduct(update);
  assert.equal(result.variants[0].id, created.variants[0].id);
  assert.equal(result.variants[0].sku, created.variants[0].sku);
  assert.equal(result.variants[0].sourceSpec, '供应商蓝色');
  assert.equal(result.variants[0].sourcePurchasePrice, '1.50');
  assert.equal(result.variants[0].purchasePrice, '1.60');
  assert.ok(store.listAudit(created.id).some(event => event.action === 'product.updated'));
});

test('过期 revision 保存必须拒绝，不能覆盖较新数据', t => {
  const { store } = fixture(t); const p = store.createProduct();
  store.saveProduct(input(p, { title: '较新数据' }));
  assert.throws(() => store.saveProduct(input(p, { title: '旧数据' })), /已更新|重新加载/);
  assert.equal(store.getProduct(p.id).title, '较新数据');
});
test('同次保存交换两个 SKU 编码时，内部身份、原价与图片关联不变', t => {
  const { store } = fixture(t); let p = store.createProduct();
  const edit = input(p); edit.variants[0].sku = 'SWAP-A'; edit.variants[0].purchasePrice = '1.00';
  edit.variants.push({ ...edit.variants[0], id: randomUUID(), sku: 'SWAP-B', purchasePrice: '2.00' });
  p = store.saveProduct(edit);
  p = store.addAssets({ productId: p.id, revision: p.revision }, [imageFile()]);
  p = store.updateAsset({ productId: p.id, revision: p.revision, assetId: p.assets[0].id, role: 'main', variantIds: [p.variants[0].id] });
  const swap = input(p); swap.variants[0].sku = 'SWAP-B'; swap.variants[1].sku = 'SWAP-A';
  const result = store.saveProduct(swap);
  assert.deepEqual(result.variants.map(v => v.sku), ['SWAP-B', 'SWAP-A']);
  assert.deepEqual(result.variants.map(v => v.id), p.variants.map(v => v.id));
  assert.deepEqual(result.variants.map(v => v.sourcePurchasePrice), ['1.00', '2.00']);
  assert.deepEqual(result.assets, p.assets);
});

test('跨商品变体 ID 与重复 SKU 不允许写入，失败不改变商品', t => {
  const { store } = fixture(t); const a = store.createProduct(); const b = store.createProduct();
  assert.throws(() => store.saveProduct(input(b, { title: '非法修改', variants: input(a).variants })), /其他商品|SKU/);
  assert.deepEqual(store.getProduct(b.id), b);
  const duplicate = input(a); duplicate.variants.push({ ...duplicate.variants[0], id: randomUUID() });
  assert.throws(() => store.saveProduct(duplicate), /SKU.*重复|重复.*SKU/);
});

test('负数价格、无穷值库存和不可用来源链接被拒绝', t => {
  const { store } = fixture(t); const p = store.createProduct();
  const bad = input(p); bad.variants[0].purchasePrice = '-1';
  assert.throws(() => store.saveProduct(bad), /采购价/);
  bad.variants[0].purchasePrice = ''; bad.variants[0].inventory = Infinity;
  assert.throws(() => store.saveProduct(bad), /库存/);
  assert.throws(() => store.saveProduct(input(p, { sourceUrl: 'javascript:alert(1)' })), /链接/);
  assert.equal(store.getProduct(p.id).revision, p.revision);
});

test('图片归属通过稳定 ID 保存，主图唯一，解除关联保留素材', t => {
  const f = fixture(t); const p = f.store.createProduct();
  let current = f.store.addAssets({ productId: p.id, revision: p.revision }, [imageFile(), imageFile()]);
  const originalAssetIds = current.assets.map(asset => asset.id);
  current = f.store.updateAsset({ productId: p.id, revision: current.revision, assetId: originalAssetIds[1], role: 'main', variantIds: [p.variants[0].id] });
  assert.equal(current.assets.filter(asset => asset.role === 'main').length, 1);
  assert.deepEqual(current.assets.find(asset => asset.id === originalAssetIds[1])?.variantIds, [p.variants[0].id]);
  current = f.reopen().getProduct(p.id);
  current = f.store.updateAsset({ productId: p.id, revision: current.revision, assetId: originalAssetIds[1], role: 'main', variantIds: [] });
  assert.equal(current.assets.length, 2);
  assert.deepEqual(current.assets.find(asset => asset.id === originalAssetIds[1])?.variantIds, []);
  assert.ok(f.store.listAudit(p.id).some(event => event.action === 'asset.updated'));
});

test('图片不能关联其他商品 SKU，事务失败后原关系保持', t => {
  const { store } = fixture(t); const a = store.createProduct(); const b = store.createProduct();
  const saved = store.addAssets({ productId: a.id, revision: a.revision }, [imageFile()]);
  assert.throws(() => store.updateAsset({ productId: a.id, revision: saved.revision, assetId: saved.assets[0].id, role: 'main', variantIds: [b.variants[0].id] }), /SKU|归属/);
  assert.deepEqual(store.getProduct(a.id), saved);
});

test('删除 SKU 后图片仍在商品中，保留其他 SKU 关联', t => {
  const { store } = fixture(t); const p = store.createProduct();
  const edit = input(p); edit.variants.push({ ...edit.variants[0], id: randomUUID(), sku: 'RED-KEEP' });
  let saved = store.saveProduct(edit);
  saved = store.addAssets({ productId: p.id, revision: saved.revision }, [imageFile()]);
  saved = store.updateAsset({ productId: p.id, revision: saved.revision, assetId: saved.assets[0].id, role: 'main', variantIds: saved.variants.map(v => v.id) });
  saved = store.saveProduct(input(saved, { variants: input(saved).variants.slice(1) }));
  assert.equal(saved.assets.length, 1);
  assert.deepEqual(saved.assets[0].variantIds, [saved.variants[0].id]);
});
