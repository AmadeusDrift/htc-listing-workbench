import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('Amazon delegates automatic task writes to the owner result port',()=>{
 const source=readFileSync(new URL('../src/main/amazon/service.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source, /UPDATE automatic_listing_tasks/);
 assert.doesNotMatch(source, /validateAutomaticListingTask/);
});

import { completionOwnerFixture } from './fixtures/completion-owners.ts';
import { automaticTaskResults } from '../src/main/automatic-listing/task-results.ts';
import { transaction } from '../src/main/application/transaction.ts';
import { imageWorkflowDraftStamp } from '../src/main/image-workflow/approval-reuse.ts';
test('task result CAS conflict rolls back the surrounding domain transaction',async t=>{
 const f=await completionOwnerFixture(t,'automatic'),db=(f.amazon as any).persistence.db;
 const saved=db.prepare('SELECT id,record_json FROM automatic_listing_tasks').get(),task=JSON.parse(saved.record_json);
 const draft=f.amazon.getDraft(f.draft.id),operationId=task.items[0].repair.operationId;
 task.items[0].repair.draftRevision=draft.revision;task.items[0].repair.draftStamp=imageWorkflowDraftStamp(draft);
 db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),task.id);
 const before=db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id).record_json;
 assert.throws(()=>transaction(db,()=>{
  const command=automaticTaskResults.prepare(db,{kind:'fixed-brand',before:draft,operationId});
  db.prepare("UPDATE automatic_listing_tasks SET record_json=json_set(record_json,'$.status','PAUSED') WHERE id=?").run(task.id);
  command.commit({...draft,revision:draft.revision+1});
 }),/检查点已变化/);
 assert.equal(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id).record_json,before);
 assert.throws(()=>automaticTaskResults.prepare(db,{kind:'fixed-brand',before:draft,operationId}),/同一事务/);
});
