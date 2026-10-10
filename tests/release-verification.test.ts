import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const moduleUrl = new URL('../scripts/release-verification.mjs', import.meta.url).href;
async function implementation() {
  const value = await import(moduleUrl).catch(() => null);
  assert.ok(value, 'release verification must provide strict package/source validation');
  return value;
}
async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(resolve('.test-data/release-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('full inventory detects additions, deletions, bytes and sizes, including nested runtime files', async t => {
  const api = await implementation(), root = await fixture(t);
  await mkdir(join(root, 'locales')); await writeFile(join(root, 'locales/en.pak'), 'runtime');
  await writeFile(join(root, 'HTC.exe'), 'exe');
  const files = await api.inventory(root);
  assert.deepEqual(files.map((f: any) => f.path), ['HTC.exe', 'locales/en.pak']);
  assert.equal(files[1].size, 7); await api.verifyInventory(root, files);
  await writeFile(join(root, 'extra.dll'), 'old'); await assert.rejects(api.verifyInventory(root, files), /file set/i);
  await rm(join(root, 'extra.dll')); await writeFile(join(root, 'HTC.exe'), 'EXE');
  await assert.rejects(api.verifyInventory(root, files), /digest/i);
  await writeFile(join(root, 'HTC.exe'), 'exe'); await rm(join(root, 'locales/en.pak'));
  await assert.rejects(api.verifyInventory(root, files), /file set/i);
});
test('manifest rejects traversal, drive paths, aliases, case collisions and dishonest sizes', async t => {
  const api = await implementation(), root = await fixture(t); await writeFile(join(root, 'a'), 'a');
  const files = await api.inventory(root);
  for (const path of ['../a', '/a', 'C:/a', 'a/../a', './a', 'a\\b', 'a.', 'CON', 'a:b']) {
    await assert.rejects(api.verifyInventory(root, [{ ...files[0], path }]), /path/i, path);
  }
  await assert.rejects(api.verifyInventory(root, [files[0], { ...files[0], path: 'A' }]), /duplicate/i);
  await assert.rejects(api.verifyInventory(root, [{ ...files[0], size: 9 }]), /size/i);
});
test('new output reservation rejects an existing directory and protected or linked locations', async t => {
  const api = await implementation(), root = await fixture(t), source = join(root, 'source'); await mkdir(source);
  await mkdir(join(root, 'release')); const old = join(root, 'release/HTC-1.0.0-win32-x64'); await mkdir(old);
  await writeFile(join(old, 'HTC.exe'), 'preserve');
  await assert.rejects(api.reserveOutput(old, [source, join(root, 'release')]), /protected/i);
  await assert.rejects(api.reserveOutput(source, [source]), /protected/i);
  await assert.rejects(api.reserveOutput(join(root, 'release/new'), [join(root, 'release')]), /protected/i);
  const fresh = join(root, 'candidate'); await api.reserveOutput(fresh, [source]);
  await assert.rejects(api.reserveOutput(fresh, [source]), /exist/i);
  assert.equal(await readFile(join(old, 'HTC.exe'), 'utf8'), 'preserve');
  const link = join(root, 'junction'); await symlink(source, link, 'junction');
  await assert.rejects(api.reserveOutput(join(link, 'candidate'), []), /link|reparse/i);
  await assert.rejects(api.inventory(root), /link|reparse/i);
});
