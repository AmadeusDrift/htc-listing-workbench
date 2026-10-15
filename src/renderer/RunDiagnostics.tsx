import { useEffect, useRef, useState } from 'react';
import type { AutomaticListingTask } from '../shared/automatic-listing-contracts';
import type { RunDiagnosticReport } from '../shared/run-report-contracts';
import type { RequestCertainty } from '../shared/run-evidence-contracts';
import { formatDate } from './utils';

const certainty: Record<RequestCertainty, string> = { NOT_SENT: '尚未发送', SENT_UNKNOWN: '已进入发送，结果未知', RECEIVED_INVALID: '已收无效结果', RECEIVED_VALID: '有效结果已保存', DEFINITIVE_REJECTION: '明确拒绝' };
const association = { TASK_EVENT: '任务事件', DRAFT_REFERENCE: '草稿引用', CLASSIFICATION_REFERENCE: '已保存分类引用（含原结果缓存）' };
const actions = { VERIFY_ORIGINAL_REQUEST: '只读核对原请求；不得新建请求重发', INSPECT_SAVED_RESULT: '核对并本地恢复原结果；尚未证明采用', INSPECT_REJECTION_AND_BUDGET: '核对原拒绝、次数、预算与继续授权', CONTINUE_FROM_ADOPTED_RESULT: '复用已采用结果；后续仍需原任务授权', INSPECT_LEGACY_EVIDENCE: '核对原证据；历史信息不足，不猜测发送资格' };
const failures: Record<string, string> = { RUN_REPORT_CURSOR_RELOAD: '运行状态已变化，请重新读取首页。', RUN_REPORT_TASK_MISSING: '原任务不存在，未读取其他任务代替。', RUN_REPORT_SKU_MISSING: '原任务中不存在所选 SKU。', RUN_REPORT_INVALID_QUERY: '请选择原任务和有效 SKU。', RUN_REPORT_INVALID_RECORD: '部分历史证据无效，请保留原数据并核对。', RUN_REPORT_CONNECTION_BUSY: '当前连接正在处理事务，请稍后读取。' };
export function RunDiagnostics({ busy, initialTaskId = '' }: { busy: boolean; initialTaskId?: string }) {
  const [tasks, setTasks] = useState<AutomaticListingTask[]>([]), [taskId, setTaskId] = useState(initialTaskId), [sku, setSku] = useState('');
  const [pageSize, setPageSize] = useState(20), [report, setReport] = useState<RunDiagnosticReport | null>(null), [working, setWorking] = useState(false), [notice, setNotice] = useState('');
  const request = useRef(0);
  useEffect(() => { if (initialTaskId) { request.current++; setTaskId(initialTaskId); setSku(''); setReport(null); setWorking(false); } }, [initialTaskId]);
  const selected = tasks.find(t => t.id === taskId);
  const error = (e: unknown) => e instanceof Error ? failures[e.message] ?? '诊断未完成，请保留原任务并稍后重读。' : '诊断未完成。';
  async function loadTasks() {
    setWorking(true); setNotice('');
    try { setTasks(await window.red.listAutomaticListingTasks()); } catch (e) { setNotice(error(e)); } finally { setWorking(false); }
  }
  async function read(cursor?: string) {
    const token = ++request.current; setWorking(true); setNotice('');
    try { const value = await window.red.getRunDiagnostics({ taskId, ...(sku ? { sku } : {}), pageSize, ...(cursor ? { cursor } : {}) }); if (token === request.current) setReport(value); }
    catch (e) { if (token === request.current) setNotice(error(e)); } finally { if (token === request.current) setWorking(false); }
  }
  async function exportReport() {
    setWorking(true); setNotice('');
    try { const value = await window.red.exportRunDiagnostics({ taskId, ...(sku ? { sku } : {}) }); if (!value.cancelled) setNotice('完整范围的脱敏诊断已保存。'); }
    catch (e) { setNotice(error(e)); } finally { setWorking(false); }
  }
  function changed(change: () => void) { request.current++; change(); setReport(null); setNotice(''); }
  return <section className="settings-section" aria-label="任务与 SKU 运行诊断">
    <h3>任务与 SKU 运行诊断</h3><p className="settings-help">读取当前程序连接中的原请求证据。打开、翻页和导出均不修复历史或发起服务请求。</p>
    <div className="workflow-actions">
      <button type="button" className="button secondary" disabled={busy || working} onClick={() => void loadTasks()}>读取任务列表</button>
      <label>任务 <select aria-label="诊断任务" value={taskId} disabled={working} onChange={e => changed(() => { setTaskId(e.target.value); setSku(''); })}><option value="">选择原任务</option>{initialTaskId && !tasks.some(t => t.id === initialTaskId) && <option value={initialTaskId}>{initialTaskId}</option>}{tasks.map(t => <option key={t.id} value={t.id}>{formatDate(t.createdAt)} · {t.id.slice(0,8)} · {t.status}</option>)}</select></label>
      <label>SKU <select aria-label="诊断 SKU" value={sku} disabled={working} onChange={e => changed(() => setSku(e.target.value))}><option value="">全部销售 SKU</option>{[...new Set(selected?.items.map(i => i.sku) ?? [])].map(s => <option key={s} value={s}>{s}</option>)}</select></label>
      <label>每页 <select aria-label="诊断每页数量" value={pageSize} disabled={working} onChange={e => changed(() => setPageSize(Number(e.target.value)))}>{[20,50,100].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <button type="button" className="button secondary" disabled={busy || working || !taskId} onClick={() => void read()}>读取诊断</button>
      <button type="button" className="button secondary" disabled={busy || working || !taskId} onClick={() => void exportReport()}>导出完整范围</button>
    </div>
    {working && <p role="status">正在读取本地证据…</p>}{notice && <p role="status" className="workflow-warning">{notice}</p>}
    {report && <>
      <p className="settings-help">采样 {formatDate(report.generatedAt)} · 当前连接一致快照 · 工作区 {report.provenance.workspaceId.slice(0,12)} · 源码 {report.provenance.sourceCommit?.slice(0,8) ?? '历史未保存'} · 任务修订 {report.scope.taskRevision ?? '历史未保存'}</p>
      <dl className="settings-values" aria-label="运行诊断统计"><div><dt>AI 调用与结果</dt><dd>总调用 {report.counts.totalCalls} · 已存回执 {report.counts.savedReceipts} · 有效结果 {report.counts.validResults} · 已采用 {report.counts.adoptedResults}</dd></div><div><dt>平台事实</dt><dd>正式提交接受 {report.counts.submittedSkus} · 实际可售 {report.counts.buyableSkus} · 演示接受 {report.counts.demoSubmittedSkus}</dd></div><div><dt>已存平台交互</dt><dd>预览 {report.counts.previewRequests} · 正式提交 {report.counts.submissionRequests} · 回读 {report.counts.readbackRequests}；此处仅统计已保存交互，不包含无回执请求。</dd></div></dl>
      <p className="settings-help">回执计数依据已保存元数据，本页不重新读取正文验证文件哈希。收到响应、有效结果、采用、平台接受与可售分别计数；诊断建议不会新增发送授权。</p>
      {report.categoryLookups.length>0&&<details><summary>类目平台检索 GET · {report.categoryLookups.length} 次</summary><p className="settings-help">原 GET 独立于 AI 付费调用计数。这里只读已存元数据，HTTP 响应、候选快照和最终分类采用分别显示。</p>{report.categoryLookups.map(lookup=><p key={lookup.requestId}>{lookup.skus.join('、')} · 原请求 <code>{lookup.requestId}</code> · HTTP {lookup.httpStatus??'未保存完整回执'} · 候选快照 {lookup.snapshotSaved?`已存（${lookup.candidateCount} 项）`:'未保存'} · {lookup.adopted?'已被最终分类采用':'未证明分类采用'}{lookup.certainty&&<> · {certainty[lookup.certainty]}</>}{lookup.missing.length>0&&<small> · 缺口：{lookup.missing.join('、')}</small>}</p>)}</details>}
      {(report.coverage.missing.length > 0 || report.coverage.draftReferenceCalls > 0) && <p className="workflow-warning">历史证据缺口：{report.coverage.missing.join('、') || '部分归属未保存'}。仅草稿引用关联 {report.coverage.draftReferenceCalls} 次，来源商品另有 {report.coverage.unassignedProductCalls} 次未能精确归入本任务；不按时间补配。</p>}
      <div style={{ overflowX: 'auto' }}><table className="audit-table"><thead><tr><th>SKU / 阶段</th><th>原身份与时间</th><th>当前证据</th><th>允许下一步</th></tr></thead><tbody>{report.calls.map(c => <tr key={c.callId}><td>{c.sku ?? '历史未保存'}<br/>{c.stage ?? '阶段历史未保存'}</td><td><code>{c.callId}</code><br/>{c.startedAt ? formatDate(c.startedAt) : '请求时间历史未保存'}<br/><small>operation：{c.operationId ?? '历史未保存'}<br/>receipt：{c.receiptId ?? '尚无完整回执'}</small></td><td><small>{association[c.association]}</small><br/>{c.certainty ? certainty[c.certainty] : '确定性历史未保存'}<br/>{c.adopted ? '已采用' : '未证明采用'}{c.errorCode && <><br/>{c.errorCode}</>}{c.abortSource && <><br/>取消来源：{c.abortSource}</>}<details><summary>阶段证据 {c.evidence.length} 条</summary>{c.evidence.map((e,i) => <p key={i}>{formatDate(e.at)} · {e.event}{e.httpStatus ? ` · HTTP ${e.httpStatus}` : ''}{e.receivedBytes !== undefined ? ` · ${e.receivedBytes} 字节` : ''}</p>)}</details></td><td>{actions[c.nextAction]}{c.missing.length > 0 && <small><br/>缺口：{c.missing.join('、')}</small>}</td></tr>)}</tbody></table></div>
      {report.errors.map((e,i) => <p className="workflow-warning" key={i}>{e.at ? formatDate(e.at) : '原失败时间未保存'} · {e.stage} · {e.code} · 原调用 {e.callId ?? '历史未保存'}</p>)}
      <div className="workflow-actions"><span>本页 {report.page.returned} / 全范围 {report.page.total} 条</span><button type="button" className="button secondary" disabled={working || busy} onClick={() => void read()}>重新读取首页</button><button type="button" className="button secondary" disabled={working || busy || !report.page.nextCursor} onClick={() => void read(report.page.nextCursor!)}>下一页</button></div>
    </>}
  </section>;
}
