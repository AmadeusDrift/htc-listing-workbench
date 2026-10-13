import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures/batch.ts';
import { BatchService } from '../src/main/ai/batch/service.ts';

test('A50 vision Batch requires a matching immutable pin retained across the waiting window',t=>{
  const f=fixture(t,async()=>{throw Error('no request');}),op=f.operation(),ref={pinId:randomUUID(),assetId:randomUUID(),sha256:'e'.repeat(64),url:'https://images.example.test/'+('e'.repeat(64))+'.png',retainedUntil:new Date(Date.now()+72*3600_000).toISOString()};
  op.body.messages=[{role:'user',content:[{type:'text',text:'Read this image'},{type:'image_url',image_url:{url:ref.url}}]}];op.references=[ref];
  let pinned=true;const service=new BatchService(f.db,f.directory,{fetch:async()=>{throw Error('no request');},credential:()=>({apiKey:'batch-fixture-private-key',scope:op.credentialScope}),validateReference:r=>pinned&&r.pinId===ref.pinId});
  assert.equal(service.previewPlan([op]).groups.length,1);pinned=false;assert.match(service.previewPlan([op]).ordinary[0].reason,/固定|保留/);
  pinned=true;op.references[0].retainedUntil=new Date(Date.now()+3600_000).toISOString();assert.equal(service.previewPlan([op]).groups.length,0);
  op.body.messages=[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]}];assert.match(service.previewPlan([op]).ordinary[0].reason,/inline/);
});

test('A45 groups only same task, phase, purpose, effective model, schema and credential scope',t=>{
  const f=fixture(t,async()=>{throw Error('no request');}),base=f.operation();
  const same={...structuredClone(base),operationId:randomUUID()},otherTask={...structuredClone(base),operationId:randomUUID(),taskId:randomUUID()},otherPhase={...structuredClone(base),operationId:randomUUID(),phase:'repair'},otherSchema={...structuredClone(base),operationId:randomUUID(),schemaFingerprint:'f'.repeat(64)},otherKey={...structuredClone(base),operationId:randomUUID(),credentialScope:'1'.repeat(64)};
  const groups=f.service.previewPlan([base,same,otherTask,otherPhase,otherSchema,otherKey]).groups;assert.deepEqual(groups.map(g=>g.length),[2,1,1,1,1]);
});
