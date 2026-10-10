import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Play, RefreshCw } from 'lucide-react';
import type { ProductDetail, ProductSummary } from '../shared/contracts';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { ListingRules } from '../shared/listing-rules';
import type { AiCapabilityInfo } from '../shared/ai-contracts';
import type { AutomaticListingTask } from '../shared/automatic-listing-contracts';
import type { HostingProfile } from '../shared/hosting-contracts';
import { createAutomaticPreparationPlan } from './automatic-preparation';
import { AutomaticTaskPanel } from './AutomaticTaskPanel';
import { errorText } from './utils';
import type { SettingsModule } from './settings-navigation';

interface Props {
  products: ProductSummary[]; targets: AmazonTarget[]; busy: boolean;
  onManual: (productId: string, draftId?: string) => void; onSettings: (module?: SettingsModule) => void; onRunningChange: (running: boolean) => void;
  onShipping?: (batchId: string) => void;
}
const requiredCapabilities = [
  { capability: 'text', label: 'DeepSeek 文案与图片规划' }, { capability: 'text-review', label: 'DeepSeek 独立复核' },
  { capability: 'image-generation', label: '生图接口' }, { capability: 'ocr', label: '阿里云 OCR' },
  { capability: 'image-risk', label: '阿里云图片侵权检测' },
] as const;

export function AutomaticPreparationPanel({ products, targets, busy, onManual, onSettings, onRunningChange, onShipping }: Props) {
  const api = window.red;
  const [riskEnabled,setRiskEnabled]=useState(true);
  const [copyReviewEnabled,setCopyReviewEnabled]=useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [details, setDetails] = useState<ProductDetail[]>([]);
  const [rules, setRules] = useState<ListingRules | null>(null);
  const [readErrors, setReadErrors] = useState<string[]>([]);
  const [rulesError, setRulesError] = useState('');
  const [capabilities, setCapabilities] = useState<AiCapabilityInfo[]>([]);
  const [capabilityError, setCapabilityError] = useState('');
  const [loadingCapabilities, setLoadingCapabilities] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingRules, setLoadingRules] = useState(true);
  const [profiles, setProfiles] = useState<HostingProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [hostingError, setHostingError] = useState('');
  const [loadingHosting, setLoadingHosting] = useState(true);
  const [reload, setReload] = useState(0);
  const [targetId, setTargetId] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [startedTask, setStartedTask] = useState<AutomaticListingTask | null>(null);
  const mounted = useRef(true), startPending = useRef(false);
  const selected = products.filter(product => selectedIds.includes(product.id));
  const selectionKey = JSON.stringify(selected.map(product => [product.id, product.updatedAt]));
  const target = targets.find(value => value.id === targetId);
  const profile = profiles.find(value => value.id === profileId && value.configured && value.enabled);
  const plan = useMemo(() => rules ? createAutomaticPreparationPlan(details, rules) : null, [details, rules]);
  const disabled = busy || starting;
  const supported = target?.marketplaceId === 'ATVPDKIKX0DER' && target.locale === 'en_US';
  const missingCapabilities = requiredCapabilities.filter(required => (riskEnabled||required.capability!=='image-risk')&&!capabilities.some(value => value.capability === required.capability && value.available));
  const connectionsReady = !loadingCapabilities && !capabilityError && !missingCapabilities.length;
  const canStart = !disabled && !loadingProducts && !loadingRules && !readErrors.length && !rulesError && connectionsReady && !loadingHosting && !hostingError && Boolean(profile && plan?.rows.length && target?.configured && !target.paused && supported);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setLoadingRules(true); setRulesError('');
    void api.getListingRules().then(value => { if (active) setRules(value); }, cause => { if (active) { setRules(null); setRulesError(errorText(cause)); } }).finally(() => { if (active) setLoadingRules(false); });
    return () => { active = false; };
  }, [api, reload]);
  useEffect(() => {
    let active = true; setLoadingCapabilities(true); setCapabilityError('');
    void Promise.all([api.listAiCapabilities(),api.getImageRiskSettings(),api.getCopyReviewSettings()]).then(([value,risk,copy]) => { if (active) {setCapabilities(value);setRiskEnabled(risk.enabled);setCopyReviewEnabled(copy.enabled);} }, cause => { if (active) { setCapabilities([]); setCapabilityError(errorText(cause)); } }).finally(() => { if (active) setLoadingCapabilities(false); });
    return () => { active = false; };
  }, [api, reload]);
  useEffect(()=>{const changed=()=>setReload(value=>value+1);window.addEventListener('image-risk-settings-changed',changed);window.addEventListener('copy-review-settings-changed',changed);return()=>{window.removeEventListener('image-risk-settings-changed',changed);window.removeEventListener('copy-review-settings-changed',changed);};},[]);
  useEffect(() => {
    let active = true; setLoadingHosting(true); setHostingError('');
    void api.listFtpProfiles().then(values => { if (active) { setProfiles(values); setProfileId(current => values.some(value => value.id === current && value.configured && value.enabled) ? current : values.find(value => value.configured && value.enabled)?.id ?? ''); } }, cause => { if (active) { setProfiles([]); setHostingError(errorText(cause)); } }).finally(() => { if (active) setLoadingHosting(false); });
    return () => { active = false; };
  }, [api, reload]);
  useEffect(() => {
    let active = true; setLoadingProducts(true); setDetails([]); setReadErrors([]);
    void Promise.all(selected.map(async product => {
      try { return { detail: await api.getProduct(product.id), error: '' }; }
      catch (cause) { return { detail: null, error: `${product.title || '未命名商品'}：${errorText(cause)}` }; }
    })).then(values => {
      if (!active) return;
      setDetails(values.flatMap(value => value.detail ? [value.detail] : []));
      setReadErrors(values.flatMap(value => value.error ? [value.error] : [])); setLoadingProducts(false);
    });
    return () => { active = false; };
  }, [api, selectionKey, reload]);

  async function start() {
    if (!canStart || startPending.current) return;
    startPending.current = true; setStarting(true); onRunningChange(true); setError(''); setNotice('');
    try {
      const task = await api.startAutomaticListing({ productIds: selected.map(value => value.id), targetId, profileId });
      if (mounted.current) { if (task) setStartedTask(task); else setNotice('已取消启动，未创建自动上架任务。'); }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { startPending.current = false; if (mounted.current) { setStarting(false); onRunningChange(false); } }
  }

  return <>
    <section className="amazon-workflow" aria-label="启动自动上架">
      <div className="section-heading"><div><h2>自动准备并发布</h2><p>确认执行范围后，按 SKU 连续完成文案、图片、上传、验证、提交、平台回读和商品标签。只有异常需要人工处理。</p></div><button type="button" className="button secondary" disabled={disabled} onClick={() => onSettings('product')}>管理商品与定价规则</button></div>
      <section className="automatic-connections" aria-label="全局自动化连接" aria-busy={loadingCapabilities}>
        <div><strong>{loadingCapabilities ? '正在检查全局连接…' : connectionsReady ? '全局连接已就绪' : '请先完成全局连接配置'}</strong><p>复用 DeepSeek、生图接口和 OCR，按开关执行文案复核与图片风险拦截。首图无字检查始终需要 DeepSeek 独立复核。每件商品的提示词与参考图自动准备。</p></div>
        {!loadingCapabilities && !capabilityError && !!missingCapabilities.length && <p className="small-copy">待配置或启用：{missingCapabilities.map(value => value.label).join('、')}</p>}
        {!loadingCapabilities&&!capabilityError&&<p className="small-copy">文案复核：{copyReviewEnabled?'已开启':'已关闭，仍生成文案并补齐必填字段'}。图片风险拦截：{riskEnabled?'已开启':'已关闭，首图仍检查无字'}。<button type="button" className="text-button" onClick={()=>onSettings('images')}>修改图片设置</button></p>}
        {capabilityError && <p role="alert">连接状态读取失败：{capabilityError}</p>}
        <div className="workflow-actions"><button type="button" className="text-button" disabled={disabled} onClick={() => onSettings('ai')}>配置 AI 与检测<ArrowRight size={14} /></button><button type="button" className="text-button" disabled={disabled} onClick={() => onSettings('images')}>配置生图接口<ArrowRight size={14} /></button></div>
      </section>
      <fieldset className="listing-setup" disabled={disabled}>
        <legend>1. 选择商品</legend>
        {products.length > 0 && <label className="sku-checkbox"><input type="checkbox" data-testid="automatic-select-all" checked={selected.length === products.length} ref={element => { if (element) element.indeterminate = selected.length > 0 && selected.length < products.length; }} onChange={event => setSelectedIds(event.target.checked ? products.map(product => product.id) : [])} /><span><strong>全选</strong><small>共 {products.length} 件商品</small></span></label>}
        <div className="sku-checkboxes">{products.map(product => <label className="sku-checkbox" key={product.id}><input type="checkbox" data-testid={`automatic-select-${product.id}`} checked={selectedIds.includes(product.id)} onChange={event => { setSelectedIds(values => event.target.checked ? [...values, product.id] : values.filter(id => id !== product.id)); }} /><span><strong>{product.title || '未命名商品'}</strong><small>{product.origin === 'sample' ? '本地示例 · ' : ''}{product.variantCount} 个来源规格</small></span></label>)}</div>
        {!products.length && <p className="small-copy">先从采集箱加入商品，或载入本地示例。</p>}
        <div className="workflow-actions"><button type="button" className="button secondary" disabled={loadingProducts || loadingRules || loadingHosting} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} />刷新资料与连接</button><span className="small-copy">已选择 {selected.length} 个来源商品链接。所有来源规格保留，超出限制的规格不纳入本次任务。</span></div>
        {(loadingProducts || loadingRules) && <p className="small-copy" role="status">正在读取本地商品与规则…</p>}
        {rulesError && <p className="workflow-notice" role="alert">规则读取失败：{rulesError}</p>}
        {readErrors.map(message => <p className="workflow-notice" role="alert" key={message}>{message}；请刷新后再启动。</p>)}
        {plan && !loadingProducts && <div className="workflow-notice"><strong>每件商品按来源顺序取前 {plan.variantLimit} 个来源规格；每个销售 SKU 计划备货 {plan.stockSets} 套。</strong><p>本次选中 {plan.rows.length} 个来源规格，{plan.products.reduce((sum, product) => sum + product.omitted, 0)} 个来源规格未纳入本次任务。销售 SKU 数由组套规则确定。备货数量按销售单位计算，不直接写入 Haul 库存。</p>{plan.products.map(product => <p key={product.productId}>{product.title || '未命名商品'}：选中 {product.selected}，未纳入本次 {product.omitted}{!product.selected ? '（暂无可用 SKU）' : ''}</p>)}</div>}
        {!!plan?.rows.length && <details className="listing-details"><summary>查看待处理来源规格</summary><ul className="listing-history">{plan.rows.map(row => <li key={row.key}><strong>{row.productTitle} · {row.sku}</strong><p>备货 {row.stockSets} 套 · 标签 {row.stockSets} 张；最终销售组合和采购明细由组套规则计算。</p></li>)}</ul></details>}
      </fieldset>
      <fieldset className="listing-setup" disabled={disabled}>
        <legend>2. 选择目标与图片托管</legend>
        <div className="form-grid">
          <label className="field span-full"><span>目标店铺与站点</span><select aria-label="目标店铺与站点" value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">请选择已启用的目标</option>{targets.map(value => <option key={value.id} value={value.id} disabled={!value.configured || value.paused}>{value.mode === 'demo' ? '本地演示' : '真实 Haul'} · {value.name} / {value.marketplaceName}{value.paused ? '（已暂停）' : !value.configured ? '（未配置）' : ''}</option>)}</select></label>
          <p className="small-copy span-full">每件商品使用资料和来源图独立判断类目，再获取对应 Schema；同一任务可以混合不同类目的商品。</p>
          <label className="field span-full"><span>图片托管服务器</span><select aria-label="图片托管服务器" value={profileId} disabled={loadingHosting} onChange={event => setProfileId(event.target.value)}><option value="">{loadingHosting ? '正在读取托管配置…' : '请选择已配置且启用的服务器'}</option>{profiles.map(value => <option key={value.id} value={value.id} disabled={!value.configured || !value.enabled}>{value.name}{value.configured ? ` · ${value.host}` : ' · 未配置'}{value.configured && !value.enabled ? '（未启用）' : ''}</option>)}</select></label>
        </div>
        {hostingError && <p className="workflow-notice" role="alert">托管配置读取失败：{hostingError}</p>}
        {!loadingHosting && !profile && <p className="workflow-notice">配置并启用图片托管后，任务会自动上传图片并检查公开地址。</p>}
        <button type="button" className="text-button" onClick={() => onSettings('hosting')}>管理图片托管<ArrowRight size={14} /></button>
        {target && <p className="workflow-notice">{target.mode === 'demo' ? '本地演示不会正式发布；文案、出图、OCR 和复核仍会调用已启用的服务并计入用量。' : '真实店铺将使用 Haul 规则并正式提交到 Amazon。启动时会弹出本次范围确认。'} 当前支持美国站 en_US；同款同规格按类目允许的主题建立父子体。</p>}
        {target && !supported && <p className="workflow-notice">该目标的站点或语言暂不支持，请选择美国站英文目标。</p>}
      </fieldset>
      <div className="workflow-actions"><button type="button" className="button primary" disabled={!canStart} onClick={() => { void start(); }}><Play size={16} />{starting ? '正在创建任务…' : '启动并自动发布'}</button><span className="small-copy">任务保存在本机。启动后可切换页面；暂停或取消请使用下方任务操作。</span></div>
      <p className="small-copy automatic-review-scope">每个销售 SKU 生成 7 张图，{riskEnabled?'全部检查侵权风险':'当前已关闭图片风险拦截'}；只检查第一张主图是否带字，其余图片不做 OCR 或文字复核。已通过图片保留，仅主图文字问题最多重试两次。</p>
      {notice && <p className="workflow-notice" role="status">{notice}</p>}
      {error && <p className="workflow-notice" role="alert">{error}</p>}
    </section>
    <AutomaticTaskPanel products={products} startedTask={startedTask} busy={busy} onManual={onManual} onShipping={onShipping} />
  </>;
}
