import { useFormGuard } from './FormGuard';
import { useEffect, useState } from 'react';
import { Download, FileKey2, History, Pause, Play, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import type { AmazonCallEvent, AmazonCredentialDiagnostics, AmazonDataPolicy, AmazonTarget } from '../shared/amazon-contracts';
import type { TaskRunner } from './amazon-ui';
import { errorText, formatDate } from './utils';
import { AmazonConnectionForm } from './AmazonConnectionForm';
import { SettingsStatusBadge } from './SettingsStatusBadge';
import { credentialPresentation } from './credential-status';

export function AmazonSettings({ targets, busy, run, onTargetsChanged }: { targets: AmazonTarget[]; busy: boolean; run: TaskRunner; onTargetsChanged: () => Promise<void> }) {
  const api = window.red;
  const [policy, setPolicy] = useState<AmazonDataPolicy | null>(null);
  const [retention, setRetention] = useState('180');
  const [calls, setCalls] = useState<AmazonCallEvent[]>([]);
  const [notice, setNotice] = useState('');
  const [credentials, setCredentials] = useState<AmazonCredentialDiagnostics | null>(null), [credentialError, setCredentialError] = useState('');
  useEffect(() => {
    let active = true;
    void api.getAmazonCredentialDiagnostics().then(value => { if (active) { setCredentials(value); setCredentialError(''); } }).catch(cause => { if (active) setCredentialError(errorText(cause)); });
    return () => { active = false; };
  }, [api, targets]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getAmazonDataPolicy(), api.listAmazonCalls()]).then(([value, events]) => {
      if (!cancelled) { setPolicy(value); setRetention(String(value.retentionDays)); setCalls(events); }
    }).catch(cause => { if (!cancelled) setNotice(errorText(cause)); });
    return () => { cancelled = true; };
  }, [api]);
  async function refresh() { await onTargetsChanged(); setCalls(await api.listAmazonCalls()); }
  async function saveRetention() {
    const days = Number(retention);
    if (busy || !Number.isInteger(days) || days < 1 || days > 548) return false;
    return await run('正在保存数据保留设置…', async () => {
      const value = await api.saveAmazonDataPolicy({ retentionDays: days }); setPolicy(value); setNotice('数据保留期限已保存。'); return true;
    }) === true;
  }
  useFormGuard({ dirty: () => !!policy && Number(retention) !== policy.retentionDays, save: saveRetention, discard: () => { if (policy) setRetention(String(policy.retentionDays)); } });
  return <section className="settings-section amazon-settings"><div className="settings-section-title"><ShieldCheck size={19} /><div><h3>Amazon 店铺连接</h3><p>选择一个目标店铺准备 Listing，也可以先使用本地演示。</p></div></div>
    {credentialError && <p className="workflow-warning" role="alert">凭据状态读取失败：{credentialError}</p>}
    {!!credentials?.orphanedCredentialCount && <p className="workflow-warning" role="alert">发现 {credentials.orphanedCredentialCount} 份已保存的授权文件，但当前工作区没有对应的店铺记录。请保留原文件并核对工作区；重新保存授权后才能建立连接。</p>}
    <AmazonConnectionForm busy={busy} run={run} onSaved={refresh} />
    <div className="workflow-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => { void run('正在导入店铺授权配置…', async () => { const target = await api.importAmazonCredentials(); if (target) { await refresh(); setNotice(`已保存「${target.name}」授权配置。首次获取类目字段时验证连接。`); } }); }}><FileKey2 size={15} />导入授权配置</button>
      <button type="button" className="button secondary" disabled={busy} onClick={() => { void run('正在保存配置模板…', async () => { const result = await api.exportAmazonCredentialTemplate(); if (!result.cancelled) setNotice('配置模板已保存。填写目标店铺的授权信息后，再从这里导入。'); }); }}><Download size={15} />保存配置模板</button>
      <button type="button" className="button secondary" disabled={busy || targets.some(target => target.mode === 'demo' && target.configured && !target.paused)} onClick={() => { void run('正在启用本地演示…', async () => { await api.enableAmazonDemo(); await refresh(); setNotice('本地演示已启用，在商品的上架检查中体验流程。'); }); }}>启用本地演示</button>
    </div>
    <p className="settings-help">可以直接填写，也可以导入配置文件。密钥由桌面程序加密保存，保存后只显示店铺信息。请使用自己已获批的私有应用和目标店铺自授权配置。</p>
    {notice && <p className="workflow-notice" role="status">{notice}</p>}
    <div className="amazon-connections">{targets.length ? targets.map(target => {
      const credential = credentials?.targets.find(item => item.targetId === target.id), presentation = credential ? credentialPresentation(credential) : null;
      const paused = credential ? !credential.storedEnabled : target.paused, saved = credential ? credential.state !== 'absent' || credential.storedConfigured : target.configured;
      return <article className="amazon-connection" key={target.id}>
      <div className="connection-title"><strong>{target.name}</strong><SettingsStatusBadge tone="info">{target.mode === 'demo' ? '本地演示' : '真实店铺'}</SettingsStatusBadge><SettingsStatusBadge tone={presentation?.tone ?? (target.mode === 'live' ? 'info' : !target.configured ? 'warning' : target.paused ? 'neutral' : 'success')}>{presentation?.label ?? (target.mode === 'live' ? '正在读取凭据状态…' : !target.configured ? '未授权' : target.paused ? '已暂停' : '已启用')}</SettingsStatusBadge>{target.lastError && <SettingsStatusBadge tone="danger">调用异常</SettingsStatusBadge>}</div>
      {presentation?.detail && <p className="workflow-warning" role="alert">{presentation.detail}</p>}
      <dl className="connection-values"><div><dt>站点</dt><dd>{target.marketplaceName} <code>{target.marketplaceId}</code></dd></div><div><dt>卖家 ID</dt><dd className="mono">{target.sellerId}</dd></div><div><dt>授权更新</dt><dd>{target.credentialUpdatedAt ? formatDate(target.credentialUpdatedAt) : '演示环境无需授权'}</dd></div></dl>
      {target.credentialUpdatedAt && Date.now() - Date.parse(target.credentialUpdatedAt) >= 330 * 86400000 && <p className="workflow-warning">授权配置即将满一年，请安排更新密钥并重新保存。</p>}
      {target.lastError && <p className="workflow-warning" role="alert">{target.lastError}</p>}
      <div className="workflow-actions"><button type="button" className="button secondary small-button" disabled={busy || !target.configured && paused} onClick={() => { void run(paused ? '正在恢复店铺调用…' : '正在暂停店铺调用…', async () => { await api.pauseAmazonTarget({ targetId: target.id, paused: !paused }); await refresh(); }); }}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? '恢复调用' : '暂停调用'}</button>{target.mode === 'live' && saved && <button type="button" className="button danger-quiet small-button" disabled={busy} onClick={() => { void run('正在解除本机连接…', async () => { await api.disconnectAmazonTarget(target.id); await refresh(); }); }}><Unplug size={14} />解除本机连接</button>}</div>
    </article>; }) : <p className="small-copy">{credentials === null ? credentialError ? '当前店铺记录为空，凭据状态尚未确认。' : '正在检查本机凭据状态…' : credentials.orphanedCredentialCount ? '当前没有可用店铺记录，请先处理上方的凭据与记录不一致问题。' : '尚未配置店铺。导入授权配置后，才能获取目标店铺的真实字段要求。'}</p>}</div>
    <div className="settings-subsection"><h4>Amazon 数据保留</h4><p className="settings-help">到期清理类目缓存和上架返回资料，保留原始商品档案；调用审计至少保留 365 天。</p><div className="inline-controls"><label className="field"><span>保留天数（1–548 天）</span><input aria-label="Amazon 数据保留天数" type="number" min={1} max={548} step={1} disabled={busy} value={retention} onChange={event => setRetention(event.target.value)} /></label><button type="button" className="button secondary" disabled={busy || !Number.isInteger(Number(retention)) || Number(retention) < 1 || Number(retention) > 548} onClick={() => { void saveRetention(); }}>保存保留设置</button><button type="button" className="button secondary" disabled={busy} onClick={() => { void run('正在清理到期数据…', async () => { const result = await api.cleanupAmazonData(); setPolicy(await api.getAmazonDataPolicy()); setNotice(`已清理 ${result.removedSchemas} 份类目缓存、${result.removedDrafts} 份过期草稿、${result.removedCalls} 条到期调用记录、${result.removedBackups ?? 0} 份到期备份。`); await refresh(); }); }}>清理到期数据</button></div>{policy?.lastCleanupAt && <p className="small-copy">上次清理：{formatDate(policy.lastCleanupAt)} · 调用审计保留 {policy.logRetentionDays} 天</p>}</div>
    <details className="listing-details"><summary><History size={15} /> 查看 Amazon 调用记录（已脱敏）</summary><div className="workflow-actions"><button type="button" className="button secondary small-button" disabled={busy} onClick={() => { void run('正在读取调用记录…', refresh); }}><RefreshCw size={14} />刷新调用记录</button></div>{calls.length ? <ul className="amazon-call-list">{calls.slice(0, 50).map(call => <li key={call.id}><div><strong>{call.mode === 'demo' ? '演示 · ' : ''}{call.operation}</strong><time>{formatDate(call.at)}</time></div><p>HTTP {call.status ?? '未返回'} · {call.durationMs} ms · 重试 {call.retries} 次{call.category ? ` · ${call.category}` : ''}</p>{call.requestId && <code>请求 {call.requestId}</code>}{call.rateLimit && <p>调用频率提示：{call.rateLimit}</p>}</li>)}</ul> : <p className="small-copy">执行类目查询、验证预览或回读后，记录会显示在这里。</p>}</details>
  </section>;
}
