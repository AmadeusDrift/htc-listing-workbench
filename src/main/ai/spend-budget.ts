import type {DatabaseSync} from 'node:sqlite';
import {realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {AiSpendBound,AiSpendPolicy,AiSpendReservation,AiSpendSummary,AiSpendReceiptProof,AiSpendStatus} from '../../shared/ai-spend-contracts.ts';
import {transaction} from '../application/transaction.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {SpendBudgetError,spendDate,spendHash,spendInteger,spendInvalid,spendText,spendUuid,validateSpendPolicy,validateSpendReservation,imageSpendBound,usdMicrosCeil} from './spend-records.ts';
import {readImageSpendReceiptProof,validateSpendReceiptProof,assertPreparedSpendReceiptProof} from './spend-receipts.ts';

export const SPEND_TABLES={ai_spend_policies:['id','record_json'],ai_spend_reservations:['id','record_json']};
export function initializeSpendBudget(db:DatabaseSync):void{
 if(!db.isTransaction)spendInvalid();
 db.exec('CREATE TABLE ai_spend_policies(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL);CREATE TABLE ai_spend_reservations(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');
}
export function assertSpendTransaction(owner:DatabaseSync,borrowed:DatabaseSync):void{
 if(!borrowed.isTransaction)spendInvalid();if(owner===borrowed)return;
 const file=(db:DatabaseSync)=>db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
 const expected=file(owner),actual=file(borrowed);if(typeof expected!=='string'||!expected||typeof actual!=='string'||!actual||realpathSync.native(expected)!==realpathSync.native(actual))spendInvalid();
}
function readPolicies(db:DatabaseSync):AiSpendPolicy[]{return db.prepare('SELECT id,record_json FROM ai_spend_policies').all().map(row=>{const r=validateSpendPolicy(JSON.parse(String(row.record_json)));if(r.id!==row.id)spendInvalid();return r;});}
function readReservations(db:DatabaseSync):AiSpendReservation[]{return db.prepare('SELECT id,record_json FROM ai_spend_reservations').all().map(row=>{const r=validateSpendReservation(JSON.parse(String(row.record_json)));if(r.id!==row.id)spendInvalid();return r;});}
function writeReservation(db:DatabaseSync,record:AiSpendReservation):void{
 const r=validateSpendReservation(record);db.prepare('INSERT INTO ai_spend_reservations(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(r.id,JSON.stringify(r));
}
export function assertSpendHistory(db:DatabaseSync,receiptRoot?:string):void{
 const policies=readPolicies(db);for(const r of readReservations(db)){
  if(r.scopeId!==null&&!policies.some(p=>p.id==='controlled-live-lifetime'))spendInvalid();
  let actual:number|null=null;for(const id of r.receiptIds){const row=db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(id);if(!row)spendInvalid();const receipt=JSON.parse(String(row.record_json));if(receipt.id!==id||receipt.callId!==r.id||receipt.gateway!=='openrouter'||receipt.endpoint!=='/api/v1/images'||receipt.model!==r.model)spendInvalid();if(receipt.costUsd!==null)actual=Math.max(actual??0,usdMicrosCeil(receipt.costUsd));}
  if(actual!==r.actualUsdMicros)spendInvalid();
  for(const proof of r.receiptProofs){const meta=JSON.parse(String(db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(proof.receiptId)!.record_json));if(meta.sha256!==proof.sha256)spendInvalid();if(receiptRoot&&listingFingerprint(readImageSpendReceiptProof(db,receiptRoot,proof.receiptId))!==listingFingerprint(proof))spendInvalid();}
 }
}
export interface SpendIdentity {id:string;businessKey:string;requestSha256:string;model:string;purpose:string;scopeId:string|null}
export class AiSpendBudget {
 private db:DatabaseSync;private now:()=>Date;
 constructor(db:DatabaseSync,now:()=>Date=()=>new Date()){this.db=db;this.now=now;}
 private at():string{return spendDate(this.now().toISOString());}
 list():AiSpendReservation[]{return readReservations(this.db);}
 policyRecord(id:AiSpendPolicy['id'],db=this.db):AiSpendPolicy|null{return readPolicies(db).find(p=>p.id===id)??null;}
 policy(id:AiSpendPolicy['id'],db=this.db):AiSpendPolicy{
  return this.policyRecord(id,db)??{version:1,id,period:id==='image-generation-daily'?'UTC_DAY':'LIFETIME',limitUsdMicros:id==='image-generation-daily'?null:5_000_000,updatedAt:this.at()};
 }
 setImagePolicy(limitUsdMicros:number|null,expectedUpdatedAt?:string|null):AiSpendPolicy{
  return transaction(this.db,()=>{const previous=this.policyRecord('image-generation-daily');if(expectedUpdatedAt!==undefined&&(previous?.updatedAt??null)!==expectedUpdatedAt)throw new SpendBudgetError('SPEND_POLICY_CONFLICT');const updatedAt=new Date(Math.max(Date.parse(this.at()),previous?Date.parse(previous.updatedAt)+1:0)).toISOString(),policy=validateSpendPolicy({version:1,id:'image-generation-daily',period:'UTC_DAY',limitUsdMicros,updatedAt});this.db.prepare('INSERT INTO ai_spend_policies(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(policy.id,JSON.stringify(policy));return policy;});
 }
 status(id:AiSpendPolicy['id']):AiSpendStatus{const summary=this.summary(id),records=this.list().filter(r=>r.policyIds.includes(id));return{...summary,policyUpdatedAt:this.policyRecord(id)?.updatedAt??null,remainingUsdMicros:summary.limitUsdMicros===null?null:Math.max(0,summary.limitUsdMicros-spendInteger(summary.reportedUsdMicros+summary.heldUsdMicros)),pendingCalls:records.filter(r=>r.state==='DISPATCH_ATTEMPTED').length,unknownCalls:records.filter(r=>r.state==='UNKNOWN').length};}
 summary(id:AiSpendPolicy['id'],db=this.db,at=this.at()):AiSpendSummary{
  const policy=this.policy(id,db),result:AiSpendSummary={reportedUsdMicros:0,heldUsdMicros:0,unboundedCalls:0,anomaly:false,limitUsdMicros:policy.limitUsdMicros};
  const records=readReservations(db).filter(r=>r.policyIds.includes(id));result.anomaly=records.some(r=>r.state==='COST_ANOMALY');
  for(const r of records.filter(r=>policy.period==='LIFETIME'||r.createdAt.slice(0,10)===at.slice(0,10)||['DISPATCH_ATTEMPTED','UNKNOWN'].includes(r.state))){
   if(r.actualUsdMicros!==null)result.reportedUsdMicros=spendInteger(result.reportedUsdMicros+r.actualUsdMicros);
   if(['DISPATCH_ATTEMPTED','UNKNOWN'].includes(r.state)){if(r.bound)result.heldUsdMicros=spendInteger(result.heldUsdMicros+Math.max(0,r.bound.upperUsdMicros-(r.actualUsdMicros??0)));else result.unboundedCalls++;}
  }return result;
 }
 needsBound(scopeId:string|null):boolean{return scopeId!==null||this.policy('image-generation-daily').limitUsdMicros!==null;}
 reserveInTransaction(db:DatabaseSync,identity:SpendIdentity,body:string,bound:AiSpendBound|null):AiSpendReservation{
  assertSpendTransaction(this.db,db);const at=this.at();spendUuid(identity.id);spendHash(identity.businessKey);spendHash(identity.requestSha256);spendText(identity.model);spendText(identity.purpose);
  if(identity.requestSha256!==createHash('sha256').update(body).digest('hex')||identity.scopeId!==null&&identity.scopeId!=='htc-250-controlled-live/v1')spendInvalid();
  if(JSON.parse(body).model!==identity.model)throw new SpendBudgetError('SPEND_IDENTITY_CONFLICT');
  if(bound){const verified=imageSpendBound(body,bound.evidence,at);if(!verified||listingFingerprint(verified)!==listingFingerprint(bound))throw new SpendBudgetError('SPEND_BOUND_UNAVAILABLE');}
  if(identity.scopeId!==null&&!readPolicies(db).some(p=>p.id==='controlled-live-lifetime')){const policy=validateSpendPolicy({version:1,id:'controlled-live-lifetime',period:'LIFETIME',limitUsdMicros:5_000_000,updatedAt:at});db.prepare('INSERT INTO ai_spend_policies(id,record_json) VALUES(?,?)').run(policy.id,JSON.stringify(policy));}
  const policies:AiSpendPolicy['id'][]=['image-generation-daily',...(identity.scopeId?['controlled-live-lifetime' as const]:[])];
  // Result uncertainty is enforced by the request/domain owner, separately from fee uncertainty.
  const previous=readReservations(db);if(previous.some(r=>r.id===identity.id))throw new SpendBudgetError('SPEND_IDENTITY_CONFLICT');
  // An unconfigured ordinary daily policy observes liabilities without pausing
  // unrelated work. The finite controlled lifetime policy still locks on any anomaly.
  for(const id of policies){const summary=this.summary(id,db,at);if(summary.limitUsdMicros!==null){if(summary.anomaly)throw new SpendBudgetError('SPEND_COST_ANOMALY');if(!bound)throw new SpendBudgetError('SPEND_BOUND_UNAVAILABLE');if(summary.unboundedCalls||summary.reportedUsdMicros+summary.heldUsdMicros+bound.upperUsdMicros>summary.limitUsdMicros)throw new SpendBudgetError('SPEND_LIMIT_EXCEEDED');}}
  const record:AiSpendReservation={version:1,...identity,createdAt:at,policyIds:policies,bound,state:'DISPATCH_ATTEMPTED',actualUsdMicros:null,receiptIds:[],receiptProofs:[]};writeReservation(db,record);return record;
 }
 private read(id:string,db:DatabaseSync):AiSpendReservation{const r=readReservations(db).find(r=>r.id===id);if(!r)spendInvalid();return r;}
 markUnknownInTransaction(db:DatabaseSync,id:string):void{assertSpendTransaction(this.db,db);const r=this.read(id,db);if(r.state==='DISPATCH_ATTEMPTED')writeReservation(db,{...r,state:'UNKNOWN'});}
 settleReceiptInTransaction(db:DatabaseSync,id:string,receiptId:string,rawProof:AiSpendReceiptProof):AiSpendReservation{
  assertSpendTransaction(this.db,db);spendHash(receiptId);const r=this.read(id,db),row=db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(receiptId);if(!row)spendInvalid();
  const receipt=JSON.parse(String(row.record_json));if(receipt.id!==receiptId||receipt.callId!==id||receipt.gateway!=='openrouter'||receipt.endpoint!=='/api/v1/images'||receipt.model!==r.model)throw new SpendBudgetError('SPEND_IDENTITY_CONFLICT');
  assertPreparedSpendReceiptProof(rawProof);const proof=validateSpendReceiptProof(rawProof);if(proof.receiptId!==receiptId||proof.sha256!==receipt.sha256)spendInvalid();
  if(r.receiptIds.includes(receiptId)){if(listingFingerprint(r.receiptProofs.find(p=>p.receiptId===receiptId))!==listingFingerprint(proof))spendInvalid();return r;}
  const proofs=[...r.receiptProofs,proof],amount=receipt.costUsd===null?null:usdMicrosCeil(receipt.costUsd),actual=amount===null?r.actualUsdMicros:Math.max(amount,r.actualUsdMicros??0),state=r.state==='COST_ANOMALY'||r.bound&&actual!==null&&actual>r.bound.upperUsdMicros?'COST_ANOMALY':actual===null||!proofs.some(p=>p.certainty!=='SENT_UNKNOWN')?'UNKNOWN':'SETTLED';
  const next:AiSpendReservation={...r,state,actualUsdMicros:actual,receiptIds:[...r.receiptIds,receiptId],receiptProofs:proofs};writeReservation(db,next);return next;
 }
 /** There is deliberately no release-by-error-code API: committed dispatch permits remain liabilities. */
}

/** Restore only the monetary ledger. Scope grants are handled by the task owner separately. */
export function retainSpendHistory(current:DatabaseSync,snapshot:DatabaseSync):void{
 if(!snapshot.isTransaction)spendInvalid();
 for(const p of readPolicies(current)){
  const old=readPolicies(snapshot).find(x=>x.id===p.id);const next=!old?p:old.limitUsdMicros===null?p:p.limitUsdMicros===null?old:{...p,limitUsdMicros:Math.min(old.limitUsdMicros,p.limitUsdMicros)};
  snapshot.prepare('INSERT INTO ai_spend_policies(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(next.id,JSON.stringify(validateSpendPolicy(next)));
 }
 for(const r of readReservations(current)){
  const old=readReservations(snapshot).find(x=>x.id===r.id);if(!old){writeReservation(snapshot,{...r,state:r.state==='DISPATCH_ATTEMPTED'?'UNKNOWN':r.state});continue;}
  const immutable=(v:AiSpendReservation)=>({id:v.id,businessKey:v.businessKey,requestSha256:v.requestSha256,model:v.model,purpose:v.purpose,scopeId:v.scopeId,policyIds:v.policyIds,createdAt:v.createdAt,bound:v.bound});if(listingFingerprint(immutable(old))!==listingFingerprint(immutable(r)))throw new SpendBudgetError('SPEND_IDENTITY_CONFLICT');
  const actual=old.actualUsdMicros===null?r.actualUsdMicros:r.actualUsdMicros===null?old.actualUsdMicros:Math.max(old.actualUsdMicros,r.actualUsdMicros);
  const proofs=[...old.receiptProofs];for(const p of r.receiptProofs){const prior=proofs.find(x=>x.receiptId===p.receiptId);if(prior&&listingFingerprint(prior)!==listingFingerprint(p))spendInvalid();if(!prior)proofs.push(p);}writeReservation(snapshot,{...r,actualUsdMicros:actual,receiptIds:proofs.map(p=>p.receiptId),receiptProofs:proofs,state:r.bound&&actual!==null&&actual>r.bound.upperUsdMicros?'COST_ANOMALY':actual===null||!proofs.some(p=>p.certainty!=='SENT_UNKNOWN')?'UNKNOWN':'SETTLED'});
 }
 assertSpendHistory(snapshot);
}
