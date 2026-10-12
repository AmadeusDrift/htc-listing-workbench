import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore, discardPreparedRestore, recoverInterruptedRestore } from '../src/main/backup.ts';
import { cleanupManagedBackups } from '../src/main/backup-retention.ts';
import { parseImport } from '../src/main/import-export.ts';
import { SCHEMA_VERSION } from '../src/main/database.ts';

async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(resolve('.test-data/backup-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

test('口令加密的完整备份恢复商品资料，不包含密钥文件', async t => {
  const root = await fixture(t), source = join(root, 'source'), target = join(root, 'target'), file = join(root, 'data.htcbackup');
  const store = new WorkspaceStore(source); const product = store.createProduct(); store.close();
  await mkdir(join(source, 'amazon-vault')); await writeFile(join(source, 'amazon-vault', 'secret.bin'), 'LONG_TERM_SECRET');
  const info = await createWorkspaceBackup(source, file, 'test passphrase 123');
  assert.equal(info.productCount, 1);
  const encrypted = await readFile(file);
  assert.equal(encrypted.includes(Buffer.from('LONG_TERM_SECRET')), false);
  assert.equal(encrypted.includes(Buffer.from(product.title)), false);
  await assert.rejects(prepareWorkspaceRestore(target, file, 'wrong passphrase 123'), /口令|损坏/);
  const prepared = await prepareWorkspaceRestore(target, file, 'test passphrase 123');
  assert.equal(prepared.productCount, 1);
  await commitWorkspaceRestore(target, prepared);
  const restored = new WorkspaceStore(target);
  assert.equal(restored.getProduct(product.id).variants[0].id, product.variants[0].id);
  restored.close();
  await assert.rejects(readFile(join(target, 'amazon-vault', 'secret.bin')), /ENOENT/);
});

test('损坏备份不能改动现有商品库，取消恢复只删除暂存副本', async t => {
  const root = await fixture(t), directory = join(root, 'data'), file = join(root, 'data.htcbackup');
  const store = new WorkspaceStore(directory); const original = store.createProduct(); store.close();
  await createWorkspaceBackup(directory, file, 'test passphrase 123');
  const bytes = await readFile(file); bytes[bytes.length - 1] ^= 1; const corrupt = join(root, 'corrupt.htcbackup'); await writeFile(corrupt, bytes);
  await assert.rejects(prepareWorkspaceRestore(directory, corrupt, 'test passphrase 123'), /损坏/);
  const prepared = await prepareWorkspaceRestore(directory, file, 'test passphrase 123');
  await discardPreparedRestore(directory, prepared);
  const current = new WorkspaceStore(directory); assert.equal(current.getProduct(original.id).title, original.title); current.close();
  await assert.rejects(commitWorkspaceRestore(directory, { ...prepared, stagingDirectory: root }), /目录/);
});

test('短口令不生成备份、不覆盖原文件', async t => {
  const root = await fixture(t), directory = join(root, 'data'), file = join(root, 'exists.htcbackup');
  const store = new WorkspaceStore(directory); store.close(); await writeFile(file, 'original');
  await assert.rejects(createWorkspaceBackup(directory, file, 'short'), /12/);
  assert.equal(await readFile(file, 'utf8'), 'original');
});

test('恢复大图及 SKU 图片关联，同时断开真实授权并保留备份后产生的提交锁', async t => {
  const root = await fixture(t), directory = join(root, 'data'), file = join(root, 'data.htcbackup');
  const store = new WorkspaceStore(directory), product = store.createProduct(), id = randomUUID(), targetId = randomUUID();
  const original = Buffer.alloc(2 * 1024 * 1024, 73), preview = Buffer.from('preview-fixture');
  await mkdir(join(directory, 'assets')); await writeFile(join(directory, 'assets', `${id}.png`), original); await writeFile(join(directory, 'assets', `${id}.preview.png`), preview);
  const added = store.addAssets({ productId: product.id, revision: product.revision }, [{ id, fileName: 'image.png', mimeType: 'image/png', width: 1000, height: 1000, byteSize: original.length, originalPath: `assets/${id}.png`, previewPath: `assets/${id}.preview.png`, sha256: createHash('sha256').update(original).digest('hex') }]);
  store.updateAsset({ productId: product.id, revision: added.revision, assetId: id, role: 'main', variantIds: [product.variants[0].id] }); store.close();
  const db = new DatabaseSync(join(directory, 'red.sqlite'));
  db.prepare("INSERT INTO amazon_targets(id,name,seller_id,marketplace_id,product_type,parentage_level,credential_ref,target_json) VALUES(?,'test','SELLER','MARKET','','NONE','vault-ref',?)").run(targetId, JSON.stringify({ id: targetId, name: 'test', sellerId: 'SELLER', marketplaceId: 'MARKET', marketplaceName: '测试站点', region: 'na', locale: 'en_US', mode: 'live', configured: true, paused: false, credentialUpdatedAt: null, lastError: null })); db.close();
  await createWorkspaceBackup(directory, file, 'test passphrase 123');
  const changed = new DatabaseSync(join(directory, 'red.sqlite'));
  changed.prepare("INSERT INTO amazon_write_locks(listing_hash,draft_id,state,created_at) VALUES('after-backup','another-draft','UNKNOWN',?)").run(new Date().toISOString()); changed.close();
  const prepared = await prepareWorkspaceRestore(directory, file, 'test passphrase 123');
  await commitWorkspaceRestore(directory, prepared);
  const restored = new WorkspaceStore(directory); const saved = restored.getProduct(product.id); restored.close();
  assert.deepEqual(saved.assets[0].variantIds, [product.variants[0].id]);
  assert.deepEqual(await readFile(join(directory, 'assets', `${id}.png`)), original);
  assert.deepEqual(await readFile(join(directory, 'assets', `${id}.preview.png`)), preview);
  const check = new DatabaseSync(join(directory, 'red.sqlite'));
  try {
    const target = check.prepare('SELECT * FROM amazon_targets').get()!;
    assert.equal(target.credential_ref, null); assert.equal(JSON.parse(String(target.target_json)).configured, false); assert.equal(JSON.parse(String(target.target_json)).paused, true);
    assert.equal(check.prepare("SELECT state FROM amazon_write_locks WHERE listing_hash='after-backup'").get()!.state, 'UNKNOWN');
  } finally { check.close(); }
});

test('恢复中断后重启回滚到原始商品库，保护已有图片', async t => {
  const root = await fixture(t), directory = join(root, 'data');
  const store = new WorkspaceStore(directory), product = store.createProduct(); store.close();
  await mkdir(join(directory, 'assets')); await writeFile(join(directory, 'assets', 'sentinel.txt'), 'keep');
  const staging = join(directory, `.restore-staging-${randomUUID()}`), rollback = join(directory, `.restore-rollback-${randomUUID()}`);
  await mkdir(staging); await mkdir(rollback);
  await writeFile(join(directory, '.restore-journal.json'), JSON.stringify({ version: 1, phase: 'installing', stagingDirectory: staging, rollbackDirectory: rollback, priorNames: ['red.sqlite', 'assets'] }));
  await rename(join(directory, 'red.sqlite'), join(rollback, 'red.sqlite'));
  await writeFile(join(directory, 'red.sqlite'), 'partial replacement');
  await recoverInterruptedRestore(directory);
  const recovered = new WorkspaceStore(directory); assert.equal(recovered.getProduct(product.id).id, product.id); recovered.close();
  assert.equal(await readFile(join(directory, 'assets', 'sentinel.txt'), 'utf8'), 'keep');
  await assert.rejects(readFile(join(directory, '.restore-journal.json')), /ENOENT/);
});

test('备份目标不能覆盖正在使用的数据库', async t => {
  const root = await fixture(t), directory = join(root, 'data');
  const store = new WorkspaceStore(directory), product = store.createProduct(); store.close();
  await assert.rejects(createWorkspaceBackup(directory, join(directory, 'red.sqlite'), 'test passphrase 123'), /备份文件/);
  const current = new WorkspaceStore(directory); assert.equal(current.getProduct(product.id).id, product.id); current.close();
});

test('结构残缺但 quick_check 正常的数据库不能成为可恢复备份', async t => {
  const root = await fixture(t), directory = join(root, 'data');
  const store = new WorkspaceStore(directory); store.createProduct(); store.close();
  const db = new DatabaseSync(join(directory, 'red.sqlite')); db.exec('DROP TABLE facts'); db.close();
  await assert.rejects(createWorkspaceBackup(directory, join(root, 'broken.htcbackup'), 'test passphrase 123'), /结构|格式/);
});

test('未知表和额外列不能把遗留凭据带进备份', async t => {
  const root = await fixture(t), directory = join(root, 'data'); const store = new WorkspaceStore(directory); store.close();
  const db = new DatabaseSync(join(directory, 'red.sqlite')); db.exec("CREATE TABLE legacy_credentials(refresh_token TEXT); INSERT INTO legacy_credentials VALUES('FAKE_SECRET_SENTINEL')"); db.close();
  await assert.rejects(createWorkspaceBackup(directory, join(root, 'unknown.htcbackup'), 'test passphrase 123'), /结构|不支持/);
  const altered = new DatabaseSync(join(directory, 'red.sqlite')); altered.exec('DROP TABLE legacy_credentials; ALTER TABLE products ADD COLUMN refresh_token TEXT'); altered.close();
  await assert.rejects(createWorkspaceBackup(directory, join(root, 'extra.htcbackup'), 'test passphrase 123'), /结构|不支持/);
});

test('恢复旧备份仍保留后续安全调用日志，日志期限独立于类目数据期限', async t => {
  const root = await fixture(t), directory = join(root, 'data'), file = join(root, 'history.htcbackup'); const store = new WorkspaceStore(directory); store.close();
  const db = new DatabaseSync(join(directory, 'red.sqlite'));
  const earlier = new Date(Date.now() - 200 * 86400000).toISOString();
  db.prepare('INSERT INTO amazon_calls VALUES(?,?,?,?)').run('old-call','target',earlier,JSON.stringify({ id: 'old-call', at: earlier })); db.close();
  const info = await createWorkspaceBackup(directory, file, 'test passphrase 123');
  assert.ok(Date.parse(info.expiresAt!) > Date.now() + 160 * 86400000);
  const current = new DatabaseSync(join(directory, 'red.sqlite'));
  current.prepare('INSERT INTO amazon_calls VALUES(?,?,?,?)').run('recent-call','target',new Date().toISOString(),JSON.stringify({ id: 'recent-call' })); current.close();
  const prepared = await prepareWorkspaceRestore(directory, file, 'test passphrase 123');
  const restored = new DatabaseSync(join(prepared.stagingDirectory, 'red.sqlite'));
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM amazon_calls WHERE id='recent-call'").get()!.n, 1); restored.close();
  await discardPreparedRestore(directory, prepared);
});

test('加密备份不包含 SQLite 空闲页中已删除的 Amazon 返回数据', async t => {
  const root = await fixture(t), directory = join(root, 'data'), file = join(root, 'sanitized.htcbackup'); const store = new WorkspaceStore(directory); store.close();
  const sentinel = 'DELETED_AMAZON_SENTINEL_FOR_BACKUP';
  const db = new DatabaseSync(join(directory, 'red.sqlite'));
  db.exec('PRAGMA secure_delete=OFF');
  db.prepare('INSERT INTO schema_cache(cache_key,schema_json,meta_schema_json,checksum,requirements,parentage_level,fetched_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run('deleted',JSON.stringify({ old: sentinel.repeat(1000) }),'{}','checksum','LISTING','NONE','2025-01-01T00:00:00.000Z','2025-01-02T00:00:00.000Z');
  db.exec('DELETE FROM schema_cache'); db.close();
  assert.ok((await readFile(join(directory, 'red.sqlite'))).includes(Buffer.from(sentinel)));
  const info = await createWorkspaceBackup(directory, file, 'test passphrase 123'); assert.equal(info.expiresAt, null);
  const bytes = await readFile(file), offset = Buffer.byteLength('HTC-BACKUP-1\n'), headerEnd = offset + 28;
  const key = scryptSync('test passphrase 123', bytes.subarray(offset, offset + 16), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(offset + 16, headerEnd)); cipher.setAAD(bytes.subarray(0, headerEnd)); cipher.setAuthTag(bytes.subarray(-16));
  const manifest = JSON.parse(gunzipSync(Buffer.concat([cipher.update(bytes.subarray(headerEnd, -16)), cipher.final()])).toString('utf8')); key.fill(0);
  assert.equal(Buffer.from(manifest.database, 'base64').includes(Buffer.from(sentinel)), false);
});

test('重复文件名不能覆盖旧备份或破坏它的到期清理登记', async t => {
  const root = await fixture(t), directory = join(root, 'data'), file = join(root, 'unique.htcbackup'); const store = new WorkspaceStore(directory); store.close();
  const db = new DatabaseSync(join(directory, 'red.sqlite'));
  db.prepare('INSERT INTO amazon_calls VALUES(?,?,?,?)').run('call','target',new Date().toISOString(),'{}'); db.close();
  const info = await createWorkspaceBackup(directory, file, 'test passphrase 123'), original = await readFile(file);
  await assert.rejects(createWorkspaceBackup(directory, file, 'test passphrase 123'), /已存在|新文件名/);
  assert.deepEqual(await readFile(file), original);
  assert.equal(await cleanupManagedBackups(directory, 180, Date.parse(info.expiresAt!) + 1), 1);
});

test('完整备份恢复全部工作区分流、分流时间及原始商品资料', async t => {
  const root = await fixture(t), source = join(root, 'source'), target = join(root, 'target'), file = join(root, 'placements.htcbackup');
  const store = new WorkspaceStore(source);
  const products = Array.from({ length: 4 }, () => store.createProduct());
  const destinations = ['inbox', 'manual', 'automatic', 'ignored'];
  products.forEach((p, index) => store.moveWorkspaceProducts({ productIds: [p.id], destination: destinations[index] }));
  const placements = store.listWorkspacePlacements(), audit = store.listAudit(); store.close();
  await createWorkspaceBackup(source, file, 'test passphrase 123');
  const prepared = await prepareWorkspaceRestore(target, file, 'test passphrase 123');
  await commitWorkspaceRestore(target, prepared);
  const restored = new WorkspaceStore(target);
  try {
    assert.deepEqual(restored.listWorkspacePlacements(), placements);
    assert.deepEqual(products.map(p => restored.getProduct(p.id)), products);
    assert.deepEqual(restored.listAudit(), audit);
    const moved = restored.moveWorkspaceProducts({ productIds: products.slice(0, 2).map(p => p.id), destination: 'automatic' });
    assert.equal(moved.length, 2);
    assert.ok(moved.every(p => p.lane === 'automatic'));
    assert.equal(restored.listWorkspacePlacements().length, products.length);
  } finally { restored.close(); }
});

async function writeBackupFixture(directory: string, file: string, databaseVersion = 2): Promise<void> {
  // Build the original v1 encrypted container directly: current backup creation upgrades
  // its staged snapshot and therefore cannot produce a genuine pre-upgrade v2 backup.
  const database = await readFile(join(directory, 'red.sqlite'));
  const manifest = { format: 'htc-workspace-backup', version: 1,
    source: { application: 'HTC', kind: 'local-workspace', databaseVersion },
    retention: { amazonDays: 180, logDays: 365, dataOldestAt: null, expiresAt: null }, createdAt: new Date().toISOString(),
    database: database.toString('base64'), databaseSha256: createHash('sha256').update(database).digest('hex'), assets: [] };
  const salt = randomBytes(16), iv = randomBytes(12), header = Buffer.concat([Buffer.from('HTC-BACKUP-1\n'), salt, iv]);
  const key = scryptSync('test passphrase 123', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
    await writeFile(file, Buffer.concat([header, cipher.update(gzipSync(Buffer.from(JSON.stringify(manifest)))), cipher.final(), cipher.getAuthTag()]));
  } finally { key.fill(0); }
}

test('升级前真实 v2 加密备份可恢复，旧导入商品默认人工区', async t => {
  const root = await fixture(t), source = join(root, 'source'), target = join(root, 'target'), file = join(root, 'legacy-v2.htcbackup');
  const store = new WorkspaceStore(source);
  const [id] = store.importProducts(parseImport('productKey,title,sku,purchasePrice\na,旧版导入商品,LEGACY-BACKUP,0.0350', 'csv'));
  const original = store.getProduct(id), manual = store.createProduct(); store.close();
  const legacy = new DatabaseSync(join(source, 'red.sqlite'));
  legacy.exec('DROP TABLE listing_completion_operations; DROP TABLE sku_naming_identities; DROP TABLE sku_naming_groups; DROP TABLE sku_naming_sequences; DROP TABLE miaoshou_sync_items; DROP TABLE miaoshou_sync_runs; DROP TABLE miaoshou_receipts; DROP TABLE collection_captures; DROP TABLE collection_receipts; DROP TABLE ai_usage_ledger; DROP TABLE ai_usage_policies; DROP TABLE product_workspaces; DROP TABLE hosting_profiles; DROP TABLE hosting_uploads; DROP TABLE execution_tasks; DROP TABLE image_write_operations; DROP TABLE image_versions; DROP TABLE image_selections; DROP TABLE content_versions; DROP TABLE ai_profiles; DROP TABLE ai_calls; DROP TABLE ai_results; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; PRAGMA user_version=2; PRAGMA journal_mode=DELETE;'); legacy.close();
  await writeBackupFixture(source, file);
  const prepared = await prepareWorkspaceRestore(target, file, 'test passphrase 123');
  await commitWorkspaceRestore(target, prepared);
  const restored = new WorkspaceStore(target);
  try {
    assert.deepEqual(restored.getProduct(id), original);
    const placements = restored.listWorkspacePlacements();
    for (const product of [original, manual]) {
      assert.deepEqual(placements.find(p => p.productId === product.id), { productId: product.id, lane: 'manual', updatedAt: product.updatedAt });
      assert.deepEqual(restored.getProduct(product.id), product);
    }
    assert.equal(placements.length, 2);
    const moved = restored.moveWorkspaceProducts({ productIds: [id, manual.id], destination: 'automatic' });
    assert.ok(moved.length === 2 && moved.every(p => p.lane === 'automatic'));
    assert.equal(restored.getStats().schemaVersion, SCHEMA_VERSION);
  } finally { restored.close(); }
  const untouched = new DatabaseSync(join(source, 'red.sqlite'), { readOnly: true });
  try {
    assert.equal(untouched.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.equal(untouched.prepare("SELECT 1 FROM sqlite_master WHERE name='product_workspaces'").get(), undefined);
  } finally { untouched.close(); }
});

test('v3 备份拒绝缺失分流表或额外凭据列', async t => {
  const root = await fixture(t);
  for (const [name, mutation] of [
    ['missing', 'DROP TABLE product_workspaces'],
    ['extra', 'ALTER TABLE product_workspaces ADD COLUMN refresh_token TEXT'],
  ]) {
    const directory = join(root, name), store = new WorkspaceStore(directory); store.createProduct(); store.close();
    const db = new DatabaseSync(join(directory, 'red.sqlite')); db.exec(mutation); db.close();
    await assert.rejects(createWorkspaceBackup(directory, join(root, `${name}.htcbackup`), 'test passphrase 123'), /结构|不支持/);
  }
});

test('分流记录的区域、时间和商品归属必须通过备份完整性检查', async t => {
  const root = await fixture(t);
  for (const [name, mutation] of [
    ['lane', "PRAGMA ignore_check_constraints=ON; UPDATE product_workspaces SET lane='published'"],
    ['date', "UPDATE product_workspaces SET updated_at='not-a-date'"],
    ['orphan', `PRAGMA foreign_keys=OFF; UPDATE product_workspaces SET product_id='${randomUUID()}'`],
  ]) {
    const directory = join(root, name), store = new WorkspaceStore(directory); store.createProduct(); store.close();
    const db = new DatabaseSync(join(directory, 'red.sqlite')); db.exec(mutation); db.close();
    await assert.rejects(createWorkspaceBackup(directory, join(root, `${name}.htcbackup`), 'test passphrase 123'), /工作区|分流|完整性/);
  }
});

test('同名同列但移除稳定主键和外键的分流表不能进入备份', async t => {
  const root = await fixture(t);
  for (const [name, definition] of [
    ['no-key', 'product_id TEXT,lane TEXT,updated_at TEXT'],
    ['no-reference', 'product_id TEXT PRIMARY KEY NOT NULL,lane TEXT NOT NULL,updated_at TEXT NOT NULL'],
  ]) {
    const directory = join(root, name), store = new WorkspaceStore(directory); store.createProduct(); store.close();
    const db = new DatabaseSync(join(directory, 'red.sqlite'));
    db.exec(`ALTER TABLE product_workspaces RENAME TO replaced; CREATE TABLE product_workspaces(${definition}); INSERT INTO product_workspaces SELECT * FROM replaced; DROP TABLE replaced;`); db.close();
    await assert.rejects(createWorkspaceBackup(directory, join(root, `${name}.htcbackup`), 'test passphrase 123'), /结构|不支持/);
  }
});

test('新增和既有表的隐藏生成凭据列不能进入或恢复备份', async t => {
  const root = await fixture(t);
  for (const table of ['product_workspaces', 'amazon_settings']) for (const storage of ['STORED', 'VIRTUAL']) {
    await t.test(`${table} ${storage}`, async () => {
      const name = `${table}-${storage}`, directory = join(root, name), store = new WorkspaceStore(directory);
      store.createProduct(); store.close();
      const db = new DatabaseSync(join(directory, 'red.sqlite'));
      try {
        if (table === 'product_workspaces') db.exec(`
          ALTER TABLE product_workspaces RENAME TO prior_workspaces;
          CREATE TABLE product_workspaces (
            product_id TEXT PRIMARY KEY NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            lane TEXT NOT NULL CHECK(lane IN ('inbox','manual','automatic','ignored')), updated_at TEXT NOT NULL,
            refresh_token TEXT GENERATED ALWAYS AS ('FAKE_SECRET_SENTINEL') ${storage}
          );
          INSERT INTO product_workspaces(product_id,lane,updated_at) SELECT product_id,lane,updated_at FROM prior_workspaces;
          DROP TABLE prior_workspaces;
        `);
        else db.exec(`
          DROP TABLE amazon_settings;
          CREATE TABLE amazon_settings (
            key TEXT PRIMARY KEY, value_json TEXT NOT NULL,
            refresh_token TEXT GENERATED ALWAYS AS ('FAKE_SECRET_SENTINEL') ${storage}
          );
          INSERT INTO amazon_settings(key,value_json) VALUES('fixture','{}');
        `);
        const visible = db.prepare('SELECT name FROM pragma_table_info(?)').all(table);
        const all = db.prepare('SELECT name,hidden FROM pragma_table_xinfo(?)').all(table);
        assert.equal(all.length, visible.length + 1);
        assert.equal(all.find(column => column.name === 'refresh_token')?.hidden, storage === 'STORED' ? 3 : 2);
      } finally { db.close(); }
      await assert.rejects(createWorkspaceBackup(directory, join(root, `${name}.htcbackup`), 'test passphrase 123'), /结构|不支持/);
      const forged = join(root, `${name}-forged.htcbackup`);
      await writeBackupFixture(directory, forged, 3);
      await assert.rejects(prepareWorkspaceRestore(join(root, `${name}-restore`), forged, 'test passphrase 123'), /结构|不支持/);
    });
  }
});

test('允许的列名也不能由隐藏生成列替代', async t => {
  const root = await fixture(t), directory = join(root, 'data'), store = new WorkspaceStore(directory); store.close();
  const db = new DatabaseSync(join(directory, 'red.sqlite'));
  db.exec("DROP TABLE amazon_settings; CREATE TABLE amazon_settings(key TEXT PRIMARY KEY,value_json TEXT GENERATED ALWAYS AS ('{}') STORED); INSERT INTO amazon_settings(key) VALUES('fixture');"); db.close();
  await assert.rejects(createWorkspaceBackup(directory, join(root, 'generated-approved-name.htcbackup'), 'test passphrase 123'), /结构|不支持/);
});

test('分流表的额外唯一约束和非规范索引不能进入或恢复备份', async t => {
  const root = await fixture(t);
  for (const [name, constraint, extraIndex] of [
    ['replace-constraint', ', UNIQUE(lane) ON CONFLICT REPLACE', ''],
    ['unique-index', '', 'CREATE UNIQUE INDEX extra_lane_unique ON product_workspaces(lane);'],
    ['extra-index', '', 'CREATE INDEX extra_lane_index ON product_workspaces(lane);'],
  ]) {
    const directory = join(root, name), store = new WorkspaceStore(directory);
    const first = store.createProduct(), second = store.createProduct();
    store.moveWorkspaceProducts({ productIds: [first.id], destination: 'inbox' });
    const originalPlacements = store.listWorkspacePlacements(), originalAudit = store.listAudit(); store.close();
    const db = new DatabaseSync(join(directory, 'red.sqlite'));
    try {
      db.exec(`
        ALTER TABLE product_workspaces RENAME TO prior_workspaces;
        CREATE TABLE product_workspaces (
          product_id TEXT PRIMARY KEY NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          lane TEXT NOT NULL CHECK(lane IN ('inbox','manual','automatic','ignored')), updated_at TEXT NOT NULL${constraint}
        );
        INSERT INTO product_workspaces(product_id,lane,updated_at) SELECT product_id,lane,updated_at FROM prior_workspaces;
        DROP TABLE prior_workspaces;
        ${extraIndex}
      `);
      assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.equal(db.prepare('PRAGMA index_list(product_workspaces)').all().length, 2);
    } finally { db.close(); }
    await t.test(`${name} 创建`, async () => {
      const file = join(root, `${name}.htcbackup`);
      await assert.rejects(createWorkspaceBackup(directory, file, 'test passphrase 123'), /结构|索引|不支持/);
      await assert.rejects(readFile(file), /ENOENT/);
    });
    await t.test(`${name} 恢复`, async () => {
      const file = join(root, `${name}-forged.htcbackup`), target = join(root, `${name}-target`);
      await writeBackupFixture(directory, file, 3);
      const current = new WorkspaceStore(target), existing = current.createProduct();
      const placements = current.listWorkspacePlacements(), audit = current.listAudit(); current.close();
      await assert.rejects(prepareWorkspaceRestore(target, file, 'test passphrase 123'), /结构|索引|不支持/);
      const untouched = new WorkspaceStore(target);
      try {
        assert.deepEqual(untouched.getProduct(existing.id), existing);
        assert.deepEqual(untouched.listWorkspacePlacements(), placements);
        assert.deepEqual(untouched.listAudit(), audit);
      } finally { untouched.close(); }
    });
    const unchanged = new WorkspaceStore(directory);
    try {
      assert.deepEqual(unchanged.listWorkspacePlacements(), originalPlacements);
      assert.deepEqual(unchanged.listAudit(), originalAudit);
      assert.deepEqual([unchanged.getProduct(first.id), unchanged.getProduct(second.id)], [first, second]);
    } finally { unchanged.close(); }
  }
});
