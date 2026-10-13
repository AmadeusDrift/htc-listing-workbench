import { usePageState } from './navigation-context';
import type { ProblemContext } from './navigation-context';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PauseCircle, Play, RefreshCw, XCircle } from 'lucide-react';
import type { AutomaticAdaptationPreview, AutomaticListingStatus, AutomaticListingTask } from '../shared/automatic-listing-contracts';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import type { SettingsStatusTone } from './SettingsStatusBadge';
import { errorText } from './utils';
import type { ProductDetail, ProductSummary } from '../shared/contracts';
import { AutomaticProductGroups, OutcomeCount } from './AutomaticProductGroups';
import { buildAutomaticProductGroups, summarizeAutomaticItems } from './automatic-product-groups';

const statusLabels: Record<AutomaticListingStatus, string> = { CREATED:'已创建', QUEUED:'等待执行', RUNNING:'运行中', WAITING:'等待平台或服务返回', PAUSED:'已暂停', NEEDS_ATTENTION:'需要处理', COMPLETED:'任务完成', CANCELLED:'已取消' };
function tone(status: AutomaticListingStatus): SettingsStatusTone { return status === 'COMPLETED' ? 'success' : status === 'NEEDS_ATTENTION' ? 'danger' : status === 'PAUSED' ? 'warning' : status === 'CANCELLED' ? 'neutral' : 'info'; }
interface Props { products: ProductSummary[]; startedTask: AutomaticListingTask | null; busy: boolean; onManual(productId: string, draftId?: string, context?: ProblemContext): void; onShipping?: (batchId: string) => void }

export function AutomaticTaskPanel({ products, startedTask, busy, onManual, onShipping }: Props) {
  const api = window.red;
  const [tasks, setTasks] = useState<AutomaticListingTask[]>([]);
  const [selectedId, setSelectedId] = usePageState('automatic:task', '');
  const [task, setTask] = useState<AutomaticListingTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [adaptation,setAdaptation]=useState<AutomaticAdaptationPreview|null>(null);
  const [adaptationError,setAdaptationError]=useState('');
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [pending, setPending] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [sourceProducts, setSourceProducts] = useState<ProductDetail[]>([]);
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [loadingSources, setLoadingSources] = useState(false);
  const previewRevision = task && ['RUNNING', 'QUEUED'].includes(task.status) ? 'active' : task?.revision;
  const groups = useMemo(() => buildAutomaticProductGroups(task?.items ?? [], sourceProducts, products), [task, sourceProducts, products]);
  const mounted = useRef(true), version = useRef(0), actionPending = useRef(false), panel = useRef<HTMLElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (startedTask) { version.current++; setTask(startedTask); setSelectedId(startedTask.id); setTasks(values => [startedTask, ...values.filter(value => value.id !== startedTask.id)]);
      // Starting a task moves attention here; scroll to it and pulse once.
      const element = panel.current;
      if (element) { element.classList.remove('jump-highlight'); void element.offsetWidth; element.classList.add('jump-highlight'); element.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
  }, [startedTask]);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const request = version.current;
      try {
        const values = await api.listAutomaticListingTasks();
        const id = selectedId || values[0]?.id;
        const detail = id ? await api.getAutomaticListingTask(id) : null;
        if (active && request === version.current && !actionPending.current) { setTasks(values); setTask(detail); setReadError(''); }
      } catch (cause) { if (active && request === version.current) setReadError(errorText(cause)); }
      finally { if (active) { setLoading(false); timer = setTimeout(() => { void poll(); }, 2000); } }
    };
    void poll();
    // Navigation only stops reads. Task lifetime belongs to the main process.
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [api, selectedId, refresh, startedTask?.id]);

  // Full evidence validation is expensive: do it once per actual task revision,
  // never for unchanged status polls, and never duplicate it just to read sources.
  useEffect(() => {
    let active = true;
    const request = version.current;
    setSourceProducts([]);
    setAdaptation(null); setAdaptationError(''); setSourceErrors({});
    if (!task || !api.previewAutomaticListingAdaptation) {
      setLoadingSources(false);
      return () => { active = false; };
    }
    const ids = [...new Set(task.items.map(item => item.productId))];
    setLoadingSources(true);
    void api.previewAutomaticListingAdaptation(task.id).then(checked => {
      if (!active || request !== version.current || actionPending.current) return;
      setAdaptation(checked); setSourceProducts(checked.sources);
    }).catch(cause => {
      if (!active || request !== version.current) return;
      const message = errorText(cause);
      setAdaptationError(message); setSourceErrors(Object.fromEntries(ids.map(id => [id, message])));
    }).finally(() => { if (active) setLoadingSources(false); });
    return () => { active = false; };
  }, [api, task?.id, previewRevision, refresh]);

  async function applyAdaptation(){
    if(!task||!adaptation||busy||actionPending.current)return;
    actionPending.current=true;version.current++;setPending('adaptation');setError('');
    try{const updated=await api.applyAutomaticListingAdaptation({taskId:task.id,token:adaptation.token});if(mounted.current){setTask(updated);setAdaptation(null);setTasks(values=>values.map(row=>row.id===updated.id?updated:row));}}
    catch(cause){if(mounted.current)setError(errorText(cause));}
    finally{actionPending.current=false;version.current++;if(mounted.current){setPending('');setRefresh(v=>v+1);}}
  }
  async function act(action: 'pause' | 'resume' | 'cancel') {
    if (!task || busy || actionPending.current) return;
    actionPending.current = true; version.current++; setPending(action); setError('');
    try {
      const value = await (action === 'pause' ? api.pauseAutomaticListingTask(task.id) : action === 'resume' ? api.resumeAutomaticListingTask(task.id) : api.cancelAutomaticListingTask(task.id));
      if (mounted.current && value) { setTask(value); setTasks(values => values.map(row => row.id === value.id ? value : row)); }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { actionPending.current = false; version.current++; if (mounted.current) { setPending(''); setRefresh(value => value + 1); } }
  }
  const outcomes = summarizeAutomaticItems(task?.items ?? []);
  const taskRevisionSignature=JSON.stringify([...tasks].sort((left,right)=>left.id.localeCompare(right.id)).map(value=>[value.id,value.revision,value.updatedAt]));
  useEffect(()=>{window.dispatchEvent(new Event('automatic-listing-changed'));},[taskRevisionSignature]);
  const finished = task && ['COMPLETED', 'CANCELLED'].includes(task.status);
  return <section ref={panel} className="amazon-workflow automatic-task-panel" aria-label="自动上架任务">
    <div className="section-heading"><div><h2>自动上架任务</h2><p>任务持续保存执行位置。离开页面不会暂停；异常修正后可继续同一任务。</p></div><button type="button" className="button secondary" disabled={busy || Boolean(pending)} title={busy?'当前有操作进行中':pending?'正在处理任务操作':undefined} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} />刷新任务</button></div>
    {readError && <p className="workflow-notice" role="alert">任务读取未完成：{readError}</p>}
    {loading && <p className="small-copy" role="status">正在读取已保存任务…</p>}
    {!!tasks.length && <label className="field"><span>选择自动上架任务</span><select aria-label="选择自动上架任务" value={task?.id ?? selectedId} disabled={Boolean(pending)} onChange={event => { setSelectedId(event.target.value); setTask(null); setLoading(true); }}>{tasks.map(value => <option key={value.id} value={value.id}>{value.targetName} · {value.productType} · {statusLabels[value.status]} · {new Date(value.createdAt).toLocaleString('zh-CN', { hour12:false })}</option>)}</select></label>}
    {!loading && !task && !tasks.length && <p className="small-copy">还没有任务。选好商品、目标和托管服务器后，从上方启动。</p>}
    {task && <div data-testid={`automatic-task-${task.id}`}>
      <div className="workflow-actions automatic-task-heading"><Badge tone={tone(task.status)}>{statusLabels[task.status]}</Badge><strong>{task.targetName} · {task.mode === 'demo' ? '本地演示' : '真实 Haul'} · {task.productType}</strong><span className="small-copy">规则版本 {task.ruleRevision}</span></div>
      <div className="automatic-task-scope" aria-label="当前任务范围"><span>来源商品链接<strong>{groups.length}</strong></span><span>来源规格<strong>{groups.every(group => group.sourceVariantCount !== null) ? groups.reduce((sum, group) => sum + (group.sourceVariantCount ?? 0), 0) : loadingSources ? '读取中' : '未完整读取'}</strong></span><span>本次销售 SKU<strong>{task.items.length}</strong></span></div>
      <progress className="automatic-task-progress" aria-label="流程已完成 SKU" value={outcomes.completed} max={Math.max(task.items.length,1)} />
      <p className="small-copy automatic-task-counts" role="status"><OutcomeCount tone="info" label="已提交待回读" value={outcomes.submittedAwaitingReadback} /> · <OutcomeCount tone="success" label="流程完成" value={outcomes.completed} suffix={` / ${task.items.length} 个销售 SKU`} /> · <OutcomeCount tone="info" label="准备标签" value={outcomes.labels} /> · <OutcomeCount tone="info" label="处理中" value={outcomes.running} /> · <OutcomeCount tone="info" label="等待服务" value={outcomes.waiting} /> · <OutcomeCount tone="neutral" label="待执行" value={outcomes.pending} /></p>
      <p className="small-copy automatic-task-counts" aria-label="任务待确认分类"><OutcomeCount tone="warning" label="本次未选中" value={outcomes.notSelected} /> · <OutcomeCount tone="warning" label="利润淘汰" value={outcomes.profitFiltered} /> · <OutcomeCount tone="warning" label="其他规则淘汰" value={outcomes.ruleFiltered} /> · <OutcomeCount tone="warning" label="待补资料" value={outcomes.needsInput} /> · <OutcomeCount tone="danger" label="系统待修复" value={outcomes.systemRepair} /> · <OutcomeCount tone="warning" label="结果待核对" value={outcomes.unknown} /> · <OutcomeCount tone="neutral" label="历史未分类" value={outcomes.unclassified} />；原始原因保留在各 SKU 中。</p>
      {error && <p className="workflow-notice" role="alert">任务操作未完成：{error}</p>}
      <div className="workflow-actions">
        {!finished && (task.status === 'PAUSED' || task.status === 'NEEDS_ATTENTION' ? <button type="button" className="button primary" disabled={busy || Boolean(pending)} title={busy?'当前有操作进行中':pending?'正在处理任务操作':undefined} onClick={() => { void act('resume'); }}><Play size={15} />{pending === 'resume' ? '正在继续…' : '继续任务'}</button> : <button type="button" className="button secondary" disabled={busy || Boolean(pending)} title={busy?'当前有操作进行中':pending?'正在处理任务操作':undefined} onClick={() => { void act('pause'); }}><PauseCircle size={15} />{pending === 'pause' ? '正在暂停…' : '暂停任务'}</button>)}
        {!finished && <button type="button" className="button danger-quiet" disabled={busy || Boolean(pending)} title={busy?'当前有操作进行中':pending?'正在处理任务操作':undefined} onClick={() => { void act('cancel'); }}><XCircle size={15} />{pending === 'cancel' ? '正在取消…' : '取消任务'}</button>}
      </div>
      {!finished && <p className="small-copy">暂停与取消会停止后续处理；已经提交的 Amazon 商品与已保存的文件会保留。</p>}
      {adaptationError&&<p role="alert" className="workflow-notice">旧任务检查未完成：{adaptationError}</p>}
      {adaptation&&<div className="workflow-notice" aria-label="旧任务适配检查"><strong>当前规则与资料检查</strong>
        {adaptation.blockers.map(message=><p key={message}>{message}</p>)}
        {adaptation.changes.length?<ul>{adaptation.changes.map((change,index)=><li key={change.key+':'+index}>{change.sku??'新增规格'}：{change.message}{change.fields.length?'；字段：'+change.fields.join('、'):''}{change.steps.length?'；涉及：'+change.steps.join('、'):''}</li>)}</ul>:<p>未发现需要适配的差异。</p>}
        <button type="button" className="button secondary" disabled={busy||Boolean(pending)||!adaptation.canApply||!adaptation.changes.some(c=>!['PRESERVED','BLOCKED'].includes(c.kind))} onClick={()=>{void applyAdaptation();}}>{pending==='adaptation'?'正在适配…':'适配当前规则'}</button><p>适配只保存本地调整。完成后请自行点击继续任务。</p>
      </div>}
      {task.error && <p className="workflow-notice" role="alert">任务处理未完成，请查看下方逐 SKU 原因。</p>}
      <AutomaticProductGroups key={task.id} memoryKey={task.id} groups={groups} sourceErrors={sourceErrors} loadingSources={loadingSources} revision={task.updatedAt} busy={busy} pending={Boolean(pending)} onManual={(id, draftId, context) => { setSelectedId(task.id); onManual(id, draftId, { ...context, taskId: task.id }); }} onShipping={onShipping} />
    </div>}
  </section>;
}
