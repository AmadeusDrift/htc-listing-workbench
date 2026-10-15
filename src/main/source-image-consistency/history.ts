import {canRetryConfirmedForbidden,claimConfirmedForbiddenRetry} from '../ai/confirmed-forbidden-retry.ts';
import { taskAiContext } from '../ai/batch/task-context.ts';
import { confirmedAuthenticationRejection,confirmedForbiddenRejection } from '../ai/receipts.ts';
import { isGenerationProvider } from "../ai/primitives.ts";
import type { DatabaseSync } from 'node:sqlite';
import type { AiResult,AiCall } from '../../shared/ai-contracts.ts';
import { createHash,randomUUID } from 'node:crypto';
import type { SourceConsistencyContext,SourceConsistencyConclusion,SourceConsistencyOutput } from '../../shared/source-image-consistency-contracts.ts';
import { SOURCE_CONSISTENCY_VERSION,SOURCE_OBSERVATION_VERSION } from '../../shared/source-image-consistency-contracts.ts';
import { keys, uuid, date, boundedText, sha256 } from "../ai/primitives.ts";
import { validateAiCall, validateStoredAiResult } from "../ai/validation.ts";
import { listingFingerprint } from "../json-fingerprint.ts";
import { readManagedImageSync } from '../ai/source.ts';
import { validateSourceImageProvenance,assertSourceImageProvenance } from '../source-image-provenance.ts';
import { assertUnambiguousRecordJson } from '../record-json.ts';
import { readSourceImageReceipt,sourceImageMappings } from '../source-images.ts';
import { validateAiUsageRecord } from '../ai/usage.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { validateConsistencyContext, consistencyScopeKey, consistencyDecisionKey } from "./contracts.ts";
import { assertConsistencyOutput,reduceSourceConsistency,normalizeSourceObservations } from './comparison.ts';
import { assertSourceReceiptRecovery, assertSourceRecoveryOwner } from './receipt-recovery.ts';
import { sourceReferenceAliasesForCall } from './reference-aliases.ts';

export const CONSISTENCY_TABLES={source_consistency_attempts:['id','record_json'],source_consistency_assessments:['id','record_json'],source_consistency_decisions:['id','record_json'],source_consistency_bindings:['id','record_json']};
export const CONSISTENCY_SCHEMA=Object.keys(CONSISTENCY_TABLES).map(table=>`CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)`);
export interface ConsistencyAttempt {version:typeof SOURCE_CONSISTENCY_VERSION;id:string;context:SourceConsistencyContext;callId:string;sentAt:string;attemptNumber?:number}
export interface ConsistencyRecovery {source:'local-diagnostic';version:typeof SOURCE_OBSERVATION_VERSION;rawOutput:unknown;rawOutputSha256:string;output:SourceConsistencyOutput}
export interface ConsistencyAssessment extends SourceConsistencyConclusion {version:typeof SOURCE_CONSISTENCY_VERSION;id:string;context:SourceConsistencyContext;callId:string;resultId:string|null;createdAt:string;recovery?:ConsistencyRecovery}
export interface ConsistencyDecision {version:typeof SOURCE_CONSISTENCY_VERSION;id:string;context:SourceConsistencyContext;fingerprint:string;assessmentId:string|null;decision:'CONFIRMED'|'CORRECTION_NEEDED';reason:string;createdAt:string}
const invalid=():never=>{throw new UserFacingError('来源图片一致性历史不完整或已变化');};
function version(o:Record<string,unknown>){if(o.version!==SOURCE_CONSISTENCY_VERSION)invalid();}
export function validateConsistencyAttempt(raw:unknown):ConsistencyAttempt {
  const o=keys(raw,['version','id','context','callId','sentAt'],['attemptNumber']);version(o);const context=validateConsistencyContext(o.context),id=sha256(o.id);const n=o.attemptNumber===undefined?1:Number(o.attemptNumber);if(!Number.isInteger(n)||n<1||n>MAX_SOURCE_ATTEMPTS||o.attemptNumber!==undefined&&(typeof o.attemptNumber!=='number'||n===1)||id!==consistencyAttemptId(context,n))invalid();
  return{version:SOURCE_CONSISTENCY_VERSION,id,context,callId:uuid(o.callId),sentAt:date(o.sentAt),...(o.attemptNumber===undefined?{}:{attemptNumber:n})};
}
export function validateConsistencyAssessment(raw:unknown):ConsistencyAssessment {
  const o=keys(raw,['version','id','context','callId','resultId','createdAt','decision','reasons'],['recovery']);version(o);
  if(!['MATCH','MISMATCH','UNCERTAIN'].includes(String(o.decision))||!Array.isArray(o.reasons)||!o.reasons.length||o.reasons.length>405)invalid();
  const context=validateConsistencyContext(o.context);let recovery:ConsistencyRecovery|undefined;
  if(o.recovery!==undefined){
    const r=keys(o.recovery,['source','version','rawOutput','rawOutputSha256','output']);
    if(r.source!=='local-diagnostic'||r.version!==SOURCE_OBSERVATION_VERSION||o.resultId!==null||Buffer.byteLength(JSON.stringify(r.rawOutput))>16*1024*1024||listingFingerprint(r.rawOutput)!==r.rawOutputSha256)invalid();
    const output=normalizeSourceObservations(r.rawOutput,context);if(listingFingerprint(output)!==listingFingerprint(r.output))invalid();
    recovery={source:'local-diagnostic',version:SOURCE_OBSERVATION_VERSION,rawOutput:r.rawOutput,rawOutputSha256:sha256(r.rawOutputSha256),output};
  }
  return{version:SOURCE_CONSISTENCY_VERSION,id:uuid(o.id),context,callId:uuid(o.callId),resultId:recovery?null:uuid(o.resultId),createdAt:date(o.createdAt),decision:o.decision as ConsistencyAssessment['decision'],reasons:(o.reasons as unknown[]).map(r=>boundedText(r,300)),...(recovery?{recovery}:{})};
}
export function validateConsistencyDecision(raw:unknown):ConsistencyDecision {
  const o=keys(raw,['version','id','context','fingerprint','assessmentId','decision','reason','createdAt']);version(o);
  const context=validateConsistencyContext(o.context);if(!['CONFIRMED','CORRECTION_NEEDED'].includes(String(o.decision))||o.fingerprint!==consistencyDecisionKey(context))invalid();
  return{version:SOURCE_CONSISTENCY_VERSION,id:uuid(o.id),context,fingerprint:sha256(o.fingerprint),assessmentId:o.assessmentId===null?null:uuid(o.assessmentId),decision:o.decision as ConsistencyDecision['decision'],reason:boundedText(o.reason,1000),createdAt:date(o.createdAt)};
}
export function validateConsistencyBinding(raw:unknown){
  const o=keys(raw,['version','id','productId','variantId','assetId','createdAt']);version(o);
  return{version:SOURCE_CONSISTENCY_VERSION,id:uuid(o.id),productId:uuid(o.productId),variantId:uuid(o.variantId),assetId:uuid(o.assetId),createdAt:date(o.createdAt)};
}
export const CONSISTENCY_VALIDATORS={source_consistency_attempts:validateConsistencyAttempt,source_consistency_assessments:validateConsistencyAssessment,source_consistency_decisions:validateConsistencyDecision,source_consistency_bindings:validateConsistencyBinding};
/** Caller owns the existing mutation transaction; no changes to variant_assets semantics. */
export function recordConsistencyBinding(db:DatabaseSync,productId:string,variantId:string,assetId:string):void {
  const record=validateConsistencyBinding({version:SOURCE_CONSISTENCY_VERSION,id:randomUUID(),productId,variantId,assetId,createdAt:new Date().toISOString()});
  db.prepare('INSERT INTO source_consistency_bindings VALUES(?,?)').run(record.id,JSON.stringify(record));
}
export const MAX_SOURCE_ATTEMPTS=3;
function consistencyAttemptId(context:SourceConsistencyContext,n:number):string {return n===1?consistencyScopeKey(context):createHash('sha256').update(`${consistencyScopeKey(context)}:attempt:${n}`).digest('hex');}
/** Append-only records, including legacy scope-key records. Never reset paid history. */
export function listConsistencyAttempts(db:DatabaseSync,context:SourceConsistencyContext):ConsistencyAttempt[] {
  return rows(db,'source_consistency_attempts',validateConsistencyAttempt).filter(a=>consistencyScopeKey(a.context)===consistencyScopeKey(context)).sort((a,b)=>(a.attemptNumber??1)-(b.attemptNumber??1));
}
export function latestConsistencyAttempt(db:DatabaseSync,context:SourceConsistencyContext):ConsistencyAttempt|undefined {return listConsistencyAttempts(db,context).at(-1);}
/** OUTPUT_INVALID is also used for empty/interrupted HTTP bodies: the code alone proves nothing. */
export function consistencyAttemptUnknown(db:DatabaseSync,attempt:ConsistencyAttempt):boolean {
 const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(attempt.callId),call=row?validateAiCall(JSON.parse(String(row.record_json))):null;
 if(!call||call.id!==attempt.callId||call.productId!==attempt.context.productId||call.productRevision!==attempt.context.productRevision||call.startedAt!==attempt.sentAt||listingFingerprint(call.sourceConsistencyContext)!==listingFingerprint(attempt.context))return true;
 for(const resultRow of db.prepare("SELECT record_json FROM ai_results WHERE json_extract(record_json,'$.callId')=?").all(call.id)){
   const result=validateStoredAiResult(JSON.parse(String(resultRow.record_json)));
   if(result.output.kind==='source-image-consistency'&&result.providerReceiptRecovery){assertSourceReceiptRecovery(db,undefined,result,call);return false;}
 }
 if(call.status==='SUCCEEDED'||confirmedAuthenticationRejection(db,call)||confirmedForbiddenRejection(db,call))return false;
 if(call.status!=='FAILED'||call.errorCode!=='OUTPUT_INVALID')return true;
 if(call.responseReceived===true)return false;
 // Legacy diagnostics may predate responseReceived. Only a validated local recovery
 // establishes usable original content; missing/null metadata never clears the guard.
 return !rows(db,'source_consistency_assessments',validateConsistencyAssessment).some(a=>a.callId===call.id&&a.recovery&&listingFingerprint(a.context)===listingFingerprint(call.sourceConsistencyContext));
}
/** Model changes alone do not authorize a new request. Credentials must have been explicitly saved. */
export function canRetryConsistencyAuthentication(db:DatabaseSync,prior:AiCall,current:{providerId:string;generation:number}):boolean {
 const scope=taskAiContext.getStore();
 if(current.providerId===prior.providerId&&prior.sourceConsistencyContext&&canRetryConfirmedForbidden(db,prior,'source:'+consistencyScopeKey(prior.sourceConsistencyContext)))return true;
 if(!scope?.explicitContinueAt||!Number.isFinite(Date.parse(scope.explicitContinueAt))||!scope.authorize()||!confirmedAuthenticationRejection(db,prior)||current.providerId!==prior.providerId||current.generation<=prior.generation)return false;
 const events=db.prepare("SELECT action,detail_json,created_at FROM audit_events WHERE action IN ('ai.credentials.updated','ai.connection.saved','ai.connection.imported')").all();
 return events.some(row=>{
  try {const detail=JSON.parse(String(row.detail_json));if(detail.changed===false)return false;
   if(row.action!=='ai.credentials.updated'&&events.some(other=>{if(other.action!=='ai.credentials.updated')return false;const newer=JSON.parse(String(other.detail_json));return newer.profiles?.some((p:any)=>detail.profiles?.some((old:any)=>old.id===p.id&&old.generation===p.generation));}))return false;
   return Date.parse(String(row.created_at))>=Date.parse(prior.finishedAt??prior.startedAt)&&Date.parse(String(row.created_at))<=Date.parse(scope.explicitContinueAt!)&&Array.isArray(detail.profiles)&&detail.profiles.some((p:any)=>p.id===current.providerId&&p.changed!==false&&Number.isInteger(p.generation)&&p.generation>prior.generation&&p.generation<=current.generation);}catch{return false;}
 });
}
/** Called only in AiUsageLedger.reserve's transaction, before the transport sends bytes. */
export function reserveConsistencyAttempt(db:DatabaseSync,context:SourceConsistencyContext,call:{id:string;startedAt:string;providerId?:string;generation?:number}):void {
  const attempts=listConsistencyAttempts(db,context),latest=attempts.at(-1),n=(latest?.attemptNumber??(latest?1:0))+1;
  if(attempts.some(attempt=>consistencyAttemptUnknown(db,attempt)))invalid();
  if(latest){const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(latest.callId),prior=row?validateAiCall(JSON.parse(String(row.record_json))):null;const usageRow=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(latest.callId),usage=usageRow?validateAiUsageRecord(JSON.parse(String(usageRow.record_json))):null;if(!prior||!usage||prior.id!==latest.callId||usage.id!==prior.id||usage.providerId!==prior.providerId||usage.startedAt!==prior.startedAt||!isGenerationProvider(prior.providerId)||prior.productId!==latest.context.productId||prior.productRevision!==latest.context.productRevision||prior.startedAt!==latest.sentAt||listingFingerprint(prior.sourceConsistencyContext)!==listingFingerprint(latest.context)||prior.status!=='FAILED'||!(prior.errorCode==='OUTPUT_INVALID'||call.providerId!==undefined&&call.generation!==undefined&&canRetryConsistencyAuthentication(db,prior,{providerId:call.providerId,generation:call.generation}))||n>MAX_SOURCE_ATTEMPTS)invalid();}
  if(latest){const prior=validateAiCall(JSON.parse(String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(latest.callId)!.record_json)));if(confirmedForbiddenRejection(db,prior))claimConfirmedForbiddenRetry(db,prior,{...call,productId:context.productId},'source:'+consistencyScopeKey(context));}
  const record=validateConsistencyAttempt({version:SOURCE_CONSISTENCY_VERSION,id:consistencyAttemptId(context,n),context,callId:call.id,sentAt:call.startedAt,...(n>1?{attemptNumber:n}:{})});
  db.prepare('INSERT INTO source_consistency_attempts VALUES(?,?)').run(record.id,JSON.stringify(record));
}
/** Same transaction as successful call/result. Also recovers a historical saved result locally. */
export function recordConsistencyAssessment(db:DatabaseSync,result:AiResult):ConsistencyAssessment {
  if(result.output.kind!=='source-image-consistency'||!result.sourceConsistencyContext)invalid();
  const existing=db.prepare("SELECT record_json FROM source_consistency_assessments WHERE json_extract(record_json,'$.resultId')=?").get(result.id);
  if(existing)return validateConsistencyAssessment(JSON.parse(String(existing.record_json)));
  const context=result.sourceConsistencyContext!;assertConsistencyOutput(result.output as import('../../shared/source-image-consistency-contracts.ts').SourceConsistencyOutput,context);
  const record=validateConsistencyAssessment({version:SOURCE_CONSISTENCY_VERSION,id:randomUUID(),context,callId:result.callId,resultId:result.id,createdAt:result.createdAt,...reduceSourceConsistency(context,result.output as import('../../shared/source-image-consistency-contracts.ts').SourceConsistencyOutput)});
  db.prepare('INSERT INTO source_consistency_assessments VALUES(?,?)').run(record.id,JSON.stringify(record));return record;
}
/** Stores a new interpretation, not an ai_result. The paid FAILED call and its ledger remain untouched. */
export function recordRecoveredConsistency(db:DatabaseSync,call:AiCall,rawOutput:unknown):ConsistencyAssessment {
  if(call.status!=='FAILED'||call.errorCode!=='OUTPUT_INVALID'||!call.sourceConsistencyContext)invalid();
  sourceReferenceAliasesForCall(call);
  const existing=db.prepare("SELECT record_json FROM source_consistency_assessments WHERE json_extract(record_json,'$.callId')=?").get(call.id);
  if(existing)return validateConsistencyAssessment(JSON.parse(String(existing.record_json)));
  const context=call.sourceConsistencyContext!,output=normalizeSourceObservations(rawOutput,context);
  const record=validateConsistencyAssessment({version:SOURCE_CONSISTENCY_VERSION,id:randomUUID(),context,callId:call.id,resultId:null,createdAt:new Date().toISOString(),...reduceSourceConsistency(context,output),recovery:{source:'local-diagnostic',version:SOURCE_OBSERVATION_VERSION,rawOutput,rawOutputSha256:listingFingerprint(rawOutput),output}});
  db.prepare('INSERT INTO source_consistency_assessments VALUES(?,?)').run(record.id,JSON.stringify(record));return record;
}
function rows<T>(db:DatabaseSync,table:string,validate:(raw:unknown)=>T & {id:string}):(T & {id:string})[]{
  assertUnambiguousRecordJson(db,table);return db.prepare(`SELECT id,record_json FROM ${table}`).all().map(row=>{const record=validate(JSON.parse(String(row.record_json)));if(record.id!==row.id)invalid();return record;});
}
/** Tombstones deliberately need no product, anchor, result or positive assessment after older restores. */
export function retainConsistencyAttempts(current:DatabaseSync,snapshot:DatabaseSync):void {
  if(!current.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_consistency_attempts'").get())return;
  if(!snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_consistency_attempts'").get()){
    // Restore migrates the snapshot before retaining safety records.
    invalid();
  }
  for(const record of rows(current,'source_consistency_attempts',validateConsistencyAttempt)){
    const old=snapshot.prepare('SELECT record_json FROM source_consistency_attempts WHERE id=?').get(record.id);
    if(old){if(listingFingerprint(validateConsistencyAttempt(JSON.parse(String(old.record_json))))!==listingFingerprint(record))invalid();}
    else snapshot.prepare('INSERT INTO source_consistency_attempts VALUES(?,?)').run(record.id,JSON.stringify(record));
  }
}
function historicalAssets(db:DatabaseSync,context:SourceConsistencyContext,directory?:string){
  const owner=db.prepare('SELECT product_id FROM variants WHERE id=?').get(context.variantId);if(owner&&owner.product_id!==context.productId)invalid();
  if(context.identity.kind!=='local-original'){
    const identity=context.identity,source=readSourceImageReceipt(db,context.productId);
    if(!source||source.kind!==identity.kind||source.receipt.id!==identity.receiptId||source.receipt.fingerprint!==identity.receiptFingerprint||!sourceImageMappings(source).some(m=>m.localVariantId===context.variantId&&m.sourceSku===identity.sourceSku))invalid();
    const rawFields:import('../../shared/source-image-consistency-contracts.ts').SourceClaimField[]=[];
    if(source!.kind==='native1688'){
      const sku=source!.receipt.snapshot.skus.find(s=>s.providerSkuId===identity.sourceSku);if(!sku)invalid();
      rawFields.push({id:'receipt.originalSpec',name:'spec',value:sku!.originalSpec},...sku!.attributes.map((a,i)=>({id:`receipt.attributes.${i}`,name:a.name,value:a.value})));
    }else if(source!.kind==='miaoshou'){
      const mapping=source!.receipt.mapping.skus.find(m=>m.sourceKey===identity.sourceSku);if(!mapping)invalid();
      for(const d of source!.receipt.snapshot.dimensions){const v=d.values.find(v=>v.id===mapping!.dimensions[d.id]);if(v)rawFields.push({id:`receipt.dimensions.${d.id}`,name:d.name,value:v.name});}
    }
    if(listingFingerprint(rawFields)!==listingFingerprint(context.fields.filter(f=>f.id.startsWith('receipt.'))))invalid();
  }
  return context.referenceAssets.map(ref=>{
    const a=db.prepare('SELECT * FROM assets WHERE id=?').get(ref.assetId);
    if(!a||a.product_id!==context.productId||a.sha256!==ref.sha256||a.byte_size!==ref.byteSize||!['image/png','image/jpeg'].includes(String(a.mime_type))||a.original_path!==`assets/${ref.assetId}.${a.mime_type==='image/png'?'png':'jpg'}`)invalid();
    if(ref.source==='receipt-image'&&context.identity.kind!=='local-original'){
      const row=db.prepare('SELECT record_json FROM source_image_provenance WHERE id=?').get(ref.anchorId!);if(!row)invalid();
      const anchor=validateSourceImageProvenance(JSON.parse(String(row!.record_json)));
      if(anchor.receiptId!==context.identity.receiptId||anchor.receiptFingerprint!==context.identity.receiptFingerprint||anchor.receiptKind!==context.identity.kind||anchor.imageId!==ref.imageId||anchor.assetId!==ref.assetId||!anchor.mappings.some(m=>m.localVariantId===context.variantId&&m.sourceSku===('sourceSku' in context.identity?context.identity.sourceSku:null)))invalid();
      assertSourceImageProvenance(db,anchor,directory);
    }
    if(directory)readManagedImageSync(directory,{id:ref.assetId,productId:context.productId,fileName:String(a!.file_name),mimeType:String(a!.mime_type),width:Number(a!.width),height:Number(a!.height),sha256:ref.sha256,byteSize:ref.byteSize,originalPath:String(a!.original_path),previewPath:String(a!.preview_path)});
    return{relativePath:String(a!.original_path),sha256:ref.sha256,byteSize:ref.byteSize};
  });
}
export function assertConsistencyHistory(db:DatabaseSync,directory?:string,receiptDirectory=directory):{relativePath:string;sha256:string;byteSize:number}[]{
  for(const table of Object.keys(CONSISTENCY_TABLES)){
    const columns=db.prepare(`PRAGMA table_xinfo(${table})`).all(),indexes=db.prepare(`PRAGMA index_list(${table})`).all();
    const shape=db.prepare('PRAGMA table_list').all().find(r=>r.name===table&&r.schema==='main');
    if(!shape||shape.type!=='table'||shape.wr!==0||shape.strict!==0||indexes.length!==1||indexes[0].partial!==0)invalid();
    const index=db.prepare(`PRAGMA index_xinfo('${String(indexes[0].name).replaceAll("'","''")}')`).all();
    if(index.length!==2||index[0].cid!==0||index[0].name!=='id'||index[0].desc!==0||index[0].coll!=='BINARY'||index[0].key!==1||index[1].cid!==-1||index[1].key!==0)invalid();
    if(columns.length!==2||columns.some(c=>!['id','record_json'].includes(String(c.name))||c.type!=='TEXT'||c.notnull!==1||c.pk!==(c.name==='id'?1:0)||c.hidden!==0||c.dflt_value!==null)||indexes.length!==1||indexes[0].origin!=='pk'||indexes[0].unique!==1||db.prepare(`PRAGMA foreign_key_list(${table})`).all().length)invalid();
  }
  const attempts=rows(db,'source_consistency_attempts',validateConsistencyAttempt),assessments=rows(db,'source_consistency_assessments',validateConsistencyAssessment),decisions=rows(db,'source_consistency_decisions',validateConsistencyDecision);
  for(const a of attempts){const n=a.attemptNumber??1;if(n>1&&!attempts.some(prior=>consistencyScopeKey(prior.context)===consistencyScopeKey(a.context)&&(prior.attemptNumber??1)===n-1))invalid();}
  for(const binding of rows(db,'source_consistency_bindings',validateConsistencyBinding)){
    const asset=db.prepare('SELECT product_id FROM assets WHERE id=?').get(binding.assetId),variant=db.prepare('SELECT product_id FROM variants WHERE id=?').get(binding.variantId);
    if(!asset||asset.product_id!==binding.productId||variant&&variant.product_id!==binding.productId)invalid();
  }
  const artifacts:{relativePath:string;sha256:string;byteSize:number}[]=[];
  for(const a of assessments){
    const callRow=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(a.callId);
    if(!callRow)invalid();const call=validateAiCall(JSON.parse(String(callRow!.record_json)));
    if(a.recovery){
      const attempt=attempts.find(t=>consistencyScopeKey(t.context)===consistencyScopeKey(a.context)&&t.callId===a.callId);
      if(!attempt||call.id!==a.callId||call.status!=='FAILED'||call.errorCode!=='OUTPUT_INVALID'||call.productId!==a.context.productId||call.productRevision!==a.context.productRevision||attempt.sentAt!==call.startedAt||listingFingerprint(call.sourceConsistencyContext)!==listingFingerprint(a.context)||listingFingerprint(attempt.context)!==listingFingerprint(a.context))invalid();
      const reduced=reduceSourceConsistency(a.context,a.recovery.output);
      if(a.decision!==reduced.decision||listingFingerprint(a.reasons)!==listingFingerprint(reduced.reasons))invalid();
      artifacts.push(...historicalAssets(db,a.context,directory));continue;
    }
    const resultRow=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(a.resultId);
    if(!resultRow)invalid();const result=validateStoredAiResult(JSON.parse(String(resultRow!.record_json)));
    const context=result.sourceConsistencyContext,attempt=attempts.find(t=>consistencyScopeKey(t.context)===consistencyScopeKey(a.context)&&t.callId===a.callId);
    if(!attempt||listingFingerprint(call.sourceConsistencyContext)!==listingFingerprint(a.context)||listingFingerprint(attempt.context)!==listingFingerprint(a.context)||call.productRevision!==a.context.productRevision||attempt.sentAt!==call.startedAt)invalid();
    if(result.providerReceiptRecovery){assertSourceRecoveryOwner(result,call);if(receiptDirectory)assertSourceReceiptRecovery(db,receiptDirectory,result,call);}
    if(result.id!==a.resultId||result.callId!==a.callId||call.id!==a.callId||(!result.providerReceiptRecovery&&(call.status!=='SUCCEEDED'||call.finishedAt!==a.createdAt))||call.productId!==a.context.productId||result.createdAt!==a.createdAt||result.providerId!==call.providerId||result.model!==call.model||listingFingerprint(context)!==listingFingerprint(a.context)||!attempts.some(t=>consistencyScopeKey(t.context)===consistencyScopeKey(a.context)&&t.callId===a.callId))invalid();
    if((result.output.kind as string)!=='source-image-consistency')invalid();
    const output=result.output as unknown as import('../../shared/source-image-consistency-contracts.ts').SourceConsistencyOutput;
    assertConsistencyOutput(output,a.context);const reduced=reduceSourceConsistency(a.context,output);
    if(a.decision!==reduced.decision||listingFingerprint(a.reasons)!==listingFingerprint(reduced.reasons))invalid();
    artifacts.push(...historicalAssets(db,a.context,directory));
  }
  for(const d of decisions){if(d.assessmentId!==null&&!assessments.some(a=>a.id===d.assessmentId&&consistencyScopeKey(a.context)===consistencyScopeKey(d.context)))invalid();artifacts.push(...historicalAssets(db,d.context,directory));}
  return artifacts;
}
