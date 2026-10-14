import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { openDatabase } from '../src/main/database.ts';
import { resolvePurpose } from '../src/main/ai/purpose-routing.ts';

async function fixture(t:test.TestContext,fetcher:typeof fetch){
  const { BatchService }=await import('../src/main/ai/batch/service.ts');
  const root=resolve('.test-data');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'batch-')),db=openDatabase(directory);
  const credentialScope='a'.repeat(64),taskId=randomUUID();
  const service=new BatchService(db,directory,{fetch:fetcher,credential:()=>({apiKey:'batch-fixture-private-key',scope:credentialScope})});
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  const operation=()=>({taskId,operationId:randomUUID(),attempt:1,phase:'copy',inputFingerprint:'b'.repeat(64),schemaFingerprint:'c'.repeat(64),credentialScope,owner:{productId:randomUUID(),productRevision:1,providerId:'openrouter' as const,generation:1},purpose:resolvePurpose(db,'listing_title'),body:{messages:[{role:'user',content:'Return JSON title'}],reasoning:{effort:'medium'},max_tokens:4096,response_format:{type:'json_object'}},references:[]});
  return{service,db,directory,operation};
}

test('A45 real Batch creates once with ordered envelope then reads by remote id',async t=>{
  const requests:{url:string;init:RequestInit}[]=[];
  const f=await fixture(t,async(url,init)=>{requests.push({url:String(url),init:init!});return Response.json({id:'batch_fixture',status:'validating',model:'openai/gpt-6-luna',endpoint:'/v1/chat/completions',results:null,usage:null},{status:init?.method==='POST'?202:200});});
  const [batch]=f.service.prepare([f.operation(),f.operation()]);assert.equal(batch.state,'prepared');
  await f.service.submit(batch.id);await f.service.submit(batch.id);await f.service.reconcile(batch.id);
  assert.deepEqual(requests.map(r=>r.init.method),['POST','GET']);
  const body=JSON.parse(String(requests[0].init.body));assert.deepEqual(Object.keys(body),['endpoint','model','provider','completion_window','requests']);
  assert.equal(body.model,'openai/gpt-6-luna');assert.equal(body.requests.length,2);assert.equal(body.requests[0].body.provider,undefined);assert.equal(body.requests[0].body.model,undefined);assert.equal(body.requests[0].body.stream,undefined);
  assert.deepEqual(body.provider,{allow_fallbacks:true,require_parameters:true});assert.equal(requests[1].url,'https://openrouter.ai/api/v1/batches/batch_fixture');
  assert.equal(f.service.get(batch.id).remoteBatchId,'batch_fixture');assert.equal(f.service.items(batch.id).every(i=>i.state==='waiting'),true);
});

test('A46 ambiguous create never rePOSTs after restart or changed input',async t=>{
  let posts=0;const f=await fixture(t,async()=>{posts++;throw Error('response lost');}),operation=f.operation(),[batch]=f.service.prepare([operation]);
  await assert.rejects(f.service.submit(batch.id));assert.equal(f.service.get(batch.id).state,'submission_unknown');
  const {BatchService}=await import('../src/main/ai/batch/service.ts');const restarted=new BatchService(f.db,f.directory,{fetch:async()=>{posts++;throw Error('must not send');},credential:()=>({apiKey:'batch-fixture-private-key',scope:operation.credentialScope})});
  await assert.rejects(restarted.submit(batch.id),/未知|原批次/);assert.throws(()=>restarted.prepare([{...operation,inputFingerprint:'d'.repeat(64)}]),/已有|身份|变化/);assert.equal(posts,1);
});

test('A48 out-of-order duplicate and partial results stay attached to custom_id; pause never adopts',async t=>{
  let response:any,posts=0;const f=await fixture(t,async(_url,init)=>{if(init?.method==='POST'){posts++;return Response.json({id:'batch_partial',status:'validating',model:'openai/gpt-6-luna',endpoint:'/v1/chat/completions',results:null},{status:202});}return Response.json(response);});
  const [batch]=f.service.prepare([f.operation(),f.operation(),f.operation()]);await f.service.submit(batch.id);const items=f.service.items(batch.id);
  const result={custom_id:items[1].customId,response:{status_code:200,request_id:'req_second',body:{id:'gen_second',choices:[{finish_reason:'stop',message:{content:'{"title":"second"}'}}],usage:{prompt_tokens:5,completion_tokens:2,cost:.02}}},error:null};
  response={id:'batch_partial',status:'completed',model:batch.model,endpoint:'/v1/chat/completions',usage:{cost:.04},results:[result,{custom_id:items[0].customId,response:null,error:{code:'fixture_error'}},result]};
  f.service.stopLocally(batch.id);await f.service.reconcile(batch.id);await f.service.reconcile(batch.id);
  const saved=f.service.items(batch.id);assert.equal(saved[1].state,'received');assert.equal(saved[0].state,'failed');assert.equal(saved[2].state,'missing');assert.equal(saved.some(i=>i.adoption!==null),false);
  assert.equal(f.service.get(batch.id).locallyStopped,true);assert.equal(f.service.get(batch.id).remoteStatus,'completed');assert.equal(f.service.get(batch.id).reportedCostUsd,.04);assert.equal(posts,1);
  const {batchAccounting}=await import('../src/main/ai/batch/accounting.ts');
  assert.deepEqual(batchAccounting(f.db,batch.id),{id:batch.id,calls:3,reportedBatchCostUsd:.04,itemReportedCostUsd:.02,unknownItemCosts:2,totalCostUsd:.04,basis:'batch_actual',allocationComplete:false});
  assert.throws(()=>f.service.adopt(items[1].id,{inputFingerprint:items[1].inputFingerprint,authorize:()=>false,apply:()=>assert.fail('paused apply')}),/暂停|授权/);
  f.service.resumeLocally(batch.id);let applied=0;const command={inputFingerprint:items[1].inputFingerprint,authorize:()=>true,apply:()=>{applied++;return 'adoption-fixture';}};
  f.service.adopt(items[1].id,command);f.service.adopt(items[1].id,command);assert.equal(applied,1);
  const {assertBatchHistory}=await import('../src/main/ai/batch/records.ts');assertBatchHistory(f.db);
});

test('A47 unsupported modes and unpinned vision explain ordinary routing without model replacement',async t=>{
  const f=await fixture(t,async()=>{throw Error('no requests');}),op=f.operation();
  const ds={...op,purpose:resolvePurpose(f.db,'listing_title')};ds.purpose.gateway='deepseek';ds.purpose.model='deepseek-flash';ds.purpose.capability={...ds.purpose.capability,gateway:'deepseek',model:'deepseek-flash',batch:false};
  const vision={...op,body:{...op.body,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.com/unversioned.png'}}]}]}};
  assert.equal(f.service.previewPlan([ds]).ordinary.length,1);assert.equal(f.service.previewPlan([vision]).ordinary.length,1);
  assert.throws(()=>f.service.prepare([vision]),/参考|固定|Batch/);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_batches').get()!.n,0);
});

export {fixture};
