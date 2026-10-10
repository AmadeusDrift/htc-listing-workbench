import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { boundedText, date, integer, keys, sha256, uuid, validateAiCall, validateStoredAiResult } from '../ai/validation.ts';
import { listingFingerprint, validateListingContext } from './validation.ts';
import { validateAiUsageRecord } from '../ai/usage.ts';

export interface CompletionCall { id:string; sent:boolean; resultId:string|null }
export interface CompletionRound {
  context:ListingAiContext; contextHash:string; candidate:CompletionCall; review:CompletionCall|null;
  resolved:boolean; adoptionId:string|null;
}
export interface CompletionOperation {
  id:string; revision:number; draftId:string; scopeHash:string; safetyScopeHash:string; safetyIdentity:ReturnType<typeof completionSafetyIdentity>; copyReviewEnabled:boolean; state:'ACTIVE'|'DONE'|'GUARD'|'RETIRED';
  draftRevision:number; draftStamp:string; rounds:CompletionRound[]; remaining:string[];
  reviewIssues:{field:string;message:string}[]; createdAt:string; updatedAt:string;
}
export interface CompletionRequest { operationId:string; callId:string; contextHash:string }
export function completionDraftStamp(draft:AmazonDraft):string {return listingFingerprint({id:draft.id,revision:draft.revision,productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,targetId:draft.targetId,sellerId:draft.sellerId,marketplaceId:draft.marketplaceId,listingProgram:draft.listingProgram,schema:draft.schema,attributes:draft.attributes,salesPlan:draft.salesPlan??null});}
/** Credential reconnects and a recreated draft cannot erase a request for the same source sale. */
export function completionSafetyIdentity(draft:Pick<AmazonDraft,'productId'|'productRevision'|'variantId'|'sku'|'mode'|'sellerId'|'marketplaceId'|'listingProgram'|'salesPlan'>){return {mode:draft.mode,productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,sellerId:draft.sellerId,marketplaceId:draft.marketplaceId,listingProgram:draft.listingProgram,recipeHash:listingFingerprint(draft.salesPlan?.recipe??null)};}
export function completionSafetyScope(draft:AmazonDraft):string{return listingFingerprint(completionSafetyIdentity(draft));}
function invalid():never {throw new UserFacingError('字段请求进度证据无效，未自动重发');}
export const unknownCompletion=():never=>{throw new UserFacingError('上次字段请求结果尚未确认，已保留进度，未自动重发');};
function parseCall(raw:unknown):CompletionCall {
  const o=keys(raw,['id','sent','resultId']);if(typeof o.sent!=='boolean'||o.resultId!==null&&!o.sent)invalid();
  return {id:uuid(o.id),sent:o.sent as boolean,resultId:o.resultId===null?null:uuid(o.resultId)};
}
export function validateCompletionOperation(raw:unknown):CompletionOperation {
  const o=keys(raw,['id','revision','draftId','scopeHash','safetyScopeHash','safetyIdentity','copyReviewEnabled','state','draftRevision','draftStamp','rounds','remaining','reviewIssues','createdAt','updatedAt']);
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
  const ids=rounds.flatMap(r=>[r.candidate.id,...(r.review?[r.review.id]:[])]);if(new Set(ids).size!==ids.length||rounds.slice(0,-1).some(r=>!r.resolved))invalid();
  if(o.state==='GUARD'&&!rounds.some(r=>r.candidate.sent||r.review?.sent)||o.state==='DONE'&&rounds.some(r=>[r.candidate,r.review].some(call=>call?.sent&&!call.resultId)))invalid();
  if(o.state==='RETIRED'&&rounds.some(r=>r.candidate.sent||r.review?.sent))invalid();
  const reviewIssues=(o.reviewIssues as unknown[]).map(raw=>{const issue=keys(raw,['field','message']);return{field:boundedText(issue.field,100),message:boundedText(issue.message,2000)};});
  const createdAt=date(o.createdAt),updatedAt=date(o.updatedAt);if(updatedAt<createdAt)invalid();
  return{id:uuid(o.id),revision:integer(o.revision,1,Number.MAX_SAFE_INTEGER),draftId:uuid(o.draftId),scopeHash:sha256(o.scopeHash),safetyScopeHash:sha256(o.safetyScopeHash),safetyIdentity,copyReviewEnabled:o.copyReviewEnabled as boolean,state:o.state as CompletionOperation['state'],draftRevision:integer(o.draftRevision,1,Number.MAX_SAFE_INTEGER),draftStamp:sha256(o.draftStamp),rounds,remaining:(o.remaining as unknown[]).map(v=>boundedText(v,2000)),reviewIssues,createdAt,updatedAt};
}
export function completionOperations(db:DatabaseSync,draftId?:string):CompletionOperation[] {
  return db.prepare('SELECT id,record_json FROM listing_completion_operations'+(draftId?" WHERE json_extract(record_json,'$.draftId')=?":'')+' ORDER BY rowid').all(...(draftId?[draftId]:[])).map(row=>{
    const op=validateCompletionOperation(JSON.parse(String(row.record_json)));if(op.id!==row.id)invalid();return op;
  });
}
function save(db:DatabaseSync,raw:CompletionOperation):CompletionOperation {
  const op=validateCompletionOperation(raw),existing=db.prepare('SELECT id FROM listing_completion_operations WHERE id=?').get(op.id);
  if(existing){op.revision++;const result=db.prepare("UPDATE listing_completion_operations SET record_json=? WHERE id=? AND json_extract(record_json,'$.revision')=?").run(JSON.stringify(op),op.id,raw.revision);if(result.changes!==1)throw new UserFacingError('字段操作已由另一请求推进，请重新读取原操作');}
  else db.prepare('INSERT INTO listing_completion_operations(id,record_json) VALUES(?,?)').run(op.id,JSON.stringify(op));
  raw.revision=op.revision;return op;
}
export class CompletionJournal {
  private db:DatabaseSync;
  constructor(db:DatabaseSync){this.db=db;}
  get(id:string):CompletionOperation { const row=this.db.prepare('SELECT record_json FROM listing_completion_operations WHERE id=?').get(uuid(id));if(!row)invalid();const op=validateCompletionOperation(JSON.parse(String(row.record_json)));if(op.id!==id)invalid();return op; }
  list(draftId:string):CompletionOperation[]{return completionOperations(this.db,draftId);}
  saleOperations(input:ReturnType<typeof completionSafetyIdentity>):CompletionOperation[]{
    const fields=['mode','productId','productRevision','variantId','sku','sellerId','marketplaceId','listingProgram','recipeHash'] as const;
    return this.db.prepare('SELECT id,record_json FROM listing_completion_operations WHERE '+fields.map(name=>`json_extract(record_json,'$.safetyIdentity.${name}')=?`).join(' AND ')).all(...fields.map(name=>input[name])).map(row=>{const op=validateCompletionOperation(JSON.parse(String(row.record_json)));if(op.id!==row.id)invalid();return op;});
  }
  save(op:CompletionOperation):CompletionOperation{op.updatedAt=[op.updatedAt,new Date().toISOString()].sort()[1];return save(this.db,op);}
  begin(input:Pick<CompletionOperation,'draftId'|'scopeHash'|'safetyScopeHash'|'safetyIdentity'|'copyReviewEnabled'|'draftRevision'|'draftStamp'>,id?:string):CompletionOperation {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(this.db.prepare("SELECT 1 FROM automatic_listing_tasks t,json_each(t.record_json,'$.items') i WHERE json_extract(i.value,'$.draftId')=? AND json_extract(i.value,'$.repair.phase')='FIELDS_STARTED' AND json_type(i.value,'$.repair.operationId') IS NULL").get(input.draftId)
        ||this.db.prepare("SELECT 1 FROM image_workflow_runs WHERE json_extract(record_json,'$.draftId')=? AND json_extract(record_json,'$.contentPreparation.state')='STARTED' AND json_type(record_json,'$.contentPreparation.operationId') IS NULL").get(input.draftId))unknownCompletion();
      const records=this.list(input.draftId),pending=records.filter(op=>!['DONE','RETIRED'].includes(op.state));
      if(this.db.prepare("SELECT 1 FROM listing_completion_operations WHERE json_extract(record_json,'$.safetyScopeHash')=? AND json_extract(record_json,'$.draftId')!=? AND json_extract(record_json,'$.state') NOT IN ('DONE','RETIRED')").get(input.safetyScopeHash,input.draftId))unknownCompletion();
      if(pending.length>1||pending.some(op=>op.state==='GUARD'))unknownCompletion();
      const op=id?this.get(id):pending[0];
      if(pending.some(other=>other.id!==op?.id))unknownCompletion();
      if(op?.state==='RETIRED')throw new UserFacingError('原字段草稿已按保留期清理，请建立新草稿');
      if(op){if(op.draftId!==input.draftId||op.scopeHash!==input.scopeHash||op.copyReviewEnabled!==input.copyReviewEnabled)throw new UserFacingError('字段操作来源、店铺或审核策略已变化，保留原操作，未自动重发');this.db.exec('COMMIT');return op;}
      const at=new Date().toISOString(),next=save(this.db,{...input,id:randomUUID(),revision:1,state:'ACTIVE',rounds:[],remaining:[],reviewIssues:[],createdAt:at,updatedAt:at});this.db.exec('COMMIT');return next;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Invoked only inside the usage reservation transaction on this exact connection. */
  markSent(request:CompletionRequest,call:AiCall):void {
    const op=this.get(request.operationId),round=op.rounds.find(r=>[r.candidate.id,r.review?.id].includes(request.callId));
    if(op.state!=='ACTIVE'||!round||round.contextHash!==request.contextHash||call.id!==request.callId||call.productId!==round.context.productId||call.productRevision!==round.context.productRevision)invalid();
    const entry=round.candidate.id===request.callId?round.candidate:round.review!;
    if(entry.sent||entry.resultId||round.resolved)unknownCompletion();entry.sent=true;this.save(op);
  }
  /** Result/call/usage and journal result reference commit together. */
  recordResult(request:CompletionRequest,result:AiResult):void {
    const op=this.get(request.operationId),round=op.rounds.find(r=>[r.candidate.id,r.review?.id].includes(request.callId));
    if(!round||round.contextHash!==request.contextHash||result.callId!==request.callId||result.sourceSha256!==request.contextHash)invalid();
    const entry=round.candidate.id===request.callId?round.candidate:round.review!;if(!entry.sent||entry.resultId)invalid();entry.resultId=result.id;this.save(op);
  }
  unknown(id:string):boolean {
    const op=this.get(id);return op.state==='GUARD'||op.rounds.some(r=>[r.candidate,r.review].some(call=>call?.sent&&!this.result(call,r)));
  }
  result(call:CompletionCall,round:CompletionRound):AiResult|undefined {
    if(!call.resultId)return undefined;
    const row=this.db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(call.resultId),callRow=this.db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id);
    if(!row||!callRow)invalid();const result=validateStoredAiResult(JSON.parse(String(row.record_json))),saved=validateAiCall(JSON.parse(String(callRow.record_json)));
    if(result.id!==call.resultId||result.callId!==call.id||saved.id!==call.id||saved.status!=='SUCCEEDED'||saved.productId!==round.context.productId||saved.productRevision!==round.context.productRevision||saved.providerId!==result.providerId||saved.model!==result.model||saved.finishedAt!==result.createdAt||!result.listingContext||result.sourceSha256!==round.contextHash||listingFingerprint(result.listingContext)!==round.contextHash||result.output.kind!==(call.id===round.candidate.id?'amazon-fields':'amazon-fields-review')||call.id!==round.candidate.id&&result.sourceResultIds[0]!==round.candidate.resultId)invalid();return result;
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
      for(const call of [round.candidate,round.review])if(call){
        if(ids.has(call.id))invalid();ids.add(call.id);
        if(call.resultId)journal.result(call,round);
        const callRow=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id),usageRow=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(call.id);
        if(call.sent){
          if(!usageRow||!callRow&&op.state!=='GUARD')invalid();const usage=validateAiUsageRecord(JSON.parse(String(usageRow.record_json)));
          if(usage.id!==call.id||usage.providerId!==(call===round.candidate?'deepseek':'deepseek-review'))invalid();
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
    if(!op.rounds.some(r=>r.candidate.sent||r.review?.sent))continue;
    const previous=previousRecords.get(op.id),currentDraftRow=current.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(op.draftId),currentDraft=currentDraftRow?JSON.parse(String(currentDraftRow.record_json)).draft as AmazonDraft:undefined;
    if(previous&&(previous.draftId!==op.draftId||previous.scopeHash!==op.scopeHash||previous.safetyScopeHash!==op.safetyScopeHash))invalid();
    if(previous)for(let i=0;i<Math.min(previous.rounds.length,op.rounds.length);i++){const a=previous.rounds[i],b=op.rounds[i];if(a.contextHash!==b.contextHash||a.candidate.id!==b.candidate.id||a.review?.id!==b.review?.id)invalid();}
    // The selected backup owns reusable results. Sent facts are the monotonic union
    // of both histories, so restoring forwards or backwards never erases a request.
    const retained=structuredClone(previous&&previous.rounds.length>=op.rounds.length?previous:op);
    let missing=false;
    const draftRow=snapshot.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(retained.draftId),draft=draftRow?JSON.parse(String(draftRow.record_json)).draft as AmazonDraft:undefined;
    for(const [index,round] of retained.rounds.entries()){
      const local=op.rounds[index],prior=previous?.rounds[index];
      round.resolved=!!(local?.resolved||prior?.resolved||local&&committedAdoption(currentDraft,local));
      if(local?.adoptionId&&prior?.adoptionId&&local.adoptionId!==prior.adoptionId)invalid();
      round.adoptionId=prior?.adoptionId??local?.adoptionId??null;
      for(const kind of ['candidate','review'] as const){
        const call=round[kind];if(!call)continue;
        const localCall=local?.[kind],priorCall=prior?.[kind];
        call.sent=!!(localCall?.sent||priorCall?.sent);
        if(localCall?.resultId&&priorCall?.resultId&&localCall.resultId!==priorCall.resultId)invalid();
        call.resultId=priorCall?.resultId??null;
        if(call.sent&&!call.resultId)missing=true;
      }
      // A prepared GUARD has deliberately cleared its result references. Only
      // an intact snapshot round can prove adoption; mixed local refs cannot.
      const adopted=!!prior?.candidate.resultId&&(!prior.review||!!prior.review.resultId)&&committedAdoption(draft,prior);
      const review=round.review?.resultId?snapshotJournal.result(round.review,round):undefined;
      const rejected=review?.output.kind==='amazon-fields-review'&&review.output.verdict!=='PASS';
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
      op.state=op.rounds.some(round=>round.candidate.sent||round.review?.sent)?'GUARD':'RETIRED';
      for(const round of op.rounds){round.resolved=committedAdoption(draft,round)||round.resolved;round.candidate.resultId=null;if(round.review)round.review.resultId=null;round.adoptionId=null;}
      save(db,op);
    }
  }
}
