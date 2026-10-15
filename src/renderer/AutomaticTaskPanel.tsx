import { AutomaticResumePanel } from './AutomaticResumePanel';
import { AutomaticBatchStatus } from './AutomaticBatchStatus';
import type { ListingExecutionMode, TaskBatchSummary } from '../shared/ai-batch-contracts';
import { usePageState } from './navigation-context';
import type { ProblemContext } from './navigation-context';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PauseCircle, Play, RefreshCw, XCircle, Search } from 'lucide-react';
import type { AutomaticAdaptationPreview, AutomaticListingStatus, AutomaticListingTask } from '../shared/automatic-listing-contracts';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import type { SettingsStatusTone } from './SettingsStatusBadge';
import { errorText } from './utils';
import type { ProductDetail, ProductSummary } from '../shared/contracts';
import { OutcomeCount } from './AutomaticProductGroups';
import { AutomaticTaskGroups } from './AutomaticTaskGroups';
import { PageSizeSelect, useListPageSize } from './ListPagination';
import type { AutomaticTaskSummary, AutomaticTaskGroupsPage } from '../shared/automatic-task-query-contracts';
import { summarizeAutomaticItems } from './automatic-product-groups';
import { formatAutomaticTaskDate } from './automatic-task-date';

const statusLabels: Record<AutomaticListingStatus, string> = { CREATED:'已创建', QUEUED:'等待执行', RUNNING:'运行中', WAITING:'等待平台或服务返回', PAUSED:'已暂停', NEEDS_ATTENTION:'需要处理', COMPLETED:'任务完成', CANCELLED:'已取消' };
function tone(status: AutomaticListingStatus): SettingsStatusTone { return status === 'COMPLETED' ? 'success' : status === 'NEEDS_ATTENTION' ? 'danger' : status === 'PAUSED' ? 'warning' : status === 'CANCELLED' ? 'neutral' : 'info'; }
interface Props { workBatchId?:string;taskIds?:string[]; products: ProductSummary[]; startedTask: AutomaticListingTask | null; busy: boolean; onManual(productId: string, draftId?: string, context?: ProblemContext): void; onShipping?: (batchId: string) => void }

export function AutomaticTaskPanel({ workBatchId,taskIds,products, startedTask, busy, onManual, onShipping }: Props) {
  const api = window.red;
  const [batchSummary,setBatchSummary]=useState<TaskBatchSummary|null>(null),[batchError,setBatchError]=useState('');
  const [tasks, setTasks] = useState<AutomaticTaskSummary[]>([]);
  const [queueLifecycleSignature,setQueueLifecycleSignature]=useState('');
  const [selectedId, setSelectedId] = usePageState('automatic:task', '');
  const [task, setTask] = useState<AutomaticTaskSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [adaptation,setAdaptation]=useState<AutomaticAdaptationPreview|null>(null);
  const [adaptationError,setAdaptationError]=useState('');
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [pending, setPending] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [sourceCounts, setSourceCounts] = useState<{taskId:string;counts:Record<string,number>} | null>(null);
  const [sourceProducts, setSourceProducts] = useState<ProductDetail[]>([]);
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [loadingSources, setLoadingSources] = useState(false);
  const [checkRequest, setCheckRequest] = useState<{id:string;revision:number;refresh:number;serial:number}|null>(null);
  const [view,setView]=useState<AutomaticTaskGroupsPage|null>(null),[search,setSearch]=usePageState('automatic:task-search',''),[groupPage,setGroupPage]=usePageState('automatic:group-page',1);
  const [groupSize,setGroupSize]=useListPageSize('task-products'),[taskPage,setTaskPage]=useState(1),[taskTotal,setTaskTotal]=useState(0);
  const readFlight=useRef<Promise<void>|null>(null);
  const summarize=(value:AutomaticListingTask):AutomaticTaskSummary=>({id:value.id,revision:value.revision,status:value.status,targetName:value.targetName,mode:value.mode,productType:value.productType,ruleRevision:value.ruleRevision,createdAt:value.createdAt,updatedAt:value.updatedAt,error:value.error,sourceProductIds:[...new Set(value.items.map(row=>row.productId))],sourceProductCount:new Set(value.items.map(row=>row.productId)).size,salesSkuCount:value.items.length,counts:summarizeAutomaticItems(value.items)});
  function adopted(value:AutomaticListingTask){const summary=summarize(value);setTask(summary);setView(null);setTasks(values=>values.map(row=>row.id===value.id?summary:row));setRefresh(v=>v+1);}
  const mounted = useRef(true), version = useRef(0), actionPending = useRef(false), panel = useRef<HTMLElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (startedTask) { setBatchSummary(null); version.current++; setTask(summarize(startedTask)); setSelectedId(startedTask.id); setTasks(values => [summarize(startedTask), ...values.filter(value => value.id !== startedTask.id)]);
      // Starting a task moves attention here; scroll to it and pulse once.
      const element = panel.current;
      if (element) { element.classList.remove('jump-highlight'); void element.offsetWidth; element.classList.add('jump-highlight'); element.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
  }, [startedTask]);
  useEffect(() => {
    let active = true, reading=false, timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    const poll = async () => {
      if (!active || reading || !visible()) return;
      reading=true;
      if(readFlight.current){await readFlight.current.catch(()=>{});if(!active||!visible()){reading=false;return;}}
      const request = version.current;
      let pollDelay = 30_000;
      const flight=(async()=>{try {
        const allValues = await api.queryAutomaticTaskSummaries({...(workBatchId?{workBatchId}:{taskIds:taskIds?[...new Set([...taskIds,...(startedTask?[startedTask.id]:[])])]:undefined}),page:taskPage,pageSize:20});
        if(!active||request!==version.current||actionPending.current)return;
        const values=allValues.rows;
        if(allValues.active)pollDelay=10_000;
        const id = values.some(value=>value.id===selectedId)?selectedId:values[0]?.id;
        // Lifecycle transitions invalidate the queue; per-SKU progress stays in this panel.
        const summary=values.find(value=>value.id===id);
        let detail=summary?await api.queryAutomaticTaskGroups({taskId:summary.id,revision:summary.revision,search,page:groupPage,pageSize:groupSize as 20|50|100}):null;
        if(detail?.kind==='revision-conflict')detail=await api.queryAutomaticTaskGroups({taskId:detail.taskId,revision:detail.revision,search,page:groupPage,pageSize:groupSize as 20|50|100});
        if(detail?.kind==='revision-conflict')throw Error('任务持续变化，请刷新读取当前版本。');
        if(!active||request!==version.current||actionPending.current)return;
        let batch:TaskBatchSummary|null=null,batchFailure='';
        if(id)try{batch=await api.getAutomaticBatchSummary(id);}catch(cause){batchFailure=errorText(cause);}
        if (active && request === version.current && !actionPending.current) { setQueueLifecycleSignature(allValues.lifecycleSignature);setTasks(values);setTaskTotal(allValues.total);setTaskPage(allValues.page);setView(detail); setTask(detail?.task??null); setReadError(''); setBatchSummary(batch);setBatchError(batchFailure); }
      } catch (cause) { if (active && request === version.current) setReadError(errorText(cause)); }
      finally { reading=false;if (active) { setLoading(false); if (visible()) timer = setTimeout(() => { void poll(); }, pollDelay); } }})();
      readFlight.current=flight;try{await flight;}finally{if(readFlight.current===flight)readFlight.current=null;}
    };
    const onVisibility = () => { if (timer) clearTimeout(timer); timer = undefined; if (visible()) void poll(); };
    document.addEventListener('visibilitychange', onVisibility);
    void poll();
    // Navigation only stops reads. Task lifetime belongs to the main process.
    return () => { active = false; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [api, selectedId, refresh, startedTask?.id,JSON.stringify(taskIds),workBatchId,taskPage,groupPage,groupSize,search]);

  // Full evidence validation is explicit. A changed snapshot invalidates its proof
  // without starting another expensive read; apply still revalidates in the main process.
  useEffect(() => {
    let active = true;
    const request = version.current;
    setSourceProducts([]);
    setAdaptation(null); setAdaptationError(''); setSourceErrors({});
    if (!task || !api.previewAutomaticListingAdaptation || checkRequest?.id !== task.id || checkRequest.revision !== task.revision || checkRequest.refresh !== refresh) {
      setLoadingSources(false);
      return () => { active = false; };
    }
    const ids = products.map(product=>product.id);
    setLoadingSources(true);
    void api.previewAutomaticListingAdaptation(task.id).then(checked => {
      if (!active || request !== version.current || actionPending.current) return;
      setAdaptation(checked); setSourceProducts(checked.sources);
      setSourceCounts({taskId:task.id,counts:Object.fromEntries(checked.sources.map(source=>[source.id,source.variants.length]))});
    }).catch(cause => {
      if (!active || request !== version.current) return;
      const message = errorText(cause);
      setAdaptationError(message); setSourceErrors(Object.fromEntries(ids.map(id => [id, message])));
    }).finally(() => { if (active) setLoadingSources(false); });
    return () => { active = false; };
  }, [api, task?.id, task?.revision, refresh, checkRequest]);

  async function changeMode(mode:ListingExecutionMode){
    if(!task||busy||actionPending.current)return;
    actionPending.current=true;version.current++;setPending('mode');setError('');
    try{const updated=await api.setAutomaticExecutionMode({taskId:task.id,mode});if(mounted.current){adopted(updated);setBatchSummary(current=>current?{...current,mode}:null);}}
    catch(cause){if(mounted.current)setError(errorText(cause));}
    finally{actionPending.current=false;version.current++;if(mounted.current){setPending('');setRefresh(value=>value+1);}}
  }
  async function applyAdaptation(){
    if(!task||!adaptation||busy||actionPending.current)return;
    actionPending.current=true;version.current++;setPending('adaptation');setError('');
    try{const updated=await api.applyAutomaticListingAdaptation({taskId:task.id,token:adaptation.token});if(mounted.current){adopted(updated);setAdaptation(null);}}
    catch(cause){if(mounted.current)setError(errorText(cause));}
    finally{actionPending.current=false;version.current++;if(mounted.current){setPending('');setRefresh(v=>v+1);}}
  }
  async function act(action: 'pause' | 'resume' | 'cancel') {
    if (!task || busy || actionPending.current) return;
    actionPending.current = true; version.current++; setPending(action); setError('');
    try {
      const value = await (action === 'pause' ? api.pauseAutomaticListingTask(task.id) : action === 'resume' ? api.resumeAutomaticListingTask(task.id) : api.cancelAutomaticListingTask(task.id));
      if (mounted.current && value) { adopted(value); }
    } catch (cause) { if (mounted.current) setError((action==='resume'?'本次未启动，未发送新请求：':'')+errorText(cause)); }
    finally { actionPending.current = false; version.current++; if (mounted.current) { setPending(''); setRefresh(value => value + 1); } }
  }
  const outcomes = task?.counts ?? summarizeAutomaticItems([]);
  const taskOptions=useMemo(()=>tasks.map(value => <option key={value.id} value={value.id}>{value.targetName} · {value.productType} · {statusLabels[value.status]} · {formatAutomaticTaskDate(value.createdAt)}</option>),[tasks]);
  useEffect(()=>{if(queueLifecycleSignature)window.dispatchEvent(new Event('automatic-listing-changed'));},[queueLifecycleSignature]);
  const finished = task && ['COMPLETED', 'CANCELLED'].includes(task.status);
  return <section ref={panel} className="amazon-workflow automatic-task-panel" aria-label="自动上架任务">
    <div className="section-heading"><div><h2>自动上架任务</h2><p>任务持续保存执行位置。离开页面不会暂停；异常修正后可继续同一任务。</p></div><button type="button" className="button secondary" disabled={busy || Boolean(pending) || loading} title={busy?'当前有操作进行中':pending?'正在处理任务操作':loading?'正在读取已保存任务':undefined} onClick={() => { setLoading(true); setRefresh(value => value + 1); }}><RefreshCw size={15} />{loading ? '正在读取任务…' : '刷新任务'}</button></div>
    {readError && <p className="workflow-notice" role="alert">任务读取未完成：{readError}</p>}
    {loading && <p className="small-copy" role="status">正在读取已保存任务…</p>}
    {!!tasks.length && <label className="field"><span>选择自动上架任务</span><select aria-label="选择自动上架任务" value={task?.id ?? selectedId} disabled={Boolean(pending)} onChange={event => { version.current++;setSelectedId(event.target.value); setTask(null);setView(null);setGroupPage(1); setBatchSummary(null); setLoading(true); }}>{taskOptions}</select></label>}
    {taskTotal>20&&<nav aria-label="自动任务分页"><button type="button" disabled={taskPage<=1} onClick={()=>{setSelectedId('');setTaskPage(v=>v-1);setGroupPage(1);}}>上一页任务</button><span>第 {taskPage} / {Math.max(1,Math.ceil(taskTotal/20))} 页任务</span><button type="button" disabled={taskPage>=Math.ceil(taskTotal/20)} onClick={()=>{setSelectedId('');setTaskPage(v=>v+1);setGroupPage(1);}}>下一页任务</button></nav>}
    {!loading && !task && !tasks.length && <p className="small-copy">还没有任务。选好商品、目标和托管服务器后，从上方启动。</p>}
    {task && <div data-testid={`automatic-task-${task.id}`}>
      <div className="workflow-actions automatic-task-heading"><Badge tone={tone(task.status)}>{statusLabels[task.status]}</Badge><strong>{task.targetName} · {task.mode === 'demo' ? '本地演示' : '真实 Haul'} · {task.productType}</strong><span className="small-copy">规则版本 {task.ruleRevision}</span></div>
      {batchError&&<p role="alert" className="workflow-notice">Batch 状态读取失败：{batchError}；请刷新任务。</p>}
      {batchSummary&&<AutomaticBatchStatus summary={batchSummary} status={task.status} disabled={busy||!!pending} onMode={mode=>{void changeMode(mode);}}/>}
      <div className="automatic-task-scope" aria-label="当前任务范围"><span>来源商品链接<strong>{task.sourceProductCount}</strong></span><span>来源规格<strong>{sourceCounts?.taskId===task.id?(task.sourceProductIds.every(id=>sourceCounts.counts[id]!==undefined)?task.sourceProductIds.reduce((sum,id)=>sum+sourceCounts.counts[id],0)+'（已读快照）':'尚未读取'):task.sourceProductIds.every(id=>products.some(p=>p.id===id))?products.filter(p=>task.sourceProductIds.includes(p.id)).reduce((sum,p)=>sum+p.variantCount,0):'尚未读取'}</strong></span><span>本次销售 SKU<strong>{task.salesSkuCount}</strong></span></div>
      <progress className="automatic-task-progress" aria-label="流程已完成 SKU" value={outcomes.completed} max={Math.max(task.salesSkuCount,1)} />
      <p className="small-copy automatic-task-counts" role="status"><OutcomeCount tone="info" label="已提交待回读" value={outcomes.submittedAwaitingReadback} /> · <OutcomeCount tone="success" label="流程完成" value={outcomes.completed} suffix={` / ${task.salesSkuCount} 个销售 SKU`} /> · <OutcomeCount tone="info" label="准备标签" value={outcomes.labels} /> · <OutcomeCount tone="info" label="处理中" value={outcomes.running} /> · <OutcomeCount tone="info" label="等待服务" value={outcomes.waiting} /> · <OutcomeCount tone="neutral" label="待执行" value={outcomes.pending} /></p>
      <p className="small-copy automatic-task-counts" aria-label="任务待确认分类"><OutcomeCount tone="warning" label="本次未选中" value={outcomes.notSelected} /> · <OutcomeCount tone="warning" label="利润淘汰" value={outcomes.profitFiltered} /> · <OutcomeCount tone="warning" label="其他规则淘汰" value={outcomes.ruleFiltered} /> · <OutcomeCount tone="warning" label="待补资料" value={outcomes.needsInput} /> · <OutcomeCount tone="danger" label="系统待修复" value={outcomes.systemRepair} /> · <OutcomeCount tone="warning" label="结果待核对" value={outcomes.unknown} /> · <OutcomeCount tone="neutral" label="历史未分类" value={outcomes.unclassified} />；原始原因保留在各 SKU 中。</p>
      {error && <p className="workflow-notice" role="alert">任务操作未完成：{error}</p>}
      <div className="workflow-actions">
        {!finished && (task.status === 'PAUSED' || task.status === 'NEEDS_ATTENTION' ? <button type="button" className="button primary" disabled={busy || Boolean(pending)} title={busy?'当前有操作进行中':pending?'正在处理任务操作':undefined} onClick={() => { void act('resume'); }}><Play size={15} />{pending === 'resume' ? '正在继续…' : '继续任务'}</button> : <button type="button" className="button secondary" disabled={busy || Boolean(pending)} title={busy?'当前有操作进行中':pending?'正在处理任务操作':undefined} onClick={() => { void act('pause'); }}><PauseCircle size={15} />{pending === 'pause' ? '正在暂停…' : '暂停任务'}</button>)}
        {!finished && <button type="button" className="button danger-quiet" disabled={busy || Boolean(pending)} title={busy?'当前有操作进行中':pending?'正在处理任务操作':undefined} onClick={() => { void act('cancel'); }}><XCircle size={15} />{pending === 'cancel' ? '正在取消…' : '取消任务'}</button>}
      </div>
      {!finished && <p className="small-copy">暂停与取消会停止后续处理；已经提交的 Amazon 商品与已保存的文件会保留。</p>}
      {['CREATED','PAUSED','NEEDS_ATTENTION'].includes(task.status)&&<AutomaticResumePanel key={`resume:${task.id}`} task={task} disabled={busy||Boolean(pending)} onUpdated={adopted}/>}
      {adaptationError&&<p role="alert" className="workflow-notice">旧任务检查未完成：{adaptationError}</p>}
      <details className="workflow-notice" aria-label="旧任务适配检查"><summary>当前规则与资料检查（展开明细）</summary>
        <p>检查仅在点击后执行，并读取全部来源规格。任务进度或资料刷新后，请重新检查再适配。</p>
        <button type="button" className="button secondary" disabled={busy||Boolean(pending)||loadingSources} onClick={()=>setCheckRequest({id:task.id,revision:task.revision,refresh,serial:(checkRequest?.serial??0)+1})}>检查当前规则与资料</button>
        {loadingSources&&<p role="status">正在检查当前规则与资料…</p>}
        {adaptation&&<>
        {adaptation.blockers.map(message=><p key={message}>{message}</p>)}
        {adaptation.changes.length?<ul>{adaptation.changes.map((change,index)=><li key={change.key+':'+index}>{change.sku??'新增规格'}：{change.message}{change.fields.length?'；字段：'+change.fields.join('、'):''}{change.steps.length?'；涉及：'+change.steps.join('、'):''}</li>)}</ul>:<p>未发现需要适配的差异。</p>}
        <button type="button" className="button secondary" disabled={busy||Boolean(pending)||!adaptation.canApply||!adaptation.changes.some(c=>!['PRESERVED','BLOCKED'].includes(c.kind))} onClick={()=>{void applyAdaptation();}}>{pending==='adaptation'?'正在适配…':'适配当前规则'}</button><p>适配只保存本地调整。完成后请自行点击继续任务。</p></>}
      </details>
      {task.error && <p className="workflow-notice" role="alert">任务处理未完成，请查看下方逐 SKU 原因。</p>}
      <label className="automatic-group-search"><Search size={16}/><input type="search" aria-label="搜索任务商品或 SKU" placeholder="搜索商品、颜色、来源或销售 SKU" value={search} onChange={event=>{setSearch(event.target.value);setGroupPage(1);}}/></label>
      {view&&view.task.id===task.id&&view.task.revision===task.revision&&<AutomaticTaskGroups view={view} search={search} onClearSearch={()=>setSearch('')} products={products} sources={sourceProducts} sourceErrors={sourceErrors} sourceCounts={sourceCounts?.taskId===task.id?sourceCounts.counts:undefined} loadingSources={loadingSources} busy={busy} pending={Boolean(pending)} onUpdated={value=>{version.current++;adopted(value);}} onManual={(id,draftId,context)=>{setSelectedId(task.id);onManual(id,draftId,{...context,taskId:task.id});}} onShipping={onShipping}/>}
      <nav aria-label="任务来源商品分页"><PageSizeSelect label="任务商品每页数量" value={groupSize} onChange={value=>{setGroupSize(value);setGroupPage(1);}}/><button type="button" disabled={!view||view.page<=1} onClick={()=>setGroupPage((view?.page??1)-1)}>上一页</button><span>第 {view?.page??1} / {Math.max(1,Math.ceil((view?.total??0)/groupSize))} 页 · 共 {view?.total??0} 个来源商品链接</span><button type="button" disabled={!view||view.page>=Math.ceil(view.total/groupSize)} onClick={()=>setGroupPage((view?.page??1)+1)}>下一页</button></nav>
    </div>}
  </section>;
}
