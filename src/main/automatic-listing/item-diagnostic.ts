import type { DatabaseSync } from 'node:sqlite';
import type { AutomaticListingItem, AutomaticListingTask } from '../../shared/automatic-listing-contracts.ts';
import type { AutomaticItemDiagnostic } from '../../shared/automatic-item-diagnostic.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { CompletionOperation } from '../listing-ai/completion-journal.ts';
import { completionSafetyIdentity } from '../listing-ai/completion-journal.ts';
import { sanitizeFailureReason } from '../../shared/automatic-resume.ts';
const fieldName=(v:unknown):v is string=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,99}$/i.test(v);
/** Explicit detail only. These records explain evidence; they never authorize a send. */
export function readItemDiagnostic(db:DatabaseSync,task:AutomaticListingTask,item:AutomaticListingItem):AutomaticItemDiagnostic {
 const result:AutomaticItemDiagnostic={resultUnknown:item.outcome?.kind==='UNKNOWN',fields:[],requests:[],note:'仅显示此 SKU 已保存的字段问题与明确关联的原调用；保存值不等于已通过校验或已采用。'};
 const names=new Map<string,string[]>(),calls=new Map<string,{purpose:string;fields:string[]}>();
 const add=(name:string,message:string)=>{if(fieldName(name))names.set(name,[...(names.get(name)??[]),sanitizeFailureReason(message)]);};
 let draft:AmazonDraft|undefined;
 try {
  if(item.draftId){const saved=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(item.draftId);const d=saved?JSON.parse(String(saved.record_json)).draft:undefined;
   if(d&&d.id===item.draftId&&d.productId===item.productId&&d.variantId===item.variantId&&d.sku===item.sku&&d.mode===task.mode&&d.sellerId===task.sellerId&&d.marketplaceId===task.marketplaceId)draft=d;
  }
  if(draft){
   for(const issue of [...draft.localIssues,...draft.previewIssues,...draft.listingIssues])if(issue.severity==='ERROR')for(const name of issue.attributeNames)add(name,issue.message);
   const identity=completionSafetyIdentity(draft);
   for(const row of db.prepare("SELECT record_json FROM listing_completion_operations WHERE json_extract(record_json,'$.safetyIdentity.productId')=?").all(item.productId)){
    const op=JSON.parse(String(row.record_json)) as CompletionOperation;
    if(op.draftId!==draft.id||!op.safetyIdentity||Object.entries(identity).some(([key,value])=>(op.safetyIdentity as unknown as Record<string,unknown>)[key]!==value))continue;
    for(const round of op.rounds){if(round.context?.draftId!==draft.id||round.context.productId!==item.productId||round.context.variantId!==item.variantId||round.context.sku!==item.sku)continue;
     const fields=round.context.fields.map(f=>f.name).filter(fieldName);
     for(const call of [round.candidate,round.review])if(call)for(const entry of [call,...(call.previous??[])])calls.set(entry.id,{purpose:call===round.review?'字段复核':'字段生成',fields});
    }
    for(const issue of op.reviewIssues??[])add(issue.field,issue.message);
   }
  }
  if(item.stage==='SOURCES')for(const row of db.prepare("SELECT record_json FROM source_consistency_attempts WHERE json_extract(record_json,'$.context.productId')=?").all(item.productId)){
   const attempt=JSON.parse(String(row.record_json));
   if(attempt.context?.productRevision===item.productRevision&&(item.salesPlan?.recipe.components.map(c=>c.variantId)??[item.variantId]).includes(attempt.context?.variantId))calls.set(attempt.callId,{purpose:'来源图片观察',fields:[]});
  }
  for(const [id,scope] of calls){const saved=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(id);if(!saved)continue;const call=JSON.parse(String(saved.record_json));
   if(call.id!==id||call.productId!==item.productId||call.productRevision!==item.productRevision)continue;
   result.requests.push({id,purpose:scope.purpose,status:String(call.status),errorCode:typeof call.errorCode==='string'?sanitizeFailureReason(call.errorCode):null,startedAt:typeof call.startedAt==='string'?call.startedAt:null,finishedAt:typeof call.finishedAt==='string'?call.finishedAt:null,fields:scope.fields});
  }
 }catch{result.note+=' 部分原记录暂不可读，未推断请求结果或解除保护。';}
 for(const message of item.repair?.remaining??[]){const name=message.match(/^([a-z][a-z0-9_]{0,99})\s*[:：]/i)?.[1];if(name)add(name,message);}
 result.fields=[...names].map(([name,messages])=>{const value=draft?.attributes[name];return {name,message:[...new Set(messages)].join('；'),hasSavedValue:draft?Object.hasOwn(draft.attributes,name)&&value!==null&&value!==undefined&&(!Array.isArray(value)||value.length>0):null};});
 result.requests.sort((a,b)=>(b.startedAt??'').localeCompare(a.startedAt??''));
 if(result.resultUnknown)result.note+=' 原请求结果尚未确认，不能认定这些字段缺失，也不能重复发送。';
 if(!result.requests.length)result.note+=' 未找到可明确关联的原调用，不能按商品或时间猜测归属。';
 return result;
}
