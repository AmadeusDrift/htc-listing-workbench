import { SCHEMA_VERSION } from '../src/main/database.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { fixture, storage, isCode } from './fixtures/ai-control.ts';
import { openDatabase } from '../src/main/database.ts';
import { AiService } from '../src/main/ai/service.ts';
import { AiUsageLedger } from '../src/main/ai/usage.ts';
import { validateAiCall, validateAiResult } from '../src/main/ai/validation.ts';
import { validateAiUsageRecord } from '../src/main/ai/usage.ts';
import { ImageVersionService } from '../src/main/image-versions/service.ts';
import { ReviewedContentService } from '../src/main/content/service.ts';
import { suggestionFingerprint } from '../src/main/ai/review.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { dropRecordQueryIndexes } from './helpers/legacy-schema.ts';

const at = '2026-09-30T00:00:00.000Z', hash = 'a'.repeat(64);
const output = { kind: 'text' as const, title: 'Synthetic title', bullets: ['Synthetic detail'], description: 'Synthetic description', attributes: [] };
const tables = ['ai_results', 'ai_calls', 'image_versions', 'image_selections', 'content_versions'] as const;
type Table = typeof tables[number];
function value(table: Table, productId: string) {
  const id = randomUUID();
  const common = { id, productId };
  if (table === 'ai_results') return { ...common, callId: randomUUID(), providerId: 'deepseek', productRevision: 1, variantId: randomUUID(), assetId: null, assetSha256: null, sourceResultIds: [], model: 'deepseek-flash', createdAt: at, reviewState: 'unreviewed', output };
  if (table === 'ai_calls') return { ...common, providerId: 'deepseek', productRevision: 1, status: 'SUCCEEDED', errorCode: null, requestId: null, model: 'deepseek-flash', generation: 1, startedAt: at, finishedAt: at, usage: { promptTokens: 1, completionTokens: 1, processedImages: 0 } };
  if (table === 'image_versions') return { ...common, productRevision: 1, sourceAssetId: randomUUID(), sourceSha256: hash, resultId: randomUUID(), version: 1, width: 256, height: 256, byteSize: 33, sha256: hash, originalPath: `assets/${id}.png`, previewPath: `assets/${id}.preview.png`, previewSha256: hash, previewByteSize: 33, createdAt: at, reviewState: 'unreviewed', checks: { transparentPixels: 30000, subjectPixels: 35536 } };
  if (table === 'image_selections') return { ...common, sourceAssetId: randomUUID(), sourceSha256: hash, versionId: null, selectedAt: at, reviewState: 'human-selected' };
  return { ...common, sourceRevision: 1, variantId: randomUUID(), generationResultId: randomUUID(), reviewResultId: randomUUID(), suggestionSha256: suggestionFingerprint(output), sourceSha256: hash, generationModel: 'deepseek-flash', reviewModel: 'deepseek-v4-pro', policyVersion: 'content-review/v1', createdAt: at, status: 'model-approved', output };
}
async function setup(t: test.TestContext) {
  let cleanup = async () => {}; t.after(() => cleanup());
  const f = await fixture(t);
  const images = new ImageVersionService(f.directory, f.store, f.service, { decode: () => { throw Error('unused'); } });
  const content = new ReviewedContentService(f.directory, f.store, f.service), db = openDatabase(f.directory);
  cleanup = async () => { db.close(); content.close(); await images.close(); };
  const query = (table: Table, input: unknown) => {
    if (table === 'ai_results') return f.service.queryResults(input);
    if (table === 'ai_calls') return f.service.queryCalls(input);
    if (table === 'image_versions') return images.queryVersions(input);
    if (table === 'image_selections') return images.querySelections(input);
    return content.queryVersions(input);
  };
  const list = (table: Table, id: string) => table === 'ai_results' ? f.service.listResults(id) : table === 'ai_calls' ? f.service.listCalls().filter(row => row.productId === id) : table === 'image_versions' ? images.list(id) : table === 'image_selections' ? images.selections(id) : content.list(id);
  const insert = (table: Table, productId: string) => { const row = value(table, productId); db.prepare(`INSERT INTO ${table}(id,record_json) VALUES(?,?)`).run(row.id, JSON.stringify(row)); return row; };
  return { ...f, images, content, db, query, list, insert };
}

test('product lists filter in SQLite before validating unrelated product records', async t => {
  const f = await setup(t), other = randomUUID();
  for (const table of tables.filter(table => table !== 'ai_calls')) {
    const expected = f.insert(table, f.product.id), broken = f.insert(table, other);
    f.db.prepare(`UPDATE ${table} SET record_json=? WHERE id=?`).run(JSON.stringify({ id: broken.id, productId: other, unexpected: true }), broken.id);
    assert.deepEqual(f.list(table, f.product.id), [expected]);
  }
});

test('all page APIs validate page size, exact fields, product IDs and cursors', async t => {
  const f = await setup(t);
  assert.equal(typeof f.service.queryResults, 'function', 'paged results API exists');
  for (const table of tables) {
    for (const pageSize of [0, 101, 1.5, '2', null, true]) assert.throws(() => f.query(table, { productId: f.product.id, pageSize }), isCode('INVALID_INPUT'));
    for (const input of [null, [], { productId: 'bad' }, { productId: f.product.id, cursor: '' }, { productId: f.product.id, cursor: 'broken' }, { productId: f.product.id, cursor: 12 }, { productId: f.product.id, sql: '1=1' }]) assert.throws(() => f.query(table, input), isCode('INVALID_INPUT'));
    if (table !== 'ai_calls') assert.throws(() => f.query(table, {}), isCode('INVALID_INPUT'));
    assert.deepEqual(f.query(table, { productId: f.product.id }), { items: [], nextCursor: null });
  }
  for (const input of [{ providerId: 'unknown' }, { status: 'SUCCEEDED OR 1=1' }, { status: ['RUNNING'] }]) assert.throws(() => f.service.queryCalls(input), isCode('INVALID_INPUT'));
});

test('all resources page in insertion order without omissions, duplicates or newly appended rows', async t => {
  const f = await setup(t), other = randomUUID();
  for (const table of tables) {
    const expected = Array.from({ length: 7 }, () => { f.insert(table, other); return f.insert(table, f.product.id); });
    const first = f.query(table, { productId: f.product.id, pageSize: 2 }); assert.ok(first.nextCursor);
    const appended = f.insert(table, f.product.id), all = [...first.items]; let cursor: string | null = first.nextCursor;
    while (cursor) { const page = f.query(table, { productId: f.product.id.toUpperCase(), pageSize: 3, cursor }); all.push(...page.items); cursor = page.nextCursor; }
    assert.deepEqual(all, expected); assert.equal(new Set(all.map(row => row.id)).size, 7);
    assert.deepEqual(f.query(table, { productId: f.product.id }).items, [...expected, appended]);
    assert.throws(() => f.query(table, { productId: other, cursor: first.nextCursor }), isCode('INVALID_INPUT'));
    const token = first.nextCursor!, [encoded, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()); payload.after = 0;
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
    assert.throws(() => f.query(table, { productId: f.product.id, cursor: tampered }), isCode('INVALID_INPUT'));
  }
  const resultCursor = f.service.queryResults({ productId: f.product.id, pageSize: 1 }).nextCursor;
  assert.throws(() => f.service.queryCalls({ productId: f.product.id, cursor: resultCursor }), isCode('INVALID_INPUT'));
  const imageCursor = f.images.queryVersions({ productId: f.product.id, pageSize: 1 }).nextCursor;
  assert.throws(() => f.images.querySelections({ productId: f.product.id, cursor: imageCursor }), isCode('INVALID_INPUT'));
});

test('AI call filters bind cursor identity and old cursors expire with their service instance', async t => {
  const f = await setup(t);
  for (let n = 0; n < 55; n++) f.insert('ai_calls', f.product.id);
  assert.equal(f.service.queryCalls({}).items.length, 50);
  const first = f.service.queryCalls({ productId: f.product.id, providerId: 'deepseek', status: 'SUCCEEDED', pageSize: 1 });
  assert.ok(first.nextCursor);
  assert.throws(() => f.service.queryCalls({ productId: f.product.id, providerId: 'deepseek', cursor: first.nextCursor }), isCode('INVALID_INPUT'));
  assert.deepEqual(f.service.queryCalls({ providerId: 'aliyun-ocr' }).items, []);
  assert.deepEqual(f.service.queryCalls({ status: 'RUNNING' }).items, []);
  await f.service.close();
  const reopened = new AiService(f.directory, f.store, f.hosting, storage);
  try { assert.throws(() => reopened.queryCalls({ productId: f.product.id, providerId: 'deepseek', status: 'SUCCEEDED', cursor: first.nextCursor }), isCode('INVALID_INPUT')); }
  finally { await reopened.close(); }
});

test('single ID readers use the key and reject mismatched stored identity', async t => {
  const f = await setup(t), result = f.insert('ai_results', f.product.id), call = f.insert('ai_calls', f.product.id);
  assert.equal(typeof f.service.getResult, 'function', 'single result lookup exists');
  f.db.prepare('INSERT INTO ai_results VALUES(?,?)').run(randomUUID(), JSON.stringify({ bad: true }));
  f.db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(randomUUID(), JSON.stringify({ bad: true }));
  assert.deepEqual(f.service.getResult(result.id), result); assert.deepEqual(f.service.getCall(call.id), call);
  assert.equal(f.service.getResult(randomUUID()), undefined);
  f.db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({ ...result, id: randomUUID() }), result.id);
  assert.throws(() => f.service.getResult(result.id), isCode('INVALID_CONFIG'));
  assert.throws(() => f.service.queryResults({ productId: f.product.id }), isCode('INVALID_CONFIG'));
});

test('startup only validates running calls and pending usage; summary filters provider and UTC day first', async t => {
  const f = await fixture(t); await f.service.close(); const db = openDatabase(f.directory);
  try {
    const terminalId = randomUUID(), pendingId = randomUUID(), running = { ...value('ai_calls', f.product.id), id: pendingId, status: 'RUNNING', finishedAt: null };
    db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(terminalId, JSON.stringify({ id: terminalId, status: 'SUCCEEDED', broken: true }));
    db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(pendingId, JSON.stringify(running));
    const valid = { id: pendingId, providerId: 'deepseek', day: at.slice(0, 10), startedAt: at, finishedAt: null, state: 'PENDING', reservedTokens: 5000, usage: { promptTokens: 0, completionTokens: 0, processedImages: 0 } };
    db.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(pendingId, JSON.stringify(valid));
    for (const row of [{ id: randomUUID(), providerId: 'deepseek', day: '2026-09-29', state: 'UNKNOWN' }, { id: randomUUID(), providerId: 'aliyun-ocr', day: '2026-09-30', state: 'UNKNOWN' }]) db.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(row.id, JSON.stringify(row));
    const service = new AiService(f.directory, f.store, f.hosting, storage, { now: () => new Date(at) });
    try { assert.equal(service.getCall(pendingId)!.errorCode, 'INTERRUPTED'); const summary = service.getUsageSummary('deepseek'); assert.equal(summary.attempts, 1); assert.equal(summary.unknownCalls, 1); assert.equal(summary.reservedTokens, 5000); }
    finally { await service.close(); }
    const ledger = new AiUsageLedger(db, () => new Date(at));
    db.prepare('UPDATE ai_usage_ledger SET record_json=? WHERE id=?').run(JSON.stringify({ ...valid, state: 'UNKNOWN', finishedAt: at, id: randomUUID() }), pendingId);
    assert.throws(() => ledger.summary('deepseek'), isCode('INVALID_CONFIG'));
  } finally { db.close(); }
});

async function writeRawBackup(db: DatabaseSync, directory: string, file: string): Promise<void> {
  const snapshot = join(directory, `${randomUUID()}.sqlite`); await backup(db, snapshot);
  const bytes = readFileSync(snapshot); unlinkSync(snapshot);
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const assets = db.prepare('SELECT original_path,preview_path FROM assets').all().flatMap(row => ['original_path', 'preview_path'].map(key => { const path = String(row[key]), data = readFileSync(join(directory, path)); return { path, data: data.toString('base64'), sha256: digest(data) }; }));
  const manifest = { format: 'htc-workspace-backup', version: 1, source: { application: 'HTC', kind: 'local-workspace', databaseVersion: db.prepare('PRAGMA user_version').get()!.user_version }, retention: { amazonDays: 180, logDays: 365, dataOldestAt: null, expiresAt: null }, createdAt: new Date().toISOString(), database: bytes.toString('base64'), databaseSha256: digest(bytes), assets };
  const salt = randomBytes(16), iv = randomBytes(12), header = Buffer.concat([Buffer.from('HTC-BACKUP-1\n'), salt, iv]), key = scryptSync('record pagination backup passphrase', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try { const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header); writeFileSync(file, Buffer.concat([header, cipher.update(gzipSync(Buffer.from(JSON.stringify(manifest)))), cipher.final(), cipher.getAuthTag()])); }
  finally { key.fill(0); }
}
test('schema 8 migration adds query indexes without rewriting records and rolls back malformed JSON', async t => {
  const f = await fixture(t); await f.service.close(); const db = openDatabase(f.directory);
  const row = value('ai_results', f.product.id); db.prepare('INSERT INTO ai_results VALUES(?,?)').run(row.id, JSON.stringify(row));
  dropRecordQueryIndexes(db); db.exec('DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; PRAGMA user_version=8'); db.close();
  const migrated = openDatabase(f.directory);
  try { assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION); assert.deepEqual(JSON.parse(String(migrated.prepare('SELECT record_json FROM ai_results WHERE id=?').get(row.id)!.record_json)), row); assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='record_ai_results_product'").get()); }
  finally { migrated.close(); }
  const bad = new DatabaseSync(join(f.directory, 'red.sqlite')); dropRecordQueryIndexes(bad); bad.exec('DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; PRAGMA user_version=8'); bad.prepare('UPDATE ai_results SET record_json=?').run('{bad'); bad.close();
  assert.throws(() => openDatabase(f.directory));
  const unchanged = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try { assert.equal(unchanged.prepare('PRAGMA user_version').get()!.user_version, 8); assert.equal(unchanged.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'record_%'").get()!.n, 0); assert.equal(unchanged.prepare('SELECT record_json FROM ai_results').get()!.record_json, '{bad'); }
  finally { unchanged.close(); }
});

test('backup allows the exact nonunique query indexes and restores genuine schema 8', async t => {
  const f = await fixture(t), file = join(f.directory, 'indexed.htcbackup');
  await createWorkspaceBackup(f.directory, file, 'record pagination backup passphrase');
  const legacy = openDatabase(f.directory); dropRecordQueryIndexes(legacy); legacy.exec('DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; PRAGMA user_version=8');
  const oldFile = join(f.directory, 'old-eight.htcbackup');
  try { await writeRawBackup(legacy, f.directory, oldFile); } finally { legacy.close(); }
  const target = join(f.directory, 'restored-eight'), prepared = await prepareWorkspaceRestore(target, oldFile, 'record pagination backup passphrase'); await commitWorkspaceRestore(target, prepared);
  const restored = openDatabase(target); try { assert.equal(restored.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION); } finally { restored.close(); }
});

test('backup rejects arbitrary, unique, partial, collated and misleadingly named indexes', async t => {
  const f = await fixture(t), cases = [
    "CREATE INDEX unapproved ON ai_results(record_json)",
    "CREATE UNIQUE INDEX unapproved ON ai_results(json_extract(record_json,'$.productId'))",
    "CREATE INDEX record_ai_results_product ON ai_results(json_extract(record_json,'$.providerId'))",
    "CREATE INDEX record_ai_results_product ON ai_results(json_extract(record_json,'$.productId')) WHERE id IS NOT NULL",
    "CREATE INDEX record_ai_results_product ON ai_results(json_extract(record_json,'$.productId') COLLATE NOCASE)",
    "CREATE UNIQUE INDEX record_ai_results_product ON ai_results(json_extract(record_json,'$.productId'))",
  ];
  const db = openDatabase(f.directory);
  try {
    for (const [n, sql] of cases.entries()) {
      db.exec('DROP INDEX IF EXISTS record_ai_results_product'); db.exec(sql);
      await assert.rejects(createWorkspaceBackup(f.directory, join(f.directory, `bad-index-${n}.htcbackup`), 'record pagination backup passphrase'));
      const rawFile = join(f.directory, `untrusted-index-${n}.htcbackup`); await writeRawBackup(db, f.directory, rawFile);
      await assert.rejects(prepareWorkspaceRestore(join(f.directory, `rejected-restore-${n}`), rawFile, 'record pagination backup passphrase'));
      db.exec('DROP INDEX IF EXISTS unapproved; DROP INDEX IF EXISTS record_ai_results_product');
    }
  } finally { db.close(); }
});

function duplicateCases(productId: string) {
  const usage = { id: randomUUID(), providerId: 'deepseek', day: '2026-09-30', startedAt: at, finishedAt: at, state: 'REPORTED', reservedTokens: 5000, usage: { promptTokens: 1, completionTokens: 1, processedImages: 0 } };
  return [
    { table: 'ai_results', row: value('ai_results', productId), field: 'productId', first: randomUUID(), validate: validateAiResult },
    { table: 'ai_calls', row: value('ai_calls', productId), field: 'providerId', first: 'aliyun-ocr', validate: validateAiCall },
    { table: 'ai_calls', row: value('ai_calls', productId), field: 'status', first: 'RUNNING', validate: validateAiCall },
    { table: 'ai_usage_ledger', row: usage, field: 'day', first: '2026-09-29', validate: validateAiUsageRecord },
    { table: 'ai_usage_ledger', row: usage, field: 'state', first: 'PENDING', validate: validateAiUsageRecord },
  ];
}
function escapedKey(key: string): string { return [...key].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''); }
function ambiguousJson(row: object, field: string, first: string, escaped: boolean): string {
  return `{"${escaped ? escapedKey(field) : field}":${JSON.stringify(first)},${JSON.stringify(row).slice(1)}`;
}

test('migration and both backup boundaries reject duplicate SQL filter keys including Unicode aliases', async t => {
  for (const field of ['productId', 'providerId', 'status', 'day', 'state']) for (const escaped of [false, true]) for (const boundary of ['migration', 'create', 'restore']) {
    await t.test(`${field}/${escaped ? 'unicode' : 'literal'}/${boundary}`, async t => {
      const f = await fixture(t), selected = duplicateCases(f.product.id).find(value => value.field === field)!;
      const raw = ambiguousJson(selected.row, selected.field, selected.first, escaped);
      // Existing JS validators accept the last field; these are real parser disagreements, not malformed records.
      assert.deepEqual(selected.validate(JSON.parse(raw)), selected.row);
      const db = openDatabase(f.directory);
      if (boundary === 'migration') { dropRecordQueryIndexes(db); db.exec('DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; PRAGMA user_version=8'); }
      db.prepare(`INSERT INTO ${selected.table}(id,record_json) VALUES(?,?)`).run(selected.row.id, raw);
      const file = join(f.directory, 'ambiguous.htcbackup'), target = join(f.directory, 'rejected-restore');
      if (boundary === 'restore') await writeRawBackup(db, f.directory, file);
      db.close();
      if (boundary === 'migration') {
        assert.throws(() => { const upgraded = openDatabase(f.directory); upgraded.close(); }, /重复 JSON 字段/);
        const unchanged = new DatabaseSync(join(f.directory, 'red.sqlite'));
        try { assert.equal(unchanged.prepare('PRAGMA user_version').get()!.user_version, 8); assert.equal(unchanged.prepare(`SELECT record_json FROM ${selected.table} WHERE id=?`).get(selected.row.id)!.record_json, raw); assert.equal(unchanged.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'record_%'").get()!.n, 0); }
        finally { unchanged.close(); }
      } else if (boundary === 'create') {
        await assert.rejects(createWorkspaceBackup(f.directory, file, 'record pagination backup passphrase'), /重复 JSON 字段/);
        assert.equal(existsSync(file), false);
      } else {
        await assert.rejects(prepareWorkspaceRestore(target, file, 'record pagination backup passphrase'), /重复 JSON 字段/);
        assert.equal(existsSync(join(target, 'red.sqlite')), false);
      }
    });
  }
});

test('migration rejects identical duplicate values and nested aliases without conflating different parent objects', async t => {
  const f = await fixture(t), row = value('ai_results', f.product.id);
  const legacy = new DatabaseSync(join(f.directory, 'red.sqlite')); dropRecordQueryIndexes(legacy); legacy.exec('DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; PRAGMA user_version=8'); legacy.close();
  for (const raw of [ambiguousJson(row, 'productId', f.product.id, true), JSON.stringify(row).replace('"title":"Synthetic title"', '"title":"earlier","\\u0074itle":"Synthetic title"')]) {
    const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
    db.prepare('INSERT INTO ai_results(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(row.id, raw); db.close();
    assert.throws(() => { const upgraded = openDatabase(f.directory); upgraded.close(); }, /重复 JSON 字段/);
  }
  const clean = new DatabaseSync(join(f.directory, 'red.sqlite'));
  const canonical = { ...row, output: { ...output, attributes: [{ name: 'Material', value: 'Cotton', factIds: [randomUUID()] }, { name: 'Color', value: 'Red', factIds: [randomUUID()] }] } };
  clean.prepare('UPDATE ai_results SET record_json=?').run(JSON.stringify(canonical).replace('"productId"', `"${escapedKey('productId')}"`)); clean.close();
  const migrated = openDatabase(f.directory);
  try { assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION); assert.deepEqual(f.service.queryResults({ productId: f.product.id }).items, [canonical]); }
  finally { migrated.close(); }
});

test('single Unicode escaped filter keys retain exact call and usage results after migration', async t => {
  const f = await fixture(t), call = validateAiCall(value('ai_calls', f.product.id)), usage = validateAiUsageRecord({ id: call.id, providerId: call.providerId, day: '2026-09-30', startedAt: at, finishedAt: at, state: 'REPORTED', reservedTokens: 5000, usage: call.usage });
  const escape = (row: object, fields: string[]) => fields.reduce((raw, field) => raw.replace(`"${field}"`, `"${escapedKey(field)}"`), JSON.stringify(row));
  const db = openDatabase(f.directory); dropRecordQueryIndexes(db); db.exec('DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; DROP TABLE IF EXISTS source_snapshots; DROP TABLE IF EXISTS product_source_adoptions; DROP TABLE IF EXISTS product_fact_scopes; PRAGMA user_version=8');
  db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(call.id, escape(call, ['productId', 'providerId', 'status']));
  db.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(usage.id, escape(usage, ['providerId', 'day', 'state'])); db.close();
  const migrated = openDatabase(f.directory);
  try {
    assert.deepEqual(f.service.queryCalls({ productId: f.product.id, providerId: 'deepseek', status: 'SUCCEEDED' }).items, [call]);
    const ledger = new AiUsageLedger(migrated, () => new Date(at));
    ledger.setPolicy({ providerId: 'deepseek', dailyCallLimit: 1, dailyTokenLimit: null });
    assert.equal(ledger.summary('deepseek').attempts, 1);
    assert.throws(() => ledger.reserve({ ...call, id: randomUUID(), status: 'RUNNING', finishedAt: null }, JSON.stringify({ max_tokens: 4096 })), isCode('QUOTA_EXCEEDED'));
  } finally { migrated.close(); }
});
