import { SCHEMA_VERSION } from '../src/main/database.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import { parseImport } from '../src/main/import-export.ts';

function fixture(t: test.TestContext) {
  const parent = resolve('.test-data');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'workspaces-'));
  let store: WorkspaceStore | null = new WorkspaceStore(directory);
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  function database(operation: (db: DatabaseSync) => void) {
    const db = new DatabaseSync(join(directory, 'red.sqlite'));
    try { operation(db); } finally { db.close(); }
  }
  return {
    directory, database,
    get store() { return store!; },
    reopen(beforeOpen?: (db: DatabaseSync) => void) {
      store!.close(); store = null;
      if (beforeOpen) database(beforeOpen);
      store = new WorkspaceStore(directory);
      return store;
    },
  };
}
function imported(sku: string) {
  return parseImport(JSON.stringify({ format: 'red-product-data', version: 1, products: [{
    title: '供应商收纳袋', sourceUrl: 'https://detail.1688.com/offer/123.html', description: '原始备注', status: 'ready',
    variants: [{ sku, originalSpec: '蓝色 / 小号', normalizedSpec: 'Blue / Small', purchasePrice: '0.0350', inventory: 0 }],
    facts: [{ name: '材质', value: '棉', source: '1688', sourceRef: '供应商规格表', state: 'source_confirmed' }],
  }] }), 'json');
}

test('旧 v2 商品迁移后全部进入人工区并保留原商品数据', t => {
  const f = fixture(t);
  const manual = f.store.createProduct(), [importId] = f.store.importProducts(imported('LEGACY-IMPORT'));
  const before = [manual, f.store.getProduct(importId)];
  const reopened = f.reopen(db => db.exec('DROP TABLE IF EXISTS miaoshou_sync_items; DROP TABLE IF EXISTS miaoshou_sync_runs; DROP TABLE IF EXISTS miaoshou_receipts; DROP TABLE IF EXISTS collection_captures; DROP TABLE IF EXISTS collection_receipts; DROP TABLE IF EXISTS ai_usage_ledger; DROP TABLE IF EXISTS ai_usage_policies; DROP TABLE IF EXISTS product_workspaces; DROP TABLE hosting_profiles; DROP TABLE hosting_uploads; DROP TABLE execution_tasks; DROP TABLE image_write_operations; DROP TABLE image_versions; DROP TABLE image_selections; DROP TABLE content_versions; DROP TABLE ai_profiles; DROP TABLE ai_calls; DROP TABLE ai_results; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS listing_completion_operations; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; DROP TABLE IF EXISTS product_fact_models; DROP TABLE IF EXISTS image_retry_allowances; DROP TABLE IF EXISTS schema_fetch_operations; DROP TABLE IF EXISTS ai_purpose_profiles; DROP TABLE IF EXISTS ai_provider_receipts; DROP TABLE IF EXISTS ai_image_requests; DROP TABLE IF EXISTS ai_batches; DROP TABLE IF EXISTS ai_batch_items; DROP TABLE IF EXISTS ai_field_groups; DROP TABLE IF EXISTS image_reference_pins; DROP TABLE IF EXISTS ai_copy_review_upgrades; PRAGMA user_version=2;'));
  assert.deepEqual(reopened.listWorkspacePlacements().sort((a, b) => a.productId.localeCompare(b.productId)), before.map(p => ({
    productId: p.id, lane: 'manual', updatedAt: p.updatedAt,
  })).sort((a, b) => a.productId.localeCompare(b.productId)));
  assert.deepEqual(before.map(p => reopened.getProduct(p.id)), before);
  f.database(db => assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION));
});

test('缺少分流记录的遗留商品在列表中默认人工区', t => {
  const f = fixture(t), p = f.store.createProduct();
  f.database(db => { db.prepare('DELETE FROM product_workspaces WHERE product_id=?').run(p.id); });
  assert.deepEqual(f.store.listWorkspacePlacements(), [{ productId: p.id, lane: 'manual', updatedAt: p.updatedAt }]);
});

test('手工新建和载入示例保持人工区，外部 JSON 与 CSV 导入进入收件箱', t => {
  const f = fixture(t), manual = f.store.createProduct();
  const [sampleId] = f.store.importProducts(imported('SAMPLE-01'), 'sample');
  const [jsonId] = f.store.importProducts(imported('JSON-01'));
  const [csvId] = f.store.importProducts(parseImport('productKey,title,sku,purchasePrice\na,CSV 商品,CSV-01,1.2000', 'csv'));
  const placements = new Map(f.store.listWorkspacePlacements().map(p => [p.productId, p.lane]));
  assert.equal(placements.size, 4);
  assert.equal(placements.get(manual.id), 'manual');
  assert.equal(placements.get(sampleId), 'manual');
  assert.equal(placements.get(jsonId), 'inbox');
  assert.equal(placements.get(csvId), 'inbox');
});

test('导入失败时商品与收件箱分流在同一事务中回滚', t => {
  const f = fixture(t), existing = f.store.createProduct();
  const before = f.store.listWorkspacePlacements(), audit = f.store.listAudit();
  const products = parseImport(`productKey,title,sku\na,可用商品,FRESH\nb,冲突商品,${existing.variants[0].sku}`, 'csv');
  assert.throws(() => f.store.importProducts(products), /SKU/);
  assert.deepEqual(f.store.listWorkspacePlacements(), before);
  assert.deepEqual(f.store.listProducts().map(p => p.id), [existing.id]);
  assert.deepEqual(f.store.listAudit(), audit);
});

test('批量移动返回请求顺序的分流结果，并在重开数据库后持久保留', t => {
  const f = fixture(t), first = f.store.createProduct(), second = f.store.createProduct(), untouched = f.store.createProduct();
  const ids = [second.id, first.id];
  const moved = f.store.moveWorkspaceProducts({ productIds: ids, destination: 'automatic' });
  assert.deepEqual(moved.map(p => p.productId), ids);
  assert.ok(moved.every(p => p.lane === 'automatic' && Number.isFinite(Date.parse(p.updatedAt))));
  assert.equal(new Set(moved.map(p => p.updatedAt)).size, 1);
  const reopened = f.reopen(), all = reopened.listWorkspacePlacements();
  assert.deepEqual(ids.map(id => all.find(p => p.productId === id)), moved);
  assert.equal(all.find(p => p.productId === untouched.id)?.lane, 'manual');
  for (const id of ids) assert.ok(reopened.listAudit(id).some(event => event.action === 'workspace.moved'));
});

test('移动批次含未知商品时全部拒绝，分流和审计均不改变', t => {
  const f = fixture(t), first = f.store.createProduct(), second = f.store.createProduct();
  f.store.moveWorkspaceProducts({ productIds: [first.id], destination: 'ignored' });
  const before = f.store.listWorkspacePlacements(), audit = f.store.listAudit();
  assert.throws(() => f.store.moveWorkspaceProducts({ productIds: [first.id, second.id, randomUUID()], destination: 'automatic' }), /不存在/);
  assert.deepEqual(f.store.listWorkspacePlacements(), before);
  assert.deepEqual(f.store.listAudit(), audit);
});

test('移动严格拒绝空列表、重复 ID、超额输入、未知字段和无效目的地', t => {
  const f = fixture(t), p = f.store.createProduct(), before = f.store.listWorkspacePlacements(), audit = f.store.listAudit();
  const invalid = [
    null, [], {}, { productIds: [], destination: 'manual' }, { productIds: p.id, destination: 'manual' },
    { productIds: [p.id, p.id], destination: 'manual' }, { productIds: [p.id, p.id.toUpperCase()], destination: 'manual' },
    { productIds: Array.from({ length: 501 }, () => randomUUID()), destination: 'inbox' },
    { productIds: ['not-an-id'], destination: 'manual' }, { productIds: [p.id], destination: 'published' },
    { productIds: [p.id], destination: 'Manual' }, { productIds: [p.id], destination: 'inbox', revision: 2 },
    { productIds: [p.id], destination: 'automatic', path: 'C:/secret' },
  ];
  for (const value of invalid) assert.throws(() => f.store.moveWorkspaceProducts(value), /格式|字段|数组|500|重复|ID|无效|选择/);
  assert.deepEqual(f.store.listWorkspacePlacements(), before);
  assert.deepEqual(f.store.listAudit(), audit);
});

test('移到当前区域保持分流时间和审计不变', t => {
  const f = fixture(t), p = f.store.createProduct();
  const before = f.store.listWorkspacePlacements(), audit = f.store.listAudit();
  assert.deepEqual(f.store.moveWorkspaceProducts({ productIds: [p.id], destination: 'manual' }), before);
  assert.deepEqual(f.store.listAudit(), audit);
});

test('移动只修改分流：商品、SKU、首次来源值、图片关系与原图文件保持一致', t => {
  const f = fixture(t), [productId] = f.store.importProducts(imported('SOURCE-UNCHANGED'));
  let p = f.store.getProduct(productId);
  const id = randomUUID(), originalPath = `assets/${id}.png`, previewPath = `assets/${id}.preview.png`, bytes = Buffer.from('immutable original image');
  mkdirSync(join(f.directory, 'assets'));
  writeFileSync(join(f.directory, originalPath), bytes); writeFileSync(join(f.directory, previewPath), bytes);
  p = f.store.addAssets({ productId, revision: p.revision }, [{ id, fileName: '供应商原图.png', mimeType: 'image/png', width: 800, height: 600,
    byteSize: bytes.length, originalPath, previewPath, sha256: 'a'.repeat(64) }]);
  p = f.store.updateAsset({ productId, revision: p.revision, assetId: id, role: 'main', variantIds: [p.variants[0].id] });
  const asset = f.store.getAssetRecord(id), summaries = f.store.listProducts();
  for (const destination of ['manual', 'automatic', 'ignored', 'inbox']) {
    f.store.moveWorkspaceProducts({ productIds: [productId], destination });
    assert.deepEqual(f.store.getProduct(productId), p);
    assert.deepEqual(f.store.getAssetRecord(id), asset);
    assert.deepEqual(f.store.listProducts(), summaries);
  }
  assert.deepEqual(readFileSync(join(f.directory, originalPath)), bytes);
  assert.deepEqual(readFileSync(join(f.directory, previewPath)), bytes);
  assert.equal(f.store.listAudit(productId).filter(e => e.action === 'workspace.moved').length, 4);
});
