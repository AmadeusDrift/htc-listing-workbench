import type {DatabaseSync} from 'node:sqlite';
import {categoryCalls} from './category-recovery.ts';
import {categoryFailureKind} from './category-retry.ts';
import {localAiRequestResolved} from './request-certainty.ts';
import {validateAiCall} from './validation.ts';
import {readCategoryOperation} from './category-operations.ts';
import {readCategoryLookup,type CategoryLookupTarget} from './category-expansion-receipts.ts';
import {AiError} from './errors.ts';

/** Read original product-root knowledge, irrespective of the current task, Key or
 * source revision. This is neither retry permission nor a paid-call reservation. */
export function categoryUnknownCode(db:DatabaseSync,directory:string,productId:string,targetScope?:()=>CategoryLookupTarget):'CATEGORY_RESULT_UNKNOWN'|'CATEGORY_EXPANSION_RESULT_UNKNOWN'|null {
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
  const expansion=readCategoryOperation(db,productId).expansion;
  if(expansion?.permittedAt){
   try{
    if(!targetScope||!readCategoryLookup(db,directory,productId,expansion.requestId,targetScope()))return 'CATEGORY_EXPANSION_RESULT_UNKNOWN';
   }catch(error){
    if(!(error instanceof AiError)||error.diagnosticReason!=='CATEGORY_EXPANSION_RESPONSE_INVALID'||!['RECEIVED_INVALID','DEFINITIVE_REJECTION'].includes(error.certainty??'')||error.requestId!==expansion.requestId)return 'CATEGORY_EXPANSION_RESULT_UNKNOWN';
   }
  }
  return null;
 }catch{return 'CATEGORY_RESULT_UNKNOWN';}
}

/** Only the exact original M07 lookup error may link an existing task failure to
 * its client request. UUID shape or provider text alone never establishes scope. */
export function categoryFailureRequestId(db:DatabaseSync,productId:string,error:unknown):string|undefined {
 try{
  if(!(error instanceof AiError)||!['CATEGORY_EXPANSION_RESULT_UNKNOWN','CATEGORY_EXPANSION_RECEIPT_INVALID','CATEGORY_EXPANSION_RESPONSE_INVALID'].includes(error.diagnosticReason??'')||typeof error.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(error.requestId))return;
  if(error.diagnosticReason==='CATEGORY_EXPANSION_RESPONSE_INVALID'?error.code!=='OUTPUT_INVALID'||!['RECEIVED_INVALID','DEFINITIVE_REJECTION'].includes(error.certainty??''):error.code!=='INTERRUPTED'||error.certainty!=='SENT_UNKNOWN')return;
  const expansion=readCategoryOperation(db,productId).expansion;
  if(expansion?.permittedAt&&expansion.requestId===error.requestId)return expansion.requestId;
 }catch{/* An unreadable original identity is never replaced with a guessed one. */}
}
