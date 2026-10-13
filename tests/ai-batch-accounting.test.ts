import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/batch.ts';
import { AiUsageLedger } from '../src/main/ai/usage.ts';
import { batchAccounting } from '../src/main/ai/batch/accounting.ts';

test('batch reserves every item under the same transaction and quota rejection sends nothing',async t=>{
  let posts=0;const f=fixture(t,async()=>{posts++;throw Error('no send allowed');}),ledger=new AiUsageLedger(f.db,()=>new Date());
  ledger.setPolicy({providerId:'openrouter',dailyCallLimit:1,dailyTokenLimit:null});
  const [batch]=f.service.prepare([f.operation(),f.operation()]);
  await assert.rejects(f.service.submit(batch.id),(e:any)=>e.code==='QUOTA_EXCEEDED');
  assert.equal(posts,0);assert.equal(ledger.summary('openrouter').attempts,0);assert.equal(f.service.get(batch.id).state,'prepared');assert.equal(f.service.items(batch.id).every(i=>i.state==='prepared'),true);
});

test('partial token reports replace reservations once and batch total is not added to item totals',async t=>{
  let raw:any;const f=fixture(t,async(_url,init)=>Response.json(init?.method==='POST'?{id:'batch_budget',model:'openai/gpt-6-luna',endpoint:'/v1/chat/completions',status:'validating',results:null}:raw,{status:init?.method==='POST'?202:200}));
  const [batch]=f.service.prepare([f.operation(),f.operation()]);await f.service.submit(batch.id);
  const ledger=new AiUsageLedger(f.db,()=>new Date()),items=f.service.items(batch.id);assert.equal(ledger.summary('openrouter').attempts,2);
  raw={id:'batch_budget',model:batch.model,endpoint:'/v1/chat/completions',status:'completed',usage:{cost:.1},results:[{custom_id:items[0].id,response:{status_code:200,request_id:'req_cost',body:{usage:{prompt_tokens:10,completion_tokens:4,cost:.03}}},error:null}]};
  await f.service.reconcile(batch.id);const before=ledger.summary('openrouter');await f.service.reconcile(batch.id);assert.deepEqual(ledger.summary('openrouter'),before);
  assert.equal(before.reportedTokens,14);assert.equal(before.unknownCalls,1);assert.equal(before.attempts,2);assert.equal(batchAccounting(f.db,batch.id).totalCostUsd,.1);assert.equal(batchAccounting(f.db,batch.id).itemReportedCostUsd,.03);
});
