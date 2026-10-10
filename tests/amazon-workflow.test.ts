import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase, SCHEMA_VERSION } from '../src/main/database.ts';
import type { JsonObject, AmazonDraft } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail, SaveProductInput } from '../src/shared/contracts.ts';

const implementation = await import('../src/main/amazon/service.ts').catch(() => null);
const key = randomBytes(32);
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
  decryptString(value: Buffer) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'); },
};
const credentials = { name: '测试店铺', sellerId: 'TEST_SELLER', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en_US',
  clientId: 'TEST_CLIENT_NEVER_PUBLIC', clientSecret: 'SECRET_CLIENT_NEVER_PUBLIC', refreshToken: 'SECRET_REFRESH_NEVER_PUBLIC' };
function productInput(p: ProductDetail): SaveProductInput {
  return { id: p.id, revision: p.revision, title: p.title, sourceUrl: p.sourceUrl, description: p.description, status: p.status, facts: p.facts,
    variants: p.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })) };
}
function fixture(t: test.TestContext) {
  assert.ok(implementation?.AmazonService, 'AmazonService must be implemented');
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(join(parent, 'amazon-workflow-'));
  const store = new WorkspaceStore(directory); let now = Date.parse('2026-01-01T00:00:00Z');
  let service = new implementation.AmazonService(directory, id => store.getProduct(id), safeStorage, { now: () => now,
    fetch: async () => { throw new Error('Tests must not access the network'); } });
  t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  let product = store.createProduct(); product = store.saveProduct({ ...productInput(product), title: 'Source bag title', description: 'Source description',
    variants: productInput(product).variants.map(v => ({ ...v, purchasePrice: '92.35', inventory: 7 })), facts: [
      { id: randomUUID(), name: 'color', value: 'Blue', source: 'manual', sourceRef: '标签', state: 'human_confirmed' },
      { id: randomUUID(), name: 'brand', value: 'UNCONFIRMED_BRAND', source: 'ai', sourceRef: '', state: 'ai_suggested' },
    ] });
  return { directory, store, product, get service() { return service; }, advance(ms: number) { now += ms; },
    reopen() { service.close(); service = new implementation!.AmazonService(directory, id => store.getProduct(id), safeStorage, { now: () => now,
      fetch: async () => { throw new Error('Tests must not access the network'); } }); return service; } };
}
async function demoDraft(f: ReturnType<typeof fixture>) {
  const target = f.service.enableDemo();
  return f.service.createDraft({ targetId: target.id, productId: f.product.id, variantId: f.product.variants[0].id,
    productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' });
}
function ready(d: AmazonDraft): JsonObject {
  return { ...d.attributes, brand: [{ value: 'Confirmed Test Brand', marketplace_id: d.marketplaceId }], color: [{ value: 'Blue', marketplace_id: d.marketplaceId }],
    purchasable_offer: [{ marketplace_id: d.marketplaceId, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 12.5 }] }] }] };
}

test('v1 migration retains products, stable variants, assets and joins', t => {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(join(parent, 'amazon-migration-'));
  const old = new DatabaseSync(join(directory, 'red.sqlite'));
  old.exec(`CREATE TABLE products(id TEXT PRIMARY KEY, title TEXT, updated_at TEXT NOT NULL); CREATE TABLE variants(id TEXT PRIMARY KEY, product_id TEXT, sku TEXT, purchase_price TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY, product_id TEXT, original_path TEXT); CREATE TABLE variant_assets(asset_id TEXT, variant_id TEXT);
    CREATE TABLE amazon_targets(id TEXT PRIMARY KEY, name TEXT NOT NULL, seller_id TEXT NOT NULL, marketplace_id TEXT NOT NULL, product_type TEXT NOT NULL, parentage_level TEXT NOT NULL, credential_ref TEXT);
    CREATE TABLE schema_cache(cache_key TEXT PRIMARY KEY, target_id TEXT REFERENCES amazon_targets(id), schema_json TEXT NOT NULL, meta_schema_json TEXT NOT NULL, checksum TEXT NOT NULL, requirements TEXT NOT NULL, parentage_level TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE listing_drafts(id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), target_id TEXT REFERENCES amazon_targets(id), request_json TEXT NOT NULL, schema_checksum TEXT NOT NULL, validation_json TEXT NOT NULL, preview_json TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE issues(id TEXT PRIMARY KEY, draft_id TEXT REFERENCES listing_drafts(id), code TEXT, severity TEXT, category TEXT, field TEXT, message TEXT, status TEXT);
    INSERT INTO products VALUES('p','原始商品','2026-01-01T00:00:00.000Z'); INSERT INTO variants VALUES('v','p','SKU-ORIGINAL','0.0350'); INSERT INTO assets VALUES('a','p','assets/source.png'); INSERT INTO variant_assets VALUES('a','v'); DROP TABLE IF EXISTS source_image_provenance; PRAGMA user_version=1;`);
  old.close(); const db = openDatabase(directory); t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(SCHEMA_VERSION, 19); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 19);
  assert.equal(db.prepare('SELECT title FROM products').get()!.title, '原始商品');
  assert.equal(db.prepare('SELECT purchase_price FROM variants').get()!.purchase_price, '0.0350');
  assert.equal(db.prepare('SELECT original_path FROM assets').get()!.original_path, 'assets/source.png');
  assert.equal(db.prepare('SELECT variant_id FROM variant_assets').get()!.variant_id, 'v');
  assert.equal(db.prepare('SELECT lane FROM product_workspaces').get()!.lane, 'manual');
});

test('demo is explicitly local and copies only source data allowed by schema', async t => {
  const f = fixture(t); const d = await demoDraft(f); const target = f.service.getTarget(d.targetId);
  assert.equal(target.name, '本地演示店铺'); assert.equal(target.mode, 'demo'); assert.match(d.schema.schema.description as string, /演示|示例/);
  const offer = (d.schema.schema.properties as JsonObject).purchasable_offer as JsonObject;
  const audience = ((offer.items as JsonObject).properties as JsonObject).audience as JsonObject;
  assert.deepEqual(audience.enum, ['ALL', 'BZR']);
  assert.equal((d.attributes.item_name as JsonObject[])[0].value, 'Source bag title');
  assert.equal((d.attributes.color as JsonObject[])[0].value, 'Blue');
  assert.equal(d.attributes.brand, undefined); assert.equal(d.attributes.purchasable_offer, undefined);
  assert.ok(!JSON.stringify(d.attributes).includes('92.35')); assert.ok(!JSON.stringify(d.attributes).includes('red-asset:'));
  const found = await f.service.searchProductTypes({ targetId: target.id, keywords: 'bag' }); assert.equal(found[0].name, 'HTC_DEMO_STORAGE_BAG');
  const restored = f.reopen().getDraft(d.id); assert.deepEqual(restored, d);
});

test('demo schema cache is isolated by locale, requirements and parentage', async t => {
  const f = fixture(t); const target = f.service.enableDemo(); const selection = { targetId: target.id, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE' as const, requirements: 'LISTING' as const, locale: 'en_US' };
  const a = await f.service.getSchema(selection); const cached = await f.service.getSchema(selection);
  assert.equal(a.fromCache, false); assert.equal(cached.fromCache, true); assert.equal(cached.key, a.key);
  const others = await Promise.all([{ ...selection, locale: 'zh_CN' }, { ...selection, parentageLevel: 'PARENT' as const }, { ...selection, requirements: 'LISTING_OFFER_ONLY' as const }].map(s => f.service.getSchema(s)));
  assert.equal(new Set([a, ...others].map(s => s.key)).size, 4);
});

test('missing fields block preview; save invalidates local checks and old previews', async t => {
  const f = fixture(t); let d = await demoDraft(f); d = await f.service.validateDraft(d);
  assert.equal(d.state, 'BLOCKED'); assert.ok(d.localIssues.some(issue => issue.attributeNames.includes('brand')));
  await assert.rejects(f.service.previewDraft(d), /本地校验|字段/);
  d = f.service.saveDraft({ ...d, attributes: ready(d) }); assert.equal(d.state, 'DRAFT');
  d = await f.service.validateDraft(d); assert.equal(d.state, 'LOCAL_VALIDATED');
  d = await f.service.previewDraft(d); assert.equal(d.state, 'AMAZON_VALIDATED'); assert.ok(d.previewedAt);
  const stale = d; d = f.service.saveDraft({ ...d, attributes: { ...ready(d), brand: [{ value: 'Changed', marketplace_id: d.marketplaceId }] } });
  assert.equal(d.previewedAt, null); assert.equal(d.state, 'DRAFT'); assert.deepEqual(d.previewIssues, []);
  assert.throws(() => f.service.saveDraft({ ...stale, attributes: ready(stale) }), /更新|重新加载/);
  await assert.rejects(f.service.submitDraft(d, true), /预览/);
});

test('submission needs native confirmation and a current preview, and acceptance needs readback', async t => {
  const f = fixture(t); let d = await demoDraft(f); d = f.service.saveDraft({ ...d, attributes: ready(d) }); d = await f.service.previewDraft(d);
  await assert.rejects(f.service.submitDraft(d, false), /确认/);
  const submitted = await f.service.submitDraft(d, true); assert.equal(submitted.state, 'SUBMITTED'); assert.ok(submitted.submissionId);
  await assert.rejects(f.service.submitDraft(submitted, true), /回读|已提交/);
  assert.throws(() => f.service.saveDraft({ ...submitted, attributes: ready(submitted) }), /回读|已提交/);
  const read = await f.service.readListing(submitted); assert.equal(read.state, 'BUYABLE'); assert.deepEqual(read.statuses, ['BUYABLE', 'DISCOVERABLE']);
  assert.equal(f.reopen().getDraft(d.id).state, 'BUYABLE');
});

test('source changes and expired preview independently block submission', async t => {
  const f = fixture(t); let d = await demoDraft(f); d = f.service.saveDraft({ ...d, attributes: ready(d) }); d = await f.service.previewDraft(d);
  f.advance(16 * 60_000); await assert.rejects(f.service.submitDraft(d, true), /过期|重新预览/);
  d = await f.service.previewDraft(d); const p = f.store.getProduct(f.product.id); f.store.saveProduct({ ...productInput(p), title: 'Changed source' });
  await assert.rejects(f.service.submitDraft(d, true), /来源商品|商品资料/);
});

test('credentials stay encrypted, rotation is visible, only one live target can be enabled', async t => {
  const f = fixture(t); const a = await f.service.importCredentials(credentials);
  assert.equal(a.configured, true); assert.equal(a.mode, 'live'); assert.ok(a.credentialUpdatedAt);
  f.advance(1000); const rotated = await f.service.importCredentials({ ...credentials, clientSecret: 'SECRET_ROTATED_NEVER_PUBLIC' });
  assert.equal(rotated.id, a.id); assert.notEqual(rotated.credentialUpdatedAt, a.credentialUpdatedAt);
  const b = await f.service.importCredentials({ ...credentials, sellerId: 'OTHER_SELLER' }); assert.notEqual(a.id, b.id);
  assert.equal(f.service.getTarget(a.id).paused, true); assert.equal(f.service.listTargets().filter(t => t.mode === 'live' && t.configured && !t.paused).length, 1);
  assert.ok(!JSON.stringify([f.service.listTargets(), f.service.listCalls()]).includes('SECRET_'));
  for (const name of readdirSync(f.directory)) if (name.startsWith('red.sqlite')) assert.ok(!readFileSync(join(f.directory, name)).includes(Buffer.from('SECRET_')));
  for (const name of readdirSync(join(f.directory, 'amazon-vault'))) assert.ok(!readFileSync(join(f.directory, 'amazon-vault', name)).includes(Buffer.from('SECRET_')));
  f.service.disconnectTarget(b.id); assert.equal(f.service.getTarget(b.id).configured, false); assert.equal(f.service.getTarget(b.id).paused, true);
  assert.ok(f.reopen().listTargets().every(target => !Object.keys(target).some(k => /secret|token|clientId/i.test(k))));
});

test('strict credential shape, marketplace region and unavailable encryption are rejected', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.importCredentials({ ...credentials, region: 'eu' }), /站点|区域/);
  await assert.rejects(f.service.importCredentials({ ...credentials, accessToken: 'SHOULD_NOT_EXIST' }), /字段|配置/);
  const other = new implementation!.AmazonService(f.directory, id => f.store.getProduct(id), { ...safeStorage, isEncryptionAvailable: () => false });
  try { await assert.rejects(other.importCredentials(credentials), /加密/); } finally { other.close(); }
  assert.deepEqual(f.service.listTargets(), []);
});

test('retention uses original timestamps and log floor, including after restart', async t => {
  const f = fixture(t); const d = await demoDraft(f); assert.equal(f.service.getDataPolicy().retentionDays, 180);
  assert.throws(() => f.service.saveDataPolicy({ retentionDays: 549 }), /548/);
  assert.throws(() => f.service.saveDataPolicy({ retentionDays: 0 }), /期限|天/);
  const policy = f.service.saveDataPolicy({ retentionDays: 1 }); assert.ok(policy.logRetentionDays >= 365);
  const calls = f.service.listCalls().length;
  f.advance(2 * 86_400_000); const result = f.service.cleanupData(); assert.ok(result.removedDrafts >= 1); assert.ok(result.removedSchemas >= 1);
  assert.equal(result.removedCalls, 0); assert.equal(f.service.listCalls().length, calls);
  assert.throws(() => f.service.getDraft(d.id), /不存在|清理/); assert.ok(f.service.getDataPolicy().lastCleanupAt);
  f.reopen(); assert.equal(f.service.getDataPolicy().retentionDays, 1);
});

test('accepted listing needs readback and other existing draft previews cannot replay it', async t => {
  const f = fixture(t); let first = await demoDraft(f); let second = await demoDraft(f);
  first = f.service.saveDraft({ ...first, attributes: ready(first) }); second = f.service.saveDraft({ ...second, attributes: ready(second) });
  first = await f.service.previewDraft(first); second = await f.service.previewDraft(second);
  first = await f.service.submitDraft(first, true);
  await assert.rejects(demoDraft(f), /回读|未确认|已提交/);
  await f.service.readListing(first);
  assert.equal(f.service.getDraft(second.id).previewedAt, null);
  await assert.rejects(f.service.submitDraft(second, true), /预览|更新/);
  const fresh = await demoDraft(f); assert.equal(fresh.state, 'DRAFT');
});

test('conflicting confirmed values are not silently chosen as a source fact', async t => {
  const f = fixture(t); const product = f.store.getProduct(f.product.id); const input = productInput(product);
  input.facts.push({ id: randomUUID(), name: '颜色', value: 'Red', source: 'manual', sourceRef: '另一个标签', state: 'human_confirmed' });
  f.store.saveProduct(input); const draft = await demoDraft(f); assert.equal(draft.attributes.color, undefined);
});

test('schema selection rejects coerced array and object enum values', async t => {
  const f = fixture(t); const target = f.service.enableDemo();
  const input = { targetId: target.id, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' };
  await assert.rejects(f.service.getSchema({ ...input, parentageLevel: ['NONE'] }), /层级|无效/);
  await assert.rejects(f.service.getSchema({ ...input, requirements: ['LISTING'] }), /要求集|无效/);
  await assert.rejects(f.service.createDraft({ ...input, productId: f.product.id, variantId: f.product.variants[0].id, parentageLevel: ['NONE'] }), /层级|无效/);
});

test('secret values cannot be persisted through credential display metadata', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.importCredentials({ ...credentials, name: `Copied ${credentials.clientSecret}` }), /字段|授权|敏感/);
  assert.deepEqual(f.service.listTargets(), []);
  const target = await f.service.importCredentials(credentials);
  await assert.rejects(f.service.importCredentials({ ...credentials, clientSecret: 'SECRET_NEW_ROTATION', name: `Copied ${credentials.clientSecret}` }), /字段|授权|敏感/);
  assert.equal(f.service.getTarget(target.id).name, credentials.name);
  for (const name of readdirSync(f.directory).filter(name => name.startsWith('red.sqlite'))) assert.ok(!readFileSync(join(f.directory, name)).includes(Buffer.from(credentials.clientSecret)));
});

test('pre-submit readback rejects locally and leaves every editable state unchanged', async t => {
  const f = fixture(t); let d = await demoDraft(f);
  const check = async () => {
    const before = f.service.getDraft(d.id); const calls = f.service.listCalls().length;
    await assert.rejects(f.service.readListing(d), /提交|回读/);
    assert.deepEqual(f.service.getDraft(d.id), before); assert.equal(f.service.listCalls().length, calls);
  };
  await check();
  d = await f.service.validateDraft(d); assert.equal(d.state, 'BLOCKED'); await check();
  d = f.service.saveDraft({ ...d, attributes: ready(d) });
  d = await f.service.validateDraft(d); assert.equal(d.state, 'LOCAL_VALIDATED'); await check();
  d = await f.service.previewDraft(d); assert.equal(d.state, 'AMAZON_VALIDATED'); await check();
  d = f.service.saveDraft({ ...d, attributes: ready(d) }); assert.equal(d.state, 'DRAFT');
});

test('cleanup removes expired payload bytes from checkpointed database and WAL', async t => {
  const f = fixture(t); const d = await demoDraft(f); const marker = `EXPIRED_AMAZON_PAYLOAD_${randomUUID()}`;
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  db.prepare('UPDATE schema_cache SET schema_json=?,snapshot_json=? WHERE cache_key=?').run(JSON.stringify({ expired: marker.repeat(300) }), JSON.stringify({ expired: marker.repeat(300) }), d.schema.key);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
  assert.ok(readFileSync(join(f.directory, 'red.sqlite')).includes(Buffer.from(marker)), 'Fixture must contain the original expired bytes');
  f.advance(181 * 86_400_000); f.service.cleanupData();
  for (const name of readdirSync(f.directory).filter(name => name === 'red.sqlite' || name === 'red.sqlite-wal')) assert.ok(!readFileSync(join(f.directory, name)).includes(Buffer.from(marker)), `Expired bytes remain in ${name}`);
});
