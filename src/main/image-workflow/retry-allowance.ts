import { validateAiCall } from '../ai/validation.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ImageRetryAllowance, ImageRetryGrantRef, ImageSlotAttempt, ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { imageSlotAttemptLimit } from '../../shared/image-workflow-contracts.ts';
import { date, integer, keys, uuid, uuidList, boundedText } from '../ai/primitives.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { listingFingerprint } from '../json-fingerprint.ts';
import { appendAuditEvent } from '../storage/audit.ts';
import { assertRecordTable } from '../storage/record-table.ts';
export const IMAGE_RETRY_TABLES={image_retry_allowances:['id','record_json']};
const POLICY='historical-image-retry/v1';
interface Scope {runId:string;slot:number;requestId:string;planningCallIds?:string[]}
interface Policy {version:1;kind:'policy';id:typeof POLICY;at:string;scopes:Scope[]}
export interface ImageRetryGrant extends ImageRetryGrantRef {version:1;kind:'grant';runId:string;draftId:string;productId:string;mode:'manual'|'historical';at:string;checkpointAt:string;/** Evidence only: never adopted as workflow conclusions. */savedAttempts:ImageSlotAttempt[];planningCallIds?:string[];initialPlanningCallIds?:string[];savedPlanningCalls?:import('../../shared/ai-contracts.ts').AiCall[]}
const invalid=():never=>{throw new UserFacingError('图片追加额度记录不完整或归属不一致');};
const has=(db:DatabaseSync)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='image_retry_allowances'").get();
export function validateRetryAllowance(raw:unknown):ImageRetryAllowance {
 const value=keys(raw,['version','grants']);if(value.version!==1||!Array.isArray(value.grants)||!value.grants.length)invalid();
 const grants=(value.grants as unknown[]).map(value=>{const r=keys(value,['id','slot','afterAttempt','requestId','scope']);if(!['generation','planning'].includes(String(r.scope)))invalid();return{id:uuid(r.id),slot:integer(r.slot,1,7),afterAttempt:integer(r.afterAttempt,1,Number.MAX_SAFE_INTEGER),requestId:uuid(r.requestId),scope:r.scope as 'generation'|'planning'};});
 if(new Set(grants.map(r=>r.id)).size!==grants.length)invalid();return{version:1,grants};
}
function parse(raw:unknown):Policy|ImageRetryGrant {
 const v=raw as Policy|ImageRetryGrant;if(v?.version!==1)invalid();
 if(v.kind==='policy'){keys(v,['version','kind','id','at','scopes']);if(v.id!==POLICY||!Array.isArray(v.scopes))invalid();date(v.at);for(const scope of v.scopes){keys(scope,['runId','slot','requestId'],['planningCallIds']);if(scope.planningCallIds)uuidList(scope.planningCallIds,Number.MAX_SAFE_INTEGER);uuid(scope.runId);integer(scope.slot,1,7);uuid(scope.requestId);}if(new Set(v.scopes.map(s=>s.runId+':'+s.slot)).size!==v.scopes.length)invalid();return v;}
 keys(v,['version','kind','id','slot','afterAttempt','requestId','runId','draftId','productId','mode','at','checkpointAt','savedAttempts','scope'],['planningCallIds','initialPlanningCallIds','savedPlanningCalls']);if(v.kind!=='grant'||!['manual','historical'].includes(v.mode))invalid();
 if(v.scope==='planning'){uuidList(v.initialPlanningCallIds,Number.MAX_SAFE_INTEGER,3);uuidList(v.planningCallIds,Number.MAX_SAFE_INTEGER,3);if(!Array.isArray(v.savedPlanningCalls))invalid();v.savedPlanningCalls!.forEach(validateAiCall);}else if(v.initialPlanningCallIds||v.planningCallIds||v.savedPlanningCalls)invalid();validateRetryAllowance({version:1,grants:[ref(v)]});uuid(v.runId);uuid(v.draftId);uuid(v.productId);date(v.at);date(v.checkpointAt);if(v.checkpointAt<v.at)invalid();
 if(!Array.isArray(v.savedAttempts)||v.savedAttempts.length<v.afterAttempt||v.savedAttempts.length>v.afterAttempt+3)invalid();
 for(const [index,a] of v.savedAttempts.entries()){keys(a,['number','requestId','state','planResultId','candidateId','ipReviewResultId','ocrResultId','reviewResultId','error'],['failureProof','planReuse','appearanceReview','riskPolicy','textReviewPolicyVersion','approvalPolicy','riskBypass']);for(const key of ['planResultId','candidateId','ipReviewResultId','ocrResultId','reviewResultId'] as const)if(a[key]!==null)uuid(a[key]);if(a.error!==null)boundedText(a.error,2000);if(a.number!==index+1||!['PLANNING','READY','GENERATING','GENERATED','PASSED','RETRYABLE_FAILURE','BLOCKED','UNKNOWN'].includes(a.state))invalid();uuid(a.requestId);if(a.failureProof){keys(a.failureProof,['version','kind','at']);if(a.failureProof.version!==1||a.failureProof.kind!=='provider-definitive')invalid();date(a.failureProof.at);}}
 if(v.savedAttempts[v.afterAttempt-1]?.requestId!==v.requestId||new Set(v.savedAttempts.map(a=>a.requestId)).size!==v.savedAttempts.length)invalid();return v;
}
const ref=(g:ImageRetryGrant):ImageRetryGrantRef=>({id:g.id,slot:g.slot,afterAttempt:g.afterAttempt,requestId:g.requestId,scope:g.scope});
function policy(db:DatabaseSync):Policy {const row=db.prepare('SELECT record_json FROM image_retry_allowances WHERE id=?').get(POLICY);if(!row)invalid();const value=parse(JSON.parse(String(row!.record_json)));if(value.kind!=='policy')invalid();return value as Policy;}
export function retryGrants(db:DatabaseSync,runId?:string):ImageRetryGrant[]{if(!has(db))return[];return (runId?db.prepare("SELECT id,record_json FROM image_retry_allowances WHERE json_extract(record_json,'$.runId')=?").all(runId):db.prepare("SELECT id,record_json FROM image_retry_allowances WHERE id<>?").all(POLICY)).map(row=>{const v=parse(JSON.parse(String(row.record_json)));if(v.kind!=='grant'||v.id!==row.id)invalid();return v as ImageRetryGrant;}).filter(g=>!runId||g.runId===runId);}
/** Migration boundary freezes all existing failed identities, never page reads. */
export function initializeImageRetryAllowances(db:DatabaseSync):void {
 db.exec('CREATE TABLE image_retry_allowances(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');
 const scopes:Scope[]=[];
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='image_workflow_runs'").get())for(const row of db.prepare('SELECT id,record_json FROM image_workflow_runs').all()){
  const run=JSON.parse(String(row.record_json)) as ImageWorkflowRun;
  for(const slot of run.slots??[]){const last=slot.attempts.at(-1);if(last&&((slot.status==='FAILED'&&last.state==='RETRYABLE_FAILURE')||last.state==='PLANNING'&&['FAILED','BLOCKED','INTERRUPTED'].includes(run.status)))scopes.push({runId:uuid(row.id),slot:integer(slot.index,1,7),requestId:uuid(last.requestId),...(last.state==='PLANNING'?{planningCallIds:planningCalls(db,run,slot.index).map(c=>c.id)}:{})});}
 }
 const value:Policy={version:1,kind:'policy',id:POLICY,at:new Date().toISOString(),scopes};db.prepare('INSERT INTO image_retry_allowances VALUES(?,?)').run(POLICY,JSON.stringify(value));
}
export function retryHistoryGap(db:DatabaseSync,run:ImageWorkflowRun):ImageRetryGrant|undefined {
 return retryGrants(db).filter(g=>g.runId===run.id||run.retryAllowance?.grants.some(r=>r.id===g.id)).find(g=>g.savedAttempts.some((a,i)=>run.slots?.[g.slot-1]?.attempts[i]?.requestId!==a.requestId));
}
export function assertRetryAllowanceRun(db:DatabaseSync,run:ImageWorkflowRun):void {
 if(!run.retryAllowance)return;
 const all=retryGrants(db);for(const r of run.retryAllowance.grants){const grant=all.find(g=>g.id===r.id);if(!grant||listingFingerprint(ref(grant))!==listingFingerprint(r)||grant.draftId!==run.draftId||grant.productId!==run.productId||grant.runId!==run.id&&grant.runId!==run.sourceReuse?.sourceRunId||run.slots?.[r.slot-1]?.attempts[r.afterAttempt-1]?.requestId!==r.requestId)invalid();}
 for(const slot of run.slots??[]){const refs=run.retryAllowance.grants.filter(r=>r.slot===slot.index&&r.scope==='generation');for(const [i,r] of refs.entries())if(r.afterAttempt!==run.maxAttempts+3*i)invalid();
  const scoped=run.retryAllowance.grants.filter(r=>r.slot===slot.index);for(const [i,r] of scoped.entries())if(r.scope==='planning'){const grant=all.find(g=>g.id===r.id)!;if(grant.initialPlanningCallIds?.length!==3+3*i||listingFingerprint(grant.planningCallIds?.slice(0,grant.initialPlanningCallIds.length))!==listingFingerprint(grant.initialPlanningCallIds)||listingFingerprint(grant.savedPlanningCalls?.map(c=>c.id))!==listingFingerprint(grant.planningCallIds))invalid();const ownerRow=db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(grant.runId);if(!ownerRow)invalid();const owner=JSON.parse(String(ownerRow!.record_json)) as ImageWorkflowRun;if(listingFingerprint(planningCalls(db,owner,grant.slot).slice(0,grant.initialPlanningCallIds!.length).map(c=>c.id))!==listingFingerprint(grant.initialPlanningCallIds))invalid();for(const id of grant.initialPlanningCallIds!){const call=grant.savedPlanningCalls?.find(c=>c.id===id),p=call?.presentationContext;if(!call||call.status!=='FAILED'||call.errorCode!=='OUTPUT_INVALID'||!call.finishedAt||call.imagePlanRetryBlock||call.rejection||call.productId!==grant.productId||p?.workflowId!==grant.runId||p.slot!==grant.slot||p.draftId!==grant.draftId||p.variantId!==owner.variantId||call.productRevision!==owner.productRevision||p.sourceSha256!==owner.slots?.[grant.slot-1]?.contextSha256||!isPlanningCall(call))invalid();const originalRow=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(id);if(!originalRow)invalid();const original=validateAiCall(JSON.parse(String(originalRow!.record_json)));if(original.status!=='FAILED'||original.errorCode!=='OUTPUT_INVALID'||!original.finishedAt||original.imagePlanRetryBlock||original.rejection||listingFingerprint(planningIdentity(original))!==listingFingerprint(planningIdentity(call!)))invalid();}}}
}
export function historicalRetryEligible(db:DatabaseSync,run:ImageWorkflowRun,slot:number):boolean {
 if(!has(db)||retryHistoryGap(db,run))return false;const attempt=run.slots?.[slot-1]?.attempts.at(-1);
 return !!attempt&&policy(db).scopes.some(s=>(s.runId===run.id||s.runId===run.sourceReuse?.sourceRunId)&&s.slot===slot&&s.requestId===attempt.requestId&&(!s.planningCallIds||listingFingerprint(s.planningCallIds)===listingFingerprint(planningCalls(db,run,slot).map(c=>c.id))))&&!retryGrants(db).some(g=>g.mode==='historical'&&g.slot===slot&&(g.runId===run.id||g.runId===run.sourceReuse?.sourceRunId));
}
export function grantImageRetry(db:DatabaseSync,run:ImageWorkflowRun,index:number,id:string,mode:'manual'|'historical',scope:'generation'|'planning'='generation'):void {
 const slot=run.slots?.[index-1],last=slot?.attempts.at(-1);if(!slot||!last||(scope==='generation'?(slot.status!=='FAILED'||last.state!=='RETRYABLE_FAILURE'||slot.attempts.length!==imageSlotAttemptLimit(run,index)):!planningRetryExhausted(db,run,index)))throw new UserFacingError('仅额度已耗尽的明确失败图位可追加3次，不能囤积');
 if(retryHistoryGap(db,run))throw new UserFacingError('恢复的检查点早于已付费尝试，请核对保留的后续历史');
 if(mode==='historical'&&!historicalRetryEligible(db,run,index))invalid();
 const value:ImageRetryGrant={version:1,kind:'grant',scope,...(scope==='planning'?{initialPlanningCallIds:planningCalls(db,run,index).map(c=>c.id),planningCallIds:planningCalls(db,run,index).map(c=>c.id),savedPlanningCalls:planningCalls(db,run,index)}:{}),id:uuid(id),slot:index,afterAttempt:slot.attempts.length,requestId:last.requestId,runId:run.id,draftId:run.draftId,productId:run.productId,mode,at:new Date().toISOString(),checkpointAt:new Date().toISOString(),savedAttempts:structuredClone(slot.attempts)};parse(value);
 db.prepare('INSERT INTO image_retry_allowances VALUES(?,?)').run(value.id,JSON.stringify(value));run.retryAllowance??={version:1,grants:[]};run.retryAllowance.grants.push(ref(value));
 appendAuditEvent(db,id,run.productId,`image.retry-allowance.${mode}`,`${run.sku} 图片 ${index} 追加3次；未清零历史与费用`,JSON.stringify({...ref(value),workflowId:run.id,mode}),value.at);
}
/** Persist consumed identities before any new request; checkpoint failures are never reset by restore. */
export function saveRetryConsumption(db:DatabaseSync,run:ImageWorkflowRun):void {
 assertRetryAllowanceRun(db,run);for(const grant of retryGrants(db).filter(g=>g.runId===run.id||run.retryAllowance?.grants.some(r=>r.id===g.id))){const previous=listingFingerprint({attempts:grant.savedAttempts,planning:grant.savedPlanningCalls??null});const attempts=run.slots?.[grant.slot-1]?.attempts??[];if(grant.savedAttempts.some((a,i)=>attempts[i]?.requestId!==a.requestId))throw new UserFacingError('旧备份缺少后续尝试检查点，已阻止重复发送');if(grant.scope==='planning'){grant.savedPlanningCalls=planningCalls(db,run,grant.slot);grant.planningCallIds=grant.savedPlanningCalls.map(c=>c.id);}const next=attempts.slice(0,grant.afterAttempt+3);if(previous===listingFingerprint({attempts:next,planning:grant.savedPlanningCalls??null}))continue;grant.savedAttempts=structuredClone(next);grant.checkpointAt=new Date(Math.max(Date.now(),Date.parse(grant.checkpointAt)+1)).toISOString();parse(grant);db.prepare('UPDATE image_retry_allowances SET record_json=? WHERE id=?').run(JSON.stringify(grant),grant.id);}
}
export function assertImageRetryHistory(db:DatabaseSync):void {
 if(!has(db))return;assertRecordTable(db,'image_retry_allowances');policy(db);const grants=retryGrants(db);
 for(const g of grants){const row=db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(g.runId);if(row)assertRetryAllowanceRun(db,JSON.parse(String(row.record_json)));}
}
/** Keep later paid history as evidence. Never fabricate adoption in an older restored checkpoint. */
export function retainImageRetryHistory(current:DatabaseSync,snapshot:DatabaseSync):void {
 if(!has(current))return;assertImageRetryHistory(current);
 const currentPolicy=policy(current);snapshot.prepare('UPDATE image_retry_allowances SET record_json=? WHERE id=?').run(JSON.stringify(currentPolicy),POLICY);
 for(const grant of retryGrants(current)){
  const old=retryGrants(snapshot).find(g=>g.id===grant.id);if(old){const {savedAttempts:prior,planningCallIds:oldCalls,savedPlanningCalls:oldHistory,checkpointAt:oldCheckpoint,...a}=old,{savedAttempts:later,planningCallIds:newCalls,savedPlanningCalls:newHistory,checkpointAt:newCheckpoint,...b}=grant;if(grant.scope==='planning'){grant.planningCallIds=[...new Set([...(oldCalls??[]),...(newCalls??[])])];grant.savedPlanningCalls=[...new Map([...(oldHistory??[]),...(newHistory??[])].map(c=>[c.id,c])).values()];}if(listingFingerprint(a)!==listingFingerprint(b))invalid();const shorter=prior.length<later.length?prior:later,longer=prior.length<later.length?later:prior;for(const [i,v] of shorter.entries()){const other=longer[i];if(v.requestId!==other.requestId||(['planResultId','candidateId'] as const).some(k=>v[k]&&other[k]&&v[k]!==other[k]))invalid();}if(prior.length!==later.length){grant.savedAttempts=longer;grant.checkpointAt=prior.length>later.length?oldCheckpoint:newCheckpoint;}else{if(oldCheckpoint===newCheckpoint&&listingFingerprint(prior)!==listingFingerprint(later))invalid();grant.savedAttempts=newCheckpoint>=oldCheckpoint?later:prior;grant.checkpointAt=newCheckpoint>=oldCheckpoint?newCheckpoint:oldCheckpoint;}}
  snapshot.prepare('INSERT INTO image_retry_allowances VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(grant.id,JSON.stringify(grant));
 }
 for(const row of snapshot.prepare('SELECT id,record_json FROM image_workflow_runs').all()){
  const run=JSON.parse(String(row.record_json)) as ImageWorkflowRun,grants=retryGrants(snapshot,run.id).sort((a,b)=>a.slot-b.slot||a.afterAttempt-b.afterAttempt);
  // Only attach grants whose original prefix exists in the snapshot. Missing
  // successors remain in the ledger and make retryHistoryGap block new sends.
  const available=grants.filter(g=>run.slots?.[g.slot-1]?.attempts[g.afterAttempt-1]?.requestId===g.requestId);
  if(available.length){run.retryAllowance={version:1,grants:available.map(ref)};snapshot.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run),row.id);}
 }
 assertImageRetryHistory(snapshot);
}

/** Row counters above the historical limit require the same trusted workflow grant. */
export function assertTaskImageRetryAllowance(db:DatabaseSync,task:import('../../shared/automatic-listing-contracts.ts').AutomaticListingTask):void {
 for(const item of task.items){const proof=item.imageRetryAllowance;if(!proof)continue;const row=db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(proof.workflowId);if(!row)invalid();const run=JSON.parse(String(row!.record_json)) as ImageWorkflowRun;assertRetryAllowanceRun(db,run);if(run.draftId!==item.draftId||run.productId!==item.productId||!proof.allowance.grants.every(g=>run.retryAllowance?.grants.some(r=>listingFingerprint(g)===listingFingerprint(r)))||item.imageAttempts>run.attempt+(run.legacyImageAttempts??0))invalid();}
}

function isPlanningCall(c:import('../../shared/ai-contracts.ts').AiCall):boolean{return c.presentationContext?.kind==='image'&&['deepseek','openrouter'].includes(c.providerId)&&(c.purposeSnapshot?['image_plan','image_plan_repair'].includes(c.purposeSnapshot.purposeId):!!c.presentationContext.imagePlanRequestSha256||c.providerId==='deepseek'&&c.model==='deepseek-flash');}
function planningIdentity(c:import('../../shared/ai-contracts.ts').AiCall){const p=c.presentationContext;return {id:c.id,providerId:c.providerId,productId:c.productId,productRevision:c.productRevision,model:c.model,generation:c.generation,startedAt:c.startedAt,purpose:c.purposeSnapshot??null,context:p?{kind:p.kind,draftId:p.draftId,variantId:p.variantId,sourceSha256:p.sourceSha256,slot:p.slot,workflowId:p.workflowId??null,requestSha:p.imagePlanRequestSha256??null}:null};}
export function planningCalls(db:DatabaseSync,run:ImageWorkflowRun,index:number):import('../../shared/ai-contracts.ts').AiCall[] {
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_calls'").get())return[];
 return db.prepare("SELECT record_json FROM ai_calls WHERE json_extract(record_json,'$.presentationContext.workflowId')=? AND json_extract(record_json,'$.presentationContext.slot')=? AND json_extract(record_json,'$.presentationContext.sourceSha256')=?").all(run.id,index,run.slots?.[index-1]?.contextSha256??'').map(row=>validateAiCall(JSON.parse(String(row.record_json)))).filter(c=>c.productId===run.productId&&c.productRevision===run.productRevision&&isPlanningCall(c));
}
export function planningRetryExhausted(db:DatabaseSync,run:ImageWorkflowRun,index:number):boolean {
 const last=run.slots?.[index-1]?.attempts.at(-1);if(!last||last.state!=='PLANNING'||last.planResultId||run.slots?.some(s=>s.status==='BLOCKED'||s.attempts.some(a=>['UNKNOWN','GENERATING'].includes(a.state))))return false;
 const calls=planningCalls(db,run,index),limit=3+3*(run.retryAllowance?.grants.filter(g=>g.slot===index).length??0);
 return calls.length===limit&&calls.every(c=>c.status==='FAILED'&&!!c.finishedAt&&!c.imagePlanRetryBlock&&!c.rejection&&c.errorCode==='OUTPUT_INVALID');
}
/** Paid planner accepts only central grants owned by this exact workflow/slot/context. */
export function imagePlanningAllowanceLimit(db:DatabaseSync,workflowId:string,context:import('../../shared/image-ai-contracts.ts').ProductImageContext):number {
 const index=context.slot?.index;if(!index)return 3;
 const row=db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(workflowId);if(!row)return 3;
 const run=JSON.parse(String(row.record_json)) as ImageWorkflowRun;if(run.productId!==context.listing.productId||run.productRevision!==context.listing.productRevision||run.draftId!==context.listing.draftId||run.slots?.[index-1]?.contextSha256!==listingFingerprint(context))return 3;
 assertRetryAllowanceRun(db,run);return 3+3*(run.retryAllowance?.grants.filter(g=>g.scope==='planning'&&g.slot===index).length??0);
}
