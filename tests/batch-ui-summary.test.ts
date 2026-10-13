import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/batch.ts';
import { TaskBatchRuntime } from '../src/main/ai/batch/task-runtime.ts';
test('W12 summary uses actual GET receipt time and safe item identities, never local stop time',async t=>{
 const f=fixture(t,async()=>Response.json({id:'batch_ui',model:'openai/gpt-6-luna',endpoint:'/v1/chat/completions',status:'in_progress'}));
 const op=f.operation(),runtime=new TaskBatchRuntime(f.db,f.directory,{fetch:async()=>Response.json({id:'batch_ui',model:'openai/gpt-6-luna',endpoint:'/v1/chat/completions',status:'in_progress'}),credential:()=>({apiKey:'batch-fixture-private-key',scope:op.credentialScope})});
 const batch=f.service.prepare([op])[0];await f.service.submit(batch.id);
 assert.equal(runtime.summary(batch.id).lastQueriedAt,null);
 await f.service.reconcile(batch.id);const summary=runtime.summary(batch.id);
 assert.ok(summary.lastQueriedAt);assert.equal(summary.items[0].operationId,op.operationId);
 assert.equal('body' in summary.items[0],false);assert.equal('references' in summary.items[0],false);
 f.service.stopLocally(batch.id);assert.equal(runtime.summary(batch.id).lastQueriedAt,summary.lastQueriedAt);
});
