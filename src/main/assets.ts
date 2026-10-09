import { UserFacingError } from '../shared/errors.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ProductDetail, ProductMutation } from '../shared/contracts.ts';
import { inspectRaster } from './image-format.ts';
import { managedAssetPath } from './security.ts';
import type { NewAsset, WorkspaceStore } from './store.ts';

export type PreviewDecoder = (data: Buffer) => Buffer;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Original bytes are copied verbatim. Only the separate preview is resized. */
export async function importImageFiles(store: WorkspaceStore, root: string, input: ProductMutation, paths: string[], decodePreview: PreviewDecoder): Promise<ProductDetail> {
  const before = store.assertRevision(input);
  if (!paths.length) return before;
  if (paths.length > 20 || before.assets.length + paths.length > 100) throw new UserFacingError('每次最多导入 20 张图片，每件商品最多保留 100 张');
  const prepared: { asset: NewAsset; original: Buffer; preview: Buffer }[] = [];
  const seen = new Set<string>(); let total = 0;
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new UserFacingError('请选择不超过 20 MB 的图片文件');
    const data = await readFile(path);
    total += data.length;
    if (data.length > MAX_FILE_BYTES || total > 80 * 1024 * 1024) throw new UserFacingError('图片单张不能超过 20 MB，每批不能超过 80 MB');
    const raster = inspectRaster(data), sha256 = createHash('sha256').update(data).digest('hex');
    if (seen.has(sha256) || store.findAssetByHash(input.productId, sha256)) continue;
    seen.add(sha256);
    const id = randomUUID();
    const preview = decodePreview(data);
    if (!preview.length) throw new UserFacingError(`图片「${basename(path)}」无法解码，请重新保存后导入`);
    prepared.push({ asset: { id, fileName: basename(path).slice(0, 255), mimeType: raster.mimeType, width: raster.width, height: raster.height,
      byteSize: data.length, originalPath: `assets/${id}.${raster.extension}`, previewPath: `assets/${id}.preview.png`, sha256 }, original: data, preview });
  }
  await mkdir(join(root, 'assets'), { recursive: true });
  const written: string[] = [];
  async function writeNewFile(path: string, bytes: Buffer) {
    const file = await open(path, 'wx');
    // The newly created file belongs to this call even if writing fails halfway.
    written.push(path);
    try { await file.writeFile(bytes); }
    finally { await file.close(); }
  }
  try {
    for (const p of prepared) {
      const originalPath = managedAssetPath(root, p.asset.originalPath), previewPath = managedAssetPath(root, p.asset.previewPath);
      await writeNewFile(originalPath, p.original);
      await writeNewFile(previewPath, p.preview);
    }
    return store.addAssets(input, prepared.map(p => p.asset));
  } catch (error) {
    // Only newly created, UUID-named files from this call are removed. Never touch source files.
    await Promise.all(written.map(path => unlink(path).catch(() => {})));
    throw error;
  }
}
