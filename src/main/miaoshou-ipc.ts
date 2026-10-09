import { readFile, stat } from 'node:fs/promises';
import { UserFacingError } from '../shared/errors.ts';
import type { IpcHandler } from './amazon-ipc.ts';
import type { MiaoshouService } from './miaoshou/service.ts';
import { MIAOSHOU_CONFIG_TEMPLATE } from './miaoshou/service.ts';
import type { MiaoshouImageService } from './miaoshou/images.ts';

export interface MiaoshouDialogs {
  selectConfig(): Promise<{ canceled: boolean; filePaths: string[] }>;
  saveTemplate(content: string): Promise<{ cancelled: boolean }>;
}
export function installMiaoshouIpc(service: MiaoshouService, images: MiaoshouImageService, handle: IpcHandler, dialogs: MiaoshouDialogs): void {
  handle('red:miaoshou:status', 0, () => service.getStatus());
  handle('red:miaoshou:preferences', 0, () => service.getPreferences());
  handle('red:miaoshou:preferences-save', 1, input => service.savePreferences(input));
  handle('red:miaoshou:inbox-sync', 1, input => service.syncInbox(input));
  handle('red:miaoshou:inbox-summaries', 1, input => service.inboxSummaries(input));
  handle('red:miaoshou:image-preview', 1, input => images.preview(input));
  handle('red:miaoshou:source-update', 1, id => service.getSourceUpdate(id));
  handle('red:miaoshou:config-save', 1, raw => service.importConfig(raw));
  handle('red:miaoshou:config-template', 0, () => dialogs.saveTemplate(JSON.stringify(MIAOSHOU_CONFIG_TEMPLATE, null, 2) + '\n'));
  handle('red:miaoshou:config-import', 0, async () => {
    const result = await dialogs.selectConfig(); if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    const info = await stat(result.filePaths[0]); if (!info.isFile() || info.size > 65536) throw new UserFacingError('妙手配置文件不能超过 64 KB');
    const bytes = await readFile(result.filePaths[0]); if (bytes.length > 65536) throw new UserFacingError('妙手配置文件不能超过 64 KB');
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
    catch { throw new UserFacingError('妙手配置不是有效的 UTF-8 JSON，请按模板填写'); }
    return { cancelled: false, status: service.importConfig(raw) };
  });
  handle('red:miaoshou:mode', 1, mode => service.setMode(mode));
  handle('red:miaoshou:disconnect', 0, () => service.disconnect());
  handle('red:miaoshou:list', 1, input => service.listProducts(input));
  handle('red:miaoshou:preview', 1, input => service.previewProduct(input));
  handle('red:miaoshou:import', 1, input => service.importProduct(input));
  handle('red:miaoshou:receipt', 1, id => service.getReceipt(id));
  handle('red:miaoshou:images', 1, input => images.download(input));
  handle('red:miaoshou:sync-status', 0, () => service.getSyncStatus());
  handle('red:miaoshou:sync-start', 1, input => service.startSync(input));
  handle('red:miaoshou:sync-pause', 0, () => service.pauseSync());
  handle('red:miaoshou:sync-resume', 0, () => service.resumeSync());
  handle('red:miaoshou:sync-retry', 0, () => service.retrySyncFailures());
  handle('red:miaoshou:sync-items', 1, input => service.listSyncItems(input));
  handle('red:miaoshou:sync-preview', 1, input => service.previewSyncedProduct(input));
}
