import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {fixture,storage} from './fixtures/ai-control.ts';
import {slowHttp} from './fixtures/stabilization/slow-http.ts';
import {classifyProduct} from '../src/main/catalog/classification.ts';
import {AiService} from '../src/main/ai/service.ts';
import {WorkspaceStore} from '../src/main/store.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {readCategoryOperation} from '../src/main/ai/category-operations.ts';
import {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore} from '../src/main/backup.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {ClassificationDependencies} from '../src/main/catalog/classification.ts';
import {createServer,get} from 'node:http';
const local=[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}],novel={name:'PLATFORM_SPECIALTY',displayName:'Actual platform label'};
const envelope=(content:unknown)=>JSON.stringify({id:'s04-keyword',choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:.001}});
for(const recovery of ['restart','older-backup','permitted-null'] as const)test(`actual durable classifier ${recovery} preserves original GET, calls, raw and cumulative usage`,async t=>{
 const keyword=await slowHttp({body:envelope({kind:'category-decision',phase:'keywords',keywords:['cloth'],productType:null,reason:'Actual source keyword result',ambiguous:false})});t.after(()=>keyword.close());
 const none=await slowHttp({body:JSON.stringify({id:'s04-original-none',answers:{category:{type:'choice',choice:'$NO_SUITABLE'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3,cost:.002}})});t.after(()=>none.close());
 const selected=await slowHttp({body:JSON.stringify({id:'s04-expanded',answers:{category:{type:'choice',choice:novel.name},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3,cost:.003}})});t.after(()=>selected.close());
 const searchBody=JSON.stringify({productTypes:[novel]});let gets=0;
 const server=createServer((request,response)=>{assert.equal(request.method,'GET');gets++;response.writeHead(200,{'content-type':'application/json','connection':'close'});if(recovery==='permitted-null'){response.write('{"productTypes":[');setImmediate(()=>response.destroy());}else response.end(searchBody);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));const address=server.address();assert.ok(address&&typeof address==='object');
 const f=await fixture(t,{fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body));const state=body.state,payload=Array.isArray(state)?state[0]:state;return fetch(!body.questions?keyword.url:payload.candidates.some((candidate:{name:string})=>candidate.name===novel.name)?selected.url:none.url,init);}});
 f.service.saveConnection({id:'openrouter',apiKey:'s04-expansion-local-only'});f.service.setEnabled({id:'openrouter',enabled:true});f.service.setEnabled({id:'openrouter-review',enabled:true});
 const beforeFile=join(f.directory,'before-expansion.htcbackup'),password='s04 synthetic expansion backup';if(recovery==='older-backup')await createWorkspaceBackup(f.directory,beforeFile,password);
 const scope={taskId:randomUUID(),rowKey:f.product.id+':'+f.product.variants[0].id,phase:'CATEGORY',mode:'immediate' as const,authorize:()=>true};
 const input={productId:f.product.id,productRevision:f.product.revision,targetId:'s04-synthetic-target'};
 let service=f.service,dispatches=0;
 const deps=():ClassificationDependencies=>({keywords:value=>service.decideCategory({...value,phase:'keywords',candidates:[]}),localCandidates:()=>local,search:()=>local,fallback:async()=>{throw Error('unexpected first recall');},choose:(value,phase)=>service.decideCategory({...value,phase}),expansion:{reserve:value=>service.reserveCategoryCandidateExpansion(value),permit:value=>service.permitCategoryCandidateExpansion(value),retain:(productId,snapshot)=>service.retainCategoryCandidateExpansion(productId,snapshot),search:async(claim,beforeDispatch)=>{beforeDispatch();dispatches++;const bytes=await new Promise<Buffer>((resolve,reject)=>{get(`http://127.0.0.1:${address.port}/catalog?targetId=${encodeURIComponent(claim.targetId)}&query=${encodeURIComponent(claim.query)}`,response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(Buffer.concat(chunks)));response.on('error',reject);response.on('aborted',()=>reject(Error('Original GET body incomplete')));}).on('error',reject);}),body=JSON.parse(bytes.toString());return {requestId:claim.requestId,candidates:body.productTypes,receiptSha256:createHash('sha256').update(bytes).digest('hex'),receivedAt:new Date().toISOString()};}}});
 const run=()=>taskAiContext.run(scope,()=>classifyProduct(input,deps()));
 if(recovery==='permitted-null')await assert.rejects(run());else assert.equal((await run()).productType,novel.name);
 const db=(service as unknown as {db:DatabaseSync}).db,operation=readCategoryOperation(db,f.product.id),calls=service.listCalls(),usage=db.prepare('SELECT * FROM ai_usage_ledger ORDER BY id').all(),raw=await Promise.all(calls.map(call=>service.readProviderReceipt(call.id)));
 assert.equal(dispatches,1);assert.equal(gets,1);assert.equal(keyword.posts,1);assert.equal(none.posts,1);assert.equal(selected.posts,recovery==='permitted-null'?0:1);
 if(recovery!=='permitted-null'){assert.equal(operation.expansion!.snapshot!.receiptSha256,createHash('sha256').update(searchBody).digest('hex'));assert.ok(operation.expansion!.snapshot!.evidence.some(e=>e.name===novel.name&&e.sources.includes('platform')));}
 await service.close();let store=f.store;
 if(recovery==='older-backup'){await f.hosting.close();f.closeStore();await commitWorkspaceRestore(f.directory,await prepareWorkspaceRestore(f.directory,beforeFile,password));store=new WorkspaceStore(f.directory);}
 let unexpectedPosts=0;service=new AiService(f.directory,store,f.hosting,storage,{fetch:async()=>{unexpectedPosts++;throw Error('Recovered original evidence must not POST');}});
 try{
  if(recovery==='permitted-null')await assert.rejects(run(),error=>!!error&&typeof error==='object'&&(error as {requestId?:string}).requestId===operation.expansion!.requestId&&(error as {certainty?:string}).certainty==='SENT_UNKNOWN');else assert.equal((await run()).productType,novel.name);
  const reopened=(service as unknown as {db:DatabaseSync}).db;assert.deepEqual(service.listCalls(),calls);assert.deepEqual(reopened.prepare('SELECT * FROM ai_usage_ledger ORDER BY id').all(),usage);assert.deepEqual(readCategoryOperation(reopened,f.product.id),operation);assert.deepEqual(await Promise.all(calls.map(call=>service.readProviderReceipt(call.id))),raw);assert.equal(unexpectedPosts,0);assert.equal(dispatches,1);
 }finally{await service.close();if(store!==f.store)store.close();}
});
