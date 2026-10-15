import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,storage,holdFetch,isCode} from './fixtures/ai-control.ts';
import {AiService} from '../src/main/ai/service.ts';
import {openDatabase} from '../src/main/database.ts';
import {ControlledRunScopes,CONTROLLED_RUN_ID} from '../src/main/application/controlled-run-scope.ts';

function register(f:Awaited<ReturnType<typeof fixture>>){const db=openDatabase(f.directory),item=f.product.variants[0],task={id:randomUUID(),revision:1,status:'RUNNING',mode:'live',targetId:'synthetic-target',sellerId:'seller',marketplaceId:'US',items:[{key:'first',productId:f.product.id,variantId:item.id,sku:item.sku}]};db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));const scopes=new ControlledRunScopes(db),scope=scopes.register({taskId:task.id,expectedTaskRevision:1,targetId:task.targetId,sellerId:task.sellerId,marketplaceId:task.marketplaceId,items:[{itemKey:'first',sku:item.sku,productId:f.product.id,variantIds:[item.id],recipeKey:null,parentage:'NONE'}]});return{db,grant:scopes.activate(scope.id)};}

for(const method of ['text','ocr','segmentation'] as const)test(`actual M07 ${method} has no call, usage, hosting observation or paid request when its reliable fee upper is unavailable`,async t=>{
 const f=await fixture(t);f.enable('deepseek');f.enable('aliyun-ocr');f.enable('aidge-segmentation');const hosted=method==='segmentation'?await f.upload():null;let verifies=0;const verify=f.hosting.verify.bind(f.hosting);f.hosting.verify=async(...args)=>{verifies++;return verify(...args);};const {db,grant}=register(f),calls=f.service.listCalls(),uploads=f.hosting.listUploads(),usage=db.prepare('SELECT * FROM ai_usage_ledger ORDER BY id').all();
 try{await assert.rejects(grant(()=>method==='text'?f.service.suggest(f.textInput):method==='ocr'?f.service.recognize(f.imageInput):f.service.segment({...f.imageInput,hostedAssetId:hosted!.id})),(e:any)=>e.diagnosticReason==='SPEND_BOUND_UNAVAILABLE'&&e.certainty==='NOT_SENT');assert.equal(f.requests.length,0);assert.equal(verifies,0);assert.deepEqual(f.service.listCalls(),calls);assert.deepEqual(f.hosting.listUploads(),uploads);assert.deepEqual(db.prepare('SELECT * FROM ai_usage_ledger ORDER BY id').all(),usage);assert.equal(db.prepare('SELECT count(*) n FROM ai_spend_reservations').get()!.n,0);}finally{db.close();}
});

test('explicit-mode missing scope cannot fall back to an ordinary request while the separate normal service remains usable',async t=>{
 const f=await fixture(t);f.enable('deepseek');let requests=0;const controlled=new AiService(f.directory,f.store,f.hosting,storage,{requiredSpendScopeId:CONTROLLED_RUN_ID,fetch:async()=>{requests++;throw Error('unexpected');}} as any);
 try{await assert.rejects(controlled.suggest(f.textInput),(e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');assert.equal(requests,0);assert.equal(controlled.listCalls().length,0);await f.service.suggest(f.textInput);assert.equal(f.requests.length,1);}finally{await controlled.close();}
});

test('controlled recovery changes only fixed original pending IDs and leaves unrelated and bare PENDING bytes untouched',async t=>{
 const f=await fixture(t);f.enable('deepseek');await f.service.suggest(f.textInput);const original=f.service.listCalls()[0];await f.service.close();const db=openDatabase(f.directory),row=JSON.parse(String(db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(original.id)!.record_json)),pending={...row,state:'PENDING',finishedAt:null,usage:{promptTokens:0,completionTokens:0,processedImages:0}},unrelated=randomUUID(),bare=randomUUID();
 db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...original,status:'RUNNING',finishedAt:null,usage:pending.usage}),original.id);db.prepare('UPDATE ai_usage_ledger SET record_json=? WHERE id=?').run(JSON.stringify(pending),original.id);
 db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(unrelated,JSON.stringify({...original,id:unrelated,status:'RUNNING',finishedAt:null,usage:pending.usage}));for(const id of [unrelated,bare])db.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(id,JSON.stringify({...pending,id}));const beforeCalls=db.prepare('SELECT * FROM ai_calls WHERE id=?').get(unrelated),beforeUsage=db.prepare('SELECT * FROM ai_usage_ledger WHERE id IN (?,?) ORDER BY id').all(unrelated,bare);
 const owner=new AiService(f.directory,f.store,f.hosting,storage,{canManageRecovery:(id:string)=>id===original.id,fetch:async()=>{throw Error('no external');}} as any);
 try{assert.equal(JSON.parse(String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(original.id)!.record_json)).status,'FAILED');assert.equal(JSON.parse(String(db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(original.id)!.record_json)).state,'UNKNOWN');assert.deepEqual(db.prepare('SELECT * FROM ai_calls WHERE id=?').get(unrelated),beforeCalls);assert.deepEqual(db.prepare('SELECT * FROM ai_usage_ledger WHERE id IN (?,?) ORDER BY id').all(unrelated,bare),beforeUsage);}finally{await owner.close();db.close();}
});

test('actual original receipt recovers with disconnected key, paused dispatch and unavailable quote without changing original call or fees',async t=>{
 const held=holdFetch(),f=await fixture(t,{fetch:held.fetch});f.enable('deepseek');const controller=new AbortController(),pending=f.service.suggest(f.textInput,controller.signal),cancelled=assert.rejects(pending,isCode('CANCELLED'));await held.started;controller.abort();await cancelled;held.release();while(f.service.busy)await new Promise(done=>setTimeout(done,5));
 const original=f.service.listCalls()[0],{db}=register(f);f.service.disconnectConnection('deepseek');await f.service.close();const beforeCalls=db.prepare('SELECT * FROM ai_calls ORDER BY id').all(),fees=db.prepare('SELECT * FROM ai_usage_ledger ORDER BY id').all(),money=db.prepare('SELECT * FROM ai_spend_reservations ORDER BY id').all();let requests=0,quotes=0;
 const local=new AiService(f.directory,f.store,f.hosting,storage,{requiredSpendScopeId:CONTROLLED_RUN_ID,fetch:async()=>{requests++;throw Error('no wire');}});const budget=(local as any).spendEffects,assertAvailable=budget.assertAvailable.bind(budget);budget.assertAvailable=(...args:unknown[])=>{quotes++;return assertAvailable(...args);};
 try{const result=await local.suggest(f.textInput);assert.equal(result.callId,original.id);assert.ok(result.providerReceiptRecovery);assert.equal((await local.suggest(f.textInput)).id,result.id);assert.equal(requests,0);assert.equal(quotes,0);assert.deepEqual(db.prepare('SELECT * FROM ai_calls ORDER BY id').all(),beforeCalls);assert.deepEqual(db.prepare('SELECT * FROM ai_usage_ledger ORDER BY id').all(),fees);assert.deepEqual(db.prepare('SELECT * FROM ai_spend_reservations ORDER BY id').all(),money);}finally{await local.close();db.close();}
});

test('a truly unknown original invocation still wins over the fresh budget gate and cannot be replaced',async t=>{
 const f=await fixture(t,{fetch:async()=>{throw Error('original unknown');}});f.enable('deepseek');await assert.rejects(f.service.suggest(f.textInput));const original=f.service.listCalls()[0],{db}=register(f),before=db.prepare('SELECT * FROM ai_calls ORDER BY id').all(),usage=db.prepare('SELECT * FROM ai_usage_ledger ORDER BY id').all();
 try{await assert.rejects(f.service.suggest(f.textInput),(e:any)=>e.callId===original.id&&e.certainty==='SENT_UNKNOWN');assert.equal(f.requests.length,1);assert.deepEqual(db.prepare('SELECT * FROM ai_calls ORDER BY id').all(),before);assert.deepEqual(db.prepare('SELECT * FROM ai_usage_ledger ORDER BY id').all(),usage);}finally{db.close();}
});
