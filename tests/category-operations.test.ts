import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer,get} from 'node:http';
import {fixture} from './fixtures/ai-control.ts';
import {slowHttp} from './fixtures/stabilization/slow-http.ts';
import {AiUsageLedger} from '../src/main/ai/usage.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {transaction} from '../src/main/application/transaction.ts';
import {categoryCandidateSnapshot} from '../src/main/ai/category-context.ts';
import {listingFingerprint} from '../src/main/json-fingerprint.ts';
import {readCategoryOperation,reserveCategoryPhaseRepair,reserveCategoryExpansion,permitCategoryExpansionRequest,storeCategoryExpansionSnapshot,retainCategoryOperations} from '../src/main/ai/category-operations.ts';
import type {CategoryExpansionOperation} from '../src/shared/category-operation-contracts.ts';
const candidates=[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}];
const ddl='CREATE TABLE ai_category_operations(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)';
async function owned(t:test.TestContext,noSuitable=false){
 const snapshot=categoryCandidateSnapshot(candidates),body={id:'s03-owned',choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'category-decision',phase:'judge',keywords:[],productType:null,reason:'Synthetic only.',ambiguous:false,...(noSuitable?{selection:{version:1,outcome:'NO_SUITABLE',candidateSnapshotSha256:snapshot}}:{})})}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:.002}};
 const http=await slowHttp({body:JSON.stringify(body)});t.after(()=>http.close());const f=await fixture(t,{fetch:async(_url,init)=>fetch(http.url,init)});f.service.saveConnection({id:'openrouter',apiKey:'s03-operation-only'});f.service.setEnabled({id:'openrouter-review',enabled:true});
 const db=(f.service as unknown as {db:DatabaseSync}).db;db.exec(ddl);
 const pending=f.service.decideCategory({productId:f.product.id,productRevision:f.product.revision,phase:'judge',candidates});const result=noSuitable?await pending:await pending.catch(error=>{assert.equal(error.certainty,'RECEIVED_INVALID');return null;});
 const prior=f.service.listCalls()[0],context=prior.categoryContext;assert.ok(context?.version===2);const continuedAt=new Date(Date.parse(prior.finishedAt!)+1).toISOString();
 const scope={taskId:randomUUID(),rowKey:f.product.id+':'+f.product.variants[0].id,phase:'CATEGORY',mode:'immediate' as const,explicitContinueAt:continuedAt,authorize:()=>true};
 const retry={...prior,id:randomUUID(),status:'RUNNING' as const,errorCode:null,requestId:null,startedAt:new Date(Date.parse(prior.finishedAt!)+2).toISOString(),finishedAt:null,usage:{promptTokens:0,completionTokens:0,processedImages:0}};delete retry.providerReceiptId;delete retry.responseReceived;
 const ledger=new AiUsageLedger(db,()=>new Date(retry.startedAt)),wire=String(f.requests[0].options?.body);
 return{...f,http,db,prior,context,scope,retry,ledger,wire,result};
}
test('category repair claim and actual call/usage reservation commit or roll back on the same connection',async t=>{
 const f=await owned(t),beforeCalls=f.db.prepare('SELECT * FROM ai_calls').all(),beforeUsage=f.db.prepare('SELECT * FROM ai_usage_ledger').all();
 await taskAiContext.run(f.scope,async()=>{
  assert.throws(()=>f.ledger.reserve(f.retry,f.wire,call=>{reserveCategoryPhaseRepair(f.db,f.directory,[f.prior],call);throw Error('Second owner write fails');}),/Second owner/);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_calls').all(),beforeCalls);assert.deepEqual(f.db.prepare('SELECT * FROM ai_usage_ledger').all(),beforeUsage);assert.equal(readCategoryOperation(f.db,f.product.id).repairs.length,0);
  f.ledger.reserve(f.retry,f.wire,call=>reserveCategoryPhaseRepair(f.db,f.directory,[f.prior],call));
  assert.equal(readCategoryOperation(f.db,f.product.id).repairs[0].retryCallId,f.retry.id);
  assert.throws(()=>f.ledger.reserve({...f.retry,id:randomUUID()},f.wire,call=>reserveCategoryPhaseRepair(f.db,f.directory,[f.prior],call)));
 });
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get()!.n,2);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_usage_ledger').get()!.n,2);assert.deepEqual(f.service.getCall(f.prior.id),f.prior);assert.equal(f.http.posts,1);
});
test('repair authorization is live at the reservation boundary and failed permission consumes no row',async t=>{
 const f=await owned(t);for(const scope of [undefined,{...f.scope,authorize:()=>false},{...f.scope,rowKey:randomUUID()+':foreign'},{...f.scope,explicitContinueAt:f.prior.startedAt}]){
  const attempt=()=>f.ledger.reserve({...f.retry,id:randomUUID()},f.wire,call=>reserveCategoryPhaseRepair(f.db,f.directory,[f.prior],call));
  if(scope)assert.throws(()=>taskAiContext.run(scope,attempt));else assert.throws(attempt);
 }
 assert.equal(readCategoryOperation(f.db,f.product.id).repairs.length,0);assert.equal(f.service.listCalls().length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_usage_ledger').get()!.n,1);assert.equal(f.http.posts,1);
});
test('same original failure cannot claim a generic repair after its legacy once-only child was recorded',async t=>{
 const f=await owned(t);f.db.prepare('INSERT INTO audit_events(id,product_id,action,summary,detail_json,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),f.product.id,'ai.category.detail-repair','Synthetic old chain',JSON.stringify({priorCallId:f.prior.id,retryCallId:randomUUID()}),f.prior.finishedAt!);
 assert.throws(()=>taskAiContext.run(f.scope,()=>f.ledger.reserve(f.retry,f.wire,call=>reserveCategoryPhaseRepair(f.db,f.directory,[f.prior],call))));assert.equal(f.service.listCalls().length,1);assert.equal(readCategoryOperation(f.db,f.product.id).repairs.length,0);
});
function expansion(f:Awaited<ReturnType<typeof owned>>):CategoryExpansionOperation {
 assert.ok(f.result);const targetId='s03-target',query='cloth';return{version:1,operationId:f.context.operationId,inputVersion:f.context.inputVersion,originalDecisionId:f.result.id,originalCallId:f.prior.id,fromCandidateSnapshotSha256:f.context.candidateSnapshotSha256,claimedAt:new Date(Date.parse(f.result.createdAt)+1).toISOString(),requestId:randomUUID(),targetId,query,requestSha256:listingFingerprint({method:'GET',targetId,query}),permittedAt:null,snapshot:null};
}
test('expansion records require the actual original no-suitable result and preserve a permitted-null stop',async t=>{
 const f=await owned(t,true),claim=expansion(f);
 assert.throws(()=>taskAiContext.run(f.scope,()=>reserveCategoryExpansion(f.db,f.directory,f.product.id,{...claim,originalDecisionId:randomUUID()})));
 taskAiContext.run(f.scope,()=>reserveCategoryExpansion(f.db,f.directory,f.product.id,claim));
 taskAiContext.run(f.scope,()=>permitCategoryExpansionRequest(f.db,f.directory,f.product.id,claim.requestId,claim.claimedAt));
 assert.throws(()=>taskAiContext.run(f.scope,()=>permitCategoryExpansionRequest(f.db,f.directory,f.product.id,claim.requestId,claim.claimedAt)));
 assert.throws(()=>taskAiContext.run(f.scope,()=>reserveCategoryExpansion(f.db,f.directory,f.product.id,{...claim,requestId:randomUUID()})));
 const restored=new DatabaseSync(':memory:');t.after(()=>restored.close());restored.exec(ddl);transaction(restored,()=>retainCategoryOperations(f.db,restored));transaction(restored,()=>retainCategoryOperations(f.db,restored));
 assert.deepEqual(readCategoryOperation(restored,f.product.id),readCategoryOperation(f.db,f.product.id));assert.equal(readCategoryOperation(restored,f.product.id).expansion!.snapshot,null);assert.equal(f.http.posts,1);
});
test('expanded snapshot bytes and receipt hashes are retained and conflicting restore records fail closed',async t=>{
 const f=await owned(t,true),claim=expansion(f);taskAiContext.run(f.scope,()=>reserveCategoryExpansion(f.db,f.directory,f.product.id,claim));taskAiContext.run(f.scope,()=>permitCategoryExpansionRequest(f.db,f.directory,f.product.id,claim.requestId,claim.claimedAt));
 const bytes=Buffer.from(JSON.stringify({candidates})),evidence=candidates.map(candidate=>({name:candidate.name,hitKeywords:['cloth'],sources:['platform' as const]}));
 const snapshot={version:1 as const,candidates,evidence,candidateSnapshotSha256:categoryCandidateSnapshot(candidates),sha256:listingFingerprint({candidates,evidence}),requestId:claim.requestId,receiptSha256:createHash('sha256').update(bytes).digest('hex'),receivedAt:claim.claimedAt};
 storeCategoryExpansionSnapshot(f.db,f.directory,f.product.id,snapshot);const stored=readCategoryOperation(f.db,f.product.id);assert.deepEqual(stored.expansion!.snapshot,snapshot);
 const restored=new DatabaseSync(':memory:');t.after(()=>restored.close());restored.exec(ddl);transaction(restored,()=>retainCategoryOperations(f.db,restored));
 const conflicting={...stored,expansion:{...stored.expansion!,requestId:randomUUID(),snapshot:null}};restored.prepare('UPDATE ai_category_operations SET record_json=? WHERE id=?').run(JSON.stringify(conflicting),stored.id);
 assert.throws(()=>transaction(restored,()=>retainCategoryOperations(f.db,restored)));assert.equal(f.http.posts,1);
});

test('main-only expansion ports keep one actual loopback GET and a separately bound expanded AI call',async t=>{
 const f=await owned(t,true);assert.ok(f.result);const targetId='s03-target',query='cloth',input={productId:f.product.id,productRevision:f.product.revision,originalCallId:f.prior.id,originalDecisionId:f.result.id,targetId,query};
 const expanded=[{name:'DISH',displayName:'Dish'}],bytes=Buffer.from(JSON.stringify({candidates:expanded}));let gets=0;
 const server=createServer((request,response)=>{assert.equal(request.method,'GET');const url=new URL(request.url!,'http://127.0.0.1');assert.equal(url.pathname,'/catalog');assert.equal(url.searchParams.get('targetId'),targetId);assert.equal(url.searchParams.get('query'),query);gets++;response.writeHead(200,{'content-type':'application/json','connection':'close'});response.end(bytes);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));const address=server.address();assert.ok(address&&typeof address==='object');
 const claim=taskAiContext.run(f.scope,()=>f.service.reserveCategoryCandidateExpansion(input));assert.equal(gets,0);
 assert.equal(taskAiContext.run(f.scope,()=>f.service.reserveCategoryCandidateExpansion(input)).requestId,claim.requestId);assert.equal(gets,0);
 const permit=taskAiContext.run(f.scope,()=>f.service.permitCategoryCandidateExpansion({productId:f.product.id,productRevision:f.product.revision,requestId:claim.requestId}));assert.equal(permit.requestSha256,listingFingerprint({method:'GET',targetId,query}));
 const received=await new Promise<Buffer>((resolve,reject)=>{get(`http://127.0.0.1:${address.port}/catalog?targetId=${encodeURIComponent(permit.targetId)}&query=${encodeURIComponent(permit.query)}`,response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(Buffer.concat(chunks)));response.on('error',reject);}).on('error',reject);});assert.deepEqual(received,bytes);
 const evidence=expanded.map(candidate=>({name:candidate.name,hitKeywords:[query],sources:['platform' as const]})),snapshot={version:1 as const,candidates:expanded,evidence,candidateSnapshotSha256:categoryCandidateSnapshot(expanded),sha256:listingFingerprint({candidates:expanded,evidence}),requestId:claim.requestId,receiptSha256:createHash('sha256').update(received).digest('hex'),receivedAt:new Date().toISOString()};
 f.service.retainCategoryCandidateExpansion(f.product.id,snapshot);assert.throws(()=>taskAiContext.run(f.scope,()=>f.service.permitCategoryCandidateExpansion({productId:f.product.id,productRevision:f.product.revision,requestId:claim.requestId})));assert.equal(gets,1);
 const valid=await slowHttp({body:JSON.stringify({id:'s03-expanded',choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'category-decision',phase:'judge',keywords:[],productType:'DISH',reason:'Synthetic expanded match.',ambiguous:false})}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:.002}})});t.after(()=>valid.close());f.respond(async(_url,init)=>fetch(valid.url,init));
 const choice=await taskAiContext.run(f.scope,()=>f.service.decideCategory({productId:f.product.id,productRevision:f.product.revision,phase:'judge',candidates:expanded,expansion:1}));assert.equal(choice.output.productType,'DISH');const call=f.service.getCall(choice.callId)!;assert.ok(call.categoryContext?.version===2);assert.equal(call.categoryContext.expansion,1);assert.equal(call.categoryContext.operationId,claim.operationId);assert.equal(call.categoryContext.inputVersion,claim.inputVersion);assert.equal(call.categoryContext.candidateSnapshotSha256,snapshot.candidateSnapshotSha256);
 assert.equal((await taskAiContext.run(f.scope,()=>f.service.decideCategory({productId:f.product.id,productRevision:f.product.revision,phase:'judge',candidates:expanded,expansion:1}))).id,choice.id);assert.equal(valid.posts,1);assert.equal(f.http.posts,1);assert.equal(gets,1);assert.equal(f.service.getUsageSummary('openrouter-review').attempts,2);
 await assert.rejects(taskAiContext.run(f.scope,()=>f.service.decideCategory({productId:f.product.id,productRevision:f.product.revision,phase:'judge',candidates,expansion:1})));assert.equal(valid.posts,1);
});
