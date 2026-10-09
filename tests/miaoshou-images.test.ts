import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import type { MiaoshouReceipt } from '../src/shared/miaoshou-contracts.ts';
import { MiaoshouImageService, createSourceImageDownloader } from '../src/main/miaoshou/images.ts';

test('source previews validate image identity, coalesce requests and do not modify product assets', async t => {
  await mkdir(resolve('.test-data'), { recursive: true }); const directory = await mkdtemp(resolve('.test-data/miaoshou-preview-'));
  const store = new WorkspaceStore(directory), product = store.createProduct();
  const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
  const receipt = { productId: product.id, mode: 'live', snapshot: { images: [{ id: 'image-1', role: 'main', url: 'https://images.example.com/a.png' }] } } as MiaoshouReceipt;
  let requests = 0;
  const service = new MiaoshouImageService(directory, store, () => receipt, bytes => bytes, { download: async () => { requests++; return png; }, getSourceUpdate: () => ({ images: [{ id: 'image-new', url: 'https://images.example.com/new.png', role: 'main' }] }) as never });
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(typeof service.preview, 'function');
  await assert.rejects(service.preview({ productId: product.id, imageId: 'invented' }));
  assert.equal(requests, 0);
  const input = { productId: product.id, imageId: 'image-1' };
  const [first, second] = await Promise.all([service.preview(input), service.preview(input)]);
  assert.equal(first, `data:image/png;base64,${png.toString('base64')}`); assert.equal(first, second);
  assert.equal(await service.preview(input), first); assert.equal(requests, 1);
  await assert.rejects(service.preview({ productId: product.id, imageId: 'image-new' }));
  assert.equal(await service.preview({ productId: product.id, imageId: 'image-new', version: 'latest' }), first);
  assert.equal(requests, 2);
  assert.deepEqual(store.getProduct(product.id), product);
  await service.close(); await assert.rejects(service.preview(input));
});

test('22 trusted Fake-IP source images serve gallery previews and imports without weakening source identity or version protection', async t => {
  await mkdir(resolve('.test-data'), { recursive: true }); const directory = await mkdtemp(resolve('.test-data/miaoshou-proxy-gallery-'));
  const store = new WorkspaceStore(directory), product = store.createProduct();
  const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
  const sourceImages = Array.from({ length: 22 }, (_, index) => ({ id: `source-${index}`, role: index === 0 ? 'main' : 'gallery', url: `https://cbu01.alicdn.com/img/ibank/image-${index}.png` }));
  const receipt = { productId: product.id, mode: 'live', snapshot: { images: sourceImages }, skuMappings: [{ sourceKey: 'one', localVariantId: product.variants[0].id, imageIds: ['source-0'] }] } as MiaoshouReceipt;
  const requested: string[] = [];
  const download = createSourceImageDownloader({ lookup: async () => [{ address: '198.18.0.91', family: 4 }], request: (() => { throw new Error('Unexpected public transport'); }) as never,
    nativeFetch: async (url, init) => { requested.push(url); assert.equal(init.credentials, 'omit'); return new Response(png, { headers: { 'content-type': 'image/png' } }); } });
  const service = new MiaoshouImageService(directory, store, () => receipt, bytes => bytes, { download,
    getSourceUpdate: () => ({ images: [{ ...sourceImages[0], url: 'https://cbu01.alicdn.com/img/ibank/updated.png' }] }) as never });
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const input = { productId: product.id, imageId: 'source-0' };
  await assert.rejects(service.preview({ ...input, url: 'https://evil.example/image.png' }));
  await assert.rejects(service.preview({ ...input, imageId: 'unknown' }));
  assert.equal(requested.length, 0);
  const previews = await Promise.all([...sourceImages.map(image => service.preview({ productId: product.id, imageId: image.id })), service.preview(input)]);
  assert.equal(previews.length, 23); assert.ok(previews.every(value => value === `data:image/png;base64,${png.toString('base64')}`));
  assert.equal(requested.length, 22, 'hero and thumbnail share the same trusted image request');
  assert.deepEqual(store.getProduct(product.id), product);
  await service.preview({ ...input, version: 'latest' });
  assert.equal(requested.at(-1), 'https://cbu01.alicdn.com/img/ibank/updated.png');
  await service.preview(input); assert.equal(requested.length, 23, 'imported preview keeps its own cached source URL');
  const result = await service.download({ productId: product.id, revision: product.revision, imageIds: ['source-0'] });
  assert.equal(result.downloaded, 1); assert.deepEqual(result.failures, []);
  assert.equal(requested.at(-1), sourceImages[0].url, 'asset import still reads the imported receipt, not the latest preview');
  assert.equal(result.product.assets[0].role, 'main'); assert.deepEqual(result.product.assets[0].variantIds, [product.variants[0].id]);
  assert.equal(result.product.assets[0].mimeType, 'image/png');
});

test('source downloads reject credentials, loopback DNS and redirects without leaking the URL', async () => {
  let sockets = 0;
  const download = createSourceImageDownloader({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: (() => { sockets++; }) as never });
  for (const url of ['https://user:secret@example.com/a.jpg', 'https://example.com/a.jpg?token=secret', 'https://images.example.com/a.jpg']) await assert.rejects(download(url, new AbortController().signal), error => error instanceof Error && !error.message.includes('secret'));
  assert.equal(sockets, 0);
  let pinned = false;
  const redirect = createSourceImageDownloader({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: ((_url: URL, options: { lookup: (host: string, options: unknown, callback: (...args: unknown[]) => void) => void }, cb: (response: Readable) => void) => {
    options.lookup('images.example.com', {}, (_error, address) => { pinned = address === '8.8.8.8'; });
    return Object.assign(new EventEmitter(), { end() { queueMicrotask(() => cb(Object.assign(Readable.from([]), { statusCode: 302, headers: { location: 'http://127.0.0.1/' } }))); }, destroy() {} });
  }) as never });
  await assert.rejects(redirect('https://images.example.com/a.jpg', new AbortController().signal)); assert.ok(pinned);
});

test('image import uses only receipt URLs, preserves SKU mapping and repeated import keeps manual associations', async t => {
  await mkdir(resolve('.test-data'), { recursive: true }); const directory = await mkdtemp(resolve('.test-data/miaoshou-images-'));
  const store = new WorkspaceStore(directory); let product = store.createProduct();
  const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
  const receipt = { productId: product.id, mode: 'live', snapshot: { images: [{ id: 'image-1', role: 'main', url: 'https://images.example.com/a.png' }] }, skuMappings: [{ sourceKey: 'one', localVariantId: product.variants[0].id, imageIds: ['image-1'] }] } as MiaoshouReceipt;
  let requests = 0;
  const service = new MiaoshouImageService(directory, store, () => receipt, bytes => bytes, { download: async () => { requests++; return png; } });
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(service.download({ productId: product.id, revision: product.revision, imageIds: ['invented'] })); assert.equal(requests, 0);
  const first = await service.download({ productId: product.id, revision: product.revision, imageIds: ['image-1'] });
  assert.equal(first.downloaded, 1); assert.deepEqual(first.product.assets[0].variantIds, [product.variants[0].id]);
  product = store.updateAsset({ productId: product.id, revision: first.product.revision, assetId: first.product.assets[0].id, role: 'main', variantIds: [] });
  const repeated = await service.download({ productId: product.id, revision: product.revision, imageIds: ['image-1'] });
  assert.equal(repeated.existing, 1); assert.equal(repeated.product.revision, product.revision); assert.deepEqual(repeated.product.assets[0].variantIds, []);
});

test('source image cancellation settles pending DNS', async () => {
  const download = createSourceImageDownloader({ lookup: () => new Promise(() => {}) });
  const controller = new AbortController(), pending = download('https://images.example.com/a.jpg', controller.signal);
  controller.abort(); await assert.rejects(pending);
});

test('image batch stops before a fifth 20 MB download and reports every unattempted image', async t => {
  const directory = await mkdtemp(resolve('.test-data/miaoshou-image-budget-')), store = new WorkspaceStore(directory), product = store.createProduct();
  const receipt = { productId: product.id, mode: 'live', snapshot: { images: Array.from({ length: 20 }, (_, i) => ({ id: `image-${i}`, role: 'gallery', url: `https://images.example.com/${i}.png` })) }, skuMappings: [] } as unknown as MiaoshouReceipt;
  let requests = 0;
  const service = new MiaoshouImageService(directory, store, () => receipt, bytes => bytes, { download: async () => { requests++; return Buffer.alloc(20 * 1024 * 1024); } });
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await service.download({ productId: product.id, revision: product.revision, imageIds: receipt.snapshot.images.map(i => i.id) });
  assert.equal(requests, 4); assert.equal(result.failures.length, 20);
});

test('network downloader enforces remaining batch bytes during streaming, including failed requests', async () => {
  let destroyed = false;
  const download = createSourceImageDownloader({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: ((_url: URL, _options: unknown, callback: (response: Readable) => void) => Object.assign(new EventEmitter(), {
    end() { queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), { statusCode: 200, headers: { 'content-type': 'image/png' } }))); },
    destroy() { destroyed = true; },
  })) as never });
  const budget = { remainingBytes: 10 };
  await assert.rejects(download('https://images.example.com/a.png', new AbortController().signal, budget), /大小限制/);
  assert.equal(budget.remainingBytes, 0); assert.ok(destroyed);
  await assert.rejects(download('https://images.example.com/b.png', new AbortController().signal, budget), /上限/);
});

test('different source URLs with identical bytes merge explicit SKU bindings only in the initial batch', async t => {
  const directory = await mkdtemp(resolve('.test-data/miaoshou-image-alias-')), store = new WorkspaceStore(directory), product = store.createProduct();
  const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
  const receipt = { productId: product.id, mode: 'live', snapshot: { images: [{ id: 'main', role: 'main', url: 'https://images.example.com/main.png' }, { id: 'color', role: 'gallery', url: 'https://images.example.com/color.png' }] }, skuMappings: [{ sourceKey: 'one', localVariantId: product.variants[0].id, imageIds: ['color'] }] } as MiaoshouReceipt;
  const service = new MiaoshouImageService(directory, store, () => receipt, bytes => bytes, { download: async () => png });
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const first = await service.download({ productId: product.id, revision: product.revision, imageIds: ['main', 'color'] });
  assert.equal(first.downloaded, 1); assert.equal(first.existing, 1); assert.deepEqual(first.product.assets[0].variantIds, [product.variants[0].id]);
  const edited = store.updateAsset({ productId: product.id, revision: first.product.revision, assetId: first.product.assets[0].id, role: 'main', variantIds: [] });
  const repeated = await service.download({ productId: product.id, revision: edited.revision, imageIds: ['main', 'color'] });
  assert.equal(repeated.product.revision, edited.revision); assert.deepEqual(repeated.product.assets[0].variantIds, []);
});

test('a product edit during temporary-directory setup rejects stale download and leaves no staging directory', async t => {
  const directory = await mkdtemp(resolve('.test-data/miaoshou-image-race-')), store = new WorkspaceStore(directory), product = store.createProduct();
  const receipt = { productId: product.id, mode: 'live', snapshot: { images: [{ id: 'main', role: 'main', url: 'https://images.example.com/main.png' }] }, skuMappings: [] } as unknown as MiaoshouReceipt;
  let requests = 0;
  const service = new MiaoshouImageService(directory, store, () => receipt, bytes => bytes, { download: async () => { requests++; return Buffer.alloc(0); } });
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const pending = service.download({ productId: product.id, revision: product.revision, imageIds: ['main'] });
  store.saveProduct({ id: product.id, revision: product.revision, title: '中途修改', sourceUrl: '', description: '', status: 'draft', facts: [], variants: [] });
  await assert.rejects(pending); assert.equal(requests, 0);
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.miaoshou-images-')), []);
});
