// Strict state/retention ports only. Actual wire/restart/backup proofs live in image-ai-service.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {reviewFixture} from './fixtures/stabilization/review-fixture.ts';
import {validateImageReviewRequest} from '../src/main/image-workflow/review-checkpoint.ts';
import {initializeImageReviewLedger,validateImageReviewLedger,writeImageReviewLedger,readImageReviewLedger} from '../src/main/image-workflow/review-ledger.ts';
import type {ImageReviewLedger} from '../src/main/image-workflow/review-ledger.ts';
import type {ImageReviewRequestV2} from '../src/shared/image-workflow-contracts.ts';
import {validateProductImageContext} from '../src/main/ai/image-validation.ts';
import {listingFingerprint} from '../src/main/json-fingerprint.ts';
import {transaction} from '../src/main/application/transaction.ts';
async function ledgerFixture(t:test.TestContext):Promise<ImageReviewLedger>{
 const f=await reviewFixture(t,{riskFailure:true}),run=(await f.run()).workflow,slot=run.slots![0],attempt=slot.attempts[0],local=await f.generation.readCandidate(attempt.candidateId!),context=validateProductImageContext({...run.imageContext,purpose:'main',slot:{index:1,total:7,provisional:true},setPlan:run.setPlan}),requestId=randomUUID(),at=run.updatedAt;
 assert.equal(listingFingerprint(context),slot.contextSha256);
 const request:ImageReviewRequestV2={version:2,requestId,step:'risk',runId:run.id,draftId:run.draftId,productId:run.productId,productRevision:run.productRevision,variantId:run.variantId,sku:run.sku,slot:1,attempt:1,generationRequestId:attempt.requestId,candidate:{id:local.candidate.id,sha256:local.candidate.sha256,width:local.candidate.width,height:local.candidate.height},planResultId:attempt.planResultId!,ocrResultId:null,contextSha256:slot.contextSha256!,requestFingerprint:null,execution:{providerId:'aliyun-image-risk',model:'aigcViolationDetection',generation:1,purposeSnapshot:null},preparedAt:at,reservedAt:null,state:'PREPARED',resultId:null,effects:(['token','upload','moderation'] as const).map(kind=>({id:listingFingerprint({requestId,kind}),kind,state:'UNPERMITTED',permittedAt:null,receivedAt:null}))};
 run.reviewRequests=[request];return {version:1,id:requestId,request,context,frozenRun:run,files:['candidate.json','image.png','preview.png'].map(name=>({path:`image-generation/candidates/${local.candidate.id}/${name}`,sha256:name==='image.png'?local.candidate.sha256:'a'.repeat(64),byteSize:33})),call:null,result:null,adopted:null};
}
test('S05 strict v2 intent rejects forged effect identities, sequencing, timestamps and new secret fields',async t=>{
 const ledger=await ledgerFixture(t),r=ledger.request;assert.deepEqual(validateImageReviewLedger(ledger),ledger);
 for(const change of [{version:'2'},{accessKeySecret:'synthetic-secret'},{effects:r.effects.map((e,i)=>i?e:{...e,id:'f'.repeat(64)})},{effects:r.effects.map((e,i)=>i===1?{...e,state:'PERMITTED',permittedAt:r.preparedAt}:e)},{state:'SENT_UNKNOWN'},{preparedAt:'2099-01-01T00:00:00.000Z'}])assert.throws(()=>validateImageReviewLedger({...ledger,request:{...r,...change}}));
 assert.throws(()=>validateImageReviewRequest({...r,state:'RESULT_STORED',resultId:randomUUID()}));
});
test('S05 ledger permit survives without a parent call and never downgrades to prepared',async t=>{
 const ledger=await ledgerFixture(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());initializeImageReviewLedger(db);transaction(db,()=>writeImageReviewLedger(db,ledger));
 const request=structuredClone(ledger.request);request.state='SENT_UNKNOWN';request.reservedAt=request.preparedAt;request.requestFingerprint='b'.repeat(64);request.effects[0]={...request.effects[0],state:'PERMITTED',permittedAt:request.preparedAt};
 transaction(db,()=>writeImageReviewLedger(db,{...ledger,request,call:null}));const retained=readImageReviewLedger(db,request.requestId)!;assert.equal(retained.request.effects[0].state,'PERMITTED');assert.equal(retained.call,null);
 assert.throws(()=>transaction(db,()=>writeImageReviewLedger(db,ledger)),/安全账/);assert.deepEqual(readImageReviewLedger(db,request.requestId),retained);
 assert.throws(()=>transaction(db,()=>{writeImageReviewLedger(db,{...retained,request:{...retained.request,effects:retained.request.effects.map((e,i)=>i===0?{...e,state:'RECEIVED',receivedAt:e.permittedAt}:e)}});throw Error('synthetic after-ledger rollback');}));assert.deepEqual(readImageReviewLedger(db,request.requestId),retained);
});
test('S05 strict ledger rejects a foreign context, owner, candidate file or adoption claim',async t=>{
 const ledger=await ledgerFixture(t);
 for(const changed of [{id:randomUUID()},{request:{...ledger.request,sku:'OTHER-SKU'}},{context:{...ledger.context,purpose:'detail'}},{files:ledger.files.map((f,i)=>i===1?{...f,sha256:'e'.repeat(64)}:f)},{files:ledger.files.map((f,i)=>i===0?{...f,path:'../foreign.json'}:f)},{adopted:{assetId:randomUUID(),file:{path:'assets/x.png',sha256:ledger.request.candidate.sha256,byteSize:33}}}])assert.throws(()=>validateImageReviewLedger({...ledger,...changed}));
});
