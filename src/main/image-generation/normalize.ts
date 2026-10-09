import { nativeImage } from 'electron';
import { inspectRaster } from '../image-format.ts';
import { AiError } from '../ai/errors.ts';

/** Lossless PNG encoding of decoded pixels; never resize a generated image. */
export function normalizeGeneratedImage(bytes: Buffer): Buffer {
  try {
    if (bytes.length > 20 * 1024 * 1024) throw new Error();
    const source = inspectRaster(bytes), image = nativeImage.createFromBuffer(bytes), size = image.getSize();
    if (image.isEmpty() || size.width !== source.width || size.height !== source.height) throw new Error();
    const png = image.toPNG(); if (png.length > 20 * 1024 * 1024) throw new Error();
    return png;
  } catch { throw new AiError('OUTPUT_INVALID'); }
}
