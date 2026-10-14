import type {DatabaseSync} from 'node:sqlite';
import type {AiCall} from '../../shared/ai-contracts.ts';
import {validateAiCall,validateStoredAiResult} from './validation.ts';
import {resultHasOwner} from './result-owner.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {AiError} from './errors.ts';

const identity=(call:AiCall)=>listingFingerprint({id:call.id,providerId:call.providerId,productId:call.productId,productRevision:call.productRevision,model:call.model,generation:call.generation,startedAt:call.startedAt,requestScope:call.requestScope??null,requestFingerprint:call.requestFingerprint??null,purposeSnapshot:call.purposeSnapshot??null,presentationContext:call.presentationContext??null,sourceConsistencyContext:call.sourceConsistencyContext??null,sourceColorContext:call.sourceColorContext??null,categoryContext:call.categoryContext??null});
/** M07 writes only its original immutable identities and validated results into
 * the staged restore transaction. A usage ledger alone cannot prevent resend. */
export function retainRequestCallHistory(current:DatabaseSync,snapshot:DatabaseSync):void {
  const has=(db:DatabaseSync,table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if(!has(current,'ai_calls')||!has(snapshot,'ai_calls'))return;
  for(const row of current.prepare('SELECT id,record_json FROM ai_calls').all()){
    const call=validateAiCall(JSON.parse(String(row.record_json)));if(call.id!==row.id)throw new AiError('INVALID_CONFIG');
    const previous=snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id);
    if(previous&&identity(validateAiCall(JSON.parse(String(previous.record_json))))!==identity(call))throw new AiError('INVALID_CONFIG');
    // Preserve the complete producer JSON, including optional future alias
    // snapshots understood by the strict reader; do not rebuild a partial call.
    snapshot.prepare('INSERT INTO ai_calls(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(call.id,row.record_json);
    if(!has(current,'ai_results')||!has(snapshot,'ai_results'))continue;
    for(const resultRow of current.prepare("SELECT id,record_json FROM ai_results WHERE json_extract(record_json,'$.callId')=?").all(call.id)){
      const result=validateStoredAiResult(JSON.parse(String(resultRow.record_json)));if(result.id!==resultRow.id||!resultHasOwner(result,call))throw new AiError('INVALID_CONFIG');
      const old=snapshot.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id);
      if(old&&listingFingerprint(JSON.parse(String(old.record_json)))!==listingFingerprint(result))throw new AiError('INVALID_CONFIG');
      snapshot.prepare('INSERT OR IGNORE INTO ai_results(id,record_json) VALUES(?,?)').run(result.id,resultRow.record_json);
    }
  }
}
