import { useEffect, useState } from 'react';
import { Box, ChevronDown, ArrowRight } from 'lucide-react';
import type { AutomaticListingItem, AutomaticListingTask } from '../shared/automatic-listing-contracts';
import type { AutomaticTaskGroupsPage, AutomaticTaskItemSummary } from '../shared/automatic-task-query-contracts';
import type { ProductSummary, ProductDetail } from '../shared/contracts';
import type { ProblemContext } from './navigation-context';
import { usePageState } from './navigation-context';
import { SalesItem, OutcomeCount, stageLabels, itemLabels, automaticItemTone, automaticGroupPresentation } from './AutomaticProductGroups';
import { SettingsStatusBadge as Badge } from './SettingsStatusBadge';
import { errorText, sourceLabel } from './utils';
import './automatic-product-groups.css';

interface Actions { busy:boolean; pending:boolean; onManual(productId:string,draftId?:string,context?:ProblemContext):void; onShipping?:(batchId:string)=>void; onUpdated(task:AutomaticListingTask):void }
function LazySale({row,view,...actions}:Actions&{row:AutomaticTaskItemSummary;view:AutomaticTaskGroupsPage}){
 const [expanded,setExpanded]=usePageState(`task:${view.task.id}:sale:${row.key}`,row.status==='RUNNING');
 const tone=automaticItemTone(row.outcome);
 const [loaded,setLoaded]=useState<{taskId:string;itemKey:string;revision:number;updatedAt:string;item:AutomaticListingItem}|null>(null),[error,setError]=useState('');
 const detail=loaded?.taskId===view.task.id&&loaded.itemKey===row.key&&loaded.item.productId===row.productId&&loaded.item.variantId===row.variantId&&loaded.item.key===row.key&&loaded.item.draftId===row.draftId&&loaded.item.sku===row.sku?loaded:null;
 useEffect(()=>{let active=true;setError('');if(expanded)void window.red.getAutomaticTaskItem({taskId:view.task.id,revision:view.task.revision,itemKey:row.key}).then(value=>{if(active){if(value.kind==='item')setLoaded({taskId:view.task.id,itemKey:row.key,revision:value.revision,updatedAt:view.task.updatedAt,item:value.item});else {setLoaded(null);setError('任务已变化，请刷新任务后查看此 SKU。');}}},cause=>{if(active){setLoaded(null);setError(errorText(cause));}});return()=>{active=false;};},[expanded,view.task.id,view.task.revision,row.key]);
 if(expanded&&detail)return <SalesItem item={detail.item} memoryKey={`${view.task.id}:loaded`} expanded={expanded} initialExpanded onExpandedChange={setExpanded} revision={detail.updatedAt} {...actions} busy={actions.busy||detail.revision!==view.task.revision} unitOwner={{taskId:view.task.id,taskRevision:view.task.revision,onUpdated:actions.onUpdated}}/>;
 return <li data-testid={`automatic-result-${row.variantId}`} data-state={row.status} data-tone={tone}>
  <button type="button" className="automatic-sale-toggle" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}><span><strong>{row.sku}</strong>{row.specification&&<small>{row.specification}</small>}<small>{stageLabels[row.stage]}{row.stage==='READBACK'?'；Amazon 接受提交不等于已可售。':''}</small></span><Badge tone={tone}>{itemLabels[row.outcome]}</Badge><ChevronDown size={16} className={expanded?'is-expanded':''}/></button>
  {(['FAILED','SCREENED','WAITING'].includes(row.status)||['READBACK','LABELS'].includes(row.stage)&&row.status!=='DONE'||row.hasError)&&<p className="workflow-notice" data-tone={tone}>{itemLabels[row.outcome]}：{row.reason}</p>}
  {expanded&&<p className="small-copy" role={error?'alert':'status'}>{error||'正在读取此 SKU 的原始详情…'}</p>}
  <div className="workflow-actions">{(row.status==='FAILED'||row.hasError)&&<button type="button" className="text-button" disabled={actions.busy||actions.pending} title={actions.busy?'当前有操作进行中':actions.pending?'正在处理任务操作':undefined} onClick={()=>actions.onManual(row.productId,row.draftId??undefined,{variantId:row.variantId})}>{['READBACK','LABELS','COMPLETE'].includes(row.stage)?'原 SKU 修正（保留图片，不新建上传）':'查看并处理异常'}<ArrowRight size={14}/></button>}{row.batchId&&actions.onShipping&&<button type="button" className="text-button" disabled={actions.busy} onClick={()=>actions.onShipping!(row.batchId!)}>查看备货与标签<ArrowRight size={14}/></button>}</div>
 </li>;
}
export function AutomaticTaskGroups({view,products,sources,sourceErrors,loadingSources,search,onClearSearch,sourceCounts,...actions}:Actions&{view:AutomaticTaskGroupsPage;products:ProductSummary[];sources:ProductDetail[];sourceErrors:Record<string,string>;loadingSources:boolean;search:string;onClearSearch():void;sourceCounts?:Record<string,number>}){
 const [expandedIds,setExpandedIds]=usePageState<string[]>(`task:${view.task.id}:expanded`,[]);
 const [collapsedSearch,setCollapsedSearch]=usePageState<string[]>(`task:${view.task.id}:collapsed`,[]);
 useEffect(()=>{setCollapsedSearch([]);},[search]);
 return <div className="automatic-source-groups">
  <div className="automatic-group-toolbar"><button type="button" className="text-button" onClick={()=>setExpandedIds(view.groups.map(g=>g.productId))}>展开当前页商品</button><button type="button" className="text-button" onClick={()=>{setExpandedIds([]);onClearSearch();}}>收起全部商品</button></div>
  <p className="small-copy">按来源商品链接汇总；展开查看同款销售组、实际父 SKU 和子 SKU。</p>
  {!view.groups.length&&<p role="status" className="small-copy">没有匹配的商品或 SKU。</p>}
  {view.groups.map(group=>{
   const source=sources.find(p=>p.id===group.productId),summary=products.find(p=>p.id===group.productId),counts=group.counts,expanded=expandedIds.includes(group.productId)||Boolean(search.trim())&&!collapsedSearch.includes(group.productId),families=new Map<string,AutomaticTaskItemSummary[]>();
   for(const row of group.items)families.set(row.familyKey,[...(families.get(row.familyKey)??[]),row]);
   const sourceAssets=source?.assets.filter(asset=>!asset.fileName.startsWith('自动生成-'))??[],count=source?.variants.length??summary?.variantCount??sourceCounts?.[group.productId],cover=sourceAssets.find(asset=>asset.role==='main')?.previewUrl??sourceAssets[0]?.previewUrl??summary?.coverUrl,sourceUrl=source?.sourceUrl??summary?.sourceUrl;
   const status={PENDING:0,RUNNING:0,WAITING:0,DONE:0,FAILED:0,SCREENED:0};for(const row of group.items)status[row.status]++;const presentation=automaticGroupPresentation(status,counts,group.items.length);
   const excluded=source?source.variants.filter(variant=>!group.items.some(row=>row.sourceVariantIds.includes(variant.id))).length:null;
   return <article className="automatic-source-group" key={group.productId} data-testid={`automatic-product-group-${group.productId}`} data-tone={presentation.tone}>
    <button type="button" className="automatic-source-toggle" aria-label={`${expanded?'收起':'展开'}来源商品 ${source?.title||summary?.title||group.title}`} aria-expanded={expanded} aria-controls={`automatic-group-body-${group.productId}`} onClick={()=>{setExpandedIds(ids=>expanded?ids.filter(id=>id!==group.productId):[...ids,group.productId]);if(search.trim())setCollapsedSearch(ids=>expanded?[...ids,group.productId]:ids.filter(id=>id!==group.productId));}}>
     <span className="workspace-thumb">{cover?<img src={cover} alt="来源商品图片" loading="lazy"/>:<Box size={24} strokeWidth={1.35}/>}</span>
     <span className="automatic-source-identity"><strong>{source?.title||summary?.title||group.title}</strong><small>{sourceUrl?sourceLabel(sourceUrl):'来源链接未保存'} · 来源规格 {count??(loadingSources?'读取中':sourceErrors[group.productId]?'读取失败':'尚未读取')}{!source&&!summary&&sourceCounts?.[group.productId]!==undefined?'（已读快照）':''} · 本次销售 SKU {group.items.length}</small><small><OutcomeCount tone="success" label="流程完成" value={counts.completed}/> · <OutcomeCount tone="info" label="已提交待回读" value={counts.submittedAwaitingReadback}/> · <OutcomeCount tone="info" label="处理中" value={counts.running+counts.labels}/> · <OutcomeCount tone="info" label="等待服务" value={counts.waiting}/> · 待执行 {counts.pending}{excluded!==null?` · 未纳入本次 ${excluded}`:''}</small>{Boolean(status.FAILED+status.SCREENED)&&<small><OutcomeCount tone="warning" label="本次未选中" value={counts.notSelected}/> · <OutcomeCount tone="warning" label="利润淘汰" value={counts.profitFiltered}/> · <OutcomeCount tone="warning" label="包装抛重限制" value={counts.packagingFiltered}/> · <OutcomeCount tone="warning" label="其他规则淘汰" value={counts.ruleFiltered}/> · <OutcomeCount tone="warning" label="待补资料" value={counts.needsInput}/> · <OutcomeCount tone="danger" label="系统待修复" value={counts.systemRepair}/> · <OutcomeCount tone="warning" label="已收无效输出" value={counts.invalidOutput}/> · <OutcomeCount tone="warning" label="结果待核对" value={counts.unknown}/> · <OutcomeCount tone="warning" label="历史未分类" value={counts.unclassified}/></small>}</span><Badge tone={presentation.tone}>{presentation.label}</Badge><ChevronDown size={17} className={expanded?'is-expanded':''}/>
    </button>
    {expanded&&<div className="automatic-source-body" id={`automatic-group-body-${group.productId}`}>
     {sourceErrors[group.productId]&&<p role="alert">来源规格读取失败：{sourceErrors[group.productId]}。任务进度仍可查看；请点击“检查当前规则与资料”重试。</p>}
     {[...families].map(([key,rows])=><section className="automatic-sales-family" key={key} aria-label={rows[0].parentSku?`父 SKU ${rows[0].parentSku}`:'销售组'}><div className="automatic-family-heading"><strong>{rows[0].parentSku?`父 SKU：${rows[0].parentSku}`:rows[0].specification||'待确定销售关系'}</strong><span className="small-copy">{rows.length} 个销售 SKU · {rows[0].parentSku?'已有父 SKU 关系':rows.every(row=>row.familyResolved&&row.independent)?'独立销售，无 Amazon 父体':'尚未确认 Amazon 父体'}</span></div><ul className="automatic-task-items">{rows.map(row=><LazySale key={row.key} row={row} view={view} {...actions}/>)}</ul></section>)}
     {source?<SourceSpecs source={source} rows={group.items} search={search} taskId={view.task.id}/>:<p className="small-copy">{loadingSources?'来源规格详情读取中…':'来源规格详情尚未读取；点击“检查当前规则与资料”后查看全部规格。'}</p>}
    </div>}
   </article>;
  })}
 </div>;
}

function SourceSpecs({source,rows,search,taskId}:{source:ProductDetail;rows:AutomaticTaskItemSummary[];search:string;taskId:string}){
 const [open,setOpen]=usePageState(`task:${taskId}:source:${source.id}`,Boolean(search.trim()));
 useEffect(()=>{if(search.trim())setOpen(true);},[search]);
 const excluded=source.variants.filter(v=>!rows.some(row=>row.sourceVariantIds.includes(v.id))).length;
 return <details className="automatic-source-variants" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>查看全部 {source.variants.length} 个来源规格 · {excluded} 个未纳入本次任务</summary><p className="small-copy">来源规格完整保留，未纳入不等于失败；来源规格数与销售 SKU 数不能相减计算失败数。销售 SKU 可由组套规则组合；下表展示每个来源规格对应的本次销售 SKU。</p><ul data-scroll-key={`source-variants:${source.id}`}>{source.variants.map(variant=>{const matching=rows.filter(row=>row.sourceVariantIds.includes(variant.id));return <li key={variant.id} data-selected={Boolean(matching.length)} data-search-match={search?[variant.sku,variant.originalSpec,variant.normalizedSpec,variant.sourceSpec].some(value=>value?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())):undefined} data-testid={`automatic-source-variant-${variant.id}`}><span><strong>{variant.normalizedSpec||variant.originalSpec||variant.sourceSpec||'未填写规格'}</strong><small>来源 SKU：{variant.sku}</small></span><span>{matching.length?<><Badge tone="info">已纳入本次任务</Badge><small>销售 SKU：{matching.map(row=>row.sku).join('、')}</small></>:<Badge tone="neutral">未纳入本次任务</Badge>}</span></li>;})}</ul></details>;
}
