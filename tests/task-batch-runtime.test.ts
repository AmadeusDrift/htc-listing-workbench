import { assertCompletionHistory } from '../src/main/listing-ai/completion-journal.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures/batch.ts';
test('Batch reserves the immutable business call identity once and keeps operation deduplication',async t=>{
 const f=fixture(t,async()=>new Response(JSON.stringify({id:'batch_original',model:'openai/gpt-6-luna',endpoint:'/v1/chat/completions',status:'in_progress'})));
 const op={...f.operation(),aiCallId:randomUUID()},batch=f.service.prepare([op])[0];await f.service.submit(batch.id);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_usage_ledger WHERE id=?').get(op.aiCallId)!.n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_usage_ledger').get()!.n,1);
 assert.throws(()=>f.service.prepare([{...op,aiCallId:randomUUID()}]),/已有Batch身份/);
});

import { fixture as listingFixture } from './fixtures/listing-ai.ts';
test('real ListingAi and AiService stage requests before one Batch POST and consume original reservations',async t=>{
 const f=await listingFixture(t),context=(f.ai as any).context,original=context.fetch,requests:any[]=[];let captured:any;context.now=()=>new Date('2026-10-13T00:00:00Z');
 f.ai.saveConnection({id:'openrouter',apiKey:'batch-runtime-fixture-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});
 for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 context.fetch=async(url:unknown,init:RequestInit)=>{
  requests.push({url:String(url),method:init.method});
  if(init.method==='POST'){assert.equal(String(url),'https://openrouter.ai/api/v1/batches');captured=JSON.parse(String(init.body));return Response.json({id:'batch_app',endpoint:'/v1/chat/completions',model:captured.model,status:'in_progress'});}
  const results=[];for(const r of captured.requests){const response=await original('https://openrouter.ai/api/v1/chat/completions',{method:'POST',body:JSON.stringify({...r.body,model:captured.model})});results.push({custom_id:r.custom_id,response:{status_code:200,body:await response.json()}});}
  return Response.json({id:'batch_app',endpoint:'/v1/chat/completions',model:captured.model,status:'completed',results});
 };
 const runtime=(f.ai as any).batchTasks;assert.ok(runtime,'AiService must own an actual task Batch runtime');
 const scope={taskId:randomUUID(),rowKey:'sku-1',phase:'fields',mode:'deferred_batch',authorize:()=>true};
 await assert.rejects(runtime.run(scope,()=>f.listing.suggest(f.reference)),{name:'BatchWaitingError'});
 assert.equal(requests.length,0);await runtime.flush(scope.taskId);assert.equal(requests.length,1);
 await runtime.reconcile(scope.taskId);
 const result=await runtime.run(scope,()=>f.listing.suggest(f.reference));assert.equal(result.output.kind,'amazon-fields');
 assert.equal(f.ai.getUsageSummary('openrouter').attempts,1);assert.equal(f.ai.listCalls().length,1);
 assert.equal(requests.filter(r=>r.method==='POST').length,1);
 const ledger=JSON.parse((f.ai as any).db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(result.callId).record_json);assert.equal(f.ai.getCall(result.callId)!.startedAt,ledger.startedAt);
});

import { completionOwnerFixture } from './fixtures/completion-owners.ts';
for(const restart of [false,true])test(`automatic task owns Batch waiting, ${restart?'restart':'pause'} revokes adoption, and resumes the original field operation`,async t=>{
 const f=await completionOwnerFixture(t,'automatic'),context=(f.ai as any).context,original=context.fetch;let service=f.ownerService() as any;
 f.ai.saveConnection({id:'openrouter',apiKey:'scheduler-batch-fixture-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});f.ai.saveFunctionSettings({id:'openrouter-review',model:'openai/gpt-6-luna',enabled:true});
 for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 let ready=false,posts=0;const batches=new Map<string,any>();
 context.fetch=async(url:unknown,init:RequestInit)=>{
  if(init.method==='POST'){assert.equal(String(url),'https://openrouter.ai/api/v1/batches');const body=JSON.parse(String(init.body)),id='batch_scheduler_'+(++posts);batches.set(id,body);return Response.json({id,model:body.model,endpoint:'/v1/chat/completions',status:'in_progress'});}
  const id=String(url).split('/').at(-1)!,body=batches.get(id),results=[];
  if(ready)for(const request of body.requests){const response=await original('https://openrouter.ai/api/v1/chat/completions',{method:'POST',body:JSON.stringify({...request.body,model:body.model})});results.push({custom_id:request.custom_id,response:{status_code:200,body:await response.json()}});}
  return Response.json({id,model:body.model,endpoint:'/v1/chat/completions',status:ready?'completed':'in_progress',results});
 };
 (f.listing as any).copyReviewEnabled=()=>true;let rechecks=0;service.deps.recheckImage=async()=>{rechecks++;throw Error('Downstream image recheck sentinel');};
 service.deps.batch=f.ai.batchTasks;service.deps.batchPlan=()=>f.ai.taskBatchPlan();service.deps.execution.pause=()=>f.child;service.deps.execution.cancel=()=>f.child;
 let task=[...service.tasks.values()][0] as any;task.executionMode='deferred_batch';task.batchPlan=f.ai.taskBatchPlan();task.status='QUEUED';service.save(task);service.grants.add(task.id);service.pump();await service.waitForIdle();
 assert.equal(task.status,'WAITING',JSON.stringify(task.items));assert.ok(task.items[0].batchWait);assert.equal(posts,1);assert.equal(service.grants.has(task.id),true);
 const attempts=task.items[0].repairAttempts,opId=task.items[0].repair.operationId;
 if(restart){await f.reopen();service=f.ownerService() as any;task=[...service.tasks.values()][0] as any;assert.equal(task.status,'PAUSED');assert.equal(service.grants.size,0);}else service.pause(task.id);ready=true;await service.refreshWaiting();assert.equal(task.status,'PAUSED');assert.equal(f.ai.listResults(f.product.id).length,0);assert.equal(task.items[0].repairAttempts,attempts);
 service.startAuthorized(service.prepareStart(task.id));
 for(let i=0;i<8;i++){await new Promise(resolve=>setImmediate(resolve));await service.waitForIdle();if(task.status==='NEEDS_ATTENTION')break;}
 assert.equal(task.items[0].repair.operationId,opId);assert.equal(task.items[0].repairAttempts,attempts);
 assert.equal(f.ai.getUsageSummary('openrouter').attempts,1);assert.equal(posts,2,JSON.stringify(task.items[0]));
 assert.equal(f.ai.getUsageSummary('openrouter-review').attempts,1);
 assert.equal(task.items[0].repair.phase,'RECHECK_PENDING');assert.equal(rechecks,1);assertCompletionHistory((f.ai as any).db);assertBatchHistory((f.ai as any).db);
});

import { saveInput } from './fixtures/listing-ai.ts';
import { addSourceOriginalFixture,confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import { assertBatchHistory } from '../src/main/ai/batch/records.ts';
test('ready real requests from different SKUs share one Batch and duplicate adoption cannot create another result',async t=>{
 const f=await listingFixture(t),context=(f.ai as any).context,original=context.fetch;let posts=0,body:any;
 let product=f.store.createProduct();product=f.store.saveProduct({...saveInput(product),title:'Second coaster',facts:f.product.facts.map(fact=>({...fact,id:randomUUID()})),variants:saveInput(product).variants.map(v=>({...v,normalizedSpec:'Blue'}))});
 product=addSourceOriginalFixture(f.directory,f.store,product.id,product.variants.map(v=>v.id));await confirmSourceConsistencyFixture(f.directory,f.store,product.id);
 const draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
 f.ai.saveConnection({id:'openrouter',apiKey:'two-sku-batch-fixture-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});
 for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 context.fetch=async(url:unknown,init:RequestInit)=>{
  if(init.method==='POST'){assert.equal(String(url),'https://openrouter.ai/api/v1/batches');posts++;body=JSON.parse(String(init.body));return Response.json({id:'batch_two',model:body.model,endpoint:'/v1/chat/completions',status:'in_progress'});}
  const results=[];for(const request of [...body.requests].reverse()){const response=await original('fake',{method:'POST',body:JSON.stringify({...request.body,model:body.model})}),raw=await response.json();raw.usage.cost=.012;results.push({custom_id:request.custom_id,response:{status_code:200,body:raw}});}
  return Response.json({id:'batch_two',model:body.model,endpoint:'/v1/chat/completions',status:'completed',results});
 };
 const runtime=f.ai.batchTasks,taskId=randomUUID(),references=[f.reference,{draftId:draft.id,draftRevision:draft.revision}],scopes=references.map((_r,i)=>({taskId,rowKey:'sku-'+i,phase:'fields',mode:'deferred_batch' as const,authorize:()=>true}));
 for(let i=0;i<2;i++)await assert.rejects(runtime.run(scopes[i],()=>f.listing.suggest(references[i])),{name:'BatchWaitingError'});
 assert.equal(posts,0);await runtime.flush(taskId);assert.equal(posts,1);assert.equal(body.requests.length,2);
 await runtime.reconcile(taskId);
 const first=await runtime.run(scopes[0],()=>f.listing.suggest(references[0])),second=await runtime.run(scopes[1],()=>f.listing.suggest(references[1]));
 assert.notEqual(first.productId,second.productId);assert.equal((await runtime.run(scopes[0],()=>f.listing.suggest(references[0]))).id,first.id);
 assert.equal(f.ai.listResults(first.productId).length,1);assert.equal(f.ai.getUsageSummary('openrouter').attempts,2);assert.equal(posts,1);assertBatchHistory((f.ai as any).db);const day=new Date().toISOString().slice(0,10),report=f.ai.getUsageReport({from:day,to:day});assert.equal(report.calls,2);assert.equal(report.totalCostUsd,.024);
});

import { AiService } from '../src/main/ai/service.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { mockStorage } from './fixtures/listing-ai.ts';
test('unknown Batch creation survives AiService restart and switching to immediate never resends',async t=>{
 const f=await listingFixture(t),context=(f.ai as any).context;let posts=0;
 f.ai.saveConnection({id:'openrouter',apiKey:'unknown-batch-fixture-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});
 for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 const fetcher=async()=>{posts++;throw Error('connection lost after remote acceptance');};context.fetch=fetcher;
 const scope={taskId:randomUUID(),rowKey:f.draft.sku,phase:'fields',mode:'deferred_batch' as 'immediate'|'deferred_batch',purposes:f.ai.taskBatchPlan().purposes,authorize:()=>true};
 await assert.rejects(f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference)),{name:'BatchWaitingError'});
 await assert.rejects(f.ai.batchTasks.flush(scope.taskId));assert.equal(posts,1);
 await f.ai.close();const restored=new AiService(f.directory,f.store,f.hosting,mockStorage,{fetch:fetcher}),listing=new ListingAiService(f.store,f.amazon,restored);const closeOriginal=f.ai.close.bind(f.ai);f.ai.close=async()=>{await restored.close();await closeOriginal();};
 scope.mode='immediate';await assert.rejects(restored.batchTasks.run(scope,()=>listing.suggest(f.reference)),{name:'BatchWaitingError'});
 await restored.batchTasks.flush(scope.taskId);assert.equal(posts,1);assert.equal(restored.getUsageSummary('openrouter').attempts,1);
 assert.equal(restored.batchTasks.batches(scope.taskId)[0].state,'submission_unknown');assertBatchHistory((restored as any).db);
});

test('ImageWorkflow preserves its content operation while Batch is waiting',async t=>{
 const f=await completionOwnerFixture(t,'images'),context=(f.ai as any).context,original=context.fetch;let body:any;
 f.ai.saveConnection({id:'openrouter',apiKey:'image-owner-batch-fixture-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});f.ai.saveFunctionSettings({id:'openrouter-review',model:'openai/gpt-6-luna',enabled:true});
 for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 context.fetch=async(_url:unknown,init:RequestInit)=>{
  if(init.method==='POST'){body=JSON.parse(String(init.body));return Response.json({id:'batch_image_owner',model:body.model,endpoint:'/v1/chat/completions',status:'in_progress'});}
  const results=[];for(const request of body.requests){const response=await original('fake',{method:'POST',body:JSON.stringify({...request.body,model:body.model})});results.push({custom_id:request.custom_id,response:{status_code:200,body:await response.json()}});}
  return Response.json({id:'batch_image_owner',model:body.model,endpoint:'/v1/chat/completions',status:'completed',results});
 };
 const scope={taskId:randomUUID(),rowKey:f.draft.sku,phase:'images',mode:'deferred_batch' as const,authorize:()=>true};
 await assert.rejects(f.ai.batchTasks.run(scope,()=>f.run()),{name:'BatchWaitingError'});
 const waiting=f.progress() as any;assert.equal(waiting.status,'WAITING_BATCH');assert.ok(waiting.contentPreparation.operationId);
 const op=waiting.contentPreparation.operationId;await f.ai.batchTasks.flush(scope.taskId);await f.ai.batchTasks.reconcile(scope.taskId);
 await assert.rejects(f.ai.batchTasks.run(scope,()=>f.run()),/Downstream image plan sentinel/);
 const resumed=f.progress() as any;assert.equal(resumed.id,waiting.id);assert.equal(resumed.contentPreparation.operationId,op);assert.equal(resumed.copyRepairAttempts??0,waiting.copyRepairAttempts??0);assert.equal(f.ai.getUsageSummary('openrouter').attempts,1);
});

import { TaskBatchRuntime } from '../src/main/ai/batch/task-runtime.ts';
for(const pointerOnly of [false,true])test(`runtime recovers ${pointerOnly?'pointer-only':'saved'} create receipt without remote identity or another POST`,async t=>{
 let posts=0,gets=0;
 const fetcher:typeof fetch=async(_url,init)=>{if(init?.method==='POST')posts++;else gets++;return Response.json({id:'batch_saved_runtime',model:'openai/gpt-6-luna',endpoint:'/v1/chat/completions',status:'in_progress'});};
 const f=fixture(t,fetcher),operation=f.operation(),runtime=new TaskBatchRuntime(f.db,f.directory,{fetch:fetcher,credential:()=>({apiKey:'batch-fixture-private-key',scope:operation.credentialScope})}),scope={taskId:operation.taskId,rowKey:'sku',phase:'copy',mode:'deferred_batch' as const,authorize:()=>true};
 await assert.rejects(runtime.run(scope,()=>runtime.request({operation,authorize:scope.authorize,reserve:()=>{}})),{name:'BatchWaitingError'});await runtime.flush(scope.taskId);
 const batch=runtime.batches(scope.taskId)[0];
 if(pointerOnly)f.db.exec('DELETE FROM ai_provider_receipts');
 f.db.prepare('UPDATE ai_batches SET record_json=? WHERE id=?').run(JSON.stringify({...batch,state:'submission_unknown',remoteBatchId:null,remoteStatus:null,...(pointerOnly?{receiptIds:[]}:{})}),batch.id);
 await runtime.reconcile(scope.taskId);assert.equal(runtime.service.get(batch.id).remoteBatchId,'batch_saved_runtime');assert.equal(posts,1);assert.equal(gets,0);
 await runtime.reconcile(scope.taskId);assert.equal(posts,1);assert.equal(gets,1);
});

for(const revoke of [false,true,'stop'] as const)test(`runtime isolates group submission failure and ${revoke==='stop'?'honors local stop before later groups':revoke?'rechecks revoked authorization before later groups':'continues later groups and GET recovery'}`,async t=>{
 let posts=0,gets=0,authorized=true,secondBody:any;
 const fetcher:typeof fetch=async(_url,init)=>{
  if(init?.method==='POST'){posts++;if(posts===1){if(revoke)authorized=false;if(revoke==='stop')runtime.stop(first.taskId);throw Error('first group create identity unknown');}secondBody=JSON.parse(String(init.body));return Response.json({id:'batch_runtime_second',model:secondBody.model,endpoint:'/v1/chat/completions',status:'in_progress'});}
  gets++;return Response.json({id:'batch_runtime_second',model:secondBody.model,endpoint:'/v1/chat/completions',status:'completed',results:secondBody.requests.map((r:any)=>({custom_id:r.custom_id,response:{status_code:200,body:{id:'result_second',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2},choices:[{finish_reason:'stop',message:{content:'{}'}}]}}}))});
 };
 const f=fixture(t,fetcher),first=f.operation(),second={...f.operation(),phase:'review'},runtime=new TaskBatchRuntime(f.db,f.directory,{fetch:fetcher,credential:()=>({apiKey:'batch-fixture-private-key',scope:first.credentialScope})}),scope={taskId:first.taskId,rowKey:'sku',phase:'copy',mode:'deferred_batch' as const,authorize:()=>authorized};
 for(const operation of [first,second])await assert.rejects(runtime.run(scope,()=>runtime.request({operation,authorize:scope.authorize,reserve:()=>{}})),{name:'BatchWaitingError'});
 await assert.rejects(runtime.flush(first.taskId));assert.equal(runtime.find(first.operationId)!.state,'waiting');
 assert.equal(runtime.service.get(runtime.find(first.operationId)!.batchId).state,'submission_unknown');
 if(revoke){assert.equal(posts,1);assert.equal(runtime.find(second.operationId)!.state,'prepared');authorized=true;runtime.resume(first.taskId);if(revoke==='stop')await assert.rejects(runtime.run(scope,()=>runtime.request({operation:second,authorize:scope.authorize,reserve:()=>{}})),{name:'BatchWaitingError'});await runtime.flush(first.taskId);}
 assert.equal(posts,2);assert.equal(runtime.service.get(runtime.find(second.operationId)!.batchId).remoteBatchId,'batch_runtime_second');
 await assert.rejects(runtime.reconcile(first.taskId),/未知/);assert.equal(runtime.ready(second.operationId),true);assert.equal(gets,1);assert.equal(posts,2);
});

import { chat } from './fixtures/listing-ai.ts';
for(const scenario of ['unscoped','immediate-openrouter','immediate-deepseek','deferred-deepseek','deferred-unpinned-vision'] as const)test(`ordinary retry allocates a new paid attempt: ${scenario}`,async t=>{
 const f=await listingFixture(t),context=(f.ai as any).context,original=context.fetch,openrouter=!scenario.includes('deepseek');let posts=0;
 if(openrouter){f.ai.saveConnection({id:'openrouter',apiKey:'ordinary-attempt-fixture-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});}
 const vision=scenario==='deferred-unpinned-vision',color=f.ai.sourceColorContext({productId:f.product.id,productRevision:f.product.revision,variantId:f.product.variants[0].id}),providerId=openrouter?'openrouter':'deepseek';
 context.fetch=async(url:unknown,init:RequestInit)=>{posts++;assert.equal(String(url),openrouter?'https://openrouter.ai/api/v1/chat/completions':'https://api.deepseek.com/chat/completions');if(posts===1)throw Error('ordinary temporary connection loss');if(vision){assert.match(String(init.body),/data:image\/png;base64/);return chat({kind:'source-color',verdict:'DETERMINED',colors:['Blue'],reason:'Visible blue body',referenceAssetIds:color.referenceAssets.map(r=>r.assetId)});}return original(url,init);};
 f.ai.setUsagePolicy({providerId,dailyCallLimit:2,dailyTokenLimit:null});
 const scope={taskId:randomUUID(),rowKey:f.draft.sku,phase:'fields',mode:scenario.startsWith('deferred')?'deferred_batch' as const:'immediate' as const,authorize:()=>true};
 const execute=()=>vision?f.ai.observeSourceColor(color,()=>{}):f.listing.suggest(f.reference),run=()=>scenario==='unscoped'?execute():f.ai.batchTasks.run(scope,execute);
 await assert.rejects(run(),{code:'NETWORK_ERROR'});const result=await run();assert.equal(result.output.kind,vision?'source-color':'amazon-fields');
 assert.equal(posts,2);const calls=f.ai.listCalls();assert.equal(calls.length,2);assert.notEqual(calls[0].id,calls[1].id);assert.equal(f.ai.getUsageSummary(providerId).attempts,2);assert.equal(f.ai.getUsageSummary(providerId).unknownCalls,1);
 await assert.rejects(run(),{code:'QUOTA_EXCEEDED'});assert.equal(posts,2);assert.equal(f.ai.getUsageSummary(providerId).attempts,2);assert.equal(f.ai.batchTasks.batches(scope.taskId).length,0);
});

test('switching immediate while a Batch operation is only staged cannot send an ordinary duplicate',async t=>{
 const f=await listingFixture(t),context=(f.ai as any).context;let posts=0;
 f.ai.saveConnection({id:'openrouter',apiKey:'staged-mode-fixture-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 context.fetch=async(url:unknown,init:RequestInit)=>{posts++;assert.equal(String(url),'https://openrouter.ai/api/v1/batches');const body=JSON.parse(String(init.body));return Response.json({id:'batch_staged_mode',model:body.model,endpoint:'/v1/chat/completions',status:'in_progress'});};
 const scope={taskId:randomUUID(),rowKey:f.draft.sku,phase:'fields',mode:'deferred_batch' as 'immediate'|'deferred_batch',authorize:()=>true},run=()=>f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference));
 await assert.rejects(run(),{name:'BatchWaitingError'});scope.mode='immediate';await assert.rejects(run(),{name:'BatchWaitingError'});assert.equal(posts,0);
 await f.ai.batchTasks.flush(scope.taskId);assert.equal(posts,1);await assert.rejects(run(),{name:'BatchWaitingError'});assert.equal(posts,1);assert.equal(f.ai.getUsageSummary('openrouter').attempts,1);
});

test('explicit immediate resume of a stopped unsent Batch plan makes one fresh ordinary attempt',async t=>{
 const f=await listingFixture(t),context=(f.ai as any).context,original=context.fetch;let posts=0;
 f.ai.saveConnection({id:'openrouter',apiKey:'unsent-mode-fixture-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 context.fetch=async(url:unknown,init:RequestInit)=>{posts++;assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');return original(url,init);};
 const scope={taskId:randomUUID(),rowKey:f.draft.sku,phase:'fields',mode:'deferred_batch' as 'immediate'|'deferred_batch',waitingOperationId:undefined as string|undefined,authorize:()=>true};
 await assert.rejects(f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference)),(error:any)=>{scope.waitingOperationId=error.operationId;return error.name==='BatchWaitingError';});
 f.ai.batchTasks.stop(scope.taskId);scope.mode='immediate';f.ai.batchTasks.resume(scope.taskId);
 const result=await f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference));assert.equal(result.output.kind,'amazon-fields');assert.equal(posts,1);assert.equal(f.ai.batchTasks.batches(scope.taskId).length,0);assert.equal(f.ai.getUsageSummary('openrouter').attempts,1);assert.notEqual(result.callId,scope.waitingOperationId);
});
