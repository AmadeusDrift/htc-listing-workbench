import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { StoredAsset } from '../store.ts';
import { managedAssetPath } from '../security.ts';
import { inspectRaster } from '../image-format.ts';
import { AiError, throwIfAborted } from './errors.ts';
import { MAX_IMAGE_BYTES } from './validation.ts';

export function validateImage(asset: StoredAsset, segmentation: boolean): void {
  if (!['image/png', 'image/jpeg'].includes(asset.mimeType) || !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 1 || asset.byteSize > MAX_IMAGE_BYTES || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height)) throw new AiError('IMAGE_INVALID');
  if (segmentation ? asset.width < 256 || asset.height < 256 || asset.width > 3000 || asset.height > 3000 : asset.width <= 15 || asset.height <= 15 || asset.width >= 8192 || asset.height >= 8192 || Math.max(asset.width, asset.height) / Math.min(asset.width, asset.height) >= 50) throw new AiError('IMAGE_INVALID');
}
export function sameAsset(left: StoredAsset, right: StoredAsset): boolean { return left.id === right.id && left.productId === right.productId && left.sha256 === right.sha256 && left.originalPath === right.originalPath && left.byteSize === right.byteSize && left.mimeType === right.mimeType && left.width === right.width && left.height === right.height; }
export async function readManagedImage(directory: string, asset: StoredAsset, signal: AbortSignal): Promise<Buffer> {
  try {
    throwIfAborted(signal);
    const expected = `assets/${asset.id}.${asset.mimeType === 'image/png' ? 'png' : 'jpg'}`;
    if (asset.originalPath !== expected) throw new AiError('SOURCE_CHANGED');
    const path = managedAssetPath(directory, asset.originalPath), [root, actual] = await Promise.all([realpath(directory), realpath(path)]);
    throwIfAborted(signal);
    const inside = (resolved: string) => { const below = relative(root, resolved); return below !== '' && below !== '..' && !below.startsWith(`..${sep}`) && resolve(root, below) === resolved; };
    if (!inside(actual)) throw new AiError('SOURCE_CHANGED');
    const file = await open(actual, 'r');
    try {
      throwIfAborted(signal);
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_BYTES || info.size !== asset.byteSize || await realpath(path) !== actual) throw new AiError('SOURCE_CHANGED');
      const bytes = Buffer.alloc(info.size); let offset = 0;
      while (offset < bytes.length) { throwIfAborted(signal); const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw new AiError('SOURCE_CHANGED'); offset += bytesRead; }
      const [after, current, real] = await Promise.all([file.stat(), stat(path), realpath(path)]); throwIfAborted(signal);
      if (real !== actual || !inside(real) || current.ino !== info.ino || current.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new AiError('SOURCE_CHANGED');
      const raster = inspectRaster(bytes);
      if (raster.mimeType !== asset.mimeType || raster.width !== asset.width || raster.height !== asset.height) throw new AiError('SOURCE_CHANGED');
      return bytes;
    } finally { await file.close(); }
  } catch (error) { throwIfAborted(signal); if (error instanceof AiError) throw error; throw new AiError('SOURCE_CHANGED'); }
}
