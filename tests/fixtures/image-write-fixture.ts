import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { WorkspaceStore } from '../../src/main/store.ts';
import { importImageFiles } from '../../src/main/assets.ts';
import type { AiResult } from '../../src/shared/ai-contracts.ts';
import type { ImageVersion } from '../../src/shared/image-version-contracts.ts';

export const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function assertTestRoot(path: string): string {
  const root = resolve(path), parent = resolve('.test-data'), child = relative(parent, root);
  if (!child || child.startsWith('..') || child.includes(sep) || !child.startsWith('image-write-')) throw Error('Unsafe test cleanup path');
  return root;
}
export async function testRoot(): Promise<string> {
  await mkdir(resolve('.test-data'), { recursive: true });
  return assertTestRoot(await mkdtemp(resolve('.test-data/image-write-')));
}
export async function removeTestRoot(root: string): Promise<void> { await rm(assertTestRoot(root), { recursive: true, force: true }); }
export async function seedImage(root: string) {
  const store = new WorkspaceStore(root), bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(256, 16); bytes.writeUInt32BE(256, 20);
  const sourceFile = join(root, 'fixture.png'); await writeFile(sourceFile, bytes);
  let product = store.createProduct();
  product = await importImageFiles(store, root, { productId: product.id, revision: product.revision }, [sourceFile], b => b);
  const asset = store.getAssetRecord(product.assets[0].id)!, output = Buffer.concat([bytes, Buffer.from('cutout')]);
  const result: AiResult = { id: randomUUID(), callId: randomUUID(), providerId: 'aidge-segmentation', productId: product.id,
    productRevision: product.revision, variantId: null, assetId: asset.id, assetSha256: asset.sha256, sourceResultIds: [], model: 'ImageMatting',
    createdAt: new Date().toISOString(), reviewState: 'unreviewed', output: { kind: 'segmentation', outputKind: 'transparent-cutout',
      imageUrl: 'https://output.oss-cn-beijing.aliyuncs.com/result.png?Signature=SECRET_SENTINEL', width: 256, height: 256, score: null, materialized: false } };
  const decode = () => ({ width: 256, height: 256, transparentPixels: 30000, subjectPixels: 35536, preview: bytes });
  return { root, store, product, asset, bytes, output, result, decode,
    input: { productId: product.id, productRevision: product.revision, resultId: result.id } };
}
export function candidate(f: Awaited<ReturnType<typeof seedImage>>, id: string = randomUUID()): ImageVersion {
  return { id, productId: f.product.id, productRevision: f.product.revision, sourceAssetId: f.asset.id, sourceSha256: f.asset.sha256,
    resultId: f.result.id, version: 1, width: 256, height: 256, byteSize: f.output.length, sha256: hash(f.output),
    originalPath: `assets/${id}.png`, previewPath: `assets/${id}.preview.png`, previewByteSize: f.bytes.length, previewSha256: hash(f.bytes),
    createdAt: f.result.createdAt, reviewState: 'unreviewed', checks: { transparentPixels: 30000, subjectPixels: 35536 } };
}
