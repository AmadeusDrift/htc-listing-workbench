import { LEGACY_THEME_REPAIR_VERSION, legacyThemeSource, type LegacyThemeRepair } from './legacy-theme-repair.ts';
import type { AutomaticListingItem } from '../../shared/automatic-listing-contracts.ts';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { isReviewCoverageOmission } from './review-omission.ts';
import {legacyCompletionOwners,recoverLegacyCompletion,linkLegacyCompletionOwners,legacyStepDebt} from './legacy-completion.ts';
import type {LegacyCompletionHistory} from './legacy-completion.ts';
import { resultHasOwner } from '../ai/result-owner.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { boundedText, date, integer, keys, sha256, uuid, validateAiCall, validateStoredAiResult } from '../ai/validation.ts';
import { listingFingerprint, validateListingContext } from './validation.ts';
import { validateAiUsageRecord } from '../ai/usage.ts';
import { isFullSchema,nativeCandidateIssues,fullCopyPolicyIssues,parseFullGeneration,retainValidNativeCandidates } from './full-schema.ts';
import { hasInvalidAiResponse,readInvalidAiOutputs } from '../ai/output-diagnostics.ts';

export interface CompletionCall { id:string; sent:boolean; resultId:string|null; previous?:CompletionCall[] }
const wasSent=(call:CompletionCall|null):boolean=>!!call&&(call.sent||!!call.previous?.some(previous=>previous.sent));
export interface CompletionRound {
  context:ListingAiContext; contextHash:string; candidate:CompletionCall; review:CompletionCall|null;
  resolved:boolean; adoptionId:string|null;
}
export interface CompletionOperation {
  id:string; revision:number; draftId:string; scopeHash:string; safetyScopeHash:string; safetyIdentity:ReturnType<typeof completionSafetyIdentity>; copyReviewEnabled:boolean; state:'ACTIVE'|'DONE'|'GUARD'|'RETIRED';
  draftRevision:number; draftStamp:string; rounds:CompletionRound[]; remaining:string[];
  reviewIssues:{field:string;message:string}[]; createdAt:string; updatedAt:string; legacyRecovery?:LegacyCompletionHistory; scopedRepair?:LegacyThemeRepair;
}
export interface CompletionRequest { operationId:string; callId:string; contextHash:string }
export function completionDraftStamp(draft:AmazonDraft):string {return listingFingerprint({id:draft.id,revision:draft.revision,productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,targetId:draft.targetId,sellerId:draft.sellerId,marketplaceId:draft.marketplaceId,listingProgram:draft.listingProgram,schema:draft.schema,attributes:draft.attributes,salesPlan:draft.salesPlan??null});}
/** Credential reconnects and a recreated draft cannot erase a request for the same source sale. */
export function completionSafetyIdentity(draft:Pick<AmazonDraft,'productId'|'productRevision'|'variantId'|'sku'|'mode'|'sellerId'|'marketplaceId'|'listingProgram'|'salesPlan'>){return {mode:draft.mode,productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,sellerId:draft.sellerId,marketplaceId:draft.marketplaceId,listingProgram:draft.listingProgram,recipeHash:listingFingerprint(draft.salesPlan?.recipe??null)};}
export function completionSafetyScope(draft:AmazonDraft):string{return listingFingerprint(completionSafetyIdentity(draft));}
function invalid():never {throw new UserFacingError('字段请求进度证据无效，未自动重发');}
export const unknownCompletion=():never=>{throw new UserFacingError('上次字段请求结果尚未确认，已保留进度，未自动重发');};
function parseCall(raw:unknown):CompletionCall {
  const o=keys(raw,['id','sent','resultId'],['previous']);if(typeof o.sent!=='boolean'||o.resultId!==null&&!o.sent)invalid();
  const previous=o.previous===undefined?undefined:Array.isArray(o.previous)?o.previous.map(parseCall):invalid();
  if(previous&&(previous.length>2||previous.some(call=>call.previous||!call.sent||call.resultId)))invalid();
  return {id:uuid(o.id),sent:o.sent as boolean,resultId:o.resultId===null?null:uuid(o.resultId),...(previous?{previous}:{})};
}
export function validateCompletionOperation(raw:unknown):CompletionOperation {
  const o=keys(raw,['id','revision','draftId','scopeHash','safetyScopeHash','safetyIdentity','copyReviewEnabled','state','draftRevision','draftStamp','rounds','remaining','reviewIssues','createdAt','updatedAt'],['legacyRecovery','scopedRepair']);
  if(typeof o.copyReviewEnabled!=='boolean'||!['ACTIVE','DONE','GUARD','RETIRED'].includes(String(o.state))||!Array.isArray(o.rounds)||o.rounds.length>2||!Array.isArray(o.remaining)||o.remaining.length>100||!Array.isArray(o.reviewIssues)||o.reviewIssues.length>100)invalid();
  const identity=keys(o.safetyIdentity,['mode','productId','productRevision','variantId','sku','sellerId','marketplaceId','listingProgram','recipeHash']);
  const safetyIdentity={mode:identity.mode as AmazonDraft['mode'],productId:uuid(identity.productId),productRevision:integer(identity.productRevision,1,Number.MAX_SAFE_INTEGER),variantId:uuid(identity.variantId),sku:boundedText(identity.sku,100),sellerId:boundedText(identity.sellerId,100),marketplaceId:boundedText(identity.marketplaceId,100),listingProgram:identity.listingProgram as AmazonDraft['listingProgram'],recipeHash:sha256(identity.recipeHash)};
  if(!['demo','live'].includes(safetyIdentity.mode)||!['standard','haul'].includes(safetyIdentity.listingProgram)||listingFingerprint(safetyIdentity)!==o.safetyScopeHash)invalid();
  const rounds=(o.rounds as unknown[]).map(raw=>{
    const r=keys(raw,['context','contextHash','candidate','review','resolved','adoptionId']),context=validateListingContext(r.context),contextHash=sha256(r.contextHash);
    if(contextHash!==listingFingerprint(context)||context.draftId!==o.draftId||context.productId!==safetyIdentity.productId||context.productRevision!==safetyIdentity.productRevision||context.variantId!==safetyIdentity.variantId||context.sku!==safetyIdentity.sku||context.marketplaceId!==safetyIdentity.marketplaceId||context.listingProgram!==safetyIdentity.listingProgram||typeof r.resolved!=='boolean')invalid();
    const candidate=parseCall(r.candidate),review=r.review===null?null:parseCall(r.review);
    if(!!review!==o.copyReviewEnabled||o.state!=='GUARD'&&review?.sent&&!candidate.resultId||r.adoptionId!==null&&(!candidate.resultId||review&&!review.resultId))invalid();
    return {context,contextHash,candidate,review,resolved:r.resolved as boolean,adoptionId:r.adoptionId===null?null:sha256(r.adoptionId)};
  });
  const ids=rounds.flatMap(r=>[r.candidate,r.review].flatMap(c=>c?[...(c.previous??[]),c].map(c=>c.id):[]));if(new Set(ids).size!==ids.length||rounds.slice(0,-1).some(r=>!r.resolved))invalid();
  if(o.state==='GUARD'&&!o.legacyRecovery&&!rounds.some(r=>wasSent(r.candidate)||wasSent(r.review))||o.state==='DONE'&&rounds.some(r=>[r.candidate,r.review].some(call=>call?.sent&&!call.resultId)))invalid();
  if(o.state==='RETIRED'&&rounds.some(r=>wasSent(r.candidate)||wasSent(r.review)))invalid();
  const reviewIssues=(o.reviewIssues as unknown[]).map(raw=>{const issue=keys(raw,['field','message']);return{field:boundedText(issue.field,100),message:boundedText(issue.message,2000)};});
  const createdAt=date(o.createdAt),updatedAt=date(o.updatedAt);if(updatedAt<createdAt)invalid();
  let legacyRecovery:LegacyCompletionHistory|undefined;
  if(o.legacyRecovery!==undefined){const l=keys(o.legacyRecovery,['checkpointIds','callIds','resultIds','adoptionIds','priorRounds','missingAttemptDebt'],['stepDebts']);const ids=(v:unknown,hash=false)=>{if(!Array.isArray(v)||v.length>1000)invalid();return (v as unknown[]).map(x=>hash?sha256(x):uuid(x));};legacyRecovery={checkpointIds:ids(l.checkpointIds),callIds:ids(l.callIds),resultIds:ids(l.resultIds),adoptionIds:ids(l.adoptionIds,true),priorRounds:integer(l.priorRounds,0,1000),missingAttemptDebt:integer(l.missingAttemptDebt,0,3)};
    if(l.stepDebts!==undefined){if(!Array.isArray(l.stepDebts)||l.stepDebts.length>1000)invalid();legacyRecovery.stepDebts=(l.stepDebts as unknown[]).map(raw=>{const step=keys(raw,['contextHash','kind','callIds']);if(!['candidate','review'].includes(String(step.kind)))invalid();return{contextHash:sha256(step.contextHash),kind:step.kind as 'candidate'|'review',callIds:ids(step.callIds)};});const steps=legacyRecovery.stepDebts;if(new Set(steps.map(step=>step.contextHash+step.kind)).size!==steps.length||steps.some(step=>!step.callIds.length||new Set(step.callIds).size!==step.callIds.length||step.callIds.some(id=>!legacyRecovery!.callIds.includes(id))))invalid();}}
  let scopedRepair:LegacyThemeRepair|undefined;
  if(o.scopedRepair!==undefined){
    const proof=keys(o.scopedRepair,['version','fields','sourceResultId','sourceCallId','sourceContextHash','sourceWorkflowId','originalDraftStamp','previousAttempts']);
    if(proof.version!==LEGACY_THEME_REPAIR_VERSION||JSON.stringify(proof.fields)!=='["theme"]'||proof.previousAttempts!==4||legacyRecovery)invalid();
    scopedRepair={version:LEGACY_THEME_REPAIR_VERSION,fields:['theme'],sourceResultId:uuid(proof.sourceResultId),sourceCallId:uuid(proof.sourceCallId),sourceContextHash:sha256(proof.sourceContextHash),sourceWorkflowId:uuid(proof.sourceWorkflowId),originalDraftStamp:sha256(proof.originalDraftStamp),previousAttempts:4};
    if(rounds.some(round=>round.context.fields.some(field=>field.name!=='theme')||!round.context.repairRequest||round.context.repairRequest.issues.some(issue=>issue.field!=='theme')))invalid();
  }
  return{...(scopedRepair?{scopedRepair}:{}),...(legacyRecovery?{legacyRecovery}:{}),id:uuid(o.id),revision:integer(o.revision,1,Number.MAX_SAFE_INTEGER),draftId:uuid(o.draftId),scopeHash:sha256(o.scopeHash),safetyScopeHash:sha256(o.safetyScopeHash),safetyIdentity,copyReviewEnabled:o.copyReviewEnabled as boolean,state:o.state as CompletionOperation['state'],draftRevision:integer(o.draftRevision,1,Number.MAX_SAFE_INTEGER),draftStamp:sha256(o.draftStamp),rounds,remaining:(o.remaining as unknown[]).map(v=>boundedText(v,2000)),reviewIssues,createdAt,updatedAt};
}
export function completionOperations(db:DatabaseSync,draftId?:string):CompletionOperation[] {
  return db.prepare('SELECT id,record_json FROM listing_completion_operations'+(draftId?" WHERE json_extract(record_json,'$.draftId')=?":'')+' ORDER BY rowid').all(...(draftId?[draftId]:[])).map(row=>{
    const op=validateCompletionOperation(JSON.parse(String(row.record_json)));if(op.id!==row.id)invalid();return op;
  });
}
function save(db:DatabaseSync,raw:CompletionOperation):CompletionOperation {
  const op=validateCompletionOperation(raw),existing=db.prepare('SELECT id FROM listing_completion_operations WHERE id=?').get(op.id);
  if(existing){const old=validateCompletionOperation(JSON.parse(String(db.prepare('SELECT record_json FROM listing_completion_operations WHERE id=?').get(op.id)!.record_json)));if(old.scopedRepair&&listingFingerprint(old.scopedRepair)!==listingFingerprint(op.scopedRepair))invalid();if(old.legacyRecovery&&listingFingerprint(old.legacyRecovery)!==listingFingerprint(op.legacyRecovery))invalid();op.revision++;const result=db.prepare("UPDATE listing_completion_operations SET record_json=? WHERE id=? AND json_extract(record_json,'$.revision')=?").run(JSON.stringify(op),op.id,raw.revision);if(result.changes!==1)throw new UserFacingError('字段操作已由另一请求推进，请重新读取原操作');}
  else db.prepare('INSERT INTO listing_completion_operations(id,record_json) VALUES(?,?)').run(op.id,JSON.stringify(op));
  raw.revision=op.revision;return op;
}
export class CompletionJournal {
  private db:DatabaseSync;
  private directory:string|undefined;
  constructor(db:DatabaseSync,directory?:string){this.db=db;this.directory=directory;}
  get(id:string):CompletionOperation { const row=this.db.prepare('SELECT record_json FROM listing_completion_operations WHERE id=?').get(uuid(id));if(!row)invalid();const op=validateCompletionOperation(JSON.parse(String(row.record_json)));if(op.id!==id)invalid();return op; }
  list(draftId:string):CompletionOperation[]{return completionOperations(this.db,draftId);}
  saleOperations(input:ReturnType<typeof completionSafetyIdentity>):CompletionOperation[]{
    const fields=['mode','productId','productRevision','variantId','sku','sellerId','marketplaceId','listingProgram','recipeHash'] as const;
    return this.db.prepare('SELECT id,record_json FROM listing_completion_operations WHERE '+fields.map(name=>`json_extract(record_json,'$.safetyIdentity.${name}')=?`).join(' AND ')).all(...fields.map(name=>input[name])).map(row=>{const op=validateCompletionOperation(JSON.parse(String(row.record_json)));if(op.id!==row.id)invalid();return op;});
  }
  save(op:CompletionOperation):CompletionOperation{op.updatedAt=[op.updatedAt,new Date().toISOString()].sort()[1];return save(this.db,op);}
  begin(input:Pick<CompletionOperation,'draftId'|'scopeHash'|'safetyScopeHash'|'safetyIdentity'|'copyReviewEnabled'|'draftRevision'|'draftStamp'>,id?:string,legacyDraft?:AmazonDraft,legacyScopeHash?:()=>string):CompletionOperation {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(this.db.prepare("SELECT 1 FROM automatic_listing_tasks t,json_each(t.record_json,'$.items') i WHERE json_extract(i.value,'$.draftId')=? AND json_extract(i.value,'$.repair.phase')='FIELDS_STARTED' AND json_type(i.value,'$.repair.operationId') IS NULL").get(input.draftId)
        ||(!legacyDraft&&legacyCompletionOwners(this.db,input.draftId).length))unknownCompletion();
      const records=this.list(input.draftId),pending=records.filter(op=>!['DONE','RETIRED'].includes(op.state));
      if(this.db.prepare("SELECT 1 FROM listing_completion_operations WHERE json_extract(record_json,'$.safetyScopeHash')=? AND json_extract(record_json,'$.draftId')!=? AND json_extract(record_json,'$.state') NOT IN ('DONE','RETIRED')").get(input.safetyScopeHash,input.draftId))unknownCompletion();
      if(pending.length>1||pending.some(op=>op.state==='GUARD'))unknownCompletion();
      const completed=legacyDraft&&legacyCompletionOwners(this.db,input.draftId).length?records.filter(record=>record.state==='DONE'&&record.scopeHash===input.scopeHash&&record.draftRevision===input.draftRevision&&record.draftStamp===input.draftStamp).at(-1):undefined;
      const op=id?this.get(id):pending[0]??completed;
      if(pending.some(other=>other.id!==op?.id))unknownCompletion();
      if(op?.state==='RETIRED')throw new UserFacingError('原字段草稿已按保留期清理，请建立新草稿');
      if(op){if(op.draftId!==input.draftId||op.scopeHash!==input.scopeHash||op.copyReviewEnabled!==input.copyReviewEnabled)throw new UserFacingError('字段操作来源、店铺或审核策略已变化，保留原操作，未自动重发');linkLegacyCompletionOwners(this.db,input.draftId,op.id);this.db.exec('COMMIT');return op;}
      const at=new Date().toISOString(),raw:CompletionOperation={...input,id:randomUUID(),revision:1,state:'ACTIVE',rounds:[],remaining:[],reviewIssues:[],createdAt:at,updatedAt:at},next=save(this.db,legacyDraft?recoverLegacyCompletion(this.db,raw,legacyDraft,legacyScopeHash):raw);linkLegacyCompletionOwners(this.db,input.draftId,next.id);this.db.exec('COMMIT');return next;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** One successor, never an ordinary budget increase. No paid request occurs here. */
  beginLegacyThemeRepair(input:Pick<CompletionOperation,'draftId'|'scopeHash'|'safetyScopeHash'|'safetyIdentity'|'copyReviewEnabled'|'draftRevision'|'draftStamp'>,draft:AmazonDraft,current:ListingAiContext,row:AutomaticListingItem,workflow:ImageWorkflowRun,assertMutationSafe?:()=>void):CompletionOperation|undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results=this.db.prepare("SELECT record_json FROM ai_results WHERE json_extract(record_json,'$.listingContext.draftId')=? ORDER BY json_extract(record_json,'$.createdAt'),id").all(draft.id).map(r=>validateStoredAiResult(JSON.parse(String(r.record_json))));
      const source=legacyThemeSource(draft,current,row,workflow,results);
      if(!source){this.db.exec('COMMIT');return;}
      const calls=this.db.prepare("SELECT record_json FROM ai_calls WHERE json_extract(record_json,'$.presentationContext.draftId')=? OR id IN (SELECT json_extract(record_json,'$.callId') FROM ai_results WHERE json_extract(record_json,'$.listingContext.draftId')=?)").all(draft.id,draft.id).map(r=>validateAiCall(JSON.parse(String(r.record_json))));
      for(const call of calls){
        const result=results.find(r=>r.callId===call.id),usage=this.db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(call.id);
        if(!result||call.status!=='SUCCEEDED'||!resultHasOwner(result,call)||!usage||result.sourceSha256!==listingFingerprint(result.listingContext)||result.productId!==draft.productId||result.productRevision!==draft.productRevision||result.variantId!==draft.variantId||call.model!==result.model||call.providerId!==result.providerId){this.db.exec('COMMIT');return;}
        const ledger=validateAiUsageRecord(JSON.parse(String(usage.record_json)));
        if(ledger.id!==call.id||ledger.startedAt!==call.startedAt||ledger.providerId!==call.providerId||this.directory&&hasInvalidAiResponse(this.directory,call,'amazon-fields')){this.db.exec('COMMIT');return;}
      }
      if(!calls.some(call=>call.id===source.callId)){this.db.exec('COMMIT');return;}
      assertMutationSafe?.();
      const existing=this.saleOperations(input.safetyIdentity),scoped=existing.filter(op=>op.scopedRepair);
      if(scoped.length){
        const op=scoped[0];
        if(scoped.length!==1||existing.some(other=>other.id!==op.id&&!['DONE','RETIRED'].includes(other.state))||op.state!=='ACTIVE'||op.scopedRepair!.sourceResultId!==source.id||op.scopeHash!==input.scopeHash||op.draftStamp!==input.draftStamp||op.rounds.some(r=>r.candidate.sent||r.review?.sent)){this.db.exec('COMMIT');return;}
        this.db.exec('COMMIT');return op;
      }
      if(existing.some(op=>!['DONE','RETIRED'].includes(op.state))||legacyCompletionOwners(this.db,draft.id).length){this.db.exec('COMMIT');return;}
      const at=new Date().toISOString(),op=save(this.db,{...input,id:randomUUID(),revision:1,state:'ACTIVE',rounds:[],remaining:[],reviewIssues:[],createdAt:at,updatedAt:at,scopedRepair:{version:LEGACY_THEME_REPAIR_VERSION,fields:['theme'],sourceResultId:source.id,sourceCallId:source.callId,sourceContextHash:source.sourceSha256!,sourceWorkflowId:workflow.id,originalDraftStamp:input.draftStamp,previousAttempts:4}});
      this.db.exec('COMMIT');return op;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  assertSendBudget(id:string,kind:'candidate'|'review'):void {
    const op=this.get(id),round=op.rounds.at(-1);
    if(round&&legacyStepDebt(op,round,kind)+(round[kind]?.previous?.length??0)>=3)throw new UserFacingError('旧字段请求已用完三次尝试，原请求与费用记录保留');
  }
  /** Invoked only inside the usage reservation transaction on this exact connection. */
  markSent(request:CompletionRequest,call:AiCall):void {
    const op=this.get(request.operationId),round=op.rounds.find(r=>[r.candidate.id,r.review?.id].includes(request.callId));
    if(op.state!=='ACTIVE'||!round||round.contextHash!==request.contextHash||call.id!==request.callId||call.productId!==round.context.productId||call.productRevision!==round.context.productRevision)invalid();
    if(op.scopedRepair){
      const grant=this.db.prepare("SELECT 1 FROM automatic_listing_tasks t,json_each(t.record_json,'$.items') i WHERE json_extract(i.value,'$.draftId')=? AND json_extract(i.value,'$.repair.phase')='FIELDS_STARTED' AND json_extract(i.value,'$.repair.operationId')=? AND json_extract(i.value,'$.legacyThemeRepair.operationId')=? AND json_extract(i.value,'$.legacyThemeRepair.version')=? AND json_extract(i.value,'$.repairAttempts')=5").get(op.draftId,op.id,op.id,LEGACY_THEME_REPAIR_VERSION);
      if(!grant)throw new UserFacingError('旧主题修复额度尚未持久化，未发送请求');
    }
    const entry=round.candidate.id===request.callId?round.candidate:round.review!;
    if(entry.sent||entry.resultId||round.resolved)unknownCompletion();if(legacyStepDebt(op,round,entry===round.candidate?'candidate':'review')+(entry.previous?.length??0)>=3)throw new UserFacingError('旧字段请求已用完三次尝试，原请求与费用记录保留');entry.sent=true;this.save(op);
  }
  /** Result/call/usage and journal result reference commit together. */
  recordResult(request:CompletionRequest,result:AiResult):void {
    const op=this.get(request.operationId),round=op.rounds.find(r=>[r.candidate.id,r.review?.id].includes(request.callId));
    if(!round||round.contextHash!==request.contextHash||result.callId!==request.callId||result.sourceSha256!==request.contextHash)invalid();
    const entry=round.candidate.id===request.callId?round.candidate:round.review!;if(!entry.sent||entry.resultId)invalid();entry.resultId=result.id;this.save(op);
  }
  unknown(id:string):boolean {
    const op=this.get(id);return op.state==='GUARD'||op.rounds.some(r=>[r.candidate,r.review].some(call=>call?.sent&&!this.result(call,r)&&!this.received(call,r)));
  }
  /** The original two repair rounds remain fixed; each missing step has at most three sends. */
  retryMissing(id:string,kind:'candidate'|'review'):void {
    const op=this.get(id),round=op.rounds.at(-1),entry=round?.[kind];
    if(op.state!=='ACTIVE'||!round||round.resolved||!entry||!entry.sent||entry.resultId)invalid();
    const row=this.db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(entry.id);
    const usage=this.db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(entry.id);
    if(!row||!usage)invalid();
    const call=validateAiCall(JSON.parse(String(row.record_json))),ledger=validateAiUsageRecord(JSON.parse(String(usage.record_json)));
    if(call.id!==entry.id||call.productId!==round.context.productId||call.productRevision!==round.context.productRevision||call.providerId!==(kind==='candidate'?'deepseek':'deepseek-review')||ledger.id!==call.id||ledger.providerId!==call.providerId||ledger.startedAt!==call.startedAt)invalid();
    const owner=call.presentationContext;
    if(!owner||owner.kind!=='listing'||owner.draftId!==round.context.draftId||owner.variantId!==round.context.variantId||owner.sourceSha256!==round.contextHash)invalid();
    if(call.status==='SUCCEEDED'||call.status==='RUNNING')invalid();
    if(this.received(entry,round)&&!(kind==='review'&&this.reviewCoverageOmission(id)))unknownCompletion();
    if((entry.previous?.length??0)+legacyStepDebt(op,round,kind)>=2)throw new UserFacingError('字段请求已用完三次尝试，原请求与费用记录保留');
    const {previous,...old}=entry;
    round[kind]={id:randomUUID(),sent:false,resultId:null,previous:[...(previous??[]),old]};this.save(op);
  }
  /** A failed review may be repeated only when its retained raw output proves coverage omission. */
  reviewCoverageOmission(id:string):boolean {
    const op=this.get(id),round=op.rounds.at(-1),entry=round?.review;
    if(op.state!=='ACTIVE'||!round||round.resolved||!entry?.sent||entry.resultId||!this.directory)return false;
    const call=this.received(entry,round),candidate=this.result(round.candidate,round);
    if(!call||candidate?.output.kind!=='amazon-fields')return false;
    const output=candidate.output;
    return readInvalidAiOutputs(this.directory,call,'amazon-fields-review').some(raw=>isReviewCoverageOmission(raw,output,round.context));
  }
  private received(entry:CompletionCall,round:CompletionRound):AiCall|undefined {
    const row=this.db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(entry.id);
    if(!row)return;
    const call=validateAiCall(JSON.parse(String(row.record_json))),kind=entry.id===round.candidate.id?'amazon-fields':'amazon-fields-review';
    if(call.id!==entry.id||call.productId!==round.context.productId||call.productRevision!==round.context.productRevision||call.providerId!==(kind==='amazon-fields'?'deepseek':'deepseek-review')||call.status!=='FAILED'||call.errorCode!=='OUTPUT_INVALID')return;
    const p=call.presentationContext;
    if(p&&(p.kind!=='listing'||p.draftId!==round.context.draftId||p.variantId!==round.context.variantId||p.sourceSha256!==round.contextHash))return;
    if(call.responseReceived||call.rejection||this.directory&&hasInvalidAiResponse(this.directory,call,kind))return call;
  }
  /** Explicit continuation only. No provider, usage reservation, or call mutation. */
  recoverReceived(id:string):void {
    const op=this.get(id);if(op.state!=='ACTIVE')return;
    for(const round of op.rounds){
      for(const entry of [round.candidate,round.review]){
      if(!entry)continue;
      if(entry.sent&&!entry.resultId){
        const rows=this.db.prepare("SELECT id FROM ai_results WHERE json_extract(record_json,'$.callId')=?").all(entry.id);
        if(rows.length>1)invalid();
        if(rows.length){entry.resultId=String(rows[0].id);this.result(entry,round);this.save(op);}
      }
      if(entry.sent&&!entry.resultId&&this.received(entry,round)&&!(entry===round.review&&this.reviewCoverageOmission(op.id)))this.recover({operationId:op.id,callId:entry.id,contextHash:round.contextHash});
      }
    }
  }
  /** Atomically persist a frozen response; current-source adoption is a separate check. */
  recover(request:CompletionRequest):AiResult {
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const op=this.get(request.operationId),round=op.rounds.find(r=>[r.candidate.id,r.review?.id].includes(request.callId));
      if(op.state!=='ACTIVE'||!round||round.contextHash!==request.contextHash)invalid();
      const entry=round.candidate.id===request.callId?round.candidate:round.review!;
      const existing=this.result(entry,round);if(existing){this.db.exec('COMMIT');return existing;}
      if(!entry.sent)invalid();const call=this.received(entry,round);if(!call)unknownCompletion();
      const unavailable=()=>{throw new UserFacingError('已收到响应，无法本地恢复：原文缺失、不完整或仍不符合字段格式；原请求和费用已保留，未自动重发');};
      if(!this.directory||entry!==round.candidate||!isFullSchema(round.context))unavailable();
      for(const rawOutput of readInvalidAiOutputs(this.directory!,call!,'amazon-fields')){
        let result:AiResult;
        try{
          const output=retainValidNativeCandidates(parseFullGeneration(rawOutput,round.context),round.context),recoveredAt=[new Date().toISOString(),call!.finishedAt!].sort()[1];
          result=validateStoredAiResult({id:randomUUID(),callId:call!.id,providerId:call!.providerId,productId:call!.productId,productRevision:call!.productRevision,variantId:round.context.variantId,assetId:null,assetSha256:null,sourceResultIds:[],model:call!.model,createdAt:recoveredAt,reviewState:'unreviewed',output,listingContext:round.context,sourceSha256:round.contextHash,listingEvidenceContractVersion:'listing-evidence/v4',localRecovery:{parserVersion:'full-schema-recovery/v2',operationId:op.id,contextSha256:round.contextHash,rawSha256:listingFingerprint(rawOutput),rawOutput,recoveredAt}});
        }catch{continue;}
        this.db.prepare('INSERT INTO ai_results(id,record_json) VALUES(?,?)').run(result.id,JSON.stringify(result));
        this.recordResult(request,result);this.db.exec('COMMIT');return result;
      }
      return unavailable();
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  result(call:CompletionCall,round:CompletionRound):AiResult|undefined {
    if(!call.resultId)return undefined;
    const row=this.db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(call.resultId),callRow=this.db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id);
    if(!row||!callRow)invalid();const result=validateStoredAiResult(JSON.parse(String(row.record_json))),saved=validateAiCall(JSON.parse(String(callRow.record_json)));
    if(result.localRecovery){const owner=this.get(result.localRecovery.operationId);if(!owner.rounds.some(r=>r.contextHash===round.contextHash&&r.candidate.id===call.id&&r.candidate.resultId===result.id))invalid();}
    if(result.id!==call.resultId||result.callId!==call.id||saved.id!==call.id||!resultHasOwner(result,saved)||saved.productId!==round.context.productId||saved.productRevision!==round.context.productRevision||saved.providerId!==result.providerId||saved.model!==result.model||!result.listingContext||result.sourceSha256!==round.contextHash||listingFingerprint(result.listingContext)!==round.contextHash||result.output.kind!==(call.id===round.candidate.id?'amazon-fields':'amazon-fields-review')||call.id!==round.candidate.id&&result.sourceResultIds[0]!==round.candidate.resultId)invalid();return result;
  }
}

/** A draft transaction may commit adoption before the coordinator saves resolved. */
function committedAdoption(draft:AmazonDraft|undefined,round:CompletionRound):boolean {
  const adoption=round.adoptionId&&draft?.fieldAdoptions?.find(value=>value.id===round.adoptionId);
  if(!adoption)return false;
  if(draft!.id!==round.context.draftId||adoption.contextSha256!==round.contextHash||adoption.suggestionResultId!==round.candidate.resultId||adoption.reviewResultId!==(round.review?.resultId??null)||adoption.fromRevision!==round.context.draftRevision||adoption.toRevision!==round.context.draftRevision+1||adoption.toRevision>draft!.revision)invalid();
  return true;
}

export function assertCompletionHistory(db:DatabaseSync):void {
  const journal=new CompletionJournal(db),ids=new Set<string>();
  for(const op of completionOperations(db)){
    const draftRow=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(op.draftId),draft=draftRow?JSON.parse(String(draftRow.record_json)).draft as AmazonDraft:undefined;
    if(!draft&&!['GUARD','RETIRED'].includes(op.state)||draft&&completionSafetyScope(draft)!==op.safetyScopeHash)invalid();
    for(const round of op.rounds){
      if(round.adoptionId&&!committedAdoption(draft,round)&&round.resolved)invalid();
      for(const [kind,entry] of [['candidate',round.candidate],['review',round.review]] as const)for(const call of entry?[...(entry.previous??[]),entry]:[]){
        if(ids.has(call.id))invalid();ids.add(call.id);
        if(call.resultId)journal.result(call,round);
        const callRow=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id),usageRow=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(call.id);
        if(call.sent){
          if(!usageRow||!callRow&&op.state!=='GUARD')invalid();const usage=validateAiUsageRecord(JSON.parse(String(usageRow.record_json)));
          if(usage.id!==call.id||usage.providerId!==(kind==='candidate'?'deepseek':'deepseek-review'))invalid();
          if(callRow){const saved=validateAiCall(JSON.parse(String(callRow.record_json)));if(saved.id!==call.id||saved.productId!==round.context.productId||saved.productRevision!==round.context.productRevision||saved.providerId!==usage.providerId||saved.startedAt!==usage.startedAt)invalid();}
        }else if(callRow||usageRow||db.prepare('SELECT id FROM ai_results WHERE json_extract(record_json,\'$.callId\')=?').get(call.id))invalid();
      }
    }
  }
  for(const row of db.prepare('SELECT record_json FROM automatic_listing_tasks').all())for(const item of JSON.parse(String(row.record_json)).items??[]){const id=item.repair?.operationId;if(id&&journal.get(id).draftId!==item.draftId)invalid();}
  for(const row of db.prepare('SELECT record_json FROM image_workflow_runs').all()){const run=JSON.parse(String(row.record_json)),id=run.contentPreparation?.operationId;if(id&&journal.get(id).draftId!==run.draftId)invalid();}
}

/** Missing results in an old backup are safety guards only, never imported AI evidence. */
export function retainCompletionOperations(current:DatabaseSync,snapshot:DatabaseSync):void {
  if(!current.prepare("SELECT 1 FROM sqlite_master WHERE name='listing_completion_operations' AND type='table'").get())return;
  assertCompletionHistory(current);
  const previousRecords=new Map(completionOperations(snapshot).map(op=>[op.id,op])),snapshotJournal=new CompletionJournal(snapshot);
  for(const op of completionOperations(current)){
    if(!op.legacyRecovery&&!op.rounds.some(r=>wasSent(r.candidate)||wasSent(r.review)))continue;
    const previous=previousRecords.get(op.id),currentDraftRow=current.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(op.draftId),currentDraft=currentDraftRow?JSON.parse(String(currentDraftRow.record_json)).draft as AmazonDraft:undefined;
    if(previous&&(previous.draftId!==op.draftId||previous.scopeHash!==op.scopeHash||previous.safetyScopeHash!==op.safetyScopeHash))invalid();
    if(previous)for(let i=0;i<Math.min(previous.rounds.length,op.rounds.length);i++){const a=previous.rounds[i],b=op.rounds[i];if(a.contextHash!==b.contextHash||(a.candidate.previous?.[0]?.id??a.candidate.id)!==(b.candidate.previous?.[0]?.id??b.candidate.id)||(a.review?.previous?.[0]?.id??a.review?.id)!==(b.review?.previous?.[0]?.id??b.review?.id))invalid();}
    // The selected backup owns reusable results. Sent facts are the monotonic union
    // of both histories, so restoring forwards or backwards never erases a request.
    const retained=structuredClone(previous&&previous.rounds.length>=op.rounds.length?previous:op);
    let missing=false;
    const draftRow=snapshot.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(retained.draftId),draft=draftRow?JSON.parse(String(draftRow.record_json)).draft as AmazonDraft:undefined;
    if(!draft&&retained.legacyRecovery)missing=true;
    for(const [index,round] of retained.rounds.entries()){
      const local=op.rounds[index],prior=previous?.rounds[index];
      round.resolved=!!(local?.resolved||prior?.resolved||local&&committedAdoption(currentDraft,local));
      if(local?.adoptionId&&prior?.adoptionId&&local.adoptionId!==prior.adoptionId)invalid();
      round.adoptionId=prior?.adoptionId??local?.adoptionId??null;
      for(const kind of ['candidate','review'] as const){
        const localEntry=local?.[kind],priorEntry=prior?.[kind];
        const localCalls=localEntry?[...(localEntry.previous??[]),localEntry]:[],priorCalls=priorEntry?[...(priorEntry.previous??[]),priorEntry]:[];
        for(let i=0;i<Math.min(localCalls.length,priorCalls.length);i++)if(localCalls[i].id!==priorCalls[i].id)invalid();
        const longest=localCalls.length>=priorCalls.length?localCalls:priorCalls;if(!longest.length)continue;
        const combined=longest.map(item=>{const l=localCalls.find(c=>c.id===item.id),p=priorCalls.find(c=>c.id===item.id);if(l?.resultId&&p?.resultId&&l.resultId!==p.resultId)invalid();return{id:item.id,sent:!!(l?.sent||p?.sent),resultId:p?.resultId??null};});
        const call=combined.at(-1)!;round[kind]={...call,...(combined.length>1?{previous:combined.slice(0,-1)}:{})};
        if(call.sent&&!call.resultId||combined.some(c=>c.sent&&!snapshot.prepare('SELECT id FROM ai_calls WHERE id=?').get(c.id)))missing=true;
      }
      // A prepared GUARD has deliberately cleared its result references. Only
      // an intact snapshot round can prove adoption; mixed local refs cannot.
      const adopted=!!prior?.candidate.resultId&&(!prior.review||!!prior.review.resultId)&&committedAdoption(draft,prior);
      const review=round.review?.resultId?snapshotJournal.result(round.review,round):undefined;
      const candidate=round.candidate.resultId?snapshotJournal.result(round.candidate,round):undefined;
      const candidateOutput=candidate?.output.kind==='amazon-fields'?candidate.output:undefined;
      const checked=candidateOutput?{...candidateOutput,candidates:[...candidateOutput.candidates,...candidateOutput.rejectedCandidates??[]]}:undefined;
      const nativeRejected=isFullSchema(round.context)&&!!checked&&!!draft&&(nativeCandidateIssues(checked,round.context).length>0||fullCopyPolicyIssues(checked).length>0);
      const rejected=review?.output.kind==='amazon-fields-review'&&review.output.verdict!=='PASS'||nativeRejected;
      // A guard forgets adoption references, but not that this round was resolved.
      // Exact negative reviews prove no adoption was needed; replay their local
      // checkpoint when the snapshot stopped immediately after saving the result.
      if(round.resolved&&!adopted&&(round.adoptionId!==null||!rejected))missing=true;
      if(rejected&&!prior?.resolved&&index===retained.rounds.length-1)round.resolved=false;
    }
    if(missing){retained.state='GUARD';for(const round of retained.rounds){round.candidate.resultId=null;if(round.review)round.review.resultId=null;round.adoptionId=null;}}
    else if(retained.state==='GUARD')retained.state='ACTIVE';
    retained.revision=previous?.revision??retained.revision;save(snapshot,retained);
  }
  assertCompletionHistory(snapshot);
}

/** Runs inside Amazon draft retention's transaction, before deleting expired drafts. */
export function retireCompletionDrafts(db:DatabaseSync,cutoff:string):void {
  for(const row of db.prepare('SELECT id,record_json FROM listing_drafts WHERE created_at < ?').all(cutoff)){
    const operations=completionOperations(db,String(row.id));if(!operations.length)continue;
    const draft=JSON.parse(String(row.record_json)).draft as AmazonDraft;
    for(const op of operations){
      op.state=op.legacyRecovery||op.rounds.some(round=>wasSent(round.candidate)||wasSent(round.review))?'GUARD':'RETIRED';
      for(const round of op.rounds){round.resolved=committedAdoption(draft,round)||round.resolved;round.candidate.resultId=null;if(round.review)round.review.resultId=null;round.adoptionId=null;}
      save(db,op);
    }
  }
}
