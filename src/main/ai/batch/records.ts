import type { DatabaseSync } from 'node:sqlite';
import type { BatchRecord,BatchItem,BatchOperation } from '../../../shared/ai-batch-contracts.ts';
import { UserFacingError } from '../../../shared/errors.ts';
import { validatePurposeSnapshot,reviewPurpose } from '../purpose-routing.ts';
import { validateAiUsageRecord } from '../usage.ts';
import { assertRecordTable } from '../../storage/record-table.ts';
import { listingFingerprint as hash } from '../../json-fingerprint.ts';
function canonical(value:any):any{return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;}
/** Batch-v1 hashes ignore JSON object key order; legacy listing hashes remain unchanged. */
export const batchFingerprint=(value:unknown)=>hash(canonical(value));
const listingFingerprint=batchFingerprint;

export const BATCH_TABLES={ai_batches:['id','record_json'],ai_batch_items:['id','record_json']};
export const REMOTE_STATUSES=['validating','in_progress','finalizing','completed','failed','expired','cancelling','cancelled'];
export const terminal=(status:string|null)=>status!==null&&['completed','failed','expired','cancelled'].includes(status);
export const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const remoteId=(v:unknown)=>typeof v==='string'&&/^batch_[a-zA-Z0-9_-]{1,190}$/.test(v);
export const invalid=(message='Batch身份或记录无效'):never=>{throw new UserFacingError(message);};
const timestamp=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const cost=(v:unknown)=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0;
function exact(raw:unknown,fields:string[]):Record<string,any>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join()!==[...fields].sort().join())return invalid();return raw as Record<string,any>;
}
const operationFields=['taskId','operationId','attempt','phase','inputFingerprint','schemaFingerprint','credentialScope','owner','purpose','body','references'];
export function validateOperation(raw:unknown):BatchOperation{
  const r=exact(raw,[...operationFields,...(raw!==null&&typeof raw==='object'&&Object.hasOwn(raw,'aiCallId')?['aiCallId']:[])]);
  if(r.aiCallId!==undefined&&!uuid(r.aiCallId))invalid();
  if(!uuid(r.taskId)||!uuid(r.operationId)||!Number.isSafeInteger(r.attempt)||r.attempt<1||r.attempt>1000||typeof r.phase!=='string'||!/^[-a-z_]{1,80}$/.test(r.phase)||![r.inputFingerprint,r.schemaFingerprint,r.credentialScope].every(sha)||!r.body||typeof r.body!=='object'||Array.isArray(r.body)||!Array.isArray(r.references)||r.references.length>16)invalid();
  validatePurposeSnapshot(r.purpose);
  exact(r.owner,['productId','productRevision','providerId','generation']);if(!uuid(r.owner.productId)||!Number.isSafeInteger(r.owner.productRevision)||r.owner.productRevision<1||!Number.isSafeInteger(r.owner.generation)||r.owner.generation<1||!['openrouter','openrouter-review'].includes(r.owner.providerId))invalid();
  if(r.owner.providerId!==(reviewPurpose(r.purpose.purposeId)?'openrouter-review':'openrouter'))invalid('Batch用途与预算归属不一致');
  for(const ref of r.references){exact(ref,['pinId','assetId','sha256','url','retainedUntil']);if(!uuid(ref.pinId)||!uuid(ref.assetId)||!sha(ref.sha256)||typeof ref.url!=='string'||ref.url.length>3000||!timestamp(ref.retainedUntil))invalid();}
  if(Buffer.byteLength(JSON.stringify(r.body))>4*1024*1024)invalid('单项Batch请求超过本地4MiB上限');
  return structuredClone(r) as BatchOperation;
}
export function validateBatch(raw:unknown):BatchRecord{
  const r=exact(raw,['version','id','taskId','phase','fingerprint','credentialScope','purpose','model','schemaFingerprint','itemIds','state','remoteBatchId','remoteStatus','locallyStopped','createdAt','submittedAt','updatedAt','receiptIds','reportedCostUsd','error']);
  validatePurposeSnapshot(r.purpose);
  if(r.version!==1||!uuid(r.id)||!uuid(r.taskId)||!sha(r.fingerprint)||!sha(r.credentialScope)||!sha(r.schemaFingerprint)||r.model!==r.purpose.model||!Array.isArray(r.itemIds)||!r.itemIds.length||r.itemIds.length>1000||!r.itemIds.every(uuid)||new Set(r.itemIds).size!==r.itemIds.length||!['prepared','submitting','submission_unknown','waiting','reconciled','failed'].includes(r.state)||r.remoteBatchId!==null&&!remoteId(r.remoteBatchId)||r.remoteStatus!==null&&!REMOTE_STATUSES.includes(r.remoteStatus)||typeof r.locallyStopped!=='boolean'||!timestamp(r.createdAt)||!timestamp(r.updatedAt)||r.submittedAt!==null&&!timestamp(r.submittedAt)||!Array.isArray(r.receiptIds)||!r.receiptIds.every(sha)||!cost(r.reportedCostUsd)||r.error!==null&&(typeof r.error!=='string'||r.error.length>2000))invalid();
  if(r.remoteStatus!==null&&r.remoteBatchId===null||r.state==='prepared'&&(r.submittedAt!==null||r.remoteBatchId!==null)||r.state==='reconciled'&&!terminal(r.remoteStatus))invalid();
  return structuredClone(r) as BatchRecord;
}
export function validateItem(raw:unknown):BatchItem{
  const r=exact(raw,[...operationFields,...(raw!==null&&typeof raw==='object'&&Object.hasOwn(raw,'aiCallId')?['aiCallId']:[]),'version','id','batchId','customId','state','receiptId','resultFingerprint','reportedCostUsd','adoption']);
  validateOperation({...Object.fromEntries(operationFields.map(k=>[k,r[k]])),...(r.aiCallId?{aiCallId:r.aiCallId}:{})});
  if(r.version!==1||!uuid(r.id)||!uuid(r.batchId)||r.customId!==r.id||!['prepared','waiting','received','failed','missing'].includes(r.state)||r.receiptId!==null&&!sha(r.receiptId)||r.resultFingerprint!==null&&!sha(r.resultFingerprint)||!cost(r.reportedCostUsd))invalid();
  if(r.adoption!==null){exact(r.adoption,['id','at']);if(r.state!=='received'||typeof r.adoption.id!=='string'||!r.adoption.id.length||r.adoption.id.length>200||!timestamp(r.adoption.at))invalid();}
  if(['received','failed'].includes(r.state)&&(!r.receiptId||!r.resultFingerprint))invalid();
  return structuredClone(r) as BatchItem;
}
export function readBatch(db:DatabaseSync,id:string):BatchRecord{
  if(!uuid(id))return invalid();const row=db.prepare('SELECT record_json FROM ai_batches WHERE id=?').get(id);if(!row)return invalid('Batch不存在');const value=validateBatch(JSON.parse(String(row.record_json)));if(value.id!==id)invalid();return value;
}
export function readItem(db:DatabaseSync,id:string):BatchItem{
  if(!uuid(id))return invalid();const row=db.prepare('SELECT record_json FROM ai_batch_items WHERE id=?').get(id);if(!row)return invalid('Batch项目不存在');const value=validateItem(JSON.parse(String(row.record_json)));if(value.id!==id)invalid();return value;
}
export function writeBatch(db:DatabaseSync,batch:BatchRecord){const r=validateBatch(batch);db.prepare('INSERT INTO ai_batches VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(r.id,JSON.stringify(r));}
export function writeItem(db:DatabaseSync,item:BatchItem){const r=validateItem(item);db.prepare('INSERT INTO ai_batch_items VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(r.id,JSON.stringify(r));}
export function assertBatchHistory(db:DatabaseSync){
  if(Number(db.prepare('PRAGMA user_version').get()!.user_version)<26)return;
  for(const name of Object.keys(BATCH_TABLES))assertRecordTable(db,name);
  const seen=new Set<string>(),remotes=new Set<string>();
  for(const row of db.prepare('SELECT id FROM ai_batches').iterate()){
    const batch=readBatch(db,String(row.id));if(batch.remoteBatchId){const scope=batch.credentialScope+':'+batch.remoteBatchId;if(remotes.has(scope))invalid();remotes.add(scope);}
    const operations:BatchOperation[]=[];
    for(const id of batch.itemIds){
      const item=readItem(db,id);if(seen.has(id)||item.batchId!==batch.id||item.taskId!==batch.taskId||item.phase!==batch.phase||item.purpose.model!==batch.model||item.credentialScope!==batch.credentialScope||item.schemaFingerprint!==batch.schemaFingerprint||listingFingerprint(item.purpose)!==listingFingerprint(batch.purpose))invalid();seen.add(id);
      operations.push({...Object.fromEntries(operationFields.map(k=>[k,(item as any)[k]])),...(item.aiCallId?{aiCallId:item.aiCallId}:{})} as unknown as BatchOperation);
      if(batch.submittedAt){const row=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(item.aiCallId??id);if(!row)return invalid('Batch预算账本缺失');const ledger=validateAiUsageRecord(JSON.parse(String(row.record_json)));if(ledger.id!==(item.aiCallId??id)||ledger.providerId!==item.owner.providerId)invalid('Batch预算归属不一致');}
      if(item.receiptId){const row=db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(item.receiptId);if(!row||JSON.parse(String(row.record_json)).callId!==id)invalid('Batch逐项收据归属缺失');}
    }
    if(listingFingerprint(operations)!==batch.fingerprint)invalid('Batch请求指纹不一致');
    for(const id of batch.receiptIds){const row=db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(id);if(!row||JSON.parse(String(row.record_json)).callId!==batch.id)invalid('Batch原始收据归属缺失');}
  }
  if(seen.size!==db.prepare('SELECT count(*) n FROM ai_batch_items').get()!.n)invalid();
}
