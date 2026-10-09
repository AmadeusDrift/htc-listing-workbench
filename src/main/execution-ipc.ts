import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import type { IpcHandler } from './amazon-ipc.ts';
import type { HostingService } from './hosting/service.ts';
import type { ExecutionService } from './execution/service.ts';
import type { WorkspaceStore } from './store.ts';
import { UserFacingError } from '../shared/errors.ts';
import { identifier } from '../shared/validation.ts';
import { profileId } from './hosting/validation.ts';
import { writeFileAtomically } from './files.ts';

export function installExecutionIpc(window: BrowserWindow, hosting: HostingService, execution: ExecutionService, store: WorkspaceStore, handle: IpcHandler): void {
  handle('red:hosting:profiles', 0, () => hosting.listProfiles());
  handle('red:hosting:uploads', 0, () => hosting.listUploads());
  handle('red:hosting:enable', 1, raw => hosting.setEnabled(raw));
  handle('red:hosting:import', 0, async () => {
    const result = await dialog.showOpenDialog(window, { title: '导入 FTP 配置（仅保存在本机加密凭据库）', properties: ['openFile'], filters: [{ name: 'FTP 配置', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = result.filePaths[0]; if ((await stat(path)).size > 16 * 1024) throw new UserFacingError('FTP 配置文件不能超过 16 KB');
    let parsed: unknown; try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw new UserFacingError('FTP 配置 JSON 格式不正确'); }
    const profile = hosting.importProfile(parsed);
    store.recordWorkspaceEvent('hosting.profile.imported', `已导入 FTP 配置 ${profile.name}`, { profileId: profile.id, generation: profile.generation }); return profile;
  });
  handle('red:hosting:template', 1, async raw => {
    const profile = hosting.getProfile(profileId(raw));
    const result = await dialog.showSaveDialog(window, { title: '导出 FTP 配置模板', defaultPath: `HTC-FTP-${profile.id}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { cancelled: true };
    await writeFileAtomically(result.filePath, JSON.stringify({ id: profile.id, host: '', port: 2121, secure: false, username: '', password: '', remoteRoot: '/', publicBaseUrl: profile.publicBaseUrl }, null, 2) + '\n');
    return { cancelled: false };
  });
  handle('red:execution:list', 0, () => execution.list());
  handle('red:execution:get', 1, raw => execution.get(identifier(raw)));
  handle('red:execution:create', 1, raw => {
    const task = execution.create(raw); store.recordWorkspaceEvent('execution.created', `已建立自动上架任务 · ${task.items.length} 个 SKU`, { taskId: task.id }); return task;
  });
  handle('red:execution:start', 1, async raw => {
    const approved = execution.prepareStart(identifier(raw));
    const live = approved.items.some(item => item.mode === 'live');
    const detail = approved.items.map(item => `${item.mode === 'demo' ? '[本地演示] ' : ''}${item.targetName} · ${item.sellerId} · ${item.marketplaceId}\nSKU：${item.sku}`).join('\n\n');
    const answer = await dialog.showMessageBox(window, { type: 'question', title: live ? '启动自动上架任务' : '启动本地演示任务',
      message: `启动 ${approved.items.length} 个 SKU 的自动流程？`,
      detail: `并发：${approved.concurrency} 个 SKU\nFTP：${approved.profileId} · 配置版本 ${approved.profileGeneration}\n\n${detail}\n\n图片将上传到所选 FTP。${live ? '校验和预览通过后会自动正式发布，仅异常时转人工。' : 'Amazon 操作仅生成本地演示结果。'}已完成的上传和提交不会因暂停或取消而撤销。`,
      buttons: ['取消', live ? '启动并自动发布' : '启动演示'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return null;
    const task = execution.startAuthorized(approved); store.recordWorkspaceEvent('execution.started', '已确认任务范围并启动自动流程', { taskId: task.id }); return task;
  });
  handle('red:execution:pause', 1, raw => execution.pause(identifier(raw)));
  handle('red:execution:cancel', 1, raw => execution.cancel(identifier(raw)));
}
