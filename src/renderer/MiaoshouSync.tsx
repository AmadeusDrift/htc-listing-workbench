import { PageSizeSelect, useListPageSize } from './ListPagination';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, RefreshCw } from 'lucide-react';
import type { MiaoshouPreview } from '../shared/miaoshou-contracts';
import type { MiaoshouSyncItemState, MiaoshouSyncPage, MiaoshouSyncPageInput, MiaoshouSyncStatus } from '../shared/miaoshou-sync-contracts';
import { errorText } from './utils';

const itemLabels: Record<MiaoshouSyncItemState, string> = { pending: '待读取', ready: '已暂存', unchanged: '未变更', failed: '读取失败' };
export function MiaoshouSync({ disabled, onPreview }: { disabled: boolean; onPreview: (preview: MiaoshouPreview) => void }) {
  const [displaySize, setDisplaySize] = useListPageSize('miaoshou-sync-records');
  const [status, setStatus] = useState<MiaoshouSyncStatus | null>(null), [items, setItems] = useState<MiaoshouSyncPage | null>(null);
  const [page, setPage] = useState(1), [filter, setFilter] = useState<MiaoshouSyncPageInput['filter']>('all'), [pageSize, setPageSize] = useState(500);
  const [working, setWorking] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const [state, rows] = await Promise.all([window.red.getMiaoshouSyncStatus(), window.red.listMiaoshouSyncItems({ page, pageSize: displaySize, filter })]);
        if (!active) return; setStatus(state); setItems(rows);
        if (page > 1 && rows.total <= (page - 1) * rows.pageSize) { setPage(Math.max(1, Math.ceil(rows.total / rows.pageSize))); return; }
        timer = setTimeout(() => void load(), state.status === 'running' ? 1000 : 5000);
      } catch (cause) { if (active) { setError(errorText(cause)); timer = setTimeout(() => void load(), 5000); } }
    }
    void load(); return () => { active = false; clearTimeout(timer); };
  }, [page, displaySize, filter, refresh]);
  async function action(operation: () => Promise<unknown>) {
    if (working || disabled) return; setWorking(true); setError('');
    try { await operation(); } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) { setWorking(false); setRefresh(value => value + 1); } }
  }
  const busy = disabled || working, running = status?.status === 'running';
  const stateText = !status || status.status === 'idle' ? '尚未同步' : status.status === 'paused' ? '已暂停，可继续' : status.status === 'completed' ? status.failed ? '已结束，部分商品读取失败' : '同步完成' : status.stage === 'listing' ? `正在收集第 ${status.nextPage} 页` : '正在读取商品详情';
  return <section className="miaoshou-sync" aria-label="妙手批量同步" aria-busy={working}>
    <div className="section-heading"><div><h3>批量同步到暂存区</h3><p>收集全部商品与 SKU，核对后再导入采集箱。再次扫描会跳过未变更的商品。</p></div><span className={`quiet-pill ${status?.failed || status?.lastError ? 'attention' : ''}`} role="status">{stateText}</span></div>
    <div className="workflow-actions">
      <label className="miaoshou-sync-page-size">每页商品数<select aria-label="同步每页商品数" value={pageSize} disabled={busy || running} onChange={event => setPageSize(Number(event.target.value))}>{[20, 50, 100, 500].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <button className="button primary" disabled={busy || running} onClick={() => void action(async () => { await window.red.startMiaoshouSync({ pageSize }); setPage(1); setFilter('all'); })}><RefreshCw size={15} />{status && status.status !== 'idle' ? '重新扫描' : '开始批量同步'}</button>
      <button className="button secondary" disabled={busy || !running} onClick={() => void action(() => window.red.pauseMiaoshouSync())}><Pause size={15} />暂停</button>
      <button className="button secondary" disabled={busy || status?.status !== 'paused'} onClick={() => void action(() => window.red.resumeMiaoshouSync())}><Play size={15} />继续同步</button>
      <button className="button secondary" disabled={busy || running || !status?.failed} onClick={() => void action(() => window.red.retryMiaoshouSyncFailures())}>重试失败项（{status?.failed ?? 0}）</button>
    </div>
    <p className="settings-help">关闭面板后继续同步；退出工作台会暂停，下次可继续。与手动读取共用请求队列，遇到限流会等待或暂停。重新扫描会保留已暂存的详情并重新核对来源更新时间。</p>
    {status && <dl className="miaoshou-sync-counts"><div><dt>发现商品</dt><dd>{status.discovered}{status.remoteTotal !== null ? ` / ${status.remoteTotal}` : ''}</dd></div><div><dt>本次已读取</dt><dd>{status.ready}</dd></div><div><dt>未变更跳过</dt><dd>{status.skipped}</dd></div><div><dt>待读取</dt><dd>{status.pending}</dd></div><div><dt>失败</dt><dd>{status.failed}</dd></div><div><dt>已暂存 SKU</dt><dd>{status.skuCount}</dd></div></dl>}
    {(error || status?.lastError) && <p className="miaoshou-error" role="alert">{error || status?.lastError}</p>}
    <div className="miaoshou-list-heading"><label>暂存商品 <select aria-label="筛选同步商品" disabled={working} value={filter} onChange={event => { setFilter(event.target.value as MiaoshouSyncPageInput['filter']); setPage(1); }}><option value="all">全部</option>{Object.entries(itemLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span>{items?.total ?? 0} 件 · 第 {page} 页</span></div>
    <div className="miaoshou-sync-items">{items?.items.map(item => <div className="miaoshou-sync-row" key={item.remoteId}>
      <div><strong>{item.title || '未命名商品'}</strong><small>编号 {item.remoteId} · {item.skuCount} SKU · 来源更新：{item.remoteModified || '未提供'}</small>{item.error && <small className="miaoshou-error">{item.error}</small>}</div>
      <span className={`miaoshou-sync-state ${item.status}`}>{itemLabels[item.status]}</span>
      <button className="button secondary" disabled={busy || !['ready', 'unchanged'].includes(item.status)} onClick={() => void action(async () => { const preview = await window.red.previewMiaoshouSyncedProduct({ id: item.remoteId }); if (mounted.current) onPreview(preview); })}>预览与映射</button>
    </div>)}</div>
    {items?.total === 0 && <p className="settings-help">{filter === 'all' ? '暂无暂存商品。同步完成的详情会显示在这里。' : '当前筛选下没有商品。'}</p>}
    <div className="workflow-actions"><PageSizeSelect label="采集同步记录每页数量" value={displaySize} onChange={value => { setItems(null); setDisplaySize(value); }}/><button className="button secondary" disabled={working || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={15} />上一页</button><button className="button secondary" disabled={working || !items || page * items.pageSize >= items.total} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={15} /></button><button className="button secondary" disabled={working} onClick={() => setRefresh(value => value + 1)}>刷新进度</button></div>
  </section>;
}
