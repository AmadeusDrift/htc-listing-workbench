import './automatic-batch.css';
import type { ListingExecutionMode, TaskBatchPlan, TaskBatchSummary } from '../shared/ai-batch-contracts';
import { AI_PURPOSE_LABELS } from '../shared/ai-purpose-contracts';

export function BatchCoverage({ plan }: { plan: TaskBatchPlan }) {
  return <div aria-label="实际 Batch 覆盖"><p className="small-copy">仅标为 Batch 的步骤按服务商实际批量计价；生图、Decisions、阿里检测和 DeepSeek 直连使用普通计价。各阶段可能分多轮等待，24 小时不是整条上架任务的完成保证。</p><ul className="batch-coverage-list">{plan.coverage.map(row => <li key={row.purposeId}><strong>{AI_PURPOSE_LABELS[row.purposeId as keyof typeof AI_PURPOSE_LABELS] ?? ({image_generation:'图片生成',aliyun_ocr:'阿里 OCR',aliyun_image_risk:'阿里图片风险检测'} as Record<string,string>)[row.purposeId] ?? row.purposeId} · {row.mode === 'deferred_batch' ? 'Batch' : '普通执行'}</strong><p>{row.reason}</p></li>)}</ul></div>;
}
export function AutomaticBatchStatus({ summary, status, disabled, onMode }: { summary: TaskBatchSummary; status: string; disabled: boolean; onMode(mode: ListingExecutionMode): void }) {
  const editable = ['CREATED', 'PAUSED', 'NEEDS_ATTENTION'].includes(status), available = !!summary.plan?.coverage.some(row => row.mode === 'deferred_batch');
  const states = {prepared:'待发送',submitting:'提交中',submission_unknown:'提交结果未知',waiting:'等待远端',reconciled:'已回收',failed:'失败'};
  return <details className="listing-details" open={summary.mode === 'deferred_batch' || !!summary.batches.length} aria-label="Batch 执行状态"><summary>执行模式与 Batch · {summary.mode === 'deferred_batch' ? '延迟批量' : '即时上架'}</summary>
    <label className="field"><span>后续未发送步骤的执行模式</span><select aria-label="后续未发送步骤的执行模式" disabled={disabled || !editable} value={summary.mode} onChange={event => onMode(event.target.value as ListingExecutionMode)}><option value="immediate">即时上架</option><option value="deferred_batch" disabled={!available}>延迟批量（Batch）{!available ? ' · 无可 Batch 步骤' : ''}</option></select></label>
    <p className="small-copy">{!editable ? (['COMPLETED','CANCELLED'].includes(status)?'已结束任务不能更改执行模式。':'请先暂停任务后更改模式。') : '更改只保存模式，需明确继续任务。'}在途或结果未知的请求仍按原 Batch 核对，不会再次普通发送。暂停或取消只停止本地后续处理，不代表远端已取消；晚到结果只保存，未授权不采用。</p>
    {summary.plan && <details><summary>查看创建时的混合执行覆盖</summary><BatchCoverage plan={summary.plan}/></details>}
    {!summary.batches.length && <p className="small-copy">尚未创建远端批次。可 Batch 的请求准备好后才会分组发送。</p>}
    {summary.batches.map(batch => { const detail=summary.details?.find(row=>row.batchId===batch.id),items=detail?.items??[],skus=[...new Set(items.flatMap(item=>item.skus))];return <section key={batch.id} className="workflow-notice" aria-label={`远端批次 ${batch.remoteBatchId??batch.id}`}><strong>{AI_PURPOSE_LABELS[batch.purpose.purposeId]} · {batch.model}</strong>
      <p>远端 ID：{batch.remoteBatchId ?? '尚未取得（未据此重发）'}</p><p>本地：{batch.locallyStopped?'已停止采用（locallyStopped）':'允许按任务授权接续'} · {states[batch.state]}；远端：{batch.remoteStatus??'未知'}</p>
      <p>AI 请求 {batch.itemIds.length} 个 · 已映射销售 SKU {skus.length} 个 · 失败/缺失 {items.filter(item=>['failed','missing'].includes(item.state)).length} 个 · 已回收未采用 {items.filter(item=>item.state==='received'&&!item.adopted).length} 个</p>
      <p>最近远端查询：{detail?.lastQueriedAt?new Date(detail.lastQueriedAt).toLocaleString('zh-CN',{hour12:false}):'暂无已收到响应的查询记录'}</p>{batch.error&&<p role="alert">{batch.error}</p>}
      <details><summary>查看请求与销售 SKU 对应关系</summary><ul className="batch-request-list">{items.map(item=><li key={item.id}>{item.skus.join('、')||'SKU 映射尚未记录'} · {item.state==='received'?(item.adopted?'结果已采用':'结果已保存，未采用'):item.state} · 请求 {item.id}</li>)}</ul></details>
      <p className="small-copy">批次完成仅表示 AI 结果回收，仍需本地校验、采用及后续上架步骤。</p>
    </section>;})}
  </details>;
}

