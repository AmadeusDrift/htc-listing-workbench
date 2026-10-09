import { nativeImage } from 'electron';
import { createHash } from 'node:crypto';

/** Local diagram for exercising imports. The UI and product are explicitly marked as demo data. */
export function miaoshouDemoImage(id: string): Buffer {
  const seed = createHash('sha256').update(id).digest(), size = 320, pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const position = (y * size + x) * 4;
    const inShape = x > 62 && x < 258 && y > 80 && y < 246;
    pixels[position] = inShape ? 95 + seed[0] % 95 : 245;
    pixels[position + 1] = inShape ? 95 + seed[1] % 95 : 247;
    pixels[position + 2] = inShape ? 95 + seed[2] % 95 : 250;
    pixels[position + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size }).toPNG();
}
