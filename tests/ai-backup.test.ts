import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase, SCHEMA_VERSION } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import type { AiProfile, AiCall, AiResult } from '../src/shared/ai-contracts.ts';

function fixture(t: test.TestContext) {
  mkdirSync(resolve('.test-data'), { recursive: true });
  const root = mkdtempSync(resolve('.test-data/ai-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function seed(directory: string) {
  const store = new WorkspaceStore(directory), product = store.createProduct(); store.close();
  const profile: AiProfile = { id: 'deepseek', capability: 'text', model: 'deepseek-flash', enabled: true, configured: true, generation: 8 };
  const call: AiCall = { id: randomUUID(), providerId: 'deepseek', productId: product.id, productRevision: product.revision,
    status: 'RUNNING', errorCode: null, requestId: null, model: profile.model, generation: 8,
    startedAt: new Date().toISOString(), finishedAt: null, usage: { promptTokens: 0, completionTokens: 0, processedImages: 0 } };
  const result: AiResult = { id: randomUUID(), callId: randomUUID(), providerId: 'deepseek', productId: product.id, productRevision: product.revision,
    variantId: product.variants[0].id, assetId: null, assetSha256: null, sourceResultIds: [], model: profile.model,
    createdAt: new Date().toISOString(), reviewState: 'unreviewed', output: { kind: 'text', title: 'Source title', bullets: ['Source detail'], description: 'Source description', attributes: [] } };
  const db = openDatabase(directory);
  db.prepare('INSERT INTO ai_profiles VALUES(?,?)').run(profile.id, JSON.stringify(profile));
  db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(call.id, JSON.stringify(call));
  db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(result.callId, JSON.stringify({ ...call, id: result.callId, status: 'SUCCEEDED', finishedAt: result.createdAt }));
  db.prepare('INSERT INTO ai_results VALUES(?,?)').run(result.id, JSON.stringify(result));
  db.close();
  return { product, profile, call, result };
}

test('v4 workspace migrates through AI and artifact tables without changing existing product facts or SKU', t => {
  const root = fixture(t), store = new WorkspaceStore(root), product = store.createProduct(); store.close();
  const legacy = new DatabaseSync(join(root, 'red.sqlite'));
  legacy.exec('DROP TABLE IF EXISTS miaoshou_sync_items; DROP TABLE IF EXISTS miaoshou_sync_runs; DROP TABLE IF EXISTS miaoshou_receipts; DROP TABLE IF EXISTS collection_captures; DROP TABLE IF EXISTS collection_receipts; DROP TABLE IF EXISTS ai_usage_ledger; DROP TABLE IF EXISTS ai_usage_policies; DROP TABLE IF EXISTS image_write_operations; DROP TABLE IF EXISTS image_versions; DROP TABLE IF EXISTS image_selections; DROP TABLE IF EXISTS content_versions; DROP TABLE IF EXISTS ai_profiles; DROP TABLE IF EXISTS ai_calls; DROP TABLE IF EXISTS ai_results; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; PRAGMA user_version=4'); legacy.close();
  const db = openDatabase(root);
  try {
    assert.equal(SCHEMA_VERSION, 17);
    for (const table of ['ai_profiles', 'ai_calls', 'ai_results']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
  } finally { db.close(); }
  const restored = new WorkspaceStore(root); try { assert.deepEqual(restored.getProduct(product.id), product); } finally { restored.close(); }
});

test('AI backup preserves unreviewed results, excludes vault, disables providers and interrupts pending calls', async t => {
  const root = fixture(t), source = join(root, 'source'), target = join(root, 'target'), file = join(root, 'ai.htcbackup');
  const seeded = seed(source); mkdirSync(join(source, 'ai-vault')); writeFileSync(join(source, 'ai-vault/deepseek.bin'), 'SECRET_SENTINEL');
  await createWorkspaceBackup(source, file, 'isolated AI backup passphrase');
  const prepared = await prepareWorkspaceRestore(target, file, 'isolated AI backup passphrase');
  await commitWorkspaceRestore(target, prepared);
  const db = openDatabase(target);
  try {
    const profile = JSON.parse(String(db.prepare('SELECT record_json FROM ai_profiles').get()!.record_json));
    assert.equal(profile.enabled, false); assert.equal(profile.configured, false); assert.ok(profile.generation > seeded.profile.generation);
    const call = JSON.parse(String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(seeded.call.id)!.record_json));
    assert.equal(call.status, 'FAILED'); assert.equal(call.errorCode, 'INTERRUPTED'); assert.ok(call.finishedAt);
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT record_json FROM ai_results').get()!.record_json)), seeded.result);
  } finally { db.close(); }
  assert.equal(existsSync(join(target, 'ai-vault')), false);
});

test('AI backup rejects hidden credentials, malformed result records and record identity mismatch', async t => {
  const root = fixture(t);
  for (const [index, mutation] of [
    (profile: AiProfile) => ({ ...profile, apiKey: 'NEVER_EXPORT' }),
    (profile: AiProfile) => ({ ...profile, id: 'aliyun-ocr' }),
  ].entries()) {
    const source = join(root, `case-${index}`), { profile } = seed(source), db = openDatabase(source);
    db.prepare('UPDATE ai_profiles SET record_json=?').run(JSON.stringify(mutation(profile))); db.close();
    await assert.rejects(createWorkspaceBackup(source, join(root, `invalid-${index}.htcbackup`), 'isolated AI backup passphrase'));
  }
  const source = join(root, 'invalid-result'), { result } = seed(source), db = openDatabase(source);
  db.prepare('UPDATE ai_results SET record_json=?').run(JSON.stringify({ ...result, reviewState: 'confirmed' })); db.close();
  await assert.rejects(createWorkspaceBackup(source, join(root, 'invalid-result.htcbackup'), 'isolated AI backup passphrase'));
});

test('AI vault cannot be used as a backup destination', async t => {
  const root = fixture(t); const store = new WorkspaceStore(root); store.close();
  await assert.rejects(createWorkspaceBackup(root, join(root, 'ai-vault/hidden.htcbackup'), 'isolated AI backup passphrase'), /备份文件/);
});

test('AI backup rejects array call states that cannot be interrupted on restore', async t => {
  const root = fixture(t), source = join(root, 'invalid-call'), file = join(root, 'invalid-call.htcbackup');
  const { call } = seed(source), db = openDatabase(source);
  db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({ ...call, status: ['RUNNING'] }), call.id); db.close();
  await assert.rejects(createWorkspaceBackup(source, file, 'isolated AI backup passphrase'));
  assert.equal(existsSync(file), false);
});

test('backup interruption handles a system clock moving behind the pending request start', async t => {
  const root = fixture(t), source = join(root, 'source'), target = join(root, 'target'), file = join(root, 'clock.htcbackup');
  const { call } = seed(source), startedAt = new Date(Date.now() + 3600000).toISOString(), db = openDatabase(source);
  db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({ ...call, startedAt }), call.id); db.close();
  await createWorkspaceBackup(source, file, 'isolated AI backup passphrase');
  const prepared = await prepareWorkspaceRestore(target, file, 'isolated AI backup passphrase'); await commitWorkspaceRestore(target, prepared);
  const restored = openDatabase(target);
  try { const record = JSON.parse(String(restored.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id)!.record_json)); assert.equal(record.errorCode, 'INTERRUPTED'); assert.ok(record.finishedAt >= startedAt); }
  finally { restored.close(); }
});
