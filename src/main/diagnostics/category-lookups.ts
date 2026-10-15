import type {DatabaseSync} from 'node:sqlite';
import type {RunCallReport,RunCategoryLookupReport} from '../../shared/run-report-contracts.ts';
import type {ClassificationReference} from './classification-references.ts';
import type {CategoryOperationRecord} from '../../shared/category-operation-contracts.ts';
import type {RequestCertainty} from '../../shared/run-evidence-contracts.ts';
import {parseCategoryOperation} from '../ai/category-operation-records.ts';
import {readErrorEvidence} from '../error-evidence.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {evidenceId} from './run-evidence.ts';
interface Item {key:string;productId:string;sku:string}
interface TaskScope {id:unknown;targetId:unknown;sellerId:unknown;marketplaceId:unknown;locale:unknown;mode:unknown}
function invalid():never{throw new UserFacingError('RUN_REPORT_INVALID_RECORD');}
/** Read persisted M07 GET ownership, never trigger receipt recovery or HTTP.
 * The capture proof is a saved DB commitment; private file bytes are not read.
 */
export function categoryLookups(db:DatabaseSync,task:TaskScope,items:Item[],calls:RunCallReport[],classification:ClassificationReference[]):RunCategoryLookupReport[]{
  const operations=new Map<string,{record:CategoryOperationRecord;keys:Set<string>;certainty:RequestCertainty|null}>();
  const load=(operationId:string)=>{
    const existing=operations.get(operationId);if(existing)return existing;
    const row=db.prepare('SELECT id,record_json FROM ai_category_operations WHERE id=?').get(operationId);if(!row)return null;
    let record:CategoryOperationRecord;try{record=parseCategoryOperation(JSON.parse(String(row.record_json)));}catch{invalid();}
    if(record.id!==row.id)invalid();const bound={record,keys:new Set<string>(),certainty:null as RequestCertainty|null};operations.set(record.id,bound);return bound;
  };
  const bind=(operationId:string,item:Item)=>{
    const owner=load(operationId);if(!owner)return null;
    if(owner.record.productId!==item.productId)invalid();owner.keys.add(item.key);return owner;
  };
  const callContext=(callId:string)=>db.prepare("SELECT json_extract(record_json,'$.productId') productId,json_extract(record_json,'$.categoryContext.version') version,json_extract(record_json,'$.categoryContext.operationId') operationId,json_extract(record_json,'$.categoryContext.expansion') expansion,json_extract(record_json,'$.categoryContext.inputVersion') inputVersion,json_extract(record_json,'$.categoryContext.candidateSnapshotSha256') candidateSnapshotSha256 FROM ai_calls WHERE id=?").get(callId);
  for(const call of calls){
    const context=callContext(call.callId);if(!context||context.version!==2||!evidenceId(context.operationId))continue;
    const exact=new Set([...(call.itemKey?[call.itemKey]:[]),...classification.filter(ref=>ref.callId===call.callId).map(ref=>ref.item.key)]);
    for(const key of exact){const item=items.find(i=>i.key===key);if(!item||context.productId!==item.productId)invalid();bind(context.operationId,item);}
  }
  // A task that reuses all AI phases may have no new call event. Its original
  // GET error request ID plus exact current task item can still prove ownership.
  for(const row of db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed' AND json_valid(detail_json) AND json_extract(detail_json,'$.taskId')=? ORDER BY rowid").all(String(task.id))){
    if(typeof row.detail_json!=='string'||row.detail_json.length>8192)continue;
    let error;try{error=readErrorEvidence(JSON.parse(row.detail_json));}catch{continue;}
    if(!error?.requestId)continue;
    const item=error.itemKey?items.find(i=>i.key===error.itemKey):error.sku?items.find(i=>i.sku===error.sku):undefined;if(!item)continue;
    if(error.sku!==undefined&&error.sku!==item.sku||error.productId!==undefined&&error.productId!==item.productId)invalid();
    for(const op of db.prepare("SELECT id FROM ai_category_operations WHERE json_valid(record_json) AND json_extract(record_json,'$.expansion.requestId')=?").all(error.requestId)){
      const owner=bind(String(op.id),item);if(!owner?.record.expansion||owner.record.expansion.requestId!==error.requestId||error.operationId&&error.operationId!==owner.record.id)invalid();
      owner.certainty=error.certainty??owner.certainty;
    }
  }
  const lookups:RunCategoryLookupReport[]=[];
  for(const {record,keys,certainty} of operations.values()){
    const e=record.expansion;if(!e||!keys.size)continue;const proof=e.captureProof,snapshot=e.snapshot;
    if(e.targetId!==task.targetId||proof&&(['sellerId','marketplaceId','locale','mode'] as const).some(key=>proof.targetScope[key]!==task[key]))invalid();
    const adoptedResultIds=classification.filter(ref=>keys.has(ref.item.key)).filter(ref=>{
      const c=callContext(ref.callId);return !!snapshot&&c?.operationId===record.id&&c.expansion===1&&c.inputVersion===e.inputVersion&&c.candidateSnapshotSha256===snapshot.candidateSnapshotSha256;
    }).map(ref=>ref.resultId);
    const scope=items.filter(i=>keys.has(i.key));
    lookups.push({operationId:record.id,requestId:e.requestId,itemKeys:scope.map(i=>i.key),skus:[...new Set(scope.map(i=>i.sku))],permittedAt:e.permittedAt,
      httpStatus:proof?.status??null,remoteRequestId:proof?.remoteRequestId&&!/\bsk-/i.test(proof.remoteRequestId)?proof.remoteRequestId:null,receivedAt:proof?.receivedAt??null,receivedBytes:proof?.byteSize??null,receiptSha256:proof?.receiptSha256??null,
      snapshotSaved:!!snapshot,snapshotSha256:snapshot?.sha256??null,candidateCount:snapshot?.candidates.length??null,adopted:adoptedResultIds.length>0,adoptedResultIds:[...new Set(adoptedResultIds)],certainty,receiptIntegrity:'SAVED_METADATA_ONLY',
      missing:[...(!proof?['CATEGORY_LOOKUP_CAPTURE_NOT_SAVED']:[]),...(!snapshot?['CATEGORY_LOOKUP_SNAPSHOT_NOT_SAVED']:[])]});
  }
  return lookups.sort((a,b)=>a.requestId.localeCompare(b.requestId));
}
