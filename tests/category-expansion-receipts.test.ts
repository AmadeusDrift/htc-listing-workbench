import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fixture,json} from './fixtures/ai-control.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {readCategoryOperation} from '../src/main/ai/category-operations.ts';
import type {DatabaseSync} from 'node:sqlite';
const scope={targetId:'s04-target',sellerId:'seller',marketplaceId:'ATVPDKIKX0DER',region:'na' as const,locale:'en_US',mode:'live' as const};
async function setup(t:test.TestContext){
 const f=await fixture(t,{fetch:async()=>json({id:'s04-original-none',answers:{category:{type:'choice',choice:'$NO_SUITABLE'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3}})});
 f.service.saveConnection({id:'openrouter',apiKey:'s04-raw-owner-only'});f.service.setEnabled({id:'openrouter',enabled:true});
 const result=await f.service.decideCategory({productId:f.product.id,productRevision:f.product.revision,phase:'select',candidates:[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}]});
 const grant={taskId:randomUUID(),rowKey:f.product.id+':'+f.product.variants[0].id,phase:'CATEGORY',mode:'immediate' as const,authorize:()=>true};
 const claim=taskAiContext.run(grant,()=>f.service.reserveCategoryCandidateExpansion({productId:f.product.id,productRevision:f.product.revision,originalCallId:result.callId,originalDecisionId:result.id,targetId:scope.targetId,query:'cloth'}));
 taskAiContext.run(grant,()=>f.service.permitCategoryCandidateExpansion({productId:f.product.id,productRevision:f.product.revision,requestId:claim.requestId}));
 const bytes=Buffer.from('{ "productTypes": [{"name":"DISH","displayName":"Dish"}] }');
 return {...f,claim,bytes,capture:{requestId:claim.requestId,targetScope:scope,targetGeneration:1,query:claim.query,status:200,remoteRequestId:'s04-remote',receivedAt:new Date().toISOString(),bytes}};
}
test('raw lookup owner stores exact original bytes and binds the original claim and target',async t=>{
 const f=await setup(t);assert.equal(typeof (f.service as any).captureCategoryCandidateExpansionReceipt,'function');
 await f.service.captureCategoryCandidateExpansionReceipt(f.product.id,f.capture);
 const receipt=f.service.readCategoryCandidateExpansionReceipt({productId:f.product.id,requestId:f.claim.requestId,targetScope:scope});assert.ok(receipt);
 assert.equal(receipt.receiptSha256,createHash('sha256').update(f.bytes).digest('hex'));assert.deepEqual(receipt.candidates,[{name:'DISH',displayName:'Dish'}]);
 await f.service.captureCategoryCandidateExpansionReceipt(f.product.id,f.capture);
 await assert.rejects(f.service.captureCategoryCandidateExpansionReceipt(f.product.id,{...f.capture,bytes:Buffer.from('{"productTypes":[]}')}));
 assert.throws(()=>f.service.readCategoryCandidateExpansionReceipt({productId:f.product.id,requestId:f.claim.requestId,targetScope:{...scope,sellerId:'foreign'}}));
});
test('damaged lookup evidence cannot be used as an expanded snapshot or read as unsent',async t=>{
 const f=await setup(t);assert.equal(typeof (f.service as any).captureCategoryCandidateExpansionReceipt,'function');await f.service.captureCategoryCandidateExpansionReceipt(f.product.id,f.capture);
 const path=join(f.directory,'ai-receipts','category-expansions',f.claim.requestId+'.json'),before=await readFile(path);
 await writeFile(path,Buffer.from('damaged original receipt'));assert.throws(()=>f.service.readCategoryCandidateExpansionReceipt({productId:f.product.id,requestId:f.claim.requestId,targetScope:scope}));await writeFile(path,before);
});
test('capture proof freeze is atomic, duplicate capture is read-only, and conflicts preserve the original tuple',async t=>{
 const f=await setup(t),db=(f.service as unknown as {db:DatabaseSync}).db,path=join(f.directory,'ai-receipts','category-expansions',f.claim.requestId+'.json');
 db.exec("CREATE TEMP TRIGGER fail_capture_proof BEFORE UPDATE ON ai_category_operations WHEN json_extract(NEW.record_json,'$.expansion.captureProof') IS NOT NULL BEGIN SELECT RAISE(FAIL,'synthetic capture proof write failed'); END");
 await assert.rejects(f.service.captureCategoryCandidateExpansionReceipt(f.product.id,f.capture),/synthetic capture proof write/);assert.equal(existsSync(path),false);assert.equal(readCategoryOperation(db,f.product.id).expansion!.captureProof,undefined);db.exec('DROP TRIGGER fail_capture_proof');
 await f.service.captureCategoryCandidateExpansionReceipt(f.product.id,f.capture);const operation=readCategoryOperation(db,f.product.id),file=await readFile(path),changes=db.prepare('SELECT total_changes() n').get()!.n;
 for(let i=0;i<5;i++)await f.service.captureCategoryCandidateExpansionReceipt(f.product.id,f.capture);
 assert.equal(db.prepare('SELECT total_changes() n').get()!.n,changes);await assert.rejects(f.service.captureCategoryCandidateExpansionReceipt(f.product.id,{...f.capture,remoteRequestId:'different'}));assert.deepEqual(readCategoryOperation(db,f.product.id),operation);assert.deepEqual(await readFile(path),file);assert.equal(f.requests.length,1);
});
test('an uncommitted caller transaction cannot publish a file with a rollbackable proof',async t=>{
 const f=await setup(t),db=(f.service as unknown as {db:DatabaseSync}).db;db.exec('BEGIN IMMEDIATE');try{await assert.rejects(f.service.captureCategoryCandidateExpansionReceipt(f.product.id,f.capture));}finally{db.exec('ROLLBACK');}
 assert.equal(readCategoryOperation(db,f.product.id).expansion!.captureProof,undefined);assert.equal(existsSync(join(f.directory,'ai-receipts/category-expansions',f.claim.requestId+'.json')),false);assert.equal(f.requests.length,1);
});
test('legacy raw without its independent proof stays original UNKNOWN and never creates a replacement permit',async t=>{
 const f=await setup(t),db=(f.service as unknown as {db:DatabaseSync}).db;await f.service.captureCategoryCandidateExpansionReceipt(f.product.id,f.capture);
 const operation=readCategoryOperation(db,f.product.id),legacy=structuredClone(operation);delete legacy.expansion!.captureProof;db.prepare('UPDATE ai_category_operations SET record_json=? WHERE id=?').run(JSON.stringify(legacy),legacy.id);
 assert.throws(()=>f.service.readCategoryCandidateExpansionReceipt({productId:f.product.id,requestId:f.claim.requestId,targetScope:scope}),(e:any)=>e.certainty==='SENT_UNKNOWN'&&e.requestId===f.claim.requestId);assert.throws(()=>f.service.permitCategoryCandidateExpansion({productId:f.product.id,productRevision:f.product.revision,requestId:f.claim.requestId}));assert.equal(f.requests.length,1);
});
