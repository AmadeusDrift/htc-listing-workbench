import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase, SCHEMA_VERSION } from '../src/main/database.ts';
import { ImageVersionService } from '../src/main/image-versions/service.ts';
import type { ImageVersionDependencies } from '../src/main/image-versions/service.ts';
import type { ImageVersion } from '../src/shared/image-version-contracts.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { candidate, hash, removeTestRoot, seedImage, testRoot } from './fixtures/image-write-fixture.ts';
import { dropRecordQueryIndexes } from './helpers/legacy-schema.ts';

async function fixture(t: test.TestContext) {
  const root = await testRoot(), f = await seedImage(root), services: ImageVersionService[] = [];
  t.after(async () => { for (const service of services) await service.close(); f.store.close(); await removeTestRoot(root); });
  return { ...f, start(deps: Partial<ImageVersionDependencies> = {}) {
    const service = new ImageVersionService(root, f.store, { listResults: () => [f.result] }, { decode: f.decode, download: async () => { throw Error('Recovery must not download'); }, ...deps });
    services.push(service); return service;
  } };
}
function intent(root: string, version: ImageVersion) {
  const db = openDatabase(root);
  try { db.prepare('INSERT INTO image_write_operations VALUES(?,?)').run(version.id, JSON.stringify({ id: version.id, candidate: version,
    state: 'WRITING', code: 'WRITE_INTENT', createdAt: version.createdAt, updatedAt: version.createdAt })); }
  finally { db.close(); }
}
async function files(root: string, version: ImageVersion, original: Buffer, preview: Buffer) {
  await writeFile(join(root, version.originalPath), original); await writeFile(join(root, version.previewPath), preview);
}
function runCrash(root: string, point: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['tests/fixtures/image-write-crash.ts', root, point], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => { child.kill(); reject(Error('Crash fixture timed out')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); resolveRun({ code, output }); });
  });
}

test('real process exits recover intent, first file, both files and committed version without downloading', async t => {
  for (const point of ['intent', 'original-written', 'preview-written', 'committed']) await t.test(point, async t => {
    const root = await testRoot(); t.after(() => removeTestRoot(root));
    const child = await runCrash(root, point); assert.equal(child.code, 73, child.output);
    const interrupted = openDatabase(root);
    try {
      const operation = JSON.parse(String(interrupted.prepare('SELECT record_json FROM image_write_operations').get()!.record_json));
      assert.equal(operation.state, point === 'committed' ? 'COMMITTED' : 'WRITING');
      assert.equal(interrupted.prepare('SELECT COUNT(*) AS n FROM image_versions').get()!.n, point === 'committed' ? 1 : 0);
    } finally { interrupted.close(); }
    assert.equal((await readdir(join(root, 'assets'))).length, point === 'intent' ? 2 : point === 'original-written' ? 3 : 4);
    const context = JSON.parse(await readFile(join(root, 'context.json'), 'utf8')), store = new WorkspaceStore(root);
    let downloads = 0;
    const service = new ImageVersionService(root, store, { listResults: () => [context.result] }, {
      decode: () => { throw Error('Recovery must not decode'); }, download: async () => { downloads++; throw Error('Recovery must not download'); },
    });
    try {
      const committed = point === 'committed', versions = service.list(context.product.id), report = service.recoveryStatus();
      assert.equal(versions.length, committed ? 1 : 0); assert.equal(report.total, 1);
      assert.equal(report.items[0].state, committed ? 'COMMITTED' : 'CLEANED');
      assert.equal((await readdir(join(root, 'assets'))).length, committed ? 4 : 2);
      assert.deepEqual(await readFile(join(root, context.asset.originalPath)), await readFile(join(root, 'fixture.png')));
      assert.deepEqual(service.recover(), report); assert.deepEqual(service.recover(), report);
      if (committed) assert.deepEqual(await service.save(context.input), versions[0]);
      assert.equal(downloads, 0);
      const db = openDatabase(root);
      try { assert.doesNotMatch(String(db.prepare('SELECT record_json FROM image_write_operations').get()!.record_json), /SECRET_SENTINEL|Signature|https|imageUrl/); }
      finally { db.close(); }
    } finally { await service.close(); store.close(); }
  });
});

test('schema v6 gains the strict write journal while preserving prior version bytes and rows', async t => {
  const f = await fixture(t), version = candidate(f), db = openDatabase(f.root);
  await files(f.root, version, f.output, f.bytes);
  db.prepare('INSERT INTO image_versions VALUES(?,?)').run(version.id, JSON.stringify(version));
  dropRecordQueryIndexes(db);
  db.exec('DROP TABLE IF EXISTS ai_usage_ledger; DROP TABLE IF EXISTS ai_usage_policies; DROP TABLE IF EXISTS image_write_operations; DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS source_image_provenance; DROP TABLE IF EXISTS source_consistency_attempts; DROP TABLE IF EXISTS source_consistency_assessments; DROP TABLE IF EXISTS source_consistency_decisions; DROP TABLE IF EXISTS source_consistency_bindings; DROP TABLE IF EXISTS listing_correction_attempts; DROP TABLE IF EXISTS listing_corrections; ALTER TABLE amazon_write_locks DROP COLUMN owner_kind; ALTER TABLE amazon_write_locks DROP COLUMN owner_id; DROP TABLE IF EXISTS module_migration_journal; PRAGMA user_version=6'); db.close();
  const upgraded = openDatabase(f.root);
  try {
    assert.equal(SCHEMA_VERSION, 22); assert.equal(upgraded.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM image_write_operations').get()!.n, 0);
    const columns = upgraded.prepare('PRAGMA table_xinfo(image_write_operations)').all();
    assert.deepEqual(columns.map(c => [c.name, c.type, c.notnull, c.pk]), [['id', 'TEXT', 1, 1], ['record_json', 'TEXT', 1, 0]]);
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM assets').get()!.n, 1);
    assert.equal(upgraded.prepare('SELECT record_json FROM image_versions WHERE id=?').get(version.id)!.record_json, JSON.stringify(version));
  } finally { upgraded.close(); }
  assert.deepEqual(await readFile(join(f.root, f.asset.originalPath)), f.bytes);
  assert.deepEqual(await readFile(join(f.root, version.originalPath)), f.output);
});

test('partial and hash-mismatched candidates remain intact and need attention without sweeping unrelated files', async t => {
  for (const kind of ['partial', 'hash']) await t.test(kind, async t => {
    const f = await fixture(t), version = candidate(f); intent(f.root, version);
    const damaged = kind === 'partial' ? f.output.subarray(0, 12) : Buffer.alloc(f.output.length, 11);
    await files(f.root, version, damaged, f.bytes);
    const unrelated = join(f.root, `assets/${randomUUID()}.png`); await writeFile(unrelated, Buffer.from('unknown'));
    const service = f.start(), status = service.recoveryStatus();
    assert.equal(status.counts.NEEDS_ATTENTION, 1); assert.equal(status.items[0].code, 'CONTENT_MISMATCH');
    assert.deepEqual(await readFile(join(f.root, version.originalPath)), damaged);
    assert.deepEqual(await readFile(join(f.root, version.previewPath)), f.bytes);
    assert.equal(await readFile(unrelated, 'utf8'), 'unknown'); assert.deepEqual(service.recover(), status);
  });
});

test('registered originals and every historical version protect their paths even when a pending record borrows them', async t => {
  const f = await fixture(t), borrowed = { ...candidate(f, f.asset.id), byteSize: f.bytes.length, sha256: hash(f.bytes) };
  intent(f.root, borrowed);
  const service = f.start({ download: async () => f.output });
  assert.equal(service.recoveryStatus().items[0].code, 'REGISTERED_PATH');
  assert.deepEqual(await readFile(join(f.root, f.asset.originalPath)), f.bytes);
  const history = await service.save(f.input); await service.close();
  const db = openDatabase(f.root);
  try {
    db.prepare('DELETE FROM image_write_operations WHERE id=?').run(history.id);
    const conflicting = { ...history, resultId: randomUUID() };
    db.prepare('INSERT INTO image_write_operations VALUES(?,?)').run(history.id, JSON.stringify({ id: history.id, candidate: conflicting,
      state: 'WRITING', code: 'WRITE_INTENT', createdAt: history.createdAt, updatedAt: history.createdAt }));
  } finally { db.close(); }
  const reopened = f.start(); assert.equal(reopened.recoveryStatus().counts.NEEDS_ATTENTION, 2);
  assert.deepEqual(await readFile(join(f.root, history.originalPath)), f.output);
  assert.equal(reopened.list(f.product.id).length, 1);
});

test('a pending record already registered with the exact candidate becomes committed without rewriting files', async t => {
  const f = await fixture(t), version = candidate(f); intent(f.root, version); await files(f.root, version, f.output, f.bytes);
  const db = openDatabase(f.root); db.prepare('INSERT INTO image_versions VALUES(?,?)').run(version.id, JSON.stringify(version)); db.close();
  const service = f.start(); assert.equal(service.recoveryStatus().counts.COMMITTED, 1);
  assert.deepEqual(await service.save(f.input), version); assert.equal(service.list(f.product.id).length, 1);
});

test('junctions out of the asset directory are retained for attention without touching their target', async t => {
  const f = await fixture(t), version = candidate(f), outside = await testRoot(); intent(f.root, version);
  t.after(() => removeTestRoot(outside)); await writeFile(join(outside, 'sentinel'), 'preserved');
  await symlink(outside, join(f.root, version.originalPath), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(f.root, version.previewPath), f.bytes);
  const service = f.start(); assert.equal(service.recoveryStatus().items[0].code, 'UNSAFE_PATH');
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'preserved');
  assert.deepEqual(await readFile(join(f.root, version.previewPath)), f.bytes);
  await unlink(join(f.root, version.originalPath));
});

test('ordinary write failure uses recovery and preserves unknown collisions; errors never enter journal', async t => {
  const f = await fixture(t); let pending!: ImageVersion;
  const service = f.start({ download: async () => f.output, checkpoint: async (point, version) => {
    if (point === 'intent') { pending = version; await mkdir(join(f.root, version.previewPath)); }
  } });
  await assert.rejects(service.save(f.input)); assert.equal(service.list(f.product.id).length, 0);
  assert.equal(service.recoveryStatus().items[0].state, 'NEEDS_ATTENTION');
  assert.deepEqual(await readFile(join(f.root, pending.originalPath)), f.output);
  assert.deepEqual(await readFile(join(f.root, f.asset.originalPath)), f.bytes);
});

test('an exception before commit cleans matching files, while an exception after commit preserves them', async t => {
  for (const point of ['original-written', 'committed']) await t.test(point, async t => {
    const f = await fixture(t), service = f.start({ download: async () => f.output, checkpoint: at => { if (at === point) throw Error('SECRET_SENTINEL private disk message'); } });
    await assert.rejects(service.save(f.input));
    assert.equal(service.recoveryStatus().items[0].state, point === 'committed' ? 'COMMITTED' : 'CLEANED');
    assert.equal(service.list(f.product.id).length, point === 'committed' ? 1 : 0);
    assert.equal((await readdir(join(f.root, 'assets'))).length, point === 'committed' ? 4 : 2);
    assert.doesNotMatch(JSON.stringify(service.recoveryStatus()), /SECRET_SENTINEL|private disk/);
  });
});

test('diagnostic recovery output is bounded and never returns candidate content or remote URLs', async t => {
  const f = await fixture(t); for (let i = 0; i < 4; i++) intent(f.root, candidate(f));
  const service = f.start(), report = service.recoveryStatus(2);
  assert.equal(report.total, 4); assert.equal(report.items.length, 2); assert.equal(report.counts.CLEANED, 4);
  assert.deepEqual(Object.keys(report.items[0]).sort(), ['code', 'createdAt', 'id', 'state', 'updatedAt']);
  assert.throws(() => service.recoveryStatus(101)); assert.throws(() => service.recoveryStatus(0));
});

test('backup excludes unfinished files and restore does not promote pending candidates', async t => {
  const f = await fixture(t), version = candidate(f); intent(f.root, version); await files(f.root, version, f.output, f.bytes);
  const archive = join(f.root, 'pending.htcbackup'), target = join(f.root, 'restored');
  await createWorkspaceBackup(f.root, archive, 'image recovery backup phrase');
  const prepared = await prepareWorkspaceRestore(target, archive, 'image recovery backup phrase'); await commitWorkspaceRestore(target, prepared);
  assert.equal((await readdir(join(target, 'assets'))).length, 2);
  const restoredStore = new WorkspaceStore(target), service = new ImageVersionService(target, restoredStore, { listResults: () => [] }, { decode: f.decode, download: async () => { throw Error('No network'); } });
  try { assert.equal(service.list(f.product.id).length, 0); assert.equal(service.recoveryStatus().counts.CLEANED, 1); }
  finally { await service.close(); restoredStore.close(); }
  assert.deepEqual(await readFile(join(f.root, version.originalPath)), f.output);
});

test('backup validates journal states, secrets, identity, paths and table structure strictly', async t => {
  const f = await fixture(t), version = candidate(f); intent(f.root, version);
  const db = openDatabase(f.root), saved = String(db.prepare('SELECT record_json FROM image_write_operations').get()!.record_json), record = JSON.parse(saved);
  try {
    const invalid = [ { ...record, secret: 'SECRET_SENTINEL' }, { ...record, state: 'SUCCEEDED' }, { ...record, code: 'arbitrary error' },
      { ...record, id: randomUUID() }, { ...record, candidate: { ...version, originalPath: '../unsafe.png' } },
      { ...record, candidate: null }, { ...record, state: 'COMMITTED', code: 'VERSION_COMMITTED' } ];
    for (let i = 0; i < invalid.length; i++) {
      db.prepare('UPDATE image_write_operations SET record_json=?').run(JSON.stringify(invalid[i]));
      await assert.rejects(createWorkspaceBackup(f.root, join(f.root, `invalid-${i}.htcbackup`), 'image recovery backup phrase'));
    }
    db.prepare('UPDATE image_write_operations SET record_json=?').run(saved);
    db.exec('ALTER TABLE image_write_operations ADD COLUMN secret TEXT');
    await assert.rejects(createWorkspaceBackup(f.root, join(f.root, 'invalid-table.htcbackup'), 'image recovery backup phrase'));
  } finally { db.close(); }
});

test('malformed journal records retain all files and expose only a safe attention record', async t => {
  const f = await fixture(t), version = candidate(f); intent(f.root, version); await files(f.root, version, f.output, f.bytes);
  const db = openDatabase(f.root); db.prepare('UPDATE image_write_operations SET record_json=?').run('{"imageUrl":"SECRET_SENTINEL"}'); db.close();
  const service = f.start(), report = service.recoveryStatus();
  assert.equal(report.counts.NEEDS_ATTENTION, 1); assert.equal(report.items[0].code, 'INVALID_RECORD');
  assert.doesNotMatch(JSON.stringify(report), /SECRET_SENTINEL/);
  assert.deepEqual(await readFile(join(f.root, version.originalPath)), f.output); assert.deepEqual(service.recover(), report);
});

test('failed terminal journal updates roll back version registration and keep a durable intent for restart', async t => {
  const f = await fixture(t), db = openDatabase(f.root);
  db.exec("CREATE TRIGGER fail_image_finish BEFORE UPDATE ON image_write_operations BEGIN SELECT RAISE(FAIL, 'SECRET_SENTINEL'); END");
  const service = f.start({ download: async () => f.output });
  try {
    await assert.rejects(service.save(f.input)); assert.equal(service.list(f.product.id).length, 0);
    assert.equal(service.recoveryStatus().counts.WRITING, 1);
    assert.doesNotMatch(String(db.prepare('SELECT record_json FROM image_write_operations').get()!.record_json), /SECRET_SENTINEL/);
    db.exec('DROP TRIGGER fail_image_finish');
  } finally { db.close(); await service.close(); }
  const reopened = f.start(); assert.equal(reopened.recoveryStatus().counts.CLEANED, 1);
  assert.equal(reopened.list(f.product.id).length, 0); assert.deepEqual(await readFile(join(f.root, f.asset.originalPath)), f.bytes);
});

test('an asset-directory junction installed after intent cannot cause a write outside the managed assets', async t => {
  const f = await fixture(t), outside = await testRoot(), originalAssets = join(f.root, 'original-assets');
  t.after(() => removeTestRoot(outside));
  const service = f.start({ download: async () => f.output, checkpoint: async point => {
    if (point === 'intent') {
      await rename(join(f.root, 'assets'), originalAssets);
      await symlink(outside, join(f.root, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    }
  } });
  try {
    await assert.rejects(service.save(f.input));
    assert.deepEqual(await readdir(outside), []);
    assert.equal(service.recoveryStatus().items[0].state, 'NEEDS_ATTENTION');
    assert.deepEqual(await readFile(join(originalAssets, f.asset.originalPath.slice('assets/'.length))), f.bytes);
  } finally { await unlink(join(f.root, 'assets')); }
});

test('a file changed after its durable write is preserved for attention and never registered as a version', async t => {
  const f = await fixture(t); let pending!: ImageVersion;
  const changed = Buffer.alloc(f.output.length, 7);
  const service = f.start({ download: async () => f.output, checkpoint: async (point, version) => {
    if (point === 'preview-written') { pending = version; await writeFile(join(f.root, version.originalPath), changed); }
  } });
  await assert.rejects(service.save(f.input));
  assert.equal(service.list(f.product.id).length, 0); assert.equal(service.recoveryStatus().items[0].code, 'CONTENT_MISMATCH');
  assert.deepEqual(await readFile(join(f.root, pending.originalPath)), changed);
  assert.deepEqual(await readFile(join(f.root, pending.previewPath)), f.bytes);
});
