import { useEffect, useState } from 'react';
import type { FollowupRecord } from '../shared/followup-contracts';
import type { TaskRunner } from './amazon-ui';
import { listingStateLabels } from './amazon-ui';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import { errorText, formatDate } from './utils';
import './operations.css';

interface Props { busy: boolean; run: TaskRunner; onOpen(productId: string, draftId: string): void }
const labels = { WAITING: '等待首次检查', PROCESSING: '等待 Amazon 处理', READY: 'Amazon 已建档', NEEDS_ATTENTION: '需要处理' } as const;
export function ListingFollowups({ busy, run, onOpen }: Props) {
  const api = window.red;
  const [rows, setRows] = useState<FollowupRecord[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [page, setPage] = useState(0);
  useEffect(() => {
    let active = true, reading = false;
    async function load() {
      if (reading) return;
      reading = true;
      try { const value = await api.listListingFollowups(); if (active) { setRows(value); setError(''); } }
      catch (cause) { if (active) setError(errorText(cause)); }
      finally { reading = false; if (active) setLoading(false); }
    }
    void load(); const timer = window.setInterval(() => { void load(); }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api]);
  const safePage = Math.min(page, Math.max(0,Math.ceil(rows.length/100)-1));
  return <section className="ops-panel listing-followups"><div className="ops-actions"><div className="ops-grow"><h2>自动检查上架结果</h2><p>正式提交被接受后，首次检查安排在 30 分钟后。工作台运行时会继续检查；下次打开工作台也会继续未完成的任务。原提交满 24 小时仍无明确结果才判超时，重启和重查不重新计时；明确错误立即进入处理。</p></div><Badge tone="info">{rows.filter(row => row.status === 'WAITING' || row.status === 'PROCESSING').length} 个等待确认</Badge><Badge tone={rows.some(row => row.status === 'NEEDS_ATTENTION') ? 'danger' : 'neutral'}>{rows.filter(row => row.status === 'NEEDS_ATTENTION').length} 个需要处理</Badge></div>
    <p className="ops-hint">Amazon 生成商品记录后，可以去“采购备货”整理备货单；是否已经可以销售，以平台状态为准。</p>
    {error && <p className="error-banner" role="alert">自动检查记录读取失败：{error}</p>}
    {loading ? <p className="ops-empty">正在读取检查安排…</p> : !rows.length ? <p className="ops-empty">还没有正式提交后的检查安排。</p> : <><div className="ops-table-wrap"><table><thead><tr><th>SKU / 店铺</th><th>检查进度</th><th>平台状态</th><th>下次检查 / 最近检查</th><th>说明</th><th>操作</th></tr></thead><tbody>{rows.slice(safePage*100,(safePage+1)*100).map(row => <tr key={row.id}><td><strong>{row.sku}</strong><small>{row.targetName}</small>{row.asin && <small>ASIN {row.asin}</small>}</td><td><Badge tone={row.status === 'READY' ? 'success' : row.status === 'NEEDS_ATTENTION' ? 'danger' : 'info'}>{labels[row.status]}</Badge></td><td>{listingStateLabels[row.listingState]}<small>已检查 {row.attempts} 次</small></td><td>{row.nextDueAt ? formatDate(row.nextDueAt,true) : '暂无下一次安排'}<small>{row.checkedAt ? '最近：' + formatDate(row.checkedAt,true) : '尚未取得查询结果'}</small></td><td>{row.error ?? (row.status === 'READY' ? '商品记录已确认；发／补货时还需确认入库资格' : '按计划自动检查')}</td><td><button type="button" className="button secondary" disabled={busy} onClick={() => onOpen(row.productId,row.draftId)}>查看商品</button>{row.status === 'NEEDS_ATTENTION' && <button type="button" className="button secondary" disabled={busy} onClick={() => { void run('正在重新安排检查…', async () => { await api.rescheduleListingFollowup(row.id); setRows(await api.listListingFollowups()); setError(''); }); }}>继续查询原提交</button>}</td></tr>)}</tbody></table></div>
      {rows.length > 100 && <div className="ops-pagination"><button type="button" className="button secondary" disabled={busy || !safePage} onClick={() => setPage(safePage-1)}>上一页</button><span>{safePage+1} / {Math.ceil(rows.length/100)} 页</span><button type="button" className="button secondary" disabled={busy || (safePage+1)*100 >= rows.length} onClick={() => setPage(safePage+1)}>下一页</button></div>}</>}
  </section>;
}
