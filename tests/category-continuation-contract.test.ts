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
import {slowHttp} from './fixtures/stabilization/slow-http.ts';
import {AiError} from '../src/main/ai/errors.ts';
import {requestOpenRouterJson} from '../src/main/ai/adapters/openrouter-chat.ts';
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

const validDomain={kind:'category-decision',phase:'judge',keywords:[],productType:'CLEANING_CLOTH',reason:'Synthetic source matched.',ambiguous:false};
const invalidDomains:readonly [string,unknown][]=[
 ['wrong-kind',{...validDomain,kind:'other'}],['wrong-phase',{...validDomain,phase:'wrong'}],
 ['null-keywords',{...validDomain,keywords:null}],['keyword-element-number',{...validDomain,keywords:[4]}],
 ['keyword-element-empty',{...validDomain,keywords:['']}],['keyword-element-control',{...validDomain,keywords:['bad\u0001word']}],
 ['too-many-keywords',{...validDomain,keywords:Array(9).fill('cloth')}],
 ['missing-key',{kind:'category-decision',phase:'judge',keywords:[],productType:'CLEANING_CLOTH',ambiguous:false}],
 ['extra-key',{...validDomain,extra:'unexpected'}],['null-object',null],['array-object',[]],['scalar-object',5],
 ['numeric-type',{...validDomain,productType:3}],['numeric-reason',{...validDomain,reason:3}],
 ['long-reason',{...validDomain,reason:'r'.repeat(2001)}],['nonboolean-ambiguous',{...validDomain,ambiguous:'false'}],
 ['phase-mismatch',{...validDomain,phase:'select'}],['candidate-mismatch',{...validDomain,productType:'DIFFERENT_TYPE'}],
 ['bad-selection-keys',{...validDomain,selection:{version:1,outcome:'SELECTED',candidateSnapshotSha256,extra:true}}],
];

async function actualCategory(t:test.TestContext,body:string,options:{partial?:string;disconnect?:boolean;delayMs?:number}={}) {
 const http=await slowHttp({body,...options});t.after(()=>http.close());
 const f=await fixture(t,{timeoutMs:2000,fetch:async(_url,init)=>fetch(http.url,init)});
 f.service.saveConnection({id:'openrouter',apiKey:'s03-synthetic-only'});f.service.setEnabled({id:'openrouter',enabled:true});f.service.setEnabled({id:'openrouter-review',enabled:true});
 const taskId=randomUUID(),rowKey=f.product.id+':'+f.product.variants[0].id,db=(f.service as unknown as {db:import('node:sqlite').DatabaseSync}).db;
 db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(taskId,JSON.stringify({id:taskId,revision:1,items:[{key:rowKey,productId:f.product.id,sku:'S03-DOMAIN',draftId:null}]}));
 const scope={taskId,rowKey,phase:'CATEGORY',mode:'immediate' as const,authorize:()=>true};
 const run=(input={productId:f.product.id,productRevision:f.product.revision,phase:'judge' as const,candidates})=>taskAiContext.run(scope,()=>f.service.decideCategory(input));
 return {f,http,db,taskId,run,scope};
}
const categoryEnvelope=(content:unknown)=>({id:'s03-domain',choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:.002}});
for(const [name,raw] of invalidDomains)test(`actual complete category domain ${name} is received-invalid with original call and fee retained`,async t=>{
 const envelope=categoryEnvelope(raw),{f,http,db,taskId,run}=await actualCategory(t,JSON.stringify(envelope));
 const error=await run().catch(error=>error);assert.ok(error instanceof AiError);
 assert.equal(error.code,'OUTPUT_INVALID');assert.equal(error.certainty,'RECEIVED_INVALID');
 assert.equal(http.posts,1);assert.equal(f.requests.length,1);assert.equal(f.service.listCalls().length,1);
 const call=f.service.listCalls()[0],receipt=await f.service.readProviderReceipt(call.id) as {body:unknown;costUsd:number};
 assert.deepEqual(receipt.body,envelope);assert.equal(receipt.costUsd,.002);assert.equal(f.service.getUsageSummary('openrouter-review').reportedTokens,5);
 const reader=new RunReportReader(db),before=JSON.stringify(db.prepare('SELECT record_json FROM ai_calls').all()),changes=db.prepare('SELECT total_changes() n').get()!.n;
 for(let i=0;i<10;i++){const report=reader.query({taskId});assert.equal(report.calls[0].certainty,'RECEIVED_INVALID');assert.equal(report.calls[0].nextAction,'INSPECT_REJECTION_AND_BUDGET');assert.equal(report.counts.validResults,0);}
 assert.equal(db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(JSON.stringify(db.prepare('SELECT record_json FROM ai_calls').all()),before);
 await assert.rejects(run());assert.equal(http.posts,1);assert.deepEqual(f.service.listCalls()[0],call);
});

test('historical category and before-send context readers do not claim a received request',()=>{
 for(const raw of [...invalidDomains.filter(([name])=>!['phase-mismatch','candidate-mismatch'].includes(name)).map(([,raw])=>raw),{...validDomain,productType:null}])assert.throws(()=>validateCategoryDecision(raw),error=>error instanceof AiError&&error.certainty===undefined);
 assert.ok(contract);assert.throws(()=>contract.validateCategoryPhaseContext({version:2}),error=>error instanceof AiError&&error.certainty===undefined);
});

for(const variant of ['content-json','missing-choices','null-choice-envelope','missing-answers','null-choice','wrong-answer-shape','answer-confidence','answer-probabilities'] as const)test(`actual category decoded protocol ${variant} is invalid rather than unknown`,async t=>{
 const select=!['content-json','missing-choices','null-choice-envelope'].includes(variant);
 const envelope=variant==='content-json'?{...categoryEnvelope(validDomain),choices:[{finish_reason:'stop',message:{content:'{"kind":'}}]}:variant==='null-choice-envelope'?{...categoryEnvelope(validDomain),choices:[null]}:variant==='missing-choices'||variant==='missing-answers'?{id:'s03-protocol',usage:{prompt_tokens:2,completion_tokens:3,input_tokens:2,output_tokens:3,total_tokens:5,cost:.002}}:{id:'s03-protocol',answers:{category:variant==='null-choice'?{type:'choice',choice:null}:variant==='wrong-answer-shape'?{type:'noul',noul:1}:{type:'choice',choice:'CLEANING_CLOTH',...(variant==='answer-confidence'?{confidence:2}:{probabilities:{CLEANING_CLOTH:'bad'}})},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3,cost:.002}};
 const {f,http,db,taskId,run}=await actualCategory(t,JSON.stringify(envelope));
 const error=await run({productId:f.product.id,productRevision:f.product.revision,phase:select?'select':'judge',candidates} as Parameters<typeof run>[0]).catch(error=>error);
 assert.ok(error instanceof AiError);assert.equal(error.code,'OUTPUT_INVALID');assert.equal(error.certainty,'RECEIVED_INVALID');
 assert.equal(http.posts,1);assert.equal(f.requests.length,1);assert.equal(f.service.listCalls().length,1);
 const call=f.service.listCalls()[0],receipt=await f.service.readProviderReceipt(call.id) as {body:unknown;costUsd:number};assert.deepEqual(receipt.body,envelope);assert.equal(receipt.costUsd,.002);
 const report=new RunReportReader(db).query({taskId});assert.equal(report.calls[0].certainty,'RECEIVED_INVALID');assert.equal(report.calls[0].nextAction,'INSPECT_REJECTION_AND_BUDGET');assert.equal(report.counts.validResults,0);
 assert.equal(f.service.getUsageSummary(select?'openrouter':'openrouter-review').reportedTokens,5);
});

for(const boundary of ['phase','candidates'] as const)test(`actual before-send invalid category ${boundary} remains unsent`,async t=>{
 const {f,http,db,taskId,run}=await actualCategory(t,JSON.stringify(categoryEnvelope(validDomain)));
 const input={productId:f.product.id,productRevision:f.product.revision,phase:boundary==='phase'?'wrong':'judge',candidates:boundary==='candidates'?[{name:'wrong-code',displayName:'Cloth'}]:candidates};
 const error=await run(input as Parameters<typeof run>[0]).catch(error=>error);assert.ok(error instanceof AiError);
 assert.notEqual(error.certainty,'RECEIVED_INVALID');assert.equal(http.posts,0);assert.equal(f.requests.length,0);assert.equal(f.service.listCalls().length,0);
 const report=new RunReportReader(db).query({taskId});assert.equal(report.counts.totalCalls,0);assert.equal(report.counts.savedReceipts,0);
 assert.ok(report.events.every(event=>event.certainty!=='RECEIVED_INVALID'));
});

test('actual category source change after a valid receipt is not relabeled as invalid output',async t=>{
 const {f,http,db,taskId,scope}=await actualCategory(t,JSON.stringify(categoryEnvelope(validDomain)));
 await assert.rejects(taskAiContext.run(scope,()=>f.service.decideCategory({productId:f.product.id,productRevision:f.product.revision,phase:'judge',candidates},()=>{if(http.posts)throw new AiError('SOURCE_CHANGED');})),error=>error instanceof AiError&&error.code==='SOURCE_CHANGED'&&error.certainty!=='RECEIVED_INVALID');
 assert.equal(http.posts,1);const call=f.service.listCalls()[0];assert.equal(call.errorCode,'SOURCE_CHANGED');assert.ok(await f.service.readProviderReceipt(call.id));
 const report=new RunReportReader(db).query({taskId});assert.equal(report.counts.validResults,0);assert.notEqual(report.calls[0].certainty,'RECEIVED_INVALID');
});

for(const variant of ['partial','echo','processing-error','choice-error'] as const)test(`actual category ${variant} stays unknown before domain parsing`,async t=>{
 const body=variant==='echo'?JSON.stringify(categoryEnvelope({...validDomain,reason:'s03-synthetic-only'})):variant==='processing-error'?JSON.stringify({error:{code:502,message:'Synthetic processing failure'},usage:{cost:.003}}):variant==='choice-error'?JSON.stringify({choices:[{error:{code:502,message:'Synthetic processing failure'}}]}):'';
 const {f,http,db,taskId,run}=await actualCategory(t,body,variant==='partial'?{partial:'{"choices":[',disconnect:true,delayMs:20}:{});
 const error=await run().catch(error=>error);assert.ok(error instanceof AiError);assert.equal(error.certainty,'SENT_UNKNOWN');
 assert.equal(http.posts,1);assert.equal(f.requests.length,1);const call=f.service.listCalls()[0],receipt=await f.service.readProviderReceipt(call.id) as {body:unknown}|null;
 if(variant==='partial')assert.equal(receipt,null);else if(variant==='echo')assert.equal(receipt?.body,'[omitted: credential echo]');else assert.deepEqual(receipt?.body,JSON.parse(body));
 const report=new RunReportReader(db).query({taskId});assert.equal(report.calls[0].certainty,'SENT_UNKNOWN');assert.equal(report.calls[0].nextAction,'VERIFY_ORIGINAL_REQUEST');
 await assert.rejects(run());assert.equal(http.posts,1);assert.equal(f.service.listCalls().length,1);assert.deepEqual(f.service.listCalls()[0],call);
});

for(const variant of ['valid','processing-error','omitted','missing-body','invalid-content'] as const)test(`shared deferred chat parse ${variant} preserves original result certainty without a new POST`,async()=>{
 const body=variant==='valid'?categoryEnvelope(validDomain):variant==='processing-error'?{error:{code:502,message:'Processing failed'}}:variant==='omitted'?'[omitted: credential echo]':variant==='missing-body'?undefined:{choices:[]};
 let posts=0,reservations=0;
 const pending=requestOpenRouterJson({},'Synthetic JSON','openai/gpt-6-luna',{apiKey:'s03-synthetic-only'},new AbortController().signal,{fetch:async()=>{posts++;throw Error('Deferred recovery cannot POST');},now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,effectiveEffort:'none',deferOpenRouter:async()=>({body}),beforeSend:()=>{reservations++;}});
 if(variant==='valid')assert.deepEqual((await pending).content,validDomain);
 else await assert.rejects(pending,error=>error instanceof AiError&&error.certainty===(variant==='invalid-content'?'RECEIVED_INVALID':'SENT_UNKNOWN')&&error.code===(variant==='processing-error'?'PROVIDER_ERROR':'OUTPUT_INVALID'));
 assert.equal(posts,0);assert.equal(reservations,0);
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
