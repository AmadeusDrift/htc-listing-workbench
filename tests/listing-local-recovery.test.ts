import { retireCompletionDrafts } from '../src/main/listing-ai/completion-journal.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, candidateFor, chat, mockStorage, saveInput } from './fixtures/listing-ai.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { AiService } from '../src/main/ai/service.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore } from '../src/main/backup.ts';

const issue={code:'90220',message:'Missing material',severity:'ERROR' as const,attributeNames:['material'],autoFixable:false,source:'amazon' as const,category:'field' as const};
async function failed(t:any,reviewed=false){
 const f=await fixture(t),listing=new ListingAiService(f.store,f.amazon,f.ai,()=>reviewed);let raw:any;
 f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id);return {...d,state:d.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:d.fieldAdoptions?.length?[]:[issue]};};
 f.respond(payload=>{raw=candidateFor(payload);raw.candidates.forEach((c:any)=>c.items.forEach((i:any)=>i.transformation='composed from source facts'));return chat({kind:'amazon-fields',candidates:null,missing:[]});});
 await assert.rejects(listing.complete(f.reference));
 const op=listing.completionOperations(f.draft.id)[0],call=f.ai.getCall(op.rounds[0].candidate.id)!;
 const path=join(f.directory,'ai-diagnostics',readdirSync(join(f.directory,'ai-diagnostics')).find(n=>n.endsWith(`${call.id}.json`))!);
 const diagnostic=JSON.parse(readFileSync(path,'utf8'));diagnostic.output=raw;writeFileSync(path,JSON.stringify(diagnostic));
 return {...f,listing,op,call,path};
}
test('known invalid response recovers on continuation, preserves failed call and usage, and survives restart and backup without diagnostics',async t=>{
 const f=await failed(t),db=openDatabase(f.directory);
 try{
 const calls=db.prepare('SELECT record_json FROM ai_calls ORDER BY id').all(),usage=db.prepare('SELECT record_json FROM ai_usage_ledger ORDER BY id').all();
 assert.equal(f.listing.completionUnknown(f.op.id),false,'received response must not be an unknown paid request');
 assert.equal(f.ai.listResults(f.product.id).length,0,'reading status must not recover paused work');
 const completed=await f.listing.complete(f.reference,undefined,f.op.id);
 assert.equal(completed.aiCalls,0);assert.equal(f.requests.length,1);assert.equal(completed.draft.fieldAdoptions?.length,1);
 assert.deepEqual(db.prepare('SELECT record_json FROM ai_calls ORDER BY id').all(),calls);assert.deepEqual(db.prepare('SELECT record_json FROM ai_usage_ledger ORDER BY id').all(),usage);
 const result=f.ai.getResult(f.listing.getCompletion(f.op.id).rounds[0].candidate.resultId!)!;
 assert.ok(result.localRecovery);assert.equal(result.callId,f.call.id);assert.equal(f.ai.getCall(f.call.id)!.status,'FAILED');
 rmSync(join(f.directory,'ai-diagnostics'),{recursive:true});
 const again=await f.listing.complete({draftId:completed.draft.id,draftRevision:completed.draft.revision},undefined,f.op.id);assert.equal(again.aiCalls,0);assert.equal(again.draft.fieldAdoptions?.length,1);
 const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,{fetch:async()=>{throw Error('No network allowed');}});
 try{assert.deepEqual(restarted.getResult(result.id),result);assert.equal(restarted.completionJournal.unknown(f.op.id),false);}finally{await restarted.close();}
 const backup=join(f.directory,'recovered.htcbackup');await createWorkspaceBackup(f.directory,backup,'recovered fixture passphrase');
 const restored=await prepareWorkspaceRestore(f.directory,backup,'recovered fixture passphrase'),restoredDb=openDatabase(restored.stagingDirectory);
 try{assert.ok(JSON.parse(String(restoredDb.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json)).localRecovery);}finally{restoredDb.close();}
 }finally{db.close();}
});
for(const mode of ['missing','invalid'] as const)test(`known response ${mode} remains unrecoverable without another request`,async t=>{
 const f=await failed(t);
 if(mode==='missing')rmSync(f.path);else{const d=JSON.parse(readFileSync(f.path,'utf8'));d.output={candidates:null};writeFileSync(f.path,JSON.stringify(d));}
 assert.equal(f.listing.completionUnknown(f.op.id),false);
 await assert.rejects(f.listing.complete(f.reference,undefined,f.op.id),/已收到响应，无法本地恢复/);
 assert.equal(f.requests.length,1);assert.equal(f.ai.listResults(f.product.id).length,0);
});


test('recovery result and journal reference roll back together and repeat without duplicate results',async t=>{
 const f=await failed(t),db=openDatabase(f.directory),request={operationId:f.op.id,callId:f.call.id,contextHash:f.op.rounds[0].contextHash};
 try{
 db.exec("CREATE TRIGGER fail_recovery BEFORE UPDATE ON listing_completion_operations WHEN json_extract(NEW.record_json,'$.rounds[0].candidate.resultId') IS NOT NULL BEGIN SELECT RAISE(ABORT,'recovery journal failure'); END");
 assert.throws(()=>f.ai.completionJournal.recover(request),/recovery journal failure/);
 assert.equal(f.ai.listResults(f.product.id).length,0);assert.equal(f.listing.getCompletion(f.op.id).rounds[0].candidate.resultId,null);
 db.exec('DROP TRIGGER fail_recovery');const result=f.ai.completionJournal.recover(request);
 assert.equal(f.ai.completionJournal.recover(request).id,result.id);assert.equal(f.ai.listResults(f.product.id).length,1);assert.equal(f.requests.length,1);
 }finally{db.close();}
});
test('a failed call without recovery cannot own an ordinary successful-looking result',async t=>{
 const f=await failed(t),result=f.ai.completionJournal.recover({operationId:f.op.id,callId:f.call.id,contextHash:f.op.rounds[0].contextHash}),db=openDatabase(f.directory);
 try{
 for(const mutate of [
  (r:any)=>{delete r.localRecovery;r.createdAt=f.call.finishedAt;},
  (r:any)=>{r.localRecovery.rawOutput.candidates=[];},
  (r:any)=>{r.localRecovery.contextSha256='0'.repeat(64);},
  (r:any)=>{r.localRecovery.operationId='00000000-0000-4000-8000-000000000099';},
 ]){
  const bad=structuredClone(result);mutate(bad);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(bad),result.id);
  assert.throws(()=>f.ai.getResult(result.id));
 }
 db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(result),result.id);
 assert.equal(f.ai.getResult(result.id)!.id,result.id);
 }finally{db.close();}
});
test('historical exact diagnostic proves response receipt but FAILED or mismatched diagnostic alone cannot',async t=>{
 const f=await failed(t),db=openDatabase(f.directory),saved=structuredClone(f.call);delete saved.responseReceived;delete saved.rejection;
 try{
 db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(saved),saved.id);
 assert.equal(f.listing.completionUnknown(f.op.id),false);
 const diagnostic=JSON.parse(readFileSync(f.path,'utf8'));diagnostic.productId='00000000-0000-4000-8000-000000000099';writeFileSync(f.path,JSON.stringify(diagnostic));
 assert.equal(f.listing.completionUnknown(f.op.id),true);
 await assert.rejects(f.listing.complete(f.reference,undefined,f.op.id));assert.equal(f.requests.length,2);assert.equal(f.listing.getCompletion(f.op.id).rounds[0].candidate.previous?.length,1);
 }finally{db.close();}
});
test('changed current product retains frozen recovery but refuses stale adoption without another provider call',async t=>{
 const f=await failed(t);f.store.saveProduct({...saveInput(f.product),title:'Changed current source'});
 await assert.rejects(f.listing.complete(f.reference,undefined,f.op.id));
 assert.equal(f.ai.listResults(f.product.id).length,1);assert.equal(f.requests.length,1);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length??0,0);
});

test('retired draft keeps recovered result readable and backup-safe while preserving the no-resend guard',async t=>{
 const f=await failed(t),result=f.ai.completionJournal.recover({operationId:f.op.id,callId:f.call.id,contextHash:f.op.rounds[0].contextHash}),db=openDatabase(f.directory);
 try{
 db.exec('BEGIN IMMEDIATE');retireCompletionDrafts(db,'2099-01-01T00:00:00.000Z');db.prepare('DELETE FROM listing_drafts WHERE id=?').run(f.draft.id);db.exec('COMMIT');
 assert.equal(f.ai.completionJournal.get(f.op.id).state,'GUARD');assert.equal(f.ai.completionJournal.unknown(f.op.id),true);
 assert.equal(f.ai.getResult(result.id)!.id,result.id);assert.equal(f.ai.listResults(f.product.id).length,1);
 assert.throws(()=>f.ai.completionJournal.recover({operationId:f.op.id,callId:f.call.id,contextHash:f.op.rounds[0].contextHash}));
 const backup=join(f.directory,'retired.htcbackup');await createWorkspaceBackup(f.directory,backup,'retired fixture passphrase');
 const restored=await prepareWorkspaceRestore(f.directory,backup,'retired fixture passphrase'),restoredDb=openDatabase(restored.stagingDirectory);
 try{assert.ok(restoredDb.prepare('SELECT id FROM ai_results WHERE id=?').get(result.id));}finally{restoredDb.close();}
 }finally{db.close();}
});

test('an older backup retains recovered candidate history when a later sent review forces a no-resend guard',async t=>{
 const f=await failed(t,true),result=f.ai.completionJournal.recover({operationId:f.op.id,callId:f.call.id,contextHash:f.op.rounds[0].contextHash});
 const before=join(f.directory,'candidate-before-review.htcbackup'),pass='guarded recovery fixture';await createWorkspaceBackup(f.directory,before,pass);
 f.respond(()=>{throw Error('review response lost');});await assert.rejects(f.listing.complete(f.reference,undefined,f.op.id));assert.equal(f.requests.length,2);
 const restored=await prepareWorkspaceRestore(f.directory,before,pass),db=openDatabase(restored.stagingDirectory);
 try{
 const op=JSON.parse(String(db.prepare('SELECT record_json FROM listing_completion_operations WHERE id=?').get(f.op.id)!.record_json));
 assert.equal(op.state,'GUARD');assert.equal(op.rounds[0].candidate.resultId,null);assert.equal(op.rounds[0].review.sent,true);
 assert.ok(db.prepare('SELECT id FROM ai_results WHERE id=?').get(result.id));
 }finally{db.close();}
 await createWorkspaceBackup(restored.stagingDirectory,join(f.directory,'guarded-again.htcbackup'),pass);
});
