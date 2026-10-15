import {lstatSync,readFileSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {ProductDetail} from '../../shared/contracts.ts';
import type {AutomaticListingTask} from '../../shared/automatic-listing-contracts.ts';
import {openDatabase} from '../database.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {sourceStamp,validateAutomaticListingTask} from '../automatic-listing/records.ts';
import {parseUnambiguousJson} from '../collection/validation.ts';
import {spendObject,spendHash,spendUuid,spendInteger,spendDate,spendText,SpendBudgetError} from '../ai/spend-records.ts';
import {CONTROLLED_RUN_ID,ControlledRunError,ControlledRunScopes,readControlledRunScope,type ControlledEffect,type ControlledRunItem,type ControlledRunReview,validateControlledRunReview} from './controlled-run-scope.ts';
import {assertVerifiedControlledCandidate,type VerifiedControlledCandidate} from './controlled-candidate.ts';
import {assertSpendTransaction} from '../ai/spend-budget.ts';
import {transaction} from './transaction.ts';
import {preflightControlledAcceptance} from './controlled-startup.ts';

export const CONTROLLED_ACCEPTANCE_FLAG='--htc-controlled-acceptance';
interface ReviewedItem extends ControlledRunItem {sourceStamp:string}
export interface ReviewedAcceptanceManifest {schema:'htc-controlled-acceptance/v1';sessionId:string;taskId:string;reviewTaskRevision:number;targetId:string;sellerId:string;marketplaceId:string;items:ReviewedItem[];candidate:ControlledRunReview['candidate'];reviewedAt:string;action:{kind:'register'|'re-attest'|'release-second';previousDigest:string|null;expectedEpoch:number;expectedTaskRevision:number}}
function blocked():never{throw Object.assign(new ControlledRunError(),{certainty:'NOT_SENT' as const,notSent:true});}
function validateManifest(raw:unknown):ReviewedAcceptanceManifest{
 const r=spendObject(raw,['schema','sessionId','taskId','reviewTaskRevision','targetId','sellerId','marketplaceId','items','candidate','reviewedAt','action']);if(r.schema!=='htc-controlled-acceptance/v1'||spendInteger(r.reviewTaskRevision)<1||!Array.isArray(r.items)||r.items.length<1||r.items.length>2)blocked();spendUuid(r.sessionId);spendUuid(r.taskId);spendText(r.targetId);spendText(r.sellerId);spendText(r.marketplaceId);spendDate(r.reviewedAt);
 for(const raw of r.items){const i=spendObject(raw,['itemKey','sku','productId','variantIds','recipeKey','parentage','sourceStamp']);spendText(i.itemKey,150);spendText(i.sku);spendUuid(i.productId);spendHash(i.sourceStamp);if(i.parentage!=='NONE'||!Array.isArray(i.variantIds)||!i.variantIds.length||i.variantIds.length>20||new Set(i.variantIds).size!==i.variantIds.length)blocked();i.variantIds.forEach(spendUuid);if(i.recipeKey!==null)spendText(i.recipeKey);}
 if(new Set(r.items.map((i:ReviewedItem)=>i.sku)).size!==r.items.length||new Set(r.items.map((i:ReviewedItem)=>i.itemKey)).size!==r.items.length)blocked();
 const a=spendObject(r.action,['kind','previousDigest','expectedEpoch','expectedTaskRevision']);if(!['register','re-attest','release-second'].includes(a.kind)||spendInteger(a.expectedTaskRevision)<1)blocked();spendInteger(a.expectedEpoch);if(a.previousDigest!==null)spendHash(a.previousDigest);if(a.kind==='register'&&(a.previousDigest!==null||a.expectedEpoch!==0||a.expectedTaskRevision!==r.reviewTaskRevision)||a.kind!=='register'&&a.previousDigest===null)blocked();
 validateControlledRunReview({version:1,sessionId:r.sessionId,digest:'0'.repeat(64),initialTaskRevision:r.reviewTaskRevision,sourceStamps:r.items.map((i:ReviewedItem)=>({itemKey:i.itemKey,stamp:i.sourceStamp})),candidate:r.candidate,secondReleased:false});return r as ReviewedAcceptanceManifest;
}
/** A reviewed, main-only local file. No key, manually entered price upper or remote success claim is accepted. */
export function readReviewedAcceptanceManifest(directory:string):{manifest:ReviewedAcceptanceManifest;digest:string}|null{
 const folder=join(resolve(directory),'controlled-acceptance'),path=join(folder,'reviewed.json');if(!existsSync(path))return null;
 try{for(const at of [resolve(directory),folder]){const st=lstatSync(at);if(!st.isDirectory()||st.isSymbolicLink()||realpathSync.native(at).toLowerCase()!==at.toLowerCase())blocked();}const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>64*1024)blocked();const bytes=readFileSync(path),after=lstatSync(path);if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||after.nlink!==1)blocked();const manifest=validateManifest(parseUnambiguousJson(bytes,64*1024));return{manifest,digest:listingFingerprint(manifest)};}catch{return blocked();}
}
/** Explicit-mode process authority. Its existence (not a UI selection) makes every
 * dispatch fail closed, including a wrong task for which no stored scope matches. */
export class ControlledAcceptanceSession {
 private db:DatabaseSync;private scopes:ControlledRunScopes;private directory:string;private candidate:VerifiedControlledCandidate;private product:(id:string)=>ProductDetail;private preparedReview:ReturnType<typeof readReviewedAcceptanceManifest>=null;
 constructor(directory:string,candidate:VerifiedControlledCandidate,product:(id:string)=>ProductDetail){this.directory=directory;this.candidate=candidate;this.product=product;assertVerifiedControlledCandidate(candidate);this.db=openDatabase(directory);this.scopes=new ControlledRunScopes(this.db);}
 private reviewed(){assertVerifiedControlledCandidate(this.candidate);const file=readReviewedAcceptanceManifest(this.directory);if(!file||listingFingerprint(file.manifest.candidate)!==listingFingerprint(this.candidate.identity))blocked();this.preparedReview=file;return file;}
 canManageTask(id:string):boolean{const file=readReviewedAcceptanceManifest(this.directory);if(!file||file.manifest.taskId!==id)return false;const scope=readControlledRunScope(this.db);if(scope&&(scope.taskId!==id||scope.review&&scope.review.sessionId!==file.manifest.sessionId))return false;this.task(file.manifest);return true;}
 canManageDraft(id:string):boolean{
  const file=readReviewedAcceptanceManifest(this.directory);if(!file||!this.canManageTask(file.manifest.taskId))return false;const saved=this.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(file.manifest.taskId);if(!saved)return false;const task=validateAutomaticListingTask(JSON.parse(String(saved.record_json)));return task.items.some(row=>row.draftId===id&&file.manifest.items.some(i=>i.itemKey===row.key));
 }
 private task(m:ReviewedAcceptanceManifest):AutomaticListingTask{
  const saved=this.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(m.taskId);if(!saved)blocked();const task=validateAutomaticListingTask(JSON.parse(String(saved.record_json)));
  if(task.id!==m.taskId||task.mode!=='live'||task.targetId!==m.targetId||task.sellerId!==m.sellerId||task.marketplaceId!==m.marketplaceId||task.items.length!==m.items.length)blocked();
  for(const i of m.items){const row=task.items.find(r=>r.key===i.itemKey);if(!row||row.sku!==i.sku||row.productId!==i.productId||row.sourceStamp!==i.sourceStamp||sourceStamp(this.product(row.productId))!==i.sourceStamp||(row.salesPlan?.parentage??'NONE')!=='NONE'||(row.salesPlan?.recipe.key??null)!==i.recipeKey||listingFingerprint([...(row.salesPlan?.recipe.components.map(c=>c.variantId)??[row.variantId])].sort())!==listingFingerprint([...i.variantIds].sort()))blocked();}
  return task;
 }
 /** Called by main on explicit start, never from renderer registration. Initial
  * review revision is only the anchor; subsequent owner progress uses durable CAS. */
 applyReviewedFile():void{
  const {manifest:m,digest}=this.reviewed(),task=this.task(m),current=readControlledRunScope(this.db);if(current?.review?.digest===digest){if(current.review.sessionId!==m.sessionId)blocked();return;}
  preflightControlledAcceptance(this.directory);if(!['CREATED','PAUSED','NEEDS_ATTENTION'].includes(task.status)||task.revision!==m.action.expectedTaskRevision)blocked();
  transaction(this.db,()=>{
   let scope=readControlledRunScope(this.db);if(m.action.kind==='register'){if(scope||task.revision!==m.reviewTaskRevision)blocked();scope=this.scopes.register({taskId:m.taskId,expectedTaskRevision:task.revision,targetId:m.targetId,sellerId:m.sellerId,marketplaceId:m.marketplaceId,items:m.items.map(({sourceStamp:_stamp,...item})=>item)});}else if(!scope||scope.review?.sessionId!==m.sessionId)blocked();
   const review:ControlledRunReview={version:1,sessionId:m.sessionId,digest,initialTaskRevision:m.reviewTaskRevision,sourceStamps:m.items.map(i=>({itemKey:i.itemKey,stamp:i.sourceStamp})),candidate:m.candidate,secondReleased:scope!.review?.secondReleased??false};
   const expected={digest:m.action.previousDigest,epoch:m.action.expectedEpoch,taskRevision:m.action.expectedTaskRevision};
   if(m.action.kind==='release-second'){if(expected.digest===null)blocked();this.scopes.releaseSecondReviewedInTransaction(this.db,{...review,secondReleased:true},{...expected,digest:expected.digest});}
   else this.scopes.bindReviewInTransaction(this.db,review,expected);
  });
 }
 /** No provider in the current full listing plan has a verified exhaustive hard
  * upper for every required effect. Stop before spending on the first AI stage. */
 assertBillingPlanAvailable():never{throw Object.assign(new SpendBudgetError('SPEND_BOUND_UNAVAILABLE'),{certainty:'NOT_SENT' as const,notSent:true});}
 admitTask(task:AutomaticListingTask):void{if(!this.canManageTask(task.id))blocked();this.applyReviewedFile();const file=this.reviewed();this.task(file.manifest);if(readControlledRunScope(this.db)?.review?.digest!==file.digest)blocked();this.assertBillingPlanAvailable();}
 assertExternal(effect:ControlledEffect,borrowed?:DatabaseSync):void{
  if(borrowed)assertSpendTransaction(this.db,borrowed);const file=borrowed?this.preparedReview:this.reviewed();if(!file)blocked();this.task(file.manifest);const scope=readControlledRunScope(borrowed??this.db);if(!scope||scope.review?.digest!==file.digest||scope.review.sessionId!==file.manifest.sessionId)blocked();if((borrowed?new ControlledRunScopes(borrowed):this.scopes).authorizeEffect(effect)!==CONTROLLED_RUN_ID)blocked();
 }
 close():void{this.db.close();}
}
