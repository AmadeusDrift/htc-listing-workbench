import type { DatabaseSync } from 'node:sqlite';
import type { BatchOperation,BatchItem,BatchReference } from '../../../shared/ai-batch-contracts.ts';
import { BatchService } from './service.ts';
import { batchFingerprint,readItem } from './records.ts';
import { taskAiContext,BatchWaitingError } from './task-context.ts';
import type { TaskAiScope } from './task-context.ts';
import { readProviderReceipt } from '../receipts.ts';
import { UserFacingError } from '../../../shared/errors.ts';

type Prepared={operation:BatchOperation;authorize:()=>boolean;reserve:()=>void};
/** A task sweep stages real adapter requests. Only flush sends the grouped Batch envelope. */
export class TaskBatchRuntime {
 readonly service:BatchService;
 private credential:()=>{apiKey:string;scope:string};private db:DatabaseSync;private directory:string;private pending=new Map<string,Prepared>();
 constructor(db:DatabaseSync,directory:string,deps:{fetch:typeof fetch;credential:()=>{apiKey:string;scope:string};validateReference?:(reference:BatchReference)=>boolean}){
  this.db=db;this.directory=directory;this.credential=deps.credential;
  this.service=new BatchService(db,directory,{...deps,reserve:item=>{
   const prepared=this.pending.get(item.operationId);
   if(!prepared||!prepared.authorize()||batchFingerprint(prepared.operation)!==batchFingerprint(this.operation(item)))throw new UserFacingError('批次发送前任务授权或请求已变化，未发送');
   prepared.reserve();
  }});
 }
 private operation(item:BatchItem):BatchOperation{const {version,id,batchId,customId,state,receiptId,resultFingerprint,reportedCostUsd,adoption,...op}=item;return op;}
 run<T>(scope:TaskAiScope,action:()=>T):T{return taskAiContext.run(scope,action);}
 find(operationId:string):BatchItem|undefined{const row=this.db.prepare("SELECT id FROM ai_batch_items WHERE json_extract(record_json,'$.operationId')=? AND json_extract(record_json,'$.attempt')=1").get(operationId);return row?readItem(this.db,String(row.id)):undefined;}
 pendingOperation(operationId:string):BatchOperation|undefined{const entry=this.pending.get(operationId);return entry?structuredClone(entry.operation):undefined;}
 async request(prepared:Prepared):Promise<{item:BatchItem;body:any}|null>{
  const scopeCredential=taskAiContext.getStore()?.credentialScope;if(scopeCredential&&scopeCredential!==this.credential().scope)throw new UserFacingError('任务连接快照已变化，未切换凭据或复制Batch请求');
  const op=prepared.operation,item=this.find(op.operationId),scope=taskAiContext.getStore();
  if(item){
   if(batchFingerprint(this.operation(item))!==batchFingerprint(op))throw new UserFacingError('原 Batch 请求快照已变化，未新建或改为即时重发');
   if(item.state==='prepared')this.pending.set(op.operationId,prepared);
   if(item.state==='received'){
    if(!prepared.authorize()||this.service.get(item.batchId).locallyStopped)throw new BatchWaitingError(op.operationId);
    const receipt=await readProviderReceipt(this.db,this.directory,item.id) as any;
    if(!receipt||receipt.status<200||receipt.status>=300)throw new UserFacingError('原Batch逐项收据不可读，未重发');
    return {item,body:receipt.body};
   }
   if(['failed','missing'].includes(item.state))throw new UserFacingError('原 Batch 项目失败或结果缺失，保留费用与身份，未自动重发');
   throw new BatchWaitingError(op.operationId);
  }
  const staged=this.pending.get(op.operationId);
  if(staged){
   if(batchFingerprint(staged.operation)!==batchFingerprint(op))throw new UserFacingError('待建Batch请求快照已变化，未改为普通请求');
   this.pending.set(op.operationId,prepared);throw new BatchWaitingError(op.operationId);
  }
  if(scope?.mode!=='deferred_batch'||op.purpose.gateway!=='openrouter'||!op.purpose.capability.batch||op.purpose.capability.endpoint==='decisions')return null;
  const unsupported=this.service.previewPlan([op]).ordinary[0];if(unsupported)throw new UserFacingError(unsupported.reason);
  this.pending.set(op.operationId,prepared);throw new BatchWaitingError(op.operationId);
 }
 async flush(taskId:string):Promise<void>{
  const pending=[...this.pending.values()].filter(p=>p.operation.taskId===taskId&&p.authorize());
  if(!pending.length)return;
  const fresh=pending.filter(p=>!this.find(p.operation.operationId));
  const ids=new Set([...this.service.prepare(fresh.map(p=>p.operation)).map(b=>b.id),...pending.flatMap(p=>{const i=this.find(p.operation.operationId);return i?[i.batchId]:[];})]);
  const failures:unknown[]=[];
  for(const id of ids){
   const batch=this.service.get(id),items=this.service.items(id);
   if(batch.state!=='prepared')continue;
   // A prior group's await may have paused the task or revoked just this row.
   if(batch.locallyStopped||items.some(item=>!this.pending.get(item.operationId)?.authorize()))continue;
   try{await this.service.submit(id);}catch(error){failures.push(error);}
   finally{
    // Keep unsent closures available for an explicitly authorized retry; an
    // in-flight/unknown identity is recovered only by receipt or GET from now on.
    if(this.service.get(id).state!=='prepared')for(const item of items)this.pending.delete(item.operationId);
   }
  }
  if(failures.length)throw failures[0];
 }
 batches(taskId:string){return this.db.prepare("SELECT id FROM ai_batches WHERE json_extract(record_json,'$.taskId')=?").all(taskId).map(row=>this.service.get(String(row.id)));}
 summary(batchId:string){
  const receipt=this.db.prepare("SELECT json_extract(record_json,'$.receivedAt') at FROM ai_provider_receipts WHERE json_extract(record_json,'$.callId')=? AND json_extract(record_json,'$.endpoint') LIKE '/api/v1/batches/%' ORDER BY rowid DESC LIMIT 1").get(batchId);
  return {batchId,lastQueriedAt:receipt?String(receipt.at):null,items:this.service.items(batchId).map(item=>{
   const row=this.db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(item.aiCallId??item.id),call=row?JSON.parse(String(row.record_json)):null;
   return {id:item.id,operationId:item.operationId,state:item.state,adopted:!!item.adoption,productId:item.owner.productId,draftId:call?.presentationContext?.draftId??null,variantId:call?.presentationContext?.variantId??call?.sourceColorContext?.variantId??call?.sourceConsistencyContext?.variantId??null};
  })};
 }
 async reconcile(taskId:string){
  const failures:unknown[]=[];
  for(const batch of this.batches(taskId)){
   if(['prepared','reconciled'].includes(batch.state)||batch.state==='failed'&&!batch.remoteBatchId)continue;
   // The underlying service recovers a missing remote ID from the original
   // local receipt. It never POSTs from reconcile, including unknown creation.
   try{await this.service.reconcile(batch.id);}catch(error){failures.push(error);}
  }
  if(failures.length)throw failures[0];
 }
 failed(operationId:string){const item=this.find(operationId);return !!item&&(['failed','missing'].includes(item.state)||this.service.get(item.batchId).state==='failed');}
 ready(operationId:string){return this.find(operationId)?.state==='received';}
 stop(taskId:string){for(const batch of this.batches(taskId))this.service.stopLocally(batch.id);for(const [id,p] of this.pending)if(p.operation.taskId===taskId)this.pending.delete(id);}
 resume(taskId:string){for(const batch of this.batches(taskId))this.service.resumeLocally(batch.id);}
}
