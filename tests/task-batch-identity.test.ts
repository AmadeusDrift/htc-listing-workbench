import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fixture, mockStorage } from './fixtures/listing-ai.ts';
import { AiService } from '../src/main/ai/service.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { assertBatchHistory } from '../src/main/ai/batch/records.ts';
import { openDatabase } from '../src/main/database.ts';
import { readProviderReceipt } from '../src/main/ai/receipts.ts';

async function batchFixture(t: test.TestContext, unknown=false) {
 const f=await fixture(t),context=(f.ai as any).context,original=context.fetch;let posts=0,gets=0,body:any;
 f.ai.saveConnection({id:'openrouter',apiKey:'s02-batch-identity-fixture'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});
 for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 const fetcher:typeof fetch=async(url,init)=>{
  if(init?.method==='POST'){posts++;assert.equal(String(url),'https://openrouter.ai/api/v1/batches');body=JSON.parse(String(init.body));if(unknown)throw Error('synthetic lost create identity');return Response.json({id:'batch_identity',model:body.model,endpoint:'/v1/chat/completions',status:'in_progress'});}
  gets++;assert.match(String(url),/\/batches\/batch_identity$/);const results=[];
  for(const request of body.requests){const response=await original('synthetic',{method:'POST',body:JSON.stringify({...request.body,model:body.model})});results.push({custom_id:request.custom_id,response:{status_code:200,body:await response.json()}});}
  return Response.json({id:'batch_identity',model:body.model,endpoint:'/v1/chat/completions',status:'completed',results});
 };
 context.fetch=fetcher;
 const scope={taskId:randomUUID(),rowKey:f.draft.productId+':'+f.draft.variantId,phase:'fields',mode:'deferred_batch' as 'deferred_batch'|'immediate',waitingOperationId:undefined as string|undefined,authorize:()=>true};
 const stage=async()=>{await assert.rejects(f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference)),(error:any)=>{scope.waitingOperationId=error.operationId;return error.name==='BatchWaitingError';});await f.ai.batchTasks.flush(scope.taskId).catch(error=>{if(!unknown)throw error;});};
 const history=()=>JSON.stringify(['ai_calls','ai_usage_ledger','ai_batch_items','ai_provider_receipts'].map(table=>(f.ai as any).db.prepare(`SELECT record_json FROM ${table} ORDER BY id`).all()));
 return {...f,scope,stage,history,fetcher,counts:()=>({posts,gets})};
}

for(const changed of ['task','row','phase','waiting','model','key','input','reservation','legacy-call','call-owner'] as const)test(`original Batch recovery rejects changed ${changed} without a replacement send`,async t=>{
 const f=await batchFixture(t);await f.stage();await f.ai.batchTasks.reconcile(f.scope.taskId);const original=f.ai.listCalls()[0],db=(f.ai as any).db;
 let scope={...f.scope},action=()=>f.listing.suggest(f.reference);
 if(changed==='task')scope.taskId=randomUUID();
 if(changed==='row')scope.rowKey=f.product.id+':'+randomUUID();
 if(changed==='phase')scope.phase='copy';
 if(changed==='waiting')scope.waitingOperationId=randomUUID();
 if(changed==='model'){const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_generation')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6.1-sol',effort:'medium'}});}
 if(changed==='key')f.ai.saveConnection({id:'openrouter',apiKey:'s02-other-batch-identity-key'});
 if(changed==='input'){const context=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation);context.evidence[0].value+=' changed';action=()=>f.ai.listingFields(context,async()=>{});}
 if(changed==='reservation')db.prepare("DELETE FROM audit_events WHERE action='run.evidence' AND json_extract(detail_json,'$.event')='REQUEST_RESERVED' AND json_extract(detail_json,'$.callId')=?").run(original.id);
 if(changed==='legacy-call'){const {requestScope:_scope,requestFingerprint:_fp,...legacy}=original;db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(legacy),original.id);}
 if(changed==='call-owner')db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...original,generation:original.generation+1}),original.id);
 const before=f.history();await assert.rejects(f.ai.batchTasks.run(scope,action));await f.ai.batchTasks.flush(scope.taskId);
 assert.deepEqual(f.counts(),{posts:1,gets:1});assert.equal(f.history(),before);assert.equal(f.ai.listResults(f.product.id).length,0);assert.equal(f.ai.getUsageSummary('openrouter').attempts,1);
});

for(const foreign of ['task','row','grant','credential'] as const)test(`concurrent foreign ${foreign} cannot join original Batch result adoption`,async t=>{
 const f=await batchFixture(t);await f.stage();await f.ai.batchTasks.reconcile(f.scope.taskId);
 const own=f.ai.batchTasks.run(f.scope,()=>f.listing.suggest(f.reference));
 const scope={...f.scope,...(foreign==='task'?{taskId:randomUUID()}:foreign==='row'?{rowKey:f.product.id+':'+randomUUID()}:foreign==='credential'?{credentialScope:'f'.repeat(64)}:{authorize:()=>false})};
 const rejected=assert.rejects(f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference)),(error:any)=>foreign==='grant'?error.name==='BatchWaitingError':error.code===(foreign==='credential'?'CONFIG_CHANGED':'INTERRUPTED'));
 const result=await own;await rejected;assert.equal(result.callId,f.scope.waitingOperationId);assert.deepEqual(f.counts(),{posts:1,gets:1});assert.equal(f.ai.listResults(f.product.id).length,1);
});

for(const changed of ['mode','explicit-grant'] as const)test(`concurrent valid ${changed} contexts recover one original Batch result and one fee`,async t=>{
 const f=await batchFixture(t);await f.stage();await f.ai.batchTasks.reconcile(f.scope.taskId);
 const changedScope={...f.scope,...(changed==='mode'?{mode:'immediate' as const}:{explicitContinueAt:'2099-01-01T00:00:00.000Z'})};
 const results=await Promise.all([f.ai.batchTasks.run(f.scope,()=>f.listing.suggest(f.reference)),f.ai.batchTasks.run(changedScope,()=>f.listing.suggest(f.reference))]);
 assert.equal(results[0].id,results[1].id);assert.equal(results[0].callId,f.scope.waitingOperationId);assert.equal(f.ai.listResults(f.product.id).length,1);assert.equal(f.ai.getUsageSummary('openrouter').attempts,1);assert.deepEqual(f.counts(),{posts:1,gets:1});assertBatchHistory((f.ai as any).db);
});

test('a deferred scope cannot borrow an in-flight immediate result',async t=>{
 const f=await fixture(t),context=(f.ai as any).context,original=context.fetch;let release!:()=>void,started!:()=>void;const sent=new Promise<void>(r=>{started=r;}),held=new Promise<void>(r=>{release=r;});let posts=0;
 context.fetch=async(...args:any[])=>{posts++;started();await held;return original(...args);};
 const scope={taskId:randomUUID(),rowKey:f.product.id+':'+f.draft.variantId,phase:'fields',mode:'immediate' as 'immediate'|'deferred_batch',authorize:()=>true};
 const own=f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference));await sent;const originalCall=f.ai.listCalls()[0];
 const other=assert.rejects(f.ai.batchTasks.run({...scope,mode:'deferred_batch'},()=>f.listing.suggest(f.reference)),(error:any)=>error.code==='INTERRUPTED'&&error.callId===originalCall.id);
 release();const result=await own;await other;assert.equal(result.callId,originalCall.id);assert.equal(posts,1);assert.equal(f.ai.listCalls().length,1);assert.equal(f.ai.batchTasks.batches(scope.taskId).length,0);
});

for(const completed of [false,true])test(`revoked immediate scope cannot send ${completed?'after an earlier success':'a new paid request'}`,async t=>{
 const f=await fixture(t);let authorized=true;
 const scope={taskId:randomUUID(),rowKey:f.product.id+':'+f.draft.variantId,phase:'fields',mode:'immediate' as const,authorize:()=>authorized};
 if(completed)await f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference));
 const calls=JSON.stringify(f.ai.listCalls()),results=JSON.stringify(f.ai.listResults(f.product.id)),usage=JSON.stringify(f.ai.getUsageSummary('deepseek'));authorized=false;
 await assert.rejects(f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference)),(error:any)=>error.code==='CANCELLED'&&error.certainty==='NOT_SENT');
 assert.equal(f.requests.length,completed?1:0);assert.equal(JSON.stringify(f.ai.listCalls()),calls);assert.equal(JSON.stringify(f.ai.listResults(f.product.id)),results);assert.equal(JSON.stringify(f.ai.getUsageSummary('deepseek')),usage);
});

test('revocation during preparation is rechecked before the ordinary reservation',async t=>{
 const f=await fixture(t);let authorized=true;const context=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation);
 const scope={taskId:randomUUID(),rowKey:f.product.id+':'+f.draft.variantId,phase:'fields',mode:'immediate' as const,authorize:()=>authorized};
 await assert.rejects(f.ai.batchTasks.run(scope,()=>f.ai.listingFields(context,async()=>{authorized=false;})),(error:any)=>error.code==='CANCELLED'&&error.certainty==='NOT_SENT');
 assert.equal(f.requests.length,0);assert.equal(f.ai.listCalls().length,0);assert.equal(f.ai.getUsageSummary('deepseek').attempts,0);
});

test('revoked after send retains the original receipt and fee without adopting a result',async t=>{
 const f=await fixture(t),context=(f.ai as any).context,original=context.fetch;let authorized=true,release!:()=>void,started!:()=>void;const sent=new Promise<void>(r=>{started=r;}),held=new Promise<void>(r=>{release=r;});let posts=0;
 context.fetch=async(...args:any[])=>{posts++;started();await held;return original(...args);};
 const scope={taskId:randomUUID(),rowKey:f.product.id+':'+f.draft.variantId,phase:'fields',mode:'immediate' as const,authorize:()=>authorized};
 const pending=f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference)),rejected=assert.rejects(pending,{code:'CANCELLED'});await sent;authorized=false;release();await rejected;
 const call=f.ai.listCalls()[0],raw=JSON.stringify(call),receipt=JSON.stringify(await f.ai.readProviderReceipt(call.id)),usage=JSON.stringify(f.ai.getUsageSummary('deepseek'));assert.notEqual(receipt,'null');assert.equal(f.ai.listResults(f.product.id).length,0);
 await assert.rejects(f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference)),{code:'CANCELLED'});authorized=true;
 const recovered=await f.ai.batchTasks.run(scope,()=>f.listing.suggest(f.reference));assert.equal(recovered.callId,call.id);assert.ok(recovered.providerReceiptRecovery);assert.equal(posts,1);assert.equal(JSON.stringify(f.ai.getCall(call.id)),raw);assert.equal(JSON.stringify(await f.ai.readProviderReceipt(call.id)),receipt);assert.equal(JSON.stringify(f.ai.getUsageSummary('deepseek')),usage);
});

test('revoked adoption retains original Batch and later explicit immediate recovery adopts once',async t=>{
 const f=await batchFixture(t);await f.stage();await f.ai.batchTasks.reconcile(f.scope.taskId);const before=f.history();
 await assert.rejects(f.ai.batchTasks.run({...f.scope,authorize:()=>false},()=>f.listing.suggest(f.reference)),{name:'BatchWaitingError'});assert.equal(f.history(),before);
 f.scope.mode='immediate';const result=await f.ai.batchTasks.run(f.scope,()=>f.listing.suggest(f.reference));
 assert.equal(result.callId,f.scope.waitingOperationId);assert.equal((await f.ai.batchTasks.run(f.scope,()=>f.listing.suggest(f.reference))).id,result.id);assert.deepEqual(f.counts(),{posts:1,gets:1});assert.equal(f.ai.getUsageSummary('openrouter').attempts,1);assertBatchHistory((f.ai as any).db);
});

for(const unknown of [false,true])test(`older backup retains original Batch ${unknown?'UNKNOWN lock':'known remote identity'} with zero new POST`,async t=>{
 const f=await batchFixture(t,unknown),file=join(f.directory,'before-batch.htcbackup'),password='s02 batch synthetic backup';await createWorkspaceBackup(f.directory,file,password);await f.stage();
 const originalCall=f.ai.listCalls()[0],originalItem=f.ai.batchTasks.find(originalCall.id)!;
 const prepared=await prepareWorkspaceRestore(f.directory,file,password);
 const snapshot=openDatabase(prepared.stagingDirectory);let restoredCall:any,restoredLedger:string;
 try{
  restoredCall=JSON.parse(String(snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(originalCall.id)!.record_json));
  assert.deepEqual(restoredCall,originalCall);
  restoredLedger=String(snapshot.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(originalCall.id)!.record_json);
 }finally{snapshot.close();}
 // Own the fixture cleanup explicitly so the restored SQLite handles are never
 // shared with the old workspace connections.
 for(const service of [f.amazon,f.store]){const close=service.close.bind(service);let closed=false;service.close=()=>{if(!closed){closed=true;close();}};}
 await f.ai.close();await f.hosting.close();f.amazon.close();f.store.close();await commitWorkspaceRestore(f.directory,prepared);
 const store=new WorkspaceStore(f.directory),hosting=new HostingService(f.directory,store,mockStorage),amazon=new AmazonService(f.directory,id=>store.getProduct(id),mockStorage),ai=new AiService(f.directory,store,hosting,mockStorage,{fetch:f.fetcher}),listing=new ListingAiService(store,amazon,ai);
 try{
  // Existing AiService startup disconnects RUNNING calls, independently of this
  // repair. All original immutable fields survive that explicit normalization.
  const reopened=ai.getCall(originalCall.id)!;
  const {status:_status,errorCode:_error,finishedAt:_finished,...immutable}=restoredCall;
  const {status,errorCode,finishedAt,...retained}=reopened;assert.deepEqual(retained,immutable);assert.equal(status,'FAILED');assert.equal(errorCode,'INTERRUPTED');assert.ok(finishedAt);
  const rawCall=JSON.stringify(reopened),originalUsage=JSON.stringify(ai.getUsageSummary('openrouter'));
  assert.equal(JSON.stringify(ai.getCall(originalCall.id)),rawCall);assert.equal(ai.batchTasks.find(originalCall.id)!.id,originalItem.id);assert.equal(String((ai as any).db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(originalCall.id).record_json),restoredLedger!);
  assert.equal(ai.batchTasks.service.get(originalItem.batchId).locallyStopped,true);f.scope.mode='immediate';
  // Restore intentionally revokes credentials. Do not patch generations or
  // resurrect secrets merely to make original-result adoption look successful.
  await assert.rejects(ai.batchTasks.run(f.scope,()=>listing.suggest(f.reference)),{code:'NOT_CONFIGURED'});
  assert.equal(ai.batchTasks.service.get(originalItem.batchId).remoteBatchId,unknown?null:'batch_identity');
  if(!unknown){const receipt:any=await readProviderReceipt((ai as any).db,f.directory,originalItem.batchId);assert.equal(receipt.body.id,'batch_identity');}
  ai.batchTasks.resume(f.scope.taskId);
  await assert.rejects(ai.batchTasks.reconcile(f.scope.taskId),unknown?/未知/:/身份|连接/);
  ai.saveConnection({id:'openrouter',apiKey:'s02-restored-new-key'});ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});
  for(let i=0;i<2;i++)await assert.rejects(ai.batchTasks.run(f.scope,()=>listing.suggest(f.reference)),(error:any)=>error.code==='INTERRUPTED'&&error.callId===originalCall.id);
  assert.equal(JSON.stringify(ai.getCall(originalCall.id)),rawCall);assert.equal(JSON.stringify(ai.getUsageSummary('openrouter')),originalUsage);assert.equal(ai.listResults(f.product.id).length,0);
  assert.deepEqual(f.counts(),{posts:1,gets:0});assertBatchHistory((ai as any).db);
 }finally{await ai.close();await hosting.close();amazon.close();store.close();}
});
