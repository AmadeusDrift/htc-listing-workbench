import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, mockStorage, chat, candidateFor, reviewFor } from './fixtures/listing-ai.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';
import { CompletionJournal } from '../src/main/listing-ai/completion-journal.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { AiService } from '../src/main/ai/service.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { WorkspaceStore } from '../src/main/store.ts';
const issue={code:'90220',message:'Missing material',severity:'ERROR' as const,attributeNames:['material'],autoFixable:false,source:'amazon' as const,category:'field' as const};
const pass='isolated completion backup';

for(const beforeDraft of [false,true])for(const success of [false,true])test(`restoring an old encrypted backup ${beforeDraft?'before draft creation':'with the original draft'} retains ${success?'known but missing':'unknown'} sends and protects recreated draft identity`,async t=>{
  const f=await fixture(t),file=join(f.directory,'before.htcbackup');
  const setup=openDatabase(f.directory),record=setup.prepare('SELECT * FROM listing_drafts WHERE id=?').get(f.draft.id)!;
  try{if(beforeDraft)setup.prepare('DELETE FROM listing_drafts WHERE id=?').run(f.draft.id);await createWorkspaceBackup(f.directory,file,pass);
    if(beforeDraft){const columns=Object.keys(record);setup.prepare('INSERT INTO listing_drafts('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...Object.values(record));}
  }finally{setup.close();}
  f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id);return{...d,state:d.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:d.fieldAdoptions?.length?[]:[issue]};};
  if(success)await f.listing.complete(f.reference);else{f.respond(()=>{throw new Error('lost response');});await assert.rejects(f.listing.complete(f.reference));}
  const op=f.listing.completionOperations(f.draft.id)[0],requests=f.requests.length,prepared=await prepareWorkspaceRestore(f.directory,file,pass);
  await f.ai.close();await f.hosting.close();f.amazon.close();f.store.close();f.store.close=()=>{};
  await commitWorkspaceRestore(f.directory,prepared);
  const store=new WorkspaceStore(f.directory),amazon=new AmazonService(f.directory,id=>store.getProduct(id),mockStorage),hosting=new HostingService(f.directory,store,mockStorage);let replayed=0;
  const ai=new AiService(f.directory,store,hosting,mockStorage,{fetch:async()=>{replayed++;throw new Error('No replay allowed');}}),listing=new ListingAiService(store,amazon,ai);
  try{
    const target=amazon.enableDemo(),db=openDatabase(f.directory);try{const saved=new CompletionJournal(db).get(op.id);assert.equal(saved.state,'GUARD');assert.ok(saved.rounds.every(r=>!r.candidate.resultId&&!r.review?.resultId));assert.equal(db.prepare('SELECT id FROM ai_results').all().length,0);}finally{db.close();}
    if(!beforeDraft)await assert.rejects(listing.complete({draftId:f.draft.id,draftRevision:amazon.getDraft(f.draft.id).revision}),/未自动重发/);
    const replacement=await amazon.createDraft({productId:f.product.id,variantId:f.product.variants[0].id,targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
    assert.notEqual(replacement.id,f.draft.id);await assert.rejects(listing.complete({draftId:replacement.id,draftRevision:replacement.revision}),/未自动重发/);
    assert.equal(replayed,0);assert.equal(f.requests.length,requests);assert.equal(listing.completionOperations(f.draft.id).length,1);
    await createWorkspaceBackup(f.directory,join(f.directory,'guard-again.htcbackup'),pass);
  }finally{await ai.close();await hosting.close();amazon.close();store.close();}
});

test('completion backup validates strict records, call/result identity, usage and adoption linkage',async t=>{
  const f=await fixture(t);f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id);return{...d,state:d.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:d.fieldAdoptions?.length?[]:[issue]};};await f.listing.complete(f.reference);
  const op=f.listing.completionOperations(f.draft.id)[0],db=openDatabase(f.directory);
  try{
    await createWorkspaceBackup(f.directory,join(f.directory,'valid.htcbackup'),pass);
    const changes=[(v:any)=>{v.extra=true;},(v:any)=>{v.rounds[0].contextHash='f'.repeat(64);},(v:any)=>{v.rounds[0].candidate.id=randomUUID();},(v:any)=>{v.rounds[0].candidate.resultId=v.rounds[0].review.resultId;},(v:any)=>{v.rounds[0].adoptionId='b'.repeat(64);},(v:any)=>{v.safetyScopeHash='c'.repeat(64);}];
    for(const [i,change] of changes.entries()){
      const changed=structuredClone(op);change(changed);db.prepare('UPDATE listing_completion_operations SET record_json=? WHERE id=?').run(JSON.stringify(changed),op.id);
      await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'invalid-'+i+'.htcbackup'),pass));db.prepare('UPDATE listing_completion_operations SET record_json=? WHERE id=?').run(JSON.stringify(op),op.id);
    }
    const saved=db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(op.rounds[0].candidate.id)!;db.prepare('DELETE FROM ai_usage_ledger WHERE id=?').run(op.rounds[0].candidate.id);
    await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'missing-usage.htcbackup'),pass));db.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(op.rounds[0].candidate.id,saved.record_json);
    const ambiguous=JSON.stringify(op).replace('{','{"id":"'+randomUUID()+'",');db.prepare('UPDATE listing_completion_operations SET record_json=? WHERE id=?').run(ambiguous,op.id);await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'duplicate.htcbackup'),pass));db.prepare('UPDATE listing_completion_operations SET record_json=? WHERE id=?').run(JSON.stringify(op),op.id);
  }finally{db.close();}
});

test('schema 17 encrypted backup migrates without inventing a completion operation',async t=>{
  const f=await fixture(t),db=openDatabase(f.directory);db.exec('DROP TABLE listing_completion_operations; PRAGMA user_version=17;');db.close();
  const file=join(f.directory,'schema17.htcbackup');await createWorkspaceBackup(f.directory,file,pass);
  const restored=await prepareWorkspaceRestore(f.directory,file,pass),snapshot=openDatabase(restored.stagingDirectory);
  try{assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version,18);assert.equal(snapshot.prepare('SELECT id FROM listing_completion_operations').all().length,0);}finally{snapshot.close();}
});

for(const sent of [false,true])test(`normal draft retention keeps exportable ${sent?'sent safety':'unsent historical'} operation records`,async t=>{
  const f=await fixture(t);f.amazon.previewDraft=async()=>{if(!sent)throw new Error('preview offline');return{...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]};};f.respond(()=>{throw new Error('lost response');});await assert.rejects(f.listing.complete(f.reference));
  const op=f.listing.completionOperations(f.draft.id)[0],db=openDatabase(f.directory);db.prepare('UPDATE listing_drafts SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',f.draft.id);db.close();
  const cleanup=f.amazon.cleanupData();assert.equal(cleanup.removedDrafts,1);await createWorkspaceBackup(f.directory,join(f.directory,'after-retention.htcbackup'),pass);
  assert.equal(f.listing.getCompletion(op.id).state,sent?'GUARD':'RETIRED');
});


test('restoring a newer snapshot never downgrades an already sent review to the older workspace phase',async t=>{
  const f=await fixture(t);f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]});
  const fields=f.ai.listingFields.bind(f.ai);f.ai.listingFields=async(...args)=>{const result=await fields(...args);if(args[2])throw new Error('stop after review result');return result;};
  await assert.rejects(f.listing.complete(f.reference));const op=f.listing.completionOperations(f.draft.id)[0],file=join(f.directory,'newer-review.htcbackup');await createWorkspaceBackup(f.directory,file,pass);
  const db=openDatabase(f.directory);try{const older=structuredClone(op),review=older.rounds[0].review!;db.prepare('DELETE FROM ai_results WHERE id=?').run(review.resultId!);db.prepare('DELETE FROM ai_calls WHERE id=?').run(review.id);db.prepare('DELETE FROM ai_usage_ledger WHERE id=?').run(review.id);review.sent=false;review.resultId=null;db.prepare('UPDATE listing_completion_operations SET record_json=? WHERE id=?').run(JSON.stringify(older),older.id);}finally{db.close();}
  const prepared=await prepareWorkspaceRestore(f.directory,file,pass),snapshot=openDatabase(prepared.stagingDirectory);try{const recovered=new CompletionJournal(snapshot).get(op.id);assert.equal(recovered.rounds[0].review!.sent,true);assert.equal(recovered.rounds[0].review!.resultId,op.rounds[0].review!.resultId);assert.equal(new CompletionJournal(snapshot).unknown(op.id),false);}finally{snapshot.close();}
});



for(const coverage of ['complete','candidate-only','before-adoption','review-blocked','blocked-before-resolution','changes-before-resolution'] as const)test(
  `forward restore after rollback guard uses only snapshot evidence: ${coverage}`,async t=>{
    t.mock.method(globalThis,'fetch',()=>{throw new Error('External network prohibited');});
    const f=await fixture(t),before=join(f.directory,'before-operation.htcbackup'),selected=join(f.directory,'selected-operation.htcbackup');
    const negative=coverage.includes('blocked')||coverage.includes('changes'),pendingResolution=coverage.endsWith('before-resolution');
    if(negative)f.respond(payload=>chat(payload.candidate?{...reviewFor(payload),verdict:coverage.includes('changes')?'NEEDS_CHANGES':'BLOCKED',issues:[{field:'material',message:'Review rejected this wording'}]}:candidateFor(payload)));
    await createWorkspaceBackup(f.directory,before,pass);
    f.amazon.previewDraft=async()=>{const draft=f.amazon.getDraft(f.draft.id);return{...draft,state:draft.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:draft.fieldAdoptions?.length?[]:[issue]};};
    if(coverage!=='complete'&&coverage!=='review-blocked'){
      const fields=f.ai.listingFields.bind(f.ai);let interrupted=false;
      f.ai.listingFields=async(...args)=>{const result=await fields(...args);if(!interrupted&&!!args[2]===(coverage!=='candidate-only')){interrupted=true;throw new Error('snapshot before remaining evidence');}return result;};
      await assert.rejects(f.listing.complete(f.reference),/snapshot before remaining evidence/);
      await createWorkspaceBackup(f.directory,selected,pass);
    }
    if(pendingResolution){const save=f.ai.completionJournal.save.bind(f.ai.completionJournal);f.ai.completionJournal.save=operation=>{const value=save(operation);if(operation.rounds[0]?.resolved)throw new Error('stop after negative resolution');return value;};}
    const operation=f.listing.completionOperations(f.draft.id)[0],completion=f.listing.complete(f.reference,undefined,operation?.id);
    if(pendingResolution)await assert.rejects(completion,/stop after negative resolution/);else await completion;
    const local=f.listing.completionOperations(f.draft.id).at(-1)!;assert.equal(local.state,pendingResolution?'ACTIVE':'DONE');assert.equal(f.requests.length,2);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length??0,negative?0:1);
    if(coverage==='complete'||coverage==='review-blocked')await createWorkspaceBackup(f.directory,selected,pass);
    const rollback=await prepareWorkspaceRestore(f.directory,before,pass);
    await f.ai.close();await f.hosting.close();f.amazon.close();f.store.close();f.store.close=()=>{};
    await commitWorkspaceRestore(f.directory,rollback);
    const current=openDatabase(f.directory);try{assert.equal(new CompletionJournal(current).get(local.id).state,'GUARD');assert.equal(current.prepare('SELECT id FROM ai_results').all().length,0);}finally{current.close();}
    const forward=await prepareWorkspaceRestore(f.directory,selected,pass);
    const check=(directory:string)=>{const db=openDatabase(directory);try{
      const journal=new CompletionJournal(db),restored=journal.get(local.id),missing=coverage==='candidate-only'||coverage==='before-adoption';
      assert.equal(restored.state,missing?'GUARD':pendingResolution?'ACTIVE':'DONE');assert.equal(journal.unknown(local.id),missing);
      assert.equal(db.prepare('SELECT id FROM ai_results').all().length,coverage==='candidate-only'?1:2);
      assert.ok(restored.rounds[0].candidate.sent);assert.ok(restored.rounds[0].review!.sent);
      if(!missing){
        assert.equal(journal.result(restored.rounds[0].candidate,restored.rounds[0])!.id,local.rounds[0].candidate.resultId);assert.equal(journal.result(restored.rounds[0].review!,restored.rounds[0])!.id,local.rounds[0].review!.resultId);assert.equal(restored.rounds[0].adoptionId,local.rounds[0].adoptionId);
        if(pendingResolution)assert.equal(restored.rounds[0].resolved,false,'reuse the saved verdict to finish its journal checkpoint without sending again');
      }else{assert.equal(restored.rounds[0].candidate.resultId,null);assert.equal(restored.rounds[0].review!.resultId,null);assert.equal(restored.rounds[0].adoptionId,null);}
    }finally{db.close();}};
    check(forward.stagingDirectory);await commitWorkspaceRestore(f.directory,forward);check(f.directory);assert.equal(f.requests.length,2);
  });


for(const route of ['rollback','retention'] as const)for(const includesAdoption of [false,true])test(
  `adoption committed before journal checkpoint survives ${route}: snapshot ${includesAdoption?'includes':'lacks'} adoption`,async t=>{
    t.mock.method(globalThis,'fetch',()=>{throw new Error('External network prohibited');});
    const f=await fixture(t),before=join(f.directory,'before-adoption-operation.htcbackup'),selected=join(f.directory,'selected-adoption-operation.htcbackup');
    await createWorkspaceBackup(f.directory,before,pass);
    f.amazon.previewDraft=async()=>{const draft=f.amazon.getDraft(f.draft.id);return{...draft,state:draft.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:draft.fieldAdoptions?.length?[]:[issue]};};
    const adopt=f.amazon.adoptFields.bind(f.amazon);f.amazon.adoptFields=()=>{throw new Error('before adoption commit');};
    await assert.rejects(f.listing.complete(f.reference),/before adoption commit/);
    const op=f.listing.completionOperations(f.draft.id)[0];assert.ok(op.rounds[0].adoptionId);assert.equal(op.rounds[0].resolved,false);
    if(!includesAdoption)await createWorkspaceBackup(f.directory,selected,pass);
    f.amazon.adoptFields=(...args)=>{adopt(...args);throw new Error('after adoption commit');};
    await assert.rejects(f.listing.complete(f.reference,undefined,op.id),/after adoption commit/);
    assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length,1);assert.equal(f.listing.getCompletion(op.id).rounds[0].resolved,false);
    if(includesAdoption)await createWorkspaceBackup(f.directory,selected,pass);
    if(route==='retention'){
      const db=openDatabase(f.directory);db.prepare('UPDATE listing_drafts SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',f.draft.id);db.close();
      assert.equal(f.amazon.cleanupData().removedDrafts,1);await createWorkspaceBackup(f.directory,join(f.directory,'retired-guard.htcbackup'),pass);
    }
    const rollback=route==='rollback'?await prepareWorkspaceRestore(f.directory,before,pass):undefined;
    await f.ai.close();await f.hosting.close();f.amazon.close();f.store.close();f.store.close=()=>{};
    if(rollback)await commitWorkspaceRestore(f.directory,rollback);
    const current=openDatabase(f.directory);try{const guard=new CompletionJournal(current).get(op.id);assert.equal(guard.state,'GUARD');assert.equal(guard.rounds[0].resolved,true,'committed adoption remains a durable fact after its references are cleared');assert.equal(guard.rounds[0].adoptionId,null);}finally{current.close();}
    const forward=await prepareWorkspaceRestore(f.directory,selected,pass);
    const check=(directory:string)=>{const db=openDatabase(directory);try{
      const journal=new CompletionJournal(db),restored=journal.get(op.id);assert.equal(restored.state,includesAdoption?'ACTIVE':'GUARD');assert.equal(journal.unknown(op.id),!includesAdoption);assert.equal(restored.rounds[0].resolved,true);
      assert.equal(db.prepare('SELECT id FROM ai_results').all().length,2);
      if(includesAdoption){assert.equal(restored.rounds[0].adoptionId,op.rounds[0].adoptionId);assert.equal(journal.result(restored.rounds[0].candidate,restored.rounds[0])!.id,op.rounds[0].candidate.resultId);const draft=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(op.draftId)!.record_json)).draft;assert.equal(draft.fieldAdoptions.length,1);}
      else{assert.equal(restored.rounds[0].adoptionId,null);assert.equal(restored.rounds[0].candidate.resultId,null);assert.equal(restored.rounds[0].review!.resultId,null);}
    }finally{db.close();}};
    check(forward.stagingDirectory);await commitWorkspaceRestore(f.directory,forward);check(f.directory);assert.equal(f.requests.length,2);
  });

test('retention rejects a mismatched committed adoption before clearing its journal references',async t=>{
  const f=await fixture(t);f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]});
  const adopt=f.amazon.adoptFields.bind(f.amazon);f.amazon.adoptFields=(...args)=>{adopt(...args);throw new Error('after adoption commit');};
  await assert.rejects(f.listing.complete(f.reference),/after adoption commit/);const op=f.listing.completionOperations(f.draft.id)[0],db=openDatabase(f.directory);
  try{const original=String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(op.draftId)!.record_json),record=JSON.parse(original);record.draft.fieldAdoptions[0].contextSha256='f'.repeat(64);
    db.prepare('UPDATE listing_drafts SET created_at=?,record_json=? WHERE id=?').run('2020-01-01T00:00:00.000Z',JSON.stringify(record),op.draftId);
    assert.throws(()=>f.amazon.cleanupData(),/证据无效/);assert.ok(db.prepare('SELECT id FROM listing_drafts WHERE id=?').get(op.draftId));assert.deepEqual(new CompletionJournal(db).get(op.id),op);
  }finally{db.close();}
});

for(const lostAt of ['candidate','review'] as const)test(`second restore safety merge preserves first adoption and unknown second ${lostAt}`,async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw new Error('External network prohibited');});
  const f=await fixture(t),selected=join(f.directory,'first-round-adopted.htcbackup');let previews=0;
  f.amazon.previewDraft=async()=>{if(++previews===2)throw new Error('stop after first round');return{...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[previews>2?{...issue,message:'Missing description',attributeNames:['product_description']}:issue]};};
  await assert.rejects(f.listing.complete(f.reference),/stop after first round/);
  const op=f.listing.completionOperations(f.draft.id)[0],adoption=structuredClone(f.amazon.getDraft(f.draft.id).fieldAdoptions![0]);
  assert.equal(op.rounds.length,1);assert.equal(op.rounds[0].resolved,true);assert.equal(adoption.id,op.rounds[0].adoptionId);
  await createWorkspaceBackup(f.directory,selected,pass);
  f.respond(payload=>{if(lostAt==='candidate'||payload.candidate)throw new Error('second round response lost');return chat(candidateFor(payload));});
  await assert.rejects(f.listing.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision},undefined,op.id));
  const requests=lostAt==='candidate'?3:4;assert.equal(f.requests.length,requests);
  const latest=f.listing.getCompletion(op.id);assert.equal(latest.rounds.length,2);assert.equal(latest.rounds[1][lostAt]!.sent,true);assert.equal(latest.rounds[1][lostAt]!.resultId,null);
  const prepared=await prepareWorkspaceRestore(f.directory,selected,pass);
  const check=(directory:string)=>{const db=openDatabase(directory);try{
    const journal=new CompletionJournal(db),guard=journal.get(op.id),draft=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(op.draftId)!.record_json)).draft;
    assert.equal(guard.state,'GUARD');assert.equal(journal.unknown(op.id),true);assert.equal(guard.rounds.length,2);assert.equal(guard.rounds[0].resolved,true);
    assert.equal(guard.rounds[1][lostAt]!.id,latest.rounds[1][lostAt]!.id);assert.equal(guard.rounds[1][lostAt]!.sent,true);
    assert.ok(guard.rounds.every(round=>round.candidate.resultId===null&&round.review!.resultId===null&&round.adoptionId===null));
    assert.deepEqual(draft.fieldAdoptions,[adoption]);assert.equal(db.prepare('SELECT id FROM ai_results').all().length,2,'only the selected first-round results remain');
  }finally{db.close();}};
  check(prepared.stagingDirectory);
  await f.ai.close();await f.hosting.close();f.amazon.close();f.store.close();f.store.close=()=>{};
  await commitWorkspaceRestore(f.directory,prepared);check(f.directory);
  const store=new WorkspaceStore(f.directory),amazon=new AmazonService(f.directory,id=>store.getProduct(id),mockStorage),hosting=new HostingService(f.directory,store,mockStorage);let replayed=0;
  const ai=new AiService(f.directory,store,hosting,mockStorage,{fetch:async()=>{replayed++;throw new Error('No replay allowed');}}),listing=new ListingAiService(store,amazon,ai);
  try{
    const reference={draftId:op.draftId,draftRevision:amazon.getDraft(op.draftId).revision};
    await assert.rejects(listing.complete(reference,undefined,op.id),/未自动重发/);await assert.rejects(listing.complete(reference),/未自动重发/);
    assert.equal(replayed,0);assert.equal(f.requests.length,requests);assert.deepEqual(amazon.getDraft(op.draftId).fieldAdoptions,[adoption]);
    await createWorkspaceBackup(f.directory,join(f.directory,'second-merge-guard.htcbackup'),pass);
  }finally{await ai.close();await hosting.close();amazon.close();store.close();}
});
