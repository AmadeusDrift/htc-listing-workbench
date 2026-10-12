import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/main/database.ts';
import {completionOwnerFixture} from './fixtures/completion-owners.ts';

for(const shape of ['67','93-C','93-B'])test(`legacy ${shape}: missing operation link reuses durable operation across restart`,async t=>{
  const f=await completionOwnerFixture(t,'images');f.previewFailure(true);await assert.rejects(f.run());
  const op=f.listing.completionOperations(f.draft.id)[0],db=openDatabase(f.directory);
  try {const row=db.prepare('SELECT id,record_json FROM image_workflow_runs').get()!;const run=JSON.parse(String(row.record_json));delete run.contentPreparation.operationId;db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run),row.id);}finally{db.close();}
  await f.reopen();f.previewFailure(false);await assert.rejects(f.run(),/Downstream|文案/);
  assert.equal(f.listing.completionOperations(f.draft.id).length,1);assert.equal(f.listing.getCompletion(op.id).state,'DONE');assert.equal(f.requests.length,1);
});

test('legacy field checkpoint without operation is journaled once, retaining conservative missing-attempt debt',async t=>{
  const f=await completionOwnerFixture(t,'images');f.previewFailure(true);await assert.rejects(f.run());const db=openDatabase(f.directory);
  try {const row=db.prepare('SELECT id,record_json FROM image_workflow_runs').get()!;const run=JSON.parse(String(row.record_json));delete run.contentPreparation.operationId;db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run),row.id);db.prepare('DELETE FROM listing_completion_operations').run();}finally{db.close();}
  await f.reopen();f.previewFailure(false);f.respond(()=>{throw new Error('lost field response');});
  await assert.rejects(f.run());const op=f.listing.completionOperations(f.draft.id)[0];assert.ok(op,'legacy owner must obtain a durable recovery operation');
  await f.reopen();await assert.rejects(f.run());await f.reopen();await assert.rejects(f.run());
  assert.equal(f.requests.length,2,'unknown original attempt plus two missing-step retries exhausts three attempts');assert.equal(f.listing.completionOperations(f.draft.id).length,1);
});
for(const boundary of ['result','adoption'] as const)test(`legacy saved ${boundary}: reconstructs original calls with zero extra field requests`,async t=>{
  const f=await completionOwnerFixture(t,'images');let stopped=false;
  if(boundary==='result'){const send=f.ai.listingFields.bind(f.ai);f.ai.listingFields=async(...args)=>{const result=await send(...args);if(!stopped){stopped=true;throw new Error('saved result crash');}return result;};}
  else {const adopt=f.amazon.adoptFields.bind(f.amazon);f.amazon.adoptFields=(...args)=>{const draft=adopt(...args);if(!stopped){stopped=true;throw new Error('saved adoption crash');}return draft;};}
  await assert.rejects(f.run());assert.equal(f.requests.length,1);const db=openDatabase(f.directory);
  try{const row=db.prepare('SELECT id,record_json FROM image_workflow_runs').get()!;const run=JSON.parse(String(row.record_json));delete run.contentPreparation.operationId;db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run),row.id);db.prepare('DELETE FROM listing_completion_operations').run();}finally{db.close();}
  await f.reopen();await assert.rejects(f.run(),/Downstream|文案/);assert.equal(f.requests.length,1);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length,1);
  await f.reopen();await assert.rejects(f.run(),/Downstream|文案/);assert.equal(f.requests.length,1);
});
import {missingWorkflowBudget} from '../src/main/image-workflow/legacy-missing.ts';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
for(const shape of ['94-A','94-B'])test(`legacy ${shape}: missing workflow with no paid artifact keeps original finite image budget`,async t=>{
  const f=await completionOwnerFixture(t,'images'),db=openDatabase(f.directory);
  try{assert.equal(missingWorkflowBudget(db,f.directory,f.draft,0),3);assert.equal(missingWorkflowBudget(db,f.directory,f.draft,2),1);assert.throws(()=>missingWorkflowBudget(db,f.directory,f.draft,3),/三次/);assert.equal(f.requests.length,0);assert.equal(f.previews(),0);}finally{db.close();}
});
test('missing workflow never resends over an orphan generated artifact or saved image call',async t=>{
  const f=await completionOwnerFixture(t,'images'),db=openDatabase(f.directory),root=join(f.directory,'image-generation','candidates','local-candidate');mkdirSync(root,{recursive:true});writeFileSync(join(root,'candidate.json'),JSON.stringify({productId:f.draft.productId,productRevision:f.draft.productRevision}));
  try{assert.throws(()=>missingWorkflowBudget(db,f.directory,f.draft,0),/已生成图片/);assert.equal(f.requests.length,0);assert.equal(f.previews(),0);}finally{db.close();}
});
import {randomUUID} from 'node:crypto';
test('legacy exhausted missing calls retain all usage and never obtain a fourth send',async t=>{
 const f=await completionOwnerFixture(t,'images');f.respond(()=>{throw Error('lost');});await assert.rejects(f.run());const db=openDatabase(f.directory);
 try{const op=f.listing.completionOperations(f.draft.id)[0],id=op.rounds[0].candidate.id,call=JSON.parse(String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(id)!.record_json)),usage=JSON.parse(String(db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(id)!.record_json));
 for(let i=0;i<2;i++){const next=randomUUID();db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(next,JSON.stringify({...call,id:next}));db.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(next,JSON.stringify({...usage,id:next}));}
 const row=db.prepare('SELECT id,record_json FROM image_workflow_runs').get()!;const run=JSON.parse(String(row.record_json));delete run.contentPreparation.operationId;db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run),row.id);db.prepare('DELETE FROM listing_completion_operations').run();
 }finally{db.close();}
 await f.reopen();await assert.rejects(f.run(),/三次/);assert.equal(f.requests.length,1);assert.equal(f.listing.completionOperations(f.draft.id)[0].legacyRecovery?.callIds.length,3);
 await f.reopen();await assert.rejects(f.run(),/三次/);assert.equal(f.requests.length,1);
});
test('HTTP success without saved output is not adoption and only retries within original budget',async t=>{
 const f=await completionOwnerFixture(t,'images');f.respond(()=>{throw Error('lost');});await assert.rejects(f.run());const db=openDatabase(f.directory);
 try{const op=f.listing.completionOperations(f.draft.id)[0],id=op.rounds[0].candidate.id,row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(id)!,call=JSON.parse(String(row.record_json));call.status='SUCCEEDED';call.errorCode=null;db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),id);
 const owner=db.prepare('SELECT id,record_json FROM image_workflow_runs').get()!,run=JSON.parse(String(owner.record_json));delete run.contentPreparation.operationId;db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run),owner.id);db.prepare('DELETE FROM listing_completion_operations').run();}finally{db.close();}
 await f.reopen();await assert.rejects(f.run());assert.equal(f.requests.length,2);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length??0,0);await f.reopen();await assert.rejects(f.run());assert.equal(f.requests.length,3);
 await f.reopen();await assert.rejects(f.run());assert.equal(f.requests.length,3);
});
test('legacy 67 saved four rounds preserve exhausted budget while latest result remains reusable',async t=>{
 const f=await completionOwnerFixture(t,'images'),send=f.ai.listingFields.bind(f.ai);f.ai.listingFields=async(...args)=>{await send(...args);throw Error('stop after result');};await assert.rejects(f.run());const db=openDatabase(f.directory);
 try{const op=f.listing.completionOperations(f.draft.id)[0],entry=op.rounds[0].candidate,result=JSON.parse(String(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(entry.resultId!)!.record_json)),call=JSON.parse(String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(entry.id)!.record_json)),usage=JSON.parse(String(db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(entry.id)!.record_json));
 for(let i=0;i<3;i++){const callId=randomUUID(),id=randomUUID();db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(callId,JSON.stringify({...call,id:callId}));db.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(callId,JSON.stringify({...usage,id:callId}));db.prepare('INSERT INTO ai_results VALUES(?,?)').run(id,JSON.stringify({...result,id,callId}));}
 const row=db.prepare('SELECT id,record_json FROM image_workflow_runs').get()!,run=JSON.parse(String(row.record_json));delete run.contentPreparation.operationId;db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run),row.id);db.prepare('DELETE FROM listing_completion_operations').run();}finally{db.close();}
 await f.reopen();await assert.rejects(f.run(),/Downstream|文案/);const op=f.listing.completionOperations(f.draft.id)[0];assert.equal(op.legacyRecovery?.priorRounds,2);assert.equal(op.legacyRecovery?.resultIds.length,4);assert.equal(f.requests.length,1);
});
test('legacy dangling DONE operation is relinked instead of allocating a fresh budget',async t=>{
 const f=await completionOwnerFixture(t,'images');await assert.rejects(f.run(),/Downstream|文案/);const op=f.listing.completionOperations(f.draft.id)[0];assert.equal(op.state,'DONE');const db=openDatabase(f.directory);
 try{const row=db.prepare('SELECT id,record_json FROM image_workflow_runs').get()!,run=JSON.parse(String(row.record_json));delete run.contentPreparation.operationId;run.contentPreparation.state='STARTED';db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run),row.id);}finally{db.close();}
 await f.reopen();await assert.rejects(f.run(),/Downstream|文案/);assert.equal(f.listing.completionOperations(f.draft.id).length,1);assert.equal(f.requests.length,1);
});
import {retainCompletionOperations,CompletionJournal} from '../src/main/listing-ai/completion-journal.ts';
test('legacy attempt debt without a new send survives restoring a backup before the draft',async t=>{
 const f=await completionOwnerFixture(t,'images');f.previewFailure(true);await assert.rejects(f.run());const db=openDatabase(f.directory);
 try{const row=db.prepare('SELECT id,record_json FROM image_workflow_runs').get()!,run=JSON.parse(String(row.record_json));delete run.contentPreparation.operationId;db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run),row.id);db.prepare('DELETE FROM listing_completion_operations').run();}finally{db.close();}
 const op=f.listing.beginCompletion(f.reference());assert.equal(op.rounds.length,0);assert.equal(op.legacyRecovery?.missingAttemptDebt,1);
 const other=await completionOwnerFixture(t,'images'),current=openDatabase(f.directory),snapshot=openDatabase(other.directory);
 try{retainCompletionOperations(current,snapshot);const preserved=new CompletionJournal(snapshot).get(op.id);assert.equal(preserved.state,'GUARD');assert.deepEqual(preserved.legacyRecovery,op.legacyRecovery);}finally{current.close();snapshot.close();}
});
import {fixture,candidateFor,reviewFor,chat} from './fixtures/listing-ai.ts';
function removeJournalForLegacy(f:{directory:string;draft:{id:string}}){const db=openDatabase(f.directory);try{db.prepare('DELETE FROM listing_completion_operations').run();db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(randomUUID(),JSON.stringify({draftId:f.draft.id,contentPreparation:{state:'STARTED'}}));}finally{db.close();}}
const legacyIssue=(field:string)=>({code:'90220',message:'Missing '+field,severity:'ERROR' as const,attributeNames:[field],autoFixable:false,source:'amazon' as const,category:'field' as const});
test('legacy exhausted reviews stay bound to saved candidate and never send a fourth review',async t=>{
 const f=await fixture(t);f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[legacyIssue('material')]});let reviews=0;
 f.respond(p=>{if(p.candidate){reviews++;throw Error('lost review');}return chat(candidateFor(p));});
 for(let i=0;i<3;i++)await assert.rejects(f.listing.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision}));assert.equal(reviews,3);removeJournalForLegacy(f);
 for(let i=0;i<2;i++)await assert.rejects(f.listing.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision}),/三次/);
 assert.equal(reviews,3);
});
test('legacy exhausted second candidate keeps its own context after the first adoption',async t=>{
 const f=await fixture(t);f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id);return {...d,state:'BLOCKED',previewIssues:[legacyIssue(d.fieldAdoptions?.length?'color':'material')]};};let candidates=0;
 f.respond(p=>{if(p.candidate)return chat(reviewFor(p));if(++candidates>1)throw Error('lost second candidate');return chat(candidateFor(p));});
 for(let i=0;i<3;i++)await assert.rejects(f.listing.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision}));assert.equal(candidates,4);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length,1);removeJournalForLegacy(f);
 for(let i=0;i<2;i++)await assert.rejects(f.listing.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision}),/三次/);
 assert.equal(candidates,4);
});
import {legacyFixture} from './fixtures/listing-ai.ts';
test('legacy scope is resolved only for recovered legacy results and its failures roll back recovery',async t=>{
 const f=await legacyFixture(t);await f.listing.suggest(f.reference);const original=f.listing.beginCompletion(f.reference);removeJournalForLegacy(f);
 const db=openDatabase(f.directory),journal=new CompletionJournal(db);let resolutions=0;
 try{
  assert.throws(()=>journal.begin(original,undefined,f.draft,()=>{resolutions++;throw Error('legacy scope corruption sentinel');}),/legacy scope corruption sentinel/);
  assert.equal(resolutions,1);assert.equal(journal.list(f.draft.id).length,0);const owner=JSON.parse(String(db.prepare('SELECT record_json FROM image_workflow_runs').get()!.record_json));assert.equal(owner.contentPreparation.operationId,undefined);
  const recovered=journal.begin(original,undefined,f.draft,()=>{resolutions++;return original.scopeHash;});assert.equal(resolutions,2);assert.equal(recovered.rounds.length,1);assert.equal(recovered.scopeHash,original.scopeHash);
 }finally{db.close();}
});
