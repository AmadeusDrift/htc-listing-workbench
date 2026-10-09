import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { CollectionBridge } from '../src/main/collection/service.ts';

const run = promisify(execFile);
async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/collection-connection-'));
  const executable = join(root, 'native', 'HTC.CollectionHost.exe');
  await run(process.execPath, ['scripts/build-native-host.mjs', '--output', join(root, 'native')], { windowsHide: true });
  t.after(async () => { assert.ok(relative(resolve('.test-data'), root).startsWith('collection-connection-')); await rm(root, { recursive: true, force: true }); });
  return { root, directory: join(root, 'workspace'), executable };
}

// Import the bridge only after installing the one-time process-boundary fault. All subsequent
// helper calls execute the real compiled EXE, and a fresh child also covers restart recovery.
const child = String.raw`
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [project, directory, executable, mode] = process.argv.slice(1);
const original = childProcess.execFile; let secureCalls = 0, inject = mode !== 'resume';
childProcess.execFile = function (...args) {
  if (Array.isArray(args[1]) && args[1].includes('--secure-local-directory')) {
    secureCalls++;
    if (inject) {
      inject = false;
      if (mode === 'crash') process.exit(73);
      setImmediate(() => args.at(-1)(Object.assign(new Error('one-time ACL helper failure'), { code: 'EACCES' }), '', ''));
      return {};
    }
  }
  return original.apply(this, args);
};
syncBuiltinESMExports();
const { CollectionBridge } = await import(pathToFileURL(join(project, 'src/main/collection/service.ts')).href);
const { WorkspaceStore } = await import(pathToFileURL(join(project, 'src/main/store.ts')).href);
const store = new WorkspaceStore(directory); let bridge = new CollectionBridge(directory, store, { nativeHostExecutable: executable });
try {
  if (mode !== 'resume') {
    await assert.rejects(bridge.prepareConnection(), /APP_UNAVAILABLE/);
    assert.equal(secureCalls, 1);
    await assert.rejects(readFile(join(bridge.connectionDirectory, 'connection.json')), /ENOENT/);
    if (mode === 'restart') { await bridge.close(); bridge = new CollectionBridge(directory, store, { nativeHostExecutable: executable }); }
  }
  if (mode === 'retry') await bridge.prepareConnection(); else await bridge.start();
  assert.equal(bridge.getStatus().state, 'ready');
  assert.equal(secureCalls, mode === 'resume' ? 1 : 2);
  const owner = JSON.parse(await readFile(join(bridge.connectionDirectory, 'owner.json'), 'utf8'));
  assert.equal(owner.application, 'HTC.CollectionBridge'); assert.equal(owner.directory, resolve(bridge.connectionDirectory).toLowerCase());
  console.log(JSON.stringify({ mode, state: bridge.getStatus().state, secureCalls, files: await readdir(bridge.connectionDirectory) }));
} finally { await bridge.close(); store.close(); }
`;
async function childRun(directory: string, executable: string, mode: string) {
  return run(process.execPath, ['--input-type=module', '-e', child, process.cwd(), directory, executable, mode], { windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 });
}

for (const mode of ['retry', 'restart']) test(`first ACL failure permits ${mode} without deleting owned files`, async t => {
  const f = await fixture(t), result = await childRun(f.directory, f.executable, mode);
  assert.equal(JSON.parse(result.stdout).state, 'ready');
});

test('a process exit immediately before the first ACL call leaves recoverable ownership for a new app', async t => {
  const f = await fixture(t);
  await assert.rejects(childRun(f.directory, f.executable, 'crash'), (error: unknown) => { assert.equal((error as { code?: unknown }).code, 73); return true; });
  const result = await childRun(f.directory, f.executable, 'resume'); assert.equal(JSON.parse(result.stdout).state, 'ready');
});

for (const kind of ['unowned-binary', 'wrong-owner', 'hardlinked-owner', 'hardlinked-host'] as const) test(`retry never takes over a ${kind} connection directory`, async t => {
  const f = await fixture(t), store = new WorkspaceStore(f.directory), bridge = new CollectionBridge(f.directory, store, { nativeHostExecutable: f.executable });
  try {
    await mkdir(bridge.connectionDirectory);
    const ownerFile = join(bridge.connectionDirectory, 'owner.json'), hostFile = join(bridge.connectionDirectory, 'HTC.CollectionHost.exe');
    const owner = JSON.stringify({ version: 1, application: 'HTC.CollectionBridge', directory: resolve(bridge.connectionDirectory).toLowerCase() });
    if (kind === 'unowned-binary') await copyFile(f.executable, hostFile);
    if (kind === 'wrong-owner') await writeFile(ownerFile, owner.replace('HTC.CollectionBridge', 'Other.Application'));
    if (kind === 'hardlinked-owner') { const outside = join(f.root, 'owner-sentinel.json'); await writeFile(outside, owner); await link(outside, ownerFile); }
    if (kind === 'hardlinked-host') { await writeFile(ownerFile, owner); await link(f.executable, hostFile); }
    const beforeFiles = await readdir(bridge.connectionDirectory), before = await Promise.all(beforeFiles.map(name => readFile(join(bridge.connectionDirectory, name))));
    await assert.rejects(bridge.prepareConnection(), /APP_UNAVAILABLE/);
    assert.deepEqual(await readdir(bridge.connectionDirectory), beforeFiles);
    assert.deepEqual(await Promise.all(beforeFiles.map(name => readFile(join(bridge.connectionDirectory, name)))), before);
    if (kind === 'hardlinked-owner') assert.equal(await readFile(join(f.root, 'owner-sentinel.json'), 'utf8'), owner);
  } finally { await bridge.close(); store.close(); }
});
