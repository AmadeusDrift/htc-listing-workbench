import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {fixture,json} from './fixtures/ai-control.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
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
