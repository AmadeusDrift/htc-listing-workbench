import { canRetryConfirmedForbidden } from '../src/main/ai/confirmed-forbidden-retry.ts';
import {inheritLegacyPurposeSettings} from '../src/main/ai/purpose-routing.ts';
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
import { reserveConsistencyAttempt,assertConsistencyHistory } from '../src/main/source-image-consistency/history.ts';
import { readConsistencyView,assertProductConsistency } from '../src/main/source-image-consistency/proof.ts';
import { randomUUID } from 'node:crypto';
import { recordInvalidAiOutput } from '../src/main/ai/output-diagnostics.ts';

async function fixture(t:test.TestContext){
  const f=consistencyFixture(t),hosting=new HostingService(f.directory,f.store,mockStorage);let count=0;
  let respond=(p:any):Response|Promise<Response>=>chat({kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:p.claims.map((c:any)=>({claimId:c.id,value:c.axis==='color'?'Blue':'Round',visibility:'visible'}))}))});
  const dependencies={fetch:async(_url:any,options?:RequestInit)=>{count++;const content=JSON.parse(String(options?.body)).messages[1].content;return respond(JSON.parse(content[0].text));}};
  const ai=new AiService(f.directory,f.store,hosting,mockStorage,dependencies);ai.saveConnection({id:'deepseek',apiKey:'consistency-synthetic-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});inheritLegacyPurposeSettings((ai as any).db,'deepseek','deepseek-flash',false);
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
test('malformed paid output remains recoverable while unknown transport stays blocked',async t=>{
  for(const kind of ['malformed','unknown']){
    const f=await fixture(t);f.respond(()=>{if(kind==='unknown')throw new TypeError('synthetic transport unknown');return chat({kind:'source-image-consistency',verdict:'PASS'});});
    await assert.rejects(f.observe(),e=>{assert.equal(f.count(),1,String(e));return true;});assert.equal(f.count(),1);await assert.rejects(f.observe());assert.equal(f.count(),1);
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
test('shared source thumbnail keeps a contradiction on its specific sibling attributes without blocking the product',async t=>{
  const f=await fixture(t),variantId=randomUUID();let p=f.store.getProduct(f.p.id);
  p=f.store.saveProduct({...saveInput(p),variants:[...saveInput(p).variants,{id:variantId,sku:'SYNTHETIC-RED',originalSpec:'Red square',normalizedSpec:'Red square',purchasePrice:'1',inventory:null}]});
  p=f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets[0].id,role:'main',variantIds:p.variants.map(v=>v.id)});
  await f.observe();const other=f.ai.sourceConsistencyContext({productId:p.id,productRevision:p.revision,variantId});await f.ai.observeSourceConsistency(other,()=>{});
  assert.equal(readConsistencyView(f.db,f.context()).status,'MATCH');assert.equal(readConsistencyView(f.db,other).status,'MATCH');assert.equal(f.count(),2);
  assertProductConsistency(f.db,p,[p.variants[0].id]);assertProductConsistency(f.db,p,[variantId]);
  assert.ok(f.ai.sourceObservationEvidence(other).conflicts.length>0);assert.equal(f.ai.sourceObservationEvidence(f.context()).conflicts.length,0);
  assert.deepEqual(f.store.getProduct(p.id),p);
});

test('disabled profile and final presend checkpoint consume no attempt and resume safely',async t=>{
  const f=await fixture(t);f.ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:false});await assert.rejects(f.observe());
  f.ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});inheritLegacyPurposeSettings((f.ai as any).db,'deepseek','deepseek-flash',false);await assert.rejects(f.ai.observeSourceConsistency(f.context(),()=>{},undefined,()=>{throw new Error('synthetic paused before send');}));
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

test('assessment write failure rolls back success atomically and preserves unknown result protection',async t=>{
  const f=await fixture(t);f.db.exec("CREATE TRIGGER synthetic_assessment_failure BEFORE INSERT ON source_consistency_assessments BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
  await assert.rejects(f.observe());f.db.exec('DROP TRIGGER synthetic_assessment_failure');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ai_results').get()!.n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_assessments').get()!.n,0);assert.equal(f.count(),1);
  await assert.rejects(f.observe());assert.equal(f.count(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,1);
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
    f.respond(payload=>{const changed=rules.get();changed.pricing.inboundCost+=1;rules.save(changed);return chat({kind:'source-image-consistency',assets:payload.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:payload.claims.map((c:any)=>({claimId:c.id,value:c.value,visibility:'visible'}))}))});});
    const result=await f.observe();assert.equal((await f.observe()).id,result.id);assert.equal(f.count(),1);
    const other=f.ai.sourceConsistencyContext({productId:p.id,productRevision:p.revision,variantId:p.variants[1].id});await assert.rejects(f.ai.observeSourceConsistency(other,()=>{}));assert.equal(f.count(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,1);
  }finally{rules.close();amazon.close();}
});

test('saved OUTPUT_INVALID diagnostics recover observations offline without changing failed call or usage',async t=>{
  const f=await fixture(t);f.respond(()=>chat({bad:true}));await assert.rejects(f.observe());
  const call=f.ai.listCalls()[0],usage=f.ai.getUsageSummary('deepseek');
  call.sourceConsistencyContext!.version='source-image-consistency/v1';
  f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);
  const attemptRow=f.db.prepare('SELECT record_json FROM source_consistency_attempts').get()!,attempt=JSON.parse(String(attemptRow.record_json));attempt.context.version='source-image-consistency/v1';
  f.db.prepare('UPDATE source_consistency_attempts SET record_json=? WHERE id=?').run(JSON.stringify(attempt),attempt.id);
  const raw={type:'json_object',assets:f.context().referenceAssets.map(a=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Teal','Cream'],appearance:['Frog-shaped'],claims:[]}))};
  recordInvalidAiOutput(f.directory,{call,operation:'source-image-consistency',createdAt:new Date(Date.parse(call.finishedAt!)+1).toISOString(),rejectionStage:'operation-output-validation',output:raw});
  const view=await f.ai.prepareSourceConsistency({productId:f.p.id,productRevision:f.store.getProduct(f.p.id).revision,variantId:f.p.variants[0].id});
  assert.equal(view.status,'MATCH');assert.deepEqual(view.observations!.assets[0].colors,['Teal','Cream']);assert.equal(f.count(),1);
  assert.deepEqual(f.ai.listCalls()[0],call);assert.deepEqual(f.ai.getUsageSummary('deepseek'),usage);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ai_results').get()!.n,0);
  assert.equal(assertConsistencyHistory(f.db,f.directory).length,1);
  const backup=join(f.directory,'recovered.htcbackup');await createWorkspaceBackup(f.directory,backup,'synthetic-recovery-backup');
  await prepareWorkspaceRestore(f.directory,backup,'synthetic-recovery-backup');
  await f.ai.close();const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies);
  try{assert.equal(restarted.getSourceConsistency({productId:f.p.id,productRevision:f.store.getProduct(f.p.id).revision,variantId:f.p.variants[0].id}).status,'MATCH');}finally{await restarted.close();}
});

test('v1 successful uncertain history remains intact while current use merges its observations locally',async t=>{
  const f=await fixture(t),p=f.store.getProduct(f.p.id);f.store.saveProduct({...saveInput(p),variants:saveInput(p).variants.map(v=>({...v,originalSpec:'XZ-190',normalizedSpec:'XZ-190'}))});
  const result=await f.observe();assert.ok(!('recovered' in result));
  const old=JSON.parse(String(f.db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json));
  old.sourceConsistencyContext.version='source-image-consistency/v1';delete old.output.version;
  const {listingFingerprint}=await import('../src/main/listing-ai/validation.ts');old.sourceSha256=listingFingerprint(old.sourceConsistencyContext);
  f.db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(old),old.id);
  const call=f.ai.listCalls()[0];call.sourceConsistencyContext!.version='source-image-consistency/v1';f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);
  const attempt=JSON.parse(String(f.db.prepare('SELECT record_json FROM source_consistency_attempts').get()!.record_json));attempt.context.version='source-image-consistency/v1';f.db.prepare('UPDATE source_consistency_attempts SET record_json=? WHERE id=?').run(JSON.stringify(attempt),attempt.id);
  f.db.exec('DELETE FROM source_consistency_assessments');
  const {recordConsistencyAssessment}=await import('../src/main/source-image-consistency/history.ts');recordConsistencyAssessment(f.db,old);
  const prior=String(f.db.prepare('SELECT record_json FROM source_consistency_assessments').get()!.record_json);assert.equal(JSON.parse(prior).decision,'UNCERTAIN');assertConsistencyHistory(f.db,f.directory);
  assert.equal(readConsistencyView(f.db,f.context()).status,'MATCH');assert.equal(f.ai.sourceObservationEvidence(f.context()).images[0].colors[0],'Blue');
  assert.equal(String(f.db.prepare('SELECT record_json FROM source_consistency_assessments').get()!.record_json),prior);assert.equal(f.count(),1);
});

test('prepare retries only missing source response, preserves immutable paid history and product, survives backup/restart',async t=>{
  const f=await fixture(t),before=f.store.getProduct(f.p.id);
  f.respond(()=>chat({bad:true}));await assert.rejects(f.observe());
  const {readdirSync,unlinkSync,existsSync}=await import('node:fs');
  for(const name of (existsSync(join(f.directory,'ai-diagnostics'))?readdirSync(join(f.directory,'ai-diagnostics')):[]))unlinkSync(join(f.directory,'ai-diagnostics',name));
  const old=f.ai.listCalls()[0],oldAttempt=String(f.db.prepare('SELECT record_json FROM source_consistency_attempts').get()!.record_json);
  f.respond(p=>chat({kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:[]}))}));
  const input={productId:f.p.id,productRevision:before.revision,variantId:f.p.variants[0].id};
  assert.equal((await f.ai.prepareSourceConsistency(input)).status,'MATCH');assert.equal(f.count(),2);
  assert.deepEqual(f.ai.listCalls().find(c=>c.id===old.id),old);assert.equal(String(f.db.prepare('SELECT record_json FROM source_consistency_attempts WHERE id=?').get(consistencyScopeKey(f.context()))!.record_json),oldAttempt);
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,2);assert.equal(f.ai.getUsageSummary('deepseek').attempts,2);assert.deepEqual(f.store.getProduct(f.p.id),before);
  assertConsistencyHistory(f.db,f.directory);const backup=join(f.directory,'retry.htcbackup');await createWorkspaceBackup(f.directory,backup,'synthetic-retry-backup');const snapshot=await prepareWorkspaceRestore(f.directory,backup,'synthetic-retry-backup');
  await f.ai.close();await f.hosting.close();f.closeStorage();await commitWorkspaceRestore(f.directory,snapshot);
  const restoredStore=new WorkspaceStore(f.directory),restoredDb=openDatabase(f.directory),restoredHosting=new HostingService(f.directory,restoredStore,mockStorage),restarted=new AiService(f.directory,restoredStore,restoredHosting,mockStorage,f.dependencies);
  try{assert.equal((await restarted.prepareSourceConsistency(input)).status,'MATCH');assert.equal(f.count(),2);assert.equal(restoredDb.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,2);assert.deepEqual(restarted.listCalls().find(c=>c.id===old.id),old);}finally{await restarted.close();await restoredHosting.close();restoredDb.close();restoredStore.close();}
});

test('missing responses consume at most three durable source attempts across repeated preparation',async t=>{
  const f=await fixture(t);f.respond(()=>chat({bad:true}));const {readdirSync,unlinkSync,existsSync}=await import('node:fs');
  for(let i=0;i<6;i++){
    await assert.rejects(f.ai.prepareSourceConsistency({productId:f.p.id,productRevision:f.store.getProduct(f.p.id).revision,variantId:f.p.variants[0].id}));
    for(const name of (existsSync(join(f.directory,'ai-diagnostics'))?readdirSync(join(f.directory,'ai-diagnostics')):[]))unlinkSync(join(f.directory,'ai-diagnostics',name));
  }
  assert.equal(f.count(),3);assert.equal(f.ai.getUsageSummary('deepseek').attempts,3);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,3);assertConsistencyHistory(f.db,f.directory);
});


test('source invalid JSON retains full useful response and fixed reason without another paid preparation',async t=>{
  const f=await fixture(t),raw='{"assets":['+' '.repeat(210000);
  f.respond(()=>new Response(JSON.stringify({id:'source-invalid-json',usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150},choices:[{finish_reason:'stop',message:{content:raw}}]})));
  await assert.rejects(f.observe());const {readdirSync,readFileSync}=await import('node:fs');
  const files=readdirSync(join(f.directory,'ai-diagnostics')),saved=JSON.parse(readFileSync(join(f.directory,'ai-diagnostics',files[0]),'utf8'));
  assert.equal(saved.output,raw);assert.equal(saved.rejectionReason,'RESPONSE_JSON_INVALID');
  await assert.rejects(f.ai.prepareSourceConsistency({productId:f.p.id,productRevision:f.store.getProduct(f.p.id).revision,variantId:f.p.variants[0].id}));assert.equal(f.count(),1);
});

test('retention never evicts a saved source response while pruning disposable diagnostics',async t=>{
  const f=await fixture(t);f.respond(()=>chat({bad:true}));await assert.rejects(f.observe());
  const {readdirSync,readFileSync,writeFileSync,truncateSync,existsSync}=await import('node:fs');
  const folder=join(f.directory,'ai-diagnostics'),source=readdirSync(folder)[0];
  const disposable=join(folder,'20990101000000000-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json');writeFileSync(disposable,'');truncateSync(disposable,129*1024*1024);
  recordInvalidAiOutput(f.directory,{call:{...f.ai.listCalls()[0],id:randomUUID()},operation:'image-plan',createdAt:'2099-01-02T00:00:00.000Z',rejectionStage:'operation-output-validation',output:{bad:true}});
  assert.ok(existsSync(join(folder,source)));assert.deepEqual(JSON.parse(readFileSync(join(folder,source),'utf8')).output,{bad:true});assert.equal(existsSync(disposable),false);
});

test('concurrent missing-response preparation sends only one replacement and retains both attempts',async t=>{
  const f=await fixture(t);f.respond(()=>chat({bad:true}));await assert.rejects(f.observe());
  const {readdirSync,unlinkSync}=await import('node:fs');for(const n of readdirSync(join(f.directory,'ai-diagnostics')))unlinkSync(join(f.directory,'ai-diagnostics',n));
  f.respond(p=>chat({kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:[],claims:[]}))}));
  const other=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies),input={productId:f.p.id,productRevision:f.store.getProduct(f.p.id).revision,variantId:f.p.variants[0].id};
  try{const results=await Promise.allSettled([f.ai.prepareSourceConsistency(input),other.prepareSourceConsistency(input)]);assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(f.count(),2);assert.equal(f.ai.getUsageSummary('deepseek').attempts,2);}finally{await other.close();}
});

test('source diagnostic rejects unicode-escaped credential echoes before retaining raw content',async t=>{
  const {readdirSync,readFileSync}=await import('node:fs');
  for(const malformed of [false,true]){
    const f=await fixture(t),escaped='\\u0063onsistency-synthetic-key',raw='{"note":"'+escaped+'"'+(malformed?'':'}');
    f.respond(()=>new Response(JSON.stringify({id:'synthetic-escaped',usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150},choices:[{finish_reason:'stop',message:{content:raw}}]})));
    await assert.rejects(f.observe());
    const saved=readdirSync(join(f.directory,'ai-diagnostics')).map(n=>JSON.parse(readFileSync(join(f.directory,'ai-diagnostics',n),'utf8')));
    assert.ok(saved.length);for(const record of saved){assert.equal(JSON.stringify(record).includes('onsistency-synthetic-key'),false);}
    await assert.rejects(f.ai.prepareSourceConsistency({productId:f.p.id,productRevision:f.store.getProduct(f.p.id).revision,variantId:f.p.variants[0].id}));assert.equal(f.count(),1);
  }
});

test('source malformed HTTP 200 envelope retains safe text and never becomes a missing-response retry',async t=>{
  const {readdirSync,readFileSync}=await import('node:fs');
  for(const raw of ['{"choices":[', '{"note":"\\u0063onsistency-synthetic-key"']){
    const f=await fixture(t);f.respond(()=>new Response(raw));await assert.rejects(f.observe());
    const saved=readdirSync(join(f.directory,'ai-diagnostics')).map(n=>JSON.parse(readFileSync(join(f.directory,'ai-diagnostics',n),'utf8')));
    assert.equal(saved.length,1);assert.equal(saved[0].rejectionReason,'RESPONSE_ENVELOPE_JSON_INVALID');assert.equal(JSON.stringify(saved).includes('onsistency-synthetic-key'),false);
    if(raw==='{"choices":[')assert.equal(saved[0].output,raw);
    await assert.rejects(f.ai.prepareSourceConsistency({productId:f.p.id,productRevision:f.store.getProduct(f.p.id).revision,variantId:f.p.variants[0].id}));assert.equal(f.count(),1);
  }
});

test('unknown source owner never resends and never resets history',async t=>{
 const f=await fixture(t);f.respond(()=>{throw Error('synthetic unavailable');});const input={productId:f.p.id,productRevision:f.p.revision,variantId:f.p.variants[0].id};
 for(let n=0;n<5;n++)await assert.rejects(f.ai.prepareSourceConsistency(input));
 assert.equal(f.count(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,1);assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);
 await createWorkspaceBackup(f.directory,join(f.directory,'source-retry.htcbackup'),'synthetic source retry backup');
});

test('unknown source call with corrupt ownership stops without another paid reservation',async t=>{
 const f=await fixture(t);f.respond(()=>{throw Error('synthetic unavailable');});await assert.rejects(f.observe());
 const row=f.db.prepare('SELECT record_json FROM ai_calls').get()!,call=JSON.parse(String(row.record_json));call.productRevision++;f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);
 await assert.rejects(f.observe());assert.equal(f.count(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,1);
});

import { taskAiContext } from '../src/main/ai/batch/task-context.ts';
import { sourceConsistencyUnknown } from '../src/main/source-image-consistency/proof.ts';
function explicitlyContinue<T>(f:{p:{id:string;variants:{id:string}[]}},action:()=>T):T{return taskAiContext.run({taskId:randomUUID(),rowKey:f.p.id+':'+f.p.variants[0].id,phase:'sources',mode:'immediate',explicitContinueAt:new Date().toISOString(),authorize:()=>true},action);}
test('confirmed auth rejection requires refreshed credentials and explicit continue; keeps original budget',async t=>{
 const f=await fixture(t);f.respond(()=>Response.json({error:{message:'synthetic rejected'}},{status:401}));
 await assert.rejects(f.observe());const original=f.ai.listCalls()[0];
 assert.equal(original.errorCode,'AUTH_FAILED');assert.equal(sourceConsistencyUnknown(f.db,f.p.id,[f.p.variants[0].id]),false);
 await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),1);
 f.ai.saveFunctionSettings({id:'deepseek',model:'deepseek-v4-pro',enabled:true});
 await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),1);
 f.ai.saveConnection({id:'deepseek',apiKey:'new-synthetic-key'});
 await assert.rejects(f.observe());assert.equal(f.count(),1);
 await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);
 f.ai.saveConnection({id:'deepseek',apiKey:'third-synthetic-key'});await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),3);
 f.ai.saveConnection({id:'deepseek',apiKey:'fourth-synthetic-key'});await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),3);
 assert.deepEqual(f.ai.listCalls().find(c=>c.id===original.id),original);
});
test('unknown source transport never resends after changed credentials and explicit continuation',async t=>{
 const f=await fixture(t);f.respond(()=>{throw new TypeError('synthetic unknown');});await assert.rejects(f.observe());
 f.ai.saveConnection({id:'deepseek',apiKey:'rotated-unknown-synthetic'});
 await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),1);
 assert.equal(sourceConsistencyUnknown(f.db,f.p.id,[f.p.variants[0].id]),true);
});

test('403 retry survives restart and requires a continuation after the credential update',async t=>{
 const f=await fixture(t);f.respond(()=>Response.json({error:{message:'synthetic forbidden'}},{status:403}));await assert.rejects(f.observe());
 assert.equal(readConsistencyView(f.db,f.context()).status,'SYSTEM_REPAIR');assert.deepEqual(readConsistencyView(f.db,f.context()).reasons,['SOURCE_CONSISTENCY_AUTH_FAILED']);
 const oldScope={taskId:randomUUID(),rowKey:f.p.id+':'+f.p.variants[0].id,phase:'sources',mode:'immediate' as const,explicitContinueAt:'2020-01-01T00:00:00Z',authorize:()=>true};
 f.ai.saveConnection({id:'deepseek',apiKey:'restart-rotated-synthetic'});
 await assert.rejects(taskAiContext.run(oldScope,()=>f.observe()));assert.equal(f.count(),1);
 await f.ai.close();const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies);
 try{await assert.rejects(restarted.observeSourceConsistency(f.context(),()=>{}));assert.equal(f.count(),1);await assert.rejects(explicitlyContinue(f,()=>restarted.observeSourceConsistency(f.context(),()=>{})));assert.equal(f.count(),2);}finally{await restarted.close();}
});
test('saving the same credential or bare AUTH_FAILED without HTTP refusal cannot unlock source attempts',async t=>{
 const f=await fixture(t);f.respond(()=>Response.json({error:{message:'synthetic denied'}},{status:401}));await assert.rejects(f.observe());
 f.ai.saveConnection({id:'deepseek',apiKey:'consistency-synthetic-key'});await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),1);
 f.db.prepare('DELETE FROM ai_provider_receipts').run();
 f.ai.saveConnection({id:'deepseek',apiKey:'different-synthetic-key'});await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),1);assert.equal(sourceConsistencyUnknown(f.db,f.p.id,[f.p.variants[0].id]),true);
});
test('timeout interrupted and cancelled source records remain unknown after restart and explicit continuation',async t=>{
 for(const code of ['TIMEOUT','INTERRUPTED','CANCELLED','PROVIDER_ERROR'] as const){
 const f=await fixture(t);f.respond(()=>{throw new TypeError('synthetic response lost');});await assert.rejects(f.observe());
 const call=f.ai.listCalls()[0];call.errorCode=code;f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);
 f.ai.saveConnection({id:'deepseek',apiKey:'unknown-new-synthetic'});await f.ai.close();const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies);
 try{await assert.rejects(explicitlyContinue(f,()=>restarted.observeSourceConsistency(f.context(),()=>{})));assert.equal(f.count(),1);assert.equal(sourceConsistencyUnknown(f.db,f.p.id,[f.p.variants[0].id]),true);}finally{await restarted.close();}
 }
});

test('actual OpenRouter source request with reference port resumes a stale immediate task scope',async t=>{
 const f=await fixture(t);await f.ai.close();
 const ai=new AiService(f.directory,f.store,f.hosting,mockStorage,{...f.dependencies,batchReferences:{prepare:async()=>{throw Error('Immediate mode must not pin Batch references');},validate:()=>true}});
 try{
 ai.saveConnection({id:'openrouter',apiKey:'old-openrouter-synthetic'});ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});
 const purpose=ai.getPurposeProfiles().find(p=>p.purposeId==='source_understanding')!;ai.savePurposeProfile({purposeId:purpose.purposeId,expectedRevision:purpose.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 const plan=ai.taskBatchPlan();ai.saveConnection({id:'openrouter',apiKey:'new-openrouter-synthetic'});
 const result=await taskAiContext.run({taskId:randomUUID(),rowKey:f.p.id+':'+f.p.variants[0].id,phase:'sources',mode:'immediate',credentialScope:plan.credentialScope,purposes:plan.purposes,explicitContinueAt:new Date().toISOString(),authorize:()=>true},()=>ai.observeSourceConsistency(f.context(),()=>{}));
 assert.equal(result.output.kind,'source-image-consistency');assert.equal(f.count(),1);assert.equal(ai.listCalls().length,1);
 }finally{await ai.close();}
});

test('legacy saved-connection audit supports denied source recovery without altering old calls',async t=>{
 const f=await fixture(t);f.respond(()=>Response.json({error:{message:'synthetic old denial'}},{status:401}));await assert.rejects(f.observe());const original=f.ai.listCalls()[0];
 f.ai.saveConnection({id:'deepseek',apiKey:'legacy-new-synthetic'});
 const profile=f.ai.listProfiles().find(p=>p.id==='deepseek')!;
 f.db.prepare("DELETE FROM audit_events WHERE action='ai.credentials.updated'").run();
 f.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),null,'ai.connection.saved','Synthetic legacy credential save',JSON.stringify({vendorId:'deepseek',profiles:[{id:profile.id,generation:profile.generation}]}),new Date().toISOString());
 f.respond(p=>chat({kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:[]}))}));
 await explicitlyContinue(f,()=>f.observe());assert.equal(f.count(),2);assert.equal(readConsistencyView(f.db,f.context()).status,'MATCH');assert.deepEqual(f.ai.listCalls().find(c=>c.id===original.id),original);
});

for(const kind of ['empty','missing','broken-stream'] as const)test(`source HTTP 200 ${kind} body stays UNKNOWN and never resends`,async t=>{
 const f=await fixture(t);f.respond(()=>kind==='empty'?new Response('',{status:200}):kind==='missing'?new Response(null,{status:200}):new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"choices":'));controller.error(new Error('synthetic interrupted body'));}}),{status:200}));
 await assert.rejects(f.observe());const call=f.ai.listCalls()[0];assert.equal(call.errorCode,'OUTPUT_INVALID');assert.equal(call.responseReceived,undefined);
 assert.equal(sourceConsistencyUnknown(f.db,f.p.id,[f.p.variants[0].id]),true);assert.equal(readConsistencyView(f.db,f.context()).status,'UNKNOWN');
 f.ai.saveConnection({id:'deepseek',apiKey:'body-new-synthetic'});assert.throws(()=>explicitlyContinue(f,()=>reserveConsistencyAttempt(f.db,f.context(),{id:randomUUID(),startedAt:new Date().toISOString(),providerId:'deepseek',generation:f.ai.listProfiles().find(p=>p.id==='deepseek')!.generation})));await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),1);
 assert.deepEqual(f.ai.listCalls()[0],call);
});

test('older unknown source attempt cannot be hidden by a later explicit auth denial',async t=>{
 const f=await fixture(t);f.respond(()=>Response.json({error:{message:'synthetic denial'}},{status:401}));await assert.rejects(f.observe());
 const old=f.ai.listCalls()[0];f.ai.saveConnection({id:'deepseek',apiKey:'second-old-synthetic'});await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);
 // The old version allowed this second send. Preserve that historical shape without issuing it again.
 const unknown={...old,errorCode:'NETWORK_ERROR'};delete unknown.providerReceiptId;
 f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(unknown),old.id);
 const attempts=f.db.prepare('SELECT id,record_json FROM source_consistency_attempts ORDER BY id').all();
 assertConsistencyHistory(f.db,f.directory);assert.equal(sourceConsistencyUnknown(f.db,f.p.id,[f.p.variants[0].id]),true);
 f.ai.saveConnection({id:'deepseek',apiKey:'third-blocked-synthetic'});assert.throws(()=>explicitlyContinue(f,()=>reserveConsistencyAttempt(f.db,f.context(),{id:randomUUID(),startedAt:new Date().toISOString(),providerId:'deepseek',generation:f.ai.listProfiles().find(p=>p.id==='deepseek')!.generation})));await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);
 assert.deepEqual(f.db.prepare('SELECT id,record_json FROM source_consistency_attempts ORDER BY id').all(),attempts);
});

test('legacy valid retained source content recovers locally without responseReceived or another send',async t=>{
 const f=await fixture(t);f.respond(()=>chat({bad:true}));await assert.rejects(f.observe());const call=f.ai.listCalls()[0];delete call.responseReceived;
 f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);
 assert.equal(sourceConsistencyUnknown(f.db,f.p.id,[f.p.variants[0].id]),true);
 const raw={kind:'source-image-consistency',assets:f.context().referenceAssets.map(a=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:[]}))};
 recordInvalidAiOutput(f.directory,{call,operation:'source-image-consistency',createdAt:new Date(Date.parse(call.finishedAt!)+1).toISOString(),rejectionStage:'operation-output-validation',output:raw});
 const result=await f.observe();assert.equal(result.output.kind,'source-image-consistency');assert.equal(f.count(),1);assert.equal(sourceConsistencyUnknown(f.db,f.p.id,[f.p.variants[0].id]),false);
 assert.deepEqual(f.ai.listCalls()[0],call);assert.equal(readConsistencyView(f.db,f.context()).status,'MATCH');
});


test('legacy OpenRouter region refusal resumes once only after explicit continue without rotating Key',async t=>{
 const f=await fixture(t);f.ai.saveConnection({id:'openrouter',apiKey:'synthetic-router-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});const purpose=f.ai.getPurposeProfiles().find(p=>p.purposeId==='source_understanding')!;f.ai.savePurposeProfile({purposeId:purpose.purposeId,expectedRevision:purpose.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'none'}});
 f.respond(()=>Response.json({error:{message:'This model is not available in your region.',code:403}},{status:403}));await assert.rejects(f.observe());
 const prior=f.ai.listCalls()[0];f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...prior,errorCode:'AUTH_FAILED'}),prior.id);
 await assert.rejects(f.observe());assert.equal(f.count(),1);
 await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);
 await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);
 assert.equal(f.ai.listCalls().find(c=>c.id===prior.id)?.errorCode,'AUTH_FAILED');
});


test('legacy forbidden uses matching403 proof while missing receipts never unlock source sends',async t=>{
 for(const missing of [false,true]){
  const f=await fixture(t);f.ai.saveConnection({id:'openrouter',apiKey:'synthetic-router-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});const purpose=f.ai.getPurposeProfiles().find(p=>p.purposeId==='source_understanding')!;f.ai.savePurposeProfile({purposeId:purpose.purposeId,expectedRevision:purpose.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'none'}});
  f.respond(()=>Response.json({error:{message:missing?'This model is not available in your region.':'Forbidden',code:403}},{status:403}));await assert.rejects(f.observe());
  const prior=f.ai.listCalls()[0];f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...prior,errorCode:'AUTH_FAILED',...(missing?{providerReceiptId:undefined}:{})}),prior.id);
  assert.equal(readConsistencyView(f.db,f.context()).status,missing?'UNKNOWN':'SYSTEM_REPAIR');
  f.ai.saveConnection({id:'openrouter',apiKey:'synthetic-rotated-router-key'});await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),missing?1:2);
 }
});

for(const message of ['This model is not available in your region.','Forbidden'])test(`confirmed403 ${message} manually resumes once without new credentials and remains blocked after restart`,async t=>{
 const f=await fixture(t);f.ai.saveConnection({id:'openrouter',apiKey:'synthetic-router-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});const purpose=f.ai.getPurposeProfiles().find(p=>p.purposeId==='source_understanding')!;f.ai.savePurposeProfile({purposeId:purpose.purposeId,expectedRevision:purpose.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'none'}});
 f.respond(()=>Response.json({error:{message,code:403}},{status:403}));await assert.rejects(f.observe());const before=f.ai.listCalls()[0];
 await assert.rejects(f.observe());assert.equal(f.count(),1);
 await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);
 await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);
 await f.ai.close();const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies);
 try{await assert.rejects(explicitlyContinue(f,()=>restarted.observeSourceConsistency(f.context(),()=>{})));assert.equal(f.count(),2);}finally{await restarted.close();}
 assert.deepEqual(JSON.parse(String(f.db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(before.id)!.record_json)),before);
});

async function routerForbiddenFixture(t:test.TestContext){
 const f=await fixture(t);f.ai.saveConnection({id:'openrouter',apiKey:'synthetic-router-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});const purpose=f.ai.getPurposeProfiles().find(p=>p.purposeId==='source_understanding')!;f.ai.savePurposeProfile({purposeId:purpose.purposeId,expectedRevision:purpose.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'none'}});
 f.respond(()=>Response.json({error:{message:'This model is not available in your region.',code:403}},{status:403}));await assert.rejects(f.observe());await new Promise(resolve=>setTimeout(resolve,5));return f;
}
test('confirmed403 retry respects quota, concurrent continuation reserves exactly once and historical raw remains immutable',async t=>{
 const f=await routerForbiddenFixture(t),before=f.ai.listCalls()[0];f.ai.setUsagePolicy({providerId:'openrouter',dailyCallLimit:1,dailyTokenLimit:null});
 await assert.rejects(explicitlyContinue(f,()=>f.observe()),/额度/);assert.equal(f.count(),1);assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='ai.forbidden.manual-retry'").get()!.n,0);
 f.ai.setUsagePolicy({providerId:'openrouter',dailyCallLimit:3,dailyTokenLimit:null});const other=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies);
 try{await Promise.allSettled([explicitlyContinue(f,()=>f.observe()),explicitlyContinue(f,()=>other.observeSourceConsistency(f.context(),()=>{}))]);assert.equal(f.count(),2);assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='ai.forbidden.manual-retry'").get()!.n,1);}finally{await other.close();}
 assert.deepEqual(f.ai.listCalls().find(c=>c.id===before.id),before);
});
for(const damage of ['missing','body','metadata','unknown'])test(`confirmed403 ${damage} cannot authorize a new source send`,async t=>{
 const f=await routerForbiddenFixture(t),call=f.ai.listCalls()[0];
 if(damage==='missing')f.db.prepare('DELETE FROM ai_provider_receipts WHERE id=?').run(call.providerReceiptId!);
 if(damage==='body'){const r=JSON.parse(String(f.db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(call.providerReceiptId!)!.record_json));writeFileSync(join(f.directory,r.relativePath),'{}');}
 if(damage==='metadata'){const r=JSON.parse(String(f.db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(call.providerReceiptId!)!.record_json));r.model='openai/gpt-6-astra';f.db.prepare('UPDATE ai_provider_receipts SET record_json=? WHERE id=?').run(JSON.stringify(r),r.id);}
 if(damage==='unknown'){f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...call,errorCode:'NETWORK_ERROR'}),call.id);}
 await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),1);assert.equal(sourceConsistencyUnknown(f.db,f.p.id,[f.p.variants[0].id]),true);
});
test('confirmed403 success resumes existing source locally without repeating result',async t=>{
 const f=await routerForbiddenFixture(t),before=f.store.getProduct(f.p.id);f.respond(p=>chat({kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:p.claims.map((c:any)=>({claimId:c.id,value:c.axis==='color'?'Blue':'Round',visibility:'visible'}))}))}));
 const result=await explicitlyContinue(f,()=>f.observe());assert.equal(f.count(),2);assert.equal(readConsistencyView(f.db,f.context()).status,'MATCH');assert.equal((await f.observe()).id,result.id);assert.equal(f.count(),2);assert.deepEqual(f.store.getProduct(f.p.id),before);
});
test('confirmed403 retry claim survives restoring older encrypted backup and cannot grant another retry',async t=>{
 const f=await routerForbiddenFixture(t),file=join(f.directory,'before-retry.htcbackup'),pass='synthetic-forbidden-backup';await createWorkspaceBackup(f.directory,file,pass);
 await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);const claim=f.db.prepare("SELECT detail_json FROM audit_events WHERE action='ai.forbidden.manual-retry'").get()!;
 const snapshot=await prepareWorkspaceRestore(f.directory,file,pass);await f.ai.close();await f.hosting.close();f.closeStorage();await commitWorkspaceRestore(f.directory,snapshot);
 const store=new WorkspaceStore(f.directory),db=openDatabase(f.directory),hosting=new HostingService(f.directory,store,mockStorage),ai=new AiService(f.directory,store,hosting,mockStorage,f.dependencies);
 try{assert.equal(db.prepare("SELECT detail_json FROM audit_events WHERE action='ai.forbidden.manual-retry'").get()!.detail_json,claim.detail_json);ai.saveConnection({id:'openrouter',apiKey:'restored-synthetic-key'});await assert.rejects(explicitlyContinue(f,()=>ai.observeSourceConsistency(ai.sourceConsistencyContext({productId:f.p.id,productRevision:store.getProduct(f.p.id).revision,variantId:f.p.variants[0].id}),()=>{})));assert.equal(f.count(),2);}finally{await ai.close();await hosting.close();db.close();store.close();}
});

test('confirmed403 reservation failure rolls back claim, call and usage together before any send',async t=>{
 const f=await routerForbiddenFixture(t),before=f.ai.getUsageSummary('openrouter');
 f.db.exec("CREATE TRIGGER synthetic_retry_reservation_failure BEFORE INSERT ON source_consistency_attempts BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END");
 await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),1);assert.equal(f.ai.listCalls().length,1);assert.deepEqual(f.ai.getUsageSummary('openrouter'),before);assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='ai.forbidden.manual-retry'").get()!.n,0);
 f.db.exec('DROP TRIGGER synthetic_retry_reservation_failure');await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);
});
test('confirmed403 claimed retry with lost response stays UNKNOWN and cannot send after another continue',async t=>{
 const f=await routerForbiddenFixture(t);f.respond(()=>{throw new TypeError('synthetic connection lost after reservation');});await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);assert.equal(sourceConsistencyUnknown(f.db,f.p.id,[f.p.variants[0].id]),true);
 await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(explicitlyContinue(f,()=>f.observe()));assert.equal(f.count(),2);assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='ai.forbidden.manual-retry'").get()!.n,1);
});
test('confirmed403 after original source limit is exhausted clearly blocks without a new allowance',async t=>{
 const f=await fixture(t);f.ai.saveConnection({id:'openrouter',apiKey:'synthetic-router-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});const purpose=f.ai.getPurposeProfiles().find(p=>p.purposeId==='source_understanding')!;f.ai.savePurposeProfile({purposeId:purpose.purposeId,expectedRevision:purpose.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'none'}});
 f.respond(()=>Response.json({error:{message:'Unauthorized',code:401}},{status:401}));await assert.rejects(f.observe());
 for(const key of ['second-synthetic','third-synthetic']){f.ai.saveConnection({id:'openrouter',apiKey:key});if(key==='third-synthetic')f.respond(()=>Response.json({error:{message:'Forbidden',code:403}},{status:403}));await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(explicitlyContinue(f,()=>f.observe()));}
 assert.equal(f.count(),3);await assert.rejects(explicitlyContinue(f,()=>f.observe()),/原重试次数已耗尽/);assert.equal(f.count(),3);assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='ai.forbidden.manual-retry'").get()!.n,0);
});
test('confirmed403 repeated manual click reports consumed opportunity without inserting a new failure',async t=>{
 const f=await routerForbiddenFixture(t);await assert.rejects(explicitlyContinue(f,()=>f.observe()));const calls=f.ai.listCalls();await new Promise(resolve=>setTimeout(resolve,5));await assert.rejects(explicitlyContinue(f,()=>f.observe()),/已使用一次手动403重试.*本次未发送新请求/);assert.deepEqual(f.ai.listCalls(),calls);assert.equal(f.count(),2);
});

test('confirmed403 old failure cannot acquire another claim through a different scope',async t=>{
 const f=await routerForbiddenFixture(t),old=f.ai.listCalls()[0];await assert.rejects(explicitlyContinue(f,()=>f.observe()));
 assert.equal(explicitlyContinue(f,()=>canRetryConfirmedForbidden(f.db,old,'alternative-scope:'+randomUUID())),false);assert.equal(f.count(),2);
});
