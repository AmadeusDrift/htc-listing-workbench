import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { IpcHandler } from './amazon-ipc.ts';
import type { ItemLabelService } from './item-labels/service.ts';
import type { ItemLabelSettings } from './item-labels/settings.ts';
import type { ProcurementService } from './procurement/service.ts';
import type { ShipmentDocumentService } from './procurement/shipment-documents.ts';
import { identifier, record } from '../shared/validation.ts';
import { UserFacingError } from '../shared/errors.ts';

export interface LabelServices { labels: ItemLabelService; labelSettings: ItemLabelSettings; shipmentDocuments: ShipmentDocumentService; procurement: ProcurementService }
interface Hooks {
  selectFolder(): Promise<{ canceled: boolean; filePaths: string[] }>;
  selectPdf(): Promise<{ canceled: boolean; filePaths: string[] }>;
  openPath(path: string): Promise<string>;
  audit(action: string, summary: string): void;
}
export function installItemLabelIpc(directory: string, services: LabelServices, handle: IpcHandler, hooks: Hooks): void {
  const { labels, labelSettings, shipmentDocuments, procurement } = services;
  handle('red:item-labels:format', 0, () => labelSettings.get());
  handle('red:item-labels:save-format', 1, raw => labelSettings.save(raw));
  handle('red:item-labels:list', 1, raw => {
    const input = raw === undefined ? {} : record(raw, '标签筛选', ['batchId','jobId']);
    return labels.list({ ...(input.batchId === undefined ? {} : { batchId: identifier(input.batchId) }), ...(input.jobId === undefined ? {} : { jobId: identifier(input.jobId) }) });
  });
  handle('red:item-labels:get', 1, id => labels.get(identifier(id)));
  handle('red:item-labels:prepare', 1, id => labels.prepareBatch(identifier(id), { format: labelSettings.get() }));
  handle('red:item-labels:retry', 1, id => labels.retry(identifier(id)));
  handle('red:item-labels:open', 1, async raw => {
    const input = record(raw, '打开标签', ['id','fileIndex']);
    if (!Number.isSafeInteger(input.fileIndex) || Number(input.fileIndex) < 1) throw new UserFacingError('标签文件序号无效');
    const result = await labels.verifyFiles(identifier(input.id)), file = result.files.find(value => value.descriptor.index === input.fileIndex);
    if (!file) throw new UserFacingError('标签文件不存在');
    if (await hooks.openPath(file.path)) throw new UserFacingError('无法打开标签 PDF，请先安装 PDF 阅读程序');
  });
  handle('red:item-labels:export', 1, async raw => {
    const batchId = identifier(raw), batch = procurement.get(batchId);
    await labels.filesForBatch(batchId);
    const selection = await hooks.selectFolder(); if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
    const chosen = selection.filePaths[0];
    if (!isAbsolute(chosen)) throw new UserFacingError('请选择完整的导出目录');
    const root = await realpath(directory), parent = await realpath(chosen), child = relative(root, parent);
    if (!child || child !== '..' && !child.startsWith('..\\') && !child.startsWith('../') && !isAbsolute(child)
      || resolve(parent).toLowerCase() !== resolve(chosen).toLowerCase() || (await lstat(chosen)).isSymbolicLink()) throw new UserFacingError('请导出到工作区数据目录以外的普通文件夹');
    const files = await labels.filesForBatch(batchId), folder = join(parent, 'HTC-labels-' + batchId + '-' + randomUUID());
    // Every PDF is verified before creating the destination. The manifest records exact sales-unit quantities.
    const snapshot = files.map(file => file.record); labels.assertBatchSnapshot(batchId, snapshot);
    await mkdir(folder);
    const manifest = [];
    try {
    labels.assertBatchSnapshot(batchId, snapshot);
    for (const file of files) {
      const name = file.record.id + '-' + file.descriptor.index + '.pdf';
      await writeFile(join(folder, name), file.bytes, { flag: 'wx' });
      manifest.push({ file: name, sha256: file.descriptor.sha256, batchId, batchCode: batch.code, sellerId: file.record.sellerId, marketplaceId: file.record.marketplaceId,
        sku: file.record.sku, quantity: file.record.quantity, format: file.record.format, version: file.record.version });
    }
    await writeFile(join(folder, 'manifest.json'), JSON.stringify({ batchId, files: manifest }, null, 2), { flag: 'wx' });
    labels.assertBatchSnapshot(batchId, snapshot);
    } catch (error) {
      // This directory was created exclusively above; never remove the chosen parent.
      if (relative(parent, folder).startsWith('HTC-labels-') && (await lstat(folder)).isDirectory() && !(await lstat(folder)).isSymbolicLink()) await rm(folder, { recursive: true, force: true });
      throw error;
    }
    hooks.audit('item-labels.exported', `导出备货批次 ${batch.code} 的 ${files.length} 个标签 PDF`);
    return { cancelled: false };
  });
  handle('red:shipment-documents:list', 1, id => shipmentDocuments.list(identifier(id)));
  handle('red:shipment-documents:import', 1, async raw => {
    const id = identifier(raw); if (!procurement.get(id).shipment?.confirmationId) throw new UserFacingError('请先保存已创建的货件编号');
    const selection = await hooks.selectPdf(); if (selection.canceled || !selection.filePaths[0]) return null;
    const doc = await shipmentDocuments.importDocument(id, selection.filePaths[0]); hooks.audit('shipment-document.imported', '已归档货件 ' + doc.shipmentId + ' 的箱唛 PDF（人工附件）'); return doc;
  });
  handle('red:shipment-documents:open', 1, async id => { if (await hooks.openPath(await shipmentDocuments.file(identifier(id)))) throw new UserFacingError('无法打开箱唛 PDF'); });
}
