import { clipboard, dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { UserFacingError } from '../shared/errors.ts';
import { record } from '../shared/validation.ts';
import { createWorkspaceBackup, discardPreparedRestore, prepareWorkspaceRestore } from './backup.ts';
import type { PreparedRestore } from './backup.ts';
import type { IpcHandler } from './amazon-ipc.ts';

function passphrase(raw: unknown): string {
  const value = record(raw, '备份参数', ['passphrase']);
  if (typeof value.passphrase !== 'string' || value.passphrase.length < 12 || value.passphrase.length > 256) throw new UserFacingError('备份口令需要 12–256 个字符');
  return value.passphrase;
}

interface BackupHooks {
  beginRestore(): () => void;
  performRestore(prepared: PreparedRestore): Promise<void>;
  beforeBackup(): void;
  audit(action: string, summary: string, detail?: unknown): void;
}
export function installBackupIpc(window: BrowserWindow, directory: string, handle: IpcHandler, hooks: BackupHooks): void {
  handle('red:backup:copy-passphrase', 1, async raw => {
    const password = passphrase(raw);
    try {
      await clipboard.writeText(password);
      if (await clipboard.readText() !== password) throw new Error('Clipboard did not accept the passphrase');
    } catch { throw new UserFacingError('口令复制失败，请重试'); }
  });
  handle('red:backup:create', 1, async raw => {
    const password = passphrase(raw);
    const backupFolder = join(directory, 'backups'); await mkdir(backupFolder, { recursive: true });
    const result = await dialog.showSaveDialog(window, { title: '保存加密工作区备份（使用新文件名）', defaultPath: join(backupFolder, `HTC-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.htcbackup`), filters: [{ name: 'HTC 加密备份', extensions: ['htcbackup'] }] });
    if (result.canceled || !result.filePath) return { cancelled: true };
    hooks.beforeBackup();
    const info = await createWorkspaceBackup(directory, result.filePath, password);
    hooks.audit('workspace.backup.created', '创建加密工作区备份', { createdAt: info.createdAt, productCount: info.productCount, assetCount: info.assetCount, expiresAt: info.expiresAt });
    return { cancelled: false, path: result.filePath, ...info };
  });
  handle('red:backup:restore', 1, async raw => {
    const password = passphrase(raw), release = hooks.beginRestore();
    let prepared: PreparedRestore | undefined, replacing = false;
    try {
      const selected = await dialog.showOpenDialog(window, { title: '选择加密工作区备份', properties: ['openFile'], filters: [{ name: 'HTC 加密备份', extensions: ['htcbackup'] }] });
      if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
      prepared = await prepareWorkspaceRestore(directory, selected.filePaths[0], password);
      const choice = await dialog.showMessageBox(window, { type: 'warning', title: '恢复工作区', message: '用备份替换当前商品资料、图片和上架记录？',
        detail: `备份时间：${new Date(prepared.createdAt).toLocaleString('zh-CN')}\n${prepared.productCount} 件商品 · ${prepared.assetCount} 张图片\n\n恢复后将重新启动工作台。真实店铺需要重新导入授权配置；未确认结果的提交仍会保持锁定。`,
        buttons: ['取消', '替换并重启'], defaultId: 0, cancelId: 0, noLink: true });
      if (choice.response !== 1) return { cancelled: true };
      replacing = true;
      await hooks.performRestore(prepared);
      return { cancelled: false, createdAt: prepared.createdAt, productCount: prepared.productCount, assetCount: prepared.assetCount };
    } catch (error) {
      if (!replacing) hooks.audit('workspace.restore.failed', '工作区备份恢复失败，现有资料未更改');
      throw error;
    } finally {
      if (!replacing) {
        try { if (prepared) await discardPreparedRestore(directory, prepared); }
        finally { release(); }
      }
    }
  });
}
