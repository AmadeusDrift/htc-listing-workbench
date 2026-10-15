import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,json} from './fixtures/ai-control.ts';

test('category phase reuses successful result and never resends a failed unknown phase',async t=>{
 const f=await fixture(t,{fetch:async()=>json({answers:{category:{type:'choice',choice:'CLEANING_CLOTH'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:1,output_tokens:0}})});
 f.service.saveConnection({id:'openrouter',apiKey:'fixture-only'});f.service.setEnabled({id:'openrouter',enabled:true});
 const input={productId:f.product.id,productRevision:f.product.revision,phase:'select' as const,candidates:[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}]};
 const first=await f.service.decideCategory(input);const second=await f.service.decideCategory(input);
 assert.equal(second.id,first.id);assert.equal(f.requests.length,1);
});
test('unknown category call remains locked on continue and model changes',async t=>{
 const f=await fixture(t,{fetch:async()=>{throw Error('synthetic timeout');}});
 f.service.saveConnection({id:'openrouter',apiKey:'fixture-only'});f.service.setEnabled({id:'openrouter',enabled:true});
 const input={productId:f.product.id,productRevision:f.product.revision,phase:'select' as const,candidates:[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}]};
 await assert.rejects(f.service.decideCategory(input));await assert.rejects(f.service.decideCategory(input));
 assert.equal(f.requests.length,1);
});

import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {retainCategoryRepairs} from '../src/main/ai/category-recovery.ts';
const denied={error:{code:400,message:'state[1] is not a valid "image_url" part: image_url.detail: Invalid option: expected one of "auto"|"low"|"high"'}};
for(const outcome of ['success','timeout','400'] as const)test(`legacy exact400 manually resumes once: ${outcome}`,async t=>{
 const f=await fixture(t,{fetch:async()=>json(denied,400)});
 f.service.saveConnection({id:'openrouter',apiKey:'fixture-only'});f.service.setEnabled({id:'openrouter',enabled:true});
 const input={productId:f.product.id,productRevision:f.product.revision,phase:'select' as const,candidates:[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}]};
 await assert.rejects(f.service.decideCategory(input));
 const prior=f.service.listCalls()[0],db=(f.service as any).db;delete prior.categoryContext;
 db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(prior),prior.id);
 await assert.rejects(f.service.decideCategory(input));assert.equal(f.requests.length,1);
 const scope={taskId:crypto.randomUUID(),rowKey:f.product.id+':'+f.product.variants[0].id,phase:'CATEGORY',mode:'immediate' as const,explicitContinueAt:new Date(Date.parse(prior.finishedAt!)+1000).toISOString(),authorize:()=>true};
 f.respond(async()=>{if(outcome==='timeout')throw Error('timeout');return outcome==='400'?json(denied,400):json({answers:{category:{type:'choice',choice:'CLEANING_CLOTH'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:1,output_tokens:0}});});
 if(outcome==='success'){
  const result=await taskAiContext.run(scope,()=>f.service.decideCategory(input));
  assert.equal((await taskAiContext.run(scope,()=>f.service.decideCategory(input))).id,result.id);
 }else{await assert.rejects(taskAiContext.run(scope,()=>f.service.decideCategory(input)));await assert.rejects(taskAiContext.run(scope,()=>f.service.decideCategory(input)));}
 assert.equal(f.requests.length,2);
 assert.equal(f.service.getCall(prior.id)!.errorCode,'PROVIDER_ERROR');
 const old=await fixture(t);const snapshot=(old.service as any).db;
 retainCategoryRepairs(db,snapshot);retainCategoryRepairs(db,snapshot);
 assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='ai.category.detail-repair'").get().n,1);
});
for(const legacy of [false,true])test(`unknown category no-identity=${legacy} blocks without a send`,async t=>{
 const f=await fixture(t,{fetch:async()=>{throw Error('timeout');}});f.service.saveConnection({id:'openrouter',apiKey:'fixture-only'});f.service.setEnabled({id:'openrouter',enabled:true});
 const input={productId:f.product.id,productRevision:f.product.revision,phase:'select' as const,candidates:[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}]};
 await assert.rejects(f.service.decideCategory(input));const prior=f.service.listCalls()[0];
 if(legacy){delete prior.categoryContext;(f.service as any).db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(prior),prior.id);}
 await assert.rejects(f.service.decideCategory({...input,keywords:['changed']}));assert.equal(f.requests.length,1);
});

import {recoverCategoryPhase} from '../src/main/ai/category-recovery.ts';
test('restoring older snapshot retains unknown category identity even without the original call',async t=>{
 const f=await fixture(t,{fetch:async()=>{throw Error('timeout');}});f.service.saveConnection({id:'openrouter',apiKey:'fixture-only'});f.service.setEnabled({id:'openrouter',enabled:true});
 const input={productId:f.product.id,productRevision:f.product.revision,phase:'select' as const,candidates:[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}]};await assert.rejects(f.service.decideCategory(input));
 const old=await fixture(t),current=(f.service as any).db,snapshot=(old.service as any).db,prior=f.service.listCalls()[0];retainCategoryRepairs(current,snapshot);
 assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM ai_calls').get().n,0);
 await assert.rejects(recoverCategoryPhase({db:snapshot,directory:old.directory,calls:[],results:[],productId:prior.productId,productRevision:prior.productRevision,model:prior.model,effort:'none',context:prior.categoryContext!,payloadHash:'a'.repeat(64)}),/备份/);
 const older=await fixture(t);retainCategoryRepairs(snapshot,(older.service as any).db);
 await assert.rejects(recoverCategoryPhase({db:(older.service as any).db,directory:older.directory,calls:[],results:[],productId:prior.productId,productRevision:prior.productRevision,model:prior.model,effort:'none',context:prior.categoryContext!,payloadHash:'a'.repeat(64)}),/备份/);
});

test('legacy successful keywords are reused with exact payload and owned matching model',async t=>{
 const f=await fixture(t,{fetch:async()=>json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'category-decision',phase:'keywords',keywords:['cloth'],productType:null,reason:'Cloth',ambiguous:false})}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})});f.enable('deepseek');
 const input={productId:f.product.id,productRevision:f.product.revision,phase:'keywords' as const,candidates:[]};const first=await f.service.decideCategory(input),call=f.service.getCall(first.callId)!;delete call.categoryContext;
 (f.service as any).db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);
 const second=await f.service.decideCategory(input);assert.equal(second.id,first.id);assert.equal(f.requests.length,1);
});
for(const reason of ['arbitrary400','missingReceipt'])test(`legacy ${reason} cannot authorize protocol repair`,async t=>{
 const f=await fixture(t,{fetch:async()=>json(reason==='arbitrary400'?{error:{code:400,message:'other failure'}}:denied,400)});f.service.saveConnection({id:'openrouter',apiKey:'fixture-only'});f.service.setEnabled({id:'openrouter',enabled:true});
 const input={productId:f.product.id,productRevision:f.product.revision,phase:'select' as const,candidates:[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}]};await assert.rejects(f.service.decideCategory(input));const call=f.service.listCalls()[0];delete call.categoryContext;(f.service as any).db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);
 if(reason==='missingReceipt'){const {rm}=await import('node:fs/promises');await rm(f.directory+'/ai-receipts',{recursive:true});}
 await assert.rejects(taskAiContext.run({taskId:crypto.randomUUID(),rowKey:f.product.id+':'+f.product.variants[0].id,phase:'CATEGORY',mode:'immediate',explicitContinueAt:new Date(Date.parse(call.finishedAt!)+1000).toISOString(),authorize:()=>true},()=>f.service.decideCategory(input)));
 assert.equal(f.requests.length,1);
});

test('concurrent category variants cannot both reserve separate requests for one unresolved phase',async t=>{
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 const f=await fixture(t,{fetch:async()=>{await held;throw Error('timeout');}});f.service.saveConnection({id:'openrouter',apiKey:'fixture-only'});f.service.setEnabled({id:'openrouter',enabled:true});
 const input={productId:f.product.id,productRevision:f.product.revision,phase:'select' as const,candidates:[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}]};
 const running=Promise.allSettled([f.service.decideCategory(input),f.service.decideCategory({...input,keywords:['another']})]);
 setTimeout(release,100);await running;assert.equal(f.requests.length,1);
});

import {saveProviderReceipt} from '../src/main/ai/receipts.ts';
for(const historical of ['two400','mixedUnknown','two403'] as const)test(`multiple historical category calls ${historical} coalesce only proven parameter denials`,async t=>{
 const status=historical==='two403'?403:400,body=historical==='two403'?{error:{code:403,message:'Forbidden'}}:denied;
 const f=await fixture(t,{fetch:async()=>json(body,status)});f.service.saveConnection({id:'openrouter',apiKey:'fixture-only'});f.service.setEnabled({id:'openrouter',enabled:true});
 const input={productId:f.product.id,productRevision:f.product.revision,phase:'select' as const,candidates:[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}]};await assert.rejects(f.service.decideCategory(input));
 const db=(f.service as any).db,first=f.service.listCalls()[0];delete first.categoryContext;db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(first),first.id);
 const second={...structuredClone(first),id:crypto.randomUUID(),...(historical==='mixedUnknown'?{errorCode:'NETWORK_ERROR' as const}: {})};delete second.providerReceiptId;
 if(historical!=='mixedUnknown'){const r=await saveProviderReceipt(db,f.directory,second.id,{gateway:'openrouter',endpoint:'/api/alpha/decisions',model:second.model,status,requestId:null,receivedAt:second.finishedAt!,body,costUsd:null},second.purposeSnapshot);second.providerReceiptId=r.id;}
 db.prepare('INSERT INTO ai_calls(id,record_json) VALUES(?,?)').run(second.id,JSON.stringify(second));
 const originals=f.service.listCalls().map(c=>JSON.stringify(c));
 const scope={taskId:crypto.randomUUID(),rowKey:f.product.id+':'+f.product.variants[0].id,phase:'CATEGORY',mode:'immediate' as const,explicitContinueAt:new Date(Date.parse(first.finishedAt!)+1000).toISOString(),authorize:()=>true};
 f.respond(async()=>json({answers:{category:{type:'choice',choice:'CLEANING_CLOTH'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:1,output_tokens:0}}));
 if(historical==='two400'){
  const result=await taskAiContext.run(scope,()=>f.service.decideCategory(input));assert.equal(f.requests.length,2);
  assert.equal((await taskAiContext.run(scope,()=>f.service.decideCategory(input))).id,result.id);assert.equal(f.requests.length,2);
  const claim=JSON.parse(String(db.prepare("SELECT detail_json FROM audit_events WHERE action='ai.category.detail-repair'").get().detail_json));assert.deepEqual(claim.priorCallIds,[first.id,second.id].sort());
  const restored=await fixture(t);retainCategoryRepairs(db,(restored.service as any).db);retainCategoryRepairs(db,(restored.service as any).db);
  assert.equal((restored.service as any).db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='ai.category.detail-repair'").get().n,1);
 }else{await assert.rejects(taskAiContext.run(scope,()=>f.service.decideCategory(input)));assert.equal(f.requests.length,1);}
 for(const original of originals){const call=JSON.parse(original);assert.equal(JSON.stringify(f.service.getCall(call.id)),original);}
});
