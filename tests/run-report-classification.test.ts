import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fixture,json} from './fixtures/ai-control.ts';
import {confirmSourceConsistencyFixture} from './helpers/source-consistency-proof.ts';
import {openDatabase} from '../src/main/database.ts';
import {RunReportReader} from '../src/main/diagnostics/run-report.ts';
import {classifyProduct} from '../src/main/catalog/classification.ts';
import {AutomaticListingService} from '../src/main/automatic-listing/service.ts';
import type {AutomaticListingDependencies} from '../src/main/automatic-listing/service.ts';
import {defaultListingRules} from '../src/shared/listing-rules.ts';
import {listingFingerprint} from '../src/main/json-fingerprint.ts';

async function producer(t:test.TestContext,judged=false,noSuitable=false){
  let automatic:AutomaticListingService|undefined;t.after(()=>automatic?.close());
  let chats=0;
  const f=await fixture(t,{fetch:async url=>String(url).includes('/decisions')?json({id:'synthetic-choice',answers:{category:{type:'choice',choice:noSuitable?'$NO_SUITABLE':'CLEANING_CLOTH'},review:{type:'choice',choice:judged?'review':'clear'}},usage:{input_tokens:10,output_tokens:10}}):json({id:'synthetic-chat',choices:[{finish_reason:'stop',message:{content:JSON.stringify(++chats===1?{kind:'category-decision',phase:'keywords',keywords:['cloth'],productType:null,reason:'Cotton source',ambiguous:false}:{kind:'category-decision',phase:'judge',keywords:['cloth'],productType:'CLEANING_CLOTH',reason:'Cotton source',ambiguous:false})}}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})});
  f.enable('deepseek');f.service.saveConnection({id:'openrouter',apiKey:'synthetic-category-fixture'});f.service.setEnabled({id:'openrouter',enabled:true});if(judged)f.enable('deepseek-review');
  const source=f.store.getProduct(f.product.id);
  const variants=source.variants.map(({id,sku,originalSpec,normalizedSpec,inventory})=>({id,sku,originalSpec,normalizedSpec,inventory,purchasePrice:'1'}));
  let product=f.store.saveProduct({id:source.id,revision:source.revision,title:source.title,sourceUrl:'',description:'',status:source.status,facts:source.facts,variants:[...variants,{...variants[0],id:randomUUID(),sku:'SYNTHETIC-CACHE-SIBLING',originalSpec:'Blue',normalizedSpec:'Blue'}]});
  product=f.store.updateAsset({productId:product.id,revision:product.revision,assetId:product.assets[0].id,role:'main',variantIds:product.variants.map(v=>v.id)});
  await confirmSourceConsistencyFixture(f.directory,f.store,product.id);
  const now=new Date().toISOString(),target={id:'synthetic-target',name:'Synthetic',mode:'demo' as const,sellerId:'synthetic-seller',marketplaceId:'ATVPDKIKX0DER',marketplaceName:'US',region:'na' as const,locale:'en_US',paused:false,configured:true,credentialUpdatedAt:now,lastError:null};
  let draftAttempts=0;
  // Actual automatic state-machine + classifier + M07; the downstream draft
  // boundary deliberately stops here. This fixture proves classification only.
  const unavailable=():never=>{throw Error('Outside classification fixture scope');};
  const deps:AutomaticListingDependencies={store:f.store,rules:defaultListingRules,hosting:{getProfile:()=>f.hosting.getProfile('alpha')},
    amazon:{executionTargetScope:()=>({target,generation:1}),getDraft:unavailable,listDrafts:()=>[],prepareDrafts:async()=>{draftAttempts++;throw Error('Synthetic stop after persisted classification');}},
    images:{getProgress:()=>null,prepareSources:unavailable,complete:unavailable,cancel:()=>({cancelled:true}),cancelSources:()=>({cancelled:true})},
    execution:{list:()=>[],get:unavailable,create:unavailable,prepareStart:unavailable,startAuthorized:unavailable,pause:unavailable,cancel:unavailable,waitForIdle:async()=>{}},
    followup:{get:unavailable,schedule:unavailable},procurement:{candidates:()=>[],ensureAutomaticBatch:unavailable},labels:{list:()=>[],syncBatch:()=>[]},
    classify:input=>classifyProduct(input,{keywords:v=>f.service.decideCategory({...v,phase:'keywords',candidates:[]}),search:()=>[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}],fallback:async()=>[],choose:(v,phase)=>f.service.decideCategory({...v,phase})}),
  };
  automatic=new AutomaticListingService(f.directory,deps);
  const run=async()=>{const task=await automatic!.create({productIds:[product.id],targetId:target.id,profileId:'alpha',productType:'AUTO'});automatic!.startAuthorized(automatic!.prepareStart(task.id));await automatic!.waitForIdle();return automatic!.get(task.id);};
  return {...f,product,automatic,run,draftAttempts:()=>draftAttempts};
}
const snapshot=(db:ReturnType<typeof openDatabase>)=>createHash('sha256').update(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>[r.name,db.prepare('SELECT * FROM "'+String(r.name).replaceAll('"','""')+'" ORDER BY rowid').all()]))).digest('hex');

test('actual automatic classification save links sibling and later task cache to exact original paid calls',async t=>{
  let db:ReturnType<typeof openDatabase>|undefined;t.after(()=>db?.close());
  const f=await producer(t),first=await f.run();db=openDatabase(f.directory);
  assert.equal(first.items.length,2);assert.ok(first.items.every(i=>i.stage==='DRAFT'&&i.status==='FAILED'&&i.classification),JSON.stringify({items:first.items.map(i=>({stage:i.stage,error:i.error,classification:!!i.classification})),diagnostics:db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed'").all(),requests:f.requests.length}));
  assert.equal(f.draftAttempts(),2);assert.equal(f.requests.length,2);
  const ids=first.items[0].classification!.decisionIds;assert.equal(ids.length,2);assert.deepEqual(first.items[1].classification!.decisionIds,ids);
  const reader=new RunReportReader(db),task=reader.query({taskId:first.id});
  assert.equal(task.counts.totalCalls,2);assert.equal(task.counts.adoptedResults,2,'saved classification is business adoption');
  for(const item of first.items){const view=reader.query({taskId:first.id,sku:item.sku});assert.equal(view.counts.totalCalls,2);assert.equal(view.counts.validResults,2);assert.equal(view.counts.adoptedResults,2);assert.ok(view.calls.every(c=>c.sku===item.sku&&c.itemKey===item.key));}
  f.automatic.cancel(first.id);const beforePosts=f.requests.length,second=await f.run();
  assert.equal(f.requests.length,beforePosts,'second task must use M07 cache');assert.deepEqual(second.items[0].classification!.decisionIds,ids);
  const cached=reader.query({taskId:second.id});assert.equal(cached.counts.totalCalls,2);assert.equal(cached.counts.savedReceipts,2);assert.equal(cached.counts.validResults,2);assert.equal(cached.counts.adoptedResults,2);assert.equal(cached.coverage.unassignedProductCalls,0);assert.ok(cached.calls.every(c=>c.association==='CLASSIFICATION_REFERENCE'));
  const initial=reader.query({taskId:second.id,pageSize:1});assert.ok(initial.page.nextCursor);const page=reader.query({taskId:second.id,pageSize:1,cursor:initial.page.nextCursor!});assert.equal(page.counts.totalCalls,2);assert.equal(new Set([...initial.calls,...page.calls].map(c=>c.callId)).size,2);assert.equal(reader.export({taskId:second.id}).calls.length,2);
  assert.throws(()=>reader.query({taskId:first.id,cursor:initial.page.nextCursor!}),/RUN_REPORT_CURSOR/);
  const before=snapshot(db),changes=db.prepare('SELECT total_changes() n').get()!.n;
  for(let i=0;i<100;i++)reader.query({taskId:second.id,sku:second.items[i%2].sku});
  assert.equal(snapshot(db),before);assert.equal(db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(f.requests.length,beforePosts);
  assert.doesNotMatch(JSON.stringify(cached),/synthetic-category-fixture|https:|Authorization|rawResponse|choices/);
});

test('actual judged classification adopts only its three exact IDs, never every result of a shared paid call',async t=>{
  let db:ReturnType<typeof openDatabase>|undefined;t.after(()=>db?.close());
  const f=await producer(t,true),task=await f.run();db=openDatabase(f.directory);
  assert.equal(f.requests.length,3,JSON.stringify(task.items.map(i=>({stage:i.stage,error:i.error}))));assert.ok(task.items[0].classification?.judged);const ids=task.items[0].classification!.decisionIds;assert.equal(ids.length,3);
  const original=JSON.parse(String(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(ids[2])!.record_json)),unused={...original,id:randomUUID()};
  db.prepare('INSERT INTO ai_results VALUES(?,?)').run(unused.id,JSON.stringify(unused));
  const view=new RunReportReader(db).query({taskId:task.id});assert.equal(view.counts.totalCalls,3);assert.equal(view.counts.validResults,4);assert.equal(view.counts.adoptedResults,3);
});

test('actual no-suitable decision without persisted classification stays valid and unadopted',async t=>{
  let db:ReturnType<typeof openDatabase>|undefined;t.after(()=>db?.close());
  const f=await producer(t,false,true),task=await f.run();db=openDatabase(f.directory);
  assert.ok(task.items.every(i=>!i.classification));assert.equal(f.requests.length,2);assert.equal(f.draftAttempts(),0);
  const report=new RunReportReader(db).query({taskId:task.id});assert.equal(report.counts.validResults,2);assert.equal(report.counts.adoptedResults,0);
});

test('saved classification foreign result identity, kind, model and call ownership fail closed without writes',async t=>{
  let db:ReturnType<typeof openDatabase>|undefined;t.after(()=>db?.close());
  const f=await producer(t),task=await f.run();db=openDatabase(f.directory);const database=db;
  const resultId=task.items[0].classification!.decisionIds[1],row=database.prepare('SELECT record_json FROM ai_results WHERE id=?').get(resultId)!,result=JSON.parse(String(row.record_json)),callRow=database.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(result.callId)!,call=JSON.parse(String(callRow.record_json));
  const reader=new RunReportReader(database);
  for(const [field,value] of [['id',randomUUID()],['productId',randomUUID()],['productRevision',result.productRevision+1],['callId',randomUUID()],['providerId','deepseek-review'],['model','foreign-model'],['output',{...result.output,kind:'text'}],['output',{...result.output,phase:'judge'}],['output',{...result.output,selection:{...result.output.selection,outcome:'NO_SUITABLE'}}]] as const){
    database.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({...result,[field]:value}),resultId);
    const before=snapshot(database),changes=database.prepare('SELECT total_changes() n').get()!.n;
    assert.throws(()=>reader.query({taskId:task.id}),/RUN_REPORT_INVALID_RECORD/,String(field));assert.equal(snapshot(database),before);assert.equal(database.prepare('SELECT total_changes() n').get()!.n,changes);
  }
  database.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(String(row.record_json),resultId);
  for(const patch of [{productId:randomUUID()},{model:'foreign-model'},{requestScope:{...call.requestScope,productId:randomUUID()}},{requestScope:{...call.requestScope,operation:'fields'}},{categoryContext:{...call.categoryContext,phase:'judge'}},{categoryContext:{...call.categoryContext,operationId:randomUUID()}}]){
    database.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...call,...patch}),call.id);
    assert.throws(()=>reader.query({taskId:task.id}),/RUN_REPORT_INVALID_RECORD/);
  }
  database.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(String(callRow.record_json),call.id);
  assert.equal(reader.query({taskId:task.id}).counts.adoptedResults,2);assert.equal(f.requests.length,2);
});

test('classification recovery metadata keeps original failed call ownership and rejects foreign recovery markers',async t=>{
  let db:ReturnType<typeof openDatabase>|undefined;t.after(()=>db?.close());
  const f=await producer(t),task=await f.run();db=openDatabase(f.directory);const database=db;
  const resultId=task.items[0].classification!.decisionIds[1],result=JSON.parse(String(database.prepare('SELECT record_json FROM ai_results WHERE id=?').get(resultId)!.record_json)),original=JSON.parse(String(database.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(result.callId)!.record_json));
  // Synthetic metadata boundary: report does not re-open private receipt bytes.
  const call={...original,status:'FAILED',errorCode:'OUTPUT_INVALID'},createdAt=new Date(Date.parse(original.finishedAt)+1).toISOString();
  const marker={version:1,receiptId:original.providerReceiptId,requestFingerprint:call.requestFingerprint,scopeSha256:listingFingerprint(call.requestScope),recoveredAt:createdAt};
  const recovered={...result,createdAt,providerReceiptRecovery:marker};database.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);database.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(recovered),result.id);
  const reader=new RunReportReader(database);assert.equal(reader.query({taskId:task.id}).counts.adoptedResults,2);
  for(const patch of [{receiptId:'a'.repeat(64)},{requestFingerprint:'a'.repeat(64)},{scopeSha256:'a'.repeat(64)},{recoveredAt:original.finishedAt}]){
    database.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({...recovered,providerReceiptRecovery:{...marker,...patch}}),result.id);
    assert.throws(()=>reader.query({taskId:task.id}),/RUN_REPORT_INVALID_RECORD/);
  }
  assert.equal(f.requests.length,2);
});
