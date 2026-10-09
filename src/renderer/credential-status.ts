import type { CredentialStatus } from '../shared/credential-status.ts';
import type { SettingsStatusTone } from './SettingsStatusBadge.tsx';
import type { AiConnection, AiFunctionSettingsInput } from '../shared/ai-connection-contracts.ts';
import type { AiProfile, AiProviderId } from '../shared/ai-contracts.ts';

export function aiFunctionSettingsInput(connection: AiConnection, id: AiProviderId, change: Partial<Pick<AiProfile, 'model' | 'enabled'>>): AiFunctionSettingsInput {
  const profile = connection.profiles.find(item => item.id === id), credential = connection.credentials.find(item => item.id === id);
  if (!profile || !credential) throw new Error('功能设置未加载，请重新打开连接设置');
  return { id, model: change.model ?? profile.model, enabled: change.enabled ?? credential.storedEnabled };
}

export function credentialPresentation(status: CredentialStatus): { label: string; tone: SettingsStatusTone; detail: string } {
  switch (status.state) {
    case 'absent': return status.storedConfigured
      ? { label: '凭据文件缺失', tone: 'danger', detail: '配置记录仍在，但本机凭据文件缺失。请核对原工作区，或重新保存凭据。' }
      : { label: '尚未配置', tone: 'neutral', detail: '' };
    case 'encryption-unavailable': return { label: '系统加密暂不可用', tone: 'danger', detail: '本机凭据仍保留。请确认原 Windows 用户，待系统加密服务恢复后重启应用；保存的启停意图不会改变。' };
    case 'unreadable': return { label: '已保存但无法读取', tone: 'danger', detail: '本机加密文件仍在，当前环境无法读取。请确认原 Windows 用户和工作区后重试；需要更换凭据时再重新保存。' };
    case 'metadata-mismatch': return { label: '配置记录不一致', tone: 'warning', detail: '已保存的凭据与当前配置记录不匹配，或连接已明确断开。不会自动启用；请核对工作区，或重新保存凭据确认连接。' };
    case 'configured-disabled': return { label: '已保存 · 未启用', tone: 'neutral', detail: '' };
    case 'ready': return { label: '已启用', tone: 'success', detail: '' };
  }
}
