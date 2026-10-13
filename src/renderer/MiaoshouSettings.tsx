import { useFormGuard } from './FormGuard';
import { useEffect, useState } from 'react';
import { Download, Plug, RefreshCw, Unplug } from 'lucide-react';
import type { MiaoshouPreferences, MiaoshouStatus } from '../shared/miaoshou-contracts';
import { errorText } from './utils';
import { SecretField } from './SecretField';
import { SettingsStatusBadge } from './SettingsStatusBadge';

const modeLabels = { unconfigured: '尚未配置', demo: '演示模式 · 不访问妙手', live: '真实接口 · 等待实际调用验证' };
export function MiaoshouSettings({ busy }: { busy: boolean }) {
  const [status, setStatus] = useState<MiaoshouStatus | null>(null);
  const [preferences, setPreferences] = useState<MiaoshouPreferences | null>(null), [savingPreferences, setSavingPreferences] = useState(false);
  const [appKey, setAppKey] = useState(''), [appSecret, setAppSecret] = useState('');
  const [working, setWorking] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { let active = true; void window.red.getMiaoshouStatus().then(value => { if (active) setStatus(value); }, cause => { if (active) setError(errorText(cause)); }); return () => { active = false; }; }, []);
  useEffect(() => { let active = true; void window.red.getMiaoshouPreferences().then(value => { if (active) setPreferences(value); }, cause => { if (active) setError(errorText(cause)); }); return () => { active = false; }; }, []);
  async function savePreferences(autoSyncOnInbox: boolean) {
    if (busy || working || savingPreferences || !preferences) return;
    const previous = preferences;
    setPreferences({ autoSyncOnInbox }); setSavingPreferences(true); setError(''); setNotice('');
    try { setPreferences(await window.red.saveMiaoshouPreferences({ autoSyncOnInbox })); setNotice(autoSyncOnInbox ? '已开启：进入采集箱时自动检查并导入。' : '已关闭自动检查，仍可随时手动同步。'); }
    catch (cause) { setPreferences(previous); setError(errorText(cause)); }
    finally { setSavingPreferences(false); }
  }
  async function action(task: () => Promise<unknown>, message: string) {
    if (working) return; setWorking(true); setError(''); setNotice('');
    try { const result = await task(); setStatus(await window.red.getMiaoshouStatus()); if (!(result && typeof result === 'object' && 'cancelled' in result && result.cancelled)) setNotice(message); }
    catch (cause) { setError(errorText(cause)); } finally { setWorking(false); }
  }
  const disabled = busy || working || savingPreferences || !status;
  async function save() {
    if (disabled || appKey.trim().length < 8 || appSecret.trim().length < 8) return false;
    let success = false;
    await action(async () => {
      const result = await window.red.saveMiaoshouConfig({ appKey: appKey.trim(), appSecret: appSecret.trim() });
      setAppKey(''); setAppSecret(''); success = true; return result;
    }, '配置已加密保存。到采集箱点击“同步妙手采集箱”导入商品。');
    return success;
  }
  useFormGuard({ dirty: () => !!(appKey || appSecret), save, discard: () => { setAppKey(''); setAppSecret(''); } });
  return <section className="settings-section" aria-label="妙手采集设置">
    <div className="settings-section-title"><Plug size={19} /><div><h3>妙手公共采集箱</h3><p>先在妙手采集，再一键同步商品与全部 SKU 到工作台。</p></div></div>
    <div className="miaoshou-auto-setting"><div><h4>进入采集箱时自动检查并导入</h4><p id="miaoshou-auto-help">开启后，每次进入采集箱都会检查妙手并导入新增商品。默认关闭；手动同步始终可用。</p></div><label className="inbox-auto-toggle"><input type="checkbox" role="switch" aria-label="进入采集箱时自动检查并导入" aria-describedby="miaoshou-auto-help" checked={preferences?.autoSyncOnInbox ?? false} disabled={busy || working || savingPreferences || !preferences} onChange={event => void savePreferences(event.target.checked)} /><span aria-hidden="true"><i /></span></label></div>
    <dl className="settings-values"><div><dt>当前模式</dt><dd><SettingsStatusBadge tone={status ? status.mode === 'unconfigured' ? 'neutral' : 'info' : error ? 'danger' : 'info'}>{status ? modeLabels[status.mode] : error ? '读取失败' : '正在读取…'}</SettingsStatusBadge></dd></div><div><dt>应用标识</dt><dd>{status?.appKeyHint || <SettingsStatusBadge tone="neutral">尚未配置</SettingsStatusBadge>}</dd></div></dl>
    <form className="credential-form" aria-label="妙手连接配置" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="credential-fields"><SecretField label="AppKey" value={appKey} onChange={setAppKey} disabled={disabled} maxLength={256} /><SecretField label="AppSecret" value={appSecret} onChange={setAppSecret} disabled={disabled} /></div>
      <p className="settings-help">填写妙手开放平台应用的 AppKey 和 AppSecret。当前采集箱接口不需要另填 Token；请求签名由工作台生成。更新连接时请重新填写两项。</p>
      <div className="workflow-actions"><button type="submit" className="button primary" disabled={disabled || appKey.trim().length < 8 || appSecret.trim().length < 8}>保存妙手连接</button></div>
    </form>
    <div className="workflow-actions">
      <button className="button secondary" disabled={disabled} onClick={() => void action(() => window.red.exportMiaoshouConfigTemplate(), '配置模板已保存，填写 AppKey 和 AppSecret 后导入。')}><Download size={15} />保存妙手配置模板</button>
      <button className="button secondary" disabled={disabled} onClick={() => void action(async () => { const result = await window.red.importMiaoshouConfig(); if (!result.cancelled) { setAppKey(''); setAppSecret(''); } return result; }, '配置已加密保存。到采集箱点击“同步妙手采集箱”导入商品。')}><Plug size={15} />导入妙手配置</button>
      <button className="button secondary" disabled={disabled} onClick={() => void action(() => window.red.setMiaoshouMode('demo'), '已切换到演示模式，可在采集箱体验导入。')}>启用妙手演示模式</button>
      <button className="button secondary" disabled={disabled || !status?.configured || status.mode === 'live'} onClick={() => void action(() => window.red.setMiaoshouMode('live'), '已切换到真实接口。')}><RefreshCw size={15} />使用妙手真实接口</button>
      <button className="button secondary" disabled={disabled || !status?.configured} onClick={() => void action(() => window.red.disconnectMiaoshou(), '妙手配置已断开，已导入的商品仍然保留。')}><Unplug size={15} />断开妙手配置</button>
    </div>
    {notice && <p className="workflow-notice" role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    <p className="settings-help">申请“公共采集箱列表”和“公共采集箱详情”的读取权限。没有权限时可以先用演示模式。密钥在本机加密保存，保存后不回显；换机恢复后重新填写或导入。</p>
  </section>;
}
