import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { AiService } from '../src/main/ai/service.ts';
import { AiUsageLedger, retainAiUsage } from '../src/main/ai/usage.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { openDatabase, SCHEMA_VERSION } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { fixture, holdFetch, isCode, json, responseFor, storage } from './fixtures/ai-control.ts';
import { dropRecordQueryIndexes } from './helpers/legacy-schema.ts';

test('usage policy defaults unlimited, validates narrowly and persists across generations and restarts', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.service.getUsagePolicy, 'function', 'usage policy API must exist');
  assert.deepEqual(f.service.getUsagePolicy('deepseek'), { providerId: 'deepseek', dailyCallLimit: null, dailyTokenLimit: null });
  const policy = { providerId: 'deepseek', dailyCallLimit: 3, dailyTokenLimit: 50000 };
  assert.deepEqual(f.service.setUsagePolicy(policy), policy);
  for (const value of [-1, 0.5, '10', Number.MAX_SAFE_INTEGER, NaN]) assert.throws(() => f.service.setUsagePolicy({ ...policy, dailyCallLimit: value }));
  assert.throws(() => f.service.setUsagePolicy({ ...policy, apiKey: 'secret' }));
  assert.throws(() => f.service.setUsagePolicy({ ...policy, providerId: 'aliyun-ocr' }));
  f.enable('deepseek'); f.enable('deepseek', 'deepseek-v4-pro'); assert.deepEqual(f.service.getUsagePolicy('deepseek'), policy);
  await f.service.close(); const restarted = new AiService(f.directory, f.store, f.hosting, storage); try { assert.deepEqual(restarted.getUsagePolicy('deepseek'), policy); } finally { await restarted.close(); }
});

test('zero quota and insufficient token reservation send no request and create no paid-call record', async t => {
  const f = await fixture(t); f.enable('deepseek');
  for (const policy of [{ dailyCallLimit: 0, dailyTokenLimit: null }, { dailyCallLimit: null, dailyTokenLimit: 4096 }]) {
    f.service.setUsagePolicy({ providerId: 'deepseek', ...policy }); await assert.rejects(f.service.suggest(f.textInput), isCode('QUOTA_EXCEEDED'));
  }
  assert.equal(f.requests.length, 0); assert.equal(f.service.listCalls().length, 0); assert.equal(f.service.getUsageSummary('deepseek').attempts, 0);
});

test('the final daily call is reserved atomically and duplicate waiters consume it once', async t => {
  const held = holdFetch(), f = await fixture(t, { fetch: held.fetch }); f.enable('deepseek'); f.service.setUsagePolicy({ providerId: 'deepseek', dailyCallLimit: 1, dailyTokenLimit: null });
  const other = f.store.createProduct();
  const first = f.service.suggest(f.textInput), duplicate = f.service.suggest(f.textInput);
  const denied = assert.rejects(f.service.suggest({ productId: other.id, productRevision: other.revision, variantId: other.variants[0].id, ocrResultIds: [] }), isCode('QUOTA_EXCEEDED'));
  await held.started; await denied;
  const pending = f.service.getUsageSummary('deepseek'); assert.equal(pending.attempts, 1); assert.equal(pending.pendingCalls, 1); assert.equal(pending.unknownCalls, 0);
  const body = JSON.parse(String(f.requests[0].options?.body)); assert.equal(pending.reservedTokens, Buffer.byteLength(String(f.requests[0].options?.body), 'utf8') + 512 + body.max_tokens);
  assert.equal(body.max_tokens, 4096); held.release(); assert.deepEqual(await first, await duplicate);
  assert.equal(f.requests.length, 1); const done = f.service.getUsageSummary('deepseek'); assert.equal(done.reportedTokens, 40); assert.equal(done.reservedTokens, 0); assert.equal(done.usedTokens, 40);
});

for (const failure of ['http-unknown', 'network', 'timeout', 'known-failure', 'invalid-output'] as const) test(`${failure}: paid attempts retain unknown reservations or independently valid provider usage`, async t => {
  const f = await fixture(t, { timeoutMs: 20, fetch: async () => {
    if (failure === 'network') throw new Error('network detail');
    if (failure === 'timeout') return new Promise<Response>(() => {});
    if (failure === 'http-unknown') return json({ id: 'failed-request' }, 500);
    if (failure === 'known-failure') return json({ id: 'failed-request', usage: { prompt_tokens: 10, completion_tokens: 2 } }, 500);
    return json({ id: 'invalid-copy', usage: { prompt_tokens: 8, completion_tokens: 4 }, choices: [{ finish_reason: 'stop', message: { content: '{invalid' } }] });
  } }); f.enable('deepseek');
  await assert.rejects(f.service.suggest(f.textInput));
  const summary = f.service.getUsageSummary('deepseek'); assert.equal(summary.attempts, 1); assert.equal(summary.pendingCalls, 0);
  const known = failure === 'known-failure' || failure === 'invalid-output'; assert.equal(summary.unknownCalls, known ? 0 : 1); assert.equal(summary.reportedTokens, known ? 12 : 0);
  assert.equal(summary.reservedTokens > 4096, !known); assert.equal(f.service.listCalls().length, 1);
  if (!known) { f.service.setUsagePolicy({ providerId: 'deepseek', dailyCallLimit: null, dailyTokenLimit: summary.reservedTokens }); await assert.rejects(f.service.suggest(f.textInput), isCode('QUOTA_EXCEEDED')); assert.equal(f.requests.length, 1); }
});

test('review reserves the actual 16384 output budget and OCR reports image counts without invented tokens', async t => {
  const f = await fixture(t); f.enable('deepseek'); const suggestion = await f.service.suggest(f.textInput); f.enable('deepseek-review');
  const held = holdFetch(); f.respond(held.fetch); const review = f.service.review({ productId: f.product.id, productRevision: f.product.revision, suggestionResultId: suggestion.id }); await held.started;
  const body = String(f.requests[1].options?.body); assert.equal(JSON.parse(body).max_tokens, 16384); assert.equal(f.service.getUsageSummary('deepseek-review').reservedTokens, Buffer.byteLength(body) + 512 + 16384);
  held.release(); await review; f.respond(async (url, options) => responseFor(String(url), options)); f.enable('aliyun-ocr'); await f.service.recognize(f.imageInput);
  assert.equal(f.service.getUsageSummary('aliyun-ocr').usedTokens, 0); assert.equal(f.service.getUsageSummary('aliyun-ocr').processedImages, 1);
});

test('over-budget actual usage stays recorded; UTC rollover and generation changes do not reset the wrong day', async t => {
  let at = new Date('2026-09-30T23:59:59.000Z');
  const f = await fixture(t, { now: () => at, fetch: async (url, options) => { const raw = await responseFor(String(url), options).json(); return json({ ...raw, usage: { prompt_tokens: 70000, completion_tokens: 1 } }); } }); f.enable('deepseek');
  f.service.setUsagePolicy({ providerId: 'deepseek', dailyCallLimit: 5, dailyTokenLimit: 60000 }); await f.service.suggest(f.textInput);
  assert.equal(f.service.getUsageSummary('deepseek').usedTokens, 70001); f.enable('deepseek', 'deepseek-v4-pro'); await assert.rejects(f.service.suggest(f.textInput), isCode('QUOTA_EXCEEDED'));
  at = new Date('2026-10-01T00:00:00.000Z'); const summary = f.service.getUsageSummary('deepseek'); assert.equal(summary.day, '2026-10-01'); assert.equal(summary.timeZone, 'UTC'); assert.equal(summary.attempts, 0); await f.service.suggest(f.textInput); assert.equal(f.requests.length, 2);
});

test('schema 7 upgrades preserve historical attempts and unknown token liability', async t => {
  const f = await fixture(t); f.enable('deepseek'); await f.service.suggest(f.textInput); f.respond(async () => json({}, 500)); await assert.rejects(f.service.suggest(f.textInput)); await f.service.close();
  const old = new DatabaseSync(join(f.directory, 'red.sqlite')); dropRecordQueryIndexes(old); old.exec('DROP TABLE IF EXISTS ai_usage_policies; DROP TABLE IF EXISTS ai_usage_ledger; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; PRAGMA user_version=7'); old.close();
  const restarted = new AiService(f.directory, f.store, f.hosting, storage, { fetch: async () => { throw new Error('must not send'); } });
  try {
    assert.equal(SCHEMA_VERSION, 19); const summary = restarted.getUsageSummary('deepseek'); assert.equal(summary.attempts, 2); assert.equal(summary.reportedTokens, 40); assert.equal(summary.unknownCalls, 1); assert.equal(summary.unboundedCalls, 1); assert.equal(summary.usedTokens, null);
    restarted.setUsagePolicy({ providerId: 'deepseek', dailyCallLimit: null, dailyTokenLimit: 1000000000000 }); await assert.rejects(restarted.suggest(f.textInput), isCode('QUOTA_EXCEEDED'));
  } finally { await restarted.close(); }
});

test('restore merges usage since backup and since prepare without double counting or requiring restored call rows', async t => {
  const f = await fixture(t); f.enable('deepseek'); f.service.setUsagePolicy({ providerId: 'deepseek', dailyCallLimit: 4, dailyTokenLimit: null });
  const path = join(f.directory, 'older.htcbackup'); await createWorkspaceBackup(f.directory, path, 'usage restore fixture passphrase');
  await f.service.suggest(f.textInput); const prepared = await prepareWorkspaceRestore(f.directory, path, 'usage restore fixture passphrase'); await f.service.suggest(f.textInput);
  await f.service.close(); await f.hosting.close(); f.closeStore(); await commitWorkspaceRestore(f.directory, prepared);
  const db = openDatabase(f.directory); try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage_ledger').get()!.n, 2); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_calls').get()!.n, 0); } finally { db.close(); }
});

test('backup strictly validates usage record identity, fields and table indexes', async t => {
  for (const mutation of ['secret', 'identity', 'index']) {
    const f = await fixture(t); f.enable('deepseek'); await f.service.suggest(f.textInput); const db = openDatabase(f.directory);
    if (mutation === 'index') db.exec('CREATE INDEX bad_usage_index ON ai_usage_ledger(record_json)');
    else { const row = db.prepare('SELECT id,record_json FROM ai_usage_ledger').get()!, record = JSON.parse(String(row.record_json)); if (mutation === 'secret') record.secret = 'forbidden'; else record.id = 'invalid'; db.prepare('UPDATE ai_usage_ledger SET record_json=? WHERE id=?').run(JSON.stringify(record), row.id); } db.close();
    await assert.rejects(createWorkspaceBackup(f.directory, join(f.directory, 'invalid.htcbackup'), 'usage backup fixture passphrase'));
  }
});

test('token reservations serialize competing sources against the same final balance', async t => {
  const held = holdFetch(), f = await fixture(t, { fetch: held.fetch }); f.enable('deepseek');
  f.service.setUsagePolicy({ providerId: 'deepseek', dailyCallLimit: null, dailyTokenLimit: 9000 });
  const other = f.store.createProduct(), first = f.service.suggest(f.textInput);
  const denied = assert.rejects(f.service.suggest({ productId: other.id, productRevision: other.revision, variantId: other.variants[0].id, ocrResultIds: [] }), isCode('QUOTA_EXCEEDED'));
  await held.started; await denied; assert.equal(f.service.getUsageSummary('deepseek').attempts, 1); held.release(); await first; assert.equal(f.requests.length, 1);
});

test('a failure to insert the RUNNING call rolls back reservation and sends no HTTP', async t => {
  const f = await fixture(t); f.enable('deepseek'); const db = openDatabase(f.directory); db.exec("CREATE TRIGGER block_call BEFORE INSERT ON ai_calls BEGIN SELECT RAISE(ABORT,'fixture'); END");
  try { await assert.rejects(f.service.suggest(f.textInput)); assert.equal(f.requests.length, 0); assert.equal(f.service.getUsageSummary('deepseek').attempts, 0); }
  finally { db.exec('DROP TRIGGER block_call'); db.close(); }
});

test('known zero usage is distinct from missing or malformed provider usage', async t => {
  const f = await fixture(t); f.enable('deepseek');
  for (const usage of [{ prompt_tokens: 0, completion_tokens: 0 }, { prompt_tokens: 9 }, { prompt_tokens: 9, completion_tokens: 1, total_tokens: 0 }]) {
    f.respond(async () => json({ id: 'failure', usage }, 500)); await assert.rejects(f.service.suggest(f.textInput));
  }
  const summary = f.service.getUsageSummary('deepseek'); assert.equal(summary.attempts, 3); assert.equal(summary.unknownCalls, 2); assert.equal(summary.reportedTokens, 0); assert.ok(summary.reservedTokens > 8192);
});

test('reservation belongs to UTC send day even if completion crosses midnight or clock moves backwards', async t => {
  let at = new Date('2026-09-30T23:59:59.000Z'); const held = holdFetch(), f = await fixture(t, { fetch: held.fetch, now: () => at }); f.enable('deepseek');
  const first = f.service.suggest(f.textInput); await held.started; at = new Date('2026-10-01T00:00:01.000Z'); held.release(); await first;
  assert.equal(f.service.getUsageSummary('deepseek').attempts, 0); at = new Date('2026-09-30T23:59:58.000Z'); assert.equal(f.service.getUsageSummary('deepseek').attempts, 1); assert.equal(f.service.getUsageSummary('deepseek').reportedTokens, 40);
  const slow = holdFetch(); f.respond(slow.fetch); const second = f.service.suggest(f.textInput); await slow.started; at = new Date('2026-09-30T23:00:00.000Z'); slow.release(); await second;
  assert.ok(f.service.listCalls().every(call => call.finishedAt! >= call.startedAt));
  at = new Date('invalid'); await assert.rejects(f.service.suggest(f.textInput), isCode('INVALID_CONFIG')); assert.equal(f.requests.length, 2);
});

test('real process exit after reservation retains unknown usage on restart without resending', async t => {
  const directory = await mkdtemp(resolve('.test-data/ai-usage-crash-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const code = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, ['tests/fixtures/ai-usage-crash.ts', directory], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr.on('data', value => { output += value; });
    const timer = setTimeout(() => { child.kill(); reject(Error('Crash child timed out')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); if (code !== 73) reject(Error(output)); else done(code); });
  }); assert.equal(code, 73);
  const db = openDatabase(directory), before = JSON.parse(String(db.prepare('SELECT record_json FROM ai_usage_ledger').get()!.record_json)); db.close(); assert.equal(before.state, 'PENDING'); assert.ok(before.reservedTokens > 4096);
  const store = new WorkspaceStore(directory), hosting = new HostingService(directory, store, storage); let sent = 0;
  const service = new AiService(directory, store, hosting, storage, { now: () => new Date('2026-09-30T11:00:00.000Z'), fetch: async () => { sent++; throw Error('Unexpected send'); } });
  try { const summary = service.getUsageSummary('deepseek'); assert.equal(summary.attempts, 1); assert.equal(summary.pendingCalls, 0); assert.equal(summary.unknownCalls, 1); assert.equal(summary.reservedTokens, before.reservedTokens); assert.equal(service.listCalls()[0].errorCode, 'INTERRUPTED'); assert.equal(sent, 0); }
  finally { await service.close(); await hosting.close(); store.close(); }
});

test('restore keeps a later known settlement once per id and retains unknown facts without Amazon lock tables', async t => {
  const held = holdFetch(), f = await fixture(t, { fetch: held.fetch }); f.enable('deepseek'); const pending = f.service.suggest(f.textInput); await held.started;
  const path = join(f.directory, 'pending.htcbackup'); await createWorkspaceBackup(f.directory, path, 'pending usage fixture passphrase'); held.release(); await pending;
  const current = openDatabase(f.directory); current.exec('DROP TABLE amazon_write_locks'); current.close();
  const prepared = await prepareWorkspaceRestore(f.directory, path, 'pending usage fixture passphrase');
  await f.service.close(); await f.hosting.close(); f.closeStore(); await commitWorkspaceRestore(f.directory, prepared);
  const db = openDatabase(f.directory); try { const summary = new AiUsageLedger(db, () => new Date()).summary('deepseek'); assert.equal(summary.attempts, 1); assert.equal(summary.reportedTokens, 40); assert.equal(summary.reservedTokens, 0); assert.equal(summary.unknownCalls, 0); } finally { db.close(); }
});

test('merging the same unknown ledger twice is monotonic and rejects conflicting identity facts', async t => {
  const f = await fixture(t, { fetch: async () => { throw Error('unknown'); } }); f.enable('deepseek'); await assert.rejects(f.service.suggest(f.textInput));
  const source = openDatabase(f.directory), targetDirectory = join(f.directory, 'merge-target'), target = openDatabase(targetDirectory);
  try {
    retainAiUsage(source, target); retainAiUsage(source, target);
    assert.equal(new AiUsageLedger(target, () => new Date()).summary('deepseek').attempts, 1);
    const row = target.prepare('SELECT id,record_json FROM ai_usage_ledger').get()!, record = JSON.parse(String(row.record_json));
    target.prepare('UPDATE ai_usage_ledger SET record_json=? WHERE id=?').run(JSON.stringify({ ...record, providerId: 'deepseek-review' }), row.id);
    assert.throws(() => retainAiUsage(source, target));
  } finally { target.close(); source.close(); }
});

test('genuine version 7 encrypted backup restores and backfills already consumed calls', async t => {
  const f = await fixture(t); f.enable('deepseek'); await f.service.suggest(f.textInput); await f.service.close(); await f.hosting.close(); f.closeStore();
  const old = new DatabaseSync(join(f.directory, 'red.sqlite'));
  const paths = [...new Set(old.prepare('SELECT original_path,preview_path FROM assets').all().flatMap(row => [String(row.original_path), String(row.preview_path)]))];
  dropRecordQueryIndexes(old); old.exec('DROP TABLE ai_usage_policies; DROP TABLE ai_usage_ledger; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; PRAGMA user_version=7; PRAGMA journal_mode=DELETE'); old.close();
  const database = await readFile(join(f.directory, 'red.sqlite')), hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const assets = await Promise.all(paths.map(async path => { const data = await readFile(join(f.directory, path)); return { path, data: data.toString('base64'), sha256: hash(data) }; }));
  const manifest = { format: 'htc-workspace-backup', version: 1, source: { application: 'HTC', kind: 'local-workspace', databaseVersion: 7 }, retention: { amazonDays: 180, logDays: 365, dataOldestAt: null, expiresAt: null }, createdAt: new Date().toISOString(), database: database.toString('base64'), databaseSha256: hash(database), assets };
  const salt = randomBytes(16), iv = randomBytes(12), header = Buffer.concat([Buffer.from('HTC-BACKUP-1\n'), salt, iv]), key = scryptSync('version seven fixture passphrase', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header); const file = join(f.directory, 'legacy.htcbackup');
  await writeFile(file, Buffer.concat([header, cipher.update(gzipSync(Buffer.from(JSON.stringify(manifest)))), cipher.final(), cipher.getAuthTag()])); key.fill(0);
  const target = join(f.directory, 'legacy-restored'), prepared = await prepareWorkspaceRestore(target, file, 'version seven fixture passphrase'); await commitWorkspaceRestore(target, prepared);
  const db = openDatabase(target); try { const summary = new AiUsageLedger(db, () => new Date()).summary('deepseek'); assert.equal(summary.attempts, 1); assert.equal(summary.reportedTokens, 40); assert.equal(summary.usedTokens, 40); } finally { db.close(); }
});

test('usage backup rejects impossible states, mismatched days, secret policy fields and identity mismatch', async t => {
  const cases: ((record: any) => unknown)[] = [record => ({ ...record, state: ['REPORTED'] }), record => ({ ...record, day: '2000-01-01' }), record => ({ ...record, reservedTokens: -1 }), record => ({ ...record, state: 'PENDING' }), record => ({ ...record, state: 'UNKNOWN' }), record => ({ ...record, providerId: 'aliyun-ocr' })];
  for (const mutate of cases) {
    const f = await fixture(t); f.enable('deepseek'); await f.service.suggest(f.textInput); const db = openDatabase(f.directory), row = db.prepare('SELECT id,record_json FROM ai_usage_ledger').get()!;
    db.prepare('UPDATE ai_usage_ledger SET record_json=? WHERE id=?').run(JSON.stringify(mutate(JSON.parse(String(row.record_json)))), row.id); db.close();
    await assert.rejects(createWorkspaceBackup(f.directory, join(f.directory, 'bad.htcbackup'), 'strict usage fixture passphrase'));
  }
  for (const extra of [{ secret: 'disallowed' }, { id: 'deepseek-review' }, { updatedAt: 'not-a-date' }, { dailyCallLimit: 1.5 }]) {
    const f = await fixture(t); f.service.setUsagePolicy({ providerId: 'deepseek', dailyCallLimit: 1, dailyTokenLimit: null }); const db = openDatabase(f.directory), row = db.prepare('SELECT record_json FROM ai_usage_policies').get()!;
    db.prepare('UPDATE ai_usage_policies SET record_json=?').run(JSON.stringify({ ...JSON.parse(String(row.record_json)), ...extra })); db.close();
    await assert.rejects(createWorkspaceBackup(f.directory, join(f.directory, 'bad-policy.htcbackup'), 'strict usage fixture passphrase'));
  }
});

test('backup refuses unknown text attempts with an empty reservation instead of silently reopening quota', async t => {
  const f = await fixture(t, { fetch: async () => { throw Error('unknown'); } }); f.enable('deepseek'); await assert.rejects(f.service.suggest(f.textInput));
  const db = openDatabase(f.directory), row = db.prepare('SELECT id,record_json FROM ai_usage_ledger').get()!, record = JSON.parse(String(row.record_json));
  db.prepare('UPDATE ai_usage_ledger SET record_json=? WHERE id=?').run(JSON.stringify({ ...record, reservedTokens: 0 }), row.id); db.close();
  await assert.rejects(createWorkspaceBackup(f.directory, join(f.directory, 'empty-reservation.htcbackup'), 'empty reservation fixture passphrase'));
});
