import { startVisiblePolling } from './visible-polling.ts';
import { PageSizeSelect, useListPageSize } from './ListPagination';
import { usePageState } from './navigation-context';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Download, RefreshCw, Search, Square } from 'lucide-react';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { ProductDataObservation, ProductDataRow, ProductDataSnapshot } from '../shared/product-data-contracts';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import type { SettingsStatusTone } from './SettingsStatusBadge';
import { formatDate } from './utils';
import './operations.css';

interface Props {
  targets: AmazonTarget[];
  busy: boolean;
  onOpen(productId: string): void;
  onProcurement(context: { targetId: string; sku?: string }): void;
  onSettings(): void;
}
type Filter = '' | 'buyable' | 'attention';
function rowStatus(row: ProductDataRow): { label: string; tone: SettingsStatusTone } {
  if (row.trackingIssue) return { label: 'SKU 对应关系待处理', tone: 'danger' };
  if (row.listing.status === 'error') return { label: '状态查询失败', tone: 'danger' };
  if ((row.listing.value?.errorCount ?? 0) > 0) return { label: '平台问题待处理', tone: 'danger' };
  if (row.listing.status === 'missing') return { label: '平台暂未返回', tone: 'warning' };
  if (row.listing.value?.statuses?.includes('BUYABLE')) return { label: '可以销售', tone: 'success' };
  if (row.listing.value?.statuses?.includes('DISCOVERABLE')) return { label: '已能搜索到', tone: 'info' };
  return { label: row.listing.status === 'ok' ? '尚未确认可售' : '等待同步', tone: 'neutral' };
}
function observationNote(value: ProductDataObservation<unknown>): string {
  if (value.status === 'error') return (value.error ?? '本次读取失败') + (value.value ? '；显示上次结果' : '');
  if (value.status === 'not_applicable') return value.error ?? '此商品不适用';
  if (value.status === 'missing') return value.error ?? '平台未返回，数量未知';
  if (!value.fetchedAt) return '尚未读取';
  return '更新于 ' + formatDate(value.fetchedAt, true);
}
function Metric({ name, rows, read, source }: {
  name: string; rows: ProductDataRow[]; read(row: ProductDataRow): number | null | undefined; source: 'sales' | 'inventory';
}) {
  const known = rows.filter(row => !row.trackingIssue && read(row) != null);
  const total = known.reduce((sum, row) => sum + (read(row) ?? 0), 0);
  const old = known.filter(row => row[source].status === 'error').length;
  return <div><span>{name}</span><strong className={known.length ? 'has-data' : ''}>{known.length ? total.toLocaleString() : '—'}</strong>
    <small>已取得 {known.length} / {rows.length} 个 SKU 的数据{old > 0 ? '，其中 ' + old + ' 个为上次结果' : ''}</small></div>;
}
const count = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString();
export function ProductDataPage({ targets, busy, onOpen, onProcurement, onSettings }: Props) {
  const readElement = useRef<HTMLElement>(null);
  const [pageSize, setPageSize] = useListPageSize('product-data');
  const live = targets.filter(target => target.mode === 'live');
  const [selection, setSelection] = usePageState('data:selection', '');
  const target = live.find(item => item.id === selection) ?? live.find(item => item.configured) ?? live[0];
  const targetId = target?.id ?? '';
  const [snapshot, setSnapshot] = useState<ProductDataSnapshot | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [query, setQuery] = usePageState('data:query', ''), [filter, setFilter] = usePageState<Filter>('data:filter', ''), [page, setPage] = usePageState('data:page', 0);
  const currentTarget = useRef(targetId), currentSnapshot = useRef(snapshot), requestId = useRef(0), mounted = useRef(false), acting = useRef(false);
  currentTarget.current = targetId; currentSnapshot.current = snapshot;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current++; }; }, []);
  useEffect(() => {
    let active = true, reading = false;
    const scope = targetId;
    requestId.current++; acting.current = false; setSnapshot(null); currentSnapshot.current = null; setError(''); setLoading(Boolean(scope));
    async function read(initial = false) {
      if (!scope || reading || acting.current) return;
      reading = true;
      const id = ++requestId.current;
      try {
        const result = await window.red.getAmazonProductData(scope);
        if (active && currentTarget.current === scope && requestId.current === id) {
          currentSnapshot.current = result; setSnapshot(result); setError('');
        }
      } catch {
        if (active && requestId.current === id) setError('本机商品记录读取失败，请刷新重试。');
      } finally {
        reading = false;
        if (initial && active && requestId.current === id) setLoading(false);
      }
    }
    const stop = startVisiblePolling(async resumed => { if (resumed || currentSnapshot.current?.job.state === 'running') await read(true); return 5000; }, { element: () => readElement.current });
    return () => { active = false; stop(); };
  }, [targetId]);
  async function action(kind: 'get' | 'sync' | 'stop') {
    if (!targetId || acting.current) return;
    const scope = targetId, id = ++requestId.current;
    acting.current = true; setLoading(true); setError('');
    try {
      const result = await (kind === 'sync' ? window.red.syncAmazonProductData(scope)
        : kind === 'stop' ? window.red.stopAmazonProductDataSync(scope) : window.red.getAmazonProductData(scope));
      if (mounted.current && currentTarget.current === scope && requestId.current === id) {
        currentSnapshot.current = result; setSnapshot(result);
      }
    } catch {
      if (mounted.current && currentTarget.current === scope && requestId.current === id) setError('操作未完成，请核对店铺连接后重试。');
    } finally {
      if (mounted.current && currentTarget.current === scope && requestId.current === id) { acting.current = false; setLoading(false); }
    }
  }
  const all = snapshot?.scope.targetId === targetId ? snapshot.rows : [];
  const job = snapshot?.scope.targetId === targetId ? snapshot.job : null;
  const running = job?.state === 'running';
  const attention = (row: ProductDataRow) => Boolean(row.trackingIssue || (row.listing.value?.errorCount ?? 0) > 0
    || [row.listing, row.inventory, row.sales].some(value => value.status === 'error'));
  const rows = all.filter(row => (!filter || (filter === 'buyable' ? rowStatus(row).label === '可以销售' : attention(row)))
    && (row.title + ' ' + row.sku + ' ' + (row.listing.value?.asin ?? '')).toLowerCase().includes(query.trim().toLowerCase()));
  const safePage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);
  return <section ref={readElement} className="operations-page product-data-page">
    <div className="ops-toolbar">
      <label className="ops-grow">查看哪个店铺<select value={targetId} disabled={busy || loading || running} onChange={event => { setSelection(event.target.value); setPage(0); }}>
        {!live.length && <option value="">尚未连接正式店铺</option>}{live.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <Badge tone="info">仅本软件上传的商品</Badge>
      <button type="button" className="button secondary" disabled={busy || loading || !targetId} onClick={() => void action('get')}><RefreshCw size={15} />刷新本机记录</button>
      {running ? <button type="button" className="button secondary" disabled={loading} onClick={() => void action('stop')}><Square size={14} />停止同步</button>
        : <button type="button" className="button primary" disabled={busy || loading || !target?.configured || target.paused || !all.some(row => !row.trackingIssue)} onClick={() => void action('sync')}><Download size={15} />从 Amazon 同步数据</button>}
    </div>
    <p className="ops-purpose">只跟踪通过本软件正式上传的商品；店铺旧商品、示例商品和未正式提交的草稿不进入这里。销量从对应 SKU 首次在本软件正式提交后开始计算。</p>
    {error && <div role="alert" className="product-data-error">{error}</div>}
    {!targetId && <div className="ops-panel"><p>连接 Amazon 店铺，并通过本软件正式上传商品后，可以在这里查看数据。</p><button type="button" className="button secondary" onClick={onSettings}>去连接店铺</button></div>}
    {snapshot?.message && <p className="ops-hint">{snapshot.message}</p>}
    {job && job.state !== 'idle' && <div className="ops-panel product-data-progress" role="status" aria-live="polite">
      <div className="ops-actions"><strong>{running ? '正在同步商品数据' : job.state === 'stopped' ? '同步已停止' : job.state === 'failed' ? '同步中断' : job.errors ? '同步完成，部分数据需重试' : '同步完成'}</strong>
        <span>{job.completed} / {job.total} 项{job.errors > 0 ? ' · ' + job.errors + ' 项读取失败' : ''}</span></div>
      {running && <progress aria-label="商品数据同步进度" max={Math.max(job.total, 1)} value={job.completed} />}
      <p>{job.message ?? (running ? '先查询商品状态和库存，再按接口允许的速度逐个读取销量；可以离开此页面。' : '各项数据的实际读取时间显示在下方。')}</p>
    </div>}
    <div className="ops-panel">
      <div className="ops-actions"><div className="ops-grow"><h2>销量和库存</h2><p>当前跟踪 {all.length} 个新上架 SKU。统计保留平台返回的实际数量，缺失数据显示“—”。</p></div>
        <Badge tone={all.some(attention) ? 'warning' : 'info'}>{all.some(attention) ? '部分数据待处理' : '按已取得的数据汇总'}</Badge></div>
      <div className="business-metrics">
        <Metric name="近 7 天销量" rows={all} source="sales" read={row => row.sales.value?.units7d} />
        <Metric name="近 30 天销量" rows={all} source="sales" read={row => row.sales.value?.units30d} />
        <Metric name="可售库存" rows={all} source="inventory" read={row => row.inventory.value?.fulfillable} />
        <Metric name="待入库库存" rows={all} source="inventory" read={row => row.inventory.value?.inbound} />
      </div>
      <p className="ops-hint">销量为 Amazon Haul 下单件数，按 UTC 自然日统计，包含今天且不早于本软件首次提交时间；库存读取当前店铺、站点和对应 SKU 的 FBA 数据；待入库包含准备发货、已发货和接收中的数量。销量在同一 UTC 日期内最多复用 6 小时，减少重复请求；刷新失败时保留上次结果及时间。补货建议将在补货周期等规则确定后接入。</p>
    </div>
    <div className="ops-panel">
      <div className="ops-actions"><div className="ops-grow"><h2>按商品规格查看</h2><p>颜色、尺寸按 SKU 分别列出；同一店铺、站点的同一 SKU 只统计一次。</p></div>
        <button type="button" className="button secondary" disabled={busy} onClick={() => onProcurement({ targetId })}>去采购备货<ArrowUpRight size={15} /></button></div>
      <div className="ops-actions">
        <label className="workspace-search ops-grow"><Search size={16} /><input aria-label="搜索商品数据" value={query} maxLength={300} placeholder="搜索商品、SKU 或 ASIN" onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
        <label>显示范围<select value={filter} onChange={event => { setFilter(event.target.value as Filter); setPage(0); }}><option value="">全部情况</option><option value="buyable">可以销售</option><option value="attention">需要处理</option></select></label><span>{rows.length} 个规格</span>
      </div>
      {!rows.length ? <div className="ops-empty"><strong>{loading ? '正在读取本机记录…' : query || filter ? '没有符合筛选条件的商品' : '等待第一件正式上传的商品'}</strong>
        <p>通过本软件正式提交后自动加入跟踪清单，再点“从 Amazon 同步数据”读取平台结果。</p></div>
        : <><div data-scroll-key="product-data-table" className="ops-table-wrap"><table><thead><tr><th>商品 / SKU</th><th>上架情况</th><th>近 7 / 30 天销量</th><th>可售 / 待入库库存</th><th>补货参考</th><th>操作</th></tr></thead>
          <tbody>{rows.slice(safePage * pageSize, (safePage + 1) * pageSize).map(row => {
            const state = rowStatus(row);
            return <tr key={row.sku}><td><div className="ops-product">{row.coverUrl && <img src={row.coverUrl} alt="商品图" />}<div><strong>{row.title}</strong><small>{row.sku}</small><small>{row.listing.value?.asin ?? 'ASIN 待确认'}</small><small>开始跟踪 {formatDate(row.salesSince, true)}</small></div></div></td>
              <td><Badge tone={state.tone}>{state.label}</Badge><small>{row.trackingIssue ?? observationNote(row.listing)}</small>
                {row.listing.status === 'error' && row.listing.fetchedAt && <small>上次成功 {formatDate(row.listing.fetchedAt, true)}</small>}
                {row.listing.value?.issues.slice(0, 2).map((issue, i) => <small key={i}>{issue.message}</small>)}</td>
              <td>{row.trackingIssue ? '— / —' : count(row.sales.value?.units7d) + ' / ' + count(row.sales.value?.units30d)}<small>{observationNote(row.sales)}</small>
                {row.sales.status === 'error' && row.sales.fetchedAt && <small>上次成功 {formatDate(row.sales.fetchedAt, true)}</small>}</td>
              <td>{row.trackingIssue ? '— / —' : count(row.inventory.value?.fulfillable) + ' / ' + count(row.inventory.value?.inbound)}<small>{observationNote(row.inventory)}</small>
                {row.inventory.status === 'error' && row.inventory.fetchedAt && <small>上次成功 {formatDate(row.inventory.fetchedAt, true)}</small>}</td>
              <td>暂未启用<small>待确定补货周期与规则</small></td>
              <td><button type="button" className="button secondary" disabled={busy} onClick={() => onOpen(row.productId)}>查看商品</button><button type="button" className="button secondary" disabled={busy} onClick={() => onProcurement({ targetId, sku: row.sku })}>采购此 SKU</button></td></tr>;
          })}</tbody></table></div>
          {rows.length > 0 && <div className="ops-pagination"><PageSizeSelect label="商品数据每页数量" value={pageSize} onChange={setPageSize}/><button type="button" className="button secondary" disabled={!safePage || busy} onClick={() => setPage(safePage - 1)}>上一页</button><span>{safePage + 1} / {Math.ceil(rows.length / pageSize)} 页</span><button type="button" className="button secondary" disabled={(safePage + 1) * pageSize >= rows.length || busy} onClick={() => setPage(safePage + 1)}>下一页</button></div>}</>}
    </div>
  </section>;
}

