import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { importImageFiles } from '../src/main/assets.ts';
import type { AiResult } from '../src/shared/ai-contracts.ts';
import { ImageVersionService } from '../src/main/image-versions/service.ts';
import type { ImageVersionDependencies } from '../src/main/image-versions/service.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';

async function fixture(t: test.TestContext, dependencies: Partial<ImageVersionDependencies> = {}) {
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/image-versions-')), store = new WorkspaceStore(root);
  const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(256, 16); bytes.writeUInt32BE(256, 20);
  const path = join(root, 'fixture.png'); await writeFile(path, bytes); let product = store.createProduct();
  product = await importImageFiles(store, root, { productId: product.id, revision: product.revision }, [path], b => b);
  const asset = store.getAssetRecord(product.assets[0].id)!;
  const result: AiResult = { id: randomUUID(), callId: randomUUID(), providerId: 'aidge-segmentation', productId: product.id, productRevision: product.revision, variantId: null, assetId: asset.id, assetSha256: asset.sha256, sourceResultIds: [], model: 'ImageMatting', createdAt: new Date().toISOString(), reviewState: 'unreviewed', output: { kind: 'segmentation', outputKind: 'transparent-cutout', imageUrl: 'https://output.oss-cn-beijing.aliyuncs.com/result.png?Signature=temporary', width: 256, height: 256, score: null, materialized: false } };
  let downloads = 0; const output = Buffer.concat([bytes, Buffer.from('result')]);
  const service = new ImageVersionService(root, store, { listResults: () => [structuredClone(result)] }, {
    decode: () => ({ width: 256, height: 256, transparentPixels: 30000, subjectPixels: 35536, preview: bytes }),
    download: async () => { downloads++; return output; }, ...dependencies,
  });
  t.after(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, product, asset, result, service, bytes, output, downloads: () => downloads, input: { productId: product.id, productRevision: product.revision, resultId: result.id } };
}
test('materialized results preserve originals, remain unreviewed and reuse the same result id', async t => {
  const f = await fixture(t), version = await f.service.save(f.input);
  assert.equal(version.version, 1); assert.equal(version.reviewState, 'unreviewed'); assert.equal(version.sourceSha256, f.asset.sha256);
  assert.deepEqual(await readFile(join(f.root, version.originalPath)), f.output);
  assert.deepEqual(await readFile(join(f.root, f.asset.originalPath)), f.bytes);
  assert.deepEqual(f.store.getProduct(f.product.id), f.product);
  assert.deepEqual(await f.service.save(f.input), version); assert.equal(f.downloads(), 1);
  assert.ok((await f.service.preview(version.id)).startsWith('data:image/png;base64,'));
});
test('explicit selection and rollback append history without changing product image roles or SKU bindings', async t => {
  const f = await fixture(t), version = await f.service.save(f.input), input = { productId: f.product.id, productRevision: f.product.revision, sourceAssetId: f.asset.id };
  await f.service.select({ ...input, versionId: version.id }); await f.service.select({ ...input, versionId: null });
  assert.deepEqual(f.service.selections(f.product.id).map(row => row.versionId), [version.id, null]);
  assert.deepEqual(f.store.getProduct(f.product.id), f.product);
  await writeFile(join(f.root, version.originalPath), Buffer.from('tampered'));
  await assert.rejects(f.service.select({ ...input, versionId: version.id }));
  assert.equal(f.service.selections(f.product.id).length, 2);
});
test('invalid alpha, decoder failures, dimensions and foreign parameters cannot create a version', async t => {
  for (const decode of [() => ({ width: 256, height: 256, transparentPixels: 0, subjectPixels: 65536, preview: Buffer.from('bad') }), () => { throw Error('decoder private error'); }, () => ({ width: 512, height: 256, transparentPixels: 10, subjectPixels: 131062, preview: Buffer.from('bad') })]) {
    const f = await fixture(t, { decode }); await assert.rejects(f.service.save(f.input)); assert.equal(f.service.list(f.product.id).length, 0); assert.equal((await readdir(join(f.root, 'assets'))).length, 2);
  }
  const f = await fixture(t); await assert.rejects(f.service.save({ ...f.input, url: 'https://evil.test/a' })); assert.equal(f.downloads(), 0);
});
test('source changes and cancellation during download leave no version or late file writes', async t => {
  let release!: (bytes: Buffer) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, { download: async () => { entered(); return new Promise<Buffer>(resolve => { release = resolve; }); } });
  const pending = f.service.save(f.input); await started; await writeFile(join(f.root, f.asset.originalPath), Buffer.from('changed')); release(f.output);
  await assert.rejects(pending); assert.equal(f.service.list(f.product.id).length, 0);
  const cancelled = await fixture(t, { download: async () => new Promise<Buffer>(() => {}) });
  const work = cancelled.service.save(cancelled.input); await cancelled.service.close(); await assert.rejects(work);
});
test('image result identity and file hashes are independently verified before reuse', async t => {
  const f = await fixture(t), version = await f.service.save(f.input);
  assert.equal(version.sha256, createHash('sha256').update(f.output).digest('hex'));
  await writeFile(join(f.root, version.previewPath), Buffer.from('tampered'));
  await assert.rejects(f.service.preview(version.id)); await assert.rejects(f.service.save(f.input)); assert.equal(f.downloads(), 1);
});

test('backup restores all version bytes and append-only selections without adding product images', async t => {
  const f = await fixture(t), version = await f.service.save(f.input);
  await f.service.select({ productId: f.product.id, productRevision: f.product.revision, sourceAssetId: f.asset.id, versionId: version.id });
  const file = join(f.root, 'versions.htcbackup'), target = join(f.root, 'restored');
  await createWorkspaceBackup(f.root, file, 'image versions fixture passphrase');
  const prepared = await prepareWorkspaceRestore(target, file, 'image versions fixture passphrase'); await commitWorkspaceRestore(target, prepared);
  assert.deepEqual(await readFile(join(target, version.originalPath)), f.output);
  assert.deepEqual(await readFile(join(target, version.previewPath)), f.bytes);
  const db = openDatabase(target);
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_versions').get()!.n, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_selections').get()!.n, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get()!.n, 1); }
  finally { db.close(); }
});

test('backup refuses damaged version files and orphaned selections without creating an archive', async t => {
  const f = await fixture(t), version = await f.service.save(f.input), file = join(f.root, 'invalid.htcbackup');
  for (const [path, bytes] of [[version.originalPath, f.output], [version.previewPath, f.bytes]] as const) {
    const damaged = Buffer.from(bytes); damaged[damaged.length - 1] ^= 1;
    await writeFile(join(f.root, path), damaged);
    await assert.rejects(createWorkspaceBackup(f.root, file, 'image versions fixture passphrase'), /图片版本文件校验/);
    await writeFile(join(f.root, path), bytes);
  }
  const selection = await f.service.select({ productId: f.product.id, productRevision: f.product.revision, sourceAssetId: f.asset.id, versionId: version.id });
  const db = openDatabase(f.root);
  try { db.prepare('UPDATE image_selections SET record_json=? WHERE id=?').run(JSON.stringify({ ...selection, versionId: randomUUID() }), selection.id); }
  finally { db.close(); }
  await assert.rejects(createWorkspaceBackup(f.root, file, 'image versions fixture passphrase'), /来源关联/);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('background artifact decode is awaited and rechecks source before materializing files',async t=>{
  let enter!:()=>void,release!:(value:any)=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  const f=await fixture(t,{decode:async()=>{enter();return new Promise(resolve=>{release=resolve;});}});
  const pending=f.service.save(f.input);await entered;assert.equal(f.service.list(f.product.id).length,0);
  await writeFile(join(f.root,f.asset.originalPath),Buffer.from('changed while background decoding'));
  release({width:256,height:256,transparentPixels:30000,subjectPixels:35536,preview:f.output});
  await assert.rejects(pending);assert.equal(f.service.list(f.product.id).length,0);assert.equal(f.downloads(),1);
});
