import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import type {DatabaseSync} from 'node:sqlite';
import {fixture,storage} from './fixtures/ai-control.ts';
import {slowHttp} from './fixtures/stabilization/slow-http.ts';
import {AutomaticListingService,type AutomaticListingDependencies} from '../src/main/automatic-listing/service.ts';
import {AmazonService} from '../src/main/amazon/service.ts';
import {classifyProduct} from '../src/main/catalog/classification.ts';
import {categoryExpansionPort} from '../src/main/catalog/category-expansion.ts';
import {readCategoryOperation} from '../src/main/ai/category-operations.ts';
import {validateAutomaticListingTask} from '../src/main/automatic-listing/records.ts';
import {currentWorkBatch,bindWorkBatchTask} from '../src/main/automatic-listing/work-batches.ts';
import {defaultListingRules} from '../src/shared/listing-rules.ts';
import {materializeSourceSnapshot,confirmSourceConsistencyFixture} from './helpers/source-consistency-proof.ts';

for(const mode of ['unknown','invalid','rejected','empty','missing-proof','missing-file','bad-file'] as const)test(`actual automatic original expansion ${mode} stays exact across task, reads and continue`,async t=>{
 const none=await slowHttp({body:JSON.stringify({id:'s09-none',answers:{category:{type:'choice',choice:'$NO_SUITABLE'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3,cost:.002}})});t.after(()=>none.close());
 const f=await fixture(t,{fetch:async(_url,init)=>fetch(none.url,init)});
 let p=f.store.getProductSnapshot(f.product.id);p=f.store.saveProduct({id:p.id,revision:p.revision,title:p.title,sourceUrl:'',description:'',status:p.status,variants:p.variants.map(({id,sku,inventory})=>({id,sku,inventory,purchasePrice:'1',originalSpec:'Cotton',normalizedSpec:'Cotton'})),facts:p.facts});
 f.service.saveConnection({id:'openrouter',apiKey:'s09-original-lookup-synthetic'});f.service.setEnabled({id:'openrouter',enabled:true});
 let gets=0,lwa=0;const server=createServer((request,response)=>{
  if(request.url==='/auth'){lwa++;response.end(JSON.stringify({access_token:'s09-local-token',token_type:'bearer',expires_in:3600}));return;}
  assert.equal(request.method,'GET');gets++;response.writeHead(mode==='rejected'?500:200,{'content-type':'application/json','connection':'close'});
  if(mode==='unknown'){response.write('{"productTypes":[');setImmediate(()=>response.destroy());}else response.end(mode==='invalid'?'{bad':mode==='rejected'?'{"errors":[{"code":"SyntheticUnavailable"}]}':'{"productTypes":[]}');
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));const address=server.address();assert.ok(address&&typeof address==='object');
 const amazon=new AmazonService(f.directory,id=>f.store.getProductSnapshot(id),storage,{fetch:async(url,init)=>{const remote=new URL(String(url));assert.ok(['api.amazon.com','sellingpartnerapi-na.amazon.com'].includes(remote.hostname));return fetch(`http://127.0.0.1:${address.port}${remote.hostname==='api.amazon.com'?'/auth':remote.pathname+remote.search}`,init);},sleep:async()=>{},timeoutMs:2000,preserveHistoricalRecords:true});t.after(()=>amazon.close());
 const target=await amazon.importCredentials({name:'S09 synthetic',sellerId:'S09_SELLER',marketplaceId:'ATVPDKIKX0DER',region:'na',locale:'en_US',clientId:'s09-local-client',clientSecret:'s09-local-secret',refreshToken:'s09-local-refresh'}),rules=defaultListingRules();
 const later={schema:0,drafts:0,images:0,submit:0},fail=()=>{throw Error('must not reach later stage');};
 const deps={store:f.store,rules:()=>rules,hosting:f.hosting,
  amazon:{executionTargetScope:id=>amazon.executionTargetScope(id),getDraft:fail,listDrafts:()=>[],getSchema:async()=>{later.schema++;return fail();},prepareDrafts:async()=>{later.drafts++;return fail();}},
  images:{prepareSources:async()=>({product:f.store.getProductSnapshot(p.id),missing:[]}),complete:async()=>{later.images++;return fail();},getProgress:()=>null,cancel:()=>({cancelled:false}),cancelSources:()=>({cancelled:false})},
  execution:{create:fail,prepareStart:fail,startAuthorized:()=>{later.submit++;return fail();},get:fail,list:()=>[],pause:fail,cancel:fail,waitForIdle:async()=>{}},followup:{get:fail,schedule:fail},procurement:{candidates:()=>[],ensureAutomaticBatch:fail},labels:{syncBatch:fail,list:()=>[]},
  prepareSourceConsistency:async input=>{const source=f.store.getProductSnapshot(input.productId);materializeSourceSnapshot(f.directory,source,input.variantIds);await confirmSourceConsistencyFixture(f.directory,f.store,source.id,input.variantIds);},
  classify:async(input,signal)=>classifyProduct(input,{keywords:async()=>({id:'synthetic-keywords',output:{kind:'category-decision',phase:'keywords',keywords:['cloth'],productType:null,reason:'Cotton',ambiguous:false}}),localCandidates:()=>[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}],search:()=>[],fallback:async()=>[],choose:(value,phase)=>f.service.decideCategory({...value,phase},()=>{},signal),expansion:categoryExpansionPort(input,f.service,amazon,()=>{})}),
 } satisfies AutomaticListingDependencies;
 const automatic=new AutomaticListingService(f.directory,deps);try{
  const task=await automatic.create({productIds:[p.id],targetId:target.id,profileId:'alpha'}),db=(automatic as unknown as {db:DatabaseSync}).db;
  // Adversarial retained historical task, seeded before any dispatch. The actual
  // public create command must reject a new task once the original is UNKNOWN.
  const second=['unknown','missing-proof','missing-file','bad-file'].includes(mode)?validateAutomaticListingTask({...structuredClone(task),id:randomUUID()}):null;if(second){db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(second.id,JSON.stringify(second));bindWorkBatchTask(db,currentWorkBatch(db).id,second.id);(automatic as unknown as {tasks:Map<string,typeof task>}).tasks.set(second.id,second);}
  automatic.startAuthorized(automatic.prepareStart(task.id));await automatic.waitForIdle();
  const operation=readCategoryOperation(db,p.id),requestId=operation.expansion!.requestId,path=join(f.directory,'ai-receipts/category-expansions',requestId+'.json');
  const originalCalls=JSON.stringify(f.service.listCalls()),originalUsage=JSON.stringify(db.prepare('SELECT * FROM ai_usage_ledger').all());assert.equal(f.service.listCalls().length,1);assert.equal(f.service.listCalls()[0].status,'SUCCEEDED');assert.equal(automatic.get(task.id).items[0].classification,undefined);
  if(mode==='missing-proof'){const legacy=structuredClone(operation);delete legacy.expansion!.captureProof;db.prepare('UPDATE ai_category_operations SET record_json=? WHERE id=?').run(JSON.stringify(legacy),legacy.id);}
  if(mode==='missing-file')await unlink(path);
  if(mode==='bad-file'){const record=JSON.parse((await readFile(path)).toString());record.remoteRequestId='forged-platform-id';await writeFile(path,JSON.stringify(record));}
  const unknown=['unknown','missing-proof','missing-file','bad-file'].includes(mode),expected=unknown?['UNKNOWN','CATEGORY_EXPANSION_RESULT_UNKNOWN']:mode==='empty'?['NEEDS_INPUT','CATEGORY_NO_SUITABLE']:['SYSTEM_REPAIR',mode==='rejected'?'CATEGORY_EXPANSION_REJECTED':'AI_RECEIVED_INVALID_OUTPUT'];
  const readItem=()=>{const saved=automatic.get(task.id),detail=automatic.getTaskItem({taskId:task.id,revision:saved.revision,itemKey:saved.items[0].key});assert.equal(detail.kind,'item');if(detail.kind!=='item')throw Error('Missing item');return detail.item;};
  if(mode==='unknown'||mode==='invalid'||mode==='rejected'){
   const event=db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed' AND json_extract(detail_json,'$.taskId')=? ORDER BY rowid DESC LIMIT 1").get(task.id),detail=JSON.parse(String(event!.detail_json));assert.equal(detail.requestId,requestId);assert.equal(detail.callId,undefined);assert.equal(detail.itemKey,automatic.get(task.id).items[0].key);assert.equal(detail.sku,automatic.get(task.id).items[0].sku);assert.equal(detail.certainty,mode==='unknown'?'SENT_UNKNOWN':mode==='invalid'?'RECEIVED_INVALID':'DEFINITIVE_REJECTION');
  }
  assert.equal(readItem().outcome?.kind,expected[0]);assert.equal(readItem().outcome?.code,expected[1]);
  const changes=db.prepare('SELECT total_changes() n').get()!.n,business=JSON.stringify(db.prepare('SELECT * FROM automatic_listing_tasks').all()),audit=JSON.stringify(db.prepare('SELECT * FROM audit_events').all());
  for(let i=0;i<3;i++){assert.equal(readItem().outcome?.code,expected[1]);const summary=automatic.queryTaskSummaries({taskIds:[task.id],page:1,pageSize:20}).rows[0];assert.equal(summary.counts[unknown?'unknown':mode==='empty'?'needsInput':mode==='rejected'?'systemRepair':'invalidOutput'],1);const group=automatic.queryTaskGroups({taskId:task.id,revision:automatic.get(task.id).revision,page:1,pageSize:20,search:''});assert.equal(group.kind,'page');}
  assert.equal(db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(JSON.stringify(db.prepare('SELECT * FROM automatic_listing_tasks').all()),business);assert.equal(JSON.stringify(db.prepare('SELECT * FROM audit_events').all()),audit);
  const queue=await automatic.queue({productIds:[p.id],targetId:target.id});assert.equal(queue.products[0].rows[0].kind,expected[0]);assert.equal(queue.products[0].rows[0].eligible,false);
  automatic.startAuthorized(automatic.prepareStart(task.id));await automatic.waitForIdle();assert.equal(readItem().outcome?.code,expected[1]);
  if(unknown){assert.ok(second);await assert.rejects(automatic.create({productIds:[p.id],targetId:target.id,profileId:'alpha'}));automatic.startAuthorized(automatic.prepareStart(second.id));await automatic.waitForIdle();const event=db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed' AND json_extract(detail_json,'$.taskId')=? ORDER BY rowid DESC LIMIT 1").get(second.id),detail=JSON.parse(String(event!.detail_json));assert.equal(detail.requestId,requestId);assert.equal(detail.taskId,second.id);assert.equal(detail.callId,undefined);assert.equal(detail.itemKey,second.items[0].key);assert.equal(detail.certainty,'SENT_UNKNOWN');assert.equal(automatic.get(second.id).items[0].outcome?.code,expected[1]);}
  assert.equal(gets,1);assert.equal(lwa,1);assert.equal(none.posts,1);assert.equal(f.requests.length,1);assert.equal(JSON.stringify(f.service.listCalls()),originalCalls);assert.equal(JSON.stringify(db.prepare('SELECT * FROM ai_usage_ledger').all()),originalUsage);assert.deepEqual(later,{schema:0,drafts:0,images:0,submit:0});
 }finally{await automatic.close();amazon.close();}
});
