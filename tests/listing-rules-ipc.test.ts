import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ruleModule from '../src/main/listing-rules.ts';

async function fixture(t: test.TestContext, borrowed: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'htc-rule-ipc-'));
  let opens = 0, closes = 0;
  class CountedRules extends ruleModule.ListingRuleStore {
    constructor(root: string) { super(root); opens++; }
    close() { closes++; super.close(); }
  }
  const owner = borrowed ? new CountedRules(directory) : undefined;
  const compiled = await build({ entryPoints: ['src/main/ipc.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
    plugins: [{ name: 'rule-lifecycle-observer', setup(builder) {
      builder.onResolve({ filter: /\/listing-rules\.ts$/ }, args => args.path.startsWith('../shared/') ? undefined : { path: 'observed-rules', external: true });
      builder.onResolve({ filter: /\/backup-ipc\.ts$/ }, () => ({ path: 'observed-backup', external: true }));
    } }] });
  const handlers = new Map<string, Function>(), closed: Function[] = [];
  let restoreHooks: any;
  const frame = { url: 'red://app/index.html' }, window = { webContents: { id: 1, mainFrame: frame }, once: (_event: string, fn: Function) => closed.push(fn) };
  const electron = { app: { getVersion: () => '2.5.0', getAppPath: () => directory }, ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) }, dialog: {}, nativeImage: {}, shell: {} };
  const module = { exports: {} as any }, require = createRequire(import.meta.url);
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: (id: string) => id === 'electron' ? electron : id === 'observed-rules' ? { ...ruleModule, ListingRuleStore: CountedRules } : id === 'observed-backup' ? { installBackupIpc: (_w: unknown, _d: string, _h: unknown, hooks: unknown) => { restoreHooks = hooks; } } : require(id), Buffer, URL, process, AbortController, setTimeout, clearTimeout });
  module.exports.installIpc(window, {}, directory, frame.url, {}, {}, {}, {}, {}, {}, async () => {}, undefined, undefined, undefined, undefined, {}, undefined, undefined, undefined, undefined, undefined, undefined, owner);
  t.after(() => { owner?.close(); rmSync(directory, { recursive: true, force: true }); });
  return { owner, counts: () => ({ opens, closes }), hooks: () => restoreHooks, closeWindow: () => closed.forEach(fn => fn()), call: (name: string, ...args: unknown[]) => handlers.get(`red:listing-rules:${name}`)!({ sender: { id: 1 }, senderFrame: frame }, ...args) };
}

test('repeated rule IPC reads and CAS saves borrow the owner connection without closing it', async t => {
  const f = await fixture(t, true);
  const initial = await f.call('get');
  assert.equal(initial.ok, true);
  for (let n = 0; n < 4; n++) assert.equal((await f.call('get')).ok, true);
  assert.deepEqual(f.counts(), { opens: 1, closes: 0 });
  const saved = await f.call('save', initial.data);
  assert.equal(saved.ok, true);
  assert.equal(saved.data.revision, initial.data.revision + 1);
  assert.equal((await f.call('save', initial.data)).ok, false);
  assert.equal(f.owner!.get().revision, saved.data.revision);
  assert.deepEqual(f.counts(), { opens: 1, closes: 0 });
  const release = f.hooks().beginRestore();
  assert.equal((await f.call('get')).ok, false);
  release();
  assert.equal((await f.call('get')).ok, true);
  f.closeWindow();
  assert.equal(f.owner!.get().revision, saved.data.revision);
  assert.deepEqual(f.counts(), { opens: 1, closes: 0 });
});

test('legacy caller without an owner still closes its temporary rule store', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.call('get')).ok, true);
  assert.equal((await f.call('get')).ok, true);
  assert.deepEqual(f.counts(), { opens: 2, closes: 2 });
});
