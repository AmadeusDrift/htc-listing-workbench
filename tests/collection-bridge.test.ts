import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/main/store.ts';
import { COLLECTION_EXTENSION_ORIGIN } from '../src/shared/collection-identity.ts';
import { COLLECTION_MAX_MESSAGE_BYTES } from '../src/shared/collection-contracts.ts';
import type { CollectionReceiveResult, CollectionResponse } from '../src/shared/collection-contracts.ts';
import { collectionRequest } from './helpers/collection-fixture.ts';

const subject = await import('../src/main/collection/service.ts').catch(() => null), run = promisify(execFile);
async function waitFor(predicate: () => boolean) { for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate(), 'condition did not settle'); }
function frame(bytes: Buffer): Buffer { const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]); }
async function fixture(t: test.TestContext) {
  assert.ok(subject, 'collection bridge service is required');
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/collection-bridge-'));
  const directory = join(root, 'workspace'), executable = join(root, 'native', 'HTC.CollectionHost.exe');
  await run(process.execPath, ['scripts/build-native-host.mjs', '--output', join(root, 'native')], { windowsHide: true });
  const store = new WorkspaceStore(directory), events: CollectionReceiveResult[] = [], bridge = new subject.CollectionBridge(directory, store, { nativeHostExecutable: executable, onReceived: event => events.push(event) });
  t.after(async () => { await bridge.close(); store.close(); assert.ok(relative(resolve('.test-data'), root).startsWith('collection-bridge-')); await rm(root, { recursive: true, force: true }); });
  return { root, directory, executable, store, bridge, events };
}
async function nativeCall(executable: string, message: unknown, origin = COLLECTION_EXTENSION_ORIGIN, raw?: Buffer): Promise<CollectionResponse> {
  const child = spawn(executable, [origin, '--parent-window=0'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); const chunks: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
  const done = once(child, 'exit'); child.stdin.on('error', () => {}); child.stdin.end(raw ?? frame(Buffer.from(JSON.stringify(message))));
  const timer = setTimeout(() => child.kill(), 15000);
  try { await done; } finally { clearTimeout(timer); }
  const bytes = Buffer.concat(chunks); assert.ok(bytes.length >= 4, `native host must emit a framed response, stderr bytes=${Buffer.concat(errors).length}`);
  assert.equal(bytes.readUInt32LE(0), bytes.length - 4); return JSON.parse(bytes.subarray(4).toString('utf8')) as CollectionResponse;
}
async function pipeCall(config: { pipeName: string; token: string }, raw: Buffer): Promise<CollectionResponse> {
  const socket = connect(`\\\\.\\pipe\\${config.pipeName}`), chunks: Buffer[] = []; socket.on('data', chunk => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
  const done = once(socket, 'close'); await once(socket, 'connect'); socket.end(frame(raw)); await done;
  const bytes = Buffer.concat(chunks); assert.equal(bytes.readUInt32LE(0), bytes.length - 4); return JSON.parse(bytes.subarray(4).toString('utf8')) as CollectionResponse;
}

test('explicit preparation supplies a fixed native host and actual EXE to pipe to inbox works', async t => {
  const f = await fixture(t); await f.bridge.start(); assert.equal(f.bridge.getStatus().state, 'unprepared');
  assert.equal((await f.bridge.prepareConnection()).state, 'ready');
  const executable = join(f.bridge.connectionDirectory, 'HTC.CollectionHost.exe'), request = collectionRequest();
  const status = await nativeCall(executable, { version: 1, type: 'status', requestId: randomUUID() }); assert.equal(status.type, 'status');
  const first = await nativeCall(executable, request); assert.equal(first.type, 'receipt'); if (first.type !== 'receipt') return;
  assert.equal(f.store.listProducts().length, 1); assert.equal(f.events.length, 1); assert.deepEqual(await nativeCall(executable, request), first);
  const receipt = f.bridge.getReceipt(first.receipt.productId); assert.equal(receipt!.snapshot.offerId, request.snapshot.offerId);
  const config = JSON.parse(await readFile(join(f.bridge.connectionDirectory, 'connection.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify([first, status, f.bridge.getStatus(), receipt, f.events]), new RegExp(`${config.token}|${config.pipeName}`));
  const manifest = JSON.parse(await readFile(join(f.bridge.connectionDirectory, 'native-host.json'), 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [COLLECTION_EXTENSION_ORIGIN]); assert.equal(manifest.path, executable);
});

test('host rejects foreign extension identity, large input and invalid UTF-8 without importing', async t => {
  const f = await fixture(t); await f.bridge.prepareConnection(); const executable = join(f.bridge.connectionDirectory, 'HTC.CollectionHost.exe');
  const wrong = await nativeCall(executable, collectionRequest(), `chrome-extension://${'a'.repeat(32)}/`); assert.equal(wrong.type === 'error' && wrong.code, 'UNAUTHORIZED');
  const bad = await nativeCall(executable, null, COLLECTION_EXTENSION_ORIGIN, frame(Buffer.from([0xff]))); assert.equal(bad.type === 'error' && bad.code, 'INVALID_MESSAGE');
  const large = Buffer.alloc(4); large.writeUInt32LE(COLLECTION_MAX_MESSAGE_BYTES + 1); const huge = await nativeCall(executable, null, COLLECTION_EXTENSION_ORIGIN, large); assert.equal(huge.type === 'error' && huge.code, 'TOO_LARGE');
  const version = await nativeCall(executable, { ...collectionRequest(), version: 2 }); assert.equal(version.type === 'error' && version.code, 'UNSUPPORTED_VERSION');
  const excessive = collectionRequest(); excessive.snapshot.skus = Array.from({ length: 201 }, (_, i) => ({ ...excessive.snapshot.skus[0], providerSkuId: `sku-${i}` }));
  const many = await nativeCall(executable, excessive); assert.equal(many.type === 'error' && many.code, 'TOO_MANY_SKUS');
  assert.equal(f.store.listProducts().length, 0);
});

test('pipe authentication, exact envelopes and duplicate inner JSON are enforced', async t => {
  const f = await fixture(t); await f.bridge.prepareConnection(); const config = JSON.parse(await readFile(join(f.bridge.connectionDirectory, 'connection.json'), 'utf8'));
  const raw = JSON.stringify(collectionRequest()), packet = { version: 1, token: config.token, origin: COLLECTION_EXTENSION_ORIGIN, payload: Buffer.from(raw).toString('base64') };
  for (const [overrides, expected] of [[{ token: '0'.repeat(64) }, 'UNAUTHORIZED'], [{ origin: COLLECTION_EXTENSION_ORIGIN + 'evil' }, 'UNAUTHORIZED'], [{ extra: 'secret' }, 'INVALID_MESSAGE'], [{ payload: Buffer.from(raw.replace('"version":1', '"version":1,"version":1')).toString('base64') }, 'INVALID_MESSAGE']] as const) {
    const response = await pipeCall(config, Buffer.from(JSON.stringify({ ...packet, ...overrides }))); assert.equal(response.type === 'error' && response.code, expected);
  }
  assert.equal(f.store.listProducts().length, 0);
});

test('restore rejects active sockets, pause blocks imports, cancel resumes and close drains before DB close', async t => {
  const f = await fixture(t); await f.bridge.prepareConnection(); const config = JSON.parse(await readFile(join(f.bridge.connectionDirectory, 'connection.json'), 'utf8'));
  const incomplete = connect(`\\\\.\\pipe\\${config.pipeName}`); await once(incomplete, 'connect'); await waitFor(() => f.bridge.busy);
  assert.equal(f.bridge.busy, true); assert.throws(() => f.bridge.pauseForRestore(), /APP_BUSY/); incomplete.destroy(); await once(incomplete, 'close'); await waitFor(() => !f.bridge.busy);
  const release = f.bridge.pauseForRestore(), executable = join(f.bridge.connectionDirectory, 'HTC.CollectionHost.exe');
  const blocked = await nativeCall(executable, collectionRequest()); assert.equal(blocked.type === 'error' && blocked.code, 'APP_BUSY'); assert.equal(f.store.listProducts().length, 0);
  release(); const accepted = await nativeCall(executable, collectionRequest()); assert.equal(accepted.type, 'receipt');
  const waiting = connect(`\\\\.\\pipe\\${config.pipeName}`); waiting.on('error', () => {}); await once(waiting, 'connect'); await waitFor(() => f.bridge.busy); await f.bridge.close(); assert.equal(f.bridge.getStatus().state, 'closed');
  await assert.rejects(readFile(join(f.bridge.connectionDirectory, 'connection.json')), /ENOENT/);
  const closed = await nativeCall(executable, collectionRequest()); assert.equal(closed.type === 'error' && closed.code, 'APP_UNAVAILABLE');
});

test('a new app instance rotates endpoint and token; connection directories cannot be junctions', async t => {
  const f = await fixture(t); await f.bridge.prepareConnection(); const file = join(f.bridge.connectionDirectory, 'connection.json'), previous = JSON.parse(await readFile(file, 'utf8')); await f.bridge.close();
  assert.ok(subject); const next = new subject.CollectionBridge(f.directory, f.store, { nativeHostExecutable: f.executable });
  try { await next.start(); assert.equal(next.getStatus().state, 'ready'); const current = JSON.parse(await readFile(file, 'utf8')); assert.notEqual(current.token, previous.token); assert.notEqual(current.pipeName, previous.pipeName); } finally { await next.close(); }
  const unsafeRoot = join(f.root, 'unsafe'), other = join(f.root, 'untouched'); await mkdir(unsafeRoot); await mkdir(other); await writeFile(join(other, 'sentinel'), 'keep'); await symlink(other, join(unsafeRoot, 'collection-connection'), 'junction');
  const unsafe = new subject.CollectionBridge(unsafeRoot, f.store, { nativeHostExecutable: f.executable }); try { await assert.rejects(unsafe.prepareConnection()); assert.equal(await readFile(join(other, 'sentinel'), 'utf8'), 'keep'); } finally { await unsafe.close(); }
});

test('test-host override is accepted only from an explicit E2E environment', () => {
  assert.ok(subject); assert.throws(() => subject.collectionHostName({ RED_COLLECTION_TEST_HOST: 'com.htc.workbench.collection.test_abc123def456' }), /INVALID_MESSAGE/);
  assert.throws(() => subject.collectionHostName({ RED_E2E: '1', RED_COLLECTION_TEST_HOST: '../../escape' }), /INVALID_MESSAGE/);
  assert.equal(subject.collectionHostName({ RED_E2E: '1', RED_COLLECTION_TEST_HOST: 'com.htc.workbench.collection.test_abc123def456' }), 'com.htc.workbench.collection.test_abc123def456');
});

test('the actual host preserves a large UTF-8 capture up to 200 complete SKU rows', async t => {
  const f = await fixture(t); await f.bridge.prepareConnection(); const request = collectionRequest();
  request.snapshot.skus = Array.from({ length: 200 }, (_, index) => ({ ...request.snapshot.skus[0], providerSkuId: `sku-${index + 1}`, originalSpec: '测试'.repeat(330) }));
  const bytes = Buffer.from(JSON.stringify(request)); assert.ok(bytes.length > 400000 && bytes.length < COLLECTION_MAX_MESSAGE_BYTES);
  const result = await nativeCall(join(f.bridge.connectionDirectory, 'HTC.CollectionHost.exe'), request);
  assert.equal(result.type, 'receipt'); if (result.type === 'receipt') { assert.equal(f.store.getProduct(result.receipt.productId).variants.length, 200); assert.equal(f.bridge.getReceipt(result.receipt.productId)!.snapshot.skus[199].originalSpec, '测试'.repeat(330)); }
});

test('failed config installation closes its listener so the same bridge can retry preparation', async t => {
  const f = await fixture(t); await f.bridge.prepareConnection(); await f.bridge.close(); assert.ok(subject);
  const next = new subject.CollectionBridge(f.directory, f.store, { nativeHostExecutable: f.executable }), badConfig = join(next.connectionDirectory, 'connection.json');
  try {
    await mkdir(badConfig); await assert.rejects(next.prepareConnection(), /APP_UNAVAILABLE/); assert.equal(next.getStatus().state, 'unavailable');
    await rmdir(badConfig); assert.equal((await next.prepareConnection()).state, 'ready');
    assert.equal((await nativeCall(join(next.connectionDirectory, 'HTC.CollectionHost.exe'), collectionRequest())).type, 'receipt');
  } finally { await next.close(); }
});

test('close during asynchronous preparation never leaves a usable endpoint or late config', async t => {
  const f = await fixture(t), preparing = f.bridge.prepareConnection(), settled = preparing.catch(error => error);
  await f.bridge.close(); assert.equal((await settled).code, 'APP_UNAVAILABLE'); assert.equal(f.bridge.getStatus().state, 'closed');
  await assert.rejects(readFile(join(f.bridge.connectionDirectory, 'connection.json')), /ENOENT/);
  await assert.rejects(f.bridge.prepareConnection(), /APP_UNAVAILABLE/);
});

test('connection limits reject an excess native sender and incomplete frames expire without touching the store', async t => {
  const f = await fixture(t); await f.bridge.prepareConnection(); const config = JSON.parse(await readFile(join(f.bridge.connectionDirectory, 'connection.json'), 'utf8'));
  const sockets = Array.from({ length: 8 }, () => connect(`\\\\.\\pipe\\${config.pipeName}`));
  const replies = sockets.map(async socket => { const chunks: Buffer[] = []; socket.on('data', chunk => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)); await once(socket, 'close'); const bytes = Buffer.concat(chunks); return JSON.parse(bytes.subarray(4).toString('utf8')) as CollectionResponse; });
  await waitFor(() => f.bridge.getStatus().activeConnections === 8);
  const rejected = await nativeCall(join(f.bridge.connectionDirectory, 'HTC.CollectionHost.exe'), collectionRequest()); assert.equal(rejected.type === 'error' && rejected.code, 'APP_BUSY');
  for (const response of await Promise.all(replies)) assert.equal(response.type === 'error' && response.code, 'TIMEOUT');
  await waitFor(() => !f.bridge.busy); assert.equal(f.store.listProducts().length, 0);
});

test('the actual native host terminates an incomplete browser frame with a fixed timeout', async t => {
  const f = await fixture(t); await f.bridge.prepareConnection();
  const child = spawn(join(f.bridge.connectionDirectory, 'HTC.CollectionHost.exe'), [COLLECTION_EXTENSION_ORIGIN], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), chunks: Buffer[] = [];
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stdin.on('error', () => {}); child.stdin.write(Buffer.from([1, 0]));
  const completion = once(child, 'exit'), timer = setTimeout(() => child.kill(), 15000); t.after(() => child.kill());
  try { await completion; } finally { clearTimeout(timer); }
  const bytes = Buffer.concat(chunks); assert.equal(bytes.readUInt32LE(0), bytes.length - 4); const response = JSON.parse(bytes.subarray(4).toString('utf8'));
  assert.deepEqual(response, { version: 1, type: 'error', requestId: null, ok: false, code: 'TIMEOUT' }); assert.equal(f.store.listProducts().length, 0);
});
