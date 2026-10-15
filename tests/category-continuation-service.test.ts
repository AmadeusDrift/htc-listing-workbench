import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/ai-control.ts';
import {slowHttp} from './fixtures/stabilization/slow-http.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {AiError} from '../src/main/ai/errors.ts';
import {DatabaseSync,backup} from 'node:sqlite';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {categoryOperationId,categoryCandidateSnapshot} from '../src/main/ai/category-context.ts';
import {recoverCategoryPhase,retainCategoryRepairs} from '../src/main/ai/category-recovery.ts';
import {readCategoryOperation} from '../src/main/ai/category-operations.ts';
const candidates=[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}];
const output=(phase:'keywords'|'judge',valid=true)=>({kind:'category-decision',phase,keywords:phase==='keywords'?['cloth']:[],productType:phase==='keywords'||!valid?null:'CLEANING_CLOTH',reason:'Synthetic source cloth.',ambiguous:false});
const envelope=(content:unknown)=>JSON.stringify({id:'s03-original',choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:.002}});
async function categoryFixture(t:test.TestContext,phase:'keywords'|'judge'='judge',valid=true){
 const http=await slowHttp({body:envelope(output(phase,valid))});t.after(()=>http.close());
 const f=await fixture(t,{fetch:async(_url,init)=>fetch(http.url,init)});f.service.saveConnection({id:'openrouter',apiKey:'s03-continuation-only'});f.service.setEnabled({id:'openrouter',enabled:true});f.service.setEnabled({id:'openrouter-review',enabled:true});
 const db=(f.service as unknown as {db:DatabaseSync}).db;
 const input={productId:f.product.id,productRevision:f.product.revision,phase,candidates:phase==='keywords'?[]:candidates};
 const scope={taskId:randomUUID(),rowKey:f.product.id+':'+f.product.variants[0].id,phase:'CATEGORY',mode:'immediate' as const,authorize:()=>true};
 return{...f,http,db,input,scope};
}

test('an invalid judge does not hide the exact successful keyword phase or spend another request',async t=>{
 const f=await categoryFixture(t,'keywords'),keywords=await f.service.decideCategory(f.input);
 const invalid=await slowHttp({body:envelope(output('judge',false))});t.after(()=>invalid.close());f.respond(async(_url,init)=>fetch(invalid.url,init));
 await assert.rejects(f.service.decideCategory({...f.input,phase:'judge',candidates}));
 const before=f.service.listCalls(),raw=await f.service.readProviderReceipt(before[0].id);
 const reused=await f.service.decideCategory(f.input);assert.equal(reused.id,keywords.id);assert.equal(f.http.posts,1);assert.equal(invalid.posts,1);assert.deepEqual(f.service.listCalls(),before);assert.deepEqual(await f.service.readProviderReceipt(before[0].id),raw);
});

for(const code of ['SOURCE_CHANGED','OUTPUT_INVALID'] as const)test(`a complete original category receipt before ${code} recovers without another provider request`,async t=>{
 const f=await categoryFixture(t);
 await assert.rejects(f.service.decideCategory(f.input,()=>{if(f.http.posts)throw new AiError(code);}));
 const original=f.service.listCalls()[0],receipt=await f.service.readProviderReceipt(original.id);assert.equal(f.http.posts,1);assert.ok(receipt);assert.equal(f.service.listResults(f.product.id).length,0);
 const result=await taskAiContext.run(f.scope,()=>f.service.decideCategory(f.input));assert.equal(f.http.posts,1);assert.equal(result.callId,original.id);assert.ok(result.providerReceiptRecovery);assert.equal(result.output.kind,'category-decision');assert.deepEqual(f.service.getCall(original.id),original);assert.deepEqual(await f.service.readProviderReceipt(original.id),receipt);
 const repeated=await taskAiContext.run(f.scope,()=>f.service.decideCategory(f.input));assert.equal(repeated.id,result.id);assert.equal(f.http.posts,1);
});

test('a true unknown category remains tied to the product after a source revision and key change',async t=>{
 const f=await categoryFixture(t);f.respond(async()=>{throw Error('Synthetic connection lost');});await assert.rejects(f.service.decideCategory(f.input));
 const original=f.service.listCalls()[0],p=f.store.getProduct(f.product.id)!;
 const changed=f.store.saveProduct({id:p.id,revision:p.revision,title:p.title+' updated',sourceUrl:p.sourceUrl,description:p.description,status:p.status,variants:p.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})),facts:p.facts});
 f.service.saveConnection({id:'openrouter',apiKey:'s03-new-synthetic-key'});await assert.rejects(f.service.decideCategory({...f.input,productRevision:changed.revision}));assert.equal(f.requests.length,1);assert.equal(f.http.posts,0);assert.deepEqual(f.service.getCall(original.id),original);
});

test('original category response recovery does not require enabling a new credential',async t=>{
 const f=await categoryFixture(t);await assert.rejects(f.service.decideCategory(f.input,()=>{if(f.http.posts)throw new AiError('OUTPUT_INVALID');}));
 const original=f.service.listCalls()[0],usage=f.db.prepare('SELECT record_json FROM ai_usage_ledger').all();
 f.service.setEnabled({id:'openrouter-review',enabled:false});
 const result=await f.service.decideCategory(f.input);assert.equal(result.callId,original.id);assert.equal(f.http.posts,1);assert.deepEqual(f.service.getCall(original.id),original);assert.deepEqual(f.db.prepare('SELECT record_json FROM ai_usage_ledger').all(),usage);
});

for(const mutation of ['candidates','receipt-bytes'] as const)test(`category original recovery refuses changed ${mutation} with no new POST`,async t=>{
 const f=await categoryFixture(t);await assert.rejects(f.service.decideCategory(f.input,()=>{if(f.http.posts)throw new AiError('OUTPUT_INVALID');}));
 const original=f.service.listCalls()[0],calls=f.service.listCalls(),usage=f.db.prepare('SELECT record_json FROM ai_usage_ledger').all();
 let originalBytes:Buffer|undefined;
 const path=join(f.directory,'ai-receipts',original.providerReceiptId+'.json');
 if(mutation==='receipt-bytes'){originalBytes=await readFile(path);await writeFile(path,Buffer.from('invalid original hash'));}
 const input=mutation==='candidates'?{...f.input,candidates:[{name:'DISH',displayName:'Dish'}]}:f.input;
 await assert.rejects(f.service.decideCategory(input));assert.equal(f.http.posts,1);assert.deepEqual(f.service.listCalls(),calls);assert.deepEqual(f.db.prepare('SELECT record_json FROM ai_usage_ledger').all(),usage);
 if(originalBytes)await writeFile(path,originalBytes);
});

for(const mutation of ['call-id','request-sha','foreign-input'] as const)test(`private category replay rejects forged ${mutation} before prepare or wire`,async t=>{
 const f=await categoryFixture(t);await assert.rejects(f.service.decideCategory(f.input,()=>{if(f.http.posts)throw new AiError('OUTPUT_INVALID');}));
 const original=f.service.listCalls()[0],raw=f.requests[0].options?.body;assert.equal(typeof raw,'string');
 const wire=JSON.parse(String(raw)),payload=JSON.parse(wire.messages[1].content.find((part:{type:string})=>part.type==='text').text);
 const source={operation:'category-decision',payload:mutation==='foreign-input'?{...payload,title:'foreign source'}:payload,references:f.product.assets.map(asset=>asset.id)};
 const service=f.service as unknown as {originalProfile(call:unknown):unknown;start(...args:unknown[]):Promise<unknown>};let prepares=0;
 const descriptor={callId:mutation==='call-id'?randomUUID():original.id,requestSha256:mutation==='request-sha'?'a'.repeat(64):original.categoryContext!.requestSha256};
 const before=f.db.prepare('SELECT record_json FROM ai_calls').all(),usage=f.db.prepare('SELECT record_json FROM ai_usage_ledger').all();
 await assert.rejects(service.start(service.originalProfile(original),f.input,source,async()=>{prepares++;throw Error('Must not prepare');},undefined,undefined,{categoryReplay:descriptor}));
 assert.equal(prepares,0);assert.equal(f.http.posts,1);assert.deepEqual(f.db.prepare('SELECT record_json FROM ai_calls').all(),before);assert.deepEqual(f.db.prepare('SELECT record_json FROM ai_usage_ledger').all(),usage);
});

test('actual category producer freezes the stable product operation and exact candidate snapshot',async t=>{
 const f=await categoryFixture(t),result=await f.service.decideCategory(f.input),call=f.service.getCall(result.callId)!;
 assert.equal(call.categoryContext?.version,2);assert.equal(call.categoryContext?.phase,'judge');
 assert.ok(call.categoryContext?.version===2);assert.equal(call.categoryContext.operationId,categoryOperationId(f.product.id));assert.equal(call.categoryContext.candidateSnapshotSha256,categoryCandidateSnapshot(candidates));assert.equal(call.categoryContext.expansion,0);assert.match(call.categoryContext.inputVersion,/^[a-f0-9]{64}$/);
});

test('a cached older phase cannot hide a later real unknown retained across an older source snapshot',async t=>{
 const f=await categoryFixture(t),saved=await f.service.decideCategory(f.input),first=f.service.getCall(saved.callId)!;
 const p=f.store.getProduct(f.product.id)!,changed=f.store.saveProduct({id:p.id,revision:p.revision,title:p.title+' changed',sourceUrl:p.sourceUrl,description:p.description,status:p.status,variants:p.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})),facts:p.facts});
 f.respond(async()=>{throw Error('Synthetic genuine unknown');});await assert.rejects(f.service.decideCategory({...f.input,productRevision:changed.revision}));assert.equal(f.requests.length,2);
 await assert.rejects(recoverCategoryPhase({db:f.db,directory:f.directory,calls:f.service.listCalls(),results:f.service.listResults(f.product.id),productId:f.product.id,productRevision:first.productRevision,model:first.model,effort:first.purposeSnapshot!.effectiveEffort,context:first.categoryContext!,payloadHash:saved.sourceSha256!}));
 assert.equal(f.requests.length,2);assert.equal(f.http.posts,1);
});

test('known invalid judge repairs once through the actual call/usage transaction without resetting a daily limit',async t=>{
 const f=await categoryFixture(t,'judge',false);f.db.exec('CREATE TABLE ai_category_operations(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');await assert.rejects(f.service.decideCategory(f.input));
 const original=f.service.listCalls()[0],receipt=await f.service.readProviderReceipt(original.id),continuedAt=new Date(Date.parse(original.finishedAt!)+1).toISOString(),scope={...f.scope,explicitContinueAt:continuedAt};
 const valid=await slowHttp({body:envelope(output('judge'))});t.after(()=>valid.close());f.respond(async(_url,init)=>fetch(valid.url,init));
 await assert.rejects(f.service.decideCategory(f.input));assert.equal(valid.posts,0);assert.equal(readCategoryOperation(f.db,f.product.id).repairs.length,0);
 f.service.setUsagePolicy({providerId:'openrouter-review',dailyCallLimit:1,dailyTokenLimit:null});
 await assert.rejects(taskAiContext.run(scope,()=>f.service.decideCategory(f.input)));assert.equal(valid.posts,0);assert.equal(readCategoryOperation(f.db,f.product.id).repairs.length,0);assert.equal(f.service.listCalls().length,1);
 f.service.setUsagePolicy({providerId:'openrouter-review',dailyCallLimit:2,dailyTokenLimit:null});
 const repaired=await taskAiContext.run(scope,()=>f.service.decideCategory(f.input));assert.equal(valid.posts,1);assert.notEqual(repaired.callId,original.id);assert.deepEqual(f.service.getCall(original.id),original);assert.deepEqual(await f.service.readProviderReceipt(original.id),receipt);
 const operation=readCategoryOperation(f.db,f.product.id);assert.deepEqual(operation.repairs[0].originalCallIds,[original.id]);assert.equal(operation.repairs[0].retryCallId,repaired.callId);assert.equal(f.service.getUsageSummary('openrouter-review').attempts,2);
 assert.equal((await taskAiContext.run(scope,()=>f.service.decideCategory(f.input))).id,repaired.id);assert.equal(valid.posts,1);
});

test('another invalid repair cannot gain an allowance from a new key, task or source revision',async t=>{
 const f=await categoryFixture(t,'judge',false);f.db.exec('CREATE TABLE ai_category_operations(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');await assert.rejects(f.service.decideCategory(f.input));
 const first=f.service.listCalls()[0],scope={...f.scope,explicitContinueAt:new Date(Date.parse(first.finishedAt!)+1).toISOString()};await assert.rejects(taskAiContext.run(scope,()=>f.service.decideCategory(f.input)));assert.equal(f.http.posts,2);
 const before=f.service.listCalls(),oldOperation=readCategoryOperation(f.db,f.product.id),p=f.store.getProduct(f.product.id)!;
 const changed=f.store.saveProduct({id:p.id,revision:p.revision,title:p.title+' updated',sourceUrl:p.sourceUrl,description:p.description,status:p.status,variants:p.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})),facts:p.facts});
 f.service.saveConnection({id:'openrouter',apiKey:'s03-following-synthetic-key'});
 await assert.rejects(taskAiContext.run({...scope,taskId:randomUUID(),explicitContinueAt:new Date(Date.now()+1).toISOString()},()=>f.service.decideCategory({...f.input,productRevision:changed.revision})));assert.equal(f.http.posts,2);assert.deepEqual(f.service.listCalls(),before);assert.deepEqual(readCategoryOperation(f.db,f.product.id),oldOperation);
});

test('an original missing-call backup marker cannot be hidden by an older successful phase or revision',async t=>{
 const f=await categoryFixture(t),saved=await f.service.decideCategory(f.input),first=f.service.getCall(saved.callId)!;
 const path=join(f.directory,'old-source.sqlite');await backup(f.db,path);
 const p=f.store.getProduct(f.product.id)!,changed=f.store.saveProduct({id:p.id,revision:p.revision,title:p.title+' changed',sourceUrl:p.sourceUrl,description:p.description,status:p.status,variants:p.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})),facts:p.facts});f.respond(async()=>{throw Error('Synthetic unknown after backup');});await assert.rejects(f.service.decideCategory({...f.input,productRevision:changed.revision}));
 const snapshot=new DatabaseSync(path);try{
  retainCategoryRepairs(f.db,snapshot);assert.equal(snapshot.prepare("SELECT count(*) n FROM audit_events WHERE action='ai.category.restored-request'").get()!.n,1);
  await assert.rejects(recoverCategoryPhase({db:snapshot,directory:f.directory,calls:[first],results:[saved],productId:f.product.id,productRevision:first.productRevision,model:first.model,effort:first.purposeSnapshot!.effectiveEffort,context:first.categoryContext!,payloadHash:saved.sourceSha256!}));
 }finally{snapshot.close();}
 assert.equal(f.requests.length,2);assert.equal(f.http.posts,1);
});

for(const status of [401,403,400] as const)test(`complete category HTTP ${status} continuation keeps the original receipt and bounded permit`,async t=>{
 const f=await categoryFixture(t);f.db.exec('CREATE TABLE ai_category_operations(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');
 const denied=await slowHttp({status,body:JSON.stringify({error:{code:status,message:status===401?'Invalid API key':status===403?'Forbidden':'Synthetic invalid parameter'}})});t.after(()=>denied.close());f.respond(async(_url,init)=>fetch(denied.url,init));await assert.rejects(f.service.decideCategory(f.input));
 const original=f.service.listCalls()[0],receipt=await f.service.readProviderReceipt(original.id),valid=await slowHttp({body:envelope(output('judge'))});t.after(()=>valid.close());f.respond(async(_url,init)=>fetch(valid.url,init));
 let scope={...f.scope,explicitContinueAt:new Date(Date.parse(original.finishedAt!)+1).toISOString()};
 if(status===401){await assert.rejects(taskAiContext.run(scope,()=>f.service.decideCategory(f.input)));assert.equal(valid.posts,0);assert.equal(readCategoryOperation(f.db,f.product.id).repairs.length,0);
  f.service.saveFunctionSettings({id:'openrouter-review',model:'openai/gpt-6.1-sol',enabled:true,thinking:false});await assert.rejects(taskAiContext.run(scope,()=>f.service.decideCategory(f.input)));assert.equal(valid.posts,0);
  f.service.saveConnection({id:'openrouter',apiKey:'s03-explicit-credential-replacement'});scope={...scope,explicitContinueAt:new Date(Date.now()+1).toISOString()};
 }
 const repaired=await taskAiContext.run(scope,()=>f.service.decideCategory(f.input));assert.equal(valid.posts,1);assert.equal(denied.posts,1);assert.notEqual(repaired.callId,original.id);assert.deepEqual(f.service.getCall(original.id),original);assert.deepEqual(await f.service.readProviderReceipt(original.id),receipt);assert.equal(readCategoryOperation(f.db,f.product.id).repairs.length,1);
 assert.equal((await taskAiContext.run(scope,()=>f.service.decideCategory(f.input))).id,repaired.id);assert.equal(valid.posts,1);
 if(status===403)assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='ai.forbidden.manual-retry'").get()!.n,1);
});

test('an older database snapshot retains a strictly received successful category phase without a new call',async t=>{
 const f=await categoryFixture(t),path=join(f.directory,'before-category.sqlite');await backup(f.db,path);const saved=await f.service.decideCategory(f.input),call=f.service.getCall(saved.callId)!;
 const snapshot=new DatabaseSync(path);try{
  retainCategoryRepairs(f.db,snapshot);
  assert.deepEqual(JSON.parse(String(snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id)?.record_json??'null')),call);
  assert.deepEqual(JSON.parse(String(snapshot.prepare('SELECT record_json FROM ai_results WHERE id=?').get(saved.id)?.record_json??'null')),saved);
  const reused=await recoverCategoryPhase({db:snapshot,directory:f.directory,calls:[call],results:[saved],productId:f.product.id,productRevision:call.productRevision,model:call.model,effort:call.purposeSnapshot!.effectiveEffort,context:call.categoryContext!,payloadHash:saved.sourceSha256!});assert.equal(reused.saved!.id,saved.id);
  assert.equal(snapshot.prepare("SELECT count(*) n FROM audit_events WHERE action='ai.category.restored-request'").get()!.n,0);
 }finally{snapshot.close();}
 assert.equal(f.http.posts,1);assert.deepEqual(f.service.getCall(call.id),call);
});

for(const fault of ['missing-raw','foreign-output','result-insert-failure'] as const)test(`category evidence retention fails closed on ${fault}`,async t=>{
 const f=await categoryFixture(t),path=join(f.directory,'before-evidence.sqlite');await backup(f.db,path);const result=await f.service.decideCategory(f.input),call=f.service.getCall(result.callId)!,snapshot=new DatabaseSync(path);
 try{
  if(fault==='missing-raw')await unlink(join(f.directory,'ai-receipts',call.providerReceiptId+'.json'));
  if(fault==='foreign-output')f.db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({...result,output:{...result.output,productType:'DISH'}}),result.id);
  if(fault==='result-insert-failure')snapshot.exec("CREATE TEMP TRIGGER fail_category_result BEFORE INSERT ON ai_results BEGIN SELECT RAISE(FAIL,'synthetic result write failure'); END");
  if(fault==='result-insert-failure')assert.throws(()=>retainCategoryRepairs(f.db,snapshot),/synthetic result write/);else retainCategoryRepairs(f.db,snapshot);
  assert.equal(snapshot.prepare('SELECT count(*) n FROM ai_calls').get()!.n,0);assert.equal(snapshot.prepare('SELECT count(*) n FROM ai_results').get()!.n,0);assert.equal(snapshot.prepare('SELECT count(*) n FROM ai_provider_receipts').get()!.n,0);assert.equal(f.http.posts,1);
 }finally{snapshot.close();}
});
