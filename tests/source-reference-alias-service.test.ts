import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consistencyFixture } from './helpers/source-consistency.ts';
import { mockStorage, saveInput } from './fixtures/listing-ai.ts';
import { slowHttp } from './fixtures/stabilization/slow-http.ts';
import { AiService } from '../src/main/ai/service.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { inheritLegacyPurposeSettings } from '../src/main/ai/purpose-routing.ts';
import { readCallReceiptSync } from '../src/main/ai/receipts.ts';
import { assertConsistencyHistory } from '../src/main/source-image-consistency/history.ts';
import { SOURCE_REFERENCE_PROTOCOL } from '../src/shared/source-reference-alias-contracts.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';

const output=(ids:string[])=>({kind:'source-image-consistency',version:'source-image-consistency/v2',assets:ids.map(assetId=>({assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:[],claims:[]}))});
const envelope=(value:unknown)=>JSON.stringify({id:'alias-fixture',model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,cost:0.001}});
async function fixture(t:test.TestContext,options:{ids?:string[];multiple?:boolean;unknown?:boolean;openrouter?:boolean}={}){
  const f=consistencyFixture(t);
  if(options.multiple){const original=f.store.getAssetRecord(f.p.assets[0].id)!,bytes=readFileSync(join(f.directory,original.originalPath)),id=randomUUID();bytes[32]=1;writeFileSync(join(f.directory,`assets/${id}.png`),bytes);let p=f.store.getProduct(f.p.id);p=f.store.addAssets({productId:p.id,revision:p.revision},[{id,fileName:'second.png',mimeType:'image/png',width:256,height:256,byteSize:bytes.length,originalPath:`assets/${id}.png`,previewPath:`assets/${id}.png`,sha256:createHash('sha256').update(bytes).digest('hex')}]);f.store.updateAsset({productId:p.id,revision:p.revision,assetId:id,role:'gallery',variantIds:[p.variants[0].id]});}
  const raw=output(options.ids??f.context().referenceAssets.map((_,i)=>`ref_${i+1}`)),literal=envelope(raw),http=await slowHttp({body:literal}),hosting=new HostingService(f.directory,f.store,mockStorage);let wire:any,ai:AiService;
  const dependencies={fetch:async(url:any,init?:RequestInit)=>{assert.equal(String(url),options.openrouter?'https://openrouter.ai/api/v1/chat/completions':'https://api.deepseek.com/chat/completions');wire=JSON.parse(String(init?.body));const calls=ai.listCalls();assert.equal(calls.length,1);assert.equal(calls[0].sourceReferenceProtocol,SOURCE_REFERENCE_PROTOCOL);assert.equal(row(f.db,'ai_usage_ledger').length,1);assert.equal(row(f.db,'source_consistency_attempts').length,1);if(options.unknown)throw new TypeError('synthetic sent response missing');return fetch(http.url,init);}};
  ai=new AiService(f.directory,f.store,hosting,mockStorage,dependencies);ai.saveConnection({id:'deepseek',apiKey:'alias-synthetic-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});inheritLegacyPurposeSettings(f.db,'deepseek','deepseek-flash',false);
  if(options.openrouter){ai.saveConnection({id:'openrouter',apiKey:'alias-router-key'});ai.setEnabled({id:'openrouter',enabled:true});const p=ai.getPurposeProfiles().find(p=>p.purposeId==='source_understanding')!;ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6.1-sol',effort:'high'}});}
  f.cleanup.push(async()=>{await ai.close();await hosting.close();await http.close();});
  return {...f,ai,hosting,http,raw,literal,dependencies,wire:()=>wire,observe:()=>ai.observeSourceConsistency(f.context(),()=>{})};
}
const row=(db:any,table:string)=>db.prepare(`SELECT record_json FROM ${table} ORDER BY rowid`).all().map((r:any)=>String(r.record_json));

test('actual AiService and production adapter send only short refs and keep raw literal, canonical UUIDs and frozen call',async t=>{
  const f=await fixture(t,{multiple:true}),c=f.context(),result=await f.observe();assert.equal(f.http.posts,1);assert.equal(result.output.kind,'source-image-consistency');
  const call=f.ai.getCall(result.callId)!;assert.equal(call.sourceReferenceProtocol,SOURCE_REFERENCE_PROTOCOL);assert.deepEqual(call.sourceReferenceAliases?.entries.map(e=>e.assetId),c.referenceAssets.map(a=>a.assetId));
  const payload=JSON.parse(f.wire().messages[1].content[0].text);assert.deepEqual(payload.referenceAssets.map((a:any)=>a.assetId),['ref_1','ref_2']);for(const ref of c.referenceAssets)assert.equal(JSON.stringify(f.wire()).includes(ref.assetId),false);
  assert.deepEqual((result.output as ReturnType<typeof output>).assets.map(a=>a.assetId),c.referenceAssets.map(a=>a.assetId));assert.ok('sourceSha256' in result);assert.equal(result.sourceSha256,call.sourceReferenceAliases?.contextSha256);
  const saved=readCallReceiptSync(f.db,f.directory,call)!;assert.deepEqual(saved.capture.body,JSON.parse(f.literal));assert.equal(saved.capture.body.choices[0].message.content,JSON.stringify(f.raw));assertConsistencyHistory(f.db,f.directory);
  const before=Object.fromEntries(['ai_calls','ai_results','ai_usage_ledger','source_consistency_attempts','source_consistency_assessments'].map(table=>[table,row(f.db,table)])),changes=f.db.prepare('SELECT total_changes() n').get()!.n;
  for(let i=0;i<100;i++){f.ai.getCall(call.id);f.ai.getSourceConsistency({productId:c.productId,productRevision:c.productRevision,variantId:c.variantId});f.ai.sourceObservationEvidence(c);}
  assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n,changes);for(const [table,value]of Object.entries(before))assert.deepEqual(row(f.db,table),value);assert.equal(f.http.posts,1);
});

test('actual short-ref response survives result-association interruption and disabled-key restart with original call/map/fees, zero new POST',async t=>{
  const f=await fixture(t,{multiple:true});f.db.exec("CREATE TRIGGER alias_result_failure BEFORE INSERT ON ai_results BEGIN SELECT RAISE(ABORT,'synthetic alias result interruption'); END");
  await assert.rejects(f.observe());assert.equal(f.http.posts,1);f.db.exec('DROP TRIGGER alias_result_failure');const call=f.ai.listCalls()[0],before=JSON.stringify(call),usage=row(f.db,'ai_usage_ledger');
  assert.ok(call.providerReceiptId);assert.equal(call.sourceReferenceProtocol,SOURCE_REFERENCE_PROTOCOL);await f.ai.close();
  let p=f.store.getProduct(f.p.id);p=f.store.saveProduct({...saveInput(p),title:'Title edited after original response'});f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets.find(a=>a.role==='gallery')!.id,role:'main',variantIds:[p.variants[0].id]});
  assert.notDeepEqual(f.context().referenceAssets.map(a=>a.assetId),call.sourceReferenceAliases!.entries.map(e=>e.assetId));
  const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,f.dependencies);try{restarted.disconnect('deepseek');restarted.setUsagePolicy({providerId:'deepseek',dailyCallLimit:0,dailyTokenLimit:0});const result=await restarted.observeSourceConsistency(f.context(),()=>{});assert.equal(result.callId,call.id);assert.equal(result.output.kind,'source-image-consistency');assert.deepEqual((result.output as ReturnType<typeof output>).assets.map(a=>a.assetId),call.sourceReferenceAliases!.entries.map(e=>e.assetId));assert.equal(result.sourceConsistencyRequestBytes,undefined);assert.equal(JSON.stringify(restarted.getCall(call.id)),before);assert.deepEqual(row(f.db,'ai_usage_ledger'),usage);assert.equal(f.http.posts,1);assertConsistencyHistory(f.db,f.directory);assert.equal((await restarted.observeSourceConsistency(f.context(),()=>{})).id,result.id);assert.equal(f.http.posts,1);}finally{await restarted.close();}
});

test('unknown call never gains another POST from key/model changes or new aliases, and a lost new map fails closed',async t=>{
  const f=await fixture(t,{unknown:true});await assert.rejects(f.observe());const original=f.ai.listCalls()[0],before=row(f.db,'ai_usage_ledger');f.ai.saveConnection({id:'deepseek',apiKey:'alias-second-key'});await assert.rejects(f.observe());assert.equal(f.ai.listCalls().length,1);assert.deepEqual(row(f.db,'ai_usage_ledger'),before);
  const bad:any=structuredClone(original);delete bad.sourceReferenceAliases;f.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(bad),bad.id);await assert.rejects(f.observe());assert.equal(f.http.posts,0);assert.equal(row(f.db,'ai_calls').length,1);
});

test('encrypted older restore retains original alias call and fees even when its successful result is outside the snapshot',async t=>{
  const f=await fixture(t),file=join(f.directory,'alias-before.htcbackup'),pass='synthetic-alias-backup';await createWorkspaceBackup(f.directory,file,pass);const result=await f.observe(),call=f.ai.getCall(result.callId)!,usage=row(f.db,'ai_usage_ledger');
  const snapshot=await prepareWorkspaceRestore(f.directory,file,pass);await f.ai.close();await f.hosting.close();f.closeStorage();await commitWorkspaceRestore(f.directory,snapshot);
  const store=new WorkspaceStore(f.directory),db=openDatabase(f.directory),hosting=new HostingService(f.directory,store,mockStorage),ai=new AiService(f.directory,store,hosting,mockStorage,f.dependencies);
  try{assert.deepEqual(ai.getCall(call.id),call);assert.deepEqual(row(db,'ai_usage_ledger'),usage);const p=store.getProduct(f.p.id),c=ai.sourceConsistencyContext({productId:p.id,productRevision:p.revision,variantId:p.variants[0].id});await assert.rejects(ai.observeSourceConsistency(c,()=>{}));assert.equal(f.http.posts,1);}finally{await ai.close();await hosting.close();db.close();store.close();}
});

test('actual adapter rejects duplicate, unknown, sparse and canonical UUID responses on new alias calls, without retry POST',async t=>{
  for(const ids of [['ref_1','ref_1'],['ref_1','ref_3'],['ref_1'],['11111111-1111-4111-8111-111111111111','ref_2']]){
    const f=await fixture(t,{multiple:true,ids});await assert.rejects(f.observe());const call=f.ai.listCalls()[0],original=JSON.stringify(call);assert.equal(call.errorCode,'OUTPUT_INVALID');assert.equal(f.http.posts,1);await assert.rejects(f.observe());assert.equal(f.http.posts,1);assert.equal(JSON.stringify(f.ai.getCall(call.id)),original);assert.equal(row(f.db,'ai_results').length,0);
  }
});

test('identical wire refs for independent SKU calls map to their own exact original assets',async t=>{
  const first=await fixture(t),second=await fixture(t);const a=await first.observe(),b=await second.observe();assert.ok('productId' in a&&'productId' in b);assert.notEqual(a.productId,b.productId);assert.notEqual(first.context().variantId,second.context().variantId);
  assert.deepEqual((a.output as ReturnType<typeof output>).assets.map(a=>a.assetId),first.context().referenceAssets.map(a=>a.assetId));assert.deepEqual((b.output as ReturnType<typeof output>).assets.map(a=>a.assetId),second.context().referenceAssets.map(a=>a.assetId));
  const forged=structuredClone(first.ai.getCall(a.callId)!);forged.sourceReferenceAliases=second.ai.getCall(b.callId)!.sourceReferenceAliases;first.db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(forged),forged.id);await assert.rejects(first.observe());assert.equal(first.http.posts,1);assert.equal(second.http.posts,1);
});

test('recovered canonical source result requires the original complete private raw at every read',async t=>{
  const f=await fixture(t);f.db.exec("CREATE TRIGGER alias_read_failure BEFORE INSERT ON ai_results BEGIN SELECT RAISE(ABORT,'synthetic result interruption'); END");await assert.rejects(f.observe());f.db.exec('DROP TRIGGER alias_read_failure');const result=await f.observe(),call=f.ai.getCall(result.callId)!,receipt=readCallReceiptSync(f.db,f.directory,call)!;
  assert.equal(f.ai.getResult(result.id)!.id,result.id);const old=String(f.db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json),forged=JSON.parse(old);forged.output.assets[0].colors=['Red'];f.db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(forged),result.id);
  assert.throws(()=>f.ai.getResult(result.id));assert.throws(()=>assertConsistencyHistory(f.db,f.directory));f.db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(old,result.id);
  const path=join(f.directory,receipt.record.relativePath),bytes=readFileSync(path);writeFileSync(path,Buffer.alloc(bytes.length,32));assert.throws(()=>f.ai.getResult(result.id));await assert.rejects(f.observe());assert.equal(f.http.posts,1);writeFileSync(path,bytes);
  assert.equal(f.ai.getResult(result.id)!.id,result.id);
});

test('source aliases keep the selected model, effective reasoning and injected production network boundary',async t=>{
  const f=await fixture(t,{openrouter:true}),result=await f.observe(),call=f.ai.getCall(result.callId)!;
  assert.equal(f.wire().model,'openai/gpt-6.1-sol');assert.equal(f.wire().reasoning.effort,'high');assert.equal(call.model,'openai/gpt-6.1-sol');assert.equal(call.purposeSnapshot!.purposeId,'source_understanding');assert.equal(call.purposeSnapshot!.effectiveEffort,'high');assert.equal(f.http.posts,1);assert.equal(f.ai.getUsageSummary('openrouter').attempts,1);
});
