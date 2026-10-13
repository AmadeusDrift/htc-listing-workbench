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
  if(scope?.mode!=='deferred_batch'||this.service.previewPlan([op]).ordinary.length)return null;
  this.pending.set(op.operationId,prepared);throw new BatchWaitingError(op.operationId);
 }
 async flush(taskId:string):Promise<void>{
  const pending=[...this.pending.values()].filter(p=>p.operation.taskId===taskId);
  if(!pending.length)return;
  if(pending.some(p=>!p.authorize()))return;
  const fresh=pending.filter(p=>!this.find(p.operation.operationId));
  const ids=new Set([...this.service.prepare(fresh.map(p=>p.operation)).map(b=>b.id),...pending.flatMap(p=>{const i=this.find(p.operation.operationId);return i?[i.batchId]:[];})]);
  for(const id of ids){const batch=this.service.get(id);if(batch.state!=='prepared')continue;await this.service.submit(id);}
  for(const p of pending)this.pending.delete(p.operation.operationId);
 }
 batches(taskId:string){return this.db.prepare("SELECT id FROM ai_batches WHERE json_extract(record_json,'$.taskId')=?").all(taskId).map(row=>this.service.get(String(row.id)));}
 async reconcile(taskId:string){for(const batch of this.batches(taskId))if(batch.remoteBatchId&&batch.state!=='reconciled')await this.service.reconcile(batch.id);}
 failed(operationId:string){const item=this.find(operationId);return !!item&&(['failed','missing'].includes(item.state)||this.service.get(item.batchId).state==='failed');}
 ready(operationId:string){return this.find(operationId)?.state==='received';}
 stop(taskId:string){for(const batch of this.batches(taskId))this.service.stopLocally(batch.id);for(const [id,p] of this.pending)if(p.operation.taskId===taskId)this.pending.delete(id);}
 resume(taskId:string){for(const batch of this.batches(taskId))this.service.resumeLocally(batch.id);}
}
