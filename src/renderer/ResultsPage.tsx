import { usePageState } from './navigation-context';
import { ArrowUpRight, CheckCircle2, CircleDashed, RefreshCw, Search } from 'lucide-react';
import type { ProductSummary } from '../shared/contracts';
import type { AmazonDraft } from '../shared/amazon-contracts';
import { listingStateLabels } from './amazon-ui';
import type { TaskRunner } from './amazon-ui';
import { ListingFollowups } from './ListingFollowups';
import { resultCounts } from './workspace-model';
import { WorkspaceEmpty } from './WorkspaceParts';
import { formatDate } from './utils';

interface Props { products: ProductSummary[]; drafts: AmazonDraft[]; busy: boolean; run: TaskRunner; onRefresh: () => void; onOpen: (productId: string, draftId: string) => void }
export function ResultsPage({ products, drafts, busy, run, onRefresh, onOpen }: Props) {
  const [scope, setScope] = usePageState<'all' | 'live' | 'demo'>('results:scope', 'all');
  const [query, setQuery] = usePageState('results:query', '');
  const counts = resultCounts(drafts);
  const names = new Map(products.map(product => [product.id, product.title]));
  const rows = drafts.filter(draft => (scope === 'all' || draft.mode === scope) && `${draft.sku} ${draft.targetName} ${names.get(draft.productId) ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <div className="results-workspace"><div className="workspace-metrics"><div><span>正式提交记录</span><strong>{counts.submitted}</strong></div><div><span>已回读可售</span><strong>{counts.buyable}</strong></div><div><span>正式记录待处理</span><strong>{counts.attention}</strong></div><div><span>本地演示记录</span><strong>{counts.demo}</strong></div></div>
    <section className="results-panel" aria-label="上架结果列表"><div className="collection-toolbar"><div className="workspace-segments" aria-label="上架结果环境">{([['all', '全部记录'], ['live', '正式店铺'], ['demo', '本地演示']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>{label}</button>)}</div><label className="workspace-search"><Search size={17} /><input aria-label="搜索上架结果" placeholder="搜索商品、SKU 或店铺" value={query} onChange={event => setQuery(event.target.value)} /></label><button type="button" className="button secondary" disabled={busy} onClick={onRefresh}><RefreshCw size={16} />刷新记录</button></div>
      {rows.length ? <div className="result-rows">{rows.map(draft => <article key={draft.id} data-testid={`result-${draft.id}`} className="result-row"><span className={`result-marker ${draft.statuses.includes('BUYABLE') ? 'success' : ''}`}>{draft.statuses.includes('BUYABLE') ? <CheckCircle2 size={21} /> : <CircleDashed size={21} />}</span><div className="result-identity"><strong>{names.get(draft.productId) || '未命名商品'}</strong><p><span className="mono">{draft.sku}</span><span>{draft.targetName} · {draft.marketplaceId}</span></p><time>更新于 {formatDate(draft.updatedAt, true)}</time></div><div className="result-state"><span className={`quiet-pill ${['BLOCKED', 'UNKNOWN'].includes(draft.state) ? 'attention' : ''}`}>{draft.mode === 'demo' ? '演示 · ' : ''}{listingStateLabels[draft.state]}</span><small>{draft.statuses.includes('DISCOVERABLE') ? `${draft.mode === 'demo' ? '演示 ' : ''}平台可见` : draft.submittedAt ? '以回读结果为准' : '尚无已接受的提交记录'}</small></div><button type="button" className="button secondary" disabled={busy} onClick={() => onOpen(draft.productId, draft.id)}>手动处理<ArrowUpRight size={15} /></button></article>)}</div> : <WorkspaceEmpty title={query || scope !== 'all' ? '没有匹配的上架记录' : '每次上架都有迹可循'} description={query || scope !== 'all' ? '调整环境筛选或搜索关键词后再试。' : '建立上架草稿后，店铺、SKU、校验和提交结果会汇总到这里。'} />}
      <footer className="results-note"><CircleDashed size={15} />此页汇总已保存的记录。“提交已接受”与“可售”分别显示；演示数据单独标记。</footer>
    </section>
    <ListingFollowups busy={busy} run={run} onOpen={onOpen} />
  </div>;
}
