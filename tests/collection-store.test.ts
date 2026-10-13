import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import { SCHEMA_VERSION } from '../src/main/database.ts';
import { collectionSnapshot } from './helpers/collection-fixture.ts';

function fixture(t: test.TestContext) {
  mkdirSync(resolve('.test-data'), { recursive: true }); const directory = mkdtempSync(resolve('.test-data/collection-store-')), store = new WorkspaceStore(directory);
  t.after(() => { store.close(); assert.ok(relative(resolve('.test-data'), directory).startsWith('collection-store-')); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store };
}

test('schema10 atomically imports source-specific SKU prices, unknown inventory and inbox placement', t => {
  const { store } = fixture(t); assert.equal(SCHEMA_VERSION, 22);
  const snapshot = collectionSnapshot(), result = store.receiveCollectionSnapshot(randomUUID(), snapshot), product = store.getProduct(result.productId);
  assert.equal(product.status, 'draft'); assert.equal(product.sourceUrl, snapshot.sourceUrl); assert.equal(product.variants[0].purchasePrice, '0.0350');
  assert.equal(product.variants[0].inventory, null); assert.equal(product.assets.length, 0); assert.equal(product.variants[0].originalSpec, snapshot.skus[0].originalSpec);
  assert.equal(store.listWorkspacePlacements().find(p => p.productId === product.id)!.lane, 'inbox');
  const receipt = store.getCollectionReceipt(product.id)!; assert.equal(receipt.snapshot.skus[0].providerSkuId, 'sku-1');
  assert.deepEqual(receipt.skuMappings, [{ providerSkuId: 'sku-1', localVariantId: product.variants[0].id }]);
});

test('retry identities and duplicate-content aliases remain immutable across edits and provider changes', t => {
  const { store } = fixture(t), snapshot = collectionSnapshot(), captureId = randomUUID(), first = store.receiveCollectionSnapshot(captureId, snapshot);
  const oldReceipt = store.getCollectionReceipt(first.productId), product = store.getProduct(first.productId);
  store.saveProduct({ id: product.id, revision: product.revision, sourceUrl: product.sourceUrl, description: product.description, status: product.status, facts: product.facts, variants: [], title: '人工编辑保留' });
  assert.deepEqual(store.receiveCollectionSnapshot(captureId, snapshot), first);
  const aliasId = randomUUID(), alias = store.receiveCollectionSnapshot(aliasId, { ...snapshot, capturedAt: '2026-10-01T00:00:00.000Z' });
  assert.equal(alias.productId, first.productId); assert.equal(alias.duplicate, true); assert.equal(store.listProducts().length, 1);
  assert.deepEqual(store.receiveCollectionSnapshot(aliasId, snapshot), alias);
  const changed = { ...snapshot, title: '供应页面变更' };
  for (const id of [captureId, aliasId]) assert.throws(() => store.receiveCollectionSnapshot(id, changed), /CAPTURE_CONFLICT/);
  const next = store.receiveCollectionSnapshot(randomUUID(), changed); assert.notEqual(next.productId, first.productId); assert.equal(store.listProducts().length, 2);
  assert.equal(store.getProduct(first.productId).title, '人工编辑保留'); assert.equal(store.getProduct(first.productId).variants.length, 0);
  assert.deepEqual(store.getCollectionReceipt(first.productId), oldReceipt);
});

test('precise source prices and zero-SKU drafts do not invent local price or inventory', t => {
  const { store } = fixture(t), precise = collectionSnapshot(); precise.skus[0].purchasePrice = '0.123456789012';
  const received = store.receiveCollectionSnapshot(randomUUID(), precise), product = store.getProduct(received.productId);
  assert.equal(product.variants[0].purchasePrice, ''); assert.equal(product.variants[0].sourcePurchasePrice, '0.123456789012'); assert.ok(received.warnings.includes('PRICE_PRECISION_UNSUPPORTED'));
  const empty = collectionSnapshot(); empty.skus = []; empty.skuImages = []; empty.title = '';
  const draft = store.getProduct(store.receiveCollectionSnapshot(randomUUID(), empty).productId); assert.equal(draft.variants.length, 0); assert.equal(draft.title, '1688 商品 123456789012');
});

test('capture-record failure rolls back product, variants, placement and receipt together', t => {
  const { directory, store } = fixture(t), db = new DatabaseSync(join(directory, 'red.sqlite'));
  try { db.exec("CREATE TRIGGER reject_capture BEFORE INSERT ON collection_captures BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => store.receiveCollectionSnapshot(randomUUID(), collectionSnapshot()), /injected/);
    for (const table of ['products', 'variants', 'product_workspaces', 'collection_receipts', 'collection_captures']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
  } finally { db.close(); }
});
