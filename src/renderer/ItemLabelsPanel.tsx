import { PageSizeSelect, useListPageSize } from './ListPagination';
import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import type { ItemLabelRecord, ItemLabelStatus } from '../shared/item-label-contracts';
import type { ProcurementBatch } from '../shared/procurement-contracts';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import type { SettingsStatusTone } from './SettingsStatusBadge';
import { ItemLabelSettings } from './ItemLabelSettings';
import { errorText } from './utils';

const statusLabels: Record<ItemLabelStatus, string> = { NOT_REQUESTED:'尚未请求', WAITING_SKU:'等待平台建档', WAITING_QUANTITY:'等待备货数量', QUEUED:'等待获取', REQUESTING:'正在获取', DOWNLOADING:'正在下载', READY:'标签已就绪', STALE:'旧版本已失效', FAILED:'获取失败', CANCELLED:'已取消' };
function labelTone(status: ItemLabelStatus): SettingsStatusTone { return status === 'READY' ? 'success' : status === 'FAILED' ? 'danger' : status === 'STALE' ? 'warning' : 'neutral'; }

export function ItemLabelsPanel({ batch, busy, dirty }: { batch: ProcurementBatch; busy: boolean; dirty: boolean }) {
  const [pageSize, setPageSize] = useListPageSize('item-labels');
  const api = window.red;
  const [labels, setLabels] = useState<ItemLabelRecord[]>([]);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false);
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0), [page, setPage] = useState(0);
  const safePage = Math.min(page, Math.max(0, Math.ceil(batch.lines.length / pageSize) - 1));
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);
  const mounted = useRef(true), version = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const request = version.current;
      try { const values = await api.listItemLabels({ batchId:batch.id }); if (active && request === version.current) { setLabels(values); setReadError(''); } }
      catch (cause) { if (active && request === version.current) setReadError(errorText(cause)); }
      finally { if (active) { setLoading(false); timer = setTimeout(() => { void poll(); }, 2000); } }
    };
    void poll(); return () => { active = false; if (timer) clearTimeout(timer); };
  }, [api, batch.id, batch.revision, refresh]);
  async function action(work: () => Promise<string | void>) {
    if (busy || dirty || pending) return;
    version.current++; setPending(true); setError(''); setNotice('');
    try { const message = await work(); if (mounted.current && message) setNotice(message); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { version.current++; if (mounted.current) { setPending(false); setRefresh(value => value + 1); } }
  }
  const current = labels.filter(value => value.current), history = labels.filter(value => !value.current);
  const ready = current.filter(value => value.status === 'READY'), failed = current.filter(value => value.status === 'FAILED');
  const allReady = batch.lines.length > 0 && batch.lines.every(line => current.filter(value => value.lineId === line.id && value.status === 'READY' && value.files.length && value.quantity === line.stockQuantity).length === 1);
  const disabled = busy || dirty || pending || loading;
  return <section className="ops-panel" aria-label="本批次商品标签">
    <div className="ops-actions"><div className="ops-grow"><h2>商品标签</h2><p>已就绪 {ready.length} / {batch.lines.length} 个 SKU。数量按销售单位计算，与供应商采购件数分别保存。</p></div><button type="button" className="button secondary" disabled={busy || pending} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} />刷新标签</button><button type="button" className="button secondary" disabled={disabled} onClick={() => { void action(async () => { await api.prepareItemLabels(batch.id); return '已准备本批次标签；已有就绪文件直接复用，失败项目请单独重试'; }); }}>准备本批次标签</button><button type="button" className="button primary" disabled={disabled || !allReady} onClick={() => { void action(async () => { const value = await api.exportItemLabels(batch.id); return value.cancelled ? undefined : '本批次商品标签已导出'; }); }}><Download size={15} />导出本批次标签</button>{!!failed.length && <button type="button" className="button secondary" disabled={disabled} onClick={() => { void action(async () => { const results = await Promise.allSettled(failed.map(value => api.retryItemLabel(value.id))); const errors = results.flatMap(value => value.status === 'rejected' ? [errorText(value.reason)] : []); if (errors.length) throw new Error(`${results.length-errors.length} 个已安排重试；${errors.join('；')}`); return `已安排 ${failed.length} 个失败标签重试`; }); }}>重试失败标签（{failed.length}）</button>}</div>
    <p className="ops-hint">打开标签 PDF 后，在系统阅读器中选择打印机。工作台不会自动向实体打印机发送任务。完整批次标签就绪后可统一导出。</p>
    {dirty && <p className="workflow-warning" role="status">备货单有未保存修改，请先保存后再准备、打开、导出或重试标签。</p>}
    {loading && <p role="status">正在读取商品标签…</p>}{readError && <p className="workflow-notice" role="alert">标签状态读取失败：{readError}</p>}{error && <p className="workflow-notice" role="alert">{error}</p>}{notice && <p className="ops-notice" role="status">{notice}</p>}
    <div className="ops-table-wrap"><table><thead><tr><th>商品 / 规格 / SKU</th><th>发往 Amazon</th><th>平台商品编号</th><th>商品标签状态</th><th>标签文件与操作</th></tr></thead><tbody>{batch.lines.slice(safePage* pageSize,(safePage+1)* pageSize).map(line => {
      const value = current.find(item => item.lineId === line.id), status = value?.status ?? (history.some(item => item.lineId === line.id) ? 'STALE' : 'NOT_REQUESTED');
      const usable = value?.status === 'READY' && value.quantity === line.stockQuantity;
      return <tr key={line.id} data-testid={`item-label-${line.id}`}><td><div className="ops-product">{line.imageAssetId && <img alt="商品图" src={`red-asset://image/${line.imageAssetId}`} />}<div>{line.title}<small>{line.spec}</small><strong>{line.sku}</strong></div></div></td><td>{line.stockQuantity ?? '尚未填写'} 个销售单位<small>对应标签 {value?.quantity ?? line.stockQuantity ?? '待定'} 张</small></td><td>ASIN {line.asin || '待确认'}<small>FNSKU {line.fnsku || '尚未取得'}</small></td><td><Badge tone={labelTone(status)}>{statusLabels[status]}</Badge>{value && <small>当前版本 v{value.version}{value.paused ? ' · 已暂停，需明确准备或重试标签' : ''}</small>}<small>{value?.message || (batch.mode === 'demo' ? '演示记录不会请求真实平台标签。' : '需要备货或打印时，点击“准备本批次标签”。')}</small>{value && value.quantity !== line.stockQuantity && <small>当前份数与备货数量不一致，请刷新后等待新版本。</small>}</td><td>{value?.files.length ? <><small>{value.files.length} 个 PDF 文件 · {value.quantity} 张标签</small>{value.files.map((file,index) => <button key={file.index} type="button" className="button secondary" aria-label={`打开标签文件 ${index+1}`} title={`${line.sku} · 文件 ${index+1}，可在系统阅读器打印`} disabled={disabled || !usable} onClick={() => { void action(async () => { await api.openItemLabel({ id:value.id,fileIndex:file.index }); return '已在系统阅读器打开标签，可选择打印机打印'; }); }}><ExternalLink size={14} />打开 / 打印 {index+1}</button>)}</> : <small>尚无可打印文件</small>}{value?.status === 'FAILED' && <button type="button" className="button secondary" disabled={disabled} onClick={() => { void action(async () => { await api.retryItemLabel(value.id); return `${line.sku} 已安排重试`; }); }}>重试此 SKU 标签</button>}</td></tr>;
    })}</tbody></table></div>
    {batch.lines.length > 0 && <div className="ops-pagination"><PageSizeSelect label="商品标签每页数量" value={pageSize} onChange={setPageSize}/><button type="button" className="button secondary" disabled={!safePage} onClick={() => setPage(safePage-1)}>上一页</button><span>{safePage+1} / {Math.ceil(batch.lines.length/ pageSize)} 页</span><button type="button" className="button secondary" disabled={(safePage+1)* pageSize >= batch.lines.length} onClick={() => setPage(safePage+1)}>下一页</button></div>}
    {!!history.length && <details className="listing-details"><summary>历史标签版本（{history.length}）</summary><p>以下版本已失效，不用于当前备货贴标。</p><ul className="listing-history">{history.map(value => <li key={value.id}><strong>{value.sku} · v{value.version} · {value.quantity ?? '待定'} 张</strong><p>旧版本已失效 · {value.files.length} 个文件 · {value.message}</p></li>)}</ul></details>}
    <details className="listing-details"><summary>设置标签纸规格</summary><ItemLabelSettings busy={busy || dirty || pending} onSaved={() => setRefresh(value => value + 1)} /></details>
  </section>;
}
