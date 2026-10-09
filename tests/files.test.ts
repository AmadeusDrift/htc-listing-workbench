import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomically } from '../src/main/files.ts';

async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'product.red.json');
  await writeFile(target, 'previous export');
  return { directory, target };
}
test('导出成功时完整替换旧文件，不留下临时文件', async t => {
  const { directory, target } = await fixture(t);
  await writeFileAtomically(target, '{"title":"新商品"}\n');
  assert.equal(await readFile(target, 'utf8'), '{"title":"新商品"}\n');
  assert.deepEqual(await readdir(directory), ['product.red.json']);
});
test('导出写到一半失败时保留已有文件，并清理新建的临时文件', async t => {
  const { directory, target } = await fixture(t);
  const probe = await open(target, 'r'); const prototype = Object.getPrototypeOf(probe);
  const write = probe.writeFile; await probe.close();
  t.mock.method(prototype, 'writeFile', async function (this: Awaited<ReturnType<typeof open>>) {
    await write.call(this, Buffer.from('partial export'));
    throw Object.assign(new Error('out of disk space'), { code: 'ENOSPC' });
  });
  await assert.rejects(writeFileAtomically(target, 'replacement'), /disk space/);
  assert.equal(await readFile(target, 'utf8'), 'previous export');
  assert.deepEqual(await readdir(directory), ['product.red.json']);
});
