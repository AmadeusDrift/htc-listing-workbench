import type {DatabaseSync} from 'node:sqlite';
import type {AiCall,AiResult} from '../../shared/ai-contracts.ts';
import type {CategoryRepairClaim} from '../../shared/category-ai-contracts.ts';
import type {CategoryOperationRecord,CategoryExpansionOperation,CategoryExpansionSnapshot} from '../../shared/category-operation-contracts.ts';
import {newCategoryOperation,parseCategoryOperation,addCategoryRepair,addCategoryExpansion,permitCategoryExpansion,completeCategoryExpansion,mergeCategoryOperations} from './category-operation-records.ts';
import {categoryOperationId} from './category-context.ts';
import {validateAiCall,validateStoredAiResult} from './validation.ts';
import {validateAiUsageRecord} from './usage.ts';
import {categoryFailureKind,categoryAuthenticationAllowed} from './category-retry.ts';
import {assertReceiptRecovery} from './receipt-recovery.ts';
import {resultHasOwner} from './result-owner.ts';
import {taskAiContext} from './batch/task-context.ts';
import {claimConfirmedForbiddenRetry} from './confirmed-forbidden-retry.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {transaction} from '../application/transaction.ts';
import {date,uuid} from './primitives.ts';
import {AiError} from './errors.ts';
import type {ProductTypeOption} from '../../shared/amazon-contracts.ts';
import {assertRecordTable} from '../storage/record-table.ts';

export const CATEGORY_OPERATION_TABLES={ai_category_operations:['id','record_json']};
export function initializeCategoryOperations(db:DatabaseSync):void {
 db.exec('CREATE TABLE ai_category_operations(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');
}
/** Safety references may outlive older business snapshots; missing evidence
 * never becomes dispatch permission. Present references must still be owned. */
export function assertCategoryOperationHistory(db:DatabaseSync):void {
 assertRecordTable(db,'ai_category_operations');
 for(const row of db.prepare('SELECT id,record_json FROM ai_category_operations').all()){
  const operation=parseJson(db,String(row.record_json));if(operation.id!==row.id)blocked('CATEGORY_OPERATION_RECORD_INVALID');
  for(const claim of operation.repairs)for(const id of [...claim.originalCallIds,claim.retryCallId]){const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(id);if(!row)continue;const call=validateAiCall(JSON.parse(String(row.record_json)));if(call.id!==id||call.productId!==operation.productId||call.categoryContext?.phase!==claim.phase)blocked('CATEGORY_REPAIR_IDENTITY_INVALID');if(id===claim.retryCallId&&(call.categoryContext.version!==2||call.categoryContext.operationId!==operation.id||call.categoryContext.inputVersion!==claim.inputVersion||call.categoryContext.candidateSnapshotSha256!==claim.candidateSnapshotSha256))blocked('CATEGORY_REPAIR_IDENTITY_INVALID');}
  if(operation.expansion){const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(operation.expansion.originalCallId);if(row){const call=validateAiCall(JSON.parse(String(row.record_json)));if(call.productId!==operation.productId||call.categoryContext?.version!==2||call.categoryContext.operationId!==operation.id||call.categoryContext.inputVersion!==operation.expansion.inputVersion||call.categoryContext.candidateSnapshotSha256!==operation.expansion.fromCandidateSnapshotSha256)blocked('CATEGORY_EXPANSION_ORIGINAL_REQUIRED');}}
 }
}
function blocked(reason:string):never {const error=new AiError('OUTPUT_INVALID');error.diagnosticReason=reason;error.message='类目阶段接续许可不可用；原调用、费用和成果保留，本次未发送';throw error;}
function parseJson(db:DatabaseSync,json:string):CategoryOperationRecord {
 if(Buffer.byteLength(json)>4*1024*1024||db.prepare("SELECT 1 FROM json_tree(?) WHERE parent IS NOT NULL GROUP BY parent,key COLLATE BINARY HAVING count(*)>1 LIMIT 1").get(json))blocked('CATEGORY_OPERATION_RECORD_INVALID');return parseCategoryOperation(JSON.parse(json));
}
function present(db:DatabaseSync):boolean{return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_category_operations'").get();}
/** No DDL or implicit migration; schema 36 is installed by explicit workspace migration. */
export function readCategoryOperation(db:DatabaseSync,productId:string):CategoryOperationRecord {
 if(!present(db))blocked('CATEGORY_OPERATION_LEDGER_UNAVAILABLE');const id=categoryOperationId(productId),row=db.prepare('SELECT id,record_json FROM ai_category_operations WHERE id=?').get(id);
 if(!row)return newCategoryOperation(productId);const parsed=parseJson(db,String(row.record_json));if(parsed.id!==row.id||parsed.productId!==productId)blocked('CATEGORY_OPERATION_RECORD_INVALID');return parsed;
}
/** Caller holds the actual owner transaction, including the AI call and usage reservation. */
function write(db:DatabaseSync,previous:CategoryOperationRecord,next:CategoryOperationRecord):void {
 if(!db.isTransaction)blocked('CATEGORY_OPERATION_TRANSACTION_REQUIRED');const parsed=parseCategoryOperation(next);if(parsed.id!==previous.id)blocked('CATEGORY_OPERATION_IDENTITY_CONFLICT');
 const row=db.prepare('SELECT record_json FROM ai_category_operations WHERE id=?').get(parsed.id);
 if(row){if(listingFingerprint(parseJson(db,String(row.record_json)))!==listingFingerprint(previous))blocked('CATEGORY_OPERATION_COMPARE_CONFLICT');const result=db.prepare('UPDATE ai_category_operations SET record_json=? WHERE id=? AND record_json=?').run(JSON.stringify(parsed),parsed.id,String(row.record_json));if(result.changes!==1)blocked('CATEGORY_OPERATION_COMPARE_CONFLICT');}
 else {if(listingFingerprint(previous)!==listingFingerprint(newCategoryOperation(previous.productId)))blocked('CATEGORY_OPERATION_COMPARE_CONFLICT');db.prepare('INSERT INTO ai_category_operations(id,record_json) VALUES(?,?)').run(parsed.id,JSON.stringify(parsed));}
}
function scope(productId:string):NonNullable<ReturnType<typeof taskAiContext.getStore>> {
 const current=taskAiContext.getStore();if(!current||!current.rowKey.startsWith(productId+':')||!current.authorize())blocked('CATEGORY_CONTINUATION_NOT_AUTHORIZED');return current;
}
function chainConsumed(db:DatabaseSync,ids:readonly string[]):boolean {
 for(const row of db.prepare("SELECT detail_json FROM audit_events WHERE action IN ('ai.category.detail-repair','ai.forbidden.manual-retry')").all()){
  const value=JSON.parse(String(row.detail_json));if([value.priorCallId,value.retryCallId,...(Array.isArray(value.priorCallIds)?value.priorCallIds:[])].some(id=>ids.includes(id)))return true;
 }return false;
}
export function assertCategoryPhaseRepair(db:DatabaseSync,directory:string,priors:readonly AiCall[],current:Pick<AiCall,'providerId'|'generation'>,context:Extract<NonNullable<AiCall['categoryContext']>,{version:2}>,candidates?:ProductTypeOption[]):CategoryOperationRecord {
 const first=priors[0];if(!first||priors.some(call=>call.productId!==first.productId||call.categoryContext?.phase!==context.phase)||context.operationId!==categoryOperationId(first.productId))blocked('CATEGORY_REPAIR_IDENTITY_INVALID');
 const operation=readCategoryOperation(db,first.productId),grant=scope(first.productId),continuedAt=date(grant.explicitContinueAt);if(operation.repairs.some(claim=>claim.phase===context.phase)||chainConsumed(db,priors.map(call=>call.id)))blocked('CATEGORY_REPAIR_ALREADY_USED');
 for(const prior of priors){const stored=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(prior.id);if(!stored||listingFingerprint(validateAiCall(JSON.parse(String(stored.record_json))))!==listingFingerprint(prior)||continuedAt<=(prior.finishedAt??prior.startedAt))blocked('CATEGORY_REPAIR_IDENTITY_INVALID');
  const kind=categoryFailureKind(db,directory,prior,candidates?{candidates,requestSha256:context.requestSha256}:undefined);if(kind==='AUTHENTICATION'||kind==='FORBIDDEN'){if(!categoryAuthenticationAllowed(db,prior,current,'category:'+context.operationId+':'+context.phase))blocked('CATEGORY_AUTHENTICATION_CONTINUATION_REQUIRED');}
  else if(kind!=='INVALID_OUTPUT'&&kind!=='REJECTION')blocked('CATEGORY_ORIGINAL_RESULT_REQUIRED');
 }return operation;
}
export function reserveCategoryPhaseRepair(db:DatabaseSync,directory:string,priors:readonly AiCall[],retry:AiCall,candidates?:ProductTypeOption[]):void {
 if(!db.isTransaction||retry.status!=='RUNNING'||retry.categoryContext?.version!==2)blocked('CATEGORY_OPERATION_TRANSACTION_REQUIRED');
 const operation=assertCategoryPhaseRepair(db,directory,priors,{providerId:retry.providerId,generation:retry.generation},retry.categoryContext,candidates),saved=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(retry.id),usage=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(retry.id);
 if(!saved||!usage||listingFingerprint(validateAiCall(JSON.parse(String(saved.record_json))))!==listingFingerprint(retry))blocked('CATEGORY_REPAIR_RESERVATION_REQUIRED');const ledger=validateAiUsageRecord(JSON.parse(String(usage.record_json)));if(ledger.id!==retry.id||ledger.providerId!==retry.providerId||ledger.startedAt!==retry.startedAt||ledger.state!=='PENDING')blocked('CATEGORY_REPAIR_RESERVATION_REQUIRED');
 const claim:CategoryRepairClaim={version:1,operationId:operation.id,phase:retry.categoryContext.phase,originalCallIds:priors.map(call=>call.id).sort(),retryCallId:retry.id,inputVersion:retry.categoryContext.inputVersion,candidateSnapshotSha256:retry.categoryContext.candidateSnapshotSha256,continuedAt:date(scope(retry.productId).explicitContinueAt)};
 write(db,operation,addCategoryRepair(operation,claim));for(const prior of priors)if(categoryFailureKind(db,directory,prior)==='FORBIDDEN')claimConfirmedForbiddenRetry(db,prior,retry,'category:'+operation.id+':'+claim.phase);
}
function originalExpansionResult(db:DatabaseSync,directory:string,productId:string,expansion:CategoryExpansionOperation):{call:AiCall;result:AiResult} {
 const c=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(expansion.originalCallId),r=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(expansion.originalDecisionId);if(!c||!r)blocked('CATEGORY_EXPANSION_ORIGINAL_REQUIRED');
 const call=validateAiCall(JSON.parse(String(c.record_json))),result=validateStoredAiResult(JSON.parse(String(r.record_json)));assertReceiptRecovery(db,directory,result,call);
 if(call.productId!==productId||!resultHasOwner(result,call)||call.categoryContext?.version!==2||call.categoryContext.expansion!==0||call.categoryContext.inputVersion!==expansion.inputVersion||call.categoryContext.candidateSnapshotSha256!==expansion.fromCandidateSnapshotSha256||result.output.kind!=='category-decision'||result.output.phase!==call.categoryContext.phase||result.output.selection?.outcome!=='NO_SUITABLE'||result.output.selection.candidateSnapshotSha256!==expansion.fromCandidateSnapshotSha256||expansion.claimedAt<result.createdAt)blocked('CATEGORY_EXPANSION_ORIGINAL_REQUIRED');return{call,result};
}
export function reserveCategoryExpansion(db:DatabaseSync,directory:string,productId:string,claim:CategoryExpansionOperation):CategoryOperationRecord {
 return transaction(db,()=>{scope(productId);const operation=readCategoryOperation(db,productId),next=addCategoryExpansion(operation,claim);originalExpansionResult(db,directory,productId,next.expansion);write(db,operation,next);return next;});
}
export function permitCategoryExpansionRequest(db:DatabaseSync,directory:string,productId:string,requestId:string,at:string):CategoryOperationRecord {
 return transaction(db,()=>{scope(productId);const operation=readCategoryOperation(db,productId),next=permitCategoryExpansion(operation,uuid(requestId),date(at));originalExpansionResult(db,directory,productId,next.expansion);write(db,operation,next);return next;});
}
export function storeCategoryExpansionSnapshot(db:DatabaseSync,directory:string,productId:string,snapshot:CategoryExpansionSnapshot):CategoryOperationRecord {
 return transaction(db,()=>{const operation=readCategoryOperation(db,productId),next=completeCategoryExpansion(operation,snapshot);originalExpansionResult(db,directory,productId,next.expansion);if(listingFingerprint(operation)!==listingFingerprint(next))write(db,operation,next);return next;});
}
/** Exact input and actual candidate bytes are required again before an expanded paid choice. */
export function assertCategoryExpansionReady(db:DatabaseSync,directory:string,productId:string,inputVersion:string,candidateSnapshotSha256:string):CategoryExpansionSnapshot {
 const operation=readCategoryOperation(db,productId),expansion=operation.expansion;
 if(!expansion?.snapshot||expansion.inputVersion!==inputVersion||expansion.snapshot.candidateSnapshotSha256!==candidateSnapshotSha256)blocked('CATEGORY_EXPANSION_ORIGINAL_REQUIRED');originalExpansionResult(db,directory,productId,expansion);return structuredClone(expansion.snapshot);
}
export function retainCategoryOperations(current:DatabaseSync,snapshot:DatabaseSync):void {
 if(!present(current))return;if(!present(snapshot)||!snapshot.isTransaction)blocked('CATEGORY_OPERATION_TRANSACTION_REQUIRED');
 for(const row of current.prepare('SELECT id,record_json FROM ai_category_operations').all()){
  const incoming=parseJson(current,String(row.record_json));if(incoming.id!==row.id)blocked('CATEGORY_OPERATION_RECORD_INVALID');const previous=readCategoryOperation(snapshot,incoming.productId),merged=mergeCategoryOperations(previous,incoming);if(listingFingerprint(previous)!==listingFingerprint(merged))write(snapshot,previous,merged);
 }
}
