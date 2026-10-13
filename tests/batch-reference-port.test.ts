import {AiService} from '../src/main/ai/service.ts';
import {HostingService} from '../src/main/hosting/service.ts';
import {mockStorage} from './fixtures/listing-ai.ts';
import {confirmSourceConsistencyFixture} from './helpers/source-consistency-proof.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {WorkspaceStore} from '../src/main/store.ts';
import {createBatchReferencePort} from '../src/main/hosting/batch-references.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {addSourceOriginalFixture} from './helpers/source-consistency-proof.ts';
import {openDatabase} from '../src/main/database.ts';
import {BatchService} from '../src/main/ai/batch/service.ts';
import {resolvePurpose} from '../src/main/ai/purpose-routing.ts';
async function fixture(t:test.TestContext){
 mkdirSync(resolve('.test-data'),{recursive:true});const directory=mkdtempSync(resolve('.test-data/batch-reference-')),store=new WorkspaceStore(directory);let product=store.createProduct();product=addSourceOriginalFixture(directory,store,product.id,product.variants.map(v=>v.id));
 const taskId=randomUUID(),profile={id:'alpha',name:'Alpha',host:'fixture.invalid',port:21,secure:true,remoteRoot:'/',publicBaseUrl:'https://images.example.test/',enabled:true,configured:true,generation:1};let allowed=true,uploads=0,probes=0;
 const task={id:taskId,profileId:'alpha',profileStamp:createHash('sha256').update(JSON.stringify(profile)).digest('hex')};
 const port=createBatchReferencePort({directory,store,generation:{readCandidate:async()=>{throw new Error('No candidate fixture');}},hosting:{getProfile:()=>profile as any,listUploads:()=>[],uploadReferenceVersion:async(_id,_gen,version)=>{uploads++;return `https://images.example.test/references/${version.sha256}.png`; }},task:()=>task as any,probe:async()=>{probes++;}});
 t.after(async()=>{await port.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const owner={taskId,operationId:randomUUID(),productId:product.id,productRevision:product.revision},bytes=readFileSync(join(directory,store.getAssetRecord(product.assets[0].id)!.originalPath)),body={messages:[{role:'user',content:[{type:'text',text:'Observe this source'},{type:'image_url',image_url:{url:`data:image/png;base64,${bytes.toString('base64')}`}}]}],reasoning:{effort:'medium'},max_tokens:4096};
 const scope={taskId,rowKey:product.variants[0].id,phase:'source',mode:'deferred_batch' as const,authorize:()=>allowed};
 return{directory,store,product,port,owner,body,scope,profile,task,counts:()=>({uploads,probes}),revoke:()=>{allowed=false;}};
}
test('main reference port uses the selected hosting profile and reuses one immutable pin',async t=>{
 const f=await fixture(t),first=await taskAiContext.run(f.scope,()=>f.port.prepare(f.body,f.owner)),second=await taskAiContext.run(f.scope,()=>f.port.prepare(f.body,f.owner));
 assert.equal(f.body.messages[0].content[1].image_url!.url.startsWith('data:'),true);assert.doesNotMatch(JSON.stringify(first.body),/data:image/);assert.deepEqual(first.references.map(r=>r.pinId),second.references.map(r=>r.pinId));assert.equal(f.counts().uploads,1);assert.equal(f.port.validate(first.references[0]),true);
});
test('foreign URLs, unowned bytes, source changes and changed task profiles are blocked before upload',async t=>{
 const f=await fixture(t);for(const url of ['https://images.example.test/unproven.png','data:image/png;base64,YWJj']){const body=structuredClone(f.body);body.messages[0].content[1].image_url!.url=url;await assert.rejects(()=>taskAiContext.run(f.scope,()=>f.port.prepare(body,f.owner)));}
 await assert.rejects(()=>taskAiContext.run(f.scope,()=>f.port.prepare(f.body,{...f.owner,productRevision:f.owner.productRevision+1})));
 f.profile.generation++;await assert.rejects(()=>taskAiContext.run(f.scope,()=>f.port.prepare(f.body,f.owner)));assert.equal(f.counts().uploads,0);
});
test('pinned URLs reach the real Batch protocol and never an inline or ordinary chat fallback',async t=>{
 const f=await fixture(t),pinned=await taskAiContext.run(f.scope,()=>f.port.prepare(f.body,f.owner)),db=openDatabase(f.directory);let posts=0;
 try{const service=new BatchService(db,f.directory,{validateReference:f.port.validate,credential:()=>({apiKey:'offline-reference-fixture-key',scope:'a'.repeat(64)}),fetch:async(url,init)=>{assert.equal(String(url),'https://openrouter.ai/api/v1/batches');posts++;const body=JSON.parse(String(init?.body));assert.doesNotMatch(JSON.stringify(body),/data:image/);assert.match(JSON.stringify(body),new RegExp(pinned.references[0].sha256));return Response.json({id:'batch_pinned',model:body.model,endpoint:'/v1/chat/completions',status:'in_progress'});}});
 const batch=service.prepare([{taskId:f.owner.taskId,operationId:f.owner.operationId,attempt:1,phase:'source',inputFingerprint:'b'.repeat(64),schemaFingerprint:'c'.repeat(64),credentialScope:'a'.repeat(64),owner:{productId:f.product.id,productRevision:f.product.revision,providerId:'openrouter',generation:1},purpose:resolvePurpose(db,'listing_title'),...pinned}])[0];await service.submit(batch.id);assert.equal(posts,1);
 }finally{db.close();}
});
test('revoked scope and a closed port do not upload or validate references',async t=>{
 const f=await fixture(t);f.revoke();await assert.rejects(()=>taskAiContext.run(f.scope,()=>f.port.prepare(f.body,f.owner)));assert.equal(f.counts().uploads,0);await f.port.close();await assert.rejects(()=>taskAiContext.run(f.scope,()=>f.port.prepare(f.body,f.owner)));
});



test('actual AiService visual step stages pinned references and adopts the original Batch call once',async t=>{
 const f=await fixture(t);await confirmSourceConsistencyFixture(f.directory,f.store,f.product.id);let body:any,posts=0;
 const hosting=new HostingService(f.directory,f.store,mockStorage),ai=new AiService(f.directory,f.store,hosting,mockStorage,{batchReferences:f.port,fetch:async(url,init)=>{
  assert.ok(String(url).startsWith('https://openrouter.ai/api/v1/batches'));
  if(init?.method==='POST'){posts++;body=JSON.parse(String(init.body));assert.doesNotMatch(JSON.stringify(body),/data:image/);return Response.json({id:'batch_visual_ai',model:body.model,endpoint:'/v1/chat/completions',status:'in_progress'});}
  return Response.json({id:'batch_visual_ai',model:body.model,endpoint:'/v1/chat/completions',status:'completed',results:body.requests.map((r:any)=>({custom_id:r.custom_id,response:{status_code:200,body:{id:'visual_result',choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'source-color',verdict:'DETERMINED',colors:['Silver'],reason:'Synthetic visible product surface.',referenceAssetIds:f.product.assets.map(asset=>asset.id)})}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,cost:.01}}}}))});
 }});
 try{ai.saveConnection({id:'openrouter',apiKey:'offline-main-reference-key'});ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});const p=ai.getPurposeProfiles().find(p=>p.purposeId==='source_understanding')!;ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 const context=(ai as any).sourceColorContext({productId:f.product.id,productRevision:f.product.revision,variantId:f.product.variants[0].id});
 const call=()=>ai.batchTasks.run(f.scope,()=>ai.observeSourceColor(context,()=>{}));await assert.rejects(call,{name:'BatchWaitingError'});assert.equal(posts,0);await ai.batchTasks.flush(f.owner.taskId);await ai.batchTasks.reconcile(f.owner.taskId);const result=await call();assert.equal(result.output.kind,'source-color');assert.equal(ai.listCalls().length,1);assert.equal(ai.getUsageSummary('openrouter').attempts,1);assert.equal(posts,1);
 const again=await call();assert.equal(again.id,result.id);assert.equal(posts,1);assert.equal(f.counts().uploads,1);
 }finally{await ai.close();await hosting.close();}
});
