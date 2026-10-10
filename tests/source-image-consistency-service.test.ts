import { AmazonService } from '../src/main/amazon/service.ts';
import { ListingRuleStore } from '../src/main/listing-rules.ts';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import type { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import { addSourceOriginalFixture } from './helpers/source-consistency-proof.ts';
import { consistencyDecisionKey } from '../src/main/source-image-consistency/scope.ts';
import { createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore } from '../src/main/backup.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { consistencyFixture } from './helpers/source-consistency.ts';
import { AiService } from '../src/main/ai/service.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { chat,mockStorage,saveInput } from './fixtures/listing-ai.ts';
import { consistencyScopeKey } from '../src/main/source-image-consistency/scope.ts';
import { assertConsistencyHistory } from '../src/main/source-image-consistency/history.ts';
import { readConsistencyView,assertProductConsistency } from '../src/main/source-image-consistency/proof.ts';
import { randomUUID } from 'node:crypto';

async function fixture(t:test.TestContext){
  const f=consistencyFixture(t),hosting=new HostingService(f.directory,f.store,mockStorage);let count=0;
  let respond=(p:any):Response|Promise<Response>=>chat({kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:p.claims.map((c:any)=>({claimId:c.id,value:c.axis==='color'?'Blue':'Round',visibility:'visible'}))}))});
  const dependencies={fetch:async(_url:any,options?:RequestInit)=>{count++;const content=JSON.parse(String(options?.body)).messages[1].content;return respond(JSON.parse(content[0].text));}};
  const ai=new AiService(f.directory,f.store,hosting,mockStorage,dependencies);ai.saveConnection({id:'deepseek',apiKey:'consistency-synthetic-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});
  f.cleanup.push(async()=>{await ai.close();await hosting.close();});
  return{...f,hosting,ai,dependencies,count:()=>count,respond:(fn:typeof respond)=>{respond=fn;},observe:()=>ai.observeSourceConsistency(f.context(),()=>{})};
}
test('new consistency request persists strict successful AI/assessment and reuses across restart/title/model changes',async t=>{
  const f=await fixture(t),before=f.store.getProduct(f.p.id),first=await f.observe();assert.equal(first.output.kind,'source-image-consistency');assert.equal(f.count(),1);assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);assert.ok(first.sourceConsistencyRequestBytes!>100);
  assert.deepEqual(f.store.getProduct(f.p.id),before);assert.equal(assertConsistencyHistory(f.db,f.directory).length,1);
  const a=f.db.prepare('SELECT record_json FROM source_consistency_assessments').get()!;assert.equal(JSON.parse(String(a.record_json)).decision,'MATCH');
  await f.ai.close();const second=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies);
  try{const p=f.store.getProduct(f.p.id);f.store.saveProduct({...saveInput(p),title:'Cosmetic edit'});second.saveFunctionSettings({id:'deepseek',model:'deepseek-v4-pro',enabled:true});const cached=await second.observeSourceConsistency(f.context(),()=>{});assert.equal(cached.id,first.id);assert.equal(f.count(),1);}finally{await second.close();}
});
test('concurrent service instances reserve exactly one send and no second usage reservation',async t=>{
  const f=await fixture(t),other=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies);
  try{const results=await Promise.allSettled([f.observe(),other.observeSourceConsistency(f.context(),()=>{})]);assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(f.count(),1);assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);}finally{await other.close();}
});
test('malformed paid output and unknown transport remain durable no-resend scopes',async t=>{
  for(const kind of ['malformed','unknown']){
    const f=await fixture(t);f.respond(()=>{if(kind==='unknown')throw new TypeError('synthetic transport unknown');return chat({kind:'source-image-consistency',verdict:'PASS'});});
    await assert.rejects(f.observe());assert.equal(f.count(),1);await assert.rejects(f.observe());assert.equal(f.count(),1);
    assert.ok(f.db.prepare('SELECT id FROM source_consistency_attempts WHERE id=?').get(consistencyScopeKey(f.context())));
    assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_assessments').get()!.n,0);
    await f.ai.close();const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies);
    try{restarted.saveConnection({id:'deepseek',apiKey:'rotated-synthetic-key'});restarted.saveFunctionSettings({id:'deepseek',model:'deepseek-v4-pro',enabled:false});restarted.setUsagePolicy({providerId:'deepseek',dailyCallLimit:0,dailyTokenLimit:0});await assert.rejects(restarted.observeSourceConsistency(f.context(),()=>{}));assert.equal(f.count(),1);}finally{await restarted.close();}
  }
});
test('presend cancellation and quota rejection do not reserve consistency attempt',async t=>{
  const f=await fixture(t),controller=new AbortController();controller.abort();await assert.rejects(f.ai.observeSourceConsistency(f.context(),()=>{},controller.signal));
  f.ai.setUsagePolicy({providerId:'deepseek',dailyCallLimit:0,dailyTokenLimit:null});await assert.rejects(f.observe());
  assert.equal(f.count(),0);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,0);
});
test('midflight source edits prevent adoption, retaining sent guard',async t=>{
  const f=await fixture(t);f.respond(p=>{const current=f.store.getProduct(f.p.id);f.store.saveProduct({...saveInput(current),variants:saveInput(current).variants.map(v=>({...v,originalSpec:'Red square'}))});return chat({kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:p.claims.map((c:any)=>({claimId:c.id,value:c.value,visibility:'visible'}))}))});});
  await assert.rejects(f.observe());assert.equal(f.count(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_assessments').get()!.n,0);
});
test('saved result recovers assessment locally; mismatched call context cannot authorize history',async t=>{
  const f=await fixture(t),result=await f.observe();f.db.prepare('DELETE FROM source_consistency_assessments').run();
  assert.equal((await f.observe()).id,result.id);assert.equal(f.count(),1);assert.equal(assertConsistencyHistory(f.db,f.directory).length,1);
  const row=f.db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(result.callId)!;const call=JSON.parse(String(row.record_json));call.sourceConsistencyContext.productRevision++;call.productRevision++;
  f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),result.callId);assert.throws(()=>assertConsistencyHistory(f.db));
});
test('shared source thumbnail assesses each sibling independently and preserves a healthy sibling',async t=>{
  const f=await fixture(t),variantId=randomUUID();let p=f.store.getProduct(f.p.id);
  p=f.store.saveProduct({...saveInput(p),variants:[...saveInput(p).variants,{id:variantId,sku:'SYNTHETIC-RED',originalSpec:'Red square',normalizedSpec:'Red square',purchasePrice:'1',inventory:null}]});
  p=f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets[0].id,role:'main',variantIds:p.variants.map(v=>v.id)});
  await f.observe();const other=f.ai.sourceConsistencyContext({productId:p.id,productRevision:p.revision,variantId});await f.ai.observeSourceConsistency(other,()=>{});
  assert.equal(readConsistencyView(f.db,f.context()).status,'MATCH');assert.equal(readConsistencyView(f.db,other).status,'NEEDS_INPUT');assert.equal(f.count(),2);
  assertProductConsistency(f.db,p,[p.variants[0].id]);assert.throws(()=>assertProductConsistency(f.db,p,[variantId]));
  assert.deepEqual(f.store.getProduct(p.id),p);
});

test('disabled profile and final presend checkpoint consume no attempt and resume safely',async t=>{
  const f=await fixture(t);f.ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:false});await assert.rejects(f.observe());
  f.ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});await assert.rejects(f.ai.observeSourceConsistency(f.context(),()=>{},undefined,()=>{throw new Error('synthetic paused before send');}));
  assert.equal(f.count(),0);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,0);await f.observe();assert.equal(f.count(),1);
});

test('midflight pause and managed-byte replacement retain liability without accepting results',async t=>{
  for(const mutation of ['pause','bytes']){
    const f=await fixture(t),controller=new AbortController();f.respond(p=>{
      if(mutation==='pause')controller.abort();else writeFileSync(join(f.directory,f.store.getAssetRecord(f.p.assets[0].id)!.originalPath),Buffer.alloc(33));
      return chat({kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:p.claims.map((c:any)=>({claimId:c.id,value:c.value,visibility:'visible'}))}))});
    });
    await assert.rejects(f.ai.observeSourceConsistency(f.context(),()=>{},controller.signal));assert.equal(f.count(),1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_assessments').get()!.n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_results').get()!.n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,1);
  }
});

test('assessment write failure rolls back success atomically and never resends the paid attempt',async t=>{
  const f=await fixture(t);f.db.exec("CREATE TRIGGER synthetic_assessment_failure BEFORE INSERT ON source_consistency_assessments BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
  await assert.rejects(f.observe());f.db.exec('DROP TRIGGER synthetic_assessment_failure');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ai_results').get()!.n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_assessments').get()!.n,0);assert.equal(f.count(),1);
  await assert.rejects(f.observe());assert.equal(f.count(),1);
});

test('actual older encrypted restore retains unknown send guard without restoring positive proof',async t=>{
  const f=await fixture(t),file=join(f.directory,'before-send.htcbackup'),pass='synthetic-consistency-restore-pass';await createWorkspaceBackup(f.directory,file,pass);
  f.respond(()=>{throw new TypeError('synthetic response lost');});await assert.rejects(f.observe());
  const retired=new AmazonService(f.directory,id=>f.store.getProduct(id),mockStorage),target=retired.enableDemo();
  try{const draft=await retired.createDraft({productId:f.p.id,variantId:f.p.variants[0].id,targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});f.db.prepare('UPDATE listing_drafts SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',draft.id);assert.equal(retired.cleanupData().removedDrafts,1);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,1);}finally{retired.close();}
  const snapshot=await prepareWorkspaceRestore(f.directory,file,pass);
  await f.ai.close();await f.hosting.close();f.closeStorage();await commitWorkspaceRestore(f.directory,snapshot);
  const store=new WorkspaceStore(f.directory),db=openDatabase(f.directory),hosting=new HostingService(f.directory,store,mockStorage),ai=new AiService(f.directory,store,hosting,mockStorage,f.dependencies);
  try{
    const p=store.getProduct(f.p.id),context=ai.sourceConsistencyContext({productId:p.id,productRevision:p.revision,variantId:p.variants[0].id});
    assert.equal(readConsistencyView(db,context).status,'UNKNOWN');assert.equal(db.prepare('SELECT count(*) n FROM source_consistency_assessments').get()!.n,0);
    ai.saveConnection({id:'deepseek',apiKey:'restored-new-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-v4-pro',enabled:true});await assert.rejects(ai.observeSourceConsistency(context,()=>{}));assert.equal(f.count(),1);
    await createWorkspaceBackup(f.directory,join(f.directory,'guard-only.htcbackup'),pass);
  }finally{await ai.close();await hosting.close();db.close();store.close();}
});

test('swapping main and gallery reuses the same paid image set but invalidates human association epoch',async t=>{
  const f=await fixture(t);let p=addSourceOriginalFixture(f.directory,f.store,f.p.id,[f.p.variants[0].id],'gallery',1),before=f.context();
  const first=await f.observe(),gallery=p.assets.find(a=>a.role==='gallery')!;
  p=f.store.updateAsset({productId:p.id,revision:p.revision,assetId:gallery.id,role:'main',variantIds:[p.variants[0].id]});
  const after=f.context();assert.notDeepEqual(after.referenceAssets.map(a=>a.assetId),before.referenceAssets.map(a=>a.assetId));
  assert.notEqual(consistencyDecisionKey(after),consistencyDecisionKey(before));assert.equal((await f.observe()).id,first.id);assert.equal(f.count(),1);
});

test('pricing-only midflight changes retain a paid source result and block the next new scope',async t=>{
  const f=await fixture(t);let p=f.store.getProduct(f.p.id);p=f.store.saveProduct({...saveInput(p),variants:[...saveInput(p).variants,{...saveInput(p).variants[0],id:randomUUID(),sku:'PRICING-SECOND'}]});
  p=f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets[0].id,role:'main',variantIds:p.variants.map(v=>v.id)});
  const amazon=new AmazonService(f.directory,id=>f.store.getProduct(id),mockStorage),rules=new ListingRuleStore(f.directory),target=amazon.enableDemo();
  try{
    for(const variant of p.variants){
      const draft=await amazon.createDraft({targetId:target.id,productId:p.id,variantId:variant.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
      const persistence=(amazon as unknown as {persistence:AmazonPersistence}).persistence,record=persistence.record(draft.id),priced=applyBusinessRules({product:p,variant,target,schema:realAmazonSchema(),attributes:{},measurements:{},costCny:2.4,now:new Date()},rules.get());
      record.draft.attributes=priced.attributes;record.draft.listingProgram='haul';record.draft.businessRules={...priced.report,fields:{}};persistence.putRecord(record);
    }
    f.respond(payload=>{rules.save(rules.get());return chat({kind:'source-image-consistency',assets:payload.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:payload.claims.map((c:any)=>({claimId:c.id,value:c.value,visibility:'visible'}))}))});});
    const result=await f.observe();assert.equal((await f.observe()).id,result.id);assert.equal(f.count(),1);
    const other=f.ai.sourceConsistencyContext({productId:p.id,productRevision:p.revision,variantId:p.variants[1].id});await assert.rejects(f.ai.observeSourceConsistency(other,()=>{}));assert.equal(f.count(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,1);
  }finally{rules.close();amazon.close();}
});
