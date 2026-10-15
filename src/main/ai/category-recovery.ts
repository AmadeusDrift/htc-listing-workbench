import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {AiCall,AiResult} from '../../shared/ai-contracts.ts';
import {AiError} from './errors.ts';
import {taskAiContext} from './batch/task-context.ts';
import {appendAuditEvent} from '../storage/audit.ts';
import {readProviderReceipt} from './receipts.ts';
import {resultHasOwner} from './result-owner.ts';
import {assertReceiptRecovery} from './receipt-recovery.ts';
import {localAiRequestResolved} from './request-certainty.ts';
import {parseOriginalCategoryReceipt} from './category-receipt.ts';
import type {CategoryDecision} from '../../shared/category-ai-contracts.ts';
import type {ProductTypeOption} from '../../shared/amazon-contracts.ts';
import {categoryFailureKind} from './category-retry.ts';
import {assertCategoryPhaseRepair,reserveCategoryPhaseRepair,retainCategoryOperations} from './category-operations.ts';
import {uuid} from './primitives.ts';
import {retainCategoryPhaseHistory} from './category-retention.ts';
import {transaction} from '../application/transaction.ts';

const ACTION='ai.category.detail-repair';
const TOMBSTONE='ai.category.restored-request';
const rejection='state[1] is not a valid "image_url" part: image_url.detail: Invalid option: expected one of "auto"|"low"|"high"';
function fail(message:string):never {const e=new AiError('PROVIDER_ERROR');e.message=message;throw e;}
const claimId=(scope:string)=>{const h=createHash('sha256').update(ACTION+scope).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
export function categoryCalls(calls:AiCall[],productId:string,revision?:number):AiCall[]{
 return calls.filter(c=>c.productId===productId&&(revision===undefined||c.productRevision===revision)&&(c.categoryContext||['category_analysis','category_decision'].includes(c.purposeSnapshot?.purposeId??'')||!c.purposeSnapshot&&!c.presentationContext&&!c.sourceConsistencyContext&&!c.sourceColorContext&&/^(openrouter|deepseek)/.test(c.providerId)));
}
export function assertCategoryRepairAvailable(db:DatabaseSync,prior:AiCall,scopeKey:string):void{
 const scope=taskAiContext.getStore();
 if(!scope?.explicitContinueAt||!Number.isFinite(Date.parse(scope.explicitContinueAt))||!scope.authorize()||Date.parse(scope.explicitContinueAt)<=Date.parse(prior.finishedAt??prior.startedAt))fail('类目接口参数历史失败：请在更新程序后手动继续原任务；本次未发送');
 if(db.prepare("SELECT 1 FROM audit_events WHERE action=? AND (id=? OR json_extract(detail_json,'$.priorCallId')=? OR json_extract(detail_json,'$.retryCallId')=?)").get(ACTION,claimId(scopeKey),prior.id,prior.id))fail('类目接口参数修复已尝试一次；请核对新回执，本次未重复发送');
}
export async function recoverCategoryPhase(options:{db:DatabaseSync;directory:string;calls:AiCall[];results:AiResult[];productId:string;productRevision:number;model:string;effort:string;context:NonNullable<AiCall['categoryContext']>;payloadHash:string;originalBatchCallId?:string;current?:Pick<AiCall,'providerId'|'generation'>;payload?:{phase:CategoryDecision['phase'];candidates:ProductTypeOption[];[key:string]:unknown}}){
 const {db,directory,results,context}=options, calls=categoryCalls(options.calls,options.productId);
 for(const row of db.prepare("SELECT id,detail_json FROM audit_events WHERE action=? AND json_extract(detail_json,'$.productId')=?").all(TOMBSTONE,options.productId)){
  const marker=JSON.parse(String(row.detail_json));if(Object.keys(marker).sort().join()!=='callId,productId,productRevision'||marker.productId!==options.productId||!Number.isSafeInteger(marker.productRevision)||marker.productRevision<1||row.id!==claimId('restored:'+uuid(marker.callId)))fail('类目备份请求保护记录无效；本次未发送');
  if(!calls.some(call=>call.id===marker.callId&&call.productRevision===marker.productRevision))fail('恢复备份前存在类目请求记录，当前备份缺少完整请求结果；本次未重发，请核对历史记录');
 }
 const owned=(result:AiResult,call:AiCall)=>{try{assertReceiptRecovery(db,directory,result,call);return result.output.kind==='category-decision'&&resultHasOwner(result,call);}catch{return false;}};
 const exact=(call:AiCall)=>call.model===options.model&&(!options.current||call.providerId===options.current.providerId)&&call.purposeSnapshot?.effectiveEffort===options.effort&&(!call.categoryContext||call.categoryContext.requestSha256===context.requestSha256&&(call.categoryContext.version!==2||context.version===2&&call.categoryContext.operationId===context.operationId&&call.categoryContext.inputVersion===context.inputVersion&&call.categoryContext.candidateSnapshotSha256===context.candidateSnapshotSha256&&call.categoryContext.expansion===context.expansion));
 const saved=results.find(result=>result.output.kind==='category-decision'&&result.output.phase===context.phase&&result.productId===options.productId&&result.productRevision===options.productRevision&&result.sourceSha256===options.payloadHash&&calls.some(call=>call.id===result.callId&&exact(call)&&owned(result,call)));
 // A failure in another phase must not hide an exact successful phase. A
 // pending request in this same phase still outranks an older cached result.
 if(saved&&!calls.some(call=>(!call.categoryContext||call.categoryContext.phase===context.phase)&&!localAiRequestResolved(db,directory,call.id,call)))return{saved,priors:[],calls,replayCall:undefined};
 // Hand a valid, exactly bound original response back to M07's original-call
 // local replay. A legacy missing context or a null/invalid domain is not proof.
 if(options.payload)for(const call of calls)if(call.status==='FAILED'&&call.requestScope&&call.requestFingerprint&&call.categoryContext?.phase===context.phase&&exact(call)&&await parseOriginalCategoryReceipt(db,directory,call,options.payload)){
  const other=calls.find(other=>other.id!==call.id&&(!other.categoryContext||other.categoryContext.phase===context.phase)&&!localAiRequestResolved(db,directory,other.id,other));
  if(!other)return{saved:undefined,priors:[],calls,replayCall:call};
 }
 const priors:AiCall[]=[],generic:AiCall[]=[];
 for(const call of calls){
  if(call.id===options.originalBatchCallId)continue;
  const owned=results.find(r=>r.callId===call.id&&r.productId===call.productId&&r.productRevision===call.productRevision&&r.model===call.model&&r.providerId===call.providerId&&r.output.kind==='category-decision');
  if(call.status==='SUCCEEDED'&&owned)continue;
  const consumed=db.prepare("SELECT detail_json FROM audit_events WHERE action=? AND (json_extract(detail_json,'$.priorCallId')=? OR EXISTS(SELECT 1 FROM json_each(json_extract(detail_json,'$.priorCallIds')) WHERE value=?))").get(ACTION,call.id,call.id);
  if(consumed){const retryId=JSON.parse(String(consumed.detail_json)).retryCallId;const retry=calls.find(c=>c.id===retryId&&c.status==='SUCCEEDED');if(retry&&results.some(r=>r.callId===retry.id&&r.productId===retry.productId&&r.productRevision===retry.productRevision&&r.model===retry.model&&r.providerId===retry.providerId&&r.output.kind==='category-decision'))continue;}
  const phase=call.categoryContext?.phase??(call.purposeSnapshot?.purposeId==='category_decision'?'select':undefined);
  const kind=categoryFailureKind(db,directory,call,options.payload?{candidates:options.payload.candidates,requestSha256:context.requestSha256}:undefined);
  if(!['UNKNOWN','VALID_OUTPUT'].includes(kind)){
   if(phase!==context.phase)continue;
   if(context.version===2&&options.current){generic.push(call);continue;}
  }
  // Unresolved calls block even after a model/configuration change. Never infer a timeout was rejected.
  let receipt:any=null;try{receipt=await readProviderReceipt(db,directory,call.id);}catch{}
  const exact=!call.categoryContext&&call.status==='FAILED'&&call.errorCode==='PROVIDER_ERROR'&&phase==='select'&&receipt?.callId===call.id&&receipt.model===call.model&&receipt.gateway==='openrouter'&&receipt.endpoint==='/api/alpha/decisions'&&receipt.status===400&&receipt.body?.error?.code===400&&receipt.body.error.message===rejection;
  if(!exact){const error=new AiError('INTERRUPTED');error.callId=call.id;error.certainty=kind==='INVALID_OUTPUT'?'RECEIVED_INVALID':kind==='VALID_OUTPUT'?'RECEIVED_VALID':'SENT_UNKNOWN';error.diagnosticReason='CATEGORY_ORIGINAL_RESULT_REQUIRED';error.message='类目原阶段仍需核对或恢复原结果；原调用和费用保留，本次未重发';throw error;}
  if(context.phase==='select'){
   priors.push(call);assertCategoryRepairAvailable(db,call,`${call.productId}:${call.productRevision}:select`);
  }
 }
 if(generic.length){if(priors.length||context.version!==2||!options.current)fail('类目历史许可身份存在冲突；本次未发送');try{assertCategoryPhaseRepair(db,directory,generic,options.current,context,options.payload?.candidates);}catch(cause){if(cause instanceof AiError){cause.callId??=generic[0].id;cause.certainty??=categoryFailureKind(db,directory,generic[0])==='INVALID_OUTPUT'?'RECEIVED_INVALID':'DEFINITIVE_REJECTION';}throw cause;}priors.push(...generic);}
 return {saved,priors,calls,replayCall:undefined};
}
/** Called within usage reservation transaction: claim and new call succeed or roll back together. */
export function claimCategoryRepair(db:DatabaseSync,priors:AiCall[],retry:AiCall,directory?:string,candidates?:ProductTypeOption[]):void{
 if(priors.some(prior=>prior.categoryContext)){if(!directory)fail('类目阶段原记录不可核验');reserveCategoryPhaseRepair(db,directory,priors,retry,candidates);return;}
 const prior=priors[0];if(!prior||priors.some(p=>p.productId!==prior.productId||p.productRevision!==prior.productRevision)||new Set(priors.map(p=>p.id)).size!==priors.length)fail('类目修复历史请求组无效');
 const scopeKey=`${prior.productId}:${prior.productRevision}:select`;for(const member of priors)assertCategoryRepairAvailable(db,member,scopeKey);
 if(!db.prepare('SELECT 1 FROM ai_calls WHERE id=?').get(retry.id)||!db.prepare('SELECT 1 FROM ai_usage_ledger WHERE id=?').get(retry.id))fail('类目请求记账未完成');
 appendAuditEvent(db,claimId(scopeKey),prior.productId,ACTION,'Decisions 图片参数修复后手动接续一次',JSON.stringify({version:2,scopeKey,priorCallId:prior.id,priorCallIds:priors.map(p=>p.id).sort(),retryCallId:retry.id}),retry.startedAt);
}
export function retainCategoryRepairs(current:DatabaseSync,snapshot:DatabaseSync):void{
 transaction(snapshot,()=>{
 retainCategoryPhaseHistory(current,snapshot);
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
  const d=JSON.parse(String(row.detail_json));if(![1,2].includes(d.version)||Object.keys(d).sort().join()!==(d.version===1?'priorCallId,retryCallId,scopeKey,version':'priorCallId,priorCallIds,retryCallId,scopeKey,version')||d.version===2&&(!Array.isArray(d.priorCallIds)||!d.priorCallIds.length||d.priorCallIds.length>10000||!d.priorCallIds.every((v:unknown)=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v))||!d.priorCallIds.includes(d.priorCallId)||new Set(d.priorCallIds).size!==d.priorCallIds.length)||typeof d.scopeKey!=='string'||!/^[-a-f0-9]{36}:[0-9]+:select$/.test(d.scopeKey)||claimId(d.scopeKey)!==row.id||![d.priorCallId,d.retryCallId].every(v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v)))fail('类目修复接续记录无效');
  const old=snapshot.prepare('SELECT * FROM audit_events WHERE id=?').get(row.id);if(old){if(old.action!==row.action||old.detail_json!==row.detail_json||old.created_at!==row.created_at)fail('类目修复接续记录冲突');continue;}
  appendAuditEvent(snapshot,String(row.id),null,ACTION,String(row.summary),String(row.detail_json),String(row.created_at));
 }
 retainCategoryOperations(current,snapshot);
 });
}
