import { enumDecisionPlans } from './enum-decisions.ts';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AiPurposeId,AiPurposeSnapshot,FieldPurposeAssignment } from '../../shared/ai-purpose-contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { resolvePurpose,validatePurposeSnapshot } from './purpose-routing.ts';
import { listingFingerprint } from '../json-fingerprint.ts';
import { keys,uuid,sha256,integer,boundedText } from './primitives.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { transaction } from '../application/transaction.ts';
import { assertRecordTable } from '../storage/record-table.ts';

export type {FieldPurposeAssignment} from '../../shared/ai-purpose-contracts.ts';
export interface FieldPurposeGroup{purpose:AiPurposeSnapshot;assignments:FieldPurposeAssignment[]}
const copyPurpose:Record<string,AiPurposeId>={item_name:'listing_title',bullet_point:'listing_bullets',product_description:'listing_description',generic_keyword:'listing_search_terms'};
export function fieldPurposeGroups(db:DatabaseSync,context:ListingAiContext,completion:boolean):FieldPurposeGroup[]{
  const fallback:AiPurposeId=completion?'listing_completion':'listing_generation';
  const assignments:FieldPurposeAssignment[]=[{field:'*',purpose:resolvePurpose(db,fallback)}];
  const enumFields=new Set(enumDecisionPlans(context).map(p=>p.field));
  for(const {name:field} of context.fields){
    const existing=context.repairRequest?.currentValues[field],repair=existing!==undefined&&existing!==null;
    if(enumFields.has(field)){assignments.push({field,purpose:resolvePurpose(db,'enum_decision')});continue;}
    if(repair||copyPurpose[field])assignments.push({field,purpose:resolvePurpose(db,repair?'listing_repair':copyPurpose[field])});
  }
  const grouped=new Map<string,FieldPurposeGroup>();
  for(const assignment of assignments){const p=assignment.purpose,key=listingFingerprint({gateway:p.gateway,model:p.model,effort:p.effectiveEffort,capability:p.capability});const group=grouped.get(key)??{purpose:p,assignments:[]};group.assignments.push(assignment);grouped.set(key,group);}
  // A fallback covering no field must not generate an empty paid request.
  return [...grouped.values()].filter(g=>context.fields.some(f=>g.assignments.some(a=>a.field===f.name)||g.assignments.some(a=>a.field==='*')&&!assignments.some(a=>a.field===f.name)));
}
export const FIELD_GROUP_TABLES={ai_field_groups:['id','record_json']};
export interface FieldGroupOperation{id:string;contextHash:string;scopeHash:string;revision:number;completion:boolean;members:(FieldPurposeGroup&{callId:string;retryCallId?:string;sent:boolean;resultId:string|null})[];resultId:string|null}
export function validateAssignments(raw:unknown):FieldPurposeAssignment[]{
  if(!Array.isArray(raw)||!raw.length||raw.length>1001)throw new UserFacingError('字段用途快照无效');
  const values=raw.map(v=>{const o=keys(v,['field','purpose']);return{field:boundedText(o.field,200),purpose:validatePurposeSnapshot(o.purpose)};});
  if(new Set(values.map(v=>v.field)).size!==values.length)throw new UserFacingError('字段用途重复');return values;
}
export function validateFieldGroup(raw:unknown):FieldGroupOperation{
  const o=keys(raw,['id','contextHash','scopeHash','revision','completion','members','resultId']);
  if(typeof o.completion!=='boolean'||!Array.isArray(o.members)||o.members.length<2||o.members.length>7)throw new UserFacingError('字段分组操作无效');
  const members=o.members.map(v=>{const m=keys(v,['purpose','assignments','callId','sent','resultId'],['retryCallId']),purpose=validatePurposeSnapshot(m.purpose),assignments=validateAssignments(m.assignments);if(typeof m.sent!=='boolean'||m.resultId!==null&&!m.sent||assignments.some(a=>a.purpose.gateway!==purpose.gateway||a.purpose.model!==purpose.model||a.purpose.effectiveEffort!==purpose.effectiveEffort))throw new UserFacingError('字段分组模型与调用不一致');if(m.retryCallId!==undefined&&(!m.sent||m.retryCallId===m.callId))throw new UserFacingError('字段分组重试身份无效');return{purpose,assignments,callId:uuid(m.callId),...(m.retryCallId===undefined?{}:{retryCallId:uuid(m.retryCallId)}),sent:m.sent,resultId:m.resultId===null?null:uuid(m.resultId)};});
  if(new Set(members.flatMap(m=>[m.callId,...(m.retryCallId?[m.retryCallId]:[])])).size!==members.reduce((n,m)=>n+1+(m.retryCallId?1:0),0)||members[0].callId!==o.id||o.resultId!==null&&members.some(m=>!m.resultId))throw new UserFacingError('字段分组身份无效');
  const fields=members.flatMap(m=>m.assignments.map(a=>a.field));if(new Set(fields).size!==fields.length||o.scopeHash!==listingFingerprint({contextHash:o.contextHash,completionId:o.completion?o.id:null}))throw new UserFacingError('字段分组范围无效');
  return{id:uuid(o.id),contextHash:sha256(o.contextHash),scopeHash:sha256(o.scopeHash),revision:integer(o.revision,0,Number.MAX_SAFE_INTEGER),completion:o.completion,members,resultId:o.resultId===null?null:uuid(o.resultId)};
}
export function readFieldGroup(db:DatabaseSync,id:string):FieldGroupOperation|undefined{if(Number(db.prepare('PRAGMA user_version').get()!.user_version)<27)return;const row=db.prepare('SELECT record_json FROM ai_field_groups WHERE id=?').get(id);if(!row)return;const v=validateFieldGroup(JSON.parse(String(row.record_json)));if(v.id!==id)throw new UserFacingError('字段分组身份无效');return v;}
export function saveFieldGroup(db:DatabaseSync,value:FieldGroupOperation):void{
  const checked=validateFieldGroup(value),old=readFieldGroup(db,value.id);if(old&&old.revision!==value.revision)throw new UserFacingError('字段分组已被其他请求推进');
  checked.revision++;db.prepare('INSERT INTO ai_field_groups VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(checked.id,JSON.stringify(checked));value.revision=checked.revision;
}
export function beginFieldGroup(db:DatabaseSync,context:ListingAiContext,groups:FieldPurposeGroup[],completionId?:string):FieldGroupOperation{
  return transaction(db,()=>{
    const contextHash=listingFingerprint(context),scopeHash=listingFingerprint({contextHash,completionId:completionId??null});
    const row=db.prepare("SELECT id FROM ai_field_groups WHERE json_extract(record_json,'$.scopeHash')=?").get(scopeHash);
    if(row)return readFieldGroup(db,String(row.id))!;
    const id=completionId??randomUUID(),value:FieldGroupOperation={id,contextHash,scopeHash,revision:0,completion:!!completionId,members:groups.map((group,index)=>({...group,callId:index===0?id:randomUUID(),sent:false,resultId:null})),resultId:null};saveFieldGroup(db,value);return value;
  });
}
export function findFieldGroup(db:DatabaseSync,context:ListingAiContext,completionId?:string):FieldGroupOperation|undefined{
  const scopeHash=listingFingerprint({contextHash:listingFingerprint(context),completionId:completionId??null}),row=db.prepare("SELECT id FROM ai_field_groups WHERE json_extract(record_json,'$.scopeHash')=?").get(scopeHash);return row?readFieldGroup(db,String(row.id)):undefined;
}
export function groupFields(context:ListingAiContext,assignments:FieldPurposeAssignment[],all:FieldPurposeAssignment[]):string[]{
  return context.fields.filter(field=>assignments.some(a=>a.field===field.name)||assignments.some(a=>a.field==='*')&&!all.some(a=>a.field===field.name)).map(f=>f.name);
}
export function assertFieldGroupHistory(db:DatabaseSync,operationId?:string):void{
  if(Number(db.prepare('PRAGMA user_version').get()!.user_version)<27)return;assertRecordTable(db,'ai_field_groups');
  const owned=new Set<string>();
  for(const row of (operationId?db.prepare('SELECT id FROM ai_field_groups WHERE id=?').iterate(operationId):db.prepare('SELECT id FROM ai_field_groups').iterate())){
    const op=readFieldGroup(db,String(row.id))!;
    for(const member of op.members){
      for(const id of [member.callId,...(member.retryCallId?[member.retryCallId]:[])]){if(owned.has(id))throw new UserFacingError('字段分组调用身份重复');owned.add(id);}
      if(member.retryCallId)assertFieldGroupRetry(db,op,member);
      const call=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(member.callId),usage=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(member.callId);
      if(member.sent){if(!call||!usage)throw new UserFacingError('字段分组调用或预算缺失');const record=JSON.parse(String(call.record_json));if(record.id!==member.callId||record.model!==member.purpose.model||record.presentationContext?.sourceSha256!==op.contextHash||listingFingerprint(record.purposeAssignments)!==listingFingerprint(member.assignments))throw new UserFacingError('字段分组调用范围不一致');}
      else if(call||usage||member.resultId)throw new UserFacingError('未发送分组存在调用记录');
      if(member.resultId){const result=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(member.resultId);if(!result)throw new UserFacingError('字段分组结果缺失');const r=JSON.parse(String(result.record_json));if(r.callId!==fieldGroupCallId(member)||r.fieldGroupPart?.operationId!==op.id||r.sourceSha256!==op.contextHash||!r.listingContext||listingFingerprint(r.fieldGroupPart.fields)!==listingFingerprint(groupFields(r.listingContext,member.assignments,op.members.flatMap(m=>m.assignments))))throw new UserFacingError('字段分组结果归属不一致');}
    }
    if(op.resultId){const row=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(op.resultId);if(!row||JSON.parse(String(row.record_json)).fieldGroupAssembly?.operationId!==op.id)throw new UserFacingError('字段合并结果归属不一致');}
  }
}
/** Preserve spent grouped calls, never fabricate missing domain results during rollback. */
export function retainFieldGroupHistory(current:DatabaseSync,snapshot:DatabaseSync):void{
  if(!current.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_field_groups'").get())return;
  const identity=(v:FieldGroupOperation)=>({...v,revision:0,resultId:null,members:v.members.map(({retryCallId,...m})=>({...m,resultId:null,sent:false}))});
  for(const row of current.prepare('SELECT id FROM ai_field_groups').all()){
    const value=readFieldGroup(current,String(row.id))!,old=readFieldGroup(snapshot,value.id);
    if(old&&listingFingerprint(identity(old))!==listingFingerprint(identity(value)))throw new UserFacingError('恢复字段分组身份冲突');
    const merged=structuredClone(value);merged.revision=old?.revision??0;
    for(const [index,member] of merged.members.entries()){
      const prior=old?.members[index];member.sent ||= prior?.sent??false;
      if(prior?.retryCallId&&member.retryCallId&&prior.retryCallId!==member.retryCallId)throw new UserFacingError('恢复字段分组重试身份冲突');
      member.retryCallId=member.retryCallId??prior?.retryCallId;
      for(const callId of [member.callId,...(member.retryCallId?[member.retryCallId]:[])]){
      const currentCall=current.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(callId),snapshotCall=snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(callId);
      if(currentCall){
        const call=JSON.parse(String(currentCall.record_json));
        if(snapshotCall){const original=JSON.parse(String(snapshotCall.record_json));if(original.id!==call.id||original.startedAt!==call.startedAt||original.providerId!==call.providerId||original.model!==call.model||listingFingerprint(original.purposeAssignments)!==listingFingerprint(call.purposeAssignments))throw new UserFacingError('恢复字段分组调用冲突');}
        else{const retained={...call,status:'FAILED',errorCode:call.errorCode??'INTERRUPTED',finishedAt:call.finishedAt??call.startedAt};snapshot.prepare('INSERT INTO ai_calls VALUES(?,?)').run(call.id,JSON.stringify(retained));}
      }
      }
      member.resultId=[prior?.resultId,member.resultId].find(id=>id&&snapshot.prepare('SELECT 1 FROM ai_results WHERE id=?').get(id))??null;
    }
    merged.resultId=[old?.resultId,value.resultId].find(id=>id&&snapshot.prepare('SELECT 1 FROM ai_results WHERE id=?').get(id))??null;
    saveFieldGroup(snapshot,merged);
  }
}

/** Original group identity is immutable; the one reserved successor owns its own result and ledger. */
export const fieldGroupCallId=(member:FieldGroupOperation['members'][number]):string=>member.retryCallId??member.callId;
export const fieldGroupRetryScope=(operation:FieldGroupOperation,member:FieldGroupOperation['members'][number]):string=>`fields-group:${operation.id}:${member.callId}`;
function assertFieldGroupRetry(db:DatabaseSync,op:FieldGroupOperation,member:FieldGroupOperation['members'][number]):void{
 const row=db.prepare("SELECT detail_json FROM audit_events WHERE action='ai.forbidden.manual-retry' AND json_extract(detail_json,'$.scopeKey')=?").get(fieldGroupRetryScope(op,member));
 const proof=row?JSON.parse(String(row.detail_json)):null;
 const retry=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(member.retryCallId!),usage=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(member.retryCallId!);
 if(!proof||proof.priorCallId!==member.callId||proof.retryCallId!==member.retryCallId||!retry||!usage)throw new UserFacingError('字段分组重试证据缺失');
 const originalRow=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(member.callId);
 if(!originalRow)throw new UserFacingError('字段分组原调用缺失');
 const original=JSON.parse(String(originalRow.record_json)),call=JSON.parse(String(retry.record_json)),ledger=JSON.parse(String(usage.record_json));
 if(call.id!==member.retryCallId||call.productId!==original.productId||call.productRevision!==original.productRevision||call.providerId!==original.providerId||call.presentationContext?.draftId!==original.presentationContext?.draftId||call.presentationContext?.variantId!==original.presentationContext?.variantId||call.model!==member.purpose.model||call.presentationContext?.sourceSha256!==op.contextHash||listingFingerprint(call.purposeAssignments)!==listingFingerprint(member.assignments)||ledger.id!==call.id||ledger.startedAt!==call.startedAt||ledger.providerId!==call.providerId)throw new UserFacingError('字段分组重试范围不一致');
}
