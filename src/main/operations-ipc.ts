import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IpcHandler } from './amazon-ipc.ts';
import type { CatalogService } from './catalog/service.ts';
import type { ProcurementService } from './procurement/service.ts';
import type { FollowupService } from './followup/service.ts';
import type { ProductDataService } from './product-data/service.ts';
import { identifier, record } from '../shared/validation.ts';
import { UserFacingError } from '../shared/errors.ts';
import { safeUrl } from './miaoshou/validation.ts';
import { procurementCsv, procurementHtml } from './procurement/export.ts';
import { writeFileAtomically } from './files.ts';
import type { ItemLabelService } from './item-labels/service.ts';
import type { ItemLabelSettings } from './item-labels/settings.ts';

export interface OperationsServices { catalog: CatalogService; procurement: ProcurementService; followup: FollowupService; productData?: ProductDataService; labels?: ItemLabelService; labelSettings?: ItemLabelSettings }
interface Hooks {
  selectDestination(name: string, extension: 'csv' | 'html'): Promise<{ canceled: boolean; filePath?: string }>;
  preview(assetId: string): Promise<Buffer | null>;
  openSource(url: string): Promise<void>;
  audit(action: string, summary: string): void;
}
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const inside = (root: string, path: string) => { const child = relative(canonical(root), canonical(path)); return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
async function exportDestination(directory: string, path: string, extension: string): Promise<string> {
  const reject = () => { throw new UserFacingError('请选择工作区数据文件夹以外的普通导出文件'); };
  if (!isAbsolute(path) || extname(path).toLowerCase() !== `.${extension}` || inside(directory, path)) reject();
  const root = await realpath(directory), parent = dirname(resolve(path)), actualParent = await realpath(parent), actual = join(actualParent, basename(path));
  if (inside(root, actual) || canonical(parent) !== canonical(actualParent) || (await lstat(parent)).isSymbolicLink()) reject();
  try { const info = await lstat(actual); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || canonical(await realpath(actual)) !== canonical(actual)) reject(); }
  catch (error) { if ((error as { code?: string })?.code !== 'ENOENT') throw error; }
  return actual;
}
export function installOperationsIpc(directory: string, services: OperationsServices, handle: IpcHandler, hooks: Hooks): void {
  const { catalog, procurement, followup } = services;
  if (services.productData) {
    const productData = services.productData;
    handle('red:product-data:get', 1, id => productData.get(identifier(id)));
    handle('red:product-data:sync', 1, id => productData.start(identifier(id)));
    handle('red:product-data:stop', 1, id => productData.stop(identifier(id)));
  }
  handle('red:catalog:get', 1, id => catalog.get(identifier(id)));
  handle('red:catalog:sync', 1, id => catalog.sync(identifier(id)));
  handle('red:catalog:search', 1, input => catalog.search(input));
  handle('red:followup:list', 0, () => followup.list());
  handle('red:followup:summary', 0, () => followup.summary());
  handle('red:followup:reschedule', 1, id => followup.reschedule(identifier(id)));
  handle('red:procurement:candidates', 0, () => procurement.candidates());
  handle('red:procurement:list', 0, () => procurement.list());
  handle('red:procurement:get', 1, id => procurement.get(id));
  handle('red:procurement:create', 1, input => { const batch = procurement.create(input); services.labels?.syncBatch(batch.id, { format: services.labelSettings?.get() }); hooks.audit('procurement.created', `创建备货批次 ${batch.code}（${batch.lines.length} 个 SKU）`); return procurement.get(batch.id); });
  handle('red:procurement:update', 1, input => { const batch = procurement.update(input); services.labels?.syncBatch(batch.id, { format: services.labelSettings?.get() }); hooks.audit('procurement.updated', `保存备货批次 ${batch.code}`); return procurement.get(batch.id); });
  handle('red:procurement:source', 1, raw => {
    const input = record(raw, '来源链接', ['batchId','lineId']), batch = procurement.get(input.batchId), line = batch.lines.find(row => row.id === identifier(input.lineId));
    if (!line?.sourceUrl || safeUrl(line.sourceUrl) !== line.sourceUrl) throw new UserFacingError('这一行尚无可用来源链接');
    return hooks.openSource(line.sourceUrl);
  });
  handle('red:procurement:export', 1, async raw => {
    const input = record(raw, '导出备货单', ['id','format']);
    if (input.format !== 'csv' && input.format !== 'html') throw new UserFacingError('请选择 CSV 或可打印备货单');
    const batch = procurement.get(input.id), format = input.format;
    const choice = await hooks.selectDestination(`${batch.code}.${format}`, format);
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    await exportDestination(directory, choice.filePath, format);
    const previews = new Map<string, string>(); let bytes = 0;
    if (format === 'html') for (const [index, line] of batch.lines.entries()) {
      if (!line.imageAssetId) continue;
      if (!previews.has(line.imageAssetId)) {
        const image = await hooks.preview(line.imageAssetId).catch(() => null);
        if (!image || image.length > 64 * 1024 || !image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new UserFacingError(`第 ${index+1} 行的本地商品图无法生成缩略图，请重新下载图片，或先导出 CSV`);
        previews.set(line.imageAssetId, `data:image/png;base64,${image.toString('base64')}`);
      }
      // HTML repeats inline bytes for each row, even when several SKUs share an asset.
      bytes += previews.get(line.imageAssetId)!.length;
      if (bytes > 64 * 1024 * 1024) throw new UserFacingError('本批图片总量过大，请拆分批次，或先导出 CSV；尚未写入不完整备货单');
    }
    const destination = await exportDestination(directory, choice.filePath, format);
    await writeFileAtomically(destination, format === 'csv' ? procurementCsv(batch) : procurementHtml(batch, previews));
    hooks.audit('procurement.exported', `导出备货批次 ${batch.code}（${format.toUpperCase()}）`);
    return { cancelled: false };
  });
}
