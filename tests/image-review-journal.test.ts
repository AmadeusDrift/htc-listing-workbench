import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateStoredImageWorkflowRun} from '../src/main/image-workflow/records.ts';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {transaction} from '../src/main/application/transaction.ts';
import {reviewFixture} from './fixtures/stabilization/review-fixture.ts';

const at='2026-10-15T00:00:00.000Z';
function fixture(){
 const run={id:randomUUID(),draftId:randomUUID(),productId:randomUUID(),productRevision:1,variantId:randomUUID(),sku:'JOURNAL-A',status:'INTERRUPTED',stage:'ip-check',attempt:1,maxAttempts:2,contextSha256:'a'.repeat(64),draftSha256:'b'.repeat(64),referenceAssets:[],planResultIds:[randomUUID()],candidateIds:[randomUUID()],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:at,updatedAt:at,error:null};
 const request={version:1,requestId:randomUUID(),step:'risk',runId:run.id,draftId:run.draftId,productId:run.productId,productRevision:1,variantId:run.variantId,sku:run.sku,slot:0,attempt:1,generationRequestId:run.candidateIds[0],candidate:{id:run.candidateIds[0],sha256:'c'.repeat(64),width:32,height:32},planResultId:run.planResultIds[0],ocrResultId:null,contextSha256:run.contextSha256,requestFingerprint:'d'.repeat(64),execution:{providerId:'aliyun-image-risk',model:'aigcViolationDetection',generation:1,purposeSnapshot:null},reservedAt:at,state:'SENT_UNKNOWN',resultId:null};
 return {run,request};
}
test('stored legacy workflow preserves original review request identity without inventing completion',()=>{
 const {run,request}=fixture(),raw={...run,reviewRequests:[request]};
 assert.deepEqual(validateStoredImageWorkflowRun(raw),raw);
 assert.deepEqual(validateStoredImageWorkflowRun(run),run,'old absent fields remain absent');
});
test('stored review identities reject wrong run, candidate, attempt, service, status and secret fields',()=>{
 const {run,request}=fixture();
 for(const changed of [{runId:randomUUID()},{sku:'OTHER-SKU'},{candidate:{...request.candidate,id:randomUUID()}},{attempt:2},{execution:{...request.execution,providerId:'aliyun-ocr'}},{state:'RESULT_STORED'},{apiKey:'synthetic-secret'}])assert.throws(()=>validateStoredImageWorkflowRun({...run,reviewRequests:[{...request,...changed}]}));
 assert.throws(()=>validateStoredImageWorkflowRun({...run,reviewRequests:[request,request]}));
});

test('images reservation borrows the active physical workspace transaction and rolls back with its call',async()=>{
 const journal=await import('../src/main/image-workflow/review-journal.ts').catch((error:NodeJS.ErrnoException)=>{if(error.code==='ERR_MODULE_NOT_FOUND')return null;throw error;});
 assert.ok(journal,'images-owned transactional reservation port is missing');
 mkdirSync(resolve('.test-data'),{recursive:true});const root=mkdtempSync(resolve('.test-data/review-owner-')),path=join(root,'red.sqlite'),owner=new DatabaseSync(path),borrowed=new DatabaseSync(path),other=new DatabaseSync(':memory:');
 const {run,request}=fixture(),call={id:request.requestId,providerId:request.execution.providerId,productId:run.productId,productRevision:1,status:'RUNNING',errorCode:null,requestId:null,model:request.execution.model,generation:1,startedAt:at,finishedAt:null,usage:{promptTokens:0,completionTokens:0,processedImages:0},requestScope:{version:1,productId:run.productId,operation:'image-ip-review',variantId:run.variantId,sku:run.sku,candidateSha256:request.candidate.sha256},requestFingerprint:request.requestFingerprint,presentationContext:{kind:'image',draftId:run.draftId,variantId:run.variantId,sourceSha256:run.contextSha256,slot:0}};
 try{
  owner.exec('CREATE TABLE image_workflow_runs(id TEXT PRIMARY KEY,record_json TEXT NOT NULL); CREATE TABLE ai_calls(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)');owner.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(run.id,JSON.stringify(run));
  assert.throws(()=>journal.reserveImageReviewRequest(owner,borrowed,request),/事务/);
  transaction(other,()=>assert.throws(()=>journal.reserveImageReviewRequest(owner,other,request),/工作区|连接/));
  assert.throws(()=>transaction(borrowed,()=>{borrowed.prepare('INSERT INTO ai_calls VALUES(?,?)').run(call.id,JSON.stringify(call));journal.reserveImageReviewRequest(owner,borrowed,request);throw Error('controlled second owner failure');}),/controlled second owner failure/);
  assert.equal(owner.prepare('SELECT count(*) AS n FROM ai_calls').get()?.n,0);assert.equal(owner.prepare('SELECT record_json FROM image_workflow_runs').get()?.record_json,JSON.stringify(run));
  transaction(borrowed,()=>{borrowed.prepare('INSERT INTO ai_calls VALUES(?,?)').run(call.id,JSON.stringify(call));journal.reserveImageReviewRequest(owner,borrowed,request);});
  assert.deepEqual(JSON.parse(String(owner.prepare('SELECT record_json FROM image_workflow_runs').get()?.record_json)).reviewRequests,[request]);
  assert.throws(()=>transaction(borrowed,()=>journal.reserveImageReviewRequest(owner,borrowed,request)),/请求|重复/);
 }finally{other.close();borrowed.close();owner.close();}
});

test('seven-slot reader retains the original candidate, generation request and risk call identity',async t=>{
 const f=await reviewFixture(t,{riskFailure:true}),result=await f.run(),run=result.workflow,slot=run.slots![0],attempt=slot.attempts[0],local=await f.generation.readCandidate(attempt.candidateId!);
 assert.equal(attempt.state,'GENERATED');
 const request={...fixture().request,requestId:randomUUID(),runId:run.id,draftId:run.draftId,productId:run.productId,productRevision:run.productRevision,variantId:run.variantId,sku:run.sku,slot:1,attempt:1,generationRequestId:attempt.requestId,candidate:{id:local.candidate.id,sha256:local.candidate.sha256,width:local.candidate.width,height:local.candidate.height},planResultId:attempt.planResultId,contextSha256:slot.contextSha256,reservedAt:run.updatedAt};
 assert.deepEqual(validateStoredImageWorkflowRun({...run,reviewRequests:[request]}).reviewRequests,[request]);
 assert.deepEqual(validateStoredImageWorkflowRun(run),run);
});

test('pending review projection preserves original identity and never treats stored evidence as a new permit',async()=>{
 const {pendingImageReviewRequests}=await import('../src/main/image-workflow/review-journal.ts'),{request}=fixture(),raw=JSON.stringify(request);
 assert.deepEqual(pendingImageReviewRequests([request as never]),[request]);
 assert.deepEqual(pendingImageReviewRequests([{...request,state:'RESULT_STORED',resultId:randomUUID()} as never]),[]);
 assert.equal(JSON.stringify(request),raw);assert.deepEqual(pendingImageReviewRequests(undefined),[]);
});
