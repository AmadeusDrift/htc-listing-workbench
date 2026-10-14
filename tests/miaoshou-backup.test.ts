import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase, SCHEMA_VERSION } from '../src/main/database.ts';
import { MiaoshouService } from '../src/main/miaoshou/service.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { testMiaoshouStorage } from './helpers/miaoshou-fixture.ts';

test('encrypted backup retains source receipts and manual edits, accepts deleted source variants, and disconnects Miaoshou', async () => {
  const root = mkdtempSync(join(tmpdir(), 'htc-ms-backup-')), source = join(root, 'source'), target = join(root, 'target');
  const storage = testMiaoshouStorage(), store = new WorkspaceStore(source), service = new MiaoshouService(source, store, storage);
  try {
    service.setMode('demo'); const preview = await service.previewProduct({ id: 'demo-colors' });
    const result = service.importProduct({ previewId: preview.previewId, mapping: { priceField: 'price', currency: 'CNY', skus: preview.product.skus.map(s => ({ sourceKey: s.key, dimensions: { color: 'tone-a', size: 'fit-a' } })) } });
    const before = store.getProduct(result.productId), receipt = service.getReceipt(result.productId);
    const saved = store.saveProduct({ id: before.id, revision: before.revision, title: '人工整理后保留', sourceUrl: before.sourceUrl, description: before.description, status: before.status, facts: before.facts,
      variants: before.variants.slice(1).map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })) });
    service.importConfig({ appKey: 'source-config-example', appSecret: 'source-secret-example' });
    const archive = join(root, 'miaoshou.htcbackup'); await createWorkspaceBackup(source, archive, 'test-backup-password');
    const priorStore = new WorkspaceStore(target), priorService = new MiaoshouService(target, priorStore, storage);
    priorService.importConfig({ appKey: 'old-target-config-example', appSecret: 'old-target-secret-example' });
    await priorService.close(); priorStore.close();
    const prepared = await prepareWorkspaceRestore(target, archive, 'test-backup-password'); await commitWorkspaceRestore(target, prepared);
    assert.equal(existsSync(join(target, 'miaoshou-vault/credentials.bin')), false);
    const restoredStore = new WorkspaceStore(target), restored = new MiaoshouService(target, restoredStore, storage);
    try {
      assert.equal(restored.getStatus().configured, false); assert.equal(restored.getStatus().mode, 'unconfigured');
      assert.deepEqual(restoredStore.getProduct(before.id), saved); assert.deepEqual(restored.getReceipt(before.id), receipt);
      restored.setMode('demo'); const again = await restored.previewProduct({ id: 'demo-colors' });
      assert.equal(restored.importProduct({ previewId: again.previewId, mapping: receipt!.mapping }).duplicate, true);
      assert.deepEqual(restoredStore.getProduct(before.id), saved);
    } finally { await restored.close(); restoredStore.close(); }
    const db = openDatabase(source);
    try {
      db.prepare("UPDATE miaoshou_receipts SET record_json=json_set(record_json, '$.skuMappings[0].imageIds',json('[]'))").run();
    } finally { db.close(); }
    await assert.rejects(createWorkspaceBackup(source, join(root, 'invalid.htcbackup'), 'test-backup-password'));
  } finally { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('genuine v10 backup restores and upgrades without altering original product data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'htc-ms-legacy-')), source = join(root, 'source'), target = join(root, 'target');
  try {
    const store = new WorkspaceStore(source), product = store.createProduct(); store.close();
    const db = openDatabase(source); db.exec('DROP TABLE miaoshou_sync_items; DROP TABLE miaoshou_sync_runs; DROP TABLE miaoshou_receipts; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS listing_completion_operations; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; DROP TABLE IF EXISTS product_fact_models; DROP TABLE IF EXISTS image_retry_allowances; DROP TABLE IF EXISTS automatic_work_batches; DROP TABLE IF EXISTS schema_fetch_operations; DROP TABLE IF EXISTS ai_purpose_profiles; DROP TABLE IF EXISTS ai_provider_receipts; DROP TABLE IF EXISTS ai_image_requests; DROP TABLE IF EXISTS ai_batches; DROP TABLE IF EXISTS ai_batch_items; DROP TABLE IF EXISTS ai_field_groups; DROP TABLE IF EXISTS image_reference_pins; DROP TABLE IF EXISTS ai_copy_review_upgrades; PRAGMA user_version=10'); db.close();
    const archive = join(root, 'legacy.htcbackup'); await createWorkspaceBackup(source, archive, 'test-backup-password');
    const prepared = await prepareWorkspaceRestore(target, archive, 'test-backup-password'); await commitWorkspaceRestore(target, prepared);
    const restored = new WorkspaceStore(target);
    try { assert.deepEqual(restored.getProduct(product.id), product); assert.equal(restored.getStats().schemaVersion, SCHEMA_VERSION); }
    finally { restored.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an expanded source receipt over the backup limit is rejected atomically at import', async () => {
  const root = mkdtempSync(join(tmpdir(), 'htc-ms-record-limit-')), store = new WorkspaceStore(root);
  const urls = Array.from({ length: 200 }, (_, i) => { const prefix = `https://images.example.com/${i}/`; return prefix + 'x'.repeat(2048 - prefix.length); });
  const body = JSON.stringify({ result: 'success', code: 'success', data: { editCommonCollectBoxDetail: {
    commonCollectBoxDetailId: '12345', title: '大来源样本', imgUrls: urls, sourceAttrs: Array.from({ length: 100 }, (_, i) => ({ name: `属性${i}`, value: '中'.repeat(4000) })),
    colorMap: { c: { name: '蓝色', imgUrls: urls } }, sizeMap: { s: { name: '大号', imgUrls: urls } }, saleProp3Map: { t: { name: '套装', imgUrls: urls } },
    skuMap: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`sku-${i}`, { price: '1.00' }])),
  } } });
  assert.ok(Buffer.byteLength(body) < 4 * 1024 * 1024);
  const service = new MiaoshouService(root, store, testMiaoshouStorage(), { fetch: (async () => new Response(body)) as typeof fetch });
  try {
    service.importConfig({ appKey: 'test-application-key', appSecret: 'test-secret-example' });
    const preview = await service.previewProduct({ id: '12345' });
    assert.throws(() => service.importProduct({ previewId: preview.previewId, mapping: { priceField: 'none', currency: 'unknown', skus: preview.product.skus.map(s => ({ sourceKey: s.key, dimensions: { color: 'c', size: 's', third: 't' } })) } }), /过大/);
    assert.equal(store.listProducts().length, 0);
    const db = openDatabase(root); try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM miaoshou_receipts').get()!.n, 0); } finally { db.close(); }
    await createWorkspaceBackup(root, join(root, 'after-rejection.htcbackup'), 'test-backup-password');
  } finally { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
