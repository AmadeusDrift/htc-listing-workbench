import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {AiCall,AiResult} from '../../shared/ai-contracts.ts';
import {AiError} from './errors.ts';
import {taskAiContext} from './batch/task-context.ts';
import {appendAuditEvent} from '../storage/audit.ts';
import {readProviderReceipt} from './receipts.ts';

const ACTION='ai.category.detail-repair';
const TOMBSTONE='ai.category.restored-request';
const rejection='state[1] is not a valid "image_url" part: image_url.detail: Invalid option: expected one of "auto"|"low"|"high"';
const fail=(message:string):never=>{const e=new AiError('PROVIDER_ERROR');e.message=message;throw e;};
const claimId=(scope:string)=>{const h=createHash('sha256').update(ACTION+scope).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
export function categoryCalls(calls:AiCall[],productId:string,revision:number):AiCall[]{
 return calls.filter(c=>c.productId===productId&&c.productRevision===revision&&(c.categoryContext||['category_analysis','category_decision'].includes(c.purposeSnapshot?.purposeId??'')||!c.purposeSnapshot&&!c.presentationContext&&!c.sourceConsistencyContext&&!c.sourceColorContext&&/^(openrouter|deepseek)/.test(c.providerId)));
}
export function assertCategoryRepairAvailable(db:DatabaseSync,prior:AiCall,scopeKey:string):void{
 const scope=taskAiContext.getStore();
 if(!scope?.explicitContinueAt||!Number.isFinite(Date.parse(scope.explicitContinueAt))||!scope.authorize()||Date.parse(scope.explicitContinueAt)<=Date.parse(prior.finishedAt??prior.startedAt))fail('类目接口参数历史失败：请在更新程序后手动继续原任务；本次未发送');
 if(db.prepare("SELECT 1 FROM audit_events WHERE action=? AND (id=? OR json_extract(detail_json,'$.priorCallId')=? OR json_extract(detail_json,'$.retryCallId')=?)").get(ACTION,claimId(scopeKey),prior.id,prior.id))fail('类目接口参数修复已尝试一次；请核对新回执，本次未重复发送');
}
export async function recoverCategoryPhase(options:{db:DatabaseSync;directory:string;calls:AiCall[];results:AiResult[];productId:string;productRevision:number;model:string;effort:string;context:NonNullable<AiCall['categoryContext']>;payloadHash:string;originalBatchCallId?:string}){
 const {db,directory,results,context}=options, calls=categoryCalls(options.calls,options.productId,options.productRevision);
 if(db.prepare("SELECT 1 FROM audit_events WHERE action=? AND json_extract(detail_json,'$.productId')=? AND json_extract(detail_json,'$.productRevision')=?").get(TOMBSTONE,options.productId,options.productRevision))fail('恢复备份前存在类目请求记录，当前备份缺少完整请求结果；本次未重发，请核对历史记录');
 let prior:AiCall|undefined;
 for(const call of calls){
  if(call.id===options.originalBatchCallId)continue;
  const owned=results.find(r=>r.callId===call.id&&r.productId===call.productId&&r.productRevision===call.productRevision&&r.model===call.model&&r.providerId===call.providerId&&r.output.kind==='category-decision');
  if(call.status==='SUCCEEDED'&&owned)continue;
  const consumed=db.prepare("SELECT detail_json FROM audit_events WHERE action=? AND json_extract(detail_json,'$.priorCallId')=?").get(ACTION,call.id);
  if(consumed){const retryId=JSON.parse(String(consumed.detail_json)).retryCallId;const retry=calls.find(c=>c.id===retryId&&c.status==='SUCCEEDED');if(retry&&results.some(r=>r.callId===retry.id&&r.productId===retry.productId&&r.productRevision===retry.productRevision&&r.model===retry.model&&r.providerId===retry.providerId&&r.output.kind==='category-decision'))continue;}
  const phase=call.categoryContext?.phase??(call.purposeSnapshot?.purposeId==='category_decision'?'select':undefined);
  // Unresolved calls block even after a model/configuration change. Never infer a timeout was rejected.
  let receipt:any=null;try{receipt=await readProviderReceipt(db,directory,call.id);}catch{}
  const exact=!call.categoryContext&&call.status==='FAILED'&&call.errorCode==='PROVIDER_ERROR'&&phase==='select'&&receipt?.callId===call.id&&receipt.model===call.model&&receipt.gateway==='openrouter'&&receipt.endpoint==='/api/alpha/decisions'&&receipt.status===400&&receipt.body?.error?.code===400&&receipt.body.error.message===rejection;
  if(!exact)fail('类目历史请求结果尚未确认或失败原因不属于本次参数修复；原记录保留，本次未重发，请核对原响应');
  if(context.phase==='select'){
   if(prior)fail('存在多条未解决类目请求，需逐条核对；本次未发送');
   prior=call;assertCategoryRepairAvailable(db,call,`${call.productId}:${call.productRevision}:select`);
  }
 }
 const saved=results.find(r=>{
  if(r.output.kind!=='category-decision'||r.output.phase!==context.phase||r.productId!==options.productId||r.productRevision!==options.productRevision||r.model!==options.model||r.sourceSha256!==options.payloadHash)return false;
  const call=calls.find(c=>c.id===r.callId&&c.status==='SUCCEEDED'&&c.providerId===r.providerId&&c.model===r.model);
  return !!call&&call.purposeSnapshot?.effectiveEffort===options.effort&&(!call.categoryContext||call.categoryContext.requestSha256===context.requestSha256);
 });
 return {saved,prior,calls};
}
/** Called within usage reservation transaction: claim and new call succeed or roll back together. */
export function claimCategoryRepair(db:DatabaseSync,prior:AiCall,retry:AiCall):void{
 const scopeKey=`${prior.productId}:${prior.productRevision}:select`;assertCategoryRepairAvailable(db,prior,scopeKey);
 if(!db.prepare('SELECT 1 FROM ai_calls WHERE id=?').get(retry.id)||!db.prepare('SELECT 1 FROM ai_usage_ledger WHERE id=?').get(retry.id))fail('类目请求记账未完成');
 appendAuditEvent(db,claimId(scopeKey),prior.productId,ACTION,'Decisions 图片参数修复后手动接续一次',JSON.stringify({version:1,scopeKey,priorCallId:prior.id,retryCallId:retry.id}),retry.startedAt);
}
export function retainCategoryRepairs(current:DatabaseSync,snapshot:DatabaseSync):void{
 // Preserve a safety-only tombstone when restoring a snapshot predating a category call.
 // Do not inject missing product data/results or reinterpret a missing call as unsent.
 for(const row of current.prepare('SELECT id,record_json FROM ai_calls').all()){
  const call=JSON.parse(String(row.record_json)) as AiCall;if(!categoryCalls([call],call.productId,call.productRevision).length||snapshot.prepare('SELECT 1 FROM ai_calls WHERE id=?').get(call.id))continue;
  const id=claimId('restored:'+call.id),detail=JSON.stringify({callId:call.id,productId:call.productId,productRevision:call.productRevision});
  if(!snapshot.prepare('SELECT 1 FROM audit_events WHERE id=?').get(id))appendAuditEvent(snapshot,id,null,TOMBSTONE,'备份前类目请求身份保留，禁止重复发送',detail,call.startedAt);
 }
 for(const row of current.prepare('SELECT * FROM audit_events WHERE action=?').all(TOMBSTONE)){
  const d=JSON.parse(String(row.detail_json));if(Object.keys(d).sort().join()!=='callId,productId,productRevision'||![d.callId,d.productId].every(v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v))||!Number.isSafeInteger(d.productRevision)||d.productRevision<1||claimId('restored:'+d.callId)!==row.id)fail('类目历史请求身份记录无效');
  const old=snapshot.prepare('SELECT * FROM audit_events WHERE id=?').get(row.id);if(old){if(old.action!==row.action||old.detail_json!==row.detail_json)fail('类目历史请求身份记录冲突');continue;}
  appendAuditEvent(snapshot,String(row.id),null,TOMBSTONE,String(row.summary),String(row.detail_json),String(row.created_at));
 }

 for(const row of current.prepare('SELECT * FROM audit_events WHERE action=?').all(ACTION)){
  const d=JSON.parse(String(row.detail_json));if(d.version!==1||Object.keys(d).sort().join()!=='priorCallId,retryCallId,scopeKey,version'||typeof d.scopeKey!=='string'||!/^[-a-f0-9]{36}:[0-9]+:select$/.test(d.scopeKey)||claimId(d.scopeKey)!==row.id||![d.priorCallId,d.retryCallId].every(v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v)))fail('类目修复接续记录无效');
  const old=snapshot.prepare('SELECT * FROM audit_events WHERE id=?').get(row.id);if(old){if(old.action!==row.action||old.detail_json!==row.detail_json||old.created_at!==row.created_at)fail('类目修复接续记录冲突');continue;}
  appendAuditEvent(snapshot,String(row.id),null,ACTION,String(row.summary),String(row.detail_json),String(row.created_at));
 }
}
