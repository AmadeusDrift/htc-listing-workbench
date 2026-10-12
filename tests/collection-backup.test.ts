import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createCipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { RECORD_INDEXES } from '../src/main/record-indexes.ts';
import { collectionSnapshot } from './helpers/collection-fixture.ts';

async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/collection-backup-')), directory = join(root, 'workspace'), store = new WorkspaceStore(directory);
  const result = store.receiveCollectionSnapshot(randomUUID(), collectionSnapshot()), receipt = store.getCollectionReceipt(result.productId)!;
  const alias = store.receiveCollectionSnapshot(randomUUID(), collectionSnapshot()); store.close();
  t.after(async () => { assert.ok(relative(resolve('.test-data'), root).startsWith('collection-backup-')); await rm(root, { recursive: true, force: true }); });
  return { root, directory, result, receipt, alias };
}

async function uncheckedBackup(directory: string, file: string): Promise<void> {
  const db = new DatabaseSync(join(directory, 'red.sqlite')), snapshot = join(directory, 'unchecked.sqlite');
  try { await backup(db, snapshot); } finally { db.close(); }
  const bytes = await readFile(snapshot); await unlink(snapshot);
  const manifest = { format: 'htc-workspace-backup', version: 1, source: { application: 'HTC', kind: 'local-workspace', databaseVersion: 11 }, retention: { amazonDays: 180, logDays: 365, dataOldestAt: null, expiresAt: null }, createdAt: new Date().toISOString(), database: bytes.toString('base64'), databaseSha256: createHash('sha256').update(bytes).digest('hex'), assets: [] };
  const salt = randomBytes(16), iv = randomBytes(12), header = Buffer.concat([Buffer.from('HTC-BACKUP-1\n'), salt, iv]), key = scryptSync('test passphrase 123', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try { const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header); await writeFile(file, Buffer.concat([header, cipher.update(gzipSync(Buffer.from(JSON.stringify(manifest)))), cipher.final(), cipher.getAuthTag()])); } finally { key.fill(0); }
}

test('backup retains receipts and capture aliases after manual SKU deletion but excludes native tokens', async t => {
  const f = await fixture(t), store = new WorkspaceStore(f.directory), product = store.getProduct(f.result.productId);
  store.saveProduct({ id: product.id, revision: product.revision, title: '人工编辑', sourceUrl: '', description: '', status: 'draft', variants: [], facts: [] });
  const precise = collectionSnapshot(); precise.skus[0].purchasePrice = '0.123456789012';
  const preciseResult = store.receiveCollectionSnapshot(randomUUID(), precise), preciseProduct = store.getProduct(preciseResult.productId); store.close();
  await mkdir(join(f.directory, 'collection-connection')); await writeFile(join(f.directory, 'collection-connection', 'connection.json'), '{"token":"NEVER_BACK_UP_BRIDGE_SECRET"}');
  const file = join(f.root, 'data.htcbackup'); await createWorkspaceBackup(f.directory, file, 'test passphrase 123');
  const target = join(f.root, 'restored'), prepared = await prepareWorkspaceRestore(target, file, 'test passphrase 123'); await commitWorkspaceRestore(target, prepared);
  const restored = new WorkspaceStore(target); try {
    assert.deepEqual(restored.getCollectionReceipt(product.id), f.receipt); assert.equal(restored.getProduct(product.id).variants.length, 0);
    assert.equal(restored.receiveCollectionSnapshot(f.alias.captureId, collectionSnapshot()).productId, product.id);
    const preciseAfter = restored.getProduct(preciseProduct.id); assert.deepEqual(preciseAfter, preciseProduct);
    assert.equal(preciseAfter.variants[0].purchasePrice, ''); assert.equal(preciseAfter.variants[0].sourcePurchasePrice, '0.123456789012');
    assert.equal(restored.getCollectionReceipt(preciseProduct.id)!.snapshot.skus[0].purchasePrice, '0.123456789012');
    assert.ok(restored.getCollectionReceipt(preciseProduct.id)!.snapshot.warnings.includes('PRICE_PRECISION_UNSUPPORTED'));
    const { readFile } = await import('node:fs/promises'); await assert.rejects(readFile(join(target, 'collection-connection', 'connection.json')), /ENOENT/);
  } finally { restored.close(); }
});

for (const version of [8, 9]) test(`genuine schema ${version} backups migrate to 14 without expanding the older index whitelist`, async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  db.exec('DROP TABLE miaoshou_sync_items; DROP TABLE miaoshou_sync_runs; DROP TABLE miaoshou_receipts; DROP TABLE collection_captures; DROP TABLE collection_receipts'); if (version === 8) for (const index of RECORD_INDEXES) db.exec(`DROP INDEX ${index.name}`);
  db.exec(`DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS listing_completion_operations; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; PRAGMA user_version=${version}`); db.close();
  const file = join(f.root, 'legacy.htcbackup'); await createWorkspaceBackup(f.directory, file, 'test passphrase 123');
  const target = join(f.root, 'restored'), prepared = await prepareWorkspaceRestore(target, file, 'test passphrase 123'); await commitWorkspaceRestore(target, prepared);
  const upgraded = openDatabase(target); try { assert.equal(upgraded.prepare('PRAGMA user_version').get()!.user_version, 21); assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM collection_receipts').get()!.n, 0); } finally { upgraded.close(); }
});

for (const kind of ['extra-field', 'duplicate-json', 'fingerprint', 'identity', 'missing-first-capture', 'orphan-alias', 'duplicate-content', 'foreign-variant', 'extra-index', 'wrong-index', 'without-rowid'] as const) test(`backup rejects collection ${kind}`, async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try {
    if (kind === 'extra-field') { Object.assign(f.receipt.snapshot, { cookie: 'secret' }); db.prepare('UPDATE collection_receipts SET record_json=? WHERE id=?').run(JSON.stringify(f.receipt), f.receipt.id); }
    if (kind === 'duplicate-json') db.prepare('UPDATE collection_receipts SET record_json=? WHERE id=?').run(JSON.stringify(f.receipt).replace('"title":', '"tit\\u006ce":"spoof","title":'), f.receipt.id);
    if (kind === 'fingerprint') db.prepare("UPDATE collection_receipts SET record_json=json_set(record_json,'$.fingerprint',?)").run('a'.repeat(64));
    if (kind === 'identity') db.prepare('UPDATE collection_receipts SET id=?').run(randomUUID());
    if (kind === 'missing-first-capture') db.prepare('DELETE FROM collection_captures WHERE id=?').run(f.result.captureId);
    if (kind === 'orphan-alias') db.prepare("UPDATE collection_captures SET record_json=json_set(record_json,'$.receiptId',?) WHERE id=?").run(randomUUID(), f.alias.captureId);
    if (kind === 'duplicate-content') { const other = { ...f.receipt, id: randomUUID() }; db.prepare('INSERT INTO collection_receipts VALUES(?,?)').run(other.id, JSON.stringify(other)); }
    if (kind === 'foreign-variant') { const other = new WorkspaceStore(f.directory); const product = other.createProduct(); other.close(); db.prepare("UPDATE variants SET product_id=? WHERE id=?").run(product.id, f.receipt.skuMappings[0].localVariantId); }
    if (kind === 'extra-index') db.exec('CREATE UNIQUE INDEX forbidden_collection_unique ON collection_receipts(record_json)');
    if (kind === 'wrong-index') db.exec("DROP INDEX collection_receipts_product; CREATE INDEX collection_receipts_product ON collection_receipts(json_extract(record_json,'$.firstCaptureId'))");
    if (kind === 'without-rowid') db.exec('DROP TABLE miaoshou_receipts; DROP TABLE collection_captures; CREATE TABLE collection_captures(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL) WITHOUT ROWID');
  } finally { db.close(); }
  await assert.rejects(createWorkspaceBackup(f.directory, join(f.root, 'bad.htcbackup'), 'test passphrase 123'));
  const forged = join(f.root, 'forged.htcbackup'); await uncheckedBackup(f.directory, forged);
  const target = join(f.root, 'protected'), existing = new WorkspaceStore(target), product = existing.createProduct(); existing.close();
  await assert.rejects(prepareWorkspaceRestore(target, forged, 'test passphrase 123'));
  const after = new WorkspaceStore(target); try { assert.deepEqual(after.getProduct(product.id), product); } finally { after.close(); }
});
