import type { AutomaticListingItem } from './automatic-listing-contracts.ts';
import { UserFacingError } from './errors.ts';
export interface AutomaticResumeSelection { mode:'targeted'|'recheck'; selections:{key:string;slots?:number[]}[] }
export interface AutomaticFailureEvent { version:1; stage:AutomaticListingItem['stage']; reason:string; occurredAt:string|null;slot?:number;source?:'request-proof'|'local-check' }
/** A recorded check/receipt time is never the provider request's start time. */
export function automaticFailureTime(event:Pick<AutomaticFailureEvent,'occurredAt'|'source'>,lastContinuedAt?:string):{label:string;at:string|null} {
 if(!event.occurredAt)return {label:'原失败时间未保存',at:null};
 if(event.source==='request-proof')return {label:'原请求明确失败凭据时间',at:event.occurredAt};
 if(event.source==='local-check')return {label:lastContinuedAt&&Date.parse(event.occurredAt)>=Date.parse(lastContinuedAt)?'本次本地检查时间':'历史本地检查时间',at:event.occurredAt};
 return {label:'失败记录时间（未保存时间来源）',at:event.occurredAt};
}
/** Stored errors are not trusted to contain public-only text. Never render request payloads. */
export function sanitizeFailureReason(raw:string):string {
 return raw.replace(/(?:request\s*body|response\s*body|body|payload|请求体|响应体)\s*[:=][\s\S]*/gi,'[请求内容已隐藏]')
 .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi,'[地址已隐藏]')
 .replace(/(?:authorization|api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi,'[凭据已隐藏]')
 .replace(/\bBearer\s+[^\s,;]+/gi,'[凭据已隐藏]')
 .replace(/\{[\s\S]*/g,'[结构化内容已隐藏]')
 .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b/g,'[凭据已隐藏]').slice(0,2000);
}
export function rememberFailure(row:AutomaticListingItem,occurredAt:string|null,slot?:number,source?:'request-proof'|'local-check'):void {
 if(!row.error)return;
 const event:AutomaticFailureEvent={version:1,stage:row.stage,reason:sanitizeFailureReason(row.error),occurredAt,...(slot?{slot}:{}),...(source?{source}:{})};
 const previous=row.failureHistory?.at(-1);
 if(previous&&previous.reason===event.reason&&previous.stage===event.stage&&previous.slot===event.slot&&(occurredAt===null||previous.occurredAt===occurredAt))return;
 (row.failureHistory??=[]).push(event);
}
export function validateResumeSelection(raw:unknown,keys:string[]):AutomaticResumeSelection {
 const value=raw as AutomaticResumeSelection;
 if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['mode','selections'].includes(k))||!['targeted','recheck'].includes(value.mode)||!Array.isArray(value.selections)||!value.selections.length||value.selections.length>keys.length)throw new UserFacingError('请选择本次处理的 SKU');
 const seen=new Set<string>();
 const selections=value.selections.map(row=>{
  if(!row||Object.keys(row).some(k=>!['key','slots'].includes(k))||!keys.includes(row.key)||seen.has(row.key))throw new UserFacingError('处理范围无效或 SKU 重复');seen.add(row.key);
  if(row.slots!==undefined&&(!Array.isArray(row.slots)||!row.slots.length||row.slots.length>7||new Set(row.slots).size!==row.slots.length||row.slots.some(s=>!Number.isInteger(s)||s<1||s>7)||value.mode!=='targeted'))throw new UserFacingError('请选择 1 至 7 的具体图位');
  return {key:row.key,...(row.slots?{slots:[...row.slots]}:{})};
 });
 return {mode:value.mode,selections};
}
export function rowSelected(scope:AutomaticResumeSelection|undefined,key:string):boolean{return !scope||scope.selections.some(row=>row.key===key);}
