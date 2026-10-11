import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { SOURCE_CONSISTENCY_VERSION,SOURCE_OBSERVATION_VERSION } from '../../shared/source-image-consistency-contracts.ts';
import type { SourceConsistencyContext,SourceConsistencyView } from '../../shared/source-image-consistency-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { WorkspaceStore } from '../store.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { keys,uuid,integer,sha256,boundedText,validateAiCall,validateStoredAiResult } from '../ai/validation.ts';
import { resolveConsistencyContext,consistencyScopeKey,consistencyDecisionKey } from './scope.ts';
import { assertConsistencyHistory,validateConsistencyAssessment,validateConsistencyDecision,validateConsistencyAttempt } from './history.ts';

import { SourceConsistencyError } from './errors.ts';
import { normalizeSourceObservations,reduceSourceConsistency } from './comparison.ts';
export { SourceConsistencyError } from './errors.ts';
const NON_VISUAL_AUTHORITY=new Set(['RANDOM_OR_AMBIGUOUS_FULFILLMENT','RAW_NORMALIZED_CONFLICT','NEGATED_CLAIM']);
export function sourceConsistencyUnknown(db:DatabaseSync,productId:string,variantIds:string[]):boolean {
  for(const row of db.prepare("SELECT record_json FROM source_consistency_attempts WHERE json_extract(record_json,'$.context.productId')=?").all(productId)){
    const attempt=validateConsistencyAttempt(JSON.parse(String(row.record_json)));if(!variantIds.includes(attempt.context.variantId))continue;
    const callRow=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(attempt.callId),call=callRow?validateAiCall(JSON.parse(String(callRow.record_json))):null;
    if(!call||call.status!=='SUCCEEDED'&&call.errorCode!=='OUTPUT_INVALID')return true;
  }
  return false;
}
/** No send, reservation, recovery write, fact adoption or implicit confirmation. */
export function readConsistencyView(db:DatabaseSync,context:SourceConsistencyContext):SourceConsistencyView {
  assertConsistencyHistory(db);
  const fingerprint=consistencyDecisionKey(context),scope=consistencyScopeKey(context);
  const assessments=db.prepare('SELECT record_json FROM source_consistency_assessments ORDER BY rowid DESC').all().map(r=>validateConsistencyAssessment(JSON.parse(String(r.record_json))));
  const assessment=assessments.find(a=>consistencyScopeKey(a.context)===scope);
  const decisions=db.prepare('SELECT record_json FROM source_consistency_decisions ORDER BY rowid DESC').all().map(r=>validateConsistencyDecision(JSON.parse(String(r.record_json))));
  const human=decisions.find(d=>d.fingerprint===fingerprint);
  const row=db.prepare('SELECT record_json FROM source_consistency_attempts WHERE id=?').get(scope),attempt=row?validateConsistencyAttempt(JSON.parse(String(row.record_json))):null;
  let observations:SourceConsistencyView['observations']=null;
  if(assessment){if(assessment.recovery)observations=assessment.recovery.output;else{const r=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(assessment.resultId);const result=r?validateStoredAiResult(JSON.parse(String(r.record_json))):null;if(result?.output.kind==='source-image-consistency')observations=result.output;}}
  // Historical assessment decisions remain immutable; current v2 use merges their observations anew.
  if(observations&&context.version===SOURCE_OBSERVATION_VERSION)observations=normalizeSourceObservations(observations,context);
  const view:SourceConsistencyView={context,fingerprint,status:'PENDING',reasons:['SOURCE_CONSISTENCY_PENDING'],assessmentId:assessment?.id??null,observations,humanDecision:human?{decision:human.decision,reason:human.reason}:null};
  if(sourceConsistencyUnknown(db,context.productId,[context.variantId])){view.status='UNKNOWN';view.reasons=['SOURCE_CONSISTENCY_SENT_UNKNOWN'];return view;}
  if(attempt&&!assessment){
    const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(attempt.callId),call=row?validateAiCall(JSON.parse(String(row.record_json))):null;
    view.status=call?.errorCode==='OUTPUT_INVALID'?'SYSTEM_REPAIR':call?.status==='SUCCEEDED'?'PENDING':'UNKNOWN';view.reasons=[call?.errorCode==='OUTPUT_INVALID'?'SOURCE_CONSISTENCY_INVALID_OUTPUT':call?.status==='SUCCEEDED'?'SOURCE_CONSISTENCY_RECOVERY_REQUIRED':'SOURCE_CONSISTENCY_SENT_UNKNOWN'];return view;
  }
  if(context.version!==SOURCE_OBSERVATION_VERSION&&context.issues.some(r=>NON_VISUAL_AUTHORITY.has(r))){view.status='NEEDS_INPUT';view.reasons=context.issues;return view;}
  if(human){view.status=human.decision==='CONFIRMED'?'MANUAL':'NEEDS_INPUT';view.reasons=[human.decision==='CONFIRMED'?'HUMAN_VISUAL_ASSOCIATION_ONLY':'HUMAN_CORRECTION_REQUIRED'];return view;}
  if(assessment){const conclusion=context.version===SOURCE_OBSERVATION_VERSION&&observations?reduceSourceConsistency(context,observations):assessment;view.status=conclusion.decision==='MATCH'?'MATCH':'NEEDS_INPUT';view.reasons=conclusion.reasons;}
  return view;
}
export function assertConsistencyView(view:SourceConsistencyView):void {
  if(view.status==='MATCH'||view.status==='MANUAL')return;
  throw new SourceConsistencyError(view.status==='UNKNOWN'?'UNKNOWN':view.status==='SYSTEM_REPAIR'?'SYSTEM_REPAIR':'NEEDS_INPUT',view.status==='UNKNOWN'?'SOURCE_CONSISTENCY_SENT_UNKNOWN':view.status==='SYSTEM_REPAIR'?'SOURCE_CONSISTENCY_INVALID_OUTPUT':'SOURCE_CONSISTENCY_NEEDS_INPUT',view.status==='UNKNOWN'?'来源图片观察请求结果未知，已阻止自动重发，请核对调用记录':view.status==='SYSTEM_REPAIR'?'来源图片观察未通过格式或记录校验，请修复后核对':'当前来源图片与规格尚未确认一致，请逐 SKU 核对原图和原始规格');
}
/** Current-use evidence for schema filling. No product writes and no provider calls. */
export function readSourceObservationEvidence(db:DatabaseSync,context:SourceConsistencyContext):import('../../shared/source-image-consistency-contracts.ts').SourceObservationEvidence {
  const view=readConsistencyView(db,context);assertConsistencyView(view);
  const images=view.observations?.assets??[];
  const conflicts=context.claims.flatMap(claim=>{
    const observed=images.flatMap(asset=>asset.quality==='clear'&&asset.lighting==='neutral'&&asset.presentation==='single-product'?asset.claims.filter(c=>c.claimId===claim.id&&c.visibility==='visible'&&c.value!==claim.value).map(c=>({value:c.value!,assetId:asset.assetId})):[]);
    return observed.length?[{claimId:claim.id,fieldId:claim.fieldId,axis:claim.axis,sourceValue:claim.value,observedValues:[...new Set(observed.map(o=>o.value))],assetIds:[...new Set(observed.map(o=>o.assetId))]}]:[];
  });
  return {version:SOURCE_OBSERVATION_VERSION,variantId:context.variantId,assessmentId:view.assessmentId,sourceFields:context.fields,images,conflicts,reasons:view.reasons};
}
export async function saveConsistencyDecision(db:DatabaseSync,store:WorkspaceStore,directory:string,raw:unknown,checkpoint:()=>Promise<void>=async()=>{}):Promise<SourceConsistencyView>{
  const o=keys(raw,['productId','productRevision','variantId','fingerprint','decision','reason']);
  const input={productId:uuid(o.productId),productRevision:integer(o.productRevision,1,Number.MAX_SAFE_INTEGER),variantId:uuid(o.variantId)},fingerprint=sha256(o.fingerprint),reason=boundedText(o.reason,1000);
  if(!['CONFIRMED','CORRECTION_NEEDED'].includes(String(o.decision)))throw new UserFacingError('图片规格决定无效');
  const fresh=()=>{const context=resolveConsistencyContext(db,store,directory,input);if(consistencyDecisionKey(context)!==fingerprint)throw new UserFacingError('规格、图片或关联已变化，请重新核对');return context;};
  fresh();await checkpoint();
  db.exec('BEGIN IMMEDIATE');try{
    const context=fresh(),view=readConsistencyView(db,context);
    if(o.decision==='CONFIRMED'&&(view.status==='UNKNOWN'||context.version!==SOURCE_OBSERVATION_VERSION&&context.issues.some(r=>NON_VISUAL_AUTHORITY.has(r))))throw new UserFacingError('图片关联确认不能解决未知付费请求、随机供货或原始规格冲突，请先补充或更正对应资料');
    const decision=validateConsistencyDecision({version:SOURCE_CONSISTENCY_VERSION,id:randomUUID(),context,fingerprint,assessmentId:view.assessmentId,decision:o.decision,reason,createdAt:new Date().toISOString()});
    db.prepare('INSERT INTO source_consistency_decisions VALUES(?,?)').run(decision.id,JSON.stringify(decision));fresh();db.exec('COMMIT');return readConsistencyView(db,context);
  }catch(error){db.exec('ROLLBACK');throw error;}
}
/** Shared current-use guard for workflow approval, manual originals, upload and parent representatives. */
export function assertProductConsistency(db:DatabaseSync,product:ProductDetail,variantIds:string[]):void {
  const directory=dirname(String(db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file));
  const store:Pick<WorkspaceStore,'getProduct'|'getAssetRecord'>={getProduct:()=>product,getAssetRecord:id=>{const a=db.prepare('SELECT * FROM assets WHERE id=?').get(id);return a?{id:String(a.id),productId:String(a.product_id),fileName:String(a.file_name),mimeType:String(a.mime_type),width:Number(a.width),height:Number(a.height),byteSize:Number(a.byte_size),originalPath:String(a.original_path),previewPath:String(a.preview_path),sha256:String(a.sha256)}:null;}};
  for(const variantId of new Set(variantIds)){
    try{const context=resolveConsistencyContext(db,store,directory,{productId:product.id,productRevision:product.revision,variantId});assertConsistencyView(readConsistencyView(db,context));}
    catch(error){if(error instanceof SourceConsistencyError)throw error;throw new SourceConsistencyError('SYSTEM_REPAIR','SOURCE_CONSISTENCY_IDENTITY_INVALID','来源图片身份或原始文件已变化，请修复来源记录');}
  }
}
