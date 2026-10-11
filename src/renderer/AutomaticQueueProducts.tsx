import { useState } from 'react';
import { ArrowRight, ChevronDown, Search } from 'lucide-react';
import type { ProductSummary } from '../shared/contracts';
import type { AutomaticListingQueue } from '../shared/automatic-listing-contracts';
import { ProductThumb, WorkspaceEmpty } from './WorkspaceParts';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import { automaticQueueReason } from './automatic-product-groups';
import { matchesQueueSearch, queueInTab, queuePresentation, queueRowInTab } from './automatic-queue-view';
import type { QueueTab } from './automatic-queue-view';
import { productGaps } from './workspace-model';
import { sourceLabel } from './utils';

const tabs: [QueueTab, string][] = [['all', '全部商品'], ['pending', '待上架'], ['repair', '待修复与核对'], ['filtered', '规则淘汰'], ['submitted', '已提交与完成']];
interface Props {
  products: ProductSummary[]; queue: AutomaticListingQueue | null; selectedIds: string[];
  disabled: boolean; loading: boolean; selectableIds: string[];
  onSelection(ids: string[]): void; onManual(id: string): void; onInbox(): void; onExamples(): void;
}
export function AutomaticQueueProducts({ products, queue, selectedIds, selectableIds, disabled, loading, onSelection, onManual, onInbox, onExamples }: Props) {
  const [tab, setTab] = useState<QueueTab>('all'), [search, setSearch] = useState(''), [page, setPage] = useState(1);
  const projection = new Map(queue?.products.map(product => [product.productId, product]));
  const visible = products.filter(product => queueInTab(projection.get(product.id), tab) && matchesQueueSearch(product.title, projection.get(product.id), search, tab));
  const pages = Math.max(1, Math.ceil(visible.length / 8)), current = Math.min(page, pages), rows = visible.slice((current - 1) * 8, current * 8);
  const visibleIds = visible.filter(product => selectableIds.includes(product.id)).map(product => product.id);
  const selectedCount = visibleIds.filter(id => selectedIds.includes(id)).length;
  const query = search.trim().toLocaleLowerCase();
  const matchingRows = (product: ProductSummary) => {
    const item = projection.get(product.id);
    return item?.rows.filter(row => !query || product.title.toLocaleLowerCase().includes(query) || queueRowInTab(row, tab) && [row.sku ?? '', row.specification, automaticQueueReason(row)].join(' ').toLocaleLowerCase().includes(query)) ?? [];
  };
  const select = (id: string, checked: boolean) => onSelection(checked ? [...new Set([...selectedIds, id])] : selectedIds.filter(value => value !== id));
  return <section className="automatic-queue automatic-unified-queue" aria-label="商品选择与处理结果">
    <div className="automatic-queue-heading"><h2>商品与销售 SKU</h2><div className="workflow-actions"><button className="button secondary" type="button" disabled={disabled} onClick={onExamples}>载入本地示例</button><button className="button secondary" type="button" disabled={disabled} onClick={onInbox}>从采集箱选择<ArrowRight size={15}/></button></div></div>
    <div className="automatic-queue-tabs" role="tablist" aria-label="自动上架结果分类">{tabs.map(([key, label]) => <button type="button" role="tab" aria-selected={tab === key} key={key} onClick={() => { setTab(key); setPage(1); }}>{label}{' '}<span>{products.filter(product => queueInTab(projection.get(product.id), key)).length}</span></button>)}</div>
    <div className="automatic-queue-toolbar"><label className="automatic-group-search"><Search size={16}/><input type="search" aria-label="搜索商品、SKU或原因" placeholder="搜索商品、SKU 或原因" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }}/></label>{search && <button type="button" className="text-button" onClick={() => { setSearch(''); setPage(1); }}>清除搜索</button>}<span className="small-copy">已选 {selectedIds.length} 件 · 筛选不改变启动范围</span></div>
    {query && <p className="small-copy automatic-search-summary">匹配：{visible.length} 个来源商品 · {visible.reduce((sum, product) => sum + matchingRows(product).length, 0)} 个销售配方</p>}
    <div className="automatic-queue-columns"><input type="checkbox" aria-label="选择当前筛选下可启动的商品" data-testid="automatic-select-all" disabled={disabled || loading || !visibleIds.length} checked={Boolean(visibleIds.length) && selectedCount === visibleIds.length} ref={element => { if (element) element.indeterminate = selectedCount > 0 && selectedCount < visibleIds.length; }} onChange={event => onSelection(event.target.checked ? [...new Set([...selectedIds, ...visibleIds])] : selectedIds.filter(id => !visibleIds.includes(id)))}/><span>商品 / 来源</span><span>规格与配方</span><span>状态与下一步</span></div>
    {!rows.length ? <WorkspaceEmpty title={search ? '没有匹配的商品或原因' : '当前分类没有商品'} description={search ? '调整关键词或清除搜索查看商品。' : '从采集箱添加商品，或选择其他分类。'}/> : rows.map(product => {
      const item = projection.get(product.id), status = queuePresentation(item), gaps = productGaps(product), selectable = selectableIds.includes(product.id);
      return <div className="automatic-queue-entry" key={product.id} data-tone={status.tone} data-selected={selectedIds.includes(product.id)}>
        <label className="automatic-row-select" title={!selectable ? '当前目标下没有可启动销售 SKU' : undefined}><input type="checkbox" aria-label={`选择 ${product.title || '未命名商品'}`} data-testid={`automatic-select-${product.id}`} disabled={disabled || loading || !selectable} checked={selectedIds.includes(product.id)} onChange={event => select(product.id, event.target.checked)}/></label>
        <details className="automatic-product" data-testid={`automatic-${product.id}`}><summary><span className="automatic-queue-identity"><ProductThumb product={product}/><span className="automatic-product-identity"><strong>{product.title || '未命名商品'}</strong><small>{product.origin === 'sample' ? '本地示例' : sourceLabel(product.sourceUrl)} · {product.assetCount} 张图</small></span></span><span className="automatic-queue-quantities"><strong>{product.variantCount} 个来源规格</strong><small>可启动 {item?.eligibleCount ?? '待核对'} 个销售 SKU</small></span><span className="automatic-queue-status"><Badge tone={status.tone}>{status.label}</Badge><small>{status.reason}</small></span><ChevronDown className="disclosure-chevron" size={16}/></summary>
          <div className="automatic-product-body">{gaps.length > 0 && <p className="workflow-notice" data-tone="warning">还需要补充：{gaps.join('、')}。</p>}
            {item && item.rows.length > 0 && <div className="automatic-recipe-table"><table><thead><tr><th>销售规格 / SKU</th><th>状态</th><th>原因与下一步</th></tr></thead><tbody>{matchingRows(product).map(row => { const state = queuePresentation({ ...item, inputIssue: undefined, rows: [row], eligibleCount: row.eligible ? 1 : 0 }); return <tr key={row.key}><td>{row.specification}<small>{row.sku || '尚未分配销售 SKU'}</small></td><td><Badge tone={state.tone}>{state.label}</Badge></td><td>{automaticQueueReason(row) || state.reason}</td></tr>; })}</tbody></table></div>}
            <div className="workflow-actions"><button type="button" className="button secondary" disabled={disabled} onClick={() => onManual(product.id)}>转手动补充资料<ArrowRight size={15}/></button><span className="small-copy">异常按 SKU 独立处理；已完成成果保留。</span></div>
          </div>
        </details>
      </div>;
    })}
    <div className="automatic-queue-footer"><span>匹配 {visible.length} / {products.length} 件 · 当前第 {current} / {pages} 页</span><div className="workflow-actions"><button type="button" className="text-button" disabled={disabled || !selectedIds.length} onClick={() => onSelection([])}>清空选择</button><button type="button" className="button secondary small-button" disabled={current <= 1} onClick={() => setPage(current - 1)}>上一页</button><button type="button" className="button secondary small-button" disabled={current >= pages} onClick={() => setPage(current + 1)}>下一页</button></div></div>
  </section>;
}
