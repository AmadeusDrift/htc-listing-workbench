import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {fixture} from './fixtures/ai-control.ts';
import {AutomaticListingService,type AutomaticListingDependencies} from '../src/main/automatic-listing/service.ts';
import {classifyProduct} from '../src/main/catalog/classification.ts';
import {AiError} from '../src/main/ai/errors.ts';
import {defaultListingRules} from '../src/shared/listing-rules.ts';
import {automaticItemReason} from '../src/shared/automatic-status-projection.ts';
import {materializeSourceSnapshot,confirmSourceConsistencyFixture} from './helpers/source-consistency-proof.ts';
import {slowHttp} from './fixtures/stabilization/slow-http.ts';
import type {AmazonTarget} from '../src/shared/amazon-contracts.ts';

for(const scenario of ['unknown','outer-timeout','invalid'] as const)test(`actual category ${scenario} has one stable disposition across reads and continue`,async t=>{
 const http=await slowHttp({body:JSON.stringify({id:'s09-invalid',answers:{category:{type:'choice',choice:null}},usage:{cost:.002}})});t.after(()=>http.close());
 const f=await fixture(t,{fetch:async(_url,init)=>{if(scenario!=='invalid')throw Error('Synthetic transport lost after reservation');return fetch(http.url,init);}});
 let p=f.store.getProductSnapshot(f.product.id);p=f.store.saveProduct({id:p.id,revision:p.revision,title:p.title,sourceUrl:'',description:'',status:p.status,variants:p.variants.map(({id,sku,inventory})=>({id,sku,inventory,purchasePrice:'1',originalSpec:'Cotton',normalizedSpec:'Cotton'})),facts:p.facts});
 f.service.saveConnection({id:'openrouter',apiKey:'s09-synthetic'});f.service.setEnabled({id:'openrouter',enabled:true});
 const rules=defaultListingRules(),target={id:'s09-store',name:'Synthetic',mode:'demo',sellerId:'synthetic-seller',marketplaceId:'ATVPDKIKX0DER',marketplaceName:'US',region:'na',locale:'en_US',paused:false,configured:true,credentialUpdatedAt:new Date().toISOString(),lastError:null} as AmazonTarget;
 const later={schema:0,drafts:0,images:0,submit:0},fail=()=>{throw Error('must not reach later stage');};
 const deps={store:f.store,rules:()=>rules,hosting:f.hosting,
  amazon:{executionTargetScope:()=>({target,generation:1}),getDraft:fail,listDrafts:()=>[],getSchema:async()=>{later.schema++;return fail();},prepareDrafts:async()=>{later.drafts++;return fail();}},
  images:{prepareSources:async()=>({product:f.store.getProductSnapshot(p.id),missing:[]}),complete:async()=>{later.images++;return fail();},getProgress:()=>null,cancel:()=>({cancelled:false}),cancelSources:()=>({cancelled:false})},
  execution:{create:fail,prepareStart:fail,startAuthorized:()=>{later.submit++;return fail();},get:fail,list:()=>[],pause:fail,cancel:fail,waitForIdle:async()=>{}},followup:{get:fail,schedule:fail},procurement:{candidates:()=>[],ensureAutomaticBatch:fail},labels:{syncBatch:fail,list:()=>[]},
  prepareSourceConsistency:async input=>{const source=f.store.getProductSnapshot(input.productId);materializeSourceSnapshot(f.directory,source,input.variantIds);await confirmSourceConsistencyFixture(f.directory,f.store,source.id,input.variantIds);},
  classify:async(input,signal)=>classifyProduct(input,{keywords:async()=>({id:'synthetic-keywords',output:{kind:'category-decision',phase:'keywords',keywords:['cloth'],productType:null,reason:'Cotton',ambiguous:false}}),localCandidates:()=>[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}],search:()=>[],fallback:async()=>[],choose:async(value,phase)=>{try{return await f.service.decideCategory({...value,phase},()=>{},signal);}catch(error){if(scenario==='outer-timeout')throw new AiError('TIMEOUT');throw error;}}}),
 } satisfies AutomaticListingDependencies;
 const automatic=new AutomaticListingService(f.directory,deps);try{
  const task=await automatic.create({productIds:[p.id],targetId:target.id,profileId:'alpha'});automatic.startAuthorized(automatic.prepareStart(task.id));await automatic.waitForIdle();
  const row=automatic.get(task.id).items[0],expected=scenario==='invalid'?['SYSTEM_REPAIR','AI_RECEIVED_INVALID_OUTPUT']:['UNKNOWN','CATEGORY_RESULT_UNKNOWN'];
  assert.equal(row.stage,'CLASSIFY');assert.equal(row.outcome?.kind,expected[0]);assert.equal(row.outcome?.code,expected[1]);assert.equal(row.draftId,null);assert.deepEqual(later,{schema:0,drafts:0,images:0,submit:0});
  assert.equal(f.requests.length,1);assert.equal(http.posts,scenario==='invalid'?1:0);
  const db=(automatic as unknown as {db:DatabaseSync}).db,changes=db.prepare('SELECT total_changes() n').get()!.n;
  const original={call:JSON.stringify(f.service.listCalls()),usage:JSON.stringify(db.prepare('SELECT * FROM ai_usage_ledger').all()),task:JSON.stringify(db.prepare('SELECT * FROM automatic_listing_tasks').all())};
  for(let i=0;i<100;i++){
   const summary=automatic.queryTaskSummaries({taskIds:[task.id],page:1,pageSize:20}).rows[0];assert.equal(summary.counts[scenario==='invalid'?'invalidOutput':'unknown'],1);
   const detail=automatic.getTaskItem({taskId:task.id,revision:automatic.get(task.id).revision,itemKey:row.key});assert.equal(detail.kind,'item');if(detail.kind==='item')assert.equal(detail.item.outcome?.code,expected[1]);
   const groups=automatic.queryTaskGroups({taskId:task.id,revision:automatic.get(task.id).revision,page:1,pageSize:20,search:''});assert.equal(groups.kind,'page');
  }
  assert.equal(db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(JSON.stringify(db.prepare('SELECT * FROM automatic_listing_tasks').all()),original.task);
  if(scenario!=='invalid'){assert.match(automaticItemReason(row),/类目.*未知/);automatic.startAuthorized(automatic.prepareStart(task.id));await automatic.waitForIdle();assert.equal(automatic.get(task.id).items[0].outcome?.code,'CATEGORY_RESULT_UNKNOWN');}
  assert.equal(f.requests.length,1);assert.equal(JSON.stringify(f.service.listCalls()),original.call);assert.equal(JSON.stringify(db.prepare('SELECT * FROM ai_usage_ledger').all()),original.usage);
 }finally{await automatic.close();}
});
