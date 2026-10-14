import type {DatabaseSync} from 'node:sqlite';
import type {AiCall} from '../../shared/ai-contracts.ts';
import {validateAiCall,validateStoredAiResult} from './validation.ts';
import {resultHasOwner} from './result-owner.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {AiError} from './errors.ts';
import {localAiRequestResolved} from './request-certainty.ts';

const identity=(call:AiCall)=>listingFingerprint({id:call.id,providerId:call.providerId,productId:call.productId,productRevision:call.productRevision,model:call.model,generation:call.generation,startedAt:call.startedAt,requestScope:call.requestScope??null,requestFingerprint:call.requestFingerprint??null,purposeSnapshot:call.purposeSnapshot??null,presentationContext:call.presentationContext??null,sourceConsistencyContext:call.sourceConsistencyContext??null,sourceColorContext:call.sourceColorContext??null,categoryContext:call.categoryContext??null});
/** M07 writes only its original immutable identities and validated results into
 * the staged restore transaction. A usage ledger alone cannot prevent resend. */
export function retainRequestCallHistory(current:DatabaseSync,snapshot:DatabaseSync,currentDirectory:string,snapshotDirectory:string):void {
  const has=(db:DatabaseSync,table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if(!has(current,'ai_calls')||!has(snapshot,'ai_calls'))return;
  for(const row of current.prepare('SELECT id,record_json FROM ai_calls').all()){
    const call=validateAiCall(JSON.parse(String(row.record_json)));if(call.id!==row.id)throw new AiError('INVALID_CONFIG');
    const recovered=has(current,'ai_results')?current.prepare("SELECT id,record_json FROM ai_results WHERE json_extract(record_json,'$.callId')=? AND json_type(record_json,'$.providerReceiptRecovery')='object'").all(call.id):[];
    if(!recovered.length&&localAiRequestResolved(current,currentDirectory,call.id,call))continue;
    const previous=snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id);
    if(previous){const selected=validateAiCall(JSON.parse(String(previous.record_json)));if(identity(selected)!==identity(call))throw new AiError('INVALID_CONFIG');if(localAiRequestResolved(snapshot,snapshotDirectory,selected.id,selected))continue;}
    // Preserve the complete producer JSON, including optional future alias
    // snapshots understood by the strict reader; do not rebuild a partial call.
    snapshot.prepare('INSERT INTO ai_calls(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(call.id,row.record_json);
    if(!has(current,'ai_results')||!has(snapshot,'ai_results'))continue;
    // Ordinary domain results stay with the selected authenticated snapshot and
    // its existing adoption/journal retention rules. Only this protocol's local
    // receipt-linked recovery needs its companion result to preserve ownership.
    for(const resultRow of recovered){
      const result=validateStoredAiResult(JSON.parse(String(resultRow.record_json)));if(result.id!==resultRow.id||!resultHasOwner(result,call))throw new AiError('INVALID_CONFIG');
      const old=snapshot.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id);
      if(old&&listingFingerprint(JSON.parse(String(old.record_json)))!==listingFingerprint(result))throw new AiError('INVALID_CONFIG');
      snapshot.prepare('INSERT OR IGNORE INTO ai_results(id,record_json) VALUES(?,?)').run(result.id,resultRow.record_json);
    }
  }
}
