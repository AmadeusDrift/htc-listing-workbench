import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, RefreshCw, Save } from 'lucide-react';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { CategoryLibrary, CategoryMatch } from '../shared/catalog-contracts';
import type { ProcurementBatch, ProcurementBatchSummary, ProcurementCandidate, ProcurementLine } from '../shared/procurement-contracts';
import type { DraftGuard, TaskRunner } from './amazon-ui';
import { ShippingPanel } from './ShippingPanel';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import { errorText } from './utils';
import './operations.css';

interface Props {
  targets: AmazonTarget[]; busy: boolean; run: TaskRunner;
  guarded(action: () => void | Promise<unknown>): void;
  registerGuard(guard: DraftGuard | null): void; onDirtyChange(dirty: boolean): void;
  section: 'procurement' | 'shipping' | 'catalog'; initialBatchId?: string; initialProcurementContext?: { targetId: string; sku?: string };
  onShipping(batchId: string): void; onProcurement(): void;
}
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const PAGE = 100;
export function OperationsPage({ targets, busy, run, guarded, registerGuard, onDirtyChange, section: tab, initialBatchId, initialProcurementContext, onShipping, onProcurement }: Props) {
  const api = window.red;
  const [targetId, setTargetId] = useState(initialProcurementContext?.targetId ?? targets.find(item => item.mode === 'live')?.id ?? targets[0]?.id ?? '');
  const [candidates, setCandidates] = useState<ProcurementCandidate[]>([]);
  const [batches, setBatches] = useState<ProcurementBatchSummary[]>([]);
  const [batch, setBatch] = useState<ProcurementBatch | null>(null);
  const [library, setLibrary] = useState<CategoryLibrary | null>(null);
  const [matches, setMatches] = useState<CategoryMatch[]>([]);
  const [query, setQuery] = useState('');
  const [skuFilter, setSkuFilter] = useState(initialProcurementContext?.sku ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState(`${new Date().toLocaleDateString('zh-CN')} 备货`);
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const current = useRef<ProcurementBatch | null>(null), saved = useRef<ProcurementBatch | null>(null);
  const dirty = JSON.stringify(batch) !== JSON.stringify(saved.current);
  const locked = busy || loading;
  const target = targets.find(item => item.id === targetId);
  const saveAction = useRef<() => Promise<boolean>>(async () => false);
  function commit(value: ProcurementBatch | null) { current.current = value; saved.current = value; setBatch(value); if (value) setTargetId(value.lines[0].targetId); onDirtyChange(false); setPage(0); }
  function change(value: ProcurementBatch) { current.current = value; setBatch(value); onDirtyChange(JSON.stringify(value) !== JSON.stringify(saved.current)); setNotice(''); }
  function editLine(id: string, patch: Partial<ProcurementLine>) { if (current.current) change({ ...current.current, lines: current.current.lines.map(line => line.id === id ? { ...line, ...patch } : line) }); }
  async function refresh() {
    if (tab === 'catalog') { if (targetId) setLibrary(await api.getCategoryLibrary(targetId)); return; }
    const [available, existing] = await Promise.all([tab === 'procurement' ? api.listProcurementCandidates() : Promise.resolve([]), api.listProcurementBatches()]);
    setCandidates(available); setBatches(existing);
  }
  async function save(): Promise<boolean> {
    const value = current.current; if (!value) return true;
    return await run('正在保存备货单…', async () => {
      const updated = await api.updateProcurementBatch({ id: value.id, revision: value.revision, shipmentConfirmationId: value.shipment?.confirmationId ?? '',
        lines: value.lines.map(({ id, purchaseQuantity, stockQuantity, purchasePrice, purchaseUnit, priceConfirmed }) => ({ id, purchaseQuantity, stockQuantity, purchasePrice, purchaseUnit, priceConfirmed })) });
      commit(updated); setNotice('备货单已保存'); setBatches(await api.listProcurementBatches()); return true;
    }) === true;
  }
  saveAction.current = save;
  useEffect(() => {
    registerGuard({ dirty: () => JSON.stringify(current.current) !== JSON.stringify(saved.current), save: () => saveAction.current(), discard: () => { current.current = saved.current; setBatch(saved.current); onDirtyChange(false); } });
    return () => { registerGuard(null); onDirtyChange(false); };
  }, [registerGuard, onDirtyChange]);
  useEffect(() => {
    let active = true;
    Promise.all([tab === 'procurement' ? api.listProcurementCandidates() : Promise.resolve([]), tab !== 'catalog' ? api.listProcurementBatches() : Promise.resolve([]), initialBatchId ? api.getProcurementBatch(initialBatchId) : Promise.resolve(null)]).then(([available, existing, initial]) => {
      if (active) { setCandidates(available); setBatches(existing); if (initial) commit(initial); }
    }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, tab, initialBatchId]);
  useEffect(() => {
    let active = true; setLibrary(null); setMatches([]);
    if (tab === 'catalog' && targetId) void api.getCategoryLibrary(targetId).then(value => { if (active) setLibrary(value); }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [api, targetId, tab]);
  const available = candidates.filter(row => row.targetId === targetId && (!skuFilter || targetId !== initialProcurementContext?.targetId || row.sku === skuFilter));
  const eligible = available.filter(row => row.eligible);
  return <section className="operations-page">
    <div className="ops-toolbar"><p className="ops-purpose ops-grow">{tab === 'procurement' ? '选商品、填数量，生成带采购链接的备货单。' : tab === 'shipping' ? '按备货单对应商品标签，并记录 Amazon 货件号。' : '把 Amazon 上架类目保存到本机，方便查找。'}</p>
      {tab !== 'shipping' && <label>店铺<select aria-label="店铺" value={targetId} disabled={locked} onChange={event => { const value = event.target.value; guarded(() => { setTargetId(value); setSelected([]); commit(null); setPage(0); }); }}><option value="" disabled>请选择店铺</option>{targets.map(item => <option value={item.id} key={item.id}>{item.name} · {item.mode === 'demo' ? '演示' : item.marketplaceName}</option>)}</select></label>}
      {target && tab !== 'shipping' && <Badge tone={target.mode === 'demo' ? 'warning' : 'info'}>{target.mode === 'demo' ? '本地演示' : '正式店铺'}</Badge>}
      <button type="button" className="button secondary" disabled={locked} onClick={() => { void run('正在刷新记录…', async () => { await refresh(); setError(''); }); }}><RefreshCw size={15} />刷新记录</button>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}{notice && <p className="ops-notice" role="status">{notice}</p>}
    {loading ? <p className="ops-empty">正在读取本地记录…</p> : tab === 'catalog' ? <div className="ops-panel"><h2>上架类目库</h2><p>先同步当前站点的产品类型索引，再在本机查找。具体上架字段仍按所选类型和店铺读取。</p><div className="ops-actions"><button type="button" className="button primary" disabled={locked || !targetId} onClick={() => { void run('正在同步站点产品类型…', async () => { const value = await api.syncCategoryLibrary(targetId); setLibrary(value); setMatches(await api.searchLocalCategories({ targetId, query })); }); }}>下载／更新类目库</button><span>{library ? `${library.productTypes.length} 个类型 · 同步于 ${time(library.fetchedAt)}` : '尚未同步'}</span></div>
      <form className="ops-actions" onSubmit={event => { event.preventDefault(); void run('正在查找本地类目…', async () => setMatches(await api.searchLocalCategories({ targetId, query }))); }}><label className="ops-grow">查找类目<input value={query} maxLength={300} disabled={locked} placeholder="例如 coaster、storage bag" onChange={event => setQuery(event.target.value)} /></label><button className="button secondary" type="submit" disabled={locked || !library}>在本机查找</button></form>
      <p className="ops-hint">当前是产品类型索引。完整类目树、自动分类与历史匹配经验将继续补充；这里的文字匹配分数不代表 Amazon 的置信度或 Haul 可售资格。</p>
      <div className="ops-table-wrap"><table><thead><tr><th>产品类型</th><th>名称</th><th>本地匹配依据</th></tr></thead><tbody>{matches.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.displayName}</td><td>{item.reason}{query ? ` · ${item.score}` : ''}</td></tr>)}</tbody></table></div>{!matches.length && <p className="ops-empty">同步后输入关键词检索；没有匹配时可调整关键词。</p>}
    </div> : <>
      <div className="ops-actions"><label className="ops-grow">选择备货单<select value={batch?.id ?? ''} disabled={locked} onChange={event => { const id = event.target.value; guarded(() => { if (!id) commit(null); else void run('正在打开备货单…', async () => { commit(await api.getProcurementBatch(id)); setSelected([]); }); }); }}><option value="">{tab === 'shipping' ? '请选择备货单' : '创建新备货单'}</option>{batches.map(item => <option key={item.id} value={item.id}>{item.mode === 'demo' ? '[演示] ' : ''}{item.name} · {item.lineCount} SKU · {item.code}</option>)}</select></label>{batch && tab === 'procurement' && <button type="button" className="button secondary" disabled={locked} onClick={() => guarded(() => commit(null))}>新建备货单</button>}</div>
      {tab === 'shipping' && !batch ? <div className="ops-panel ops-empty"><h2>先选择一张备货单</h2><p>商品标签和箱唛按备货单分别整理。还没有备货单时，先到“采购备货”选择商品。</p><button type="button" className="button primary" disabled={locked} onClick={onProcurement}>去采购备货</button></div> : !batch ? <div className="ops-panel"><h2>选择这次要采购的商品</h2><p>选择 Amazon 已生成商品记录的 SKU，颜色、尺寸分别处理。备货单会保留对应的 1688 采购链接。</p><div className="ops-actions"><label className="ops-grow">备货单名称<input value={name} maxLength={100} disabled={locked} onChange={event => setName(event.target.value)} /></label><button type="button" className="button primary" disabled={locked || !selected.length || !name.trim()} onClick={() => { void run('正在创建备货单…', async () => { const value = await api.createProcurementBatch({ name, draftIds: selected }); commit(value); setSelected([]); setBatches(await api.listProcurementBatches()); }); }}>生成备货单（{selected.length} SKU）</button></div>
        <div className="ops-actions"><button type="button" className="button secondary" disabled={locked || !eligible.length} onClick={() => setSelected(eligible.slice(0,5000).map(row => row.draftId))}>选择可备货商品</button><button type="button" className="button secondary" disabled={locked || !selected.length} onClick={() => setSelected([])}>清空选择</button><span>{skuFilter && <button type="button" className="text-button" onClick={() => { setSkuFilter(''); setPage(0); }}>显示店铺全部 SKU</button>}可备货 {eligible.length} / {available.length} 个 SKU</span></div>
        {!available.length ? <p className="ops-empty">该店铺还没有上架草稿。已有商品完成提交并取得平台查询结果后，会在这里显示。</p> : <><div className="ops-table-wrap"><table><thead><tr><th>选择</th><th>商品 / SKU</th><th>规格 / 采购价</th><th>来源链接</th><th>备货状态</th></tr></thead><tbody>{available.slice(page*PAGE,(page+1)*PAGE).map(row => <tr key={row.draftId}><td><input type="checkbox" aria-label={`选择 ${row.sku}`} checked={selected.includes(row.draftId)} disabled={locked || !row.eligible} onChange={event => setSelected(values => event.target.checked ? [...values,row.draftId] : values.filter(id => id !== row.draftId))} /></td><td>{row.title}<small>{row.sku}</small></td><td>{row.spec}<small>{row.sourcePurchasePrice || '采购价待填'} {row.currency === 'CNY' ? 'CNY' : ''}</small></td><td>{row.sourceUrl ? <span className="ops-url" title={row.sourceUrl}>{row.sourceUrl}</span> : '待补充'}</td><td><Badge tone={row.eligible ? 'success' : 'neutral'}>{row.eligible ? '可以备货' : '等待确认'}</Badge><small>{row.reason}</small></td></tr>)}</tbody></table></div><Pager count={available.length} page={page} setPage={setPage} /></>}
      </div> : tab === 'shipping' ? <ShippingPanel key={batch.id} batch={batch} busy={locked} dirty={dirty} run={run} onChange={change} onSave={save} /> : <div className="ops-panel"><div className="ops-actions"><div className="ops-grow"><h2>{batch.name}</h2><p>{batch.code} · 修订 {batch.revision} · {batch.lines.length} SKU · {batch.mode === 'demo' ? '本地演示' : '正式备货'}</p></div><button type="button" className="button primary" disabled={locked || !dirty} onClick={() => { void save(); }}><Save size={15} />保存修改</button>{(['csv','html'] as const).map(format => <button type="button" className="button secondary" key={format} disabled={locked || dirty} onClick={() => { void run('正在导出备货单…', async () => { const result = await api.exportProcurementBatch({ id: batch.id, format }); if (!result.cancelled) setNotice('备货单已导出'); }); }}><Download size={15} />{format === 'csv' ? '导出表格' : '可打印备货单'}</button>)}</div>
        <p>分别填写向供应商采购多少，以及发往 Amazon 多少。发往 Amazon 的数量按销售单位计算，例如 3 件套要填写套数。</p>
        <div className="ops-table-wrap"><table><thead><tr><th>图片 / 商品 / SKU</th><th>采购链接</th><th>采购数量 / 单位</th><th>采购单价</th><th>发往 Amazon 的数量</th></tr></thead><tbody>{batch.lines.slice(page*PAGE,(page+1)*PAGE).map(line => <tr key={line.id}><td><div className="ops-product">{line.imageAssetId && <img alt="商品图" src={`red-asset://image/${line.imageAssetId}`} />}<div>{line.title}<small>{line.spec}</small>{line.salesRecipe && line.stockQuantity !== null && <small>{salesPurchaseDescription(line.salesRecipe,line.stockQuantity)}</small>}<strong>{line.sku}</strong><small>{line.targetName} · ASIN {line.asin || '待确认'}</small></div></div></td><td>{line.sourceUrl ? <><button type="button" className="button secondary" disabled={locked} onClick={() => { void run('正在打开采购来源…', () => api.openProcurementSource({ batchId: batch.id, lineId: line.id })); }}><ExternalLink size={14} />来源商品</button><small className="ops-url">{line.sourceUrl}</small></> : '来源链接待补充'}</td><td><input aria-label={`${line.sku} 采购数量`} type="number" min={0} max={1000000} step={1} value={line.purchaseQuantity ?? ''} disabled={locked} placeholder="待填" onChange={event => editLine(line.id, { purchaseQuantity: event.target.value === '' ? null : Number(event.target.value) })} /><input aria-label={`${line.sku} 采购单位`} value={line.purchaseUnit} maxLength={40} disabled={locked} placeholder="件 / 包" onChange={event => editLine(line.id, { purchaseUnit: event.target.value })} /></td><td><input aria-label={`${line.sku} 采购单价`} inputMode="decimal" value={line.purchasePrice} maxLength={20} disabled={locked} onChange={event => editLine(line.id, { purchasePrice: event.target.value, priceConfirmed: false })} /><small>{line.currency === 'CNY' ? '人民币 CNY' : '币种待确认'}</small><label className="ops-check"><input type="checkbox" checked={line.priceConfirmed} disabled={locked || !line.purchasePrice} onChange={event => editLine(line.id, { priceConfirmed: event.target.checked })} />价格已确认</label></td><td><input aria-label={`${line.sku} 备货数量`} type="number" min={0} max={1000000} step={1} value={line.stockQuantity ?? ''} disabled={locked} placeholder="待填" onChange={event => editLine(line.id, { stockQuantity: event.target.value === '' ? null : Number(event.target.value) })} /></td></tr>)}</tbody></table></div><Pager count={batch.lines.length} page={page} setPage={setPage} />
        <div className="ops-shipment"><h3>备货单整理好后，继续发货与贴标</h3><p>商品标签、箱唛和货件号在独立的“发货与标签”页面查看。修改数量后请先保存。</p><button type="button" className="button secondary" disabled={locked || dirty} onClick={() => onShipping(batch.id)}>去发货与标签</button></div>
      </div>}
    </>}
  </section>;
}
function Pager({ count, page, setPage }: { count: number; page: number; setPage(value: number): void }) {
  return count > PAGE ? <div className="ops-pagination"><button type="button" className="button secondary" disabled={page <= 0} onClick={() => setPage(page-1)}>上一页</button><span>{page+1} / {Math.ceil(count/PAGE)} 页 · 共 {count} 行</span><button type="button" className="button secondary" disabled={(page+1)*PAGE >= count} onClick={() => setPage(page+1)}>下一页</button></div> : null;
}
import { salesPurchaseDescription } from '../shared/sales-purchase';
