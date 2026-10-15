import { PageSizeSelect, useListPageSize } from './ListPagination';
import { pageWindow } from './list-pagination';
import { useEffect, useState } from 'react';
import type { AutomaticTaskSummary, AutomaticResumeItemsPage } from '../shared/automatic-task-query-contracts';
import type { AutomaticListingTask } from '../shared/automatic-listing-contracts';
import type { AutomaticResumeSelection } from '../shared/automatic-resume';
import { errorText } from './utils';

export function AutomaticResumePanel({task,disabled,onUpdated}:{task:AutomaticTaskSummary;disabled:boolean;onUpdated(task:AutomaticListingTask):void}){
 const [pageSize,setPageSize]=useListPageSize('targeted-resume'),[page,setPage]=useState(1);
 const [open,setOpen]=useState(false),[result,setResult]=useState<AutomaticResumeItemsPage|null>(null);
 const paging=pageWindow(result?.total??0,pageSize,page),candidates=result?.rows??[];
 const [keys,setKeys]=useState<string[]>([]),[slots,setSlots]=useState<Record<string,string>>({}),[mode,setMode]=useState<'targeted'|'recheck'>('targeted');
 const [preview,setPreview]=useState<{taskRevision:number;token:string;lines:string[];scope:AutomaticResumeSelection}|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(false);
 useEffect(()=>{let active=true;setResult(null);setPreview(null);if(open)void window.red.queryAutomaticResumeItems({taskId:task.id,revision:task.revision,page,pageSize:pageSize as 20|50|100}).then(value=>{if(active){if(value.kind==='page'){setResult(value);if(value.page!==page)setPage(value.page);}else setError('任务已变化，请刷新后重新选择范围。');}},cause=>{if(active)setError(errorText(cause));});return()=>{active=false;};},[open,task.id,task.revision,page,pageSize]);
 async function inspect(){setPending(true);setError('');setPreview(null);try{
  const scope:AutomaticResumeSelection={mode,selections:keys.map(key=>({key,...(mode==='targeted'&&slots[key]?.trim()?{slots:slots[key].split(/[，,\s]+/).filter(Boolean).map(Number)}:{})}))};
  const result=await window.red.previewAutomaticResume({taskId:task.id,scope});setPreview({...result,scope});
 }catch(cause){setError(errorText(cause));}finally{setPending(false);}}
 async function execute(){if(!preview)return;setPending(true);setError('');try{const result=await window.red.resumeAutomaticSelection({taskId:task.id,taskRevision:preview.taskRevision,token:preview.token,scope:preview.scope});if(result){onUpdated(result);setPreview(null);}else setError('已取消确认；本次未发送新请求');}catch(cause){setError(errorText(cause));}finally{setPending(false);}}
 return <details className="workflow-notice" aria-label="定向接续与从头检查" onToggle={event=>setOpen(event.currentTarget.open)}><summary>选择 SKU 定向处理 / 从头检查</summary>
  <p>从头检查复用正确文案、通过图片和有效地址，只执行缺失或失效步骤。已有接收记录请使用下方原 SKU 修正入口。选择、预览均不发送请求。</p>
  <label>处理方式 <select aria-label="处理方式" disabled={pending||disabled} value={mode} onChange={event=>{setMode(event.target.value as typeof mode);setPreview(null);}}><option value="targeted">接续所选 SKU 的未完成步骤</option><option value="recheck">从第一步重新检查并复用成果</option></select></label>
  {open&&!result&&!error&&<p role="status">正在读取所选任务的 SKU…</p>}
  <ul>{candidates.map(row=><li key={row.key}><label><input type="checkbox" checked={keys.includes(row.key)} disabled={pending||disabled} onChange={event=>{setKeys(value=>event.target.checked?[...value,row.key]:value.filter(key=>key!==row.key));setPreview(null);}}/>{row.sku} · {row.stage}</label>{mode==='targeted'&&keys.includes(row.key)&&row.draftId&&<label>仅处理图片图位（留空接续 SKU）<input aria-label={`${row.sku} 图位`} placeholder="例如 1,3" value={slots[row.key]??''} disabled={pending||disabled} onChange={event=>{setSlots(value=>({...value,[row.key]:event.target.value}));setPreview(null);}}/></label>}</li>)}</ul>
  <nav aria-label="定向 SKU 分页"><PageSizeSelect label="定向 SKU 每页数量" value={pageSize} onChange={setPageSize}/><button type="button" disabled={paging.page<=1} onClick={()=>setPage(paging.page-1)}>上一页</button><span>第 {paging.page} / {paging.pages} 页 · 已选 {keys.length} 个 SKU</span><button type="button" disabled={paging.page>=paging.pages} onClick={()=>setPage(paging.page+1)}>下一页</button></nav>
  <button type="button" className="button secondary" disabled={disabled||pending||!keys.length||!result} onClick={()=>void inspect()}>预览处理与复用范围</button>
  {preview&&<div><ul>{preview.lines.map((line,index)=><li key={index}>{line}</li>)}</ul><button type="button" className="button primary" disabled={disabled||pending||task.revision!==preview.taskRevision} onClick={()=>void execute()}>确认范围并继续</button>{task.revision!==preview.taskRevision&&<p>任务已变化，请重新预览。</p>}</div>}
  {error&&<p role="alert">本次未启动：{error}</p>}
 </details>;
}
