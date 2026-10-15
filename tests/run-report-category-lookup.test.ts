import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {fixture,storage} from './fixtures/ai-control.ts';
import {AmazonService} from '../src/main/amazon/service.ts';
import {classifyProduct} from '../src/main/catalog/classification.ts';
import {categoryExpansionPort} from '../src/main/catalog/category-expansion.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {readCategoryOperation} from '../src/main/ai/category-operations.ts';
import {recordErrorEvidence} from '../src/main/error-evidence.ts';
import {RunReportReader} from '../src/main/diagnostics/run-report.ts';
const local=[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}],novel={name:'PLATFORM_SPECIALTY',displayName:'Cloth specialty'};
async function setup(t:test.TestContext,mode:'valid'|'500'|'half'|'invalid'|'empty'='valid'){
  let amazon:AmazonService|undefined;t.after(()=>amazon?.close());
  const counts={aiPosts:0,lwa:0,get:0};
  const server=createServer((request,response)=>{let raw='';request.on('data',c=>raw+=c);request.on('end',()=>{
    response.setHeader('content-type','application/json');
    if(request.url==='/auth'){counts.lwa++;response.end(JSON.stringify({access_token:'synthetic-lookup-token',token_type:'bearer',expires_in:3600}));return;}
    if(request.url?.startsWith('/definitions/')){assert.equal(request.method,'GET');counts.get++;response.writeHead(mode==='500'?500:200,{'x-amzn-requestid':'synthetic-original-get'});
      if(mode==='half'){response.write('{"productTypes":[');setImmediate(()=>response.destroy());return;}
      response.end(mode==='invalid'?'{bad json':mode==='500'?'{"errors":[{"code":"SyntheticUnavailable"}]}':JSON.stringify({productTypes:mode==='empty'?[]:[novel]}));return;
    }
    counts.aiPosts++;const body=JSON.parse(raw),state=Array.isArray(body.state)?body.state[0]:body.state;
    response.end(JSON.stringify(body.questions?{id:'synthetic-select',answers:{category:{type:'choice',choice:state.candidates.some((c:{name:string})=>c.name===novel.name)?novel.name:'$NO_SUITABLE'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3,cost:.001}}:{id:'synthetic-keywords',choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'category-decision',phase:'keywords',keywords:['cloth'],productType:null,reason:'Synthetic cloth source',ambiguous:false})}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:.001}}));
  });});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  const f=await fixture(t,{fetch:async(url,init)=>fetch(base+(String(url).includes('/decisions')?'/decisions':'/keywords'),init)});f.enable('deepseek');f.service.saveConnection({id:'openrouter',apiKey:'synthetic-get-report-key'});f.service.setEnabled({id:'openrouter',enabled:true});
  amazon=new AmazonService(f.directory,id=>f.store.getProductSnapshot(id),storage,{fetch:async(url,init)=>{const original=new URL(String(url));assert.ok(['api.amazon.com','sellingpartnerapi-na.amazon.com'].includes(original.hostname));return fetch(base+(original.hostname==='api.amazon.com'?'/auth':original.pathname+original.search),init);},sleep:async()=>{},timeoutMs:2000,preserveHistoricalRecords:true});
  const target=await amazon.importCredentials({name:'Synthetic category report',sellerId:'SYNTHETIC_REPORT_SELLER',marketplaceId:'ATVPDKIKX0DER',region:'na',locale:'en_US',clientId:'synthetic-client',clientSecret:'synthetic-client-secret',refreshToken:'synthetic-refresh'});
  const db=(f.service as unknown as {db:DatabaseSync}).db,taskId=randomUUID(),item={key:f.product.id+':'+f.product.variants[0].id,productId:f.product.id,productRevision:f.product.revision,sku:f.product.variants[0].sku,draftId:null},task={id:taskId,revision:1,targetId:target.id,sellerId:target.sellerId,marketplaceId:target.marketplaceId,locale:target.locale,mode:target.mode,items:[item]};
  const persist=(value:unknown,id=taskId)=>db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(id,JSON.stringify(value));persist(task);
  const run=async(id=taskId,adopt=true)=>{const context={taskId:id,rowKey:item.key,phase:'CATEGORY',mode:'immediate' as const,authorize:()=>true},input={productId:f.product.id,productRevision:f.product.revision,targetId:target.id};
    try{const result=await taskAiContext.run(context,()=>classifyProduct(input,{keywords:v=>f.service.decideCategory({...v,phase:'keywords',candidates:[]}),search:()=>local,localCandidates:()=>local,fallback:async()=>[],choose:(v,phase)=>f.service.decideCategory({...v,phase}),expansion:categoryExpansionPort(input,f.service,amazon!,()=>{})}));if(adopt)persist({...task,id,items:[{...item,classification:result}]},id);return result;}
    catch(error){const requestId=error&&typeof error==='object'&&'requestId'in error?String(error.requestId):undefined;recordErrorEvidence(detail=>db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),f.product.id,'operation.failed','Synthetic GET failure',JSON.stringify(detail),new Date().toISOString()),error,{stage:'CLASSIFY',taskId:id,itemKey:item.key,sku:item.sku,requestId});throw error;}
  };
  return {...f,db,taskId,item,task,persist,run,counts,reader:new RunReportReader(db)};
}
const dbHash=(db:DatabaseSync)=>createHash('sha256').update(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>[r.name,db.prepare('SELECT * FROM "'+String(r.name).replaceAll('"','""')+'" ORDER BY rowid').all()]))).digest('hex');

test('actual M07 + Amazon GET keeps original HTTP, snapshot and adopted selection separate from paid calls',async t=>{
  const s=await setup(t);await s.run();const report=s.reader.query({taskId:s.taskId});
  assert.deepEqual(s.counts,{aiPosts:3,lwa:1,get:1});assert.equal(report.counts.totalCalls,3);assert.equal(report.counts.validResults,3);assert.equal(report.counts.adoptedResults,2);
  const lookups=report.categoryLookups;assert.equal(lookups?.length,1,'successful GET needs its original request and HTTP evidence');
  const op=readCategoryOperation(s.db,s.product.id),lookup=lookups[0];assert.equal(lookup.requestId,op.expansion!.requestId);assert.equal(lookup.httpStatus,200);assert.equal(lookup.remoteRequestId,'synthetic-original-get');assert.equal(lookup.snapshotSaved,true);assert.equal(lookup.adopted,true);assert.equal(lookup.receiptIntegrity,'SAVED_METADATA_ONLY');assert.ok(!report.calls.some(c=>c.callId===lookup.requestId));
  assert.doesNotMatch(JSON.stringify(report),/https?:|Authorization|synthetic-get-report-key|synthetic-lookup-token|synthetic-client-secret|query|base64|productTypes/);
  const before=dbHash(s.db),changes=s.db.prepare('SELECT total_changes() n').get()!.n;
  for(let i=0;i<100;i++)s.reader.query({taskId:s.taskId,sku:s.item.sku});assert.equal(dbHash(s.db),before);assert.equal(s.db.prepare('SELECT total_changes() n').get()!.n,changes);assert.deepEqual(s.counts,{aiPosts:3,lwa:1,get:1});
  const unrelated=randomUUID();s.persist({...s.task,id:unrelated},unrelated);assert.equal(s.reader.query({taskId:unrelated}).categoryLookups.length,0,'same product alone cannot assign GET');
  const cached=randomUUID();s.persist({...s.task,id:cached},cached);const reused=await s.run(cached);assert.deepEqual(s.counts,{aiPosts:3,lwa:1,get:1});const view=s.reader.query({taskId:cached});assert.equal(view.counts.totalCalls,2);assert.equal(view.categoryLookups[0].requestId,lookup.requestId);assert.equal(view.categoryLookups[0].adopted,true);
  const sibling={...s.item,key:s.product.id+':'+randomUUID(),sku:'SYNTHETIC-LOOKUP-SIBLING',classification:reused};s.persist({...s.task,id:cached,items:[{...s.item,classification:reused},sibling]},cached);
  const grouped=s.reader.query({taskId:cached});assert.equal(grouped.counts.totalCalls,2);assert.equal(grouped.categoryLookups.length,1);assert.deepEqual(new Set(grouped.categoryLookups[0].skus),new Set([s.item.sku,sibling.sku]));
  const onlySibling=s.reader.query({taskId:cached,sku:sibling.sku});assert.equal(onlySibling.counts.totalCalls,2);assert.deepEqual(onlySibling.categoryLookups[0].skus,[sibling.sku]);assert.deepEqual(s.counts,{aiPosts:3,lwa:1,get:1});
});

for(const mode of ['500','half','invalid','empty'] as const)test(`actual original GET ${mode} retains request evidence without inventing valid candidates or adoption`,async t=>{
  const s=await setup(t,mode);await assert.rejects(s.run());const report=s.reader.query({taskId:s.taskId}),lookup=report.categoryLookups?.[0],operation=readCategoryOperation(s.db,s.product.id);
  assert.ok(lookup,'GET failure still needs its original request ID');assert.equal(lookup.requestId,operation.expansion!.requestId);assert.equal(lookup.adopted,false);assert.equal(report.counts.totalCalls,2);assert.equal(report.counts.adoptedResults,0);assert.equal(lookup.snapshotSaved,mode==='empty');assert.equal(lookup.httpStatus,mode==='half'?null:mode==='500'?500:200);
  assert.deepEqual(s.counts,{aiPosts:2,lwa:1,get:1});await assert.rejects(s.run());assert.deepEqual(s.counts,{aiPosts:2,lwa:1,get:1});
});

test('all-cached later task GET error links only its exact request and current SKU without fabricating AI calls',async t=>{
  const s=await setup(t,'half');await assert.rejects(s.run());const operation=readCategoryOperation(s.db,s.product.id),next=randomUUID();s.persist({...s.task,id:next},next);
  await assert.rejects(s.run(next));const report=s.reader.query({taskId:next});assert.equal(report.counts.totalCalls,0);assert.equal(report.categoryLookups.length,1);assert.equal(report.categoryLookups[0].requestId,operation.expansion!.requestId);assert.equal(report.categoryLookups[0].certainty,'SENT_UNKNOWN');assert.deepEqual(report.categoryLookups[0].skus,[s.item.sku]);assert.deepEqual(s.counts,{aiPosts:2,lwa:1,get:1});
  const before=dbHash(s.db),changes=s.db.prepare('SELECT total_changes() n').get()!.n;for(let i=0;i<100;i++)s.reader.query({taskId:next,sku:s.item.sku});assert.equal(dbHash(s.db),before);assert.equal(s.db.prepare('SELECT total_changes() n').get()!.n,changes);assert.deepEqual(s.counts,{aiPosts:2,lwa:1,get:1});
  const foreign=randomUUID();s.persist({...s.task,id:foreign},foreign);
  recordErrorEvidence(detail=>s.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),s.product.id,'operation.failed','Synthetic foreign request',JSON.stringify(detail),new Date().toISOString()),{},{stage:'CLASSIFY',taskId:foreign,itemKey:s.item.key,sku:s.item.sku,requestId:randomUUID(),certainty:'SENT_UNKNOWN'});
  assert.equal(s.reader.query({taskId:foreign}).categoryLookups.length,0);
});

test('GET projection rejects foreign operation or target ownership and invalidates pagination on changed lookup metadata',async t=>{
  const s=await setup(t);await s.run();const operation=readCategoryOperation(s.db,s.product.id),original=JSON.stringify(operation),id=operation.id,first=s.reader.query({taskId:s.taskId,pageSize:1});assert.ok(first.page.nextCursor);
  for(const changed of [{...operation,productId:randomUUID()},{...operation,expansion:{...operation.expansion,captureProof:{...operation.expansion!.captureProof,targetScope:{...operation.expansion!.captureProof!.targetScope,sellerId:'FOREIGN_SELLER'}}}}]){
    s.db.prepare('UPDATE ai_category_operations SET record_json=? WHERE id=?').run(JSON.stringify(changed),id);const before=dbHash(s.db),changes=s.db.prepare('SELECT total_changes() n').get()!.n;
    assert.throws(()=>s.reader.query({taskId:s.taskId}),/RUN_REPORT_INVALID_RECORD/);assert.equal(dbHash(s.db),before);assert.equal(s.db.prepare('SELECT total_changes() n').get()!.n,changes);
  }
  const changed={...operation,expansion:{...operation.expansion,captureProof:{...operation.expansion!.captureProof,remoteRequestId:'changed-original-metadata'}}};s.db.prepare('UPDATE ai_category_operations SET record_json=? WHERE id=?').run(JSON.stringify(changed),id);
  assert.throws(()=>s.reader.query({taskId:s.taskId,cursor:first.page.nextCursor!}),/RUN_REPORT_CURSOR_RELOAD/);
  s.db.prepare('UPDATE ai_category_operations SET record_json=? WHERE id=?').run(original,id);assert.equal(s.reader.export({taskId:s.taskId}).categoryLookups.length,1);assert.deepEqual(s.counts,{aiPosts:3,lwa:1,get:1});
});
