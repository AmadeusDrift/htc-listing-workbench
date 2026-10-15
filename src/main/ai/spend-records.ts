import {createHash} from 'node:crypto';
import type {AiSpendBound,AiSpendPolicy,AiSpendReservation,ImagePriceEvidence} from '../../shared/ai-spend-contracts.ts';
import {AiError} from './errors.ts';
import {listingFingerprint} from '../json-fingerprint.ts';

export class SpendBudgetError extends AiError {
 readonly budgetCode:string;
 constructor(code:string){super(['SPEND_LIMIT_INVALID','SPEND_POLICY_CONFLICT'].includes(code)?'INVALID_INPUT':'QUOTA_EXCEEDED');this.budgetCode=code;this.diagnosticReason=code;this.message=({SPEND_BOUND_UNAVAILABLE:'费用上界无法可靠核验；未发送新付费请求',SPEND_LIMIT_EXCEEDED:'金额预算不足或仍有未知费用预留；未发送',SPEND_COST_ANOMALY:'已报告费用超过原预留上界；停止新增付费请求',SPEND_IDENTITY_CONFLICT:'费用请求身份不一致；请核对原请求',SPEND_RECORD_INVALID:'费用记录无效；未发送',SPEND_LIMIT_INVALID:'请输入非负USD金额，最多6位小数；未增加金额上限',SPEND_POLICY_CONFLICT:'日金额设置已变化，请刷新后重新保存'} as Record<string,string>)[code]??'费用保护阻止了本次操作';}
}
export function spendInvalid():never{throw new SpendBudgetError('SPEND_RECORD_INVALID');}
/** Strict data descriptors prevent readers from executing accessors before validation. */
export function spendObject(raw:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,any>{
 if(!raw||typeof raw!=='object'||Object.getPrototypeOf(raw)!==Object.prototype)spendInvalid();
 const descriptors=Object.getOwnPropertyDescriptors(raw);
 if(Reflect.ownKeys(raw).some(k=>typeof k!=='string'||!required.includes(k)&&!optional.includes(k))||required.some(k=>!Object.hasOwn(descriptors,k))||Object.values(descriptors).some(d=>!Object.hasOwn(d,'value')||!d.enumerable))spendInvalid();return raw as Record<string,any>;
}
export function spendInteger(raw:unknown):number{if(!Number.isSafeInteger(raw)||Number(raw)<0)spendInvalid();return Number(raw);}
export function spendDate(raw:unknown):string{if(typeof raw!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw)||!Number.isFinite(Date.parse(raw))||new Date(raw).toISOString()!==raw)spendInvalid();return raw;}
export function spendHash(raw:unknown):string{if(typeof raw!=='string'||!/^[a-f0-9]{64}$/.test(raw))spendInvalid();return raw;}
export function spendUuid(raw:unknown):string{if(typeof raw!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw))spendInvalid();return raw;}
export function spendText(raw:unknown,max=200):string{if(typeof raw!=='string'||!raw.trim()||raw.length>max||/[\x00-\x1f\x7f]/.test(raw))spendInvalid();return raw;}
/** Decimal USD -> integer micro-USD, always upward; no floating point budget addition. */
export function usdMicrosCeil(raw:unknown):number{
 if(typeof raw!=='string'&&typeof raw!=='number')spendInvalid();const value=String(raw),m=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);if(!m||value.length>60)spendInvalid();
 const scale=(m[2]?.length??0)-Number(m[3]??0)-6;if(Math.abs(scale)>40)spendInvalid();let n=BigInt(m[1]+(m[2]??''));if(scale>0){const d=10n**BigInt(scale);n=(n+d-1n)/d;}else n*=10n**BigInt(-scale);if(n>BigInt(Number.MAX_SAFE_INTEGER))spendInvalid();return Number(n);
}
/** User maxima are exact, never rounded upward like provider costs. */
export function usdLimitMicros(raw:unknown):number|null{
 if(raw===null)return null;if(typeof raw!=='string'||raw.length>30||!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw))throw new SpendBudgetError('SPEND_LIMIT_INVALID');
 const [whole,fraction='']=raw.split('.'),value=BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'));if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new SpendBudgetError('SPEND_LIMIT_INVALID');return Number(value);
}
export function validateSpendPolicy(raw:unknown):AiSpendPolicy{
 const r=spendObject(raw,['version','id','period','limitUsdMicros','updatedAt']);if(r.version!==1||!['image-generation-daily','controlled-live-lifetime'].includes(r.id)||r.period!==(r.id==='image-generation-daily'?'UTC_DAY':'LIFETIME'))spendInvalid();
 if(r.limitUsdMicros!==null)spendInteger(r.limitUsdMicros);if(r.id==='controlled-live-lifetime'&&r.limitUsdMicros!==5_000_000)spendInvalid();spendDate(r.updatedAt);return r as AiSpendPolicy;
}
export function priceEvidence(model:string,body:unknown,now:Date):ImagePriceEvidence{
 const fetchedAt=spendDate(now.toISOString());return{version:1,url:`https://openrouter.ai/api/v1/images/models/${model}/endpoints`,fetchedAt,expiresAt:new Date(now.getTime()+60_000).toISOString(),body,sha256:listingFingerprint(body)};
}
function fixedImageUpper(raw:any,model:string):number|null{
 if(raw?.id!==model||!Array.isArray(raw.endpoints)||raw.endpoints.length<1||raw.endpoints.length>32)return null;let upper=0;
 for(const endpoint of raw.endpoints){
  if(!Array.isArray(endpoint?.pricing)||endpoint.pricing.length<1||endpoint.pricing.length>20)return null;let sum=0;
  for(const price of endpoint.pricing){
   if(!price||Object.keys(price).some(k=>!['billable','unit','cost_usd'].includes(k))||!((price.billable==='output_image'&&price.unit==='image')||(price.billable==='request'&&price.unit==='request')))return null;
   sum=spendInteger(sum+usdMicrosCeil(price.cost_usd));
  }upper=Math.max(upper,sum);
 }return upper;
}
/** Only exhaustive fixed-per-image/request tariffs qualify. Token rates without hard caps do not. */
export function imageSpendBound(bodyText:string,evidence:ImagePriceEvidence,at:string):AiSpendBound|null{
 const e=spendObject(evidence,['version','url','fetchedAt','expiresAt','body','sha256']);spendDate(e.fetchedAt);spendDate(e.expiresAt);spendDate(at);spendHash(e.sha256);
 const request=JSON.parse(bodyText);if(e.version!==1||typeof request.model!=='string'||e.url!==`https://openrouter.ai/api/v1/images/models/${request.model}/endpoints`||e.sha256!==listingFingerprint(e.body)||at<e.fetchedAt||at>e.expiresAt||Date.parse(e.expiresAt)-Date.parse(e.fetchedAt)>60_000)throw new SpendBudgetError('SPEND_BOUND_UNAVAILABLE');
 if(Object.keys(request).some(k=>!['model','prompt','n','size','quality','background','output_format','provider','input_references'].includes(k)))return null;
 // The only current production producer requests one image. Other shapes require a new verified method.
 if(request.n!==1)return null;const upper=fixedImageUpper(e.body,request.model);if(upper===null)return null;
 return{version:1,method:'fixed-image-endpoints/v1',requestSha256:createHash('sha256').update(bodyText).digest('hex'),upperUsdMicros:upper,evidence:structuredClone(evidence)};
}
export function validateSpendBound(raw:unknown):AiSpendBound{
 const r=spendObject(raw,['version','method','requestSha256','upperUsdMicros','evidence']);if(r.version!==1||r.method!=='fixed-image-endpoints/v1')spendInvalid();spendHash(r.requestSha256);spendInteger(r.upperUsdMicros);
 const e=spendObject(r.evidence,['version','url','fetchedAt','expiresAt','body','sha256']);if(e.version!==1||typeof e.url!=='string'||!/^https:\/\/openrouter\.ai\/api\/v1\/images\/models\/[a-zA-Z0-9_.\/-]+\/endpoints$/.test(e.url)||listingFingerprint(e.body)!==e.sha256)spendInvalid();spendDate(e.fetchedAt);spendDate(e.expiresAt);spendHash(e.sha256);
 const model=e.url.slice('https://openrouter.ai/api/v1/images/models/'.length,-'/endpoints'.length);if(fixedImageUpper(e.body,model)!==r.upperUsdMicros||e.expiresAt<e.fetchedAt||Date.parse(e.expiresAt)-Date.parse(e.fetchedAt)>60_000)spendInvalid();return r as AiSpendBound;
}
export function validateSpendReservation(raw:unknown):AiSpendReservation{
 const r=spendObject(raw,['version','id','businessKey','requestSha256','model','purpose','createdAt','policyIds','scopeId','bound','state','actualUsdMicros','receiptIds','receiptProofs']);
 if(r.version!==1||!['DISPATCH_ATTEMPTED','UNKNOWN','SETTLED','COST_ANOMALY'].includes(r.state)||!Array.isArray(r.policyIds)||r.policyIds.length<1||r.policyIds.length>2||new Set(r.policyIds).size!==r.policyIds.length||r.policyIds.some((v:unknown)=>!['image-generation-daily','controlled-live-lifetime'].includes(String(v)))||!Array.isArray(r.receiptIds)||r.receiptIds.length>100||new Set(r.receiptIds).size!==r.receiptIds.length)spendInvalid();
 spendUuid(r.id);spendHash(r.businessKey);spendHash(r.requestSha256);spendText(r.model);spendText(r.purpose);spendDate(r.createdAt);r.receiptIds.forEach(spendHash);
 if(!Array.isArray(r.receiptProofs)||r.receiptProofs.length!==r.receiptIds.length)spendInvalid();r.receiptProofs.forEach((raw:unknown,i:number)=>{const p=spendObject(raw,['receiptId','sha256','certainty']);if(p.receiptId!==r.receiptIds[i]||!['SENT_UNKNOWN','RECEIVED_INVALID','RECEIVED_VALID','DEFINITIVE_REJECTION'].includes(p.certainty))spendInvalid();spendHash(p.sha256);});
 if(r.scopeId!==null&&r.scopeId!=='htc-250-controlled-live/v1'||r.policyIds.includes('controlled-live-lifetime')!==(r.scopeId!==null))spendInvalid();
 if(r.bound!==null){const b=validateSpendBound(r.bound);if(b.requestSha256!==r.requestSha256)spendInvalid();}if(r.actualUsdMicros!==null)spendInteger(r.actualUsdMicros);
 if(r.scopeId!==null&&r.bound===null)spendInvalid();
 const resolved=r.receiptProofs.some((p:{certainty:string})=>p.certainty!=='SENT_UNKNOWN');
 if(['SETTLED','COST_ANOMALY'].includes(r.state)&&r.actualUsdMicros===null||r.state==='SETTLED'&&!resolved||r.state==='UNKNOWN'&&resolved&&r.actualUsdMicros!==null||r.state==='DISPATCH_ATTEMPTED'&&(r.actualUsdMicros!==null||r.receiptIds.length))spendInvalid();
 if(r.actualUsdMicros!==null&&!r.receiptIds.length||r.bound&&(r.createdAt<r.bound.evidence.fetchedAt||r.createdAt>r.bound.evidence.expiresAt))spendInvalid();
 if(r.state==='COST_ANOMALY'&&(r.bound===null||r.actualUsdMicros<=r.bound.upperUsdMicros)||r.state==='SETTLED'&&r.bound!==null&&r.actualUsdMicros>r.bound.upperUsdMicros)spendInvalid();return r as AiSpendReservation;
}
