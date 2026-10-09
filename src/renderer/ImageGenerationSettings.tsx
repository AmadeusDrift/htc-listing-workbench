import { ArrowRight, ImagePlus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiCapabilityInfo } from '../shared/ai-contracts';
import { DEFAULT_OPENAI_IMAGE_MODEL, OPENAI_IMAGE_MODELS } from '../shared/image-generation-contracts';
import type { ImageModelCatalog } from '../shared/image-generation-contracts';
import { GEMINI_IMAGE_SIZES, fixedRelayQuality, isGeminiImageModel, relayDefaultQuality, validRelayModelId } from '../shared/image-models';
import { RelayModelPicker } from './RelayModelPicker';
import { ImageRiskSettings } from './ImageRiskSettings';
import { CopyReviewSettings } from './CopyReviewSettings';
import type { ImageGenerationConnection, ImageGenerationModel, ImageGenerationProvider, ImageGenerationQuality, ImageGenerationSize } from '../shared/image-generation-contracts';
import { SettingsStatusBadge } from './SettingsStatusBadge';
import type { SettingsStatusTone } from './SettingsStatusBadge';
import { errorText, formatDate } from './utils';
import './image-generation-settings.css';

type Operation = 'loading' | 'saving' | 'checking' | 'disconnecting' | 'models';
const modelLabels: Record<ImageGenerationModel, string> = {
  'gpt-image-2.5-sunburst': 'GPT Image 2.5 · Sunburst',
  'gpt-image-2.5-flare': 'GPT Image 2.5 · Flare',
  'gpt-image-2-4k-high': 'GPT Image 2 · 4K High',
  'gpt-image-2-4K': 'GPT Image 2 · 4K',
  'gpt-image-2-1k': 'GPT Image 2 · 1K',
  'gpt-image-2-逆向': 'GPT Image 2 · 逆向',
  'gpt-image-2.5-sunburst-4k-max': 'GPT Image 2.5 · Sunburst 4K Max',
  'gpt-image-2.5-flare-4k-max': 'GPT Image 2.5 · Flare 4K Max',
  'gpt-image-2.5-逆向': 'GPT Image 2.5 · 逆向',
};
const providerName = (provider: ImageGenerationProvider) => provider === 'openai' ? 'OpenAI' : 'Tyai';
const qualityLabels: Record<ImageGenerationQuality, string> = { auto: '模型默认', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };

function connectionStatus(connection: ImageGenerationConnection | null): { label: string; tone: SettingsStatusTone; detail: string } {
  if (!connection) return { label: '状态未读取', tone: 'neutral', detail: '请刷新后读取本机配置。' };
  if (connection.credentialState === 'encryption-unavailable') return { label: '暂时无法保存密钥', tone: 'warning', detail: '当前系统无法安全保存密钥。恢复本机加密功能后再配置。' };
  if (connection.credentialState === 'unreadable') return { label: '密钥需重新保存', tone: 'warning', detail: '已保存的密钥无法读取。请重新填写并保存，或移除配置后重试。' };
  if (!connection.configured || connection.credentialState === 'absent') return { label: '未配置', tone: 'neutral', detail: `填写 ${providerName(connection.provider)} API Key，保存后可启用自动生图。` };
  if (connection.provider !== connection.activeProvider) return { label: '已保存 · 未选用', tone: 'neutral', detail: '保存当前配置后，自动图片流程将使用此服务。' };
  if (connection.accessCheck === 'failed') return { label: '模型访问未确认', tone: 'warning', detail: '上次未能确认模型访问，请检查密钥和网络后重试。' };
  if (connection.accessCheck === 'accessible') return { label: '模型可访问 · 生图待测试', tone: 'success', detail: `已确认模型可访问，尚未实际生成图片。接口${connection.enabled ? '已启用' : '尚未启用'}。` };
  if (connection.enabled) return { label: '已启用 · 待测试', tone: 'info', detail: connection.provider === 'tyai' ? '自动图片流程将使用此中转服务，连接与生图结果会在流程中验证。' : '配置已启用，模型访问与实际生图尚待测试。' };
  return { label: '已保存 · 未启用', tone: 'neutral', detail: '密钥已保存在本机，生图接口尚未启用。' };
}

export function ImageGenerationSettings({ visible, busy, onAiSettings }: { visible: boolean; busy: boolean; onAiSettings: () => void }) {
  const [connection, setConnection] = useState<ImageGenerationConnection | null>(null);
  const [capabilities, setCapabilities] = useState<AiCapabilityInfo[]>([]);
  const [provider, setProvider] = useState<ImageGenerationProvider>('openai');
  const [model, setModel] = useState<ImageGenerationModel>(DEFAULT_OPENAI_IMAGE_MODEL);
  const [size, setSize] = useState<ImageGenerationSize>('auto');
  const [quality, setQuality] = useState<ImageGenerationQuality>('auto');
  const [catalog, setCatalog] = useState<ImageModelCatalog | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState('');
  const [capabilityError, setCapabilityError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const visibleRef = useRef(visible);
  const operationRef = useRef<Operation | null>(null);
  const readVersion = useRef(0);
  const viewVersion = useRef(0);
  const refreshAfterOperation = useRef(false);
  visibleRef.current = visible;

  const applyConnection = useCallback((value: ImageGenerationConnection) => {
    setConnection(value); setProvider(value.provider); setModel(value.model); setEnabled(value.enabled); setSize(value.size); setQuality(value.quality);
  }, []);

  const refresh = useCallback(async () => {
    if (operationRef.current && operationRef.current !== 'loading') {
      refreshAfterOperation.current = true;
      return;
    }
    const version = ++readVersion.current;
    operationRef.current = 'loading'; setOperation('loading'); setError(''); setCapabilityError(''); setNotice('');
    const [saved, services, models] = await Promise.allSettled([
      window.red.getImageGenerationConnection(), window.red.listAiCapabilities(), window.red.getImageGenerationModels(),
    ]);
    if (!mounted.current || !visibleRef.current || version !== readVersion.current) return;
    if (saved.status === 'fulfilled') applyConnection(saved.value);
    else { setConnection(null); setError(errorText(saved.reason)); }
    if (services.status === 'fulfilled') setCapabilities(services.value);
    else { setCapabilities([]); setCapabilityError(errorText(services.reason)); }
    if (models.status === 'fulfilled') setCatalog(models.value);
    operationRef.current = null; setOperation(null);
  }, [applyConnection]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readVersion.current += 1; };
  }, []);

  useEffect(() => {
    viewVersion.current += 1;
    setApiKey(''); setNotice(''); setError('');
    if (visible) void refresh();
    else {
      // Invalidate local reads, but keep a mutation locked until it really settles.
      readVersion.current += 1; refreshAfterOperation.current = false;
      if (operationRef.current === 'loading') { operationRef.current = null; setOperation(null); }
    }
  }, [visible, refresh]);

  useEffect(() => {
    const clearWhenHidden = () => { if (document.hidden) setApiKey(''); };
    document.addEventListener('visibilitychange', clearWhenHidden);
    return () => document.removeEventListener('visibilitychange', clearWhenHidden);
  }, []);

  const loading = operation === 'loading';
  const disabled = busy || operation !== null || !visible;
  const hasSavedKey = connection?.configured === true && connection.credentialState === 'ready';
  const cannotEncrypt = connection?.credentialState === 'encryption-unavailable';
  const dirty = connection !== null && (provider !== connection.activeProvider || model !== connection.model || size !== connection.size || quality !== connection.quality || enabled !== connection.enabled || apiKey.length > 0);
  const canSave = !disabled && !cannotEncrypt && dirty && (provider === 'openai' || validRelayModelId(model)) && (hasSavedKey || apiKey.trim().length > 0);
  const canCheck = provider === 'openai' && !disabled && hasSavedKey && !dirty;
  const canDisconnect = !disabled && connection !== null && (connection.configured || connection.credentialState !== 'absent' || connection.enabled);
  const status = connectionStatus(connection);
  const gemini = provider === 'tyai' && isGeminiImageModel(model);
  const sizes = gemini ? Object.keys(GEMINI_IMAGE_SIZES) : ['1024x1024', '1536x1024', '1024x1536', ...(provider === 'tyai' && !/-1k$/i.test(model) ? ['2048x2048', '2880x2880', '2160x3840', '3840x2160'] : [])];
  const qualityFixed = provider === 'tyai' && fixedRelayQuality(model);

  function editDraft() { setNotice(''); setError(''); }
  function chooseRelayModel(value: string) {
    setModel(value); setQuality(relayDefaultQuality(value)); setSize('1024x1024'); editDraft();
  }
  async function syncModels() {
    if (disabled || !hasSavedKey || apiKey.length) return;
    const view = viewVersion.current;
    operationRef.current = 'models'; setOperation('models'); setError(''); setNotice('');
    try {
      const value = await window.red.refreshImageGenerationModels();
      if (mounted.current && visibleRef.current && view === viewVersion.current) { setCatalog(value); setNotice(`已同步当前 API 分组的 ${value.models.length} 个模型，没有发起生图请求。`); }
    } catch (cause) { if (mounted.current && visibleRef.current && view === viewVersion.current) setError(errorText(cause)); }
    finally {
      operationRef.current = null;
      if (mounted.current) { setOperation(null); if (refreshAfterOperation.current && visibleRef.current) { refreshAfterOperation.current = false; void refresh(); } }
    }
  }

  async function chooseProvider(next: ImageGenerationProvider) {
    if (disabled || next === provider) return;
    const version = ++readVersion.current;
    operationRef.current = 'loading'; setOperation('loading'); setProvider(next); setConnection(null); setApiKey(''); editDraft();
    try {
      const [value, models] = await Promise.all([window.red.getImageGenerationConnection(next), window.red.getImageGenerationModels()]);
      if (mounted.current && visibleRef.current && version === readVersion.current) { applyConnection(value); setCatalog(models); }
    } catch (cause) {
      if (mounted.current && visibleRef.current && version === readVersion.current) setError(errorText(cause));
    } finally {
      if (version === readVersion.current) { operationRef.current = null; if (mounted.current) setOperation(null); }
    }
  }

  async function act(kind: Exclude<Operation, 'loading'>, task: () => Promise<ImageGenerationConnection>) {
    if (!visibleRef.current || busy || operationRef.current) return;
    const view = viewVersion.current;
    operationRef.current = kind; setOperation(kind); setError(''); setNotice('');
    try {
      const value = await task();
      if (!mounted.current) return;
      applyConnection(value);
      if (kind === 'saving' || kind === 'disconnecting') setCatalog(await window.red.getImageGenerationModels());
      if (kind !== 'checking') setApiKey('');
      if (visibleRef.current && view === viewVersion.current) {
        if (kind === 'saving') setNotice(`配置已保存${value.enabled ? '并启用' : '，接口尚未启用'}。没有发起生图请求。`);
        else if (kind === 'disconnecting') setNotice('本机密钥已移除，生图接口已停用。');
        else if (value.accessCheck === 'accessible') setNotice('模型可访问。此次检查没有生成图片；生图权限、额度及质量仍待实际测试。');
        else setError('未能确认模型访问，请检查密钥和网络后重试。');
      }
    } catch (cause) {
      if (!mounted.current) return;
      if (visibleRef.current && view === viewVersion.current) setError(errorText(cause));
      if (kind === 'checking') {
        // A failed check can still update its saved timestamp and status.
        try {
          const value = await window.red.getImageGenerationConnection(provider);
          if (mounted.current) applyConnection(value);
        } catch { /* Keep the original check error visible. */ }
      }
    } finally {
      operationRef.current = null;
      if (mounted.current) {
        setOperation(null);
        if (refreshAfterOperation.current && visibleRef.current) {
          refreshAfterOperation.current = false;
          void refresh();
        }
      }
    }
  }

  async function save() {
    if (!canSave) return;
    await act('saving', () => window.red.saveImageGenerationConnection({
      provider, model, enabled, size, quality, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }));
  }

  return <section className="settings-section image-generation-settings" aria-busy={operation !== null}>
    <div className="settings-section-title"><ImagePlus size={20} aria-hidden="true" /><div><h3>图片与生图</h3><p>选择自动图片流程使用的服务和默认参数。</p></div><button type="button" className="button secondary" disabled={disabled || dirty} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />刷新状态</button></div>
    <ImageRiskSettings visible={visible} busy={busy}/>
    <CopyReviewSettings visible={visible} busy={busy}/>
    <form className="credential-form image-generation-form" aria-label={`${providerName(provider)} 生图连接配置`} autoComplete="off" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="credential-heading"><h4>{provider === 'openai' ? 'OpenAI Image 2.5' : 'Tyai 图片中转'}</h4><SettingsStatusBadge tone={loading || operation === 'checking' ? 'info' : status.tone}>{loading ? '正在读取…' : operation === 'checking' ? '正在检查模型…' : status.label}</SettingsStatusBadge></div>
      <label className="field image-generation-provider"><span>生图服务</span><select aria-label="生图服务" value={provider} disabled={disabled} onChange={event => void chooseProvider(event.target.value as ImageGenerationProvider)}><option value="openai">OpenAI 官方</option><option value="tyai">Tyai 中转</option></select><small className="image-generation-field-help">{connection ? `自动流程当前使用：${providerName(connection.activeProvider)}。保存后切换服务。` : '正在读取服务配置…'}</small></label>
      <div className="image-generation-endpoint"><span>{provider === 'openai' ? '官方接口' : '中转接口'}</span><code>{provider === 'openai' ? 'https://api.openai.com/v1' : 'https://tyaiapi.com/v1'}</code></div>
      <p className={connection?.credentialState === 'unreadable' || cannotEncrypt ? 'workflow-warning' : 'settings-help'} role={connection?.credentialState === 'unreadable' || cannotEncrypt ? 'alert' : undefined}>{loading ? '正在读取本机配置…' : status.detail}</p>
      <div className="image-generation-fields">
        <label className="field"><span>{providerName(provider)} API Key</span><input type="password" aria-label={`${providerName(provider)} API Key`} aria-describedby="image-generation-key-help" autoComplete="off" spellCheck={false} maxLength={4096} value={apiKey} disabled={disabled || !connection || cannotEncrypt} required={!hasSavedKey} onChange={event => { setApiKey(event.target.value); editDraft(); }} placeholder={hasSavedKey ? '已保存；留空保留原密钥' : `粘贴 ${providerName(provider)} API Key`} /><small id="image-generation-key-help" className="image-generation-field-help">密钥分别加密保存在本机。{hasSavedKey ? '留空保留此服务的密钥。' : '填写当前服务对应的密钥。'}</small></label>
        {provider === 'tyai' ? <RelayModelPicker value={model} onChange={chooseRelayModel} catalog={catalog} disabled={disabled || !connection || !!cannotEncrypt} canSync={!disabled && hasSavedKey && !apiKey.length} syncing={operation === 'models'} onSync={() => void syncModels()} /> : <label className="field"><span>生图模型</span><select aria-label="生图模型" value={model} disabled={disabled || !connection || cannotEncrypt} onChange={event => { setModel(event.target.value); editDraft(); }}>{OPENAI_IMAGE_MODELS.map(value => <option key={value} value={value}>{modelLabels[value]}</option>)}</select><small className="image-generation-field-help">更换模型后，请保存并重新检查访问。</small></label>}
        <label className="field"><span>{gemini ? '分辨率与比例' : '默认尺寸'}</span><select aria-label="默认尺寸" value={size} disabled={disabled || !connection || cannotEncrypt} onChange={event => { setSize(event.target.value as ImageGenerationSize); editDraft(); }}>{[...new Set(['auto', ...sizes, size])].map(value => <option key={value} value={value}>{value === 'auto' ? '自动' : gemini && GEMINI_IMAGE_SIZES[value] ? `${GEMINI_IMAGE_SIZES[value].imageSize} · ${GEMINI_IMAGE_SIZES[value].aspectRatio}` : value.replace('x', ' × ')}</option>)}</select><small className="image-generation-field-help">{gemini && '实际像素尺寸由 Gemini 返回。'}自动复核当前支持不超过 10 MB 的 PNG；候选图超出时会保留并停止复核。</small></label>
        <label className="field"><span>默认质量</span><select aria-label="默认质量" value={qualityFixed ? relayDefaultQuality(model) : quality} disabled={disabled || !connection || cannotEncrypt || qualityFixed} onChange={event => { setQuality(event.target.value as ImageGenerationQuality); editDraft(); }}>{(Object.keys(qualityLabels) as ImageGenerationQuality[]).map(value => <option key={value} value={value}>{qualityLabels[value]}</option>)}</select><small className="image-generation-field-help">{gemini ? 'Gemini 使用分辨率与比例，不发送 GPT 的质量参数。' : provider === 'tyai' ? '旧 4K 模型固定高质量；1K 模型使用模型默认质量。' : '自动图片流程使用已保存的默认参数。'}</small></label>
      </div>
      <div className="image-generation-enable"><label><input type="checkbox" checked={enabled} disabled={disabled || (!hasSavedKey && !apiKey.trim())} onChange={event => { setEnabled(event.target.checked); editDraft(); }} /><span>启用生图接口</span></label><span className="image-generation-field-help">填写密钥后可一并启用，保存配置不会发起生图请求。</span></div>
      <div className="workflow-actions image-generation-actions">
        <button type="submit" className="button primary" disabled={!canSave}>{operation === 'saving' ? '正在保存…' : '保存配置'}</button>
        {provider === 'openai' && <button type="button" className="button secondary" disabled={!canCheck} onClick={() => { if (canCheck) void act('checking', () => window.red.checkImageGenerationConnection(provider)); }}>{operation === 'checking' ? '正在检查…' : '检查模型访问'}</button>}
        <button type="button" className="button secondary image-generation-disconnect" disabled={!canDisconnect} onClick={() => { if (canDisconnect) void act('disconnecting', () => window.red.disconnectImageGenerationConnection(provider)); }}>{operation === 'disconnecting' ? '正在移除…' : '移除配置'}</button>
      </div>
      {dirty && <p className="image-generation-unsaved" role="status">有未保存的更改。保存后供自动图片流程使用。</p>}
      <p className="settings-help image-generation-check-help">{provider === 'openai' ? '检查仅确认模型访问，不生成图片，也不验证生图权限、额度或质量。' : '模型列表来自当前 API 分组；生成权限和效果以实际请求为准。Gemini 返回的 JPEG 会按原尺寸转换为 PNG，接入后续 OCR 复核。'}保存、刷新和打开本页都不会发起生图请求。{connection?.checkedAt && <span>最近检查：{formatDate(connection.checkedAt)}</span>}</p>
      {error && <p className="workflow-warning" role="alert">{error}</p>}
      {notice && <p className="workflow-notice" role="status" aria-live="polite">{notice}</p>}
    </form>
    <div className="image-generation-other"><h4>自动七图规则</h4><p className="settings-help">每个销售 SKU 共七张：第一张为无字场景主图，其余优先展示带简短英文的单个卖点。有可靠来源尺寸时安排一张尺寸图，自动补填尺寸不用于出图。卖点不足时补场景图，可无字或带简短场景文案。DeepSeek 自行选择适合商品的场景、构图与整套风格。</p></div>
    <div className="image-generation-other"><h4>其他图片能力</h4>
      {capabilityError && <p className="workflow-warning" role="alert">图片处理状态读取失败：{capabilityError}</p>}
      <div className="image-capability-list">{([['ocr', '文字识别 OCR'], ['segmentation', '图片分割']] as const).map(([id, name]) => {
        const item = capabilities.find(row => row.capability === id);
        return <div key={id}><div><strong>{name}</strong><p>{loading ? '正在读取…' : item?.available ? id === 'ocr' ? '用于检查生成主图是否带字，并读取来源图的可靠尺寸；其余生成图不做文字复核。' : '服务已配置，可用于图片分割。' : item?.reason || '尚未读取连接状态'}</p></div><SettingsStatusBadge tone={item?.available && !loading ? 'success' : 'neutral'}>{loading ? '读取中' : item?.available ? '服务可用' : '未就绪'}</SettingsStatusBadge></div>;
      })}</div>
      <div className="workflow-actions"><button type="button" className="button secondary" disabled={disabled} onClick={onAiSettings}>管理 OCR 与分割连接<ArrowRight size={15} aria-hidden="true" /></button></div>
    </div>
  </section>;
}
