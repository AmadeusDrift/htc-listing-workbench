import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture,isCode} from './fixtures/ai-control.ts';
import {validateCategoryDecision} from '../src/main/ai/category-adapter.ts';
import {listingFingerprint} from '../src/main/json-fingerprint.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {RunReportReader} from '../src/main/diagnostics/run-report.ts';
import {validateAiCall,validateStoredAiResult} from '../src/main/ai/validation.ts';
const contract=await import('../src/main/ai/category-context.ts').catch(()=>null);
const candidates=[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}];
const candidateSnapshotSha256=listingFingerprint(candidates);
const decision=(outcome:'SELECTED'|'NO_SUITABLE',sha=candidateSnapshotSha256)=>({kind:'category-decision',phase:'judge',keywords:[],productType:outcome==='SELECTED'?'CLEANING_CLOTH':null,reason:'Only supplied candidates considered.',ambiguous:false,selection:{version:1,outcome,candidateSnapshotSha256:sha}});

test('explicit no-suitable outcome is distinct from a legacy missing category',()=>{
 assert.deepEqual(validateCategoryDecision(decision('NO_SUITABLE')),decision('NO_SUITABLE'));
 const {selection:_,...legacy}=decision('NO_SUITABLE');
 assert.throws(()=>validateCategoryDecision(legacy),isCode('OUTPUT_INVALID'));
 assert.throws(()=>validateCategoryDecision({...decision('NO_SUITABLE'),productType:'CLEANING_CLOTH'}),isCode('OUTPUT_INVALID'));
 assert.throws(()=>validateCategoryDecision({...decision('SELECTED'),productType:null}),isCode('OUTPUT_INVALID'));
 assert.throws(()=>validateCategoryDecision({...decision('NO_SUITABLE'),phase:'keywords',keywords:['cloth']}),isCode('OUTPUT_INVALID'));
});

test('category operation is stable while input and candidate snapshots remain exact recovery evidence',()=>{
 assert.ok(contract,'category continuation context contract missing');
 const productId=randomUUID(),operationId=contract.categoryOperationId(productId);
 const old={version:1,phase:'judge',requestSha256:'a'.repeat(64)};
 assert.deepEqual(contract.validateCategoryPhaseContext(old),old);
 const current={...old,version:2,operationId,inputVersion:'b'.repeat(64),candidateSnapshotSha256,expansion:0};
 assert.deepEqual(contract.validateCategoryPhaseContext(current,productId),current);
 assert.equal(contract.categoryOperationId(productId),operationId);
 assert.throws(()=>contract.validateCategoryPhaseContext({...current,operationId:randomUUID()},productId),isCode('INVALID_INPUT'));
 assert.throws(()=>contract.validateCategoryPhaseContext({...current,expansion:2},productId),isCode('INVALID_INPUT'));
 assert.throws(()=>contract.validateCategoryPhaseContext({...current,model:'replacement'},productId),isCode('INVALID_INPUT'));
 assert.throws(()=>contract.validateCategoryPhaseContext({...current,version:'2'},productId),isCode('INVALID_INPUT'));
 assert.notEqual(contract.categoryCandidateSnapshot([...candidates,{name:'DISH',displayName:'Dish'}]),candidateSnapshotSha256);
});

for(const outcome of ['SELECTED','NO_SUITABLE','bad-snapshot','legacy-null'] as const)test(`actual AiService HTTP category contract ${outcome}`,async t=>{
 let posts=0;
 const raw=outcome==='legacy-null'?{...decision('NO_SUITABLE'),selection:undefined}:outcome==='bad-snapshot'?decision('SELECTED','f'.repeat(64)):decision(outcome);
 const server=createServer((request,response)=>{request.resume();request.on('end',()=>{assert.equal(request.method,'POST');posts++;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({id:'s03-contract',choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5},cost:.001}));});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
 const address=server.address();assert.ok(address&&typeof address==='object');
 const f=await fixture(t,{fetch:async(_url,options)=>fetch(`http://127.0.0.1:${address.port}/chat`,options)});
 f.service.saveConnection({id:'openrouter',apiKey:'s03-synthetic-only'});f.service.setEnabled({id:'openrouter-review',enabled:true});
 const taskId=randomUUID(),rowKey=f.product.id+':'+f.product.variants[0].id,db=(f.service as unknown as {db:import('node:sqlite').DatabaseSync}).db;
 db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(taskId,JSON.stringify({id:taskId,revision:1,items:[{key:rowKey,productId:f.product.id,sku:'S03-CONTRACT',draftId:null}]}));
 const pending=taskAiContext.run({taskId,rowKey,phase:'CATEGORY',mode:'immediate',authorize:()=>true},()=>f.service.decideCategory({productId:f.product.id,productRevision:f.product.revision,phase:'judge',candidates}));
 if(outcome==='SELECTED'||outcome==='NO_SUITABLE'){
  const result=await pending;assert.deepEqual(result.output,raw);
  assert.equal(f.service.getCall(result.callId)!.status,'SUCCEEDED');
  assert.deepEqual(validateStoredAiResult(result).output,result.output);
  const call=f.service.getCall(result.callId)!;
  assert.ok(contract);
  const v2={...call,categoryContext:{...call.categoryContext,version:2,operationId:contract.categoryOperationId(call.productId),inputVersion:'b'.repeat(64),candidateSnapshotSha256,expansion:0}};
  assert.deepEqual(validateAiCall(v2).categoryContext,v2.categoryContext);
  assert.throws(()=>validateAiCall({...v2,requestScope:{...call.requestScope,phase:'select'}}));
 }else {
  await assert.rejects(pending,isCode('OUTPUT_INVALID'));
  const report=new RunReportReader(db).query({taskId});
  assert.equal(report.calls[0].certainty,'RECEIVED_INVALID');assert.equal(report.counts.validResults,0);
 }
 assert.equal(posts,1);assert.equal(f.requests.length,1);
 assert.equal(f.service.listCalls().length,1);assert.equal(f.service.getUsageSummary('openrouter-review').reportedTokens,5);
 const receipt=await f.service.readProviderReceipt(f.service.listCalls()[0].id) as {body:{choices:unknown[]}};
 assert.ok(receipt.body.choices.length,'original HTTP receipt retained');
});
