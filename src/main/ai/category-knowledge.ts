import type {DatabaseSync} from 'node:sqlite';
import {categoryCalls} from './category-recovery.ts';
import {categoryFailureKind} from './category-retry.ts';
import {localAiRequestResolved} from './request-certainty.ts';
import {validateAiCall} from './validation.ts';

/** Read original product-root knowledge, irrespective of the current task, Key or
 * source revision. This is neither retry permission nor a paid-call reservation. */
export function categoryUnknownCode(db:DatabaseSync,directory:string,productId:string):'CATEGORY_RESULT_UNKNOWN'|null {
 try{
  const calls=categoryCalls(db.prepare("SELECT id,record_json FROM ai_calls WHERE json_extract(record_json,'$.productId')=?").all(productId).map(row=>{
   const call=validateAiCall(JSON.parse(String(row.record_json)));if(call.id!==row.id)throw Error('Category call identity');return call;
  }),productId);
  for(const row of db.prepare("SELECT detail_json FROM audit_events WHERE product_id=? AND action='ai.category.restored-request' UNION ALL SELECT detail_json FROM audit_events WHERE product_id IS NULL AND action='ai.category.restored-request' AND json_extract(detail_json,'$.productId')=?").all(productId,productId)){
   const marker=JSON.parse(String(row.detail_json));if(!calls.some(call=>call.id===marker.callId&&call.productRevision===marker.productRevision))return 'CATEGORY_RESULT_UNKNOWN';
  }
  // Use the existing product expression index once; the shared classifier still
  // validates every original result, owner and private receipt for its call.
  const results=calls.length?db.prepare("SELECT id,record_json FROM ai_results WHERE json_extract(record_json,'$.productId')=?").all(productId):[];
  for(const call of calls){
   if(['INVALID_OUTPUT','REJECTION','AUTHENTICATION','FORBIDDEN'].includes(categoryFailureKind(db,directory,call)))continue;
   if(localAiRequestResolved(db,directory,call.id,call,results))continue;
   return 'CATEGORY_RESULT_UNKNOWN';
  }
  return null;
 }catch{return 'CATEGORY_RESULT_UNKNOWN';}
}
