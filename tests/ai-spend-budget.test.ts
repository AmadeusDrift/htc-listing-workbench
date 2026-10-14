import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {transaction} from '../src/main/application/transaction.ts';
import {imageSpendBound,priceEvidence,usdMicrosCeil} from '../src/main/ai/spend-records.ts';
import {prepareImageSpendReceiptProof} from '../src/main/ai/spend-receipts.ts';
import type {ProviderReceipt} from '../src/main/ai/receipts.ts';

const model='openai/gpt-image-2.5-sunburst',at='2026-10-15T00:00:00.000Z';
const body=JSON.stringify({model,n:1}),sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const quote=()=>imageSpendBound(body,priceEvidence(model,{id:model,endpoints:[{pricing:[{billable:'output_image',unit:'image',cost_usd:.04}]}]},new Date(at)),at)!;
const load=async()=>{const mod=await import('../src/main/ai/spend-budget.ts').catch(()=>null);assert.ok(mod?.AiSpendBudget,'missing money reservation owner');return mod!;};

test('money owner reserves intent and permit atomically, keeps unknown holds, and settles only an exact saved receipt',async()=>{
 const {AiSpendBudget,initializeSpendBudget}=await load(),db=new DatabaseSync(':memory:');
 try{transaction(db,()=>initializeSpendBudget(db));db.exec('CREATE TABLE ai_provider_receipts(id TEXT PRIMARY KEY,record_json TEXT);CREATE TABLE intents(id TEXT PRIMARY KEY)');const budget=new AiSpendBudget(db,()=>new Date(at));budget.setImagePolicy(100_000);
 const id=randomUUID(),identity={id,businessKey:sha('scope1'),requestSha256:sha(body),model,purpose:'image_generation',scopeId:null};
 assert.throws(()=>transaction(db,()=>{budget.reserveInTransaction(db,identity,body,quote());db.prepare('INSERT INTO intents VALUES(?)').run(id);throw Error('second owner failed');}),/second owner/);assert.equal(budget.list().length,0);assert.equal(db.prepare('SELECT count(*) n FROM intents').get()!.n,0);
 transaction(db,()=>{budget.reserveInTransaction(db,identity,body,quote());db.prepare('INSERT INTO intents VALUES(?)').run(id);});assert.equal(budget.summary('image-generation-daily').heldUsdMicros,40_000);
 transaction(db,()=>budget.markUnknownInTransaction(db,id));assert.equal(budget.summary('image-generation-daily').heldUsdMicros,40_000);assert.throws(()=>transaction(db,()=>budget.reserveInTransaction(db,identity,body,quote())));
 const capture={gateway:'openrouter' as const,endpoint:'/api/v1/images',model,status:401,requestId:null,receivedAt:at,body:{error:{code:401,message:'Synthetic denied'}},costUsd:.02},bytes=JSON.stringify({version:1,callId:id,purpose:null,...capture}),digest=sha(bytes),receipt=sha(id+':'+digest),{body:_body,...metadata}=capture,record:ProviderReceipt={...metadata,version:1,id:receipt,callId:id,relativePath:`ai-receipts/${receipt}.json`,sha256:digest,byteSize:Buffer.byteLength(bytes),reportedTokens:null};
 db.prepare('INSERT INTO ai_provider_receipts VALUES(?,?)').run(receipt,JSON.stringify(record));const proof=prepareImageSpendReceiptProof(record,capture);transaction(db,()=>budget.settleReceiptInTransaction(db,id,receipt,proof));transaction(db,()=>budget.settleReceiptInTransaction(db,id,receipt,proof));assert.deepEqual(budget.summary('image-generation-daily'),{reportedUsdMicros:20_000,heldUsdMicros:0,unboundedCalls:0,anomaly:false,limitUsdMicros:100_000});
 }finally{db.close();}
});
test('money is rounded upward and token/image metadata cannot fabricate a hard image bound',()=>{
 assert.equal(usdMicrosCeil('0.00000001'),1);assert.equal(usdMicrosCeil(5),5_000_000);assert.equal(usdMicrosCeil('3e-8'),1);assert.throws(()=>usdMicrosCeil(-1));
 assert.equal(imageSpendBound(body,priceEvidence(model,{id:model,endpoints:[{pricing:[{billable:'output_image',unit:'token',cost_usd:.00003}]}]},new Date(at)),at),null);
 assert.equal(imageSpendBound(body,priceEvidence(model,{id:model,endpoints:[{pricing:[{billable:'output_image',unit:'image',cost_usd:.04},{billable:'input_text',unit:'token',cost_usd:.000005}]}]},new Date(at)),at),null);
 assert.throws(()=>imageSpendBound(body,quote().evidence,'2026-10-15T00:02:00.000Z'));
});
test('borrowed budget reservations require an active transaction on the same physical workspace',async()=>{
 const {AiSpendBudget,initializeSpendBudget}=await load();await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s08-owner-')),db=new DatabaseSync(join(root,'owner.sqlite')),other=new DatabaseSync(join(root,'owner.sqlite')),alien=new DatabaseSync(':memory:');
 try{transaction(db,()=>initializeSpendBudget(db));const budget=new AiSpendBudget(db,()=>new Date(at)),id={id:randomUUID(),businessKey:sha('borrowed'),requestSha256:sha(body),model,purpose:'image_generation',scopeId:null};budget.setImagePolicy(50_000);
 assert.throws(()=>budget.reserveInTransaction(other,id,body,quote()));assert.throws(()=>transaction(alien,()=>budget.reserveInTransaction(alien,id,body,quote())));transaction(other,()=>budget.reserveInTransaction(other,id,body,quote()));assert.equal(budget.summary('image-generation-daily').heldUsdMicros,40_000);
 assert.throws(()=>transaction(db,()=>budget.reserveInTransaction(db,{...id,id:randomUUID(),businessKey:sha('independent')},body,quote())),(e:any)=>e.diagnosticReason==='SPEND_LIMIT_EXCEEDED');assert.equal(budget.list().length,1);
 }finally{alien.close();other.close();db.close();await rm(root,{recursive:true,force:true});}
});
test('the fixed five USD lifetime ledger retains unknown liabilities across UTC days and old snapshot restore',async()=>{
 const {AiSpendBudget,initializeSpendBudget,retainSpendHistory}=await load(),db=new DatabaseSync(':memory:'),snapshot=new DatabaseSync(':memory:');let now=at;
 const makeQuote=(cost:number)=>imageSpendBound(body,priceEvidence(model,{id:model,endpoints:[{pricing:[{billable:'output_image',unit:'image',cost_usd:cost}]}]},new Date(now)),now)!;
 const identity=()=>({id:randomUUID(),businessKey:sha(randomUUID()),requestSha256:sha(body),model,purpose:'image_generation',scopeId:'htc-250-controlled-live/v1'});
 try{transaction(db,()=>initializeSpendBudget(db));transaction(snapshot,()=>initializeSpendBudget(snapshot));const budget=new AiSpendBudget(db,()=>new Date(now));transaction(db,()=>budget.reserveInTransaction(db,identity(),body,makeQuote(2.4)));now='2026-10-16T00:00:00.000Z';transaction(db,()=>budget.reserveInTransaction(db,identity(),body,makeQuote(2.4)));assert.equal(budget.summary('controlled-live-lifetime').heldUsdMicros,4_800_000);
 transaction(snapshot,()=>retainSpendHistory(db,snapshot));const restored=new AiSpendBudget(snapshot,()=>new Date(now));assert.equal(restored.summary('controlled-live-lifetime').heldUsdMicros,4_800_000);assert.equal(restored.policy('controlled-live-lifetime').limitUsdMicros,5_000_000);assert.throws(()=>transaction(snapshot,()=>restored.reserveInTransaction(snapshot,identity(),body,makeQuote(.25))),(e:any)=>e.diagnosticReason==='SPEND_LIMIT_EXCEEDED');assert.equal(restored.list().length,2);
 }finally{snapshot.close();db.close();}
});
