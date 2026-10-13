import { useEffect } from 'react';
import { AlertCircle, ArrowDownToLine, Check, CheckCircle2, ChevronDown, Circle, ClipboardCheck, FileText, ImageIcon, Info, Layers3, Link2, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import type { Fact, FactState, ListingReadiness, ProductDetail, ProductStatus, Variant } from '../shared/contracts';
import { AssetsPanel } from './AssetsPanel';
import { factStateLabels, formatDate, statusLabels } from './utils';
import type { EditorTab } from './utils';
import type { WorkflowStep } from './WorkflowRail';
import { AmazonPanel } from './AmazonPanel';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { DraftGuard, TaskRunner } from './amazon-ui';

interface Props {
  product: ProductDetail;
  tab: EditorTab;
  initialDraftId?: string;
  focusVariantId?: string;
  workflowRequest: { step: WorkflowStep; token: number } | null;
  dirty: boolean;
  busy: boolean;
  readiness: ListingReadiness | null;
  onTabChange: (tab: EditorTab) => void;
  onChange: (update: (product: ProductDetail) => ProductDetail) => void;
  onSave: () => void;
  onExport: () => void;
  onImportImages: () => void;
  onUpdateAsset: (assetId: string, role: 'main' | 'gallery' | 'detail', variantIds: string[]) => void;
  onCheck: () => void;
  onImageSettings: () => void;
  amazonTargets: AmazonTarget[];
  run: TaskRunner;
  guarded: (action: () => void | Promise<unknown>) => void;
  registerGuard: (guard: DraftGuard | null) => void;
  onAmazonDirtyChange: (dirty: boolean) => void;
  onTargetsChanged: () => Promise<void>;
}

const tabs = [
  { id: 'info' as const, label: '商品资料', icon: FileText },
  { id: 'variants' as const, label: 'SKU 与规格', icon: Layers3 },
  { id: 'assets' as const, label: '图片工作区', icon: ImageIcon },
  { id: 'checks' as const, label: '上架检查', icon: ClipboardCheck },
];

export function ProductEditor(props: Props) {
  const { product, tab, dirty, busy, onChange } = props;
  useEffect(() => {
    if (tab !== 'variants' || !props.focusVariantId) return;
    const row = [...document.querySelectorAll<HTMLElement>('[data-variant-id]')].find(row => row.dataset.variantId === props.focusVariantId);
    row?.scrollIntoView({ block: 'center' }); row?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }, [tab, product.id, props.focusVariantId]);
  const update = <K extends keyof ProductDetail>(key: K, value: ProductDetail[K]) => onChange((current) => ({ ...current, [key]: value }));
  const editFact = (id: string, patch: Partial<Fact>) => onChange((current) => ({ ...current, facts: current.facts.map((fact) => fact.id === id ? { ...fact, ...patch } : fact) }));
  const editVariant = (id: string, patch: Partial<Variant>) => onChange((current) => ({ ...current, variants: current.variants.map((variant) => variant.id === id ? { ...variant, ...patch } : variant) }));

  return <section className="product-editor" aria-label="商品编辑器">
    <div className="editor-heading"><div className="editor-identity"><div className="eyebrow">PRODUCT DETAILS <span className="mono">{product.id.slice(0, 8).toUpperCase()}</span></div>
      <h2 title={product.title || '未命名商品'}>{product.title || '未命名商品'}</h2>
      <div className="editor-meta"><span className={`status-badge ${product.status}`}>{statusLabels[product.status]}</span>{product.origin === 'sample' && <span className="sample-tag">示例商品</span>}<span>更新于 {formatDate(product.updatedAt)}</span></div>
    </div><div className="editor-actions"><span className={`save-indicator ${dirty ? 'dirty' : ''}`} aria-live="polite">{dirty ? <Circle size={7} fill="currentColor" /> : <Check size={13} />}{dirty ? '有未保存的修改' : '已保存到本机'}</span><div className="editor-action-buttons"><button type="button" className="button secondary" onClick={props.onExport} disabled={busy} title="导出当前商品资料"><ArrowDownToLine size={15} />导出资料</button><button type="button" className="button primary" onClick={props.onSave} disabled={busy || !dirty}><Save size={15} />保存修改</button></div></div></div>
    <div className="editor-tabs" role="tablist" aria-label="商品编辑分类">{tabs.map(({ id, label, icon: Icon }) => <button type="button" id={`tab-${id}`} key={id} role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} className={tab === id ? 'active' : ''} disabled={busy} onClick={() => props.onTabChange(id)}><Icon size={16} />{label}{id === 'variants' && <span>{product.variants.length}</span>}{id === 'assets' && <span>{product.assets.length}</span>}</button>)}</div>
    <div className="editor-content" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {tab === 'info' && <fieldset className="editor-fieldset" disabled={busy}>
        <section className="form-section"><div className="section-heading"><div><h3>基本资料</h3><p>从来源资料开始，保留能核实的商品信息。</p></div><span className="section-marker"><FileText size={15} />商品档案</span></div>
          <div className="form-grid"><label className="field span-full"><span>商品标题</span><input aria-label="商品标题" value={product.title} maxLength={500} placeholder="填写清晰、完整的商品名称" onChange={(event) => update('title', event.target.value)} /></label>
            <label className="field source-field"><span>来源链接</span><div className="input-with-icon"><Link2 size={15} /><input aria-label="来源链接" value={product.sourceUrl} placeholder="https://detail.1688.com/…" onChange={(event) => update('sourceUrl', event.target.value)} /></div></label>
            <label className="field status-field"><span>商品状态</span><select aria-label="商品状态" value={product.status} onChange={(event) => update('status', event.target.value as ProductStatus)}><option value="draft">草稿</option><option value="ready">已就绪</option><option value="archived">已归档</option></select></label>
            <label className="field span-full"><span>商品描述 <small>可填写材质、用途及需要保留的说明</small></span><textarea aria-label="商品描述" rows={5} value={product.description} placeholder="填写已确认的商品描述…" onChange={(event) => update('description', event.target.value)} /></label>
          </div>
        </section>
        <section className="form-section facts-section"><div className="section-heading"><div><h3>商品事实 <span className="quiet-count">{product.facts.length}</span></h3><p>每条资料单独保留来源和确认状态。</p></div><button type="button" className="button secondary small-button" onClick={() => update('facts', [...product.facts, { id: crypto.randomUUID(), name: '', value: '', source: 'manual', sourceRef: '', state: 'missing' }])}><Plus size={15} />添加事实</button></div>
          {product.facts.length === 0 ? <div className="inline-empty"><Info size={20} /><div><strong>还没有商品事实</strong><p>可添加材质、尺寸、包装数量等资料，记录确认依据。</p></div></div> : <div className="facts-list">{product.facts.map((fact, index) => <div className="fact-row" key={fact.id}>
            <div className="fact-number">{String(index + 1).padStart(2, '0')}</div><div className="fact-fields"><div className="fact-main"><label className="field"><span>字段名称</span><input aria-label={`事实名称 ${index + 1}`} value={fact.name} placeholder="如：材质" onChange={(event) => editFact(fact.id, { name: event.target.value })} /></label><label className="field"><span>内容</span><input aria-label={`事实内容 ${index + 1}`} value={fact.value} placeholder="填写已知信息" onChange={(event) => editFact(fact.id, { value: event.target.value })} /></label><label className="field fact-state"><span>确认状态</span><select aria-label={`事实状态 ${index + 1}`} value={fact.state} onChange={(event) => editFact(fact.id, { state: event.target.value as FactState })}>{Object.entries(factStateLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
              <div className="fact-origin"><label className="field"><span>资料来源</span><select aria-label={`事实来源 ${index + 1}`} value={fact.source} onChange={(event) => editFact(fact.id, { source: event.target.value as Fact['source'] })}><option value="manual">人工录入</option><option value="1688">1688</option><option value="import">文件导入</option><option value="ai">AI 建议</option></select></label><label className="field"><span>来源依据</span><input aria-label={`事实来源依据 ${index + 1}`} value={fact.sourceRef} placeholder="来源链接、页码或人工确认说明" onChange={(event) => editFact(fact.id, { sourceRef: event.target.value })} /></label></div>
            </div><button type="button" className="icon-button remove-fact" aria-label={`删除事实 ${index + 1}`} title="删除此条事实" onClick={() => update('facts', product.facts.filter((item) => item.id !== fact.id))}><Trash2 size={15} /></button>
          </div>)}</div>}
        </section>
      </fieldset>}
      {tab === 'variants' && <fieldset className="editor-fieldset" disabled={busy}>
        <div className="section-heading"><div><h3>SKU 与规格 <span className="quiet-count">{product.variants.length}</span></h3><p>原始规格与整理后规格分别保存，采购价由你确认。</p></div><button type="button" className="button primary" onClick={() => update('variants', [...product.variants, { id: crypto.randomUUID(), sku: '', originalSpec: '', normalizedSpec: '', purchasePrice: '', inventory: null, sourceSpec: '', sourcePurchasePrice: '' }])}><Plus size={16} />添加 SKU</button></div>
        <div className="info-strip"><Info size={16} /><span>规格和采购价只按你的输入修改。来源快照保留各字段首次非空保存时的值。</span></div>
        {product.variants.length === 0 ? <div className="asset-empty compact"><div className="empty-icon"><Layers3 size={32} strokeWidth={1.3} /></div><h3>添加商品的第一个 SKU</h3><p>每个 SKU 单独维护规格、采购价和库存。</p></div> : <>
          <div className="variant-table-wrap"><table className="variant-table">
            <thead><tr><th className="row-number">#</th><th>SKU</th><th>原始规格</th><th>整理后规格</th><th>采购价</th><th>库存</th><th className="variant-action-column">操作</th></tr></thead>
            <tbody>{product.variants.map((variant, index) => <tr key={variant.id} data-variant-id={variant.id} data-testid={`variant-${variant.id}`}>
              <td className="row-number">{String(index + 1).padStart(2, '0')}</td>
              <td data-label="SKU"><input className="mono" aria-label={`SKU ${index + 1}`} value={variant.sku} placeholder="SKU 编码" onChange={(event) => editVariant(variant.id, { sku: event.target.value })} /></td>
              <td data-label="原始规格"><textarea aria-label={`原始规格 ${index + 1}`} value={variant.originalSpec} rows={2} placeholder="原始规格" onChange={(event) => editVariant(variant.id, { originalSpec: event.target.value })} /></td>
              <td data-label="整理后规格"><textarea aria-label={`整理后规格 ${index + 1}`} value={variant.normalizedSpec} rows={2} placeholder="整理后的规格" onChange={(event) => editVariant(variant.id, { normalizedSpec: event.target.value })} /></td>
              <td data-label="采购价"><input className="numeric" aria-label={`采购价 ${index + 1}`} inputMode="decimal" value={variant.purchasePrice} placeholder="未填写" onChange={(event) => editVariant(variant.id, { purchasePrice: event.target.value })} /></td>
              <td data-label="库存"><input className="numeric" type="number" min={0} step={1} aria-label={`库存 ${index + 1}`} value={variant.inventory ?? ''} placeholder="未填写" onChange={(event) => editVariant(variant.id, { inventory: event.target.value === '' ? null : Number(event.target.value) })} /></td>
              <td><button type="button" className="sku-remove-button" aria-label={`移除 SKU ${index + 1}`} title="保存后解除此 SKU 的图片关联，图片仍保留在商品里" onClick={() => onChange((current) => ({ ...current, variants: current.variants.filter((item) => item.id !== variant.id) }))}>移除 SKU</button></td>
            </tr>)}</tbody>
          </table></div>
          <p className="variant-removal-note">移除 SKU 后，对应图片关联将在保存时解除，图片仍保留在商品里。</p>
        </>}
        {product.variants.length > 0 && <details className="source-snapshot"><summary><span><ShieldCheck size={17} />原始来源快照<span className="snapshot-readonly">只读</span></span><ChevronDown size={15} /></summary><p>来源规格和采购价分别保留首次非空保存时的值，后续修改不会覆盖。手工创建和导入的 SKU 都会留存；尚未填写的字段暂时没有快照。</p><div className="source-table-wrap"><table><thead><tr><th>当前 SKU</th><th>来源规格</th><th>来源采购价</th></tr></thead><tbody>{product.variants.map((variant) => <tr key={variant.id}><td className="mono">{variant.sku || '未命名 SKU'}</td><td>{variant.sourceSpec || <span className="muted">无来源快照</span>}</td><td className="numeric">{variant.sourcePurchasePrice || <span className="muted">无来源快照</span>}</td></tr>)}</tbody></table></div></details>}
      </fieldset>}
      {tab === 'assets' && <><div className="image-settings-entry"><p>管理本地素材与 SKU 归属</p><button type="button" className="button secondary" disabled={busy} onClick={props.onImageSettings}><ImageIcon size={16} />图片接口</button></div><AssetsPanel product={product} busy={busy} onImport={props.onImportImages} onUpdate={props.onUpdateAsset} /></>}
      {tab === 'checks' && <><div data-workflow-step="hosting" tabIndex={-1} className="workflow-hosting-note"><Info size={19} /><div><strong>图片上传与公开地址</strong><p>自动图片上传尚未接入此工作流。当前可在上架属性中填写已有的公开 HTTPS 图片地址，并核对图片与 SKU 归属。</p></div></div><AmazonPanel key={product.id} initialDraftId={props.initialDraftId} workflowRequest={props.workflowRequest} product={product} targets={props.amazonTargets} busy={busy} run={props.run} guarded={props.guarded} registerGuard={props.registerGuard} onDirtyChange={props.onAmazonDirtyChange} onTargetsChanged={props.onTargetsChanged} /><details className="local-preflight" open><summary>本地商品资料完整性检查</summary><ChecksPanel readiness={props.readiness} busy={busy} onCheck={props.onCheck} /></details></>}
    </div>
    <footer className="editor-footer"><span><ShieldCheck size={13} />原始来源与编辑内容分别保留</span><span>修订 {product.revision}<span className="footer-divider">/</span>本地商品资料</span></footer>
  </section>;
}

function ChecksPanel({ readiness, busy, onCheck }: { readiness: ListingReadiness | null; busy: boolean; onCheck: () => void }) {
  const passed = readiness?.checks.filter((check) => check.passed).length ?? 0;
  return <div className="checks-panel"><div className="section-heading"><div><h3>上架前资料检查</h3><p>核对已保存资料的基础完整性。</p></div><button type="button" className="button primary" disabled={busy} onClick={onCheck}><ClipboardCheck size={16} />{readiness ? '重新检查' : '运行本地检查'}</button></div>
    <div className="connection-notice"><div className="connection-icon"><Info size={21} /></div><div><strong>商品资料的基础检查</strong><p>此检查核对本机保存的商品资料。目标类目校验、Amazon 预览与提交请使用上方的上架流程。</p></div><span className="neutral-badge">本地检查</span></div>
    {readiness ? <><div className="check-summary"><div className={`check-summary-icon ${passed === readiness.checks.length ? 'all-passed' : ''}`}>{passed === readiness.checks.length ? <CheckCircle2 size={25} /> : <ClipboardCheck size={25} />}</div><div><h4>{passed} / {readiness.checks.length} 项资料检查通过</h4><p>检查时间 {formatDate(readiness.checkedAt)}</p></div><span className="local-check-label">LOCAL CHECK</span></div><div className="check-list">{readiness.checks.map((check) => <div className={`check-row ${check.passed ? 'passed' : 'missing'}`} key={check.key}>{check.passed ? <CheckCircle2 size={19} /> : <AlertCircle size={19} />}<div><strong>{check.label}</strong><p>{check.detail}</p></div><span>{check.passed ? '通过' : '待完善'}</span></div>)}</div><p className="check-footnote">{readiness.note}</p></> : <div className="asset-empty compact"><div className="empty-icon"><ClipboardCheck size={33} strokeWidth={1.3} /></div><h3>先检查资料是否齐备</h3><p>运行检查后，在这里查看需要补充的资料。<br />检查结果不代表 Amazon 已批准或可直接上架。</p></div>}
  </div>;
}
