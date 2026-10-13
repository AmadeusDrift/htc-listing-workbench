import { useFormGuard } from './FormGuard';
import { useRef, useState } from 'react';
import { AMAZON_MARKETPLACES } from '../shared/amazon-marketplaces';
import type { TaskRunner } from './amazon-ui';
import { SecretField } from './SecretField';

export function AmazonConnectionForm({ busy, run, onSaved }: { busy: boolean; run: TaskRunner; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(''), [sellerId, setSellerId] = useState('');
  const [marketplaceId, setMarketplaceId] = useState('ATVPDKIKX0DER'), [locale, setLocale] = useState('en_US');
  const [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState(''), [refreshToken, setRefreshToken] = useState('');
  const [working, setWorking] = useState(false), [notice, setNotice] = useState('');
  const savedFields = useRef({ name: '', sellerId: '', marketplaceId: 'ATVPDKIKX0DER', locale: 'en_US' });
  const disabled = busy || working;
  const valid = [name, sellerId, locale, clientId, clientSecret, refreshToken].every(value => value.trim()) && /^[A-Za-z0-9_-]{1,100}$/.test(sellerId.trim()) && /^[a-z]{2}(?:_[A-Z]{2})?$/.test(locale.trim());
  async function save() {
    if (disabled || !valid) return false;
    let success = false;
    setWorking(true); setNotice('');
    try {
      await run('正在保存 Amazon 连接…', async () => {
        const target = await window.red.saveAmazonCredentials({ name: name.trim(), sellerId: sellerId.trim(), marketplaceId, region: AMAZON_MARKETPLACES[marketplaceId][0], locale: locale.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim(), refreshToken: refreshToken.trim() });
        setClientId(''); setClientSecret(''); setRefreshToken('');
        savedFields.current = { name, sellerId, marketplaceId, locale }; success = true;
        setNotice(`「${target.name}」配置已加密保存。首次获取类目字段时验证连接，保存不会发布商品。`);
        await onSaved();
      });
    } finally { setWorking(false); }
    return success;
  }
  useFormGuard({ dirty: () => !!(clientId || clientSecret || refreshToken) || JSON.stringify({ name, sellerId, marketplaceId, locale }) !== JSON.stringify(savedFields.current), save, discard: () => {
    const saved = savedFields.current; setName(saved.name); setSellerId(saved.sellerId); setMarketplaceId(saved.marketplaceId); setLocale(saved.locale); setClientId(''); setClientSecret(''); setRefreshToken('');
  } });
  return <form className="credential-form" aria-label="Amazon 连接配置" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="credential-fields">
      <label className="field"><span>店铺名称</span><input aria-label="店铺名称" value={name} maxLength={100} required disabled={disabled} placeholder="便于自己识别的店铺名称" onChange={event => setName(event.target.value)} /></label>
      <label className="field"><span>Seller ID</span><input aria-label="Seller ID" value={sellerId} maxLength={100} required spellCheck={false} disabled={disabled} placeholder="目标店铺的卖家 ID" onChange={event => setSellerId(event.target.value)} /></label>
      <label className="field"><span>站点</span><select aria-label="Amazon 连接站点" value={marketplaceId} disabled={disabled} onChange={event => setMarketplaceId(event.target.value)}>{Object.entries(AMAZON_MARKETPLACES).map(([id, [, label]]) => <option value={id} key={id}>{label} · {id}</option>)}</select></label>
      <label className="field"><span>字段语言</span><input aria-label="Amazon 字段语言" value={locale} maxLength={16} required disabled={disabled} spellCheck={false} placeholder="例如 en_US、de_DE、ja_JP" onChange={event => setLocale(event.target.value)} /></label>
      <SecretField label="LWA Client ID" value={clientId} onChange={setClientId} disabled={disabled} />
      <SecretField label="LWA Client Secret" value={clientSecret} onChange={setClientSecret} disabled={disabled} />
      <SecretField label="Refresh Token" value={refreshToken} onChange={setRefreshToken} disabled={disabled} />
    </div>
    <p className="settings-help">填写已获授权的应用和目标店铺信息。Refresh Token 是店铺授权的刷新令牌，工作台据此自动获取临时 Access Token，无需手动填写临时 Token。同一卖家和站点再次保存会更新连接，并暂停其他正式店铺。</p>
    <div className="workflow-actions"><button type="submit" className="button primary" disabled={disabled || !valid}>保存 Amazon 连接</button></div>
    {notice && <p className="workflow-notice" role="status">{notice}</p>}
  </form>;
}
