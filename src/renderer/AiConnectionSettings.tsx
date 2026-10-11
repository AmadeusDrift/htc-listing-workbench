import { useEffect, useState } from 'react';
import type { AiProfile, AiProviderId } from '../shared/ai-contracts';
import { AI_FUNCTION_NAMES } from '../shared/ai-connection-contracts';
import type { AiConnection, AiConnectionInput, AiVendorId } from '../shared/ai-connection-contracts';
import type { TaskRunner } from './amazon-ui';
import { SecretField } from './SecretField';
import { SettingsStatusBadge } from './SettingsStatusBadge';
import type { SettingsStatusTone } from './SettingsStatusBadge';
import { errorText } from './utils';
import { aiFunctionSettingsInput, credentialPresentation } from './credential-status';

const connectionStates = { unconfigured: '尚未配置', partial: '已有单项配置', shared: '已共用凭据', separate: '旧配置分别保存' };
const connectionTones: Record<AiConnection['state'], SettingsStatusTone> = { unconfigured: 'neutral', partial: 'warning', shared: 'info', separate: 'warning' };

export function AiConnectionSettings({ vendor, busy, run, onVendorChange }: { vendor: AiVendorId; busy: boolean; run: TaskRunner; onVendorChange: (id: AiVendorId) => void }) {
  const [connection, setConnection] = useState<AiConnection | null>(null);
  const [loading, setLoading] = useState(true), [working, setWorking] = useState(false);
  const [apiKey, setApiKey] = useState(''), [accessKeyId, setAccessKeyId] = useState(''), [accessKeySecret, setAccessKeySecret] = useState(''), [securityToken, setSecurityToken] = useState('');
  const [sourceId, setSourceId] = useState<AiProviderId | ''>('');
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const textVendor = vendor === 'deepseek', vendorName = textVendor ? 'DeepSeek' : '阿里云';
  const disabled = busy || loading || working;
  const valid = textVendor ? apiKey.trim().length >= 8 : accessKeyId.trim().length >= 8 && accessKeySecret.trim().length >= 8 && (!securityToken.trim() || securityToken.trim().length >= 8);
  const configured = connection?.profiles.filter(profile => profile.configured) ?? [];
  const credentialIssue = connection?.credentials.find(item => item.state === 'encryption-unavailable' || item.state === 'unreadable') ?? connection?.credentials.find(item => item.state === 'metadata-mismatch' || item.state === 'absent' && item.storedConfigured);
  const issuePresentation = credentialIssue ? credentialPresentation(credentialIssue) : null;
  const saved = connection?.credentials.some(item => item.state !== 'absent' || item.storedConfigured) ?? false;
  function clearSecrets() { setApiKey(''); setAccessKeyId(''); setAccessKeySecret(''); setSecurityToken(''); }
  function apply(value: AiConnection) {
    setConnection(value);
    setSourceId(previous => value.profiles.some(profile => profile.id === previous && profile.configured) ? previous : value.profiles.find(profile => profile.configured)?.id ?? '');
  }
  useEffect(() => {
    let active = true;
    void window.red.listAiConnections().then(connections => {
      if (active) { const value = connections.find(item => item.id === vendor); if (value) apply(value); }
    }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [vendor]);
  async function action(task: () => Promise<void>) {
    if (disabled) return;
    setWorking(true); setNotice(''); setError('');
    try { await run('正在更新 AI 连接…', task); } finally { setWorking(false); }
  }
  async function save() {
    if (!valid) return;
    const input: AiConnectionInput = textVendor
      ? { id: 'deepseek', apiKey: apiKey.trim() }
      : { id: 'aliyun', accessKeyId: accessKeyId.trim(), accessKeySecret: accessKeySecret.trim(), ...(securityToken.trim() ? { securityToken: securityToken.trim() } : {}) };
    await action(async () => {
      apply(await window.red.saveAiConnection(input)); clearSecrets();
      setNotice('共享密钥已加密保存。下方可分别启用功能、选择模型；保存不会发起调用。');
    });
  }
  async function configure(profile: AiProfile, change: Partial<Pick<AiProfile, 'model' | 'enabled' | 'thinking'>>) {
    if (!connection) return;
    await action(async () => {
      apply(await window.red.saveAiFunctionSettings(aiFunctionSettingsInput(connection, profile.id, change)));
      setNotice(`${AI_FUNCTION_NAMES[profile.id]}设置已保存。`);
    });
  }
  return <form className="credential-form" aria-label="AI 连接配置" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="credential-heading"><h4>{vendorName} 连接</h4><SettingsStatusBadge tone={loading ? 'info' : error ? 'danger' : issuePresentation?.tone ?? (connection ? connectionTones[connection.state] : 'neutral')}>{loading ? '正在读取…' : error ? '读取失败' : issuePresentation?.label ?? (connection ? connectionStates[connection.state] : '尚未配置')}</SettingsStatusBadge></div>
    {issuePresentation && <p className="workflow-warning" role="alert">{issuePresentation.detail}</p>}
    <p className="settings-help">{textVendor ? '填写一次 API Key，文案生成与复核共用。两项任务的模型和启停可分别设置。' : '填写一次 AccessKey，OCR、图片分割与侵权风险检测共用。请开通所需服务并授予访问权限；侵权检测使用图片审核增强版。临时凭据还需填写 Security Token。'}</p>
    <div className="credential-fields">
      {textVendor ? <SecretField label="API Key" value={apiKey} onChange={setApiKey} disabled={disabled} /> : <>
        <SecretField label="AccessKey ID" value={accessKeyId} onChange={setAccessKeyId} disabled={disabled} />
        <SecretField label="AccessKey Secret" value={accessKeySecret} onChange={setAccessKeySecret} disabled={disabled} />
        <SecretField label="Security Token（可选）" value={securityToken} onChange={setSecurityToken} disabled={disabled} optional />
      </>}
    </div>
    <div className="workflow-actions">
      <button type="submit" className="button primary" disabled={disabled || !valid}>保存共享密钥</button>
      <button type="button" className="button secondary" disabled={disabled || !saved} onClick={() => void action(async () => {
        apply(await window.red.disconnectAiConnection(vendor)); clearSecrets(); setNotice(`${vendorName}本机密钥已清除，各项功能已停用，历史结果仍保留。`);
      })}>清除共享密钥</button>
    </div>
    {connection && ['partial', 'separate'].includes(connection.state) && <div className="ai-legacy-connection">
      <p className="settings-help">已有功能单独保存的配置。可选择其中一组密钥供各项功能共用，模型、启停及上限保持各自设置。</p>
      <label className="field"><span>复用哪项功能的已存密钥</span><select aria-label="复用已有密钥来源" value={sourceId} disabled={disabled} onChange={event => setSourceId(event.target.value as AiProviderId)}>
        {configured.map(profile => <option value={profile.id} key={profile.id}>{AI_FUNCTION_NAMES[profile.id]}</option>)}
      </select></label>
      <button type="button" className="button secondary" disabled={disabled || !sourceId} onClick={() => void action(async () => {
        if (!sourceId) return;
        apply(await window.red.reuseAiConnection({ id: vendor, sourceId })); clearSecrets(); setNotice('已复用选中的密钥，各项功能现在共用同一组凭据。');
      })}>复用已有密钥</button>
    </div>}
    <section className="ai-functions" aria-label="AI 功能设置">
      <div><h4>功能设置</h4><p className="settings-help">{textVendor ? '模型和启停分别保存，无需重新填写密钥。' : '各项功能可分别启用或暂停，无需重新填写密钥。'}</p></div>
      {connection?.profiles.map(profile => {
        const credential = connection.credentials.find(item => item.id === profile.id)!, presentation = credentialPresentation(credential);
        return <div className="ai-function-row" key={profile.id} data-ai-function={profile.id}>
        <div className="credential-heading"><strong>{AI_FUNCTION_NAMES[profile.id]}</strong><SettingsStatusBadge tone={presentation.tone}>{presentation.label}</SettingsStatusBadge></div>
        <div className="ai-function-controls">
          {textVendor ? <label className="field"><span>模型</span><select aria-label={`${AI_FUNCTION_NAMES[profile.id]}模型`} value={profile.model} disabled={disabled} onChange={event => void configure(profile, { model: event.target.value })}>
            <option value="deepseek-flash">deepseek-flash</option><option value="deepseek-v4-pro">deepseek-v4-pro</option>
          </select></label> : <p className="settings-help">{profile.id === 'aliyun-ocr' ? '识别来源图片中的文字。' : profile.id==='aliyun-image-risk' ? '使用 aigcViolationDetection 检查生成图片；需开通图片审核增强版及访问权限。图片临时上传至阿里云检测空间，约 30 分钟后由服务清理。未检出风险不等于法律上的无侵权认定。' : '移除图片背景，保留商品主体。'}</p>}
          {textVendor && <label className="field"><span>思考模式</span><select aria-label={`${AI_FUNCTION_NAMES[profile.id]}思考模式`} value={profile.thinking?'on':'off'} disabled={disabled} onChange={event=>void configure(profile,{thinking:event.target.value==='on'})}><option value="off">关闭</option><option value="on">开启</option></select><small>用于该功能的分类、识别或填写请求；开启后耗时和用量可能增加。</small></label>}
          <button type="button" className="button secondary" disabled={disabled || !profile.configured && !credential.storedEnabled} onClick={() => void configure(profile, { enabled: !credential.storedEnabled })}>{credential.storedEnabled ? '暂停' : '启用'}{AI_FUNCTION_NAMES[profile.id]}</button>
        </div>
      </div>; })}
    </section>
    <details className="credential-advanced"><summary>也可以导入配置文件</summary><p className="settings-help">导入的密钥会供本供应商各项功能共用。</p><div className="workflow-actions">
      <button type="button" className="button secondary" disabled={disabled} onClick={() => void action(async () => {
        const value = await window.red.importAiConnectionConfig();
        if (!value) return; clearSecrets();
        if (value.id !== vendor) onVendorChange(value.id); else apply(value);
        setNotice('共享配置已导入，可在功能设置中启用所需功能。');
      })}>导入 AI 连接配置</button>
      <button type="button" className="button secondary" disabled={disabled} onClick={() => void action(async () => { const result = await window.red.exportAiConnectionTemplate(vendor); if (!result.cancelled) setNotice('空白连接模板已保存。'); })}>保存 AI 连接模板</button>
    </div></details>
    {error && <p className="workflow-warning" role="alert">{error}</p>}{notice && <p className="workflow-notice" role="status">{notice}</p>}
  </form>;
}
