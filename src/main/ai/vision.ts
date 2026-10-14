import { createHash } from 'node:crypto';
import { inspectRaster } from '../image-format.ts';
import { AiError } from './errors.ts';

export const MAX_VISION_REQUEST_BYTES = 32 * 1024 * 1024;
export interface DeepSeekReferenceImage {
  assetId: string; sha256: string; mimeType: string; width: number; height: number; bytes: Buffer;
}
/** Only managed, locally read bytes cross the provider boundary; no provider-side URL fetch. */
export function visionContent(payload: unknown, images: readonly DeepSeekReferenceImage[], detail: 'original' | 'high' = 'original') {
  let bytes = 0;
  if (!images.length || images.length > (payload&&typeof payload==='object'&&'operation' in payload&&payload.operation==='image-appearance-review'?11:10) || new Set(images.map(image => image.assetId)).size !== images.length) throw new AiError('IMAGE_INVALID');
  const parts = images.map(image => {
    bytes += image.bytes.length;
    if (!image.bytes.length || image.bytes.length > 10 * 1024 * 1024 || bytes > 20 * 1024 * 1024 || createHash('sha256').update(image.bytes).digest('hex') !== image.sha256) throw new AiError('IMAGE_INVALID');
    const raster = inspectRaster(image.bytes);
    if (!['image/png','image/jpeg'].includes(image.mimeType) || raster.mimeType !== image.mimeType || raster.width !== image.width || raster.height !== image.height || Math.max(raster.width,raster.height) >= 8192) throw new AiError('IMAGE_INVALID');
    return { type: 'image_url' as const, image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString('base64')}`, detail } };
  });
  return [{ type: 'text' as const, text: JSON.stringify(payload) }, ...parts];
}
