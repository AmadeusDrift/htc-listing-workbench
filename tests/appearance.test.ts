import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const defaults = { theme: 'light', density: 'comfortable', motion: 'full' } as const;
const dark = { theme: 'dark', density: 'compact', motion: 'reduced' } as const;

async function subject() {
  const module = await import('../src/main/appearance.ts').catch(() => null);
  assert.ok(module, 'appearance persistence must be available without starting Electron');
  return module;
}
async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/appearance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'appearance.json') };
}

test('a fresh installation uses light, comfortable, full motion without writing or sharing mutable defaults', async t => {
  const { AppearanceStore } = await subject();
  const { directory } = await fixture(t);
  const store = new AppearanceStore(directory);
  const first = await store.getAppearance();
  assert.deepEqual(first, defaults);
  Object.assign(first, { theme: 'dark' });
  assert.deepEqual(await store.getAppearance(), defaults);
  assert.deepEqual(await readdir(directory), []);
});

test('appearance survives restart in the existing data root without changing workspace files', async t => {
  const { AppearanceStore } = await subject();
  const { directory, path } = await fixture(t);
  await writeFile(join(directory, 'workspace-sentinel.txt'), 'existing workspace data');
  const store = new AppearanceStore(directory);
  const saved = await store.saveAppearance(dark);
  assert.deepEqual(saved, dark);
  assert.deepEqual(await new AppearanceStore(directory).getAppearance(), dark);
  Object.assign(saved, { theme: 'light' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), dark);
  const system = { ...defaults, theme: 'system' as const };
  assert.deepEqual(await store.saveAppearance(system), system);
  assert.deepEqual(await new AppearanceStore(directory).getAppearance(), system);
  assert.equal(await readFile(join(directory, 'workspace-sentinel.txt'), 'utf8'), 'existing workspace data');
  assert.deepEqual((await readdir(directory)).sort(), ['appearance.json', 'workspace-sentinel.txt']);
});

test('only complete appearance values with exactly the supported fields can replace saved preferences', async t => {
  const { AppearanceStore } = await subject();
  const { directory, path } = await fixture(t);
  const store = new AppearanceStore(directory);
  await store.saveAppearance(dark);
  const before = await readFile(path, 'utf8');
  const invalid = [undefined, null, [], 'dark', {}, { ...defaults, theme: 'auto' }, { ...defaults, density: 'dense' },
    { ...defaults, motion: 'none' }, { ...defaults, theme: ' dark ' }, { ...defaults, motion: false },
    { theme: 'light', density: 'comfortable' }, { ...defaults, path: '../red.sqlite' },
    Object.create(defaults), { ...defaults, constructor: 'unsupported' }];
  for (const value of invalid) await assert.rejects(store.saveAppearance(value), /外观/);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await store.getAppearance(), dark);
});

test('corrupt and oversized appearance files fall back without replacing the original bytes', async t => {
  const { AppearanceStore } = await subject();
  const { directory, path } = await fixture(t);
  for (const contents of ['{', JSON.stringify({ ...dark, unsupported: true }), ' '.repeat(5000) + JSON.stringify(dark)]) {
    await writeFile(path, contents);
    assert.deepEqual(await new AppearanceStore(directory).getAppearance(), defaults);
    assert.equal(await readFile(path, 'utf8'), contents);
  }
});

test('an interrupted appearance write preserves the saved preference and cleans up its temporary file', async t => {
  const { AppearanceStore } = await subject();
  const { directory, path } = await fixture(t);
  const store = new AppearanceStore(directory);
  await store.saveAppearance(defaults);
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe), write = probe.writeFile;
  await probe.close();
  t.mock.method(prototype, 'writeFile', async function (this: Awaited<ReturnType<typeof open>>) {
    await write.call(this, Buffer.from('{"theme":'));
    throw Object.assign(new Error('out of disk space'), { code: 'ENOSPC' });
  });
  await assert.rejects(store.saveAppearance(dark), /disk space/);
  assert.deepEqual(await store.getAppearance(), defaults);
  assert.deepEqual(await readdir(directory), ['appearance.json']);
  t.mock.restoreAll();
  assert.deepEqual(await store.saveAppearance(dark), dark);
});

test('rapid appearance saves are serialized so an earlier disk write cannot revert the latest selection', async t => {
  const { AppearanceStore } = await subject();
  const { directory, path } = await fixture(t);
  const store = new AppearanceStore(directory);
  await store.saveAppearance(defaults);
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe), write = probe.writeFile;
  await probe.close();
  let release!: () => void, firstWriteStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { firstWriteStarted = resolve; });
  t.mock.method(prototype, 'writeFile', async function (this: Awaited<ReturnType<typeof open>>, value: string | Uint8Array) {
    if (String(value).includes('"dark"')) { firstWriteStarted(); await gate; }
    await write.call(this, value);
  });
  const first = store.saveAppearance(dark);
  await started;
  const latest = { ...defaults, theme: 'system' as const };
  let latestFinished = false;
  const second = store.saveAppearance(latest).then(value => { latestFinished = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(latestFinished, false);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(await new AppearanceStore(directory).getAppearance(), latest);
});

test('linked or non-file appearance destinations cannot read or overwrite other workspace files', async t => {
  const { AppearanceStore } = await subject();
  const { directory, path } = await fixture(t);
  const original = join(directory, 'keep.json');
  await writeFile(original, JSON.stringify(dark));
  await link(original, path);
  const store = new AppearanceStore(directory);
  assert.deepEqual(await store.getAppearance(), defaults);
  await assert.rejects(store.saveAppearance(defaults), /外观/);
  assert.deepEqual(JSON.parse(await readFile(original, 'utf8')), dark);
  await rm(path);
  await mkdir(path);
  await assert.rejects(store.saveAppearance(defaults), /外观/);
});

test('native titlebar colors honor fixed themes and follow the OS only for system mode', async () => {
  const { appearanceTitleBarOverlay } = await subject();
  const light = { color: '#eef3f6', symbolColor: '#253f4e', height: 44 };
  const darkOverlay = { color: '#20303b', symbolColor: '#e7eef3', height: 44 };
  assert.deepEqual(appearanceTitleBarOverlay('light', true), light);
  assert.deepEqual(appearanceTitleBarOverlay('dark', false), darkOverlay);
  assert.deepEqual(appearanceTitleBarOverlay('system', false), light);
  assert.deepEqual(appearanceTitleBarOverlay('system', true), darkOverlay);
});
