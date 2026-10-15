import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/ai-control.ts';
import { AutomaticListingService } from '../src/main/automatic-listing/service.ts';
import type { AutomaticListingDependencies } from '../src/main/automatic-listing/service.ts';
import { classifyProduct } from '../src/main/catalog/classification.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { slowHttp } from './fixtures/stabilization/slow-http.ts';
import { materializeSourceSnapshot, confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import type { AmazonTarget } from '../src/shared/amazon-contracts.ts';
import {createServer,get} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import type {ClassificationDependencies} from '../src/main/catalog/classification.ts';

for(const scenario of ['none','manual','expanded'] as const)test(`actual automatic coordinator preserves ${scenario==='none'?'valid none before Schema/draft/images':scenario==='manual'?'the explicitly selected manual product type':'the actual expanded selected type before draft preparation'}`,async t=>{
 const http=await slowHttp({body:JSON.stringify({id:'s04-decisions',answers:{category:{type:'choice',choice:'$NO_SUITABLE',probabilities:{$NO_SUITABLE:.95,CLEANING_CLOTH:.05}},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3,cost:.001}})});t.after(()=>http.close());
 const expanded=await slowHttp({body:JSON.stringify({id:'s04-expanded-decisions',answers:{category:{type:'choice',choice:'PLATFORM_SPECIALTY'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3,cost:.001}})});t.after(()=>expanded.close());
 const f=await fixture(t,{fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body)),payload=Array.isArray(body.state)?body.state[0]:body.state;return fetch(payload?.candidates?.some((c:{name:string})=>c.name==='PLATFORM_SPECIALTY')?expanded.url:http.url,init);}});
 const searchBody=JSON.stringify({productTypes:[{name:'PLATFORM_SPECIALTY',displayName:'Actual platform label'}]});let gets=0;
 const server=createServer((_request,response)=>{gets++;response.end(searchBody);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));const address=server.address();assert.ok(address&&typeof address==='object');
 let product=f.store.getProductSnapshot(f.product.id);
 product=f.store.saveProduct({id:product.id,revision:product.revision,title:product.title,sourceUrl:'',description:'',status:product.status,variants:product.variants.map(({id,sku,inventory})=>({id,sku,inventory,purchasePrice:'1',originalSpec:'Cotton',normalizedSpec:'Cotton'})),facts:product.facts});
 f.service.saveConnection({id:'openrouter',apiKey:'s04-synthetic-pipeline'});f.service.setEnabled({id:'openrouter',enabled:true});
 const rules=defaultListingRules(),target={id:'s04-store',name:'Synthetic',mode:'demo',sellerId:'synthetic-seller',marketplaceId:'ATVPDKIKX0DER',marketplaceName:'US',region:'na',locale:'en_US',paused:false,configured:true,credentialUpdatedAt:new Date().toISOString(),lastError:null} as AmazonTarget;
 const counts={schema:0,drafts:0,images:0,submissions:0,select:0};const unexpected=()=>{throw Error('later stage must not run');};
 const dependencies:AutomaticListingDependencies={
  store:f.store,rules:()=>rules,hosting:f.hosting,
  amazon:{executionTargetScope:()=>({target,generation:1}),getDraft:unexpected,listDrafts:()=>[],prepareDrafts:async raw=>{counts.drafts++;if(scenario!=='none')assert.equal((raw as {productType:string}).productType,scenario==='manual'?'CLEANING_CLOTH':'PLATFORM_SPECIALTY');throw Error('draft stage intentionally stopped after type assertion');},getSchema:async()=>{counts.schema++;throw Error('schema must not run');}},
  images:{prepareSources:async()=>({product:f.store.getProductSnapshot(product.id),missing:[]}),complete:async()=>{counts.images++;throw Error('images must not run');},getProgress:()=>null,cancel:()=>({cancelled:false}),cancelSources:()=>({cancelled:false})},
  execution:{create:unexpected,prepareStart:unexpected,startAuthorized:()=>{counts.submissions++;throw Error('submit must not run');},get:unexpected,list:()=>[],pause:unexpected,cancel:unexpected,waitForIdle:async()=>{}},
  followup:{get:unexpected,schedule:unexpected},procurement:{candidates:()=>[],ensureAutomaticBatch:unexpected},labels:{syncBatch:unexpected,list:()=>[]},
  prepareSourceConsistency:async input=>{const source=f.store.getProductSnapshot(input.productId);materializeSourceSnapshot(f.directory,source,input.variantIds);await confirmSourceConsistencyFixture(f.directory,f.store,source.id,input.variantIds);},
  classify:async(input,signal)=>{const ports:ClassificationDependencies={keywords:async()=>({id:randomUUID(),output:{kind:'category-decision',phase:'keywords',keywords:['cloth'],productType:null,reason:'Synthetic keyword stage only',ambiguous:false}}),localCandidates:()=>[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}],search:()=>[],fallback:async()=>{throw Error('no expansion permission');},choose:async(value,phase)=>{counts.select++;return f.service.decideCategory({...value,phase},()=>{},signal);}};
   if(scenario==='expanded')ports.expansion={reserve:value=>f.service.reserveCategoryCandidateExpansion(value),permit:value=>f.service.permitCategoryCandidateExpansion(value),retain:(productId,snapshot)=>f.service.retainCategoryCandidateExpansion(productId,snapshot),search:async(claim,permit)=>{permit();const bytes=await new Promise<Buffer>((resolve,reject)=>{get(`http://127.0.0.1:${address.port}/`,response=>{const chunks:Buffer[]=[];response.on('data',c=>chunks.push(c));response.on('end',()=>resolve(Buffer.concat(chunks)));response.on('error',reject);}).on('error',reject);});await f.service.captureCategoryCandidateExpansionReceipt(input.productId,{requestId:claim.requestId,targetScope:{targetId:claim.targetId,sellerId:target.sellerId,marketplaceId:target.marketplaceId,region:target.region,locale:target.locale,mode:target.mode},targetGeneration:1,query:claim.query,status:200,remoteRequestId:null,receivedAt:new Date().toISOString(),bytes});return{requestId:claim.requestId,candidates:JSON.parse(bytes.toString()).productTypes,receiptSha256:createHash('sha256').update(bytes).digest('hex'),receivedAt:new Date().toISOString()};}};
   return classifyProduct(input,ports);
  },
 };
 const automatic=new AutomaticListingService(f.directory,dependencies);try{
 const task=await automatic.create({productIds:[product.id],targetId:target.id,profileId:'alpha',...(scenario==='manual'?{productType:'CLEANING_CLOTH'}:{})});
 automatic.startAuthorized(automatic.prepareStart(task.id));await automatic.waitForIdle();
 if(scenario==='manual'){
  assert.equal(counts.select,0);assert.equal(counts.drafts,1);assert.equal(http.posts,0);assert.equal(f.requests.length,0);assert.equal(f.service.listCalls().length,0);assert.equal(automatic.get(task.id).items[0].classification,undefined);return;
 }
 if(scenario==='expanded'){
  const row=automatic.get(task.id).items[0];assert.equal(row.classification?.productType,'PLATFORM_SPECIALTY');assert.equal(row.stage,'DRAFT');assert.equal(row.draftId,null);assert.equal(counts.drafts,1);assert.equal(counts.images,0);assert.equal(counts.submissions,0);assert.equal(gets,1);assert.equal(http.posts,1);assert.equal(expanded.posts,1);assert.equal(f.requests.length,2);return;
 }
 const saved=automatic.get(task.id);assert.equal(saved.status,'NEEDS_ATTENTION');assert.equal(saved.items[0].stage,'CLASSIFY');assert.equal(saved.items[0].draftId,null);assert.match(saved.items[0].error??'',/无适用.*人工/);
 assert.deepEqual(counts,{schema:0,drafts:0,images:0,submissions:0,select:1});assert.equal(http.posts,1);assert.equal(f.requests.length,1);
 const calls=f.service.listCalls();assert.equal(calls.length,1);assert.equal(calls[0].status,'SUCCEEDED');assert.equal(f.service.listResults(product.id)[0].output.kind,'category-decision');
 assert.equal((await f.service.readProviderReceipt(calls[0].id) as {costUsd:number}).costUsd,.001);
 const originalCall=JSON.stringify(calls[0]),originalResults=JSON.stringify(f.service.listResults(product.id));
 automatic.startAuthorized(automatic.prepareStart(task.id));await automatic.waitForIdle();
 assert.equal(http.posts,1);assert.equal(f.requests.length,1);assert.equal(JSON.stringify(f.service.listCalls()[0]),originalCall);assert.equal(JSON.stringify(f.service.listResults(product.id)),originalResults);
 assert.equal(counts.schema,0);assert.equal(counts.drafts,0);assert.equal(counts.images,0);assert.equal(counts.submissions,0);
 }finally{await automatic.close();}
});
