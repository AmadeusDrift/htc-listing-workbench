import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initializeImageRetryAllowances, grantImageRetry, saveRetryConsumption, retryGrants, retryHistoryGap, retainImageRetryHistory, historicalRetryEligible, assertRetryAllowanceRun } from '../src/main/image-workflow/retry-allowance.ts';
import { validateStoredImageWorkflowRun } from '../src/main/image-workflow/records.ts';
import { PRODUCT_IMAGE_POLICY_VERSION } from '../src/shared/image-ai-contracts.ts';
import type { ImageWorkflowRun, ImageSlotAttempt } from '../src/shared/image-workflow-contracts.ts';
import { retainAiUsage } from '../src/main/ai/usage.ts';
const attempt=(number:number):ImageSlotAttempt=>({number,requestId:randomUUID(),state:'RETRYABLE_FAILURE',planResultId:null,candidateId:null,ipReviewResultId:null,ocrResultId:null,reviewResultId:null,error:'definitive fixture failure',failureProof:{version:1,kind:'provider-definitive',at:new Date().toISOString()}});
function run():ImageWorkflowRun {const now=new Date().toISOString();return {id:randomUUID(),draftId:randomUUID(),productId:randomUUID(),productRevision:1,variantId:randomUUID(),sku:'SYNTHETIC',status:'FAILED',stage:'generating',attempt:3,maxAttempts:3,contextSha256:null,draftSha256:null,referenceAssets:[],planResultIds:[],candidateIds:[],ipReviewResultIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:'fixture',imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION,slotPolicy:'seven-product-v2',slots:Array.from({length:7},(_,i)=>({index:i+1,purpose:i===0?'main':'detail',status:i===0?'FAILED':'PENDING',contextSha256:i===0?'a'.repeat(64):null,attempts:i===0?[attempt(1),attempt(2),attempt(3)]:[],approvedAssetId:null,approvedSha256:null,error:null}))};}
function db(r:ImageWorkflowRun){const d=new DatabaseSync(':memory:');d.exec('CREATE TABLE image_workflow_runs(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL); CREATE TABLE audit_events(id TEXT,product_id TEXT,action TEXT,summary TEXT,detail_json TEXT,created_at TEXT); CREATE TABLE ai_usage_ledger(id TEXT PRIMARY KEY,record_json TEXT); CREATE TABLE ai_usage_policies(id TEXT PRIMARY KEY,record_json TEXT)');d.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(r.id,JSON.stringify(r));initializeImageRetryAllowances(d);return d;}
function save(d:DatabaseSync,r:ImageWorkflowRun){r.updatedAt=new Date(Math.max(Date.now(),Date.parse(r.updatedAt)+1)).toISOString();r.attempt=r.slots!.reduce((n,s)=>n+s.attempts.length,0);saveRetryConsumption(d,r);d.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(r),r.id);}

test('retry ledger restore retains later attempt detail, budget and no duplicate historical grant',t=>{
 const r=run(),current=db(r),snapshot=db(r);t.after(()=>{current.close();snapshot.close();});const old=structuredClone(r);
 grantImageRetry(current,r,1,randomUUID(),'historical');save(current,r);r.slots![0].attempts.push(attempt(4));save(current,r);
 const usage={id:r.slots![0].attempts[3].requestId,providerId:'deepseek',day:'2026-10-14',startedAt:'2026-10-14T00:00:00.000Z',finishedAt:'2026-10-14T00:00:01.000Z',state:'REPORTED',reservedTokens:4608,usage:{promptTokens:10,completionTokens:20,processedImages:0}};current.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(usage.id,JSON.stringify(usage));
 retainAiUsage(current,snapshot);retainImageRetryHistory(current,snapshot);retainImageRetryHistory(current,snapshot);
 const restored=JSON.parse(String(snapshot.prepare('SELECT record_json FROM image_workflow_runs').get()!.record_json));
 assert.deepEqual(restored.slots,old.slots);assert.equal(retryGrants(snapshot).length,1);assert.deepEqual(retryHistoryGap(snapshot,restored)?.savedAttempts,r.slots![0].attempts);assert.equal(historicalRetryEligible(snapshot,restored,1),false);
 assert.equal(JSON.parse(String(snapshot.prepare('SELECT record_json FROM ai_usage_ledger').get()!.record_json)).usage.completionTokens,20);
 assert.throws(()=>saveRetryConsumption(snapshot,restored),/旧备份/);assert.throws(()=>grantImageRetry(snapshot,restored,1,randomUUID(),'manual'));
});

test('retry ledger supports repeated exhausted grants but rejects forged references and old oversized records',t=>{
 const r=run(),d=db(r);t.after(()=>d.close());const old=structuredClone(r);old.slots![0].attempts.push(attempt(4));old.attempt=4;assert.throws(()=>validateStoredImageWorkflowRun(old));
 for(let n=0;n<8;n++){grantImageRetry(d,r,1,randomUUID(),'manual');save(d,r);for(let i=0;i<3;i++)r.slots![0].attempts.push(attempt(r.slots![0].attempts.length+1));save(d,r);}
 assert.equal(r.attempt,27);assert.equal(r.retryAllowance!.grants.length,8);assertRetryAllowanceRun(d,r);
 const forged=structuredClone(r);forged.retryAllowance!.grants[0].id=randomUUID();assert.throws(()=>assertRetryAllowanceRun(d,forged));
 const count=retryGrants(d).length;retainImageRetryHistory(d,d);assert.equal(retryGrants(d).length,count);
});

test('retry ledger restore keeps same-count later stage evidence and rejects conflicting candidate identity',t=>{
 const r=run(),current=db(r),snapshot=db(r);t.after(()=>{current.close();snapshot.close();});grantImageRetry(current,r,1,randomUUID(),'manual');save(current,r);
 r.slots![0].attempts.push({...attempt(4),state:'GENERATING',failureProof:undefined,error:null});save(current,r);retainImageRetryHistory(current,snapshot);
 const old=retryGrants(snapshot)[0];assert.equal(old.savedAttempts.at(-1)!.state,'GENERATING');
 const last=r.slots![0].attempts.at(-1)!;last.state='GENERATED';last.candidateId=randomUUID();save(current,r);retainImageRetryHistory(current,snapshot);
 assert.equal(retryGrants(snapshot)[0].savedAttempts.at(-1)!.state,'GENERATED');assert.equal(retryGrants(snapshot)[0].savedAttempts.at(-1)!.candidateId,last.candidateId);
 const tampered=retryGrants(snapshot)[0];tampered.savedAttempts.at(-1)!.candidateId=randomUUID();snapshot.prepare('UPDATE image_retry_allowances SET record_json=? WHERE id=?').run(JSON.stringify(tampered),tampered.id);assert.throws(()=>retainImageRetryHistory(current,snapshot),/归属/);
});
