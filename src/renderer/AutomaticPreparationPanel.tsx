import { BatchCoverage } from './AutomaticBatchStatus';
import type { ListingExecutionMode, TaskBatchPlan } from '../shared/ai-batch-contracts';
import type { ProblemContext } from './navigation-context';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Play, RefreshCw } from 'lucide-react';
import type { ProductDetail, ProductSummary } from '../shared/contracts';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { ListingRules } from '../shared/listing-rules';
import type { AiCapabilityInfo } from '../shared/ai-contracts';
import type { AutomaticListingTask, AutomaticListingQueue } from '../shared/automatic-listing-contracts';
import type { HostingProfile } from '../shared/hosting-contracts';
import { createAutomaticPreparationPlan } from './automatic-preparation';
import { AutomaticTaskPanel } from './AutomaticTaskPanel';
import { errorText } from './utils';
import type { SettingsModule } from './settings-navigation';

import { AutomaticQueueProducts } from './AutomaticQueueProducts';

interface Props {
  workBatchId?:string;taskIds?:string[];archived?:boolean;
  products: ProductSummary[]; targets: AmazonTarget[]; busy: boolean;
  taskProducts:ProductSummary[];targetId:string;onTargetChange:(id:string)=>void;queue:AutomaticListingQueue|null;queueLoading:boolean;queueError:string;onRefreshQueue:()=>void;
  onManual: (productId: string, draftId?: string, context?: ProblemContext) => void; onSettings: (module?: SettingsModule) => void;
  onExamples: () => void; onInbox: () => void;
  onShipping?: (batchId: string) => void;
}
const requiredCapabilities = [
  { capability: 'text', label: '文案与图片规划用途' }, { capability: 'text-review', label: '复核用途' },
  { capability: 'image-generation', label: 'OpenRouter 生图接口' }, { capability: 'ocr', label: '阿里云 OCR' },
  { capability: 'image-risk', label: '阿里云图片侵权检测' },
] as const;

export function AutomaticPreparationPanel({ workBatchId,taskIds,archived,products, taskProducts, targets, targetId, onTargetChange, queue, queueLoading, queueError, onRefreshQueue, busy, onManual, onSettings, onExamples, onInbox, onShipping }: Props) {
  const api = window.red;
  const [executionMode,setExecutionMode]=useState<ListingExecutionMode>('immediate');
  const [batchPlan,setBatchPlan]=useState<TaskBatchPlan|null>(null),[batchError,setBatchError]=useState(''),[batchLoading,setBatchLoading]=useState(true);
  const batchAvailable=!!batchPlan?.coverage.some(row=>row.mode==='deferred_batch');
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
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [startedTask, setStartedTask] = useState<AutomaticListingTask | null>(null);
  const mounted = useRef(true), startPending = useRef(false);
  const selectable=products.filter(product=>!targetId||!!queue?.products.find(p=>p.productId===product.id)?.eligibleCount);
  const selected = selectable.filter(product => selectedIds.includes(product.id));
  const salesRows=queue?.products.filter(p=>selectedIds.includes(p.productId)).flatMap(p=>p.rows.filter(row=>row.eligible))??[];
  const selectionKey = JSON.stringify(selected.map(product => [product.id, product.updatedAt]));
  const target = targets.find(value => value.id === targetId);
  const profile = profiles.find(value => value.id === profileId && value.configured && value.enabled);
  const plan = useMemo(() => rules ? createAutomaticPreparationPlan(details, rules) : null, [details, rules]);
  const disabled = busy || starting;
  const supported = target?.marketplaceId === 'ATVPDKIKX0DER' && target.locale === 'en_US';
  const missingCapabilities = requiredCapabilities.filter(required => (riskEnabled||required.capability!=='image-risk')&&!capabilities.some(value => value.capability === required.capability && value.available));
  const connectionsReady = !loadingCapabilities && !capabilityError && !missingCapabilities.length;
  const canStart = !archived && (executionMode==='immediate'||!batchLoading&&!batchError&&batchAvailable) && !disabled && !queueLoading && !queueError && queue?.targetId===targetId && !loadingProducts && !loadingRules && !readErrors.length && !rulesError && connectionsReady && !loadingHosting && !hostingError && Boolean(profile && salesRows.length && target?.configured && !target.paused && supported);
  const startHint = executionMode==='deferred_batch'&&(batchLoading||batchError||!batchAvailable)?'延迟批量覆盖尚未确认或没有可 Batch 步骤，请刷新或选择即时上架。': disabled ? '当前有操作进行中，请等待完成。' : !targetId ? '请先选择目标店铺。' : queueLoading || loadingProducts || loadingRules || loadingHosting || loadingCapabilities ? '正在核对商品、规则与连接，请稍候。' : queueError ? '队列读取失败，请刷新资料后再启动。' : !target?.configured || target.paused || !supported ? '请选择已配置、未暂停的美国站英文目标。' : !connectionsReady ? '请先处理上方连接配置问题。' : hostingError || !profile ? '请配置并选择已启用的图片托管服务器。' : rulesError || readErrors.length ? '商品或规则读取失败，请查看上方原因并刷新。' : !salesRows.length ? '请勾选含有可启动销售 SKU 的商品。' : '';

  useEffect(()=>{let active=true;setBatchLoading(true);setBatchError('');setBatchPlan(null);
    void Promise.resolve().then(()=>api.getAutomaticBatchPlan()).then(value=>{if(active)setBatchPlan(value);},cause=>{if(active)setBatchError(errorText(cause));}).finally(()=>{if(active)setBatchLoading(false);});
    return()=>{active=false;};
  },[api,reload]);
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
    startPending.current = true; setStarting(true); setError(''); setNotice('');
    try {
      const task = await api.startAutomaticListing({workBatchId, productIds: selected.map(value => value.id), targetId, profileId, executionMode });
      if (mounted.current) { if (task) setStartedTask(task); else setNotice('已取消启动，未创建自动上架任务。'); }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { startPending.current = false; if (mounted.current) { setStarting(false); } }
  }

  return <>
    <section className="amazon-workflow automatic-preparation" aria-label="启动自动上架">
      <div className="section-heading"><div><h2>执行设置</h2></div><button type="button" className="button secondary" disabled={disabled} onClick={() => onSettings('product')}>管理商品与定价规则</button></div>
      <fieldset className="listing-setup automatic-target-setup" disabled={disabled}>
        <legend>1. 选择目标与图片托管</legend>
        <div className="form-grid">
          <label className="field"><span>目标店铺与站点</span><select aria-label="目标店铺与站点" value={targetId} onChange={event => onTargetChange(event.target.value)}><option value="">请选择已启用的目标</option>{targets.map(value => <option key={value.id} value={value.id} disabled={!value.configured || value.paused}>{value.mode === 'demo' ? '本地演示' : '真实 Haul'} · {value.name} / {value.marketplaceName}{value.paused ? '（已暂停）' : !value.configured ? '（未配置）' : ''}</option>)}</select></label>
          <label className="field"><span>图片托管服务器</span><select aria-label="图片托管服务器" value={profileId} disabled={loadingHosting} onChange={event => setProfileId(event.target.value)}><option value="">{loadingHosting ? '正在读取托管配置…' : '请选择已配置且启用的服务器'}</option>{profiles.map(value => <option key={value.id} value={value.id} disabled={!value.configured || !value.enabled}>{value.name}{value.configured ? ` · ${value.host}` : ' · 未配置'}{value.configured && !value.enabled ? '（未启用）' : ''}</option>)}</select></label>
        </div>
        {hostingError && <p className="workflow-notice" role="alert">托管配置读取失败：{hostingError}</p>}
        {!loadingHosting && !profile && <p className="workflow-notice">配置并启用图片托管后，任务会自动上传图片并检查公开地址。</p>}
        <button type="button" className="text-button automatic-hosting-link" onClick={() => onSettings('hosting')}>管理图片托管<ArrowRight size={14} /></button>
        {target && <p className="workflow-notice">{target.mode === 'demo' ? '本地演示不会正式发布；文案、出图、OCR 和复核仍会调用已启用的服务并计入用量。' : '真实店铺将使用 Haul 规则并正式提交到 Amazon。启动时会弹出本次范围确认。'} 当前支持美国站 en_US；同款同规格按类目允许的主题建立父子体。</p>}
        {target && !supported && <p className="workflow-notice">该目标的站点或语言暂不支持，请选择美国站英文目标。</p>}
      </fieldset>
      <details open={!connectionsReady} className="automatic-connections" aria-label="全局自动化连接" aria-busy={loadingCapabilities} data-state={loadingCapabilities ? undefined : connectionsReady ? 'ready' : 'pending'}>
        <summary>{loadingCapabilities ? '正在检查全局连接…' : connectionsReady ? '全局连接已就绪 · 查看连接与复核设置' : '连接尚未就绪 · 需要处理'}</summary>
        <div><p>按 SKU 读取来源事实与参考图；首图无字检查始终使用“图片文字核对”用途所选模型。各用途按已保存的渠道与思考强度执行。</p></div>
        {!loadingCapabilities && !capabilityError && !!missingCapabilities.length && <p className="small-copy">待配置或启用：{missingCapabilities.map(value => value.label).join('、')}</p>}
        {!loadingCapabilities&&!capabilityError&&<p className="small-copy">文案复核：{copyReviewEnabled?'已开启':'已关闭，仍生成文案并补齐必填字段'}。图片风险拦截：{riskEnabled?'已开启':'已关闭，首图仍检查无字'}。<button type="button" className="text-button" onClick={()=>onSettings('images')}>修改图片设置</button></p>}
        {capabilityError && <p role="alert">连接状态读取失败：{capabilityError}</p>}
        <div className="workflow-actions"><button type="button" className="text-button" disabled={disabled} onClick={() => onSettings('ai')}>配置 AI 与检测<ArrowRight size={14} /></button><button type="button" className="text-button" disabled={disabled} onClick={() => onSettings('images')}>配置生图接口<ArrowRight size={14} /></button></div>
      </details>
      <fieldset className="listing-setup automatic-selection" disabled={disabled}>
        <legend>2. 选择商品与执行范围</legend>
        <AutomaticQueueProducts products={products} queue={queue} selectedIds={selected.map(product => product.id)} selectableIds={selectable.map(product => product.id)} disabled={disabled} loading={queueLoading} onSelection={setSelectedIds} onManual={onManual} onExamples={onExamples} onInbox={onInbox}/>
        <div className="workflow-actions"><button type="button" className="button secondary" disabled={loadingProducts || loadingRules || loadingHosting} onClick={() => {setReload(value => value + 1);onRefreshQueue();}}><RefreshCw size={15} />刷新资料与连接</button><span className="small-copy">已选择 {selected.length} 个来源商品链接。所有来源规格保留，超出限制的规格不纳入本次任务。</span></div>
        {(loadingProducts || loadingRules) && <p className="small-copy" role="status">正在读取本地商品与规则…</p>}
        {rulesError && <p className="workflow-notice" role="alert">规则读取失败：{rulesError}</p>}
        {readErrors.map(message => <p className="workflow-notice" role="alert" key={message}>{message}；请刷新后再启动。</p>)}
        {plan && !loadingProducts && <div className="workflow-notice"><strong>每个来源链接按配置、资料和代表性选择，最多 {Math.min(4,plan.variantLimit)} 个销售 SKU，不含说明性选项；每个销售 SKU 计划备货 {plan.stockSets} 套。</strong><p>{queue?`本次可启动 ${salesRows.length} 个销售 SKU。`:'选择目标店铺后计算销售配方。'}备货数量按销售单位计算，不直接写入 Haul 库存。</p>{queue?.products.filter(p=>selected.some(value=>value.id===p.productId)).map(product => <p key={product.productId}>{product.title || '未命名商品'}：可启动 {product.eligibleCount}，本次未选中 {product.notSelectedCount??0}，利润淘汰 {product.profitFilteredCount??0}，其他规则淘汰 {product.filteredCount-(product.profitFilteredCount??0)}</p>)}</div>}
        {queueLoading&&<p className="small-copy" role="status">正在核对销售配方和已保存结果…</p>}{queueError&&<p className="workflow-notice" role="alert">{queueError}</p>}
        {!!salesRows.length && <details className="listing-details"><summary>查看待处理销售配方</summary><ul className="listing-history">{salesRows.map(row => <li key={row.key}><strong>{row.specification}</strong><p>备货 {rules?.product.stockSets} 套；{row.reconsideration||'使用当前目标店铺规则'}</p></li>)}</ul></details>}
      </fieldset>

      <fieldset className="listing-setup" disabled={disabled}>
        <legend>3. 执行模式</legend>
        <label className="field"><span>上架执行模式</span><select aria-label="上架执行模式" value={executionMode} onChange={event=>setExecutionMode(event.target.value as ListingExecutionMode)}><option value="immediate">即时上架</option><option value="deferred_batch" disabled={batchLoading||!!batchError||!batchAvailable}>延迟批量（Batch）</option></select></label>
        {batchLoading?<p role="status">正在读取实际 Batch 覆盖…</p>:batchError?<p role="alert">Batch 覆盖读取失败：{batchError}。可刷新资料与连接后重试。</p>:!batchAvailable&&<p className="small-copy">延迟批量不可选：当前配置没有可 Batch 步骤，具体原因见下方覆盖。</p>}
        {batchPlan&&<details open={executionMode==='deferred_batch'}><summary>查看实际 Batch / 普通执行步骤</summary><BatchCoverage plan={batchPlan}/></details>}
      </fieldset>

      <div className="workflow-actions automatic-launch-actions"><strong>已选 {selected.length} 件商品 · 可启动 {salesRows.length} 个销售 SKU</strong><button type="button" className="button primary" disabled={!canStart} aria-describedby="automatic-start-hint" onClick={() => { void start(); }}><Play size={16} />{starting ? '正在创建任务…' : '启动并自动发布'}</button><span id="automatic-start-hint" className="small-copy">{canStart ? '任务保存在本机。启动后可切换页面；暂停或取消请使用下方任务操作。' : startHint}</span></div>
      <p className="small-copy automatic-review-scope">每个销售 SKU 生成 7 张图，{riskEnabled?'全部检查侵权风险':'当前已关闭图片风险拦截'}；只检查第一张主图是否带字，其余图片不做 OCR 或文字复核。已通过图片保留，仅主图文字问题最多重试两次。</p>
      {notice && <p className="workflow-notice" role="status">{notice}</p>}
      {error && <p className="workflow-notice" role="alert">{error}</p>}
    </section>
    <AutomaticTaskPanel taskIds={taskIds} products={taskProducts} startedTask={startedTask} busy={busy} onManual={onManual} onShipping={onShipping} />
  </>;
}
