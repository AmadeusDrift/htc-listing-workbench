import { validateAiUsageRecord } from './usage.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AiCall,AiResult } from '../../shared/ai-contracts.ts';
import type { AiPurposeSnapshot } from '../../shared/ai-purpose-contracts.ts';
import type { CompletionRequest } from '../listing-ai/completion-journal.ts';
import { validatePurposeSnapshot } from './purpose-routing.ts';
import { validateAiCall,validateStoredAiResult } from './validation.ts';
import { keys,uuid,sha256,boundedText,integer } from './primitives.ts';
import { listingFingerprint } from '../json-fingerprint.ts';
import { transaction } from '../application/transaction.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { resultHasOwner } from './result-owner.ts';

export const COPY_REVIEW_TABLES={ai_copy_review_upgrades:['id','record_json']};
type Leg={callId:string;sent:boolean;resultId:string|null};
export interface CopyReviewUpgrade {id:string;revision:number;scopeHash:string;scope:unknown;contextHash:string;snapshot:AiPurposeSnapshot;completion:CompletionRequest|null;first:Leg;second:Leg|null;reason:string|null}
const invalid=():never=>{throw new UserFacingError('文案升级复核证据无效，已保留原调用，未自动重发');};
export function validateCopyReviewUpgrade(raw:unknown):CopyReviewUpgrade{
 const o=keys(raw,['id','revision','scopeHash','scope','contextHash','snapshot','completion','first','second','reason']);
 const leg=(v:unknown):Leg=>{const l=keys(v,['callId','sent','resultId']);if(typeof l.sent!=='boolean'||l.resultId!==null&&!l.sent)invalid();return{callId:uuid(l.callId),sent:l.sent as boolean,resultId:l.resultId===null?null:uuid(l.resultId)};};
 const scope=o.scope as Record<string,unknown>;if(!scope||typeof scope!=='object')invalid();
 if('suggestionId' in scope){keys(scope,['suggestionId']);uuid(scope.suggestionId);}else{keys(scope,['currentCopy']);if(!Array.isArray(scope.currentCopy))invalid();for(const value of scope.currentCopy as unknown[]){const c=keys(value,['field','values']);boundedText(c.field,200);if(!Array.isArray(c.values)||c.values.some(v=>typeof v!=='string'))invalid();}}
 if(o.scopeHash!==listingFingerprint({contextHash:o.contextHash,scope,completion:o.completion}))invalid();
 const first=leg(o.first),second=o.second===null?null:leg(o.second),snapshot=validatePurposeSnapshot(o.snapshot);
 let completion:CompletionRequest|null=null;if(o.completion!==null){const c=keys(o.completion,['operationId','callId','contextHash']);completion={operationId:uuid(c.operationId),callId:uuid(c.callId),contextHash:sha256(c.contextHash)};if(completion.callId!==first.callId||completion.contextHash!==o.contextHash)invalid();}
 const reason=o.reason===null?null:boundedText(o.reason,12000);
 if(o.id!==first.callId||snapshot.purposeId!=='copy_review'||second&&(!snapshot.upgrade||!first.sent||!reason||second.callId===first.callId))invalid();
 return{id:uuid(o.id),revision:integer(o.revision,0,Number.MAX_SAFE_INTEGER),scopeHash:sha256(o.scopeHash),scope,contextHash:sha256(o.contextHash),snapshot,completion,first,second,reason};
}
export function copyReviewReason(result:AiResult):string|null{
 const out=result.output;if((out.kind!=='amazon-fields-review'&&out.kind!=='listing-current-review')||out.verdict==='PASS')return null;
 const reasons=out.checks.flatMap(c=>[c,...c.claims].filter(v=>v.verdict==='UNSUPPORTED'||v.verdict==='CONTRADICTED').map(v=>`${c.field}: ${v.verdict}: ${v.reason}`));
 return reasons.length?[...new Set(reasons)].join('\n').slice(0,12000):null;
}
export function readCopyReview(db:DatabaseSync,id:string):CopyReviewUpgrade|undefined{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_copy_review_upgrades'").get())return;
 const row=db.prepare('SELECT record_json FROM ai_copy_review_upgrades WHERE id=?').get(id);if(!row)return;const v=validateCopyReviewUpgrade(JSON.parse(String(row!.record_json)));if(v.id!==id)invalid();return v;
}
function save(db:DatabaseSync,value:CopyReviewUpgrade):void{
 const v=validateCopyReviewUpgrade(value),old=readCopyReview(db,v.id);v.revision++;
 if(old){if(old.revision!==value.revision)invalid();const update=db.prepare("UPDATE ai_copy_review_upgrades SET record_json=? WHERE id=? AND json_extract(record_json,'$.revision')=?").run(JSON.stringify(v),v.id,value.revision);if(update.changes!==1)invalid();}
 else db.prepare('INSERT INTO ai_copy_review_upgrades VALUES(?,?)').run(v.id,JSON.stringify(v));value.revision=v.revision;
}
export function copyReviewResult(db:DatabaseSync,op:CopyReviewUpgrade,second=false):AiResult|undefined{
 const leg=second?op.second:op.first;if(!leg?.resultId)return;
 const row=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(leg.resultId),owner=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(leg.callId);if(!row||!owner)invalid();
 const result=validateStoredAiResult(JSON.parse(String(row!.record_json))),call=validateAiCall(JSON.parse(String(owner!.record_json))),routing=second?{...op.snapshot.upgrade!,upgradePurposeId:null,upgrade:null}:op.snapshot;
 if(!['amazon-fields-review','listing-current-review'].includes(result.output.kind)||call.providerId!==(routing.gateway==='openrouter'?'openrouter-review':'deepseek-review'))invalid();
 const expectedScope=result.output.kind==='listing-current-review'?{currentCopy:result.output.currentListingCopy}:{suggestionId:result.sourceResultIds[0]};if(listingFingerprint(expectedScope)!==listingFingerprint(op.scope))invalid();
 if(result.id!==leg.resultId||result.callId!==leg.callId||!resultHasOwner(result,call)||call.status!=='SUCCEEDED'||result.sourceSha256!==op.contextHash||listingFingerprint(call.purposeSnapshot)!==listingFingerprint(routing))invalid();
 if(second){const first=copyReviewResult(db,op);if(!first)invalid();if(first!.output.kind!==result.output.kind||listingFingerprint(first!.sourceResultIds)!==listingFingerprint(result.sourceResultIds)||copyReviewReason(first!)!==op.reason||first!.output.kind==='listing-current-review'&&result.output.kind==='listing-current-review'&&first!.output.copySha256!==result.output.copySha256)invalid();}
 return result;
}
export interface ReviewHooks {id:string;sent:(call:AiCall)=>void;result:(result:AiResult)=>void}
/** Unfinished executions resume their original calls; explicit current-copy rechecks may start only after a terminal result. */
export async function runCopyReview(db:DatabaseSync,input:{contextHash:string;scope:unknown;snapshot:()=>AiPurposeSnapshot;completion?:CompletionRequest;signal?:AbortSignal;fresh:()=>Promise<void>;invoke:(snapshot:AiPurposeSnapshot,hooks:ReviewHooks,completion?:CompletionRequest)=>Promise<AiResult>;freshCompleted?:boolean;canResume?:(callId:string)=>boolean;budget?:()=>void;link?:(result:AiResult)=>void}):Promise<AiResult>{
 await input.fresh();input.signal?.throwIfAborted();
 const scopeHash=listingFingerprint({contextHash:input.contextHash,scope:input.scope,completion:input.completion??null});
 let op=transaction(db,()=>{const row=db.prepare("SELECT id FROM ai_copy_review_upgrades WHERE json_extract(record_json,'$.scopeHash')=? ORDER BY rowid DESC LIMIT 1").get(scopeHash);if(row){const previous=readCopyReview(db,String(row.id))!,first=copyReviewResult(db,previous),finished=!!copyReviewResult(db,previous,true)||!!first&&!copyReviewReason(first);if(!input.freshCompleted||!finished)return previous;}const id=input.completion?.callId??randomUUID(),owner=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(id),existing=owner?validateAiCall(JSON.parse(String(owner.record_json))):undefined;
 if(existing&&!existing.purposeSnapshot)throw new UserFacingError('旧文案复核未记录冻结升级配置；原结果保留，未自动重新付费');
 const result=existing?db.prepare("SELECT id FROM ai_results WHERE json_extract(record_json,'$.callId')=?").get(id):undefined;
 const v:CopyReviewUpgrade={id,revision:0,scopeHash,scope:input.scope,contextHash:input.contextHash,snapshot:existing?.purposeSnapshot??input.snapshot(),completion:input.completion??null,first:{callId:id,sent:!!existing,resultId:result?String(result.id):null},second:null,reason:null};save(db,v);return v;});
 const invoke=async(second:boolean):Promise<AiResult>=>{
  op=readCopyReview(db,op.id)!;const cached=copyReviewResult(db,op,second);if(cached)return cached;
  const leg=second?op.second!:op.first;if(leg.sent&&!input.canResume?.(leg.callId))throw new UserFacingError('上次文案复核请求已发送，结果尚未确认；保留原调用与费用，未自动重发');
  const snapshot=second?{...op.snapshot.upgrade!,upgradePurposeId:null,upgrade:null}:op.snapshot;
  return input.invoke(snapshot,{id:leg.callId,sent:call=>{
   const current=readCopyReview(db,op.id)!,target=second?current.second!:current.first;if(target.sent||call.id!==target.callId||listingFingerprint(call.purposeSnapshot)!==listingFingerprint(snapshot))invalid();
   if(second)input.budget?.();target.sent=true;save(db,current);
  },result:result=>{const current=readCopyReview(db,op.id)!,target=second?current.second!:current.first;if(!target.sent||target.resultId||result.callId!==target.callId||result.sourceSha256!==current.contextHash)invalid();target.resultId=result.id;if(!second)current.reason=copyReviewReason(result);save(db,current);copyReviewResult(db,current,second);if(second)input.link?.(result);}},second?undefined:input.completion);
 };
 const first=await invoke(false),reason=copyReviewReason(first);if(!reason)return first;
 await input.fresh();input.signal?.throwIfAborted();op=readCopyReview(db,op.id)!;
 if(!op.snapshot.upgrade)throw new UserFacingError('常规文案复核存在具体不确定或冲突，但本次冻结配置未指定升级目标；原结论与费用已保留');
 if(!op.second)transaction(db,()=>{op=readCopyReview(db,op.id)!;if(!op.second){input.budget?.();op.reason=reason;op.second={callId:randomUUID(),sent:false,resultId:null};save(db,op);}});
 return invoke(true);
}
export function assertCopyReviewHistory(db:DatabaseSync):void{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_copy_review_upgrades'").get())return;
 const callIds=new Set<string>();
 for(const row of db.prepare('SELECT id FROM ai_copy_review_upgrades').all()){
  const op=readCopyReview(db,String(row.id))!;for(const leg of [op.first,op.second])if(leg){if(callIds.has(leg.callId))invalid();callIds.add(leg.callId);}
  for(const [second,leg] of [[false,op.first],[true,op.second]] as const){if(!leg)continue;const call=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(leg.callId),usage=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(leg.callId);if(leg.sent){if(!call||!usage)invalid();const c=validateAiCall(JSON.parse(String(call!.record_json))),u=validateAiUsageRecord(JSON.parse(String(usage!.record_json)));if(u.id!==c.id||u.providerId!==c.providerId||u.startedAt!==c.startedAt)invalid();if(c.id!==leg.callId||c.presentationContext?.sourceSha256!==op.contextHash||listingFingerprint(c.purposeSnapshot)!==listingFingerprint(second?{...op.snapshot.upgrade!,upgradePurposeId:null,upgrade:null}:op.snapshot))invalid();}else if(call||usage||leg.resultId)invalid();copyReviewResult(db,op,second);}
 }
}


/** Backward restore retains paid identities, never imports later product conclusions. */
export function retainCopyReviewHistory(current:DatabaseSync,snapshot:DatabaseSync):void{
 if(!current.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_copy_review_upgrades'").get())return;
 assertCopyReviewHistory(current);
 for(const row of current.prepare('SELECT id FROM ai_copy_review_upgrades').all()){
  const local=readCopyReview(current,String(row.id))!,prior=readCopyReview(snapshot,local.id);
  if(prior&&(prior.scopeHash!==local.scopeHash||listingFingerprint(prior.snapshot)!==listingFingerprint(local.snapshot)||prior.second&&local.second&&prior.second.callId!==local.second.callId))invalid();
  const merged=structuredClone(local);merged.revision=prior?.revision??0;merged.second??=prior?.second??null;merged.reason??=prior?.reason??null;
  for(const [which,leg] of [['first',merged.first],['second',merged.second]] as const){
   if(!leg)continue;const old=prior?.[which];leg.sent ||=old?.sent??false;
   const owner=current.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(leg.callId),saved=snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(leg.callId);
   if(owner){const call=validateAiCall(JSON.parse(String(owner.record_json)));if(saved){const other=validateAiCall(JSON.parse(String(saved.record_json)));if(call.id!==other.id||call.startedAt!==other.startedAt||call.providerId!==other.providerId||listingFingerprint(call.purposeSnapshot)!==listingFingerprint(other.purposeSnapshot))invalid();}else snapshot.prepare('INSERT INTO ai_calls VALUES(?,?)').run(call.id,JSON.stringify({...call,status:'FAILED',errorCode:call.errorCode??'INTERRUPTED',finishedAt:call.finishedAt??call.startedAt}));}
   leg.resultId=[old?.resultId,leg.resultId].find(id=>id&&snapshot.prepare('SELECT 1 FROM ai_results WHERE id=?').get(id))??null;
  }
  save(snapshot,merged);
 }
 assertCopyReviewHistory(snapshot);
}
