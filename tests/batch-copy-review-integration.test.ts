import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, candidateFor, reviewFor, chat } from './fixtures/listing-ai.ts';
import { assertCopyReviewHistory } from '../src/main/ai/copy-review-upgrade.ts';
import { assertBatchHistory } from '../src/main/ai/batch/records.ts';
test('W08+A19 real Batch runtime recovers both review stages once under original budget identities',async t=>{
 const f=await fixture(t),context=(f.ai as any).context;
 f.ai.saveConnection({id:'openrouter',apiKey:'isolated-review-batch-key'});
 f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});f.ai.saveFunctionSettings({id:'openrouter-review',model:'openai/gpt-6-luna',enabled:true});
 for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:p.purposeId==='copy_review_difficult'?'openai/gpt-6.1-sol':'openai/gpt-6-luna',effort:'medium'}});
 let posts=0;const batches=new Map<string,any>();
 context.fetch=async(_url:unknown,init:RequestInit)=>{
   if(init.method==='POST'){const body=JSON.parse(String(init.body)),id='batch_review_'+(++posts);batches.set(id,body);return Response.json({id,model:body.model,endpoint:'/v1/chat/completions',status:'in_progress'});}
   const id=String(_url).split('/').at(-1)!,body=batches.get(id),results=[];
   for(const request of body.requests){const p=JSON.parse(request.body.messages[1].content),output:any=p.candidate?reviewFor(p):candidateFor(p);if(p.candidate&&body.model==='openai/gpt-6-luna'){output.verdict='BLOCKED';output.checks[0].verdict='CONTRADICTED';output.checks[0].claims[0].verdict='CONTRADICTED';output.issues=[{field:output.checks[0].field,message:'Requires independent evidence review'}];}results.push({custom_id:request.custom_id,response:{status_code:200,body:await chat(output).json()}});}
   return Response.json({id,model:body.model,endpoint:'/v1/chat/completions',status:'completed',results});
 };
 const runtime=f.ai.batchTasks,scope={taskId:randomUUID(),rowKey:f.draft.productId+':'+f.draft.variantId,phase:'fields',mode:'deferred_batch' as const,authorize:()=>true};
 await assert.rejects(runtime.run(scope,()=>f.listing.suggest(f.reference)),{name:'BatchWaitingError'});await runtime.flush(scope.taskId);await runtime.reconcile(scope.taskId);
 const suggestion=await runtime.run(scope,()=>f.listing.suggest(f.reference)),input={...f.reference,suggestionResultId:suggestion.id};
 await assert.rejects(runtime.run(scope,()=>f.listing.review(input)),{name:'BatchWaitingError'});await runtime.flush(scope.taskId);await runtime.reconcile(scope.taskId);
 await assert.rejects(runtime.run(scope,()=>f.listing.review(input)),{name:'BatchWaitingError'});await runtime.flush(scope.taskId);await runtime.reconcile(scope.taskId);
 const review=await runtime.run(scope,()=>f.listing.review(input));assert.equal(review.model,'openai/gpt-6.1-sol');assert.equal(posts,3);
 assert.equal((await runtime.run(scope,()=>f.listing.review(input))).id,review.id);await runtime.reconcile(scope.taskId);assert.equal(posts,3);
 const db=(f.ai as any).db;
 const history=()=>JSON.stringify(['ai_calls','ai_results','ai_usage_ledger','ai_batch_items','ai_copy_review_upgrades'].map(table=>db.prepare(`SELECT record_json FROM ${table} ORDER BY id`).all()));
 const before=history(),waitingScope={...scope,waitingOperationId:review.callId};
 const duplicates=await Promise.all(Array.from({length:3},()=>runtime.run(waitingScope,()=>f.listing.review(input))));
 assert.ok(duplicates.every(result=>result.id===review.id));await runtime.reconcile(scope.taskId);await runtime.flush(scope.taskId);
 assert.equal(history(),before,'late waiting-operation replay must retain both calls, results, usage and single adoption');assert.equal(posts,3);
 const items=runtime.batches(scope.taskId).flatMap(batch=>runtime.service.items(batch.id));assert.equal(items.length,3);assert.ok(items.every(item=>item.adoption));
 const calls=f.ai.listCalls();assert.equal(calls.length,3);assert.equal(f.ai.getUsageSummary('openrouter-review').attempts,2);
 for(const call of calls){const ledger=JSON.parse(db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(call.id).record_json);assert.equal(ledger.startedAt,call.startedAt);assert.equal(db.prepare('SELECT count(*) n FROM ai_usage_ledger WHERE id=?').get(call.id).n,1);}
 assertCopyReviewHistory(db);assertBatchHistory(db);
});


test('W14 current-copy Batch replay retains the completed pair and never stages a third review',async t=>{
 const f=await fixture(t),context=(f.ai as any).context;
 f.ai.saveConnection({id:'openrouter',apiKey:'isolated-review-batch-key'});
 f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});f.ai.saveFunctionSettings({id:'openrouter-review',model:'openai/gpt-6-luna',enabled:true});
 for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:p.purposeId==='copy_review_difficult'?'openai/gpt-6.1-sol':'openai/gpt-6-luna',effort:'medium'}});
 let posts=0;const batches=new Map<string,any>();
 context.fetch=async(_url:unknown,init:RequestInit)=>{
   if(init.method==='POST'){const body=JSON.parse(String(init.body)),id='batch_review_'+(++posts);batches.set(id,body);return Response.json({id,model:body.model,endpoint:'/v1/chat/completions',status:'in_progress'});}
   const id=String(_url).split('/').at(-1)!,body=batches.get(id),results=[];
   for(const request of body.requests){const p=JSON.parse(request.body.messages[1].content),output:any={kind:'amazon-fields-review',verdict:'PASS',checks:p.candidate.candidates.flatMap((c:any)=>c.items.map((_:any,index:number)=>({field:c.field,index,verdict:'SUPPORTED',evidenceIds:[],reason:'Reviewed complete wording',claims:[]}))),issues:[]};if(p.candidate&&body.model==='openai/gpt-6-luna'){output.verdict='BLOCKED';output.checks[0].verdict='CONTRADICTED';output.issues=[{field:output.checks[0].field,message:'Requires independent evidence review'}];}results.push({custom_id:request.custom_id,response:{status_code:200,body:await chat(output).json()}});}
   return Response.json({id,model:body.model,endpoint:'/v1/chat/completions',status:'completed',results});
 };
 const runtime=f.ai.batchTasks,scope={taskId:randomUUID(),rowKey:f.draft.productId+':'+f.draft.variantId,phase:'copy',mode:'deferred_batch' as const,authorize:()=>true};
 const listingContext=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation),copy=[{field:'item_name',values:['Blue Silicone Coaster']}];
 const review=()=>f.ai.reviewCurrentListing(listingContext,copy,async()=>{});
 await assert.rejects(runtime.run(scope,review),{name:'BatchWaitingError'});await runtime.flush(scope.taskId);await runtime.reconcile(scope.taskId);
 await assert.rejects(runtime.run(scope,review),{name:'BatchWaitingError'});await runtime.flush(scope.taskId);await runtime.reconcile(scope.taskId);
 const result=await runtime.run(scope,review),db=(f.ai as any).db;
 const history=()=>JSON.stringify(['ai_calls','ai_results','ai_usage_ledger','ai_batch_items','ai_copy_review_upgrades'].map(table=>db.prepare(`SELECT record_json FROM ${table} ORDER BY id`).all()));
 const before=history(),waitingScope={...scope,waitingOperationId:result.callId};
 const duplicates=await Promise.all(Array.from({length:3},()=>runtime.run(waitingScope,review)));
 assert.ok(duplicates.every(value=>value.id===result.id));await runtime.reconcile(scope.taskId);await runtime.flush(scope.taskId);
 assert.equal(posts,2);assert.equal(history(),before);assert.equal(f.ai.getUsageSummary('openrouter-review').attempts,2);
 assertCopyReviewHistory(db);assertBatchHistory(db);
});
