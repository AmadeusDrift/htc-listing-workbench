import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/listing-ai.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { openDatabase } from '../src/main/database.ts';
import { candidateFor, chat, reviewFor, saveInput } from './fixtures/listing-ai.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore } from '../src/main/backup.ts';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realParentAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { schemaKey } from '../src/main/amazon/context.ts';
import { AiService } from '../src/main/ai/service.ts';
import { mockStorage } from './fixtures/listing-ai.ts';

const issue={code:'90220',message:'Missing material',severity:'ERROR' as const,attributeNames:['material'],autoFixable:false,source:'amazon' as const,category:'field' as const};
test('a new completion service retries a lost field response within its original operation',async t=>{
  const f=await fixture(t);
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]});
  f.respond(()=>{throw new Error('response lost after entering fetch');});
  await assert.rejects(f.listing.complete(f.reference));
  const next=new ListingAiService(f.store,f.amazon,f.ai);
  await assert.rejects(next.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision}));
  assert.equal(f.requests.length,2);assert.equal(next.completionOperations(f.draft.id).length,1);assert.equal(next.completionOperations(f.draft.id)[0].rounds[0].candidate.previous?.length,1);
});

for(const failure of ['quota','journal-write'] as const)test(`${failure} before fetch rolls back all three records and reuses the fixed call ID`,async t=>{
  const f=await fixture(t);f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id);return{...d,state:d.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:d.fieldAdoptions?.length?[]:[issue]};};
  const op=f.listing.beginCompletion(f.reference),db=openDatabase(f.directory);
  try{
    if(failure==='quota')f.ai.setUsagePolicy({providerId:'deepseek',dailyCallLimit:0,dailyTokenLimit:null});
    else db.exec("CREATE TRIGGER fail_completion_send BEFORE UPDATE ON listing_completion_operations WHEN json_extract(NEW.record_json,'$.rounds[0].candidate.sent')=1 BEGIN SELECT RAISE(ABORT,'fixture journal write failure'); END");
    await assert.rejects(f.listing.complete(f.reference,undefined,op.id));
    const before=f.listing.getCompletion(op.id),callId=before.rounds[0].candidate.id;
    assert.equal(f.requests.length,0);assert.equal(before.rounds[0].candidate.sent,false);assert.equal(f.ai.listCalls().length,0);assert.equal(f.ai.getUsageSummary('deepseek').attempts,0);
    if(failure==='quota')f.ai.setUsagePolicy({providerId:'deepseek',dailyCallLimit:null,dailyTokenLimit:null});else db.exec('DROP TRIGGER fail_completion_send');
    await f.listing.complete(f.reference,undefined,op.id);
    assert.equal(f.listing.getCompletion(op.id).rounds[0].candidate.id,callId);assert.equal(f.requests.length,2);
  }finally{db.close();}
});

for(const boundary of ['candidate-result','review-result','adoption'] as const)test(`resume after persisted ${boundary} uses exact durable evidence without another adoption or request`,async t=>{
  const f=await fixture(t);f.amazon.previewDraft=async()=>{const draft=f.amazon.getDraft(f.draft.id);return{...draft,state:draft.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:draft.fieldAdoptions?.length?[]:[issue]};};
  const op=f.listing.beginCompletion(f.reference);let interrupted=false;
  if(boundary==='adoption'){
    const adopt=f.amazon.adoptFields.bind(f.amazon);f.amazon.adoptFields=(...args)=>{const value=adopt(...args);if(!interrupted){interrupted=true;throw new Error('interrupted after adoption commit');}return value;};
  }else{
    const fields=f.ai.listingFields.bind(f.ai);f.ai.listingFields=async(...args)=>{const value=await fields(...args);if(!interrupted&&Boolean(args[2])===(boundary==='review-result')){interrupted=true;throw new Error('interrupted after result commit');}return value;};
  }
  await assert.rejects(f.listing.complete(f.reference,undefined,op.id),/interrupted after/);
  const sent=f.requests.length,before=f.listing.getCompletion(op.id),next=new ListingAiService(f.store,f.amazon,f.ai);
  const result=await next.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision},undefined,op.id);
  assert.equal(f.requests.length,2);assert.equal(result.draft.fieldAdoptions?.length,1);assert.equal(next.getCompletion(op.id).rounds[0].candidate.id,before.rounds[0].candidate.id);
  assert.equal(result.aiCalls,boundary==='candidate-result'?1:0);assert.ok(sent>=1);
});

test('pause after a result commits retains evidence but cannot adopt before explicit continuation',async t=>{
  const f=await fixture(t),controller=new AbortController();f.amazon.previewDraft=async()=>{const draft=f.amazon.getDraft(f.draft.id);return{...draft,state:draft.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:draft.fieldAdoptions?.length?[]:[issue]};};
  const op=f.listing.beginCompletion(f.reference),fields=f.ai.listingFields.bind(f.ai);
  f.ai.listingFields=async(...args)=>{const result=await fields(...args);if(args[2])controller.abort();return result;};
  await assert.rejects(f.listing.complete(f.reference,controller.signal,op.id));assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length??0,0);assert.equal(f.requests.length,2);
  assert.equal(f.listing.completionUnknown(op.id),false);
  await f.listing.complete(f.reference,undefined,op.id);assert.equal(f.requests.length,2);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length,1);
});

for(const change of ['policy','source','draft'] as const)test(`pending operation rejects changed ${change} and cannot be bypassed with a new operation`,async t=>{
  const f=await fixture(t);f.amazon.previewDraft=async()=>{throw new Error('preview offline');};
  await assert.rejects(f.listing.complete(f.reference));const op=f.listing.completionOperations(f.draft.id)[0];
  if(change==='source')f.store.saveProduct({...saveInput(f.product),title:'Changed source'});
  if(change==='draft')f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:f.draft.attributes});
  const service=new ListingAiService(f.store,f.amazon,f.ai,()=>change!=='policy');
  await assert.rejects(service.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision}));
  assert.equal(f.requests.length,0);assert.equal(service.completionOperations(f.draft.id).length,1);assert.equal(service.getCompletion(op.id).rounds.length,0);
});

test('restart after two rejected reviews preserves the entire 2+2 budget',async t=>{
  const f=await fixture(t);f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]});
  f.respond(payload=>chat(payload.candidate?{...reviewFor(payload),verdict:'NEEDS_CHANGES',issues:[{field:'material',message:'Needs another wording'}]}:candidateFor(payload)));
  const op=f.listing.beginCompletion(f.reference),fields=f.ai.listingFields.bind(f.ai);let reviews=0;
  f.ai.listingFields=async(...args)=>{const result=await fields(...args);if(args[2]&&++reviews===2)throw new Error('stop after second review result');return result;};
  await assert.rejects(f.listing.complete(f.reference,undefined,op.id));assert.equal(f.requests.length,4);
  const result=await new ListingAiService(f.store,f.amazon,f.ai).complete(f.reference,undefined,op.id);
  assert.equal(f.requests.length,4);assert.equal(result.aiCalls,0);assert.ok(result.remaining.length);assert.equal(f.listing.getCompletion(op.id).rounds.length,2);
});

test('overlapping completion coordinators cannot overwrite a sent round with an older preview snapshot',async t=>{
  const f=await fixture(t);let releasePreview!:()=>void,previewEntered!:()=>void,releaseFetch!:()=>void,fetchEntered!:()=>void,previews=0;
  const heldPreview=new Promise<void>(r=>releasePreview=r),beganPreview=new Promise<void>(r=>previewEntered=r),heldFetch=new Promise<void>(r=>releaseFetch=r),beganFetch=new Promise<void>(r=>fetchEntered=r);
  f.amazon.previewDraft=async()=>{if(++previews===1){previewEntered();await heldPreview;}return{...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]};};
  f.respond(async()=>{fetchEntered();await heldFetch;throw new Error('lost concurrent reply');});
  const first=f.listing.complete(f.reference).catch(error=>error);await beganPreview;
  const secondAi=new AiService(f.directory,f.store,f.hosting,mockStorage,{fetch:(f.ai as any).context.fetch});
  const second=new ListingAiService(f.store,f.amazon,secondAi).complete(f.reference).catch(error=>error);await beganFetch;
  releasePreview();await new Promise<void>(resolve=>setImmediate(resolve));releaseFetch();await Promise.all([first,second]);await secondAi.close();
  assert.equal(f.requests.length,1);const op=f.listing.completionOperations(f.draft.id)[0];assert.equal(op.rounds.length,1);assert.equal(op.rounds[0].candidate.sent,true);
});

test('a real child process crash preserves paid history and bounded retries on process restart',async t=>{
  const f=await fixture(t);await f.ai.close();
  const run=(mode:string)=>spawnSync(process.execPath,['tests/fixtures/completion-crash.ts',f.directory,f.draft.id,mode],{encoding:'utf8',timeout:20000,windowsHide:true});
  const crash=run('crash');assert.equal(crash.status,73,crash.stderr);assert.equal(crash.stdout.trim(),'FETCH_ENTERED');
  for(let n=0;n<3;n++){const restart=run('recover');assert.equal(restart.status,0,restart.stderr);assert.equal(restart.stdout.trim(),n<2?'FETCH_ENTERED\nUNKNOWN_PRESERVED':'UNKNOWN_PRESERVED');}
  const db=openDatabase(f.directory);try{assert.equal(db.prepare('SELECT id FROM ai_calls').all().length,3);assert.equal(db.prepare('SELECT id FROM ai_usage_ledger').all().length,3);assert.equal(db.prepare('SELECT id FROM ai_results').all().length,0);}finally{db.close();}
});

test('a transport timeout after entering fetch is UNKNOWN after restarting the AI service',async t=>{
  const f=await fixture(t);await f.ai.close();let posts=0;
  let ai=new AiService(f.directory,f.store,f.hosting,mockStorage,{timeoutMs:30,fetch:async()=>{posts++;return new Promise<Response>(()=>{});}});
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]});
  try{
    await assert.rejects(new ListingAiService(f.store,f.amazon,ai).complete(f.reference),(error:any)=>error.code==='TIMEOUT');assert.equal(posts,1);assert.equal(ai.listCalls()[0].errorCode,'TIMEOUT');await ai.close();
    ai=new AiService(f.directory,f.store,f.hosting,mockStorage,{fetch:async()=>{posts++;throw new Error('Unexpected replay');}});
    await assert.rejects(new ListingAiService(f.store,f.amazon,ai).complete(f.reference));assert.equal(posts,2);
  }finally{await ai.close();}
});

test('pause inside adoption freshness prevents the final draft write',async t=>{
  const f=await fixture(t),controller=new AbortController(),getSchema=f.amazon.getSchema.bind(f.amazon);let enteringAdoption=false;
  const adopt=f.listing.adopt.bind(f.listing);f.listing.adopt=async(...args)=>{enteringAdoption=true;return adopt(...args);};
  f.amazon.getSchema=async raw=>{const schema=await getSchema(raw);if(enteringAdoption)controller.abort();return schema;};
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]});
  await assert.rejects(f.listing.complete(f.reference,controller.signal));assert.equal(f.requests.length,2);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length??0,0);
});

test('real confirmed-declaration revision and journal checkpoint commit together before a thrown upper-layer continuation',async t=>{
  const f=await fixture(t),target=f.amazon.getTarget(f.draft.targetId),selection={targetId:target.id,productType:'FIGURINE',parentageLevel:'PARENT' as const,requirements:'LISTING' as const,locale:'en_US'};
  f.amazon.getSchema=async()=>({...realParentAmazonSchema(),...selection,key:schemaKey(target,selection)});
  const fact={id:randomUUID(),name:'batteries_required',value:'false',state:'human_confirmed' as const,source:'manual' as const,sourceRef:'Explicit synthetic declaration'};
  f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,fact]});
  const created=await f.amazon.createDraft({...selection,productId:f.product.id,variantId:f.product.variants[0].id,listingProgram:'haul'});
  assert.ok(created.attributes.batteries_required,'confirmed source supplies the original declaration');
  const attributes={...created.attributes};delete attributes.batteries_required;
  const saved=f.amazon.saveDraft({id:created.id,revision:created.revision,attributes}),reference={draftId:saved.id,draftRevision:saved.revision},op=f.listing.beginCompletion(reference),defaults=f.amazon.applyBusinessDefaults.bind(f.amazon);
  let stopped=false;f.amazon.applyBusinessDefaults=(...args)=>{const draft=defaults(...args);if(!stopped){stopped=true;throw new Error('stopped after default transaction');}return draft;};
  await assert.rejects(f.listing.complete(reference,undefined,op.id),/stopped after/);const advanced=f.amazon.getDraft(saved.id);
  assert.deepEqual(advanced.attributes.batteries_required,created.attributes.batteries_required);
  assert.deepEqual(advanced.sourceMapping!.find(mapping=>mapping.field===fact.name)!.sourceFactIds,[fact.id]);
  assert.equal(advanced.revision,saved.revision+1);assert.equal(f.listing.getCompletion(op.id).draftRevision,advanced.revision);assert.equal(f.requests.length,0);
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(saved.id),state:'AMAZON_VALIDATED',previewIssues:[]});
  await new ListingAiService(f.store,f.amazon,f.ai).complete({draftId:saved.id,draftRevision:advanced.revision},undefined,op.id);assert.equal(f.requests.length,0);assert.equal(f.listing.getCompletion(op.id).state,'DONE');
});

test('preview activation of a schema optional category field preserves stable operation scope while no supported candidate is returned',async t=>{
  const f=await fixture(t,{closure:{type:'array',items:{type:'object',properties:{value:{type:'string',enum:['Zipper']}},required:['value'],additionalProperties:false}}});
  const db=openDatabase(f.directory);try{const row=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id)!;const record=JSON.parse(String(row.record_json));record.draft.previewIssues=[];db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(record),f.draft.id);}finally{db.close();}
  const op=f.listing.beginCompletion(f.reference);let previews=0;
  f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id),next={...d,state:++previews===1?'BLOCKED' as const:'AMAZON_VALIDATED' as const,previewIssues:previews===1?[{...issue,attributeNames:['closure']}]:[]};const db=openDatabase(f.directory);try{const r=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(d.id)!.record_json));r.draft=next;db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(r),d.id);}finally{db.close();}return next;};
  f.respond(payload=>chat(payload.candidate?reviewFor(payload):{kind:'amazon-fields',candidates:[],missing:[{field:'closure',reason:'No supported closure evidence'}]}));
  const result=await f.listing.complete(f.reference,undefined,op.id);assert.equal(f.requests.length,1);assert.ok(result.remaining.length);assert.equal(f.listing.getCompletion(op.id).scopeHash,op.scopeHash);
});

test('encrypted backup roundtrip retains operations and old snapshot restores only a no-resend guard',async t=>{
  const f=await fixture(t),file=join(f.directory,'before.htcbackup'),after=join(f.directory,'after.htcbackup'),pass='isolated completion backup';
  await createWorkspaceBackup(f.directory,file,pass);
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]});f.respond(()=>{throw new Error('lost reply');});await assert.rejects(f.listing.complete(f.reference));
  const op=f.listing.completionOperations(f.draft.id)[0];await createWorkspaceBackup(f.directory,after,pass);
  const recent=await prepareWorkspaceRestore(f.directory,after,pass),recentDb=openDatabase(recent.stagingDirectory);assert.equal(JSON.parse(String(recentDb.prepare('SELECT record_json FROM listing_completion_operations WHERE id=?').get(op.id)!.record_json)).id,op.id);recentDb.close();
  const old=await prepareWorkspaceRestore(f.directory,file,pass),db=openDatabase(old.stagingDirectory);
  // Restore commit merges local safety history, covered by a real commit in the owner/restore fixture.
  const retained=JSON.parse(String(db.prepare('SELECT record_json FROM listing_completion_operations WHERE id=?').get(op.id)!.record_json));assert.equal(retained.state,'GUARD');assert.equal(retained.rounds[0].candidate.sent,true);assert.equal(retained.rounds[0].candidate.resultId,null);db.close();
});

test('preview failure keeps the same operation and consumes no field call budget',async t=>{
  const f=await fixture(t);f.amazon.previewDraft=async()=>{throw new Error('preview offline');};
  await assert.rejects(f.listing.complete(f.reference),/preview offline/);
  assert.equal(f.requests.length,0);
  const db=openDatabase(f.directory);
  const before=db.prepare('SELECT id,record_json FROM listing_completion_operations').all();
  assert.equal(before.length,1);assert.deepEqual(JSON.parse(String(before[0].record_json)).rounds,[]);
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'AMAZON_VALIDATED',previewIssues:[]});
  await new ListingAiService(f.store,f.amazon,f.ai).complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision});
  const after=db.prepare('SELECT id,record_json FROM listing_completion_operations').all();
  assert.deepEqual(after.map(row=>row.id),before.map(row=>row.id));assert.equal(JSON.parse(String(after[0].record_json)).state,'DONE');db.close();
});
