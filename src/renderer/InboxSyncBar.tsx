import { PageSizeSelect, useListPageSize } from './ListPagination';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileInput, LoaderCircle, MoreHorizontal, PackageOpen, Pause, Play, RefreshCw, Settings2, X } from 'lucide-react';
import type { MiaoshouStatus } from '../shared/miaoshou-contracts';
import type { MiaoshouSyncPage, MiaoshouSyncPageInput, MiaoshouSyncStatus } from '../shared/miaoshou-sync-contracts';
import { errorText, formatDate } from './utils';
import { InboxDialog } from './InboxDialog';

interface Props {
  busy: boolean; onChanged: () => Promise<unknown>; onOpenSettings?: () => void;
  onImport: () => void; onExamples: () => void;
}
const itemLabels = { pending: '待读取', ready: '已读取', unchanged: '未变更', failed: '读取失败' };

export function InboxSyncBar({ busy, onChanged, onOpenSettings, onImport, onExamples }: Props) {
  const [connection, setConnection] = useState<MiaoshouStatus | null>(null), [autoSync, setAutoSync] = useState<boolean | null>(null);
  const [status, setStatus] = useState<MiaoshouSyncStatus | null>(null), [error, setError] = useState('');
  const [working, setWorking] = useState(false), [detailsOpen, setDetailsOpen] = useState(false);
  const mounted = useRef(true), entered = useRef(false), changeCount = useRef(''), onChangedRef = useRef(onChanged);
  const more = useRef<HTMLDetailsElement>(null);
  onChangedRef.current = onChanged;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const observe = useCallback((value: MiaoshouSyncStatus) => {
    if (!mounted.current) return;
    setStatus(value);
    const count = `${value.imported ?? 0}/${value.existing ?? 0}/${value.status === 'completed'}`;
    if (value.importToInbox && changeCount.current !== count) {
      changeCount.current = count;
      void onChangedRef.current().catch(cause => { if (mounted.current) setError(errorText(cause)); });
    }
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([window.red.getMiaoshouStatus(), window.red.getMiaoshouPreferences(), window.red.getMiaoshouSyncStatus()]).then(async ([mode, preferences, sync]) => {
      if (!active) return;
      if (mode.status === 'fulfilled') setConnection(mode.value); else setError(errorText(mode.reason));
      if (preferences.status === 'fulfilled') setAutoSync(preferences.value.autoSyncOnInbox); else setError(errorText(preferences.reason));
      if (sync.status === 'fulfilled') observe(sync.value); else if (mode.status !== 'fulfilled' || mode.value.mode !== 'unconfigured') setError(errorText(sync.reason));
      if (entered.current || preferences.status !== 'fulfilled' || !preferences.value.autoSyncOnInbox || mode.status !== 'fulfilled' || mode.value.mode === 'unconfigured') return;
      entered.current = true;
      try { const value = await window.red.syncMiaoshouInbox({ trigger: 'enter' }); if (active && value) observe(value); }
      catch (cause) { if (active) setError(errorText(cause)); }
    });
    return () => { active = false; };
  }, [observe]);
  useEffect(() => {
    if (status?.status !== 'running') return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await window.red.getMiaoshouSyncStatus();
        if (!active) return;
        setError('');
        observe(value);
        if (value.status === 'running') timer = setTimeout(() => void poll(), 1200);
      } catch (cause) { if (active) { setError(errorText(cause)); timer = setTimeout(() => void poll(), 3000); } }
    }
    timer = setTimeout(() => void poll(), 700);
    return () => { active = false; clearTimeout(timer); };
  }, [status?.status, observe]);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (more.current?.open && !more.current.contains(event.target as Node)) more.current.open = false; };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  async function action(operation: () => Promise<MiaoshouSyncStatus | null>) {
    if (working || busy) return;
    setWorking(true); setError('');
    try { const value = await operation(); if (value) observe(value); }
    catch (cause) { if (mounted.current) { setError(errorText(cause)); setDetailsOpen(true); } }
    finally { if (mounted.current) setWorking(false); }
  }
  const running = status?.status === 'running', unconfigured = connection?.mode === 'unconfigured';
  const stateText = !connection ? '正在读取连接状态…' : unconfigured ? '配置连接后即可同步全部商品与 SKU' : !status || status.status === 'idle' ? '将全部商品与 SKU 导入本地采集箱'
    : status.status === 'paused' ? '同步已暂停，可在详情中继续' : status.status === 'completed' ? `同步完成 · 新增 ${status.imported ?? 0} 件 · 已有 ${status.existing ?? 0} 件${status.failed ? ` · 失败 ${status.failed} 件` : ''}`
      : status.stage === 'listing' ? `正在检查第 ${status.nextPage} 页 · 已发现 ${status.discovered} 件` : `正在导入 · 新增 ${status.imported ?? 0} 件 · 剩余 ${status.pending} 件`;
  return <>
    <section className="inbox-sync-bar" aria-label="妙手采集箱同步">
      <span className="inbox-sync-symbol" aria-hidden="true"><RefreshCw size={19} className={running ? 'spin' : undefined} /></span>
      <div className="inbox-sync-summary"><strong>妙手采集箱</strong><span role="status">{stateText}</span>{error && <button type="button" className="text-button inbox-sync-error-link" onClick={() => setDetailsOpen(true)}>同步遇到问题，查看详情</button>}</div>
      <div className="inbox-sync-controls">{onOpenSettings && <button type="button" className="text-button inbox-auto-status" onClick={onOpenSettings}><Settings2 size={14} />{autoSync === null ? '同步设置' : autoSync ? '自动检查已开启' : '自动检查已关闭'}</button>}
        <button type="button" className="button primary" disabled={busy || working || running || !connection || unconfigured} onClick={() => void action(() => window.red.syncMiaoshouInbox({ trigger: 'manual' }))}>{working || running ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}同步妙手采集箱</button>
        {unconfigured && onOpenSettings ? <button type="button" className="button secondary" onClick={onOpenSettings}>配置妙手连接</button> : <button type="button" className="button secondary" onClick={() => setDetailsOpen(true)}>同步详情</button>}
        <details className="inbox-more" ref={more} onKeyDown={event => { if (event.key === 'Escape' && more.current) { more.current.open = false; more.current.querySelector('summary')?.focus(); } }}><summary aria-label="采集箱更多操作"><MoreHorizontal size={18} /><span>更多</span></summary><div className="inbox-more-menu"><button type="button" disabled={busy} onClick={() => { if (more.current) more.current.open = false; onImport(); }}><FileInput size={16} />导入 JSON / CSV</button><button type="button" disabled={busy} onClick={() => { if (more.current) more.current.open = false; onExamples(); }}><PackageOpen size={16} />载入本地示例</button></div></details>
      </div>
    </section>
    {detailsOpen && <InboxSyncDetails status={status} error={error} working={working || busy} onClose={() => setDetailsOpen(false)} onAction={action} />}
  </>;
}

function InboxSyncDetails({ status, error, working, onClose, onAction }: { status: MiaoshouSyncStatus | null; error: string; working: boolean; onClose: () => void; onAction: (operation: () => Promise<MiaoshouSyncStatus | null>) => Promise<void> }) {
  const [pageSize, setPageSize] = useListPageSize('inbox-sync-records');
  const [page, setPage] = useState(1), [filter, setFilter] = useState<MiaoshouSyncPageInput['filter']>('all');
  const [items, setItems] = useState<MiaoshouSyncPage | null>(null), [readError, setReadError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setReadError('');
    void window.red.listMiaoshouSyncItems({ page, pageSize, filter }).then(value => {
      if (!active) return;
      setItems(value);
      if (page > 1 && value.total <= (page - 1) * value.pageSize) setPage(Math.max(1, Math.ceil(value.total / value.pageSize)));
    }, cause => { if (active) setReadError(errorText(cause)); });
    return () => { active = false; };
  }, [page, pageSize, filter, status?.updatedAt, refresh]);
  const running = status?.status === 'running';
  return <InboxDialog label="同步详情" className="inbox-sync-dialog" onClose={onClose}>
    <header className="inbox-dialog-header"><div><span className="section-kicker">妙手采集箱</span><h2>同步详情</h2></div><button type="button" className="icon-button" aria-label="关闭同步详情" onClick={onClose}><X size={20} /></button></header>
    <div className="inbox-dialog-body">
      <p className="inbox-dialog-intro">新增商品和全部 SKU 会自动加入采集箱。关闭此窗口后，同步仍会继续。</p>
      <div className="inbox-sync-progress"><strong role="status">{!status || status.status === 'idle' ? '尚未同步' : running ? status.stage === 'listing' ? '正在检查来源商品' : '正在读取并导入商品' : status.status === 'paused' ? '已暂停' : status.failed ? '同步结束，部分商品需要重试' : '同步完成'}</strong>{status?.updatedAt && <span>{formatDate(status.updatedAt, true)}</span>}{running && <progress aria-label="同步进度" max={Math.max(1, status.discovered)} value={status.stage === 'listing' ? undefined : status.ready + status.skipped + status.failed} />}</div>
      <dl className="inbox-sync-counts">{[['发现商品', status?.discovered ?? 0], ['新增入箱', status?.imported ?? 0], ['已有商品', status?.existing ?? 0], ['来源 SKU', status?.skuCount ?? 0], ['待处理', status?.pending ?? 0], ['失败', status?.failed ?? 0]].map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
      {(error || status?.lastError) && <p className="inbox-inline-error" role="alert">{error || status?.lastError}</p>}
      <div className="inbox-sync-item-heading"><label>商品记录<select aria-label="筛选同步商品" value={filter} onChange={event => { setFilter(event.target.value as MiaoshouSyncPageInput['filter']); setPage(1); setItems(null); }}><option value="all">全部</option>{Object.entries(itemLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><span>{items?.total ?? 0} 件</span></div>
      {readError && <p className="inbox-inline-error" role="alert">{readError}<button type="button" className="text-button" onClick={() => setRefresh(value => value + 1)}>重试读取</button></p>}
      <div className="inbox-sync-records">{items?.items.map(item => <article key={item.remoteId}><div><strong>{item.title || '未命名商品'}</strong><small>{item.skuCount} SKU · 编号 {item.remoteId}</small>{item.error && <p className="inbox-record-error">{item.error}</p>}</div><span className={`inbox-record-state ${item.status === 'failed' ? 'failed' : ''}`}>{item.importResult === 'added' ? '已加入采集箱' : item.importResult === 'existing' ? '本地已有' : itemLabels[item.status]}</span></article>)}</div>
      {!items && !readError && <p className="inbox-muted" role="status">正在读取同步记录…</p>}{items?.total === 0 && <p className="inbox-muted">{filter === 'all' ? '暂无同步记录。' : '当前筛选下没有商品。'}</p>}
      {!!items?.total && <nav className="inbox-pagination" aria-label="同步记录分页"><PageSizeSelect label="同步记录每页数量" value={pageSize} onChange={value => { setItems(null); setPageSize(value); }}/><div><button type="button" className="icon-button" aria-label="同步记录上一页" disabled={page <= 1} onClick={() => { setItems(null); setPage(value => value - 1); }}><ChevronLeft size={17} /></button><span>第 {page} / {Math.max(1, Math.ceil(items.total / pageSize))} 页</span><button type="button" className="icon-button" aria-label="同步记录下一页" disabled={page * pageSize >= items.total} onClick={() => { setItems(null); setPage(value => value + 1); }}><ChevronRight size={17} /></button></div></nav>}
    </div>
    <footer className="inbox-dialog-footer"><span className="inbox-muted">暂停后可从当前进度继续</span><div>{running ? <button type="button" className="button secondary" disabled={working} onClick={() => void onAction(() => window.red.pauseMiaoshouSync())}><Pause size={16} />暂停同步</button> : status?.status === 'paused' ? <button type="button" className="button primary" disabled={working} onClick={() => void onAction(() => window.red.syncMiaoshouInbox({ trigger: 'resume' }))}><Play size={16} />继续同步</button> : null}<button type="button" className="button secondary" disabled={working || running || !status?.failed} onClick={() => void onAction(() => window.red.syncMiaoshouInbox({ trigger: 'retry' }))}><RefreshCw size={15} />重试失败项（{status?.failed ?? 0}）</button></div></footer>
  </InboxDialog>;
}
