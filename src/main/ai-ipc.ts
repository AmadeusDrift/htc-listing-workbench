import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { open } from 'node:fs/promises';
import type { IpcHandler } from './amazon-ipc.ts';
import type { AiService } from './ai/service.ts';
import type { WorkspaceStore } from './store.ts';
import { keys, providerId, vendorId } from './ai/validation.ts';
import type { AiConnection } from '../shared/ai-connection-contracts.ts';
import { UserFacingError } from '../shared/errors.ts';
import { identifier } from '../shared/validation.ts';
import { writeFileAtomically } from './files.ts';

/** File import and direct form entry share the service's strict validation and encrypted vault. */
async function readConfig(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 16 * 1024) throw new UserFacingError('AI 配置文件需要是 16 KB 以内的 JSON 文件');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw new UserFacingError('配置文件读取期间发生变化，请重新选择'); offset += bytesRead; }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new UserFacingError('配置文件读取期间发生变化，请重新选择');
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new UserFacingError('AI 配置 JSON 格式不正确'); }
  } finally { await file.close(); }
}

export function installAiIpc(window: BrowserWindow, ai: AiService, store: WorkspaceStore, handle: IpcHandler): void {
  const auditConnection = (action: string, summary: string, connection: AiConnection) => store.recordWorkspaceEvent(action, summary,
    { vendorId: connection.id, profiles: connection.profiles.map(({ id, generation }) => ({ id, generation })) });
  handle('red:ai:connections', 0, () => ai.listConnections());
  handle('red:ai:connection-save', 1, raw => {
    const connection = ai.saveConnection(raw);
    auditConnection('ai.connection.saved', '已保存供应商共用凭据，各功能保持原启用状态', connection);
    return connection;
  });
  handle('red:ai:connection-reuse', 1, raw => {
    const connection = ai.reuseConnection(raw);
    auditConnection('ai.connection.reused', '已为同一供应商的功能复用所选凭据', connection);
    return connection;
  });
  handle('red:ai:function-settings', 1, raw => {
    const connection = ai.saveFunctionSettings(raw), id = providerId(keys(raw, ['id', 'model', 'enabled']).id);
    store.recordWorkspaceEvent('ai.function.saved', '已保存 AI 功能模型与启用设置', { providerId: id, generation: connection.profiles.find(profile => profile.id === id)!.generation });
    return connection;
  });
  handle('red:ai:connection-disconnect', 1, raw => {
    const connection = ai.disconnectConnection(raw);
    auditConnection('ai.connection.disconnected', '已清除供应商共用凭据并停用相关功能', connection);
    return connection;
  });
  handle('red:ai:connection-import', 0, async () => {
    const selected = await dialog.showOpenDialog(window, { title: '导入供应商共用 AI 凭据（旧格式也将用于该供应商的两个功能）', properties: ['openFile'], filters: [{ name: 'AI 供应商配置', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const connection = ai.importConnectionConfig(await readConfig(selected.filePaths[0]));
    auditConnection('ai.connection.imported', '已导入供应商共用凭据，各功能保持原启用状态', connection);
    return connection;
  });
  handle('red:ai:connection-template', 1, async raw => {
    const id = vendorId(raw), template = ai.connectionTemplate(id);
    const selected = await dialog.showSaveDialog(window, { title: '导出供应商共用 AI 凭据空白模板', defaultPath: `HTC-AI-${id}-connection.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePath) return { cancelled: true };
    await writeFileAtomically(selected.filePath, JSON.stringify(template, null, 2) + '\n');
    return { cancelled: false };
  });
  handle('red:ai:providers', 0, () => ai.listProfiles());
  handle('red:ai:capabilities', 0, () => ai.capabilities());
  handle('red:ai:save', 1, raw => {
    const profile = ai.importProfile(raw);
    store.recordWorkspaceEvent('ai.profile.saved', '已保存 AI 服务配置，等待启用', { providerId: profile.id, generation: profile.generation });
    return profile;
  });
  handle('red:ai:import', 0, async () => {
    const selected = await dialog.showOpenDialog(window, { title: '导入 AI 服务配置（凭据仅保存在本机加密库）', properties: ['openFile'], filters: [{ name: 'AI 服务配置', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const profile = ai.importProfile(await readConfig(selected.filePaths[0]));
    store.recordWorkspaceEvent('ai.profile.imported', '已导入 AI 服务配置，等待启用', { providerId: profile.id, generation: profile.generation });
    return profile;
  });
  handle('red:ai:template', 1, async raw => {
    const id = providerId(raw), template = ai.template(id);
    const selected = await dialog.showSaveDialog(window, { title: '导出 AI 配置空白模板', defaultPath: `HTC-AI-${id}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePath) return { cancelled: true };
    await writeFileAtomically(selected.filePath, JSON.stringify(template, null, 2) + '\n');
    return { cancelled: false };
  });
  handle('red:ai:enable', 1, raw => ai.setEnabled(raw));
  handle('red:ai:disconnect', 1, raw => {
    const profile = ai.disconnect(providerId(raw));
    store.recordWorkspaceEvent('ai.profile.disconnected', '已断开 AI 服务授权', { providerId: profile.id });
    return profile;
  });
  handle('red:ai:ocr', 1, raw => ai.recognize(raw));
  handle('red:ai:segment', 1, raw => ai.segment(raw));
  handle('red:ai:suggest', 1, raw => ai.suggest(raw));
  handle('red:ai:review', 1, raw => ai.review(raw));
  handle('red:ai:results', 1, raw => ai.listResults(identifier(raw)));
  handle('red:ai:calls', 0, () => ai.listCalls());
  handle('red:ai:results-query', 1, raw => ai.queryResults(raw));
  handle('red:ai:calls-query', 1, raw => ai.queryCalls(raw));
  handle('red:ai:usage-policy', 1, raw => ai.getUsagePolicy(providerId(raw)));
  handle('red:ai:usage-policy-save', 1, raw => ai.setUsagePolicy(raw));
  handle('red:ai:usage-summary', 1, raw => ai.getUsageSummary(providerId(raw)));
}
