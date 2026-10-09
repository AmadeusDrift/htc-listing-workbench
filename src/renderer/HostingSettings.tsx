import { useEffect, useRef, useState } from 'react';
import { Download, FileInput, RefreshCw, Server } from 'lucide-react';
import type { HostingProfile } from '../shared/hosting-contracts';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import { errorText } from './utils';

export function HostingSettings({ busy }: { busy: boolean }) {
  const api = window.red;
  const [profiles, setProfiles] = useState<HostingProfile[]>([]);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void api.listFtpProfiles().then(value => { if (mounted.current) setProfiles(value); }, cause => { if (mounted.current) setError(errorText(cause)); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [api]);
  async function action(work: () => Promise<string | void>) {
    if (busy || pending) return;
    setPending(true); setError(''); setNotice('');
    try { const message = await work(), values = await api.listFtpProfiles(); if (mounted.current) { setProfiles(values); if (message) setNotice(message); } }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setPending(false); }
  }
  const disabled = busy || loading || pending;
  return <section className="settings-section hosting-settings" aria-label="图片托管服务器设置">
    <div className="settings-section-title"><Server size={19} /><div><h3>图片托管</h3><p>配置用于上传商品图片的服务器，自动任务会检查上传结果与公开地址。</p></div></div>
    <div className="workflow-actions"><button type="button" className="button primary" disabled={disabled} onClick={() => { void action(async () => { const value = await api.importFtpProfile(); return value ? `${value.name} 配置已导入，请启用后在自动上架中选择。` : undefined; }); }}><FileInput size={15} />导入托管配置</button><button type="button" className="button secondary" disabled={disabled} onClick={() => { void action(async () => undefined); }}><RefreshCw size={15} />刷新托管配置</button></div>
    <p className="small-copy">先下载对应服务器的配置模板，填写 FTP 地址、公开图片地址与登录信息，再导入。登录凭据由本机加密保存，页面不显示账号和密码。</p>
    {loading && <p role="status">正在读取托管配置…</p>}{error && <p className="workflow-notice" role="alert">{error}</p>}{notice && <p className="workflow-notice" role="status">{notice}</p>}
    <div className="hosting-profile-list">{profiles.map(profile => <article className="hosting-profile" key={profile.id}>
      <div className="hosting-profile-heading"><strong>{profile.name}</strong><Badge tone={!profile.configured ? 'neutral' : profile.enabled ? 'success' : 'warning'}>{!profile.configured ? '尚未配置' : profile.enabled ? '已启用' : '已配置，未启用'}</Badge></div>
      {profile.configured && <dl className="settings-values"><div><dt>服务器</dt><dd>{profile.host}:{profile.port} · {profile.secure ? '加密连接' : 'FTP'}</dd></div><div><dt>公开地址</dt><dd className="path-value">{profile.publicBaseUrl}</dd></div><div><dt>远程目录</dt><dd className="path-value">{profile.remoteRoot || '/'}</dd></div></dl>}
      <div className="workflow-actions"><button type="button" className="button secondary" disabled={disabled} onClick={() => { void action(async () => { const value = await api.exportFtpProfileTemplate(profile.id); return value.cancelled ? undefined : `${profile.name} 配置模板已导出`; }); }}><Download size={14} />下载 {profile.name} 模板</button><button type="button" className="button secondary" disabled={disabled || !profile.configured} onClick={() => { void action(async () => { const value = await api.setFtpProfileEnabled({ id:profile.id, enabled:!profile.enabled }); return `${value.name} 已${value.enabled ? '启用' : '停用'}`; }); }}>{profile.enabled ? '停用' : '启用'} {profile.name}</button></div>
    </article>)}</div>
  </section>;
}
