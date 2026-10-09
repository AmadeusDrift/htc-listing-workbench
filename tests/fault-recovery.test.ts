import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AiCall } from '../src/shared/ai-contracts.ts';
import { AiUsageLedger } from '../src/main/ai/usage.ts';
import { openDatabase } from '../src/main/database.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { commitWorkspaceRestore, createWorkspaceBackup, prepareWorkspaceRestore, recoverInterruptedRestore } from '../src/main/backup.ts';

const at = '2026-09-30T12:00:00.000Z';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const passphrase = 'isolated fault recovery fixture';
const checkpoints = ['journal-written', 'old-files-moved', 'database-installed', 'assets-installed', 'complete-marked'] as const;
async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(resolve('.test-data/fault-recovery-'));
  t.after(async () => {
    const path = resolve(root), inside = relative(resolve('.test-data'), path);
    assert.ok(!inside.startsWith('..') && !inside.includes(sep) && inside.startsWith('fault-recovery-'));
    await rm(path, { recursive: true, force: true });
  });
  return root;
}
async function seed(directory: string, label: string) {
  const store = new WorkspaceStore(directory), product = store.createProduct(), assetId = randomUUID();
  const originalPath = `assets/${assetId}.png`, previewPath = `assets/${assetId}.preview.png`;
  await mkdir(join(directory, 'assets')); await writeFile(join(directory, originalPath), png); await writeFile(join(directory, previewPath), png);
  store.addAssets({ productId: product.id, revision: product.revision }, [{ id: assetId, fileName: `${label}.png`, mimeType: 'image/png', width: 1, height: 1, byteSize: png.length,
    originalPath, previewPath, sha256: createHash('sha256').update(png).digest('hex') }]);
  store.close();
  return { productId: product.id, assetId, originalPath, previewPath };
}
function call(productId: string): AiCall {
  return { id: randomUUID(), providerId: 'deepseek', productId, productRevision: 1, status: 'RUNNING', errorCode: null, requestId: null,
    model: 'deepseek-flash', generation: 1, startedAt: at, finishedAt: null, usage: { promptTokens: 0, completionTokens: 0, processedImages: 0 } };
}
function paidAttempt(db: DatabaseSync, productId: string): string {
  const ledger = new AiUsageLedger(db, () => new Date(at)), value = call(productId), usage = { promptTokens: 2, completionTokens: 3, processedImages: 0 };
  ledger.reserve(value, '{"max_tokens":4096}'); ledger.settle(value.id, true, usage, at);
  db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({ ...value, status: 'SUCCEEDED', usage, finishedAt: at }), value.id);
  return value.id;
}
async function preparedFixture(root: string) {
  const sourceRoot = join(root, 'source'), targetRoot = join(root, 'target');
  const source = await seed(sourceRoot, 'source'), target = await seed(targetRoot, 'target');
  await writeFile(join(targetRoot, 'assets', 'unregistered-original.txt'), 'preserve on rollback');
  await mkdir(join(targetRoot, 'ai-vault')); await writeFile(join(targetRoot, 'ai-vault', 'private-fixture'), 'local secret remains outside replacement');
  const db = openDatabase(targetRoot), ledger = new AiUsageLedger(db, () => new Date(at));
  ledger.setPolicy({ providerId: 'deepseek', dailyCallLimit: 10, dailyTokenLimit: null });
  const attempts = [paidAttempt(db, target.productId)];
  db.prepare('INSERT INTO amazon_write_locks VALUES(?,?,?,?)').run('fault-safety-lock', randomUUID(), 'UNKNOWN', at); db.close();
  const archive = join(root, 'source.htcbackup');
  await createWorkspaceBackup(sourceRoot, archive, passphrase);
  const prepared = await prepareWorkspaceRestore(targetRoot, archive, passphrase);
  const latest = openDatabase(targetRoot);
  attempts.push(paidAttempt(latest, target.productId));
  new AiUsageLedger(latest, () => new Date(at)).setPolicy({ providerId: 'deepseek', dailyCallLimit: 3, dailyTokenLimit: null });
  latest.prepare('INSERT INTO amazon_write_locks VALUES(?,?,?,?)').run('fault-after-prepare-lock', randomUUID(), 'UNKNOWN', at); latest.close();
  await writeFile(join(root, 'prepared.json'), JSON.stringify(prepared));
  return { source, target, sourceRoot, targetRoot, attempts, prepared };
}
function child(root: string, mode: 'restore' | 'lock', point = '') {
  const worker = spawn(process.execPath, ['tests/fixtures/fault-child.ts', root, mode, point], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  worker.stdout!.on('data', data => { output += data; }); worker.stderr!.on('data', data => { output += data; });
  const timer = setTimeout(() => { worker.kill(); }, 18000);
  const finished = new Promise<{ code: number | null; output: string }>((resolveChild, reject) => {
    worker.once('error', cause => { clearTimeout(timer); reject(cause); });
    worker.once('exit', code => { clearTimeout(timer); resolveChild({ code, output }); });
  });
  return { process: worker, finished };
}

test('actual process exits at all restore boundaries recover one complete workspace and retain newer safety history', async t => {
  for (const point of checkpoints) await t.test(point, async t => {
    const root = await fixture(t), f = await preparedFixture(root), running = child(root, 'restore', point);
    const result = await running.finished; assert.equal(result.code, 73, result.output);
    assert.ok((await readdir(f.targetRoot)).includes('.restore-journal.json'));
    const complete = point === 'complete-marked';
    assert.equal(await recoverInterruptedRestore(f.targetRoot), complete ? 'completed' : 'rolled-back');
    assert.equal(await recoverInterruptedRestore(f.targetRoot), null);
    const expected = complete ? f.source : f.target, unexpected = complete ? f.target : f.source;
    const store = new WorkspaceStore(f.targetRoot);
    try {
      assert.deepEqual(store.listProducts().map(product => product.id), [expected.productId]);
      assert.deepEqual(store.getProduct(expected.productId).assets.map(asset => asset.id), [expected.assetId]);
      assert.throws(() => store.getProduct(unexpected.productId));
    } finally { store.close(); }
    for (const path of [expected.originalPath, expected.previewPath]) assert.deepEqual(await readFile(join(f.targetRoot, path)), png);
    if (!complete) assert.equal(await readFile(join(f.targetRoot, 'assets', 'unregistered-original.txt'), 'utf8'), 'preserve on rollback');
    assert.equal(await readFile(join(f.targetRoot, 'ai-vault', 'private-fixture'), 'utf8'), 'local secret remains outside replacement');
    const restored = openDatabase(f.targetRoot);
    try {
      const summary = new AiUsageLedger(restored, () => new Date(at)).summary('deepseek');
      assert.equal(summary.attempts, 2); assert.equal(summary.reportedTokens, 10); assert.equal(summary.policy.dailyCallLimit, 3);
      assert.deepEqual(restored.prepare('SELECT id FROM ai_usage_ledger').all().map(row => row.id).sort(), [...f.attempts].sort());
      assert.equal(restored.prepare("SELECT state FROM amazon_write_locks WHERE listing_hash='fault-safety-lock'").get()!.state, 'UNKNOWN');
      assert.equal(restored.prepare("SELECT state FROM amazon_write_locks WHERE listing_hash='fault-after-prepare-lock'").get()!.state, 'UNKNOWN');
    } finally { restored.close(); }
    assert.equal((await readdir(f.targetRoot)).some(name => name.startsWith('.restore-')), false);
  });
});

test('a real staged-assets rename failure rolls back installed database and preserves original files', async t => {
  const root = await fixture(t), f = await preparedFixture(root), withheld = join(root, 'withheld-staged-assets');
  let obstruction = false;
  await assert.rejects(commitWorkspaceRestore(f.targetRoot, f.prepared, async point => {
    if (point === 'database-installed') {
      await rename(join(f.prepared.stagingDirectory, 'assets'), withheld); obstruction = true;
    }
  }));
  assert.equal(obstruction, true, 'The real filesystem obstruction must execute');
  assert.equal(await recoverInterruptedRestore(f.targetRoot), null, 'in-process rollback already completed');
  const store = new WorkspaceStore(f.targetRoot);
  try { assert.deepEqual(store.listProducts().map(product => product.id), [f.target.productId]); }
  finally { store.close(); }
  assert.deepEqual(await readFile(join(f.targetRoot, f.target.originalPath)), png);
  assert.equal(await readFile(join(f.targetRoot, 'assets', 'unregistered-original.txt'), 'utf8'), 'preserve on rollback');
  assert.deepEqual(await readFile(join(withheld, f.source.originalPath.slice('assets/'.length))), png);
  assert.equal((await readdir(f.targetRoot)).some(name => name.startsWith('.restore-')), false);
});

test('actual SQLite writer contention reserves nothing while locked and succeeds once after release', async t => {
  const root = await fixture(t), target = join(root, 'target'), product = await seed(target, 'lock');
  const db = openDatabase(target), ledger = new AiUsageLedger(db, () => new Date(at)); db.exec('PRAGMA busy_timeout=50');
  ledger.setPolicy({ providerId: 'deepseek', dailyCallLimit: 1, dailyTokenLimit: null });
  const running = child(root, 'lock');
  try {
    await Promise.race([
      new Promise<void>(resolveLock => running.process.once('message', message => { assert.deepEqual(message, { locked: true }); resolveLock(); })),
      running.finished.then(result => { throw new Error(`Lock child exited before handshake (${result.code}): ${result.output}`); }),
    ]);
    const value = call(product.productId);
    assert.throws(() => ledger.reserve(value, '{"max_tokens":4096}'), cause => {
      return typeof cause === 'object' && cause !== null && 'errcode' in cause && typeof cause.errcode === 'number' && (cause.errcode & 255) === 5;
    });
    assert.equal(db.isTransaction, false);
    assert.equal(ledger.summary('deepseek').attempts, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_calls').get()!.n, 0);
    running.process.send({ release: true });
    const result = await running.finished; assert.equal(result.code, 0, result.output);
    ledger.reserve(value, '{"max_tokens":4096}');
    assert.equal(ledger.summary('deepseek').attempts, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_calls').get()!.n, 1);
    assert.throws(() => ledger.reserve(call(product.productId), '{"max_tokens":4096}'), /QUOTA|额度|上限/);
    assert.equal(ledger.summary('deepseek').attempts, 1);
    assert.equal(db.isTransaction, false);
  } finally { running.process.kill(); await running.finished; db.close(); }
});
