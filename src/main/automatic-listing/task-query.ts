import { validateWorkBatch } from './work-batches.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AutomaticListingTask, AutomaticListingItem } from '../../shared/automatic-listing-contracts.ts';
import type { AutomaticPageInput, AutomaticTaskSummary, AutomaticTaskGroupsPage, AutomaticResumeItemsPage, AutomaticTaskItemResult, AutomaticRevisionConflict, AutomaticTaskItemSummary } from '../../shared/automatic-task-query-contracts.ts';
import { automaticItemOutcome, automaticItemReason, summarizeAutomaticItems } from '../../shared/automatic-status-projection.ts';
import { identifier, record, text } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { sanitizeFailureReason } from '../../shared/automatic-resume.ts';

type ItemPresenter=(row:AutomaticListingItem,task:AutomaticListingTask)=>AutomaticListingItem;
const unchanged:ItemPresenter=row=>row;
function paging(input:Record<string,unknown>,total:number):AutomaticPageInput {
 if(!Number.isSafeInteger(input.page)||Number(input.page)<1||![20,50,100].includes(Number(input.pageSize))||typeof input.pageSize!=='number')throw new UserFacingError('分页参数无效');
 return {page:Math.min(Number(input.page),Math.max(1,Math.ceil(total/Number(input.pageSize)))),pageSize:input.pageSize as 20|50|100};
}
export function taskSummary(task:AutomaticListingTask,_present:ItemPresenter=unchanged):AutomaticTaskSummary {
 return {id:task.id,revision:task.revision,status:task.status,targetName:task.targetName,mode:task.mode,productType:task.productType,ruleRevision:task.ruleRevision,createdAt:task.createdAt,updatedAt:task.updatedAt,error:task.error?sanitizeFailureReason(task.error):null,sourceProductIds:[...new Set(task.items.map(row=>row.productId))],sourceProductCount:new Set(task.items.map(row=>row.productId)).size,salesSkuCount:task.items.length,counts:summarizeAutomaticItems(task.items)};
}
export function queryTaskSummaries(tasks:Map<string,AutomaticListingTask>,raw:unknown,db:DatabaseSync,present:ItemPresenter=unchanged){
 const input=record(raw,'任务摘要',['taskIds','workBatchId','page','pageSize']);let ids:Set<string>|undefined;
 if(input.taskIds!==undefined){if(!Array.isArray(input.taskIds)||input.taskIds.length>10000)throw new UserFacingError('任务范围无效');const values=input.taskIds.map(identifier);if(new Set(values).size!==values.length)throw new UserFacingError('任务范围不能重复');ids=new Set(values);}
 if(input.workBatchId!==undefined){if(input.taskIds!==undefined)throw new UserFacingError('批次范围与任务名单不能同时指定');const id=text(input.workBatchId,'工作批次',200,true),row=db.prepare('SELECT record_json FROM automatic_work_batches WHERE id=?').get(id);if(!row)throw new UserFacingError('原工作批次不存在，请刷新');const batch=validateWorkBatch(JSON.parse(String(row.record_json)));if(batch.id!==id)throw new UserFacingError('工作批次身份不一致');ids=new Set(batch.taskIds);}
 const selected=[...tasks.values()].reverse().filter(task=>!ids||ids.has(task.id)),page=paging(input,selected.length),start=(page.page-1)*page.pageSize;
 const lifecycle=createHash('sha256');for(const task of selected)lifecycle.update(task.id+':'+(['RUNNING','QUEUED','WAITING'].includes(task.status)?'active':task.status)+';');
 return {...page,lifecycleSignature:lifecycle.digest('hex'),total:selected.length,active:selected.some(task=>['RUNNING','QUEUED','WAITING'].includes(task.status)),rows:selected.slice(start,start+page.pageSize).map(task=>taskSummary(task,present))};
}
function taskScope(task:AutomaticListingTask,input:Record<string,unknown>):AutomaticRevisionConflict|null {
 if(!Number.isSafeInteger(input.revision)||Number(input.revision)<1)throw new UserFacingError('任务版本无效');
 return input.revision===task.revision?null:{kind:'revision-conflict',taskId:task.id,revision:task.revision};
}
export function taskQueryId(raw:unknown,fields:string[]):{input:Record<string,unknown>;id:string}{const input=record(raw,'任务查询',['taskId','revision',...fields]);return {input,id:identifier(input.taskId)};}
function itemSummary(item:AutomaticListingItem):AutomaticTaskItemSummary {
 const plan=item.salesPlan;
 return {key:item.key,productId:item.productId,variantId:item.variantId,sku:item.sku,status:item.status,stage:item.stage,draftId:item.draftId,stockSets:item.stockSets,imageStarted:item.imageStarted,imageAttempts:item.imageAttempts,batchId:item.batchId,specification:plan?.recipe.specification??'',color:plan?.recipe.color??'',sourceVariantIds:[...new Set([item.variantId,...(plan?.recipe.components.map(c=>c.variantId)??[])])],parentSku:plan?.parentSku??null,familyKey:plan?.parentSku?'parent:'+plan.parentSku:plan?.sourceGroupKey?'source:'+plan.sourceGroupKey:'unresolved',familyResolved:plan?.familyResolved??false,independent:plan?.parentage==='NONE',outcome:automaticItemOutcome(item),reason:automaticItemReason(item),hasError:Boolean(item.error)};
}
export function queryTaskGroups(db:DatabaseSync,task:AutomaticListingTask,input:Record<string,unknown>,_present:ItemPresenter=unchanged,changeStamp?:(key:string)=>string|null):AutomaticTaskGroupsPage|AutomaticRevisionConflict {
 const conflict=taskScope(task,input);if(conflict)return conflict;
 const search=text(input.search,'搜索词',200).toLocaleLowerCase(),groups=new Map<string,AutomaticListingItem[]>();
 // Refresh projects durable checkpoints. Receipt reconciliation belongs to an
 // explicit single-SKU detail read or a business admission, never every row here.
 for(const row of task.items){const rows=groups.get(row.productId)??[];rows.push(row);groups.set(row.productId,rows);}
 // Only scalar source search fields are read; source repair/adoption and full product snapshots are excluded.
 const sources=search?new Map(db.prepare("SELECT p.id,p.title,p.source_url,(SELECT group_concat(v.sku||' '||v.original_spec||' '||v.normalized_spec||' '||v.source_spec,' ') FROM variants v WHERE v.product_id=p.id) specs FROM products p JOIN json_each(?) ids ON p.id=ids.value").all(JSON.stringify([...groups.keys()])).map(row=>[String(row.id),`${row.title} ${row.source_url} ${row.specs??''}`.toLocaleLowerCase()])):new Map<string,string>();
 const selected=[...groups].filter(([productId,rows])=>!search||sources.get(productId)?.includes(search)||rows.some(row=>[row.productTitle,row.sku,row.salesPlan?.parentSku??'',row.salesPlan?.recipe.specification??'',row.salesPlan?.recipe.color??'',automaticItemReason(row)].some(value=>value.toLocaleLowerCase().includes(search))));
 const page=paging(input,selected.length),start=(page.page-1)*page.pageSize;
 return {kind:'page',...page,task:taskSummary(task),total:selected.length,groups:selected.slice(start,start+page.pageSize).map(([productId,rows])=>({productId,title:rows[0].productTitle,items:rows.map(row=>({...itemSummary(row),...(changeStamp?.(row.key)?{detailStamp:changeStamp(row.key)!}:{})})),counts:summarizeAutomaticItems(rows)}))};
}
export function queryResumeItems(task:AutomaticListingTask,input:Record<string,unknown>):AutomaticResumeItemsPage|AutomaticRevisionConflict {
 const conflict=taskScope(task,input);if(conflict)return conflict;
 const rows=task.items.filter(row=>!['READBACK','LABELS','COMPLETE'].includes(row.stage)),page=paging(input,rows.length),start=(page.page-1)*page.pageSize;
 return {kind:'page',...page,total:rows.length,rows:rows.slice(start,start+page.pageSize).map(({key,sku,stage,draftId})=>({key,sku,stage,draftId}))};
}
export function getTaskItem(task:AutomaticListingTask,input:Record<string,unknown>,present:ItemPresenter=unchanged):AutomaticTaskItemResult {
 const conflict=taskScope(task,input);if(conflict)return conflict;
 const key=text(input.itemKey,'原任务行',200,true),item=task.items.find(row=>row.key===key);if(!item)throw new UserFacingError('原任务行不存在或不在当前任务范围');
 return {kind:'item',taskId:task.id,revision:task.revision,item:structuredClone(present(item,task))};
}
