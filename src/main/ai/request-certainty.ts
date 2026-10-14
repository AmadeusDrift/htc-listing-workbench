import type {DatabaseSync} from 'node:sqlite';
import {validateAiCall,validateStoredAiResult} from './validation.ts';
import {resultHasOwner} from './result-owner.ts';
import {readCallReceiptSync} from './receipts.ts';
import {openRouterHttpError} from './adapters/openrouter-http.ts';
import {httpError} from './errors.ts';

/** Result certainty is independent of reported usage and current adoption permission.
 * This query does not settle costs, repair records or grant another provider request. */
export function localAiRequestResolved(db:DatabaseSync,directory:string,id:string,raw:unknown):boolean {
  try{
    const call=validateAiCall(raw);if(call.id!==id||call.status==='RUNNING')return false;
    for(const row of db.prepare("SELECT id,record_json FROM ai_results WHERE json_extract(record_json,'$.callId')=?").all(call.id)){
      try{const result=validateStoredAiResult(JSON.parse(String(row.record_json)));if(result.id===row.id&&resultHasOwner(result,call))return true;}catch{/* An unrelated/damaged result does not prove completion. */}
    }
    const saved=readCallReceiptSync(db,directory,call);if(!saved)return false;
    const {record,capture}=saved,body=capture.body as any;
    // HTTP 200 may contain an upstream processing error; a complete envelope is
    // not proof of rejection before processing, nor a valid domain result.
    if(record.status>=200&&record.status<300)return call.status==='FAILED'&&call.errorCode==='OUTPUT_INVALID'&&body!=='[omitted: credential echo]'&&!body?.error&&!(Array.isArray(body?.choices)&&body.choices.some((c:any)=>c?.error));
    if(call.status!=='FAILED'||!body||typeof body!=='object'||!body.error)return false;
    const error=record.gateway==='openrouter'?openRouterHttpError(record.status,body):httpError(record.status,body.error.code);
    const definitive=record.gateway==='openrouter'?(error as ReturnType<typeof openRouterHttpError>).definitive:[401,402,403,429].includes(record.status);
    return definitive&&call.errorCode===error.code;
  }catch{return false;}
}
