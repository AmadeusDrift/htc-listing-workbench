import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { importImageFiles } from '../src/main/assets.ts';

async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true }); const dir = await mkdtemp(resolve('.test-data/assets-'));
  const store = new WorkspaceStore(dir); t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
  const source = join(dir, 'source.png'); await writeFile(source, png);
  return { dir, store, png, source };
}
test('图片导入不改原文件且重复内容只生成一条素材记录', async t => {
  const { dir, store, source, png } = await fixture(t); const p = store.createProduct();
  const saved = await importImageFiles(store, dir, { productId: p.id, revision: p.revision }, [source, source], bytes => bytes);
  assert.equal(saved.assets.length, 1);
  assert.deepEqual(await readFile(source), png);
  assert.deepEqual(await readFile(join(dir, 'assets', `${saved.assets[0].id}.png`)), png);
  const repeat = await importImageFiles(store, dir, { productId: p.id, revision: saved.revision }, [source], bytes => bytes);
  assert.equal(repeat.assets.length, 1); assert.equal(repeat.revision, saved.revision);
});

test('source import awaits background preview bytes and preserves the original image',async t=>{
 const {dir,store,source,png}=await fixture(t),product=store.createProduct();let processed=false;
 const saved=await importImageFiles(store,dir,{productId:product.id,revision:product.revision},[source],async bytes=>{await Promise.resolve();processed=true;return bytes;});
 assert.equal(processed,true);assert.equal(saved.assets.length,1);
 assert.deepEqual(await readFile(source),png);assert.deepEqual(await readFile(join(dir,'assets',saved.assets[0].id+'.preview.png')),png);
});
test('图片解码期间商品被修改时，数据库拒绝过期写入并清理本次新文件', async t => {
  const { dir, store, source, png } = await fixture(t); const p = store.createProduct();
  await assert.rejects(importImageFiles(store, dir, { productId: p.id, revision: p.revision }, [source], bytes => {
    store.saveProduct({ id: p.id, revision: p.revision, title: '已经修改', sourceUrl: '', description: '', status: 'draft', facts: [],
      variants: p.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })) });
    return bytes;
  }), /已更新/);
  assert.equal(store.getProduct(p.id).title, '已经修改'); assert.equal(store.getProduct(p.id).assets.length, 0);
  assert.deepEqual(await readdir(join(dir, 'assets')), []); assert.deepEqual(await readFile(source), png);
});
test('新图片文件写到一半失败时也清理残片，商品和用户原文件保持不变', async t => {
  const { dir, store, source, png } = await fixture(t); const p = store.createProduct();
  const probe = await open(source, 'r'); const prototype = Object.getPrototypeOf(probe);
  const write = probe.writeFile; await probe.close();
  t.mock.method(prototype, 'writeFile', async function (this: Awaited<ReturnType<typeof open>>) {
    await write.call(this, Buffer.from('partial image'));
    throw Object.assign(new Error('out of disk space'), { code: 'ENOSPC' });
  });
  await assert.rejects(importImageFiles(store, dir, { productId: p.id, revision: p.revision }, [source], bytes => bytes), /disk space/);
  assert.deepEqual(await readdir(join(dir, 'assets')), []);
  assert.deepEqual(store.getProduct(p.id), p);
  assert.deepEqual(await readFile(source), png);
});
