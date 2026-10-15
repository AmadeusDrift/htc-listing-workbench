import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/ai-control.ts';
import {slowHttp} from './fixtures/stabilization/slow-http.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {AiError} from '../src/main/ai/errors.ts';
import type {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
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
