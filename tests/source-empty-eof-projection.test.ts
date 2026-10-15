import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync,writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AutomaticListingService } from '../src/main/automatic-listing/service.ts';
import { validateAutomaticListingTask,sourceStamp } from '../src/main/automatic-listing/records.ts';
import { fingerprint } from '../src/main/execution/records.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { DEFAULT_ITEM_LABEL_FORMAT } from '../src/shared/item-label-contracts.ts';
import { consistencyFixture } from './helpers/source-consistency.ts';
import { AiService } from '../src/main/ai/service.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { inheritLegacyPurposeSettings } from '../src/main/ai/purpose-routing.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { chat,mockStorage } from './fixtures/listing-ai.ts';
import { consistencyAttemptUnknown,latestConsistencyAttempt } from '../src/main/source-image-consistency/history.ts';
import { readConsistencyView } from '../src/main/source-image-consistency/proof.ts';
async function fixture(t:test.TestContext){
  const f=consistencyFixture(t),hosting=new HostingService(f.directory,f.store,mockStorage);let count=0;
  let respond=(p:any):Response|Promise<Response>=>chat({kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:p.claims.map((c:any)=>({claimId:c.id,value:c.axis==='color'?'Blue':'Round',visibility:'visible'}))}))});
  const dependencies={fetch:async(_url:any,options?:RequestInit)=>{count++;const content=JSON.parse(String(options?.body)).messages[1].content;return respond(JSON.parse(content[0].text));}};
  const ai=new AiService(f.directory,f.store,hosting,mockStorage,dependencies);ai.saveConnection({id:'deepseek',apiKey:'consistency-synthetic-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});inheritLegacyPurposeSettings((ai as any).db,'deepseek','deepseek-flash',false);
  f.cleanup.push(async()=>{await ai.close();await hosting.close();});
  return{...f,hosting,ai,dependencies,count:()=>count,respond:(fn:typeof respond)=>{respond=fn;},observe:()=>ai.observeSourceConsistency(f.context(),()=>{})};
}
test('actual source HTTP empty EOF is invalid output while original dispatch guard remains locked',async t=>{
 const f=await fixture(t);let posts=0;const server=createServer((request,response)=>{request.resume();request.on('end',()=>{assert.equal(request.method,'POST');posts++;response.writeHead(200,{'content-type':'application/json'});response.end();});});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done())));
 const port=(server.address() as {port:number}).port;f.respond(()=>fetch('http://127.0.0.1:'+port+'/',{method:'POST',body:'synthetic source response boundary probe'}));
 const error=await f.observe().catch(error=>error),call=f.ai.listCalls()[0],before=JSON.stringify(call),view=readConsistencyView(f.db,f.context()),receipt=await f.ai.readProviderReceipt(call.id);
 writeFileSync(join(process.cwd(),'artifacts/stabilization/s09-semantics/source-empty-eof-actual.json'),JSON.stringify({call,receipt,view,usage:f.db.prepare('SELECT record_json FROM ai_usage_ledger').all(),posts},null,2)); t.diagnostic(JSON.stringify({errorName:error.name,errorCode:error.code,certainty:error.certainty,posts,callId:call.id,receiptPresent:!!receipt,viewStatus:view.status,viewReasons:view.reasons}));
 assert.ok(error instanceof AiError);assert.equal(error.certainty,'RECEIVED_INVALID');assert.equal(posts,1);await assert.rejects(f.observe());assert.equal(posts,1);assert.equal(JSON.stringify(f.ai.listCalls()[0]),before);assert.equal(consistencyAttemptUnknown(f.db,latestConsistencyAttempt(f.db,f.context())!),true,'display correction must not unlock dispatch');assert.equal(view.status,'SYSTEM_REPAIR');assert.deepEqual(view.reasons,['SOURCE_CONSISTENCY_INVALID_OUTPUT']);
 const snapshot=JSON.stringify(f.db.prepare('SELECT record_json FROM ai_usage_ledger').all());
 for(let i=0;i<100;i++)assert.equal(readConsistencyView(f.db,f.context()).status,'SYSTEM_REPAIR');
 assert.equal(JSON.stringify(f.db.prepare('SELECT record_json FROM ai_usage_ledger').all()),snapshot);assert.equal(posts,1);assert.equal(JSON.stringify(f.ai.listCalls()[0]),before);
 assert.ok(call.providerReceiptId);const index=f.db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(call.providerReceiptId)!;
 const path=join(f.directory,JSON.parse(String(index.record_json)).relativePath),bytes=readFileSync(path);writeFileSync(path,Buffer.concat([bytes,Buffer.from(' ')]));
 assert.equal(readConsistencyView(f.db,f.context()).status,'UNKNOWN','tampered raw cannot establish a known invalid response');writeFileSync(path,bytes);
 await f.ai.close();const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies);f.cleanup.push(()=>restarted.close());
 assert.equal(restarted.getSourceConsistency({productId:f.p.id,productRevision:f.p.revision,variantId:f.p.variants[0].id}).status,'SYSTEM_REPAIR');await assert.rejects(restarted.observeSourceConsistency(f.context(),()=>{}));assert.equal(posts,1);assert.equal(JSON.stringify(restarted.listCalls()[0]),before);
 const rules=defaultListingRules(),at='2026-10-15T00:00:00.000Z',hash='a'.repeat(64),p=f.store.getProductSnapshot(f.p.id),variant=p.variants[0];
 const item={key:p.id+':'+variant.id,productId:p.id,productRevision:p.revision,sourceStamp:sourceStamp(p),productTitle:p.title,variantId:variant.id,sku:variant.sku,stockSets:5,sourcesPrepared:false,status:'FAILED',stage:'SOURCES',draftId:null,executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,batchId:null,error:'Historical unknown source',outcome:{version:1,kind:'UNKNOWN',code:'SOURCE_CONSISTENCY_SENT_UNKNOWN',message:'Historical unknown source',classifiedAt:at,scope:{mode:'demo',sellerId:'synthetic',marketplaceId:'US',productId:p.id,recipeKey:variant.id,recipeStamp:fingerprint({variantId:variant.id}),sourceStamp:sourceStamp(p),rulesStamp:fingerprint(rules),ruleRevision:rules.revision},draftId:null,draftRevision:null}};
 const task=validateAutomaticListingTask({id:randomUUID(),revision:1,status:'PAUSED',targetId:'synthetic',targetName:'Synthetic',sellerId:'synthetic',marketplaceId:'US',mode:'demo',targetStamp:hash,profileId:'alpha',profileStamp:hash,rulesStamp:fingerprint(rules),ruleRevision:rules.revision,productType:'BOX',locale:'en_US',labelFormat:DEFAULT_ITEM_LABEL_FORMAT,items:[item],createdAt:at,updatedAt:at,error:null});
 f.db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));
 const automatic=new AutomaticListingService(f.directory,{store:f.store,rules:()=>rules,amazon:{executionTargetScope:()=>({target:{mode:'demo',sellerId:'synthetic',marketplaceId:'US'},generation:1})},images:{getProgress:()=>null},execution:{list:()=>[]}} as any);f.cleanup.push(()=>automatic.close());
 const owned=(automatic as any).tasks.get(task.id),originalRow=owned.items[0],stored=JSON.stringify(f.db.prepare('SELECT * FROM automatic_listing_tasks').all()),changes=f.db.prepare('SELECT total_changes() n').get()!.n;
 const query={taskId:task.id,revision:1,page:1,pageSize:20,search:''};
 for(let i=0;i<20;i++){
  assert.equal(automatic.queryTaskSummaries({taskIds:[task.id],page:1,pageSize:20}).rows[0].counts.invalidOutput,1);
  const groups=automatic.queryTaskGroups(query);assert.equal(groups.kind,'page');if(groups.kind==='page'){assert.equal(groups.groups[0].counts.invalidOutput,1);assert.equal(groups.groups[0].items[0].outcome,'invalidOutput');}
  const detail=automatic.getTaskItem({taskId:task.id,revision:1,itemKey:item.key});assert.equal(detail.kind,'item');if(detail.kind==='item')assert.equal(detail.item.outcome?.code,'SOURCE_CONSISTENCY_INVALID_OUTPUT');
 }
 const queue=await automatic.queue({productIds:[p.id],targetId:'synthetic'});assert.equal(queue.products[0].rows[0].kind,'SYSTEM_REPAIR');assert.equal(queue.products[0].rows[0].reasonCode,'SOURCE_CONSISTENCY_INVALID_OUTPUT');assert.equal(queue.products[0].rows[0].eligible,false);
 assert.equal((automatic as any).unknownCode(originalRow,owned),'SOURCE_CONSISTENCY_SENT_UNKNOWN');
 for(const patch of [{imageStarted:true},{repair:{phase:'FIELDS_STARTED',sourceWorkflowId:randomUUID(),draftRevision:1,draftStamp:hash}}]){
  Object.assign(originalRow,patch);const detail=automatic.getTaskItem({taskId:task.id,revision:1,itemKey:item.key});assert.equal(detail.kind,'item');if(detail.kind==='item'){assert.equal(detail.item.outcome?.kind,'UNKNOWN');assert.equal(detail.item.outcome?.code,'repair' in patch?'FIELD_RESULT_UNKNOWN':'IMAGE_RESULT_UNKNOWN');}originalRow.imageStarted=false;originalRow.repair=null;
 }
 const classified=structuredClone(originalRow);await (automatic as any).classifyFailure(owned,classified,new AiError('INTERRUPTED'));assert.equal(classified.outcome.kind,'SYSTEM_REPAIR');assert.equal(classified.outcome.code,'SOURCE_CONSISTENCY_INVALID_OUTPUT');
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM automatic_listing_tasks').all()),stored);assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(originalRow.outcome.kind,'UNKNOWN');assert.equal(posts,1);assert.equal(JSON.stringify(restarted.listCalls()[0]),before);
});


for(const [name,response] of [
 ['credential echo',()=>new Response('consistency-synthetic-key',{status:200})],
 ['processing error',()=>new Response(JSON.stringify({error:{message:'provider processing failed'}}),{status:200})],
 ['no complete response',()=>Promise.reject(new Error('synthetic transport interruption'))],
] as const)test('source projection preserves UNKNOWN for '+name,async t=>{
 const f=await fixture(t);f.respond(response);await assert.rejects(f.observe());const before=JSON.stringify(f.ai.listCalls()),attempt=latestConsistencyAttempt(f.db,f.context())!;
 const call=f.ai.listCalls()[0];t.diagnostic(JSON.stringify({name,errorCode:call.errorCode,responseReceived:call.responseReceived,hasReceipt:!!call.providerReceiptId,guardUnknown:consistencyAttemptUnknown(f.db,attempt),view:readConsistencyView(f.db,f.context()).status}));assert.equal(readConsistencyView(f.db,f.context()).status,'UNKNOWN');const n=f.count();await assert.rejects(f.observe());assert.equal(f.count(),n);assert.equal(JSON.stringify(f.ai.listCalls()),before);
});
