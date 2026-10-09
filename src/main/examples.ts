import { nativeImage } from 'electron';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PreviewDecoder } from './assets.ts';
import { parseImport } from './import-export.ts';
import type { NewAsset, SampleLane, WorkspaceStore } from './store.ts';
import type { ProductSummary } from '../shared/contracts.ts';
import { UserFacingError } from '../shared/errors.ts';

/** Clearly labelled local sample illustrations. No downloaded product photos or seller information. */
function sampleImage(color: [number, number, number], coaster = false): Buffer {
  const size = 640, pixels = Buffer.alloc(size * size * 4);
  function pixel(x: number, y: number, rgb: number[]) {
    const i = (y * size + x) * 4;
    pixels[i] = rgb[2]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[0]; pixels[i + 3] = 255;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixel(x, y, [246 - y * .006, 247 - y * .005, 249 - y * .003]);
  function ellipse(cx: number, cy: number, rx: number, ry: number, rgb: number[]) {
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(size - 1, cy + ry); y++) for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(size - 1, cx + rx); x++)
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) pixel(x, y, rgb);
  }
  function rect(x0: number, y0: number, width: number, height: number, radius: number, rgb: number[]) {
    for (let y = y0; y < y0 + height; y++) for (let x = x0; x < x0 + width; x++) {
      const dx = Math.max(x0 + radius - x, 0, x - (x0 + width - radius - 1));
      const dy = Math.max(y0 + radius - y, 0, y - (y0 + height - radius - 1));
      if (dx * dx + dy * dy <= radius * radius) pixel(x, y, rgb);
    }
  }
  const dark = color.map(c => Math.max(0, c - 24)), light = color.map(c => Math.min(255, c + 18));
  if (coaster) {
    ellipse(326, 451, 177, 34, [220, 225, 231]);
    rect(176, 217, 310, 250, 52, dark); rect(160, 187, 310, 250, 52, color);
    for (let n = 0; n < 12; n++) rect(195, 220 + n * 15, 240, 3, 1, light);
  } else {
    ellipse(321, 505, 149, 23, [225, 229, 234]);
    rect(177, 191, 286, 308, 29, dark); rect(184, 187, 272, 304, 24, color);
    rect(182, 167, 276, 43, 10, light); rect(183, 188, 274, 6, 2, dark);
    for (let y = 219; y < 471; y += 13) { rect(198, y, 2, 5, 0, light); rect(441, y, 2, 5, 0, light); }
    rect(162, 178, 53, 7, 3, [83, 94, 99]); rect(424, 178, 52, 7, 3, [83, 94, 99]);
    rect(159, 180, 8, 57, 3, [83, 94, 99]); rect(470, 181, 8, 45, 3, [83, 94, 99]);
    rect(284, 326, 72, 45, 3, [244, 241, 230]); rect(294, 342, 51, 4, 1, [158, 156, 146]); rect(302, 352, 35, 3, 1, [177, 173, 160]);
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size }).toPNG();
}
const sampleLoads = new WeakMap<WorkspaceStore, Promise<ProductSummary[]>>();

export function loadExamples(store: WorkspaceStore, root: string, decode: PreviewDecoder): Promise<ProductSummary[]> {
  return queueExamples(store, root, decode, 'manual');
}
export function loadWorkspaceExamples(store: WorkspaceStore, root: string, decode: PreviewDecoder, lane: 'inbox' | 'automatic'): Promise<ProductSummary[]> {
  return queueExamples(store, root, decode, lane);
}
function queueExamples(store: WorkspaceStore, root: string, decode: PreviewDecoder, lane: SampleLane): Promise<ProductSummary[]> {
  // Serialize asynchronous file preparation, then check identity again in the database transaction.
  const pending = (sampleLoads.get(store) ?? Promise.resolve()).catch(() => {}).then(() => prepareExamples(store, root, decode, lane));
  sampleLoads.set(store, pending);
  return pending.finally(() => { if (sampleLoads.get(store) === pending) sampleLoads.delete(store); });
}
async function prepareExamples(store: WorkspaceStore, root: string, decode: PreviewDecoder, lane: SampleLane): Promise<ProductSummary[]> {
  if (store.getSampleProductIds(lane).length) return store.listProducts();
  const suffix = randomUUID().toUpperCase();
  const definitions = [
    { title: '棉质抽绳收纳袋', kind: false, specs: ['鼠尾草绿 / 大号', '米白 / 大号', '雾蓝 / 小号'], colors: [[137, 162, 150], [204, 196, 174], [133, 158, 181]], material: '棉', price: '1.80' },
    { title: '方形硅胶杯垫', kind: true, specs: ['灰绿', '砖红'], colors: [[132, 152, 146], [193, 131, 119]], material: '硅胶', price: '0.65' },
  ];
  const rows = definitions.map((d, i) => ({ title: d.title, sourceUrl: '', description: '本地示例数据，用于体验多 SKU 编辑和图片关联。示意图及数值均为演示内容，请勿用于实际采购或上架。',
    status: 'draft', variants: d.specs.map((spec, n) => ({ sku: `DEMO-${suffix}-${i + 1}-${n + 1}`, originalSpec: spec, normalizedSpec: '', purchasePrice: d.price, inventory: null })),
    facts: [{ name: '材质', value: d.material, source: 'manual', sourceRef: '演示内容', state: 'human_confirmed' }] }));
  const products = parseImport(JSON.stringify({ format: 'red-product-data', version: 1, products: rows }), 'json');
  const assets: NewAsset[][] = [], written: string[] = [];
  let committed = false;
  async function writeNewFile(path: string, bytes: Buffer) {
    const file = await open(path, 'wx'); written.push(path);
    try { await file.writeFile(bytes); } finally { await file.close(); }
  }
  try {
    await mkdir(join(root, 'assets'), { recursive: true });
    for (const [index, definition] of definitions.entries()) {
      const images: NewAsset[] = [];
      for (const [variantIndex, color] of definition.colors.entries()) {
        const id = randomUUID(), original = sampleImage(color as [number, number, number], definition.kind), preview = decode(original);
        if (!preview.length) throw new UserFacingError('本地示例图片生成失败，请重新载入');
        const asset: NewAsset = { id, fileName: `本地示例-${index + 1}-${variantIndex + 1}.png`, mimeType: 'image/png', width: 640, height: 640,
          byteSize: original.length, originalPath: `assets/${id}.png`, previewPath: `assets/${id}.preview.png`, sha256: createHash('sha256').update(original).digest('hex') };
        await writeNewFile(join(root, asset.originalPath), original); await writeNewFile(join(root, asset.previewPath), preview);
        images.push(asset);
      }
      assets.push(images);
    }
    // A failed image preparation never leaves a persisted, incomplete sample group.
    committed = store.importSampleProducts(lane, products, assets).created;
    return store.listProducts();
  } finally {
    // Remove only this attempt's UUID files if it failed or another caller created the group first.
    if (!committed) await Promise.all(written.map(path => unlink(path).catch(() => {})));
  }
}
