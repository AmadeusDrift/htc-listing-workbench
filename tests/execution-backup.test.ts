import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { validateExecutionTask } from '../src/main/execution/records.ts';

function fixture(t: test.TestContext) {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'execution-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
const profile = { id: 'alpha', name: 'Alpha', host: 'ftp.example.com', port: 2121, secure: false, remoteRoot: '/', publicBaseUrl: 'https://images.example.com/AAA/', enabled: true, configured: true, generation: 1 };
function task() {
  const id = randomUUID(), now = new Date().toISOString();
  return { id, revision: 1, status: 'RUNNING', profileId: 'alpha', profileGeneration: 1, profileStamp: 'a'.repeat(64), createdAt: now, updatedAt: now, error: null,
    items: [{ draftId: randomUUID(), productId: randomUUID(), variantId: randomUUID(), productRevision: 1, sku: 'TEST-SKU', targetId: randomUUID(), targetName: 'Demo', sellerId: 'TEST', marketplaceId: 'ATVPDKIKX0DER', mode: 'demo', targetStamp: 'b'.repeat(64), schemaHash: 'c'.repeat(64), attributesHash: 'd'.repeat(64), intendedAttributesHash: null, draftRevision: 1, assets: [{ id: randomUUID(), role: 'main', sha256: 'e'.repeat(64) }], uploads: [], status: 'RUNNING', listingState: null, submitStarted: false,
      steps: ['upload','images','validate','preview','submit','readback'].map(name => ({ name, status: 'PENDING', attempts: 0, error: null })) }] };
}
test('v4 encrypted restore disables FTP, excludes its vault, and pauses pending execution', async t => {
  const root = fixture(t), source = join(root, 'source'), target = join(root, 'target'), file = join(root, 'backup.htcbackup');
  const db = openDatabase(source), running = task();
  db.prepare('INSERT INTO hosting_profiles VALUES(?,?)').run(profile.id, JSON.stringify(profile));
  db.prepare('INSERT INTO execution_tasks VALUES(?,?)').run(running.id, JSON.stringify(running)); db.close();
  mkdirSync(join(source, 'hosting-vault')); writeFileSync(join(source, 'hosting-vault', 'alpha.bin'), 'SECRET_NOT_BACKED_UP');
  await createWorkspaceBackup(source, file, 'sufficient test password');
  await commitWorkspaceRestore(target, await prepareWorkspaceRestore(target, file, 'sufficient test password'));
  const restored = openDatabase(target);
  try {
    const p = JSON.parse(String(restored.prepare('SELECT record_json FROM hosting_profiles').get()!.record_json));
    const job = JSON.parse(String(restored.prepare('SELECT record_json FROM execution_tasks').get()!.record_json));
    assert.equal(p.configured, false); assert.equal(p.enabled, false); assert.ok(p.generation > 1); assert.equal(job.status, 'PAUSED');
    assert.equal(validateExecutionTask(job).concurrency, 1);
    assert.equal(existsSync(join(target, 'hosting-vault')), false);
  } finally { restored.close(); }
});
test('backup rejects credential fields hidden in a hosting profile record', async t => {
  const root = fixture(t), source = join(root, 'source'); const db = openDatabase(source);
  db.prepare('INSERT INTO hosting_profiles VALUES(?,?)').run('alpha', JSON.stringify({ ...profile, password: 'MUST_NOT_EXPORT' })); db.close();
  await assert.rejects(createWorkspaceBackup(source, join(root, 'backup.htcbackup'), 'sufficient test password'));
});
test('v4 backup rejects extra unique constraints that could replace task records', async t => {
  const root = fixture(t), source = join(root, 'source'); const db = openDatabase(source);
  db.exec('DROP TABLE execution_tasks; CREATE TABLE execution_tasks(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL UNIQUE ON CONFLICT REPLACE)'); db.close();
  await assert.rejects(createWorkspaceBackup(source, join(root, 'backup.htcbackup'), 'sufficient test password'));
});

test('v4 backup rejects WITHOUT ROWID tables that would make services fail on restart', async t => {
  const root = fixture(t), source = join(root, 'source'); const db = openDatabase(source);
  db.exec('DROP TABLE execution_tasks; CREATE TABLE execution_tasks(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL) WITHOUT ROWID'); db.close();
  await assert.rejects(createWorkspaceBackup(source, join(root, 'backup.htcbackup'), 'sufficient test password'));
});

test('backup preserves every supported SKU concurrency setting while restoring jobs as paused', async t => {
  const root = fixture(t);
  for (const concurrency of [1, 3, 5]) {
    const source = join(root, `source-${concurrency}`), target = join(root, `target-${concurrency}`), file = join(root, `parallel-${concurrency}.htcbackup`);
    const running = { ...task(), concurrency }, db = openDatabase(source);
    db.prepare('INSERT INTO execution_tasks VALUES(?,?)').run(running.id, JSON.stringify(running)); db.close();
    await createWorkspaceBackup(source, file, 'parallel backup fixture passphrase');
    await commitWorkspaceRestore(target, await prepareWorkspaceRestore(target, file, 'parallel backup fixture passphrase'));
    const restored = openDatabase(target);
    try {
      const job = validateExecutionTask(JSON.parse(String(restored.prepare('SELECT record_json FROM execution_tasks').get()!.record_json)));
      assert.equal(job.concurrency, concurrency); assert.equal(job.status, 'PAUSED'); assert.deepEqual(job.items, running.items);
    } finally { restored.close(); }
  }
});

test('backup rejects invalid concurrency records instead of silently substituting a higher worker count', async t => {
  const root = fixture(t);
  for (const [index, concurrency] of [0, 2, 4, 6, 3.5, '3', null, true].entries()) {
    const source = join(root, `invalid-${index}`), file = join(root, `invalid-${index}.htcbackup`), invalid = { ...task(), concurrency }, db = openDatabase(source);
    db.prepare('INSERT INTO execution_tasks VALUES(?,?)').run(invalid.id, JSON.stringify(invalid)); db.close();
    await assert.rejects(createWorkspaceBackup(source, file, 'parallel backup fixture passphrase'));
    assert.equal(existsSync(file), false);
  }
});
