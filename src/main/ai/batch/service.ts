import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { BatchOperation,BatchPlan,BatchRecord,BatchItem,BatchReference } from '../../../shared/ai-batch-contracts.ts';
import { transaction } from '../../application/transaction.ts';
import { batchFingerprint as listingFingerprint } from './records.ts';
import { readBounded } from '../transport.ts';
import { postOpenRouter,openRouterHttpError,safeResponse,openRouterMetadata } from '../adapters/openrouter-http.ts';
import { AiUsageLedger } from '../usage.ts';
import { emptyUsage } from '../transport.ts';
import { saveProviderReceipt,readProviderReceipt } from '../receipts.ts';
import { throwIfAborted } from '../errors.ts';
import { validatePublicUrl } from '../../hosting/public-probe.ts';
import { readBatch,readItem,writeBatch,writeItem,validateOperation,terminal,REMOTE_STATUSES,remoteId,invalid } from './records.ts';

interface BatchDependencies {
  fetch?:typeof fetch; now?:()=>Date;
  credential:()=>{apiKey:string;scope:string};
  /** M09 must recheck pin, hash and retention; a caller-supplied URL alone is insufficient. */
  validateReference?:(reference:BatchReference)=>boolean;
  /** M11/M07 synchronous reservation on the same connection as the durable intent. */
  reserve?:(item:BatchItem,db:DatabaseSync)=>void;
}
const MAX_ITEMS=1000,MAX_BODY=8*1024*1024;
const cost=(raw:any):number|null=>typeof raw?.usage?.cost==='number'&&Number.isFinite(raw.usage.cost)&&raw.usage.cost>=0?raw.usage.cost:null;
function itemId(op:BatchOperation){const hex=listingFingerprint({taskId:op.taskId,operationId:op.operationId,attempt:op.attempt});return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
function operation(item:BatchItem):BatchOperation{const {version,id,batchId,customId,state,receiptId,resultFingerprint,reportedCostUsd,adoption,...op}=item;return op;}

/** Durable batch identity, transport and receipts. Domain adoption belongs to the caller. */
export class BatchService {
  private db:DatabaseSync;private directory:string;private deps:BatchDependencies;private fetcher:typeof fetch;
  constructor(db:DatabaseSync,directory:string,deps:BatchDependencies){this.db=db;this.directory=directory;this.deps=deps;this.fetcher=deps.fetch??globalThis.fetch;}
  private now(){return (this.deps.now?.()??new Date()).toISOString();}
  get(id:string){return readBatch(this.db,id);}
  items(id:string){return this.get(id).itemIds.map(key=>readItem(this.db,key));}
  private credentials(batch:BatchRecord){const current=this.deps.credential();if(current.scope!==batch.credentialScope||!/^[\x21-\x7e]{8,4096}$/.test(current.apiKey))invalid('Batch连接身份已变化，未切换凭据或重发');return current;}
  private eligible(op:BatchOperation):string|null{
    if(op.purpose.gateway!=='openrouter'||!op.purpose.capability.batch||op.purpose.capability.endpoint==='decisions')return '当前用途/渠道不支持OpenRouter Batch，按原配置普通调用';
    try{validateOperation(op);}catch{return 'Batch请求或用途快照无效，未替换模型';}
    const body=op.body;
    if(Object.keys(body).some(k=>!['messages','reasoning','max_tokens','response_format','temperature','seed'].includes(k))||!Array.isArray(body.messages)||!body.messages.length||!Number.isSafeInteger(body.max_tokens)||Number(body.max_tokens)<1||Number(body.max_tokens)>128000)return 'Batch请求参数不受支持，未静默丢弃参数';
    if(JSON.stringify(body.reasoning)!==JSON.stringify({effort:op.purpose.effectiveEffort}))return 'Batch思考参数与用途快照不一致';
    const urls:string[]=[];
    for(const message of body.messages){
      if(!message||typeof message!=='object'||Object.keys(message).some(k=>!['role','content'].includes(k))||!['system','user','assistant'].includes(message.role))return 'Batch消息格式不受支持';
      if(typeof message.content==='string')continue;
      if(!Array.isArray(message.content)||!message.content.length)return 'Batch消息内容为空';
      for(const part of message.content){
        if(part?.type==='text'&&typeof part.text==='string'&&Object.keys(part).every(k=>['type','text'].includes(k)))continue;
        if(part?.type!=='image_url'||typeof part.image_url?.url!=='string'||Object.keys(part).some(k=>!['type','image_url'].includes(k))||Object.keys(part.image_url).some(k=>!['url','detail'].includes(k)))return 'Batch仅支持文字及有固定版本的参考图URL';
        urls.push(part.image_url.url);
      }
    }
    for(const url of urls){
      try{if(validatePublicUrl(url).protocol!=='https:')return 'Batch参考图要求HTTPS固定版本URL';}catch{return 'Batch参考图URL不可用，不接受inline base64';}
      const ref=op.references.find(r=>r.url===url);
      if(!ref||!url.includes(ref.sha256)||Date.parse(ref.retainedUntil)<Date.parse(this.now())+48*3600_000||!this.deps.validateReference?.(ref))return 'Batch参考图必须固定版本并保留到等待及回收窗口结束';
    }
    if(op.references.some(r=>!urls.includes(r.url)))return 'Batch参考图pin与实际发送图片不匹配';
    return null;
  }
  previewPlan(operations:BatchOperation[]):BatchPlan{
    const groups=new Map<string,BatchOperation[][]>(),ordinary:BatchPlan['ordinary']=[];
    for(const op of operations){
      const reason=this.eligible(op);if(reason){ordinary.push({operationId:op.operationId,reason});continue;}
      const key=listingFingerprint({task:op.taskId,phase:op.phase,purpose:op.purpose,schema:op.schemaFingerprint,credential:op.credentialScope});
      const chunks=groups.get(key)??[[]],last=chunks.at(-1)!;
      if(last.length>=MAX_ITEMS||Buffer.byteLength(JSON.stringify([...last.map(o=>o.body),op.body]))>MAX_BODY)chunks.push([]);
      chunks.at(-1)!.push(structuredClone(op));groups.set(key,chunks);
    }
    return{groups:[...groups.values()].flat().filter(g=>g.length),ordinary};
  }
  prepare(operations:BatchOperation[]):BatchRecord[]{
    if(!operations.length)return[];const plan=this.previewPlan(operations);if(plan.ordinary.length)invalid(plan.ordinary[0].reason);
    return transaction(this.db,()=>plan.groups.map(group=>{
      const fingerprint=listingFingerprint(group),existing=this.db.prepare("SELECT id FROM ai_batches WHERE json_extract(record_json,'$.fingerprint')=?").get(fingerprint);
      if(existing)return this.get(String(existing.id));
      const id=randomUUID(),now=this.now(),first=group[0],ids=group.map(itemId);if(new Set(ids).size!==ids.length)invalid('Batch包含重复操作身份');
      for(const key of ids)if(this.db.prepare('SELECT 1 FROM ai_batch_items WHERE id=?').get(key))invalid('该操作已有Batch身份；输入变化也不能重发在途或未知请求');
      const batch:BatchRecord={version:1,id,taskId:first.taskId,phase:first.phase,fingerprint,credentialScope:first.credentialScope,purpose:first.purpose,model:first.purpose.model,schemaFingerprint:first.schemaFingerprint,itemIds:ids,state:'prepared',remoteBatchId:null,remoteStatus:null,locallyStopped:false,createdAt:now,submittedAt:null,updatedAt:now,receiptIds:[],reportedCostUsd:null,error:null};
      writeBatch(this.db,batch);group.forEach((op,index)=>writeItem(this.db,{...op,version:1,id:ids[index],batchId:id,customId:ids[index],state:'prepared',receiptId:null,resultFingerprint:null,reportedCostUsd:null,adoption:null}));return batch;
    }));
  }
  async submit(id:string,signal=AbortSignal.timeout(60_000)):Promise<BatchRecord>{
    let batch=this.get(id);if(batch.remoteBatchId)return batch;
    if(batch.state!=='prepared'){
      const saved=await readProviderReceipt(this.db,this.directory,id) as any;
      if(saved?.status>=200&&saved.status<300&&remoteId(saved.body?.id)){await this.collect(id,saved.body);return this.get(id);}
      return invalid('原批次提交结果未知；只能核对原批次，未重新POST');
    }
    if(batch.locallyStopped)invalid('Batch已本地暂停，未发送');if(this.deps.reserve&&types.isAsyncFunction(this.deps.reserve))invalid('Batch预算命令必须同步');const credential=this.credentials(batch),items=this.items(id);
    for(const item of items){const reason=this.eligible(operation(item));if(reason)invalid(reason);}
    const body={endpoint:'/v1/chat/completions',model:batch.model,provider:{allow_fallbacks:true,require_parameters:true},completion_window:'24h',requests:items.map(item=>({custom_id:item.customId,body:item.body}))};
    if(JSON.stringify(body).includes(credential.apiKey))invalid('Batch正文含凭据，未发送');
    try{
      const raw=await postOpenRouter('/api/v1/batches',body,credential,signal,{fetch:this.fetcher,now:()=>new Date(this.now()),nonce:()=>'',maxResponseBytes:160*1024*1024,
        beforeSend:()=>transaction(this.db,()=>{
          batch=this.get(id);if(batch.state!=='prepared'||batch.locallyStopped)invalid('原批次已有发送意图或已暂停');this.credentials(batch);
          for(const item of this.items(id)){
            new AiUsageLedger(this.db,()=>new Date(this.now())).reserveBatch({id:item.aiCallId??item.id,...item.owner,status:'RUNNING',errorCode:null,requestId:null,model:item.purpose.model,purposeSnapshot:item.purpose,startedAt:this.now(),finishedAt:null,usage:emptyUsage()},JSON.stringify(item.body),item.references);
            const reserved=this.deps.reserve?.(item,this.db) as unknown;if(reserved&&typeof (reserved as any).then==='function')invalid('Batch预算命令不能返回Promise');writeItem(this.db,{...item,state:'waiting'});
          }
          writeBatch(this.db,{...batch,state:'submitting',submittedAt:this.now(),updatedAt:this.now()});
        }),
        onProviderReceipt:async receipt=>{
          const saved=await saveProviderReceipt(this.db,this.directory,id,receipt,batch.purpose),current=this.get(id);
          writeBatch(this.db,{...current,receiptIds:[...new Set([...current.receiptIds,saved.id])],updatedAt:this.now()});
          if(receipt.status>=200&&receipt.status<300&&remoteId((receipt.body as any)?.id))await this.collect(id,receipt.body);
        },
      });
      await this.collect(id,raw);return this.get(id);
    }catch(error){
      const current=this.get(id);
      if(current.state==='submitting'){
        const known=!!error&&typeof error==='object'&&'definitive' in error&&error.definitive===true;
        writeBatch(this.db,{...current,state:known?'failed':'submission_unknown',updatedAt:this.now(),error:known?'创建被明确拒绝，原意图和收据保留':'创建结果未知，未重发；请核对原批次'});
        const ledger=new AiUsageLedger(this.db,()=>new Date(this.now()));for(const item of this.items(id))ledger.settle(item.aiCallId??item.id,false,emptyUsage(),this.now());
      }
      throw error;
    }
  }
  async reconcile(id:string,signal=AbortSignal.timeout(60_000)):Promise<BatchRecord>{
    const batch=this.get(id);if(!batch.remoteBatchId)return this.submitUnknownRecovery(id);
    const credential=this.credentials(batch);throwIfAborted(signal);
    const response=await this.fetcher('https://openrouter.ai/api/v1/batches/'+batch.remoteBatchId,{method:'GET',headers:{authorization:'Bearer '+credential.apiKey,accept:'application/json'},redirect:'error',signal});
    const raw=await readBounded(response,160*1024*1024,AbortSignal.timeout(30_000),undefined,async(status,text)=>{
      // Keys are ASCII and cannot legitimately appear in a result. Escaped echoes are also rejected.
      const safe=safeResponse(text,credential.apiKey);
      let body:unknown;try{body=JSON.parse(text);}catch{body=text;}
      const receipt=await saveProviderReceipt(this.db,this.directory,id,{gateway:'openrouter',endpoint:'/api/v1/batches/'+batch.remoteBatchId,model:batch.model,status,requestId:batch.remoteBatchId,receivedAt:this.now(),body:safe?body:'[omitted: credential echo]',costUsd:safe?cost(body):null},batch.purpose);
      const current=this.get(id);writeBatch(this.db,{...current,receiptIds:[...new Set([...current.receiptIds,receipt.id])],updatedAt:this.now()});
      if(!safe)invalid('Batch响应包含凭据回显，未采用');
    });
    if(!response.ok)throw openRouterHttpError(response.status,raw);
    await this.collect(id,raw);throwIfAborted(signal);return this.get(id);
  }
  private async submitUnknownRecovery(id:string){
    const receipt=await readProviderReceipt(this.db,this.directory,id) as any;
    if(receipt?.status>=200&&receipt.status<300&&remoteId(receipt.body?.id)){await this.collect(id,receipt.body);return this.get(id);}
    return invalid('Batch远端身份未知；未重建整批，也未根据时间猜测归属');
  }
  private async collect(id:string,raw:any):Promise<void>{
    const batch=this.get(id);
    if(!raw||!remoteId(raw.id)||raw.model!==batch.model||raw.endpoint!=='/v1/chat/completions'||!REMOTE_STATUSES.includes(raw.status)||batch.remoteBatchId&&batch.remoteBatchId!==raw.id)invalid('Batch远端身份与本地意图不一致');
    const bound=this.db.prepare("SELECT id FROM ai_batches WHERE json_extract(record_json,'$.remoteBatchId')=? AND id<>?").get(raw.id,id);if(bound)invalid('远端Batch已归属另一意图');
    if(terminal(batch.remoteStatus)&&raw.status!==batch.remoteStatus)invalid('远端Batch终态变化，原收据保留');
    // Bind an authenticated remote identity before item parsing can fail. This enables GET-only recovery.
    if(!batch.remoteBatchId)writeBatch(this.db,{...batch,remoteBatchId:raw.id,remoteStatus:raw.status,state:'waiting',updatedAt:this.now()});
    const matches=new Map(this.items(id).map(item=>[item.customId,item])),results=new Map<string,any>();
    if(raw.results!==null&&raw.results!==undefined&&!Array.isArray(raw.results))invalid('Batch结果结构无效');
    for(const result of raw.results??[]){
      if(!matches.has(result?.custom_id))invalid('Batch返回外来custom_id，原响应已保留');
      if(results.has(result.custom_id)&&listingFingerprint(results.get(result.custom_id))!==listingFingerprint(result))invalid('Batch重复custom_id内容冲突，未采用');
      results.set(result.custom_id,result);
    }
    const received:BatchItem[]=[],metadata=new Map<string,ReturnType<typeof openRouterMetadata>>();
    for(const [customId,result] of results){
      const item=matches.get(customId)!,fingerprint=listingFingerprint(result);
      if(item.resultFingerprint){if(item.resultFingerprint!==fingerprint)invalid('Batch已回收结果发生变化，未覆盖');continue;}
      if((result.response==null)===(result.error==null))invalid('Batch逐项响应与错误身份无效');
      const success=result.response!=null,status=success?result.response.status_code:400;
      if(!Number.isInteger(status)||status<100||status>599)invalid('Batch逐项状态无效');
      const body=success?result.response.body:result.error,receipt=await saveProviderReceipt(this.db,this.directory,item.id,{gateway:'openrouter',endpoint:'/api/v1/batches/'+raw.id,model:batch.model,status,requestId:typeof result.response?.request_id==='string'?result.response.request_id:null,receivedAt:this.now(),body,costUsd:cost(body)},item.purpose);
      received.push({...item,state:success&&status>=200&&status<300?'received':'failed',receiptId:receipt.id,resultFingerprint:fingerprint,reportedCostUsd:receipt.costUsd});
      metadata.set(item.id,openRouterMetadata(body));
    }
    transaction(this.db,()=>{
      const current=this.get(id);
      if(current.remoteBatchId!==raw.id||terminal(current.remoteStatus)&&raw.status!==current.remoteStatus)invalid('并发回收已有终态，较早状态未覆盖');
      if(terminal(current.remoteStatus)&&current.reportedCostUsd!==null&&cost(raw)!==null&&cost(raw)!==current.reportedCostUsd)invalid('终态Batch费用发生冲突，原账本保留');
      const ledger=new AiUsageLedger(this.db,()=>new Date(this.now()));
      for(const item of received){const current=readItem(this.db,item.id);if(current.resultFingerprint&&current.resultFingerprint!==item.resultFingerprint)invalid('并发回收结果冲突');writeItem(this.db,{...item,adoption:current.adoption});const meta=metadata.get(item.id)!;ledger.settle(item.aiCallId??item.id,meta.usageKnown,meta.usage,this.now());}
      if(terminal(raw.status))for(const item of this.items(id))if(item.state==='waiting'){writeItem(this.db,{...item,state:'missing'});ledger.settle(item.aiCallId??item.id,false,emptyUsage(),this.now());}
      writeBatch(this.db,{...current,remoteBatchId:raw.id,remoteStatus:raw.status,state:terminal(raw.status)?'reconciled':'waiting',reportedCostUsd:cost(raw)??current.reportedCostUsd,updatedAt:this.now(),error:raw.status==='completed'?null:terminal(raw.status)?'远端批次终止；缺失项目和费用保留待核对':null});
    });
  }
  stopLocally(id:string){const batch=this.get(id);writeBatch(this.db,{...batch,locallyStopped:true,updatedAt:this.now()});return this.get(id);}
  /** Explicit task continuation only; does not send a new POST. */
  resumeLocally(id:string){const batch=this.get(id);writeBatch(this.db,{...batch,locallyStopped:false,updatedAt:this.now()});return this.get(id);}
  adopt(id:string,command:{inputFingerprint:string;authorize:()=>boolean;apply:(item:BatchItem,db:DatabaseSync)=>string}):string{
    if(types.isAsyncFunction(command.authorize)||types.isAsyncFunction(command.apply))invalid('Batch采用与授权必须是同步受控事务');
    return transaction(this.db,()=>{
      const item=readItem(this.db,id),batch=this.get(item.batchId);
      if(item.inputFingerprint!==command.inputFingerprint)invalid('Batch来源版本已变化，原结果保留未采用');
      if(item.adoption)return item.adoption.id;
      if(batch.locallyStopped||command.authorize()!==true)invalid('任务暂停或未授权，Batch结果仅保存未采用');
      if(item.state!=='received')invalid('Batch项目尚无成功收据');
      const adoption=command.apply(item,this.db);if(typeof adoption!=='string'||!adoption||adoption.length>200)invalid('Batch采用必须使用同事务同步命令');
      writeItem(this.db,{...item,adoption:{id:adoption,at:this.now()}});return adoption;
    });
  }
}
