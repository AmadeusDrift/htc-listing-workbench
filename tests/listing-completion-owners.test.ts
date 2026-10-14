import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { chat } from './fixtures/listing-ai.ts';
import { openDatabase } from '../src/main/database.ts';
import { CompletionJournal, completionSafetyIdentity } from '../src/main/listing-ai/completion-journal.ts';
import { completionOwnerFixture } from './fixtures/completion-owners.ts';

for(const owner of ['automatic','images'] as const){
  test(`${owner}: real preview transport failure sends no fields and restart resumes the same operation`,async t=>{
    const f=await completionOwnerFixture(t,owner);f.previewFailure(true);await assert.rejects(f.run());
    assert.equal(f.requests.length,0);assert.ok(f.previews()>0);const op=f.listing.completionOperations(f.draft.id)[0];assert.ok(op);assert.equal(op.rounds.length,0);
    if(owner==='automatic'){const queue=await f.queue();assert.notEqual(queue!.products[0].rows[0].kind,'UNKNOWN');assert.equal((f.progress() as any).repairAttempts,1);}
    await f.reopen();f.previewFailure(false);await assert.rejects(f.run(),/Downstream|文案/);
    assert.equal(f.listing.completionOperations(f.draft.id).length,1);assert.equal(f.listing.getCompletion(op.id).state,'DONE');assert.equal(f.requests.filter(p=>p.operation!=='source-color').length,1);
    if(owner==='automatic')assert.equal((f.progress() as any).repairAttempts,1);
  });
  test(`${owner}: field fetch lost response preserves the original step across restart without resending`,async t=>{
    const f=await completionOwnerFixture(t,owner);f.respond(()=>{throw new Error('lost field response');});await assert.rejects(f.run());assert.equal(f.requests.length,1);
    const op=f.listing.completionOperations(f.draft.id)[0];assert.equal(f.listing.completionUnknown(op.id),true);await f.reopen();await assert.rejects(f.run());assert.equal(f.requests.length,1);assert.equal(f.listing.getCompletion(op.id).rounds[0].candidate.id,op.rounds[0].candidate.id);assert.equal(f.listing.getCompletion(op.id).rounds[0].candidate.previous?.length??0,0);
    if(owner==='automatic')assert.equal((await f.queue())!.products[0].rows[0].kind,'UNKNOWN');
  });
  test(`${owner}: quota failure has no send marker and resumes its reserved local ID`,async t=>{
    const f=await completionOwnerFixture(t,owner);f.ai.setUsagePolicy({providerId:'deepseek',dailyCallLimit:0,dailyTokenLimit:null});await assert.rejects(f.run());assert.equal(f.requests.length,0);
    const op=f.listing.completionOperations(f.draft.id)[0],call=op.rounds[0].candidate;assert.equal(call.sent,false);assert.equal(f.ai.listCalls().length,0);assert.equal(f.ai.getUsageSummary('deepseek').attempts,0);
    await f.reopen();f.ai.setUsagePolicy({providerId:'deepseek',dailyCallLimit:null,dailyTokenLimit:null});await assert.rejects(f.run(),/Downstream|文案/);assert.equal(f.requests.length,1);assert.equal(f.listing.getCompletion(op.id).rounds[0].candidate.id,call.id);
  });
  for(const boundary of ['result','adoption'] as const)test(`${owner}: persisted ${boundary} is recovered without another field POST or adoption`,async t=>{
    const f=await completionOwnerFixture(t,owner);let stopped=false;
    if(boundary==='result'){const fields=f.ai.listingFields.bind(f.ai);f.ai.listingFields=async(...args)=>{const value=await fields(...args);if(!stopped){stopped=true;throw new Error('stop after result');}return value;};}
    else{const adopt=f.amazon.adoptFields.bind(f.amazon);f.amazon.adoptFields=(...args)=>{const value=adopt(...args);if(!stopped){stopped=true;throw new Error('stop after adoption');}return value;};}
    await assert.rejects(f.run());assert.equal(stopped,true);assert.equal(f.requests.length,1);const op=f.listing.completionOperations(f.draft.id)[0];await f.reopen();await assert.rejects(f.run(),/Downstream|文案/);
    assert.equal(f.requests.length,1);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length,1);assert.equal(f.listing.getCompletion(op.id).rounds.length,1);
  });
  test(`${owner}: bound source observations are reused after a later preview failure without a redundant color call`,async t=>{
    const f=await completionOwnerFixture(t,owner,true);f.previewFailure(true);
    await assert.rejects(f.run());assert.equal(f.requests.filter(p=>p.operation==='source-color').length,0);assert.equal(f.requests.filter(p=>p.operation!=='source-color').length,0);
    await f.reopen();f.previewFailure(false);await assert.rejects(f.run());assert.equal(f.requests.filter(p=>p.operation==='source-color').length,0);assert.ok(f.requests.filter(p=>p.operation!=='source-color').length>=1);assert.ok(f.requests.some(p=>p.sourceProduct?.assets?.length&&p.sourceProduct?.observations?.some((o:any)=>o.variantId===f.draft.variantId)));
  });
}

test('automatic recovery rejects a child submit intent before entering complete',async t=>{
  const f=await completionOwnerFixture(t,'automatic');f.previewFailure(true);await assert.rejects(f.run());const op=f.listing.completionOperations(f.draft.id)[0];f.child.items[0].submitStarted=true;f.previewFailure(false);await f.reopen();await assert.rejects(f.run(),/提交记录/);assert.equal(f.requests.length,0);assert.equal(f.listing.getCompletion(op.id).rounds.length,0);
});


test('completion send scope isolates other modes, programs and sales recipes',async t=>{
  const f=await completionOwnerFixture(t,'automatic');f.respond(()=>{throw new Error('lost field response');});await assert.rejects(f.run());
  const db=openDatabase(f.directory);try{
    const journal=new CompletionJournal(db),identity=completionSafetyIdentity(f.amazon.getDraft(f.draft.id));assert.equal(journal.saleOperations(identity).length,1);
    for(const changed of [{...identity,mode:'demo' as const},{...identity,listingProgram:'haul' as const},{...identity,recipeHash:'a'.repeat(64)}])assert.equal(journal.saleOperations(changed).length,0);
  }finally{db.close();}
});


test('real preview first activates an optional category field and completion retains its operation through adoption',async t=>{
  const f=await completionOwnerFixture(t,'automatic',false,true);
  f.respond(payload=>chat({kind:'amazon-fields',candidates:[{field:'closure',items:[{value:'Zipper',evidenceIds:[payload.evidence.find((e:any)=>e.name==='closure').id],transformation:'copy'}]}],missing:[]}));
  await assert.rejects(f.run(),/Downstream/);const operations=f.listing.completionOperations(f.draft.id);assert.equal(operations.length,1);assert.equal(operations[0].state,'DONE');assert.equal(f.requests.length,1);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length,1);assert.ok(f.previews()>=2);
});


test('queue does not mark another mode or sales recipe guard as UNKNOWN',async t=>{
  const f=await completionOwnerFixture(t,'automatic');f.respond(()=>{throw new Error('lost response');});await assert.rejects(f.listing.complete(f.reference()));
  assert.equal((await f.queue())!.products[0].rows[0].kind,'UNKNOWN');
  const original=f.listing.completionOperations(f.draft.id)[0],db=openDatabase(f.directory);
  try{for(const other of [{mode:'demo' as const},{recipeHash:'a'.repeat(64)}]){
    const guard=structuredClone(original);guard.draftId=randomUUID();guard.state='GUARD';Object.assign(guard.safetyIdentity,other);guard.safetyScopeHash=listingFingerprint(guard.safetyIdentity);
    for(const round of guard.rounds){round.context.draftId=guard.draftId;round.contextHash=listingFingerprint(round.context);}
    db.prepare('UPDATE listing_completion_operations SET record_json=? WHERE id=?').run(JSON.stringify(guard),guard.id);
    assert.notEqual((await f.queue())!.products[0].rows[0].kind,'UNKNOWN');
  }}finally{db.close();}
});


test('read-only queue rejects a journal phase change during its evidence snapshot',async t=>{
  const f=await completionOwnerFixture(t,'automatic');f.previewFailure(true);await assert.rejects(f.run());
  const op=f.listing.completionOperations(f.draft.id)[0],getDraft=f.amazon.getDraft.bind(f.amazon);let reads=0;
  f.amazon.getDraft=id=>{const draft=getDraft(id);if(++reads===2){const db=openDatabase(f.directory);try{const journal=new CompletionJournal(db),changed=journal.get(op.id);changed.remaining=['Snapshot change'];journal.save(changed);}finally{db.close();}}return draft;};
  await assert.rejects(f.queue()!,/读取期间范围已变化/);assert.equal(f.requests.length,0);
});
