import type {DatabaseSync} from 'node:sqlite';
import {validateAiCall,validateStoredAiResult} from './validation.ts';
import {resultHasOwner} from './result-owner.ts';
import {readCallReceiptSync} from './receipts.ts';
import {openRouterFailure} from './adapters/openrouter-http.ts';
import {assertReceiptRecovery} from './receipt-recovery.ts';
import {httpError,receivedDeepSeekRejection} from './errors.ts';

/** Result certainty is independent of reported usage and current adoption permission.
 * This query does not settle costs, repair records or grant another provider request. */
export function localAiRequestResolved(db:DatabaseSync,directory:string,id:string,raw:unknown):boolean {
  try{
    const call=validateAiCall(raw);if(call.id!==id||call.status==='RUNNING')return false;
    for(const row of db.prepare("SELECT id,record_json FROM ai_results WHERE json_extract(record_json,'$.callId')=?").all(call.id)){
      try{const result=validateStoredAiResult(JSON.parse(String(row.record_json)));assertReceiptRecovery(db,directory,result,call);if(result.id===row.id&&resultHasOwner(result,call))return true;}catch{/* An unrelated/damaged result does not prove completion. */}
    }
    const saved=readCallReceiptSync(db,directory,call);if(!saved)return false;
    const {record,capture}=saved,body=capture.body as any;
    // HTTP 200 may contain an upstream processing error; a complete envelope is
    // not proof of rejection before processing, nor a valid domain result.
    if(record.status>=200&&record.status<300)return call.status==='FAILED'&&call.errorCode==='OUTPUT_INVALID'&&body!=='[omitted: credential echo]'&&!openRouterFailure(record.status,body);
    if(call.status!=='FAILED'||body===undefined||typeof body==='string'&&!body.trim()||body==='[omitted: credential echo]')return false;
    const error=record.gateway==='openrouter'?openRouterFailure(record.status,body):httpError(record.status,body?.error?.code);
    const definitive=record.gateway==='openrouter'?!!error&&'definitive' in error&&error.definitive===true:receivedDeepSeekRejection(record.status,body,call.errorCode!);
    // Earlier OpenRouter readers encoded a complete matching 403 as AUTH_FAILED.
    // Recognize that terminal receipt; retry permission remains with the existing
    // explicit once-only claim, not this read-only certainty projection.
    const legacy403=record.gateway==='openrouter'&&record.status===403&&call.errorCode==='AUTH_FAILED'&&typeof body?.error?.message==='string'&&!!body.error.message.trim()&&(body.error.code===undefined||body.error.code===403);
    return definitive&&(call.errorCode===error?.code||legacy403);
  }catch{return false;}
}
