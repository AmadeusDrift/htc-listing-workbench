import { PageSizeSelect, useListPageSize } from './ListPagination';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CheckCheck, ChevronLeft, ChevronRight, FileInput, Search, Undo2 } from 'lucide-react';
import type { ProductSummary } from '../shared/contracts';
import type { MiaoshouInboxSummary } from '../shared/miaoshou-contracts';
import type { WorkspaceLane, WorkspacePlacement } from '../shared/workspace-contracts';
import { errorText, sourceLabel } from './utils';
import { productsInLane } from './workspace-model';
import { WorkspaceEmpty } from './WorkspaceParts';
import { InboxSyncBar } from './InboxSyncBar';
import { InboxProductDetail } from './InboxProductDetail';
import { InboxSourceImage } from './InboxSourceImage';
import './inbox.css';
import { loadInboxSummaryPage } from './inbox-summary-page';

interface Props {
  products: ProductSummary[]; placements: WorkspacePlacement[]; busy: boolean;
  onImport: () => void; onExamples: () => void; onOpenSettings?: () => void;
  onChanged: () => Promise<unknown>;
  onMove: (ids: string[], lane: WorkspaceLane, open?: boolean) => void;
}


export function InboxPage({ products, placements, busy, onImport, onExamples, onMove, onChanged, onOpenSettings }: Props) {
  const [pageSize, setPageSize] = useListPageSize('inbox');
  const [lane, setLane] = useState<'inbox' | 'ignored'>('inbox'), [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]), [inspectId, setInspectId] = useState<string | null>(null);
  const [page, setPage] = useState(1), [summaries, setSummaries] = useState<Record<string, MiaoshouInboxSummary>>({});
  const [summaryError, setSummaryError] = useState(''), [summaryLoading, setSummaryLoading] = useState(false), [reload, setReload] = useState(0);
  const selectAll = useRef<HTMLInputElement>(null), listViewport = useRef<HTMLDivElement>(null);
  const laneItems = useMemo(() => productsInLane(products, placements, lane), [products, placements, lane]);
  const items = useMemo(() => laneItems.filter(product => `${product.title} ${product.sourceUrl}`.toLowerCase().includes(query.trim().toLowerCase())), [laneItems, query]);
  const pages = Math.max(1, Math.ceil(items.length / pageSize)), currentPage = Math.min(page, pages);
  const pageItems = items.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pageKey = JSON.stringify(pageItems.map(item => [item.id, item.updatedAt]));
  const pageIds = pageItems.map(item => item.id);
  const ids = laneItems.filter(item => selected.includes(item.id)).map(item => item.id);
  const pageSelected = pageIds.filter(id => selected.includes(id)).length;
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages]);
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = pageSelected > 0 && pageSelected < pageIds.length; }, [pageSelected, pageIds.length]);
  useEffect(() => {
    let active = true;
    const productIds = (JSON.parse(pageKey) as [string, string][]).map(([id]) => id);
    setSummaries({}); setSummaryError(''); setSummaryLoading(productIds.length > 0);
    if (!productIds.length) return;
    void loadInboxSummaryPage(productIds, input => window.red.getMiaoshouInboxSummaries(input), () => active).then(rows => {
      if (active && rows) setSummaries(Object.fromEntries(rows.map(row => [row.productId, row])));
    }, cause => { if (active) setSummaryError(errorText(cause)); }).finally(() => { if (active) setSummaryLoading(false); });
    return () => { active = false; };
  }, [pageKey, reload]);
  const setFilter = (value: 'inbox' | 'ignored') => { setLane(value); setSelected([]); setPage(1); };
  const changePage = (value: number) => { setPage(value); listViewport.current?.scrollTo({ top: 0, left: 0 }); };
  const move = (target: WorkspaceLane) => { onMove(ids, target); setSelected([]); };
  return <div className="inbox-workspace inbox-browser">
    <InboxSyncBar busy={busy} onChanged={async () => { await onChanged(); setReload(value => value + 1); }} onOpenSettings={onOpenSettings} onImport={onImport} onExamples={() => { setFilter('inbox'); setQuery(''); onExamples(); }} />
    <section className="inbox-panel" aria-label="采集箱商品">
      <div className="collection-toolbar"><div className="workspace-segments" aria-label="采集箱分类"><button type="button" aria-pressed={lane === 'inbox'} onClick={() => setFilter('inbox')}>待整理<span>{productsInLane(products, placements, 'inbox').length}</span></button><button type="button" aria-pressed={lane === 'ignored'} onClick={() => setFilter('ignored')}>已忽略<span>{productsInLane(products, placements, 'ignored').length}</span></button></div><label className="workspace-search"><Search size={17} /><input aria-label="搜索采集箱" placeholder="搜索标题或来源" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></label></div>
      <div className="inbox-selection-scope"><button type="button" className="text-button" disabled={busy || lane !== 'inbox' || !laneItems.length} onClick={() => setSelected(laneItems.map(item => item.id))}>选中全部待整理商品（跨页，{lane === 'inbox' ? laneItems.length : productsInLane(products, placements, 'inbox').length} 件，不受搜索影响）</button><button type="button" className="text-button" disabled={busy || !pageIds.length} onClick={() => setSelected(pageIds)}>仅选中当前页商品（{pageIds.length} 件）</button><span>已选 {ids.length} 件 · 翻页与搜索保留选择</span></div>
      {summaryError && <div className="inbox-inline-error" role="alert"><span>商品参数读取失败：{summaryError}</span><button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>重试读取</button></div>}
      {items.length ? <div ref={listViewport} className="inbox-table-viewport" tabIndex={0} aria-label="采集箱商品滚动区域" aria-busy={summaryLoading}><table className="inbox-product-table"><caption className="inbox-sr-only">采集箱商品，价格、尺寸、重量与关键属性</caption><colgroup><col className="inbox-col-check" /><col className="inbox-col-image" /><col className="inbox-col-title" /><col className="inbox-col-price" /><col className="inbox-col-size" /><col className="inbox-col-weight" /><col className="inbox-col-attributes" /><col className="inbox-col-detail" /></colgroup><thead><tr><th scope="col"><input ref={selectAll} type="checkbox" aria-label="选择本页全部商品" checked={pageIds.length > 0 && pageSelected === pageIds.length} disabled={busy} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, ...pageIds])] : current.filter(id => !pageIds.includes(id)))} /></th><th scope="col">图片</th><th scope="col">商品标题</th><th scope="col">价格</th><th scope="col">尺寸</th><th scope="col">重量</th><th scope="col">关键属性</th><th scope="col"><span className="inbox-sr-only">详情</span></th></tr></thead><tbody>{pageItems.map(item => {
        const summary = summaries[item.id], title = item.title || '未命名商品';
        return <tr className={`collection-row ${selected.includes(item.id) ? 'selected' : ''}`} key={item.id} data-testid={`inbox-${item.id}`}>
          <td><input type="checkbox" aria-label={`选择 ${title}`} checked={selected.includes(item.id)} disabled={busy} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, item.id])] : current.filter(id => id !== item.id))} /></td>
          <td><InboxSourceImage productId={item.id} imageId={summary?.imageId} localUrl={item.coverUrl} alt={title} onOpen={() => setInspectId(item.id)} openLabel={`查看商品图片 ${title}`} /></td>
          <td><button type="button" className="inbox-title-button" aria-label={`查看采集资料 ${title}`} onClick={() => setInspectId(item.id)}>{title}</button><div className="inbox-row-meta"><span>{sourceLabel(item.sourceUrl)}</span><span>{item.variantCount} SKU</span>{item.origin === 'sample' && <span className="sample-tag">本地示例</span>}</div>{summary?.hasSourceUpdate && <span className="inbox-update-label">来源有更新</span>}</td>
          <td className="inbox-number-cell">{summary?.price || '—'}</td><td className="inbox-parameter-cell">{summary?.size || '—'}</td><td className="inbox-parameter-cell">{summary?.weight || '—'}</td>
          <td>{summary?.attributes.length ? <dl className="inbox-key-attributes">{summary.attributes.slice(0, 3).map((attribute, index) => <div key={`${attribute.name}-${index}`}><dt>{attribute.name}</dt><dd>{attribute.value}</dd></div>)}</dl> : <span className="inbox-missing">—</span>}</td>
          <td><button type="button" className="icon-button" aria-label={`打开商品详情 ${title}`} onClick={() => setInspectId(item.id)}><ChevronRight size={17} /></button></td>
        </tr>;
      })}</tbody></table></div> : <WorkspaceEmpty title={query ? '没有匹配的商品' : lane === 'ignored' ? '这里还没有忽略的商品' : '采集箱准备好了'} description={query ? '换一个关键词，或清空搜索查看全部商品。' : lane === 'ignored' ? '忽略的商品仍保留资料，可以随时恢复。' : '同步妙手采集箱，或导入已有的 JSON / CSV 商品资料。'}>{!query && lane === 'inbox' ? <button type="button" className="button secondary" onClick={onImport} disabled={busy}><FileInput size={17} />导入商品资料</button> : query ? <button type="button" className="button secondary" onClick={() => { setQuery(''); setPage(1); }}>清空搜索</button> : null}</WorkspaceEmpty>}
      {items.length > 0 && <nav className="inbox-pagination" aria-label="采集箱分页"><span>共 {items.length} 件</span><PageSizeSelect label="采集箱每页数量" value={pageSize} onChange={setPageSize} /><div><button type="button" className="icon-button" aria-label="采集箱上一页" disabled={currentPage <= 1} onClick={() => changePage(currentPage - 1)}><ChevronLeft size={17} /></button><span aria-live="polite">第 {currentPage} / {pages} 页</span><button type="button" className="icon-button" aria-label="采集箱下一页" disabled={currentPage >= pages} onClick={() => changePage(currentPage + 1)}><ChevronRight size={17} /></button></div></nav>}
      <div className={`collection-selection ${ids.length ? 'has-selection' : ''}`} aria-label="采集箱批量操作"><span><CheckCheck size={17} />{ids.length ? `已选择 ${ids.length} 件` : '选择商品后分配上架方式'}</span>{ids.length > 0 && <><button type="button" className="text-button" onClick={() => setSelected([])}>清空</button><div className="selection-actions">{lane === 'ignored' ? <button type="button" className="button secondary" disabled={busy} onClick={() => move('inbox')}><Undo2 size={16} />恢复到采集箱</button> : <><button type="button" className="button secondary" disabled={busy} onClick={() => move('ignored')}>忽略</button><button type="button" className="button secondary" disabled={busy} onClick={() => move('manual')}>加入手动上架</button><button type="button" className="button primary" disabled={busy} onClick={() => move('automatic')}>加入自动上架<ArrowRight size={16} /></button></>}</div></>}</div>
    </section>
    {inspectId && <InboxProductDetail onChanged={async()=>{await onChanged();setReload(n=>n+1);}} key={inspectId} productId={inspectId} hasSourceUpdate={summaries[inspectId]?.hasSourceUpdate} busy={busy} onClose={() => setInspectId(null)} onMove={onMove} />}
  </div>;
}
