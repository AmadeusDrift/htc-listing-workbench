import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import type {AiSpendBound} from '../../shared/ai-spend-contracts.ts';
import type {ControlledEffect} from '../application/controlled-run-scope.ts';
import {ControlledRunScopes,ControlledRunError} from '../application/controlled-run-scope.ts';
import {AiSpendBudget,assertSpendTransaction} from './spend-budget.ts';
import {SpendBudgetError,spendObject,spendUuid,spendHash,spendText,imageSpendBound,priceEvidence} from './spend-records.ts';
import {readBounded} from './transport.ts';

export const PAID_EFFECT_SERVICES=['openrouter-image','openrouter-chat','openrouter-decisions','deepseek-chat','aliyun-ocr','aliyun-segmentation','aliyun-upload-token','aliyun-oss-put','aliyun-image-risk','openrouter-batch-create','openrouter-batch-status','openrouter-batch-results','hosting-connect','hosting-size','hosting-directory','hosting-upload','hosting-post-size','hosting-public-get','reference-upload','provider-result-download','source-download'] as const;
export interface PaidEffectDescription {version:1;service:typeof PAID_EFFECT_SERVICES[number];operation:string;method:'GET'|'POST'|'PUT'|'PATCH'|'FTP';origin:string;endpoint:string;model:string|null;logicalCallId:string;effectId:string;businessKey:string;requestSha256:string;scope:ControlledEffect}
export interface PreparedPaidEffect {readonly version:1;readonly service:PaidEffectDescription['service'];readonly requestSha256:string}
interface PreparedRecord {description:PaidEffectDescription;scopeId:string|null;requiredScopeId:string|undefined;bound:AiSpendBound|null;recordMoney:boolean}
const prepared=new WeakMap<object,PreparedRecord>(),hash=(body:string|Buffer)=>createHash('sha256').update(body).digest('hex');
const notSent=(code:string)=>Object.assign(new SpendBudgetError(code),{certainty:'NOT_SENT' as const,notSent:true as const});
function description(raw:unknown,body:string|Buffer):PaidEffectDescription{
 const d=spendObject(raw,['version','service','operation','method','origin','endpoint','model','logicalCallId','effectId','businessKey','requestSha256','scope']);
 if(d.version!==1||!PAID_EFFECT_SERVICES.includes(d.service)||!['GET','POST','PUT','PATCH','FTP'].includes(d.method)||typeof body!=='string'&&!Buffer.isBuffer(body))throw notSent('SPEND_RECORD_INVALID');spendText(d.operation);spendText(d.origin,300);spendText(d.endpoint,1000);spendUuid(d.logicalCallId);spendUuid(d.effectId);spendHash(d.businessKey);spendHash(d.requestSha256);if(hash(body)!==d.requestSha256)throw notSent('SPEND_IDENTITY_CONFLICT');if(d.model!==null)spendText(d.model);
 const s=spendObject(d.scope,['kind','productId'],['taskId','itemKey','sku','targetId','sellerId','marketplaceId','variantIds','recipeKey','parentage']);spendUuid(s.productId);if(!['source','schema','classification','planning','ai','image','hosting','platform-write','platform-read','lwa','task-stage'].includes(s.kind))throw notSent('SPEND_RECORD_INVALID');
 return structuredClone(d) as PaidEffectDescription;
}
/** Main-only fee gate shared with the original owner, never a second money ledger.
 * The original owner retains business freshness, UNKNOWN locks and dispatch identity. */
export class PaidEffectBudget {
 private db:DatabaseSync;private scopes:ControlledRunScopes;private money:AiSpendBudget;private fetcher:typeof fetch;private now:()=>Date;
 constructor(db:DatabaseSync,deps:{fetch:typeof fetch;now?:()=>Date}){this.db=db;this.scopes=new ControlledRunScopes(db);this.now=deps.now??(()=>new Date());this.money=new AiSpendBudget(db,this.now);this.fetcher=deps.fetch;}
 private authorize(scopes:ControlledRunScopes,d:PaidEffectDescription,required:string|undefined):string|null{const id=scopes.authorizeEffect(d.scope);if(required!==undefined&&id!==required)throw new ControlledRunError();return id;}
 async prepare(raw:PaidEffectDescription,body:string|Buffer,signal=new AbortController().signal,requiredScopeId?:string):Promise<PreparedPaidEffect>{
  if(this.db.isTransaction)throw notSent('SPEND_RECORD_INVALID');const d=description(raw,body),scopeId=this.authorize(this.scopes,d,requiredScopeId);let bound:AiSpendBound|null=null;
  const image=d.service==='openrouter-image';
  if(image&&(d.method!=='POST'||d.origin!=='https://openrouter.ai'||d.endpoint!=='/api/v1/images'||d.logicalCallId!==d.effectId||typeof body!=='string'||JSON.parse(body).model!==d.model))throw notSent('SPEND_IDENTITY_CONFLICT');
  if(scopeId!==null&&!image)throw notSent('SPEND_BOUND_UNAVAILABLE');
  if(image&&this.money.needsBound(scopeId)){
   try{const response=await this.fetcher(`https://openrouter.ai/api/v1/images/models/${d.model}/endpoints`,{method:'GET',redirect:'error',signal});if(!response.ok)throw notSent('SPEND_BOUND_UNAVAILABLE');const rawPrice=await readBounded(response,1024*1024,signal);bound=imageSpendBound(body as string,priceEvidence(d.model!,rawPrice,this.now()),this.now().toISOString());if(!bound)throw notSent('SPEND_BOUND_UNAVAILABLE');}catch{throw notSent('SPEND_BOUND_UNAVAILABLE');}
   this.authorize(this.scopes,d,requiredScopeId);
  }
  const ticket=Object.freeze({version:1 as const,service:d.service,requestSha256:d.requestSha256});prepared.set(ticket,{description:d,scopeId,requiredScopeId,bound,recordMoney:image});return ticket;
 }
 /** Borrow the original call/effect intent transaction. COMMIT must precede HTTP/FTP. */
 reserveInTransaction(db:DatabaseSync,ticket:PreparedPaidEffect,body:string|Buffer){
  assertSpendTransaction(this.db,db);const record=prepared.get(ticket);if(!record||hash(body)!==record.description.requestSha256)throw notSent('SPEND_IDENTITY_CONFLICT');const d=record.description,scopeId=this.authorize(new ControlledRunScopes(db),d,record.requiredScopeId);if(scopeId!==record.scopeId)throw notSent('SPEND_IDENTITY_CONFLICT');if(!record.recordMoney)return null;
  return this.money.reserveInTransaction(db,{id:d.effectId,businessKey:d.businessKey,requestSha256:d.requestSha256,model:d.model!,purpose:d.operation,scopeId},body as string,record.bound);
 }
}
