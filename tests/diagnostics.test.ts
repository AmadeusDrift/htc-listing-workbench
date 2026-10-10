import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/main/store.ts';
import { createLocalDiagnosticReport } from '../src/main/diagnostics/service.ts';
import type { DiagnosticContext } from '../src/main/diagnostics/service.ts';
import { installDiagnosticsIpc } from '../src/main/diagnostics-ipc.ts';
import type { IpcHandler } from '../src/main/amazon-ipc.ts';

const sentinel = 'SENSITIVE_TITLE_COOKIE_TOKEN_URL_HOST_USER_ERROR';
const context = { appVersion: '0.5.0-rc.1', runtime: { nodeMajor: 24, electronMajor: 44 }, services: { aiBusy: false, imageWritesBusy: true, executionBusy: false } };
async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(resolve('.test-data/diagnostics-'));
  t.after(async () => {
    const child = relative(resolve('.test-data'), root);
    assert.ok(child.startsWith('diagnostics-') && !child.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, 'workspace'), store = new WorkspaceStore(directory), product = store.createProduct(); store.close();
  return { root, directory, product };
}

test('the read-only report projects fixed fields and never exports arbitrary stored strings', async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.directory, 'red.sqlite')), operationId = randomUUID();
  db.prepare('UPDATE products SET title=?,source_url=?,description=?').run(sentinel, `https://${sentinel}.test/?token=${sentinel}`, sentinel);
  db.prepare('INSERT INTO image_write_operations VALUES(?,?)').run(operationId, JSON.stringify({ id: operationId, state: 'NEEDS_ATTENTION', code: 'IO_ERROR', candidate: { path: `C:/${sentinel}`, apiKey: sentinel }, createdAt: sentinel, updatedAt: sentinel }));
  db.prepare('INSERT INTO image_write_operations VALUES(?,?)').run(sentinel, `{invalid-${sentinel}`);
  db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(randomUUID(), JSON.stringify({ error: sentinel, rawResponse: sentinel }));
  db.close();
  const before = await readFile(join(f.directory, 'red.sqlite')), files = await readdir(f.directory);
  const report = await createLocalDiagnosticReport(f.directory, context);
  assert.equal(report.appVersion, '0.5.0-rc.1'); assert.equal(report.counts.products, 1); assert.equal(report.counts.aiCalls, 1);
  assert.deepEqual(report.services, context.services); assert.equal(report.recovery.total, 2); assert.equal(report.recovery.invalid, 1);
  assert.deepEqual(report.recovery.items, [{ operationId, state: 'NEEDS_ATTENTION', code: 'IO_ERROR' }]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${sentinel}|https:|C:|rawResponse|candidate|originalPath|previewPath`));
  assert.equal(new Date(report.generatedAt).toISOString(), report.generatedAt);
  assert.deepEqual(await readFile(join(f.directory, 'red.sqlite')), before);
  // SQLite itself may create WAL/SHM coordination files even for SQLITE_OPEN_READONLY.
  assert.deepEqual((await readdir(f.directory)).filter(name => !['red.sqlite-wal', 'red.sqlite-shm'].includes(name)), files);
});

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function addAsset(f: Awaited<ReturnType<typeof fixture>>, original = Buffer.from('original'), preview = Buffer.from('preview')) {
  const id = randomUUID(), originalPath = `assets/${id}.png`, previewPath = `assets/${id}.preview.png`;
  await mkdir(join(f.directory, 'assets'), { recursive: true });
  await writeFile(join(f.directory, originalPath), original); await writeFile(join(f.directory, previewPath), preview);
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try { db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, f.product.id, sentinel, 'gallery', 'image/png', 256, 256, original.length, originalPath, previewPath, hash(original), new Date().toISOString()); }
  finally { db.close(); }
  return { id, originalPath, previewPath, original, preview };
}

test('original previews are readable but unverified; image-version files use their own two hashes', async t => {
  const f = await fixture(t), asset = await addAsset(f), id = randomUUID(), originalPath = `assets/${id}.png`, previewPath = `assets/${id}.preview.png`;
  const original = Buffer.from('version original'), preview = Buffer.from('version preview');
  await writeFile(join(f.directory, originalPath), original); await writeFile(join(f.directory, previewPath), preview);
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  db.prepare('INSERT INTO image_versions VALUES(?,?)').run(id, JSON.stringify({ id, originalPath, previewPath, byteSize: original.length, previewByteSize: preview.length, sha256: hash(original), previewSha256: hash(preview), raw: sentinel })); db.close();
  const report = await createLocalDiagnosticReport(f.directory, context);
  assert.equal(report.assets.total, 4); assert.equal(report.assets.inspected, 4); assert.equal(report.assets.truncated, false);
  assert.deepEqual(report.assets.items, [
    { recordId: asset.id, kind: 'ASSET_ORIGINAL', status: 'VERIFIED' }, { recordId: asset.id, kind: 'ASSET_PREVIEW', status: 'READABLE_UNVERIFIED' },
    { recordId: id, kind: 'IMAGE_VERSION_ORIGINAL', status: 'VERIFIED' }, { recordId: id, kind: 'IMAGE_VERSION_PREVIEW', status: 'VERIFIED' },
  ]);
  await writeFile(join(f.directory, previewPath), Buffer.alloc(preview.length, 65));
  assert.equal((await createLocalDiagnosticReport(f.directory, context)).assets.items[3].status, 'CONTENT_MISMATCH');
});

test('missing, truncated and changed assets are reported without repair', async t => {
  const f = await fixture(t), asset = await addAsset(f);
  await unlink(join(f.directory, asset.previewPath)); await writeFile(join(f.directory, asset.originalPath), Buffer.from('bad'));
  const report = await createLocalDiagnosticReport(f.directory, context);
  assert.deepEqual(report.assets.items.map(item => item.status), ['CONTENT_MISMATCH', 'MISSING']);
  assert.equal(await readFile(join(f.directory, asset.originalPath), 'utf8'), 'bad');
  await writeFile(join(f.directory, asset.originalPath), asset.original);
  const probe = await open(join(f.directory, asset.originalPath), 'r'), prototype = Object.getPrototypeOf(probe), read = probe.read; await probe.close();
  let changed = false;
  t.mock.method(prototype, 'read', async function (this: Awaited<ReturnType<typeof open>>, ...args: Parameters<typeof read>) {
    const result = await Reflect.apply(read, this, args);
    if (!changed) { changed = true; await writeFile(join(f.directory, asset.originalPath), Buffer.alloc(asset.original.length, 66)); }
    return result;
  });
  assert.equal((await createLocalDiagnosticReport(f.directory, context)).assets.items[0].status, 'CHANGED_DURING_READ');
});

test('hardlinks and junctions are rejected before reading target bytes', async t => {
  const f = await fixture(t), asset = await addAsset(f), outside = join(f.root, 'outside'); await mkdir(outside);
  const target = join(outside, 'sentinel'); await writeFile(target, sentinel); await unlink(join(f.directory, asset.originalPath));
  await link(target, join(f.directory, asset.originalPath));
  let report = await createLocalDiagnosticReport(f.directory, context); assert.equal(report.assets.items[0].status, 'UNSAFE_PATH');
  await unlink(join(f.directory, asset.originalPath)); await unlink(join(f.directory, asset.previewPath)); await rmdir(join(f.directory, 'assets'));
  await symlink(outside, join(f.directory, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  try { report = await createLocalDiagnosticReport(f.directory, context); assert.deepEqual(report.assets.items.map(item => item.status), ['UNSAFE_PATH', 'UNSAFE_PATH']); assert.equal(report.assets.bytesRead, 0); }
  finally { await unlink(join(f.directory, 'assets')); }
  assert.equal(await readFile(target, 'utf8'), sentinel);
});

test('file size, total read bytes and result count are bounded with explicit truncation', async t => {
  const f = await fixture(t), huge = await addAsset(f, Buffer.alloc(20 * 1024 * 1024 + 1));
  let report = await createLocalDiagnosticReport(f.directory, context);
  assert.equal(report.assets.items[0].status, 'SKIPPED_FILE_LIMIT'); assert.equal(report.truncated, true);
  await unlink(join(f.directory, huge.originalPath)); await unlink(join(f.directory, huge.previewPath));
  const db = new DatabaseSync(join(f.directory, 'red.sqlite')); db.exec('DELETE FROM assets'); db.close();
  for (let i = 0; i < 4; i++) await addAsset(f, Buffer.alloc(10 * 1024 * 1024, i));
  report = await createLocalDiagnosticReport(f.directory, context);
  assert.ok(report.assets.bytesRead <= 64 * 1024 * 1024); assert.ok(report.assets.items.some(item => item.status === 'SKIPPED_BYTE_LIMIT')); assert.equal(report.assets.truncated, true);
  for (let i = 0; i < 48; i++) await addAsset(f, Buffer.from(`small-${i}`));
  report = await createLocalDiagnosticReport(f.directory, context);
  assert.equal(report.assets.items.length, 100); assert.equal(report.assets.total, 104); assert.equal(report.assets.truncated, true);
});

test('malformed projection fields, IDs and oversized JSON cannot leak or authorize file reads', async t => {
  const f = await fixture(t), a = await addAsset(f), db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  db.prepare('UPDATE assets SET id=?,original_path=?,preview_path=?,sha256=?').run(sentinel, `../${sentinel}`, sentinel, sentinel);
  db.prepare('INSERT INTO image_versions VALUES(?,?)').run(randomUUID(), JSON.stringify({ id: sentinel, originalPath: sentinel, previewPath: sentinel, secret: sentinel.repeat(2000) }));
  for (let i = 0; i < 103; i++) db.prepare('INSERT INTO image_write_operations VALUES(?,?)').run(randomUUID(), i % 2 ? '{broken' : JSON.stringify({ id: sentinel, state: sentinel, code: sentinel }));
  db.close();
  const report = await createLocalDiagnosticReport(f.directory, { ...context, appVersion: `0.5.0-${sentinel}` });
  assert.equal(report.appVersion, null); assert.equal(report.recovery.inspected, 100); assert.equal(report.recovery.invalid, 100); assert.equal(report.recovery.truncated, true);
  assert.deepEqual(report.assets.items.map(item => item.status), Array(4).fill('INVALID_RECORD'));
  assert.ok(report.assets.items.every(item => item.recordId === null || /^[0-9a-f-]{36}$/i.test(item.recordId)));
  assert.equal(report.assets.bytesRead, 0); assert.doesNotMatch(JSON.stringify(report), new RegExp(sentinel));
  assert.deepEqual(await readFile(join(f.directory, a.originalPath)), a.original);
});

test('empty, missing, corrupt and older databases are inspected without creating or upgrading data', async t => {
  const f = await fixture(t);
  let report = await createLocalDiagnosticReport(f.directory, context); assert.deepEqual(report.errors, []); assert.equal(report.assets.total, 0);
  const missing = join(f.root, 'does-not-exist'); report = await createLocalDiagnosticReport(missing, context);
  assert.ok(report.errors.includes('DATABASE_MISSING')); await assert.rejects(readdir(missing), { code: 'ENOENT' });
  const corrupt = join(f.root, 'corrupt'); await mkdir(corrupt); await writeFile(join(corrupt, 'red.sqlite'), sentinel);
  report = await createLocalDiagnosticReport(corrupt, context); assert.deepEqual(report.errors, ['DATABASE_CORRUPT']); assert.doesNotMatch(JSON.stringify(report), new RegExp(sentinel));
  const db = new DatabaseSync(join(f.directory, 'red.sqlite')); db.exec('DROP TABLE IF EXISTS listing_followups; DROP TABLE IF EXISTS category_libraries; DROP TABLE IF EXISTS procurement_batches; DROP TABLE IF EXISTS image_workflow_runs; DROP TABLE IF EXISTS automatic_listing_tasks; DROP TABLE IF EXISTS item_labels; DROP TABLE IF EXISTS shipment_documents; DROP TABLE IF EXISTS sku_naming_identities; DROP TABLE IF EXISTS sku_naming_groups; DROP TABLE IF EXISTS sku_naming_sequences; DROP TABLE IF EXISTS listing_completion_operations; DROP TABLE IF EXISTS source_image_provenance; PRAGMA user_version=8'); db.close();
  report = await createLocalDiagnosticReport(f.directory, context); assert.equal(report.schemaVersion, 8);
  const check = new DatabaseSync(join(f.directory, 'red.sqlite')); assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 8); check.close();
});

async function ipcFixture(directory: string, choice: () => Promise<{ canceled: boolean; filePath?: string }>, contextSource = (): DiagnosticContext => context) {
  const handlers = new Map<string, { count: number; run: (...args: unknown[]) => unknown }>();
  const handle: IpcHandler = (channel, count, run) => { handlers.set(channel, { count, run }); };
  installDiagnosticsIpc(directory, handle, { context: contextSource, selectDestination: choice });
  assert.deepEqual([...handlers].map(([channel, h]) => [channel, h.count]), [['red:diagnostics:get', 0], ['red:diagnostics:export', 0]]);
  return { get: () => handlers.get('red:diagnostics:get')!.run(), save: () => Promise.resolve(handlers.get('red:diagnostics:export')!.run()) };
}

test('diagnostic export cancels before reading the workspace and returns no destination path', async t => {
  const f = await fixture(t);
  let ipc = await ipcFixture(f.directory, async () => ({ canceled: true }), () => { throw new Error(sentinel); });
  assert.deepEqual(await ipc.save(), { cancelled: true });
  const destination = join(f.root, 'report.json'); await writeFile(destination, 'previous export');
  ipc = await ipcFixture(f.directory, async () => ({ canceled: false, filePath: destination }));
  assert.deepEqual(await ipc.save(), { cancelled: false });
  const report = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(report.reportVersion, 1); assert.equal(report.counts.products, 1); assert.doesNotMatch(JSON.stringify(report), new RegExp(`${sentinel}|${f.root.replaceAll('\\', '\\\\')}`));
  assert.equal((await readdir(f.root)).filter(name => name.startsWith('.red-export-')).length, 0);
});

test('diagnostic export rejects every managed destination, aliases, linked files and non-JSON names', async t => {
  const f = await fixture(t), asset = await addAsset(f), databaseBefore = await readFile(join(f.directory, 'red.sqlite'));
  for (const folder of ['amazon-vault', 'ai-vault', 'future-bridge']) await mkdir(join(f.directory, folder));
  for (const destination of [join(f.directory, 'red.sqlite'), join(f.directory, 'red.sqlite.json'), join(f.directory, 'assets', 'report.json'), join(f.directory, 'amazon-vault', 'secret.json'), join(f.directory, 'ai-vault', 'secret.json'), join(f.directory, 'future-bridge', 'pairing.json'), join(f.root, 'report.txt')]) {
    const ipc = await ipcFixture(f.directory, async () => ({ canceled: false, filePath: destination }));
    await assert.rejects(ipc.save(), { message: 'DIAGNOSTIC_EXPORT_DESTINATION' });
  }
  const alias = join(f.root, 'alias'); await symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try { const ipc = await ipcFixture(f.directory, async () => ({ canceled: false, filePath: join(alias, 'hidden.json') })); await assert.rejects(ipc.save(), { message: 'DIAGNOSTIC_EXPORT_DESTINATION' }); }
  finally { await unlink(alias); }
  const linked = join(f.root, 'hardlink.json'); await link(join(f.directory, asset.originalPath), linked);
  const ipc = await ipcFixture(f.directory, async () => ({ canceled: false, filePath: linked })); await assert.rejects(ipc.save(), { message: 'DIAGNOSTIC_EXPORT_DESTINATION' });
  assert.deepEqual(await readFile(join(f.directory, 'red.sqlite')), databaseBefore); assert.deepEqual(await readFile(linked), asset.original);
});

test('real export rename failure keeps the prior directory and cleans the temporary file', async t => {
  const f = await fixture(t), destination = join(f.root, 'collision.json'), probe = await open(join(f.root, 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe), sync = probe.sync; await probe.close();
  // Introduce an actual directory collision after validation, before the real atomic rename.
  t.mock.method(prototype, 'sync', async function (this: Awaited<ReturnType<typeof open>>) { await sync.call(this); await mkdir(destination); await writeFile(join(destination, 'keep'), sentinel); });
  const ipc = await ipcFixture(f.directory, async () => ({ canceled: false, filePath: destination }));
  await assert.rejects(ipc.save(), { message: 'DIAGNOSTIC_EXPORT_FAILED' });
  assert.equal(await readFile(join(destination, 'keep'), 'utf8'), sentinel);
  assert.equal((await readdir(f.root)).filter(name => name.startsWith('.red-export-')).length, 0);
});

test('simulated ENOSPC during the actual atomic writer preserves the old report and cleans temporary files', async t => {
  const f = await fixture(t), destination = join(f.root, 'report.json'); await writeFile(destination, 'previous export');
  const probe = await open(destination, 'r'), prototype = Object.getPrototypeOf(probe), write = probe.writeFile; await probe.close();
  t.mock.method(prototype, 'writeFile', async function (this: Awaited<ReturnType<typeof open>>) { await write.call(this, Buffer.from('partial')); throw Object.assign(new Error(sentinel), { code: 'ENOSPC' }); });
  const ipc = await ipcFixture(f.directory, async () => ({ canceled: false, filePath: destination }));
  await assert.rejects(ipc.save(), { message: 'DIAGNOSTIC_EXPORT_NO_SPACE' });
  assert.equal(await readFile(destination, 'utf8'), 'previous export');
  assert.equal((await readdir(f.root)).filter(name => name.startsWith('.red-export-')).length, 0);
});

test('unknown dialog and context failures are replaced with fixed operation codes', async t => {
  const f = await fixture(t), ipc = await ipcFixture(f.directory, async () => { throw new Error(sentinel); }, () => { throw new Error(sentinel); });
  await assert.rejects(ipc.save(), { message: 'DIAGNOSTIC_EXPORT_FAILED' });
  await assert.rejects(Promise.resolve().then(() => ipc.get()), { message: 'DIAGNOSTIC_FAILED' });
});

test('duplicate projection keys and inconsistent recovery states never claim a successful recovery', async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  db.prepare('INSERT INTO image_write_operations VALUES(?,?)').run(ids[0], `{"id":"${ids[0]}","state":"COMMITTED","st\\u0061te":"WRITING","code":"VERSION_COMMITTED"}`);
  db.prepare('INSERT INTO image_write_operations VALUES(?,?)').run(ids[1], JSON.stringify({ id: ids[1], state: 'COMMITTED', code: 'IO_ERROR' }));
  db.prepare('INSERT INTO image_versions VALUES(?,?)').run(ids[2], `{"id":"${ids[2]}","id":"${sentinel}","originalPath":"assets/${ids[2]}.png","sha256":"${'a'.repeat(64)}","byteSize":1}`);
  db.close();
  const report = await createLocalDiagnosticReport(f.directory, context);
  assert.equal(report.recovery.invalid, 2); assert.deepEqual(report.recovery.items, []);
  assert.deepEqual(report.assets.items.map(item => item.status), ['INVALID_RECORD', 'INVALID_RECORD']);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(sentinel));
});

test('a report holds one database snapshot while bounded file checks allow application writes', async t => {
  const f = await fixture(t), asset = await addAsset(f), probe = await open(join(f.directory, asset.originalPath), 'r');
  const prototype = Object.getPrototypeOf(probe), read = probe.read; await probe.close();
  let wrote = false;
  t.mock.method(prototype, 'read', async function (this: Awaited<ReturnType<typeof open>>, ...args: Parameters<typeof read>) {
    if (!wrote) {
      wrote = true;
      const db = new DatabaseSync(join(f.directory, 'red.sqlite')), id = randomUUID();
      db.prepare('INSERT INTO image_versions VALUES(?,?)').run(id, JSON.stringify({ id, originalPath: `assets/${id}.png`, previewPath: `assets/${id}.preview.png`, byteSize: 1, previewByteSize: 1, sha256: 'a'.repeat(64), previewSha256: 'b'.repeat(64) })); db.close();
    }
    return Reflect.apply(read, this, args);
  });
  const report = await createLocalDiagnosticReport(f.directory, context);
  assert.equal(report.counts.imageVersions, 0); assert.equal(report.assets.total, 2); assert.equal(report.assets.items.length, 2);
  const next = await createLocalDiagnosticReport(f.directory, context); assert.equal(next.counts.imageVersions, 1); assert.equal(next.assets.items.length, 4);
});

test('export rechecks a destination parent changed to a workspace junction during the report', async t => {
  const f = await fixture(t), asset = await addAsset(f), parent = join(f.root, 'export-folder'), protectedFile = join(f.directory, 'bridge.json');
  await mkdir(parent); await writeFile(protectedFile, sentinel);
  const probe = await open(join(f.directory, asset.originalPath), 'r'), prototype = Object.getPrototypeOf(probe), read = probe.read; await probe.close();
  let swapped = false;
  t.mock.method(prototype, 'read', async function (this: Awaited<ReturnType<typeof open>>, ...args: Parameters<typeof read>) {
    if (!swapped) { swapped = true; await rename(parent, join(f.root, 'original-export-folder')); await symlink(f.directory, parent, process.platform === 'win32' ? 'junction' : 'dir'); }
    return Reflect.apply(read, this, args);
  });
  try {
    const ipc = await ipcFixture(f.directory, async () => ({ canceled: false, filePath: join(parent, 'bridge.json') }));
    await assert.rejects(ipc.save(), { message: 'DIAGNOSTIC_EXPORT_DESTINATION' });
    assert.equal(await readFile(protectedFile, 'utf8'), sentinel);
    assert.equal((await readdir(f.directory)).filter(name => name.startsWith('.red-export-')).length, 0);
  } finally { if (swapped) await unlink(parent); }
});

test('version strings and failed inspection totals preserve the report whitelist and truncation', async t => {
  const f = await fixture(t);
  for (const version of ['0.5.0\n', '0.5.0\r', '0.5.0-private', '0.5.0-rc.secret', sentinel]) assert.equal((await createLocalDiagnosticReport(f.directory, { ...context, appVersion: version })).appVersion, null);
  for (const version of ['0.5.0', '0.5.0-rc.1', '0.5.0-beta.2', '0.5.0-alpha.3']) assert.equal((await createLocalDiagnosticReport(f.directory, { ...context, appVersion: version })).appVersion, version);
  const db = new DatabaseSync(join(f.directory, 'red.sqlite')); db.exec('DROP TABLE assets; CREATE TABLE assets(id TEXT); INSERT INTO assets VALUES(1)'); db.close();
  const report = await createLocalDiagnosticReport(f.directory, context);
  assert.equal(report.assets.total, 2); assert.equal(report.assets.inspected, 0); assert.equal(report.assets.truncated, true); assert.equal(report.truncated, true); assert.ok(report.errors.length > 0);
});
