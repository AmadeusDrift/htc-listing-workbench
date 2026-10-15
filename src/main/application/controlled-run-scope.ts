import {assertVerifiedControlledCandidate,type VerifiedControlledCandidate} from './controlled-candidate.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
import {realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {AiRequestScope} from '../../shared/ai-request-identity-contracts.ts';
import {AiError} from '../ai/errors.ts';
import {transaction} from './transaction.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {spendObject,spendInteger,spendUuid,spendText,spendDate,spendHash,spendInvalid} from '../ai/spend-records.ts';
import {AiSpendBudget,assertSpendTransaction} from '../ai/spend-budget.ts';
import {validateFollowupRecord,followupDraftFingerprint} from '../followup/records.ts';
import type {AutomaticResumeSelection} from '../../shared/automatic-resume.ts';

export const CONTROLLED_RUN_ID='htc-250-controlled-live/v1';
export const CONTROLLED_RUN_TABLES={controlled_run_scopes:['id','record_json']};
export interface ControlledRunItem {itemKey:string;sku:string;productId:string;variantIds:string[];recipeKey:string|null;parentage:'NONE'}
export interface ControlledRunReview {version:1;sessionId:string;digest:string;initialTaskRevision:number;sourceStamps:{itemKey:string;stamp:string}[];candidate:{sourceCommit:string;sourceDigest:string;executableSha256:string;packageManifestSha256:string};secondReleased:boolean}
export interface ControlledRunScope {version:1;id:typeof CONTROLLED_RUN_ID;workspaceId:string;taskId:string;expectedTaskRevision:number;targetId:string;sellerId:string;marketplaceId:string;items:ControlledRunItem[];activeItemKey:string;authorityEpoch:number;authorityNonce?:string;review?:ControlledRunReview;createdAt:string;status:'PAUSED'|'ACTIVE'}
const authority=new AsyncLocalStorage<{scopeId:string;fingerprint:string;grant:object}>(),grants=new WeakSet<object>();
export type ControlledRunGrant=<T>(work:()=>T)=>T;
const grantObjects=new WeakMap<ControlledRunGrant,object>();
/** Revoke the actual in-flight process capability before attempting durable pause. */
export function revokeControlledRunGrant(grant:ControlledRunGrant|undefined):void{const token=grant&&grantObjects.get(grant);if(token)grants.delete(token);}
export interface ControlledEffect {kind:'source'|'schema'|'classification'|'planning'|'ai'|'ai-batch-read'|'image'|'hosting'|'platform-write'|'platform-read'|'lwa'|'task-stage';taskId?:string;itemKey?:string;productId?:string;sku?:string;targetId?:string;sellerId?:string;marketplaceId?:string;variantIds?:string[];recipeKey?:string|null;parentage?:string}
// Only the original TaskOwner may advance the expected revision in its active
// physical transaction. That progress is separate from revocable dispatch authority.
const grantFingerprint=(scope:ControlledRunScope)=>listingFingerprint({...scope,expectedTaskRevision:0});
const reviewedProcesses=new Map<string,{digest:string;candidate:VerifiedControlledCandidate;nonce:string}>();
function assertReviewedProcess(scope:ControlledRunScope):void{if(!scope.review)return;const process=reviewedProcesses.get(scope.workspaceId);if(!process||process.digest!==scope.review.digest||listingFingerprint(process.candidate.identity)!==listingFingerprint(scope.review.candidate))blocked();}
/** An actual verified main-process session is required in addition to persisted
 * review JSON. Restarting normally or reading the file never recreates a grant. */
export function permitReviewedScopeActivation(db:DatabaseSync,candidate:VerifiedControlledCandidate):()=>void{
 if(db.isTransaction)blocked();assertVerifiedControlledCandidate(candidate);const scope=readControlledRunScope(db);if(!scope?.review||scope.status!=='PAUSED'||scope.workspaceId!==workspaceIdentity(db)||listingFingerprint(scope.review.candidate)!==listingFingerprint(candidate.identity))blocked();const lease={digest:scope.review.digest,candidate,nonce:randomUUID()};reviewedProcesses.set(scope.workspaceId,lease);return()=>{if(reviewedProcesses.get(scope.workspaceId)===lease)reviewedProcesses.delete(scope.workspaceId);};
}
export class ControlledRunError extends AiError {constructor(){super('INVALID_INPUT');this.diagnosticReason='CONTROLLED_RUN_SCOPE_BLOCKED';this.message='受控验收任务、卖家、站点、SKU或当前授权不匹配；未发送';}}
function blocked():never{throw new ControlledRunError();}
const memoryWorkspaces=new WeakMap<DatabaseSync,string>();
function workspaceIdentity(db:DatabaseSync):string{
 const file=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
 if(typeof file==='string'&&file){const path=realpathSync.native(file);return listingFingerprint(process.platform==='win32'?path.toLowerCase():path);}
 let id=memoryWorkspaces.get(db);if(!id){id=listingFingerprint(randomUUID());memoryWorkspaces.set(db,id);}return id;
}
export function validateControlledRunScope(raw:unknown):ControlledRunScope{
 const r=spendObject(raw,['version','id','workspaceId','taskId','expectedTaskRevision','targetId','sellerId','marketplaceId','items','activeItemKey','authorityEpoch','createdAt','status'],['authorityNonce','review']);if(r.version!==1||r.id!==CONTROLLED_RUN_ID||!['PAUSED','ACTIVE'].includes(r.status)||!Array.isArray(r.items)||r.items.length<1||r.items.length>2||spendInteger(r.expectedTaskRevision)<1)spendInvalid();spendHash(r.workspaceId);spendInteger(r.authorityEpoch);if(r.status==='ACTIVE'&&r.authorityEpoch<1)spendInvalid();if(r.authorityNonce!==undefined)spendUuid(r.authorityNonce);
 if(r.review!==undefined){validateControlledRunReview(r.review);if(r.review.sourceStamps.length!==r.items.length||r.review.sourceStamps.some((v:{itemKey:string})=>!r.items.some((i:ControlledRunItem)=>i.itemKey===v.itemKey))||r.review.secondReleased&&r.items.length!==2||!r.review.secondReleased&&r.activeItemKey!==r.items[0].itemKey)spendInvalid();}
 spendUuid(r.taskId);spendText(r.targetId);spendText(r.sellerId);spendText(r.marketplaceId);spendDate(r.createdAt);
 for(const item of r.items){const i=spendObject(item,['itemKey','sku','productId','variantIds','recipeKey','parentage']);spendText(i.itemKey,150);spendText(i.sku);spendUuid(i.productId);if(i.parentage!=='NONE'||!Array.isArray(i.variantIds)||i.variantIds.length<1||i.variantIds.length>20||new Set(i.variantIds).size!==i.variantIds.length)spendInvalid();i.variantIds.forEach(spendUuid);if(i.recipeKey!==null)spendText(i.recipeKey);}
 if(new Set(r.items.map((i:ControlledRunItem)=>i.sku)).size!==r.items.length||new Set(r.items.map((i:ControlledRunItem)=>i.itemKey)).size!==r.items.length||!r.items.some((i:ControlledRunItem)=>i.itemKey===r.activeItemKey))spendInvalid();return r as ControlledRunScope;
}
export function validateControlledRunReview(raw:unknown):ControlledRunReview{
 const r=spendObject(raw,['version','sessionId','digest','initialTaskRevision','sourceStamps','candidate','secondReleased']);if(r.version!==1||spendInteger(r.initialTaskRevision)<1||typeof r.secondReleased!=='boolean'||!Array.isArray(r.sourceStamps)||r.sourceStamps.length<1||r.sourceStamps.length>2)spendInvalid();spendUuid(r.sessionId);spendHash(r.digest);for(const raw of r.sourceStamps){const v=spendObject(raw,['itemKey','stamp']);spendText(v.itemKey,150);spendHash(v.stamp);}if(new Set(r.sourceStamps.map((v:{itemKey:string})=>v.itemKey)).size!==r.sourceStamps.length)spendInvalid();const c=spendObject(r.candidate,['sourceCommit','sourceDigest','executableSha256','packageManifestSha256']);if(typeof c.sourceCommit!=='string'||!/^([a-f0-9]{40})$/.test(c.sourceCommit))spendInvalid();spendHash(c.sourceDigest);spendHash(c.executableSha256);spendHash(c.packageManifestSha256);return r as ControlledRunReview;
}
export function initializeControlledRunScopes(db:DatabaseSync):void{if(!db.isTransaction)spendInvalid();db.exec('CREATE TABLE controlled_run_scopes(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');}
export function readControlledRunScope(db:DatabaseSync):ControlledRunScope|null{
 const rows=db.prepare('SELECT id,record_json FROM controlled_run_scopes').all();if(rows.length>1)spendInvalid();if(!rows.length)return null;const r=validateControlledRunScope(JSON.parse(String(rows[0].record_json)));if(rows[0].id!==r.id)spendInvalid();return r;
}
function writeScope(db:DatabaseSync,r:ControlledRunScope):void{const valid=validateControlledRunScope(r);db.prepare('INSERT INTO controlled_run_scopes(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(valid.id,JSON.stringify(valid));}
/** Main-only authority. No IPC accepts a grant; a process restart loses all grant objects. */
export class ControlledRunScopes {
 private db:DatabaseSync;constructor(db:DatabaseSync){this.db=db;}
 private assertTaskRecord(scope:ControlledRunScope,task:any,requireRunning=false):void{
  if(requireRunning&&task.status!=='RUNNING'||task.id!==scope.taskId||task.revision!==scope.expectedTaskRevision||task.targetId!==scope.targetId||task.sellerId!==scope.sellerId||task.marketplaceId!==scope.marketplaceId||task.mode!=='live'||!Array.isArray(task.items)||task.items.length!==scope.items.length)blocked();
  for(const expected of scope.items){const item=task.items.find((i:any)=>i.key===expected.itemKey);if(!item||item.sku!==expected.sku||item.productId!==expected.productId||(item.salesPlan?.parentage??'NONE')!=='NONE'||(item.salesPlan?.recipe?.key??null)!==expected.recipeKey)blocked();const ids=item.salesPlan?.recipe?.components?.map((c:any)=>c.variantId)??[item.variantId];if(listingFingerprint([...new Set(ids)].sort())!==listingFingerprint([...expected.variantIds].sort()))blocked();}
 }
 private assertTask(scope:ControlledRunScope,requireRunning=false,db=this.db):void{
  if(scope.workspaceId!==workspaceIdentity(db))blocked();
  const row=db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(scope.taskId);if(!row)blocked();const task=JSON.parse(String(row.record_json));
  this.assertTaskRecord(scope,task,requireRunning);
 }
 register(input:Pick<ControlledRunScope,'taskId'|'expectedTaskRevision'|'targetId'|'sellerId'|'marketplaceId'|'items'>):ControlledRunScope{
  return transaction(this.db,()=>{if(readControlledRunScope(this.db))blocked();const record=validateControlledRunScope({version:1,id:CONTROLLED_RUN_ID,...input,workspaceId:workspaceIdentity(this.db),activeItemKey:input.items[0]?.itemKey,authorityEpoch:0,createdAt:new Date().toISOString(),status:'PAUSED'});this.assertTask(record);writeScope(this.db,record);return record;});
 }
 /** Bind only a main-process reviewed file, preserving all original money and request rows. */
 bindReviewInTransaction(db:DatabaseSync,raw:ControlledRunReview,expected:{digest:string|null;epoch:number;taskRevision:number}):void{
  assertSpendTransaction(this.db,db);const review=validateControlledRunReview(raw),scope=readControlledRunScope(db);if(!scope||scope.status!=='PAUSED'||scope.authorityEpoch!==expected.epoch||scope.expectedTaskRevision!==expected.taskRevision||(scope.review?.digest??null)!==expected.digest)blocked();this.assertTask(scope,false,db);
  const old=scope.review;if(old&&(review.sessionId!==old.sessionId||review.initialTaskRevision!==old.initialTaskRevision||listingFingerprint(review.sourceStamps)!==listingFingerprint(old.sourceStamps)||review.secondReleased!==old.secondReleased)||!old&&(review.initialTaskRevision!==scope.expectedTaskRevision||review.secondReleased))blocked();
  writeScope(db,{...scope,review,status:'PAUSED',authorityEpoch:spendInteger(scope.authorityEpoch+1),authorityNonce:randomUUID()});
 }
 /** Explicit main review only, after reading the real first-item producers. An
  * accepted HTTP response, file claim or UNKNOWN cannot authorize the next SKU. */
 releaseSecondReviewedInTransaction(db:DatabaseSync,raw:ControlledRunReview,expected:{digest:string;epoch:number;taskRevision:number}):void{
  assertSpendTransaction(this.db,db);const scope=readControlledRunScope(db);if(!scope?.review||scope.status!=='PAUSED'||scope.items.length!==2||scope.activeItemKey!==scope.items[0].itemKey||scope.review.secondReleased||scope.review.digest!==expected.digest||scope.authorityEpoch!==expected.epoch||scope.expectedTaskRevision!==expected.taskRevision)blocked();this.assertTask(scope,false,db);
  const task=JSON.parse(String(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(scope.taskId)!.record_json)),first=task.items.find((i:any)=>i.key===scope.items[0].itemKey);if(!['PAUSED','NEEDS_ATTENTION'].includes(task.status)||first?.status!=='DONE'||first.stage!=='COMPLETE'||!first.draftId||first.outcome?.kind==='UNKNOWN')blocked();
  const saved=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(first.draftId);if(!saved)blocked();const record=JSON.parse(String(saved.record_json)),draft=record.draft,item=scope.items[0];if(!draft||record.unresolvedWrite||draft.id!==first.draftId||draft.productId!==item.productId||draft.sku!==item.sku||draft.targetId!==scope.targetId||draft.sellerId!==scope.sellerId||draft.marketplaceId!==scope.marketplaceId||draft.mode!=='live'||draft.schema?.parentageLevel!=='NONE'||draft.salesPlan&&draft.salesPlan.parentage!=='NONE'||(draft.salesPlan?.recipe?.key??null)!==item.recipeKey||draft.state!=='BUYABLE'||!draft.statuses?.includes('BUYABLE')||!draft.submittedAt||!draft.checkedAt||Date.parse(draft.checkedAt)<Date.parse(draft.submittedAt)||draft.listingIssues?.some((i:any)=>i.severity==='ERROR'))blocked();
  const observed=db.prepare('SELECT record_json FROM listing_followups WHERE id=?').get(draft.id);if(!observed)blocked();const followup=validateFollowupRecord(JSON.parse(String(observed.record_json)));if(followup.status!=='READY'||followup.draftId!==draft.id||followup.productId!==draft.productId||followup.sku!==draft.sku||followup.targetId!==draft.targetId||followup.sellerId!==draft.sellerId||followup.marketplaceId!==draft.marketplaceId||followup.draftFingerprint!==followupDraftFingerprint(draft)||followup.checkedAt!==draft.checkedAt||followup.listingState!=='BUYABLE'||!followup.statuses.includes('BUYABLE'))blocked();
  const money=new AiSpendBudget(db),status=money.status('controlled-live-lifetime');if(status.anomaly||status.unknownCalls||status.pendingCalls||status.unboundedCalls||status.remainingUsdMicros===null||status.remainingUsdMicros<=0)blocked();
  if(db.prepare("SELECT 1 FROM ai_usage_ledger u JOIN ai_calls c ON c.id=u.id WHERE json_extract(c.record_json,'$.productId')=? AND json_extract(u.record_json,'$.state') IN ('PENDING','UNKNOWN') LIMIT 1").get(item.productId))blocked();
  for(const saved of db.prepare("SELECT record_json FROM image_workflow_runs WHERE json_extract(record_json,'$.draftId')=?").all(draft.id)){const run=JSON.parse(String(saved.record_json));if(run.status==='RUNNING'||run.slots?.some((s:any)=>s.status==='UNKNOWN'||s.attempts?.some((a:any)=>['UNKNOWN','GENERATING'].includes(a.state))))blocked();}
  const review=validateControlledRunReview(raw);if(review.secondReleased!==true)blocked();this.bindReviewInTransaction(db,{...review,secondReleased:false},expected);const updated=readControlledRunScope(db)!;writeScope(db,{...updated,activeItemKey:scope.items[1].itemKey,review,authorityEpoch:spendInteger(updated.authorityEpoch+1),authorityNonce:randomUUID()});
 }
 private activateScope(id:string,allowedStatuses:string[]):ControlledRunGrant{
  const scope=transaction(this.db,()=>{const r=readControlledRunScope(this.db);if(!r||r.id!==id)blocked();this.assertTask(r);assertReviewedProcess(r);const task=JSON.parse(String(this.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(r.taskId)!.record_json));if(!allowedStatuses.includes(task.status))blocked();const active={...r,status:'ACTIVE' as const,authorityEpoch:spendInteger(r.authorityEpoch+1),authorityNonce:randomUUID()};writeScope(this.db,active);return active;});
  const grant={};grants.add(grant);const context={scopeId:scope.id,fingerprint:grantFingerprint(scope),grant},run:ControlledRunGrant=<T>(work:()=>T):T=>authority.run(context,work);grantObjects.set(run,grant);return run;
 }
 activate(id:string):ControlledRunGrant{return this.activateScope(id,['RUNNING']);}
 /** Main-only original TaskOwner admission. The returned closure cannot cross IPC. */
 activateQueuedTask(taskId:string):ControlledRunGrant|null{const scope=readControlledRunScope(this.db);if(scope?.taskId!==taskId)return null;return this.activateScope(scope.id,['QUEUED']);}
 taskSelection(taskId:string,selection?:AutomaticResumeSelection):AutomaticResumeSelection|undefined{
  const scope=readControlledRunScope(this.db);if(scope?.taskId!==taskId)return selection;this.assertTask(scope);
  if(selection?.selections.some(row=>row.key!==scope.activeItemKey))blocked();return selection??{mode:'targeted',selections:[{key:scope.activeItemKey}]};
 }
 /** Called before the original task write, within the same physical active TX. */
 advanceTaskInTransaction(db:DatabaseSync,next:{id:string;revision:number;status:string},previousRevision:number|null):void{
  assertSpendTransaction(this.db,db);const scope=readControlledRunScope(db);if(scope?.taskId!==next.id)return;
  if(previousRevision===null||scope.expectedTaskRevision!==previousRevision||next.revision!==previousRevision+1)blocked();this.assertTask(scope,false,db);
  const revoke=!['QUEUED','RUNNING','WAITING'].includes(next.status),updated={...scope,expectedTaskRevision:next.revision,...(revoke?{status:'PAUSED' as const,authorityEpoch:spendInteger(scope.authorityEpoch+1)}:{})};this.assertTaskRecord(updated,next);writeScope(db,updated);
 }
 authorizeEffect(effect:ControlledEffect):string|null{
  const ctx=authority.getStore(),scope=readControlledRunScope(this.db);
  if(!ctx){if(scope&&(effect.taskId===scope.taskId||scope.items.some(i=>i.productId===effect.productId)))blocked();return null;}
  if(!scope||ctx.scopeId!==scope.id||!grants.has(ctx.grant)||scope.status!=='ACTIVE'||ctx.fingerprint!==grantFingerprint(scope))blocked();assertReviewedProcess(scope);this.assertTask(scope);
  const saved=this.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(scope.taskId)!,task=JSON.parse(String(saved.record_json));if(task.status!=='RUNNING'&&!(task.status==='WAITING'&&['schema','platform-read','lwa','task-stage','ai-batch-read'].includes(effect.kind)))blocked();
  const item=scope.items.find(i=>i.itemKey===scope.activeItemKey)!;
  if(effect.taskId!==undefined&&effect.taskId!==scope.taskId||effect.itemKey!==undefined&&effect.itemKey!==item.itemKey||effect.productId!==undefined&&effect.productId!==item.productId||effect.sku!==undefined&&effect.sku!==item.sku||effect.targetId!==undefined&&effect.targetId!==scope.targetId||effect.sellerId!==undefined&&effect.sellerId!==scope.sellerId||effect.marketplaceId!==undefined&&effect.marketplaceId!==scope.marketplaceId||effect.parentage!==undefined&&effect.parentage!=='NONE'||effect.recipeKey!==undefined&&effect.recipeKey!==item.recipeKey||effect.variantIds!==undefined&&listingFingerprint([...effect.variantIds].sort())!==listingFingerprint([...item.variantIds].sort()))blocked();return scope.id;
 }
 runTask<T>(taskId:string,itemKey:string,productId:string,grant:ControlledRunGrant|undefined,work:()=>T):T{
  const checked=()=>{this.authorizeEffect({kind:'task-stage',taskId,itemKey,productId});return work();};if(grant)return grant(checked);const scope=readControlledRunScope(this.db);if(scope?.taskId===taskId)blocked();return checked();
 }
 authorizeImage(effect:AiRequestScope):string|null{
  const ctx=authority.getStore(),scope=readControlledRunScope(this.db);
  // An authority miss never downgrades a controlled request to ordinary unlimited mode.
  if(!ctx){if(scope?.items.some(i=>i.productId===effect.productId))blocked();return null;}
  if(!scope||ctx.scopeId!==scope.id||!grants.has(ctx.grant)||scope.status!=='ACTIVE'||ctx.fingerprint!==grantFingerprint(scope))blocked();assertReviewedProcess(scope);this.assertTask(scope,true);
  if(!effect.draftId)blocked();const saved=this.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(effect.draftId);if(!saved)blocked();const draft=JSON.parse(String(saved.record_json)).draft;
  if(!draft||draft.id!==effect.draftId||draft.productId!==effect.productId||draft.sku!==effect.sku||draft.targetId!==scope.targetId||draft.sellerId!==scope.sellerId||draft.marketplaceId!==scope.marketplaceId||draft.mode!=='live'||draft.schema?.parentageLevel!=='NONE'||draft.salesPlan&&draft.salesPlan.parentage!=='NONE')blocked();
  const draftVariants=draft.salesPlan?.recipe?.components?.map((c:any)=>c.variantId)??[draft.variantId];if(listingFingerprint([...new Set(draftVariants)].sort())!==listingFingerprint([...(effect.variantIds??[])].sort()))blocked();
  const match=scope.items.find(i=>i.itemKey===scope.activeItemKey&&i.productId===effect.productId&&i.sku===effect.sku);if(!match||(draft.salesPlan?.recipe?.key??null)!==match.recipeKey||effect.targetId!==scope.targetId||effect.marketplaceId!==scope.marketplaceId||listingFingerprint([...(effect.variantIds??[])].sort())!==listingFingerprint([...match.variantIds].sort()))blocked();return scope.id;
 }
}
export function assertControlledRunHistory(db:DatabaseSync):void{readControlledRunScope(db);}
export function pauseControlledRunScopes(db:DatabaseSync):void{transaction(db,()=>{const scope=readControlledRunScope(db);if(scope?.status==='ACTIVE')writeScope(db,{...scope,status:'PAUSED',authorityEpoch:spendInteger(scope.authorityEpoch+1)});});}
/** Preserve the original finite roster, never union it, and revoke dispatch authority on restore. */
export function retainControlledRunHistory(current:DatabaseSync,snapshot:DatabaseSync):void{
 if(!snapshot.isTransaction)spendInvalid();const now=readControlledRunScope(current),old=readControlledRunScope(snapshot);if(!now&&!old)return;
 const identity=(r:ControlledRunScope)=>({...r,status:'PAUSED',expectedTaskRevision:0,authorityEpoch:0,authorityNonce:null,review:null,activeItemKey:null});if(now&&old&&listingFingerprint(identity(now))!==listingFingerprint(identity(old)))blocked();
 if(now?.review&&old?.review&&(now.review.sessionId!==old.review.sessionId||now.review.initialTaskRevision!==old.review.initialTaskRevision||listingFingerprint(now.review.sourceStamps)!==listingFingerprint(old.review.sourceStamps)))blocked();
 const record=now??old!;writeScope(snapshot,{...record,status:'PAUSED',authorityEpoch:spendInteger(Math.max(now?.authorityEpoch??0,old?.authorityEpoch??0)+1)});
}
