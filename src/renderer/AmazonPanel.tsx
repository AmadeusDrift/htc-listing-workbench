import { ListingCorrectionPanel } from './ListingCorrectionPanel';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ClipboardCheck, Code2, FileCheck2, Layers3, RefreshCw, Save, Search, Send, ShieldCheck } from 'lucide-react';
import type { ProductDetail } from '../shared/contracts';
import type { AmazonDraft, AmazonTarget, JsonObject, ListingIssue, ListingRequirements, ParentageLevel, ProductTypeOption } from '../shared/amazon-contracts';
import type { DraftGuard, TaskRunner } from './amazon-ui';
import { listingStateLabels } from './amazon-ui';
import { objectValue, displaySchema, parseAttributes } from './schema-form';
import { SchemaFields } from './SchemaFields';
import { ListingAiPanel } from './ListingAiPanel';
import { errorText, formatDate } from './utils';
import type { WorkflowStep } from './WorkflowRail';

interface Props {
  initialDraftId?: string;
  workflowRequest: { step: WorkflowStep; token: number } | null;
  product: ProductDetail; targets: AmazonTarget[]; busy: boolean; run: TaskRunner;
  guarded: (action: () => void | Promise<unknown>) => void;
  registerGuard: (guard: DraftGuard | null) => void;
  onDirtyChange: (dirty: boolean) => void;
  onTargetsChanged: () => Promise<void>;
}
export function AmazonPanel(props: Props) {
  const { product, targets, busy, run, guarded, registerGuard, onDirtyChange } = props;
  const api = window.red;
  const [drafts, setDrafts] = useState<AmazonDraft[]>([]);
  const [draft, setDraft] = useState<AmazonDraft | null>(null);
  const [raw, setRaw] = useState('{}');
  const [fieldLocation, setFieldLocation] = useState<{path: string; token: number}>();
  const [editorMode, setEditorMode] = useState<'fields' | 'json'>('fields');
  const [targetId, setTargetId] = useState('');
  const [variantId, setVariantId] = useState(product.variants[0]?.id ?? '');
  const [productType, setProductType] = useState('');
  const [keywords, setKeywords] = useState('');
  const [types, setTypes] = useState<ProductTypeOption[]>([]);
  const [parentage, setParentage] = useState<ParentageLevel>('NONE');
  const [requirements, setRequirements] = useState<ListingRequirements>('LISTING');
  const [listingProgram, setListingProgram] = useState<'haul' | 'standard'>('haul');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const focusedRequest = useRef<number | null>(null);
  useEffect(() => {
    if (loading || !props.workflowRequest || focusedRequest.current === props.workflowRequest.token) return;
    const element = document.querySelector<HTMLElement>(`[data-workflow-step="${props.workflowRequest.step}"]`) ?? document.querySelector<HTMLElement>('.amazon-workflow');
    if (!element) return;
    element.scrollIntoView({ block: 'start', behavior: 'instant' });
    element.focus({ preventScroll: true });
    focusedRequest.current = props.workflowRequest.token;
  }, [loading, props.workflowRequest]);
  const latest = useRef({ draft, raw, run });
  latest.current = { draft, raw, run };
  const dirty = Boolean(draft && raw !== JSON.stringify(draft.attributes, null, 2));
  const selectedTarget = targets.find(target => target.id === targetId);

  function accept(value: AmazonDraft) {
    latest.current.draft = value;
    latest.current.raw = JSON.stringify(value.attributes, null, 2);
    setDraft(value); setRaw(latest.current.raw);
    setDrafts(current => [value, ...current.filter(item => item.id !== value.id)]);
    setTargetId(value.targetId); setVariantId(value.variantId); setProductType(value.schema.productType);
    setParentage(value.schema.parentageLevel); setRequirements(value.schema.requirements);
    setListingProgram(value.listingProgram ?? 'standard');
  }
  function updateRaw(value: string) { latest.current.raw = value; setRaw(value); }
  async function save(): Promise<boolean> {
    const current = latest.current;
    if (!current.draft || current.raw === JSON.stringify(current.draft.attributes, null, 2)) return true;
    let attributes: JsonObject;
    try { attributes = parseAttributes(current.raw); } catch (cause) { setNotice(errorText(cause)); return false; }
    const saved = await current.run('正在保存上架草稿…', () => api.saveAmazonDraft({ id: current.draft!.id, revision: current.draft!.revision, attributes }));
    if (!saved) return false;
    accept(saved); setNotice('上架草稿已保存，请重新校验和预览。'); return true;
  }
  const actionsRef = useRef({ save, accept });
  actionsRef.current = { save, accept };
  useEffect(() => {
    registerGuard({
      dirty: () => Boolean(latest.current.draft && latest.current.raw !== JSON.stringify(latest.current.draft.attributes, null, 2)),
      save: () => actionsRef.current.save(),
      discard: () => { if (latest.current.draft) actionsRef.current.accept(latest.current.draft); },
    });
    return () => { registerGuard(null); onDirtyChange(false); };
  }, [registerGuard, onDirtyChange]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setNotice('');
    void api.listAmazonDrafts(product.id).then(rows => {
      if (cancelled) return;
      setDrafts(rows);
      const selected = props.initialDraftId ? rows.find(row => row.id === props.initialDraftId) : rows[0];
      if (props.initialDraftId && !selected) setNotice('目标草稿已不存在；未打开其他草稿。请返回来源页面刷新。');
      if (selected) actionsRef.current.accept(selected);
      else { setDraft(null); updateRaw('{}'); }
    }).catch(cause => { if (!cancelled) setNotice(errorText(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, product.id, props.initialDraftId]);
  useEffect(() => {
    if (!targetId) {
      const candidate = targets.find(target => target.mode === 'demo' && target.configured && !target.paused);
      if (candidate) { setTargetId(candidate.id); setProductType('HTC_DEMO_STORAGE_BAG'); }
    }
  }, [targets, targetId]);

  const sourceChanged = Boolean(draft && product.revision !== draft.productRevision);
  const draftTarget = targets.find(target => target.id === draft?.targetId);
  const disabled = busy || loading;
  let parsed: JsonObject | null = null;
  let parseError = '';
  try { parsed = parseAttributes(raw); } catch (cause) { parseError = errorText(cause); }
  const lockedWrite = draft?.state === 'UNKNOWN' || draft?.state === 'SUBMITTING';
  const readOnlyDraft = Boolean(lockedWrite || draft?.submittedAt || (draft && ['SUBMITTED', 'PROCESSING', 'BUYABLE', 'DISCOVERABLE'].includes(draft.state)));
  const supportsImages = draft && Object.keys(objectValue(displaySchema(draft.schema.schema, draft.schema.schema).properties)).some(key => /image/i.test(key));

  async function operate(action: 'validate' | 'preview' | 'readback') {
    if (action !== 'readback' && !await save()) return;
    const current = latest.current.draft;
    if (!current) return;
    const reference = { id: current.id, revision: current.revision };
    const result = await run(action === 'validate' ? '正在校验类目字段…' : action === 'preview' ? '正在运行验证预览…' : '正在回读 Listing 状态…', () =>
      action === 'validate' ? api.validateAmazonDraft(reference) : action === 'preview' ? api.previewAmazonDraft(reference) : api.readAmazonListing(reference));
    if (result) { accept(result); setNotice(''); }
    await props.onTargetsChanged();
  }
  function locateField(path: string) {
    setEditorMode('fields'); setFieldLocation({ path, token: Date.now() }); setNotice('');
  }
  return <section className="amazon-workflow" data-workflow-step="fields" tabIndex={-1} aria-label="Amazon 上架工作区">
    <div className="section-heading"><div><h3>Amazon 上架</h3><p>按店铺、站点和 SKU 准备草稿，逐步确认上架结果。</p></div><span className={`mode-badge ${draft?.mode ?? selectedTarget?.mode ?? ''}`}>{draft?.mode === 'live' || (!draft && selectedTarget?.mode === 'live') ? '真实店铺' : '本地演示'}</span></div>
    {targets.length === 0 && <div className="connection-notice"><div className="connection-icon"><ShieldCheck size={21} /></div><div><strong>先配置目标店铺</strong><p>在设置中导入店铺授权，或启用本地演示体验完整流程。</p><button type="button" className="button secondary" disabled={disabled} onClick={() => { void run('正在启用演示店铺…', async () => { const target = await api.enableAmazonDemo(); await props.onTargetsChanged(); setTargetId(target.id); setProductType('HTC_DEMO_STORAGE_BAG'); }); }}>启用本地演示</button></div></div>}
    {notice && <p className="workflow-notice" role="status">{notice}</p>}
    <fieldset className="listing-setup" disabled={disabled}>
      <div className="form-grid">
        <label className="field"><span>目标店铺与站点</span><select aria-label="上架目标店铺" value={targetId} onChange={event => { const target = targets.find(item => item.id === event.target.value); setTargetId(event.target.value); setTypes([]); setProductType(target?.mode === 'demo' ? 'HTC_DEMO_STORAGE_BAG' : ''); }}><option value="">请选择目标店铺</option>{targets.map(target => <option value={target.id} key={target.id}>{target.mode === 'demo' ? '演示 · ' : ''}{target.name} / {target.marketplaceName}{target.paused ? '（已暂停）' : ''}</option>)}</select></label>
        <label className="field"><span>本次上架 SKU</span><select aria-label="上架 SKU" value={variantId} onChange={event => setVariantId(event.target.value)}>{product.variants.map(variant => <option value={variant.id} key={variant.id}>{variant.sku} · {variant.normalizedSpec || variant.originalSpec || '未填写规格'}</option>)}</select></label>
        <div className="field span-full"><label htmlFor={`type-search-${product.id}`}>搜索 Amazon 类目</label><div className="inline-controls"><input id={`type-search-${product.id}`} value={keywords} onChange={event => setKeywords(event.target.value)} placeholder="输入英文商品关键词，如 storage bag" /><button type="button" className="button secondary" disabled={!selectedTarget || selectedTarget.paused || disabled} onClick={() => { void run('正在搜索商品类目…', async () => { const found = await api.searchAmazonProductTypes({ targetId, keywords }); setTypes(found); setNotice(found.length ? `找到 ${found.length} 个类目候选，请按商品确认。` : '没有找到匹配类目，请更换关键词。'); }); }}><Search size={15} />搜索类目</button></div></div>
        <label className="field"><span>商品类型（product type）</span><input aria-label="Amazon 商品类型" list={`amazon-types-${product.id}`} value={productType} onChange={event => setProductType(event.target.value)} placeholder="选择搜索结果或填写已确认的类型代码" /><datalist id={`amazon-types-${product.id}`}>{types.map(type => <option key={type.name} value={type.name}>{type.displayName}</option>)}</datalist></label>
        <label className="field"><span>父子体层级</span><select aria-label="父子体层级" value={parentage} onChange={event => setParentage(event.target.value as ParentageLevel)}><option value="NONE">独立商品</option><option value="PARENT">父体</option><option value="CHILD">子体</option></select></label>
        <label className="field"><span>商城类型</span><select aria-label="商城类型" value={selectedTarget?.mode==='demo'?'standard':listingProgram} disabled={selectedTarget?.mode==='demo'} onChange={event=>setListingProgram(event.target.value as 'haul'|'standard')}><option value="haul">Haul 低价商城</option><option value="standard">标准商城</option></select></label>
        <label className="field"><span>字段要求</span><select aria-label="Listing 字段要求" value={requirements} onChange={event => setRequirements(event.target.value as ListingRequirements)}><option value="LISTING">完整商品与报价</option><option value="LISTING_PRODUCT_ONLY">仅商品信息</option><option value="LISTING_OFFER_ONLY">仅报价（已有商品）</option></select></label>
      </div>
      <div className="workflow-actions"><button type="button" className="button primary" disabled={disabled || !selectedTarget?.configured || selectedTarget.paused || !productType.trim() || !variantId} onClick={() => guarded(async () => {
        const value = await run('正在获取类目字段并建立草稿…', () => api.createAmazonDraft({ productId: product.id, variantId, targetId, productType: productType.trim(), parentageLevel: parentage, requirements, locale: selectedTarget?.locale ?? 'en_US', listingProgram: selectedTarget?.mode==='demo'?'standard':listingProgram }));
        if (value) { accept(value); setNotice('草稿已建立。请确认字段，销售价需要单独填写。'); }
      })}><Layers3 size={16} />获取字段并建草稿</button><span className="small-copy">每个 SKU 单独保存草稿；采购价不会作为销售价发送。</span></div>
    </fieldset>

    {drafts.length > 0 && <label className="field draft-picker"><span>已保存的上架草稿</span><select aria-label="已保存的上架草稿" value={draft?.id ?? ''} disabled={disabled} onChange={event => { const choice = drafts.find(item => item.id === event.target.value); if (choice) guarded(() => { accept(choice); setNotice(''); }); }}>{drafts.map(item => <option key={item.id} value={item.id}>{item.mode === 'demo' ? '演示 · ' : ''}{item.sku} / {item.targetName} / {listingStateLabels[item.state]} / {formatDate(item.updatedAt, true)}</option>)}</select></label>}
    {loading && <p className="small-copy">正在读取已保存的上架草稿…</p>}
    {draft && <div className="listing-draft" data-testid="amazon-draft">
      {draft.mode === 'demo' && <div className="info-strip"><InfoIcon /><span>当前为本地演示。字段、预览和可售状态均为模拟结果，不会发送到 Amazon。</span></div>}
      <div className="listing-status-line"><strong className={`listing-state ${draft.state.toLowerCase()}`}>{draft.mode === 'demo' ? '演示 · ' : ''}{listingStateLabels[draft.state]}</strong><span className="mono">{draft.sku}</span>{draft.statuses.map(status => <span key={status} className="status-badge ready">{draft.mode === 'demo' ? '演示 ' : ''}{status === 'BUYABLE' ? '可售 BUYABLE' : status === 'DISCOVERABLE' ? '可见 DISCOVERABLE' : status}</span>)}</div>
      <div className="listing-progress" aria-label="上架流程"><span><b>1</b>类目字段</span><span><b>2</b>本地校验</span><span><b>3</b>验证预览</span><span><b>4</b>提交与回读</span></div>
      <div className="schema-meta"><span>{draft.schema.productType}</span><span>版本 {draft.schema.version}</span><span>{draft.schema.fromCache ? '已复用缓存' : '已获取字段'}</span><span>{formatDate(draft.schema.fetchedAt)}</span></div>
      <p className="small-copy">此草稿：{draft.targetName} · {draft.marketplaceId} · 卖家 {draft.sellerId}</p>
      <p className="small-copy">商城：{draft.listingProgram==='haul'?'Haul 低价商城':'标准商城'} · 语言：{draft.schema.locale}</p>
      {!!draft.sourceMapping?.length&&<details className="listing-details"><summary>来源字段映射 · 已填 {draft.sourceMapping.filter(f=>f.status==='mapped').length} · 待补 {draft.sourceMapping.filter(f=>f.status==='needs_input').length} · 冲突 {draft.sourceMapping.filter(f=>f.status==='conflicting').length}</summary><p className="small-copy">待补中包含可选字段；是否必须填写以当前类目完整校验为准。来源单位不明或事实冲突时不会猜填。</p><div className="listing-mapping-rows">{draft.sourceMapping.map(f=><div className="listing-mapping-row" key={f.field}><code>{f.field}</code><span className={`status-badge ${f.status==='mapped'?'ready':f.status==='conflicting'?'blocked':f.status==='needs_input'?'warning':''}`}>{{mapped:'已填入',needs_input:'待补充',not_applicable:'不适用',conflicting:'有冲突'}[f.status]}</span><span>{f.reason}</span></div>)}</div></details>}
      <ListingAiPanel draft={draft} disabled={disabled||sourceChanged||readOnlyDraft||!!draftTarget?.paused} dirty={dirty} run={run} onAdopt={accept} onLocate={locateField}/>
      {supportsImages && <details className="listing-details image-comparison" open><summary>图片归属对照 · {product.assets.length} 张</summary><p className="small-copy">对照本地素材填写可公开访问的 HTTPS 图片地址。图片关联在“图片工作区”确认，不会按顺序自动分配给 SKU。</p>
        <div className="listing-image-grid">{product.assets.map(asset => <figure key={asset.id} className={asset.variantIds.includes(draft.variantId) ? 'sku-linked' : ''}><img src={asset.previewUrl} alt={asset.fileName} /><figcaption><strong>{asset.role === 'main' ? '商品主图' : asset.role === 'gallery' ? '商品附图' : '详情图'}</strong><span>{asset.fileName}</span><span>{asset.variantIds.includes(draft.variantId) ? `已关联本次 SKU ${draft.sku}` : asset.variantIds.length ? `已关联 ${asset.variantIds.length} 个其他 SKU` : '尚未关联 SKU'}</span></figcaption></figure>)}</div>
        {!product.assets.length && <p className="small-copy">尚未导入本地图片。</p>}
      </details>}
      {sourceChanged && <div className="workflow-warning" role="alert"><AlertCircle size={17} /><span>商品资料已变更。请使用上方按钮重新建立草稿，再执行校验和提交。</span></div>}
      {lockedWrite && <div className="workflow-warning" role="alert"><AlertCircle size={17} /><span>上次提交结果尚不明确，请先回读状态并核对平台记录。当前禁止再次提交。</span></div>}
      {draft.submittedAt && !lockedWrite && <p className="workflow-notice">此份草稿已提交，属性保留为提交时的记录。如需更新商品，请在上方建立新草稿并重新校验。</p>}
      {draftTarget?.paused && <div className="workflow-warning" role="alert"><AlertCircle size={17} /><span>目标店铺已暂停调用。请在设置中检查连接。</span></div>}
      <div className="draft-editor-heading"><h4>上架属性</h4><div className="segmented-control" aria-label="草稿编辑方式"><button type="button" disabled={disabled || !!parseError} aria-pressed={editorMode === 'fields'} onClick={() => setEditorMode('fields')}><FileCheck2 size={14} />字段表单</button><button type="button" disabled={disabled} aria-pressed={editorMode === 'json'} onClick={() => setEditorMode('json')}><Code2 size={14} />属性 JSON</button></div></div>
      {editorMode === 'fields' && parsed ? <SchemaFields locate={fieldLocation} onLocateError={setNotice} schema={draft.schema.schema} attributes={parsed} disabled={disabled || readOnlyDraft} onChange={value => updateRaw(JSON.stringify(value, null, 2))} /> : <label className="field"><span>Amazon attributes JSON</span><textarea className="json-editor" aria-label="Amazon attributes JSON" rows={16} spellCheck={false} disabled={disabled || readOnlyDraft} value={raw} onChange={event => updateRaw(event.target.value)} /></label>}
      {parseError && <p className="workflow-warning" role="alert">{parseError}</p>}
      <div className="workflow-actions" data-workflow-step="validation" tabIndex={-1}><button type="button" className="button secondary" disabled={disabled || !dirty || !!parseError || readOnlyDraft} onClick={() => { void save(); }}><Save size={15} />保存上架草稿</button>
        <button type="button" className="button secondary" disabled={disabled || sourceChanged || !!parseError || readOnlyDraft} onClick={() => { void operate('validate'); }}><ClipboardCheck size={15} />本地 Schema 校验</button>
        <button type="button" className="button secondary" disabled={disabled || sourceChanged || !!parseError || readOnlyDraft || draftTarget?.paused} onClick={() => { void operate('preview'); }}><CheckCircle2 size={15} />{draft.mode === 'demo' ? '演示验证预览' : 'Amazon 验证预览'}</button>
      </div>
      <IssueList onLocate={locateField} title="本地校验" issues={draft.localIssues} demo={draft.mode === 'demo'} empty={draft.state !== 'DRAFT' ? '本地校验未发现阻塞项。' : ''} />
      {(draft.previewedAt || draft.previewIssues.length > 0) && <IssueList onLocate={locateField} title="验证预览" issues={draft.previewIssues} demo={draft.mode === 'demo'} empty={`预览未返回 ERROR · ${draft.previewedAt ? formatDate(draft.previewedAt) : ''}`} />}
      {(draft.checkedAt || draft.listingIssues.length > 0) && <IssueList onLocate={locateField} title="Listing 回读" issues={draft.listingIssues} demo={draft.mode === 'demo'} empty="本次回读未返回待处理问题。" />}
      <div className="listing-publish" data-workflow-step="publish" tabIndex={-1}><div><h4>确认提交与状态回读</h4><p>{dirty ? '草稿有未保存的修改，保存后需要重新验证预览。' : '预览通过后，再确认店铺、站点和 SKU。提交接受后继续回读处理状态。'}</p></div><div className="workflow-actions"><button type="button" className="button primary" disabled={disabled || dirty || sourceChanged || draft.state !== 'AMAZON_VALIDATED' || draftTarget?.paused} onClick={() => { void run('正在确认并提交 Listing…', async () => { const value = await api.submitAmazonDraft({ id: draft.id, revision: draft.revision }); if (value) { accept(value); setNotice(''); } else setNotice('已取消提交，草稿保持不变。'); await props.onTargetsChanged(); }); }}><Send size={15} />{draft.mode === 'demo' ? '演示提交' : '确认正式提交'}</button><button type="button" data-workflow-step="readback" className="button secondary" disabled={disabled || dirty || (!draft.submittedAt && !lockedWrite) || draftTarget?.paused} onClick={() => { void operate('readback'); }}><RefreshCw size={15} />回读 Listing 状态</button></div></div>
      {draft.mode==='live'&&draft.schema.parentageLevel==='NONE'&&<ListingCorrectionPanel key={draft.id} draft={draft} busy={disabled||dirty||!!draftTarget?.paused} run={run} onDraft={accept} />}
      <details className="listing-details"><summary>查看将发送的商品属性</summary><pre>{JSON.stringify({ productType: draft.schema.productType, requirements: draft.schema.requirements, attributes: parsed ?? draft.attributes }, null, 2)}</pre></details>
      <details className="listing-details"><summary>处理记录 · {draft.events.length} 条</summary><ol className="listing-history">{draft.events.slice().reverse().map((event, index) => <li key={`${event.at}-${index}`}><time>{formatDate(event.at)}</time><span>{event.summary}</span>{event.requestId && <code>请求 {event.requestId}</code>}</li>)}</ol></details>
    </div>}
  </section>;
}
function InfoIcon() { return <ShieldCheck size={17} />; }
export function IssueList({ title, issues, demo, empty, onLocate }: { onLocate: (path: string) => void; title: string; issues: ListingIssue[]; demo: boolean; empty: string }) {
  if (!issues.length && !empty) return null;
  return <section className="listing-issues"><h4>{demo ? '演示 · ' : ''}{title} <span className="quiet-count">{issues.length}</span></h4>{issues.length ? <ul>{issues.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity.toLowerCase()}><AlertCircle size={17} /><div><strong>{issue.message}</strong><p>{issue.code} · {issue.attributeNames.length ? (issue.attributePaths?.length ? issue.attributePaths : issue.attributeNames).map(path => <button type="button" className="text-button" key={path} onClick={() => onLocate(path)}>定位 {path}</button>) : '商品整体'} · {issue.autoFixable ? '可按字段修改' : '需要核对或人工补充'}</p></div><span>{issue.severity}</span></li>)}</ul> : <p className="small-copy">{empty}</p>}</section>;
}
