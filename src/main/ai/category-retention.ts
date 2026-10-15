import type {DatabaseSync} from 'node:sqlite';
import {dirname} from 'node:path';
import type {AiCall,AiResult} from '../../shared/ai-contracts.ts';
import {validateAiCall,validateStoredAiResult} from './validation.ts';
import {readCallReceiptSync} from './receipts.ts';
import {openRouterReceiptState} from './adapters/openrouter-http.ts';
import {resultHasOwner} from './result-owner.ts';
import {assertReceiptRecovery} from './receipt-recovery.ts';
import {localAiRequestResolved} from './request-certainty.ts';
import {validateCategoryDecision} from './category-adapter.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {assertUnambiguousRecordJson} from '../record-json.ts';
import {transaction} from '../application/transaction.ts';
import {AiError} from './errors.ts';

function invalid():never {throw new AiError('INVALID_CONFIG');}
const identity=(call:AiCall)=>listingFingerprint({id:call.id,productId:call.productId,productRevision:call.productRevision,providerId:call.providerId,model:call.model,generation:call.generation,startedAt:call.startedAt,requestScope:call.requestScope??null,requestFingerprint:call.requestFingerprint??null,purposeSnapshot:call.purposeSnapshot??null,categoryContext:call.categoryContext??null});
/** Verify an already-owned category result against the received response. This
 * never decodes a new result, invents a category or grants dispatch permission. */
function matchesReceipt(result:AiResult,call:AiCall,saved:NonNullable<ReturnType<typeof readCallReceiptSync>>):boolean {
 if(result.output.kind!=='category-decision'||!resultHasOwner(result,call)||openRouterReceiptState(saved.record.status,saved.capture.body)!=='available'||saved.record.status<200||saved.record.status>=300)return false;
 const body=saved.capture.body as any,output=result.output;if(call.categoryContext&&output.phase!==call.categoryContext.phase)return false;
 try{
  if(saved.record.endpoint==='/api/alpha/decisions'){
   const answers=body?.answers;if(!answers||Object.keys(answers).sort().join()!=='category,review'||answers.category?.type!=='choice'||typeof answers.category.choice!=='string'||answers.review?.type!=='choice'||!['clear','review'].includes(answers.review.choice))return false;
   if(answers.category.choice==='$NO_SUITABLE')return output.productType===null&&output.selection?.outcome==='NO_SUITABLE'&&call.categoryContext?.version===2&&output.selection.candidateSnapshotSha256===call.categoryContext.candidateSnapshotSha256;
   return output.productType===answers.category.choice&&output.keywords.length===0&&output.ambiguous===(output.phase==='select'&&answers.review.choice==='review')&&(!output.selection||call.categoryContext?.version===2&&output.selection.outcome==='SELECTED'&&output.selection.candidateSnapshotSha256===call.categoryContext.candidateSnapshotSha256);
  }
  if(!Array.isArray(body?.choices)||body.choices.length!==1||body.choices[0]?.finish_reason!=='stop'||body.choices[0].message?.refusal||body.choices[0].message?.tool_calls?.length||typeof body.choices[0].message?.content!=='string')return false;
  return listingFingerprint(validateCategoryDecision(JSON.parse(body.choices[0].message.content)))===listingFingerprint(output);
 }catch{return false;}
}
/** Preserve M07 category evidence, not product/draft business state. The existing
 * provider-receipt restore port copies these validated private file references
 * into the staged artifact root after this synchronous owner transaction. */
export function retainCategoryPhaseHistory(current:DatabaseSync,snapshot:DatabaseSync):void {
 const has=(db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 if(!['ai_calls','ai_results','ai_provider_receipts'].every(name=>has(current,name)&&has(snapshot,name)))return;
 const file=current.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;if(typeof file!=='string'||!file)return;const directory=dirname(file);
 for(const name of ['ai_calls','ai_results','ai_provider_receipts'])assertUnambiguousRecordJson(current,name);
 transaction(snapshot,()=>{
  for(const row of current.prepare('SELECT id,record_json FROM ai_calls').all()){
   const call=validateAiCall(JSON.parse(String(row.record_json)));if(call.id!==row.id)invalid();if(!call.categoryContext&&!['category_analysis','category_decision'].includes(call.purposeSnapshot?.purposeId??''))continue;
   const saved=readCallReceiptSync(current,directory,call);if(!saved||listingFingerprint((saved.capture as unknown as {purpose:unknown}).purpose??null)!==listingFingerprint(call.purposeSnapshot??null)||!localAiRequestResolved(current,directory,call.id,call))continue;
   const results=current.prepare("SELECT id,record_json FROM ai_results WHERE json_extract(record_json,'$.callId')=?").all(call.id).filter(row=>{try{const result=validateStoredAiResult(JSON.parse(String(row.record_json)));assertReceiptRecovery(current,directory,result,call);return result.id===row.id&&matchesReceipt(result,call,saved);}catch{return false;}});
   if(call.status==='SUCCEEDED'&&!results.length)continue;
   const previous=snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id);if(previous){const selected=validateAiCall(JSON.parse(String(previous.record_json)));if(identity(selected)!==identity(call))invalid();if(selected.status!=='RUNNING'&&localAiRequestResolved(snapshot,directory,selected.id,selected)&&listingFingerprint(selected)!==listingFingerprint(call))invalid();}
   if(!previous||listingFingerprint(JSON.parse(String(previous.record_json)))!==listingFingerprint(call))snapshot.prepare('INSERT INTO ai_calls(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(call.id,String(row.record_json));
   const receipt=snapshot.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(saved.record.id);if(receipt&&listingFingerprint(JSON.parse(String(receipt.record_json)))!==listingFingerprint(saved.record))invalid();
   snapshot.prepare('INSERT OR IGNORE INTO ai_provider_receipts(id,record_json) VALUES(?,?)').run(saved.record.id,JSON.stringify(saved.record));
   for(const result of results){const previous=snapshot.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id);if(previous&&listingFingerprint(JSON.parse(String(previous.record_json)))!==listingFingerprint(JSON.parse(String(result.record_json))))invalid();snapshot.prepare('INSERT OR IGNORE INTO ai_results(id,record_json) VALUES(?,?)').run(result.id,String(result.record_json));}
  }
 });
}
