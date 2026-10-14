import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,chat} from './fixtures/listing-ai.ts';
import {ListingAiService} from '../src/main/listing-ai/service.ts';
import {openDatabase} from '../src/main/database.ts';
import {validateStoredAiResult} from '../src/main/ai/validation.ts';
const shape={type:'array',items:{type:'object',properties:{value:{type:'string'}}}};
test('local replay adopts a retained reference-rejected field without changing original result or paid records',async t=>{
 const f=await fixture(t,{item_shape:shape}),listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false),asset=f.product.assets[0].id;
 f.respond(()=>chat({kind:'amazon-fields',candidates:[{field:'item_shape',nativeValue:[{value:'Round'}],evidenceIds:[asset],transformation:'infer',inferenceReason:'Visible shape in supplied photo.'}],missing:[]}));
 const original=await listing.suggest(f.reference);if(original.output.kind!=='amazon-fields')throw Error('fixture');
 original.output={...original.output,rejectedCandidates:original.output.candidates,candidates:[],missing:[{field:'item_shape',reason:'[FIELD_REFERENCE] supplied image ID rejected by old parser'}]};
 const db=openDatabase(f.directory);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(original),original.id);db.close();
 const before=JSON.stringify(original),calls=JSON.stringify(f.ai.listCalls()),draftBefore=f.amazon.getDraft(f.draft.id);
 const result=await (listing as any).recoverRetainedFieldCandidates(f.reference);
 assert.deepEqual(result.draft.attributes.item_shape,[{value:'Round'}]);assert.equal(result.recoveredFields[0],'item_shape');assert.equal(f.requests.length,1);assert.equal(JSON.stringify(f.ai.getResult(original.id)),before);assert.equal(JSON.stringify(f.ai.listCalls()),calls);
 const derived=f.ai.listResults(f.product.id).find(r=>r.fieldCandidateRecovery)!;assert.ok(derived);assert.equal(derived.sourceResultIds[0],original.id);assert.equal(derived.createdAt,original.createdAt);assert.equal(derived.listingContext!.draftRevision,draftBefore.revision);
 const adoptionEvents=()=>((f.ai as any).db.prepare("SELECT detail_json FROM audit_events WHERE action='run.evidence' AND json_extract(detail_json,'$.event')='RESULT_ADOPTED'").all() as {detail_json:string}[]).map(row=>JSON.parse(row.detail_json));
 assert.equal(adoptionEvents().length,1);assert.equal(adoptionEvents()[0].callId,original.callId);assert.equal(adoptionEvents()[0].draftId,result.draft.id);
 const again=await (listing as any).recoverRetainedFieldCandidates({draftId:result.draft.id,draftRevision:result.draft.revision});assert.equal(again.recoveredFields.length,0);assert.equal(f.requests.length,1);
 assert.equal(adoptionEvents().length,1,'repeated local recovery must not invent another adoption');
 const altered=structuredClone(derived);(altered.output as any).candidates[0].nativeValue=[{value:'Square'}];assert.throws(()=>validateStoredAiResult(altered));
 await assert.doesNotReject(()=>listing.snapshotCurrentForImages({draftId:result.draft.id,draftRevision:result.draft.revision}));
});

async function retained(t:test.TestContext){
 const f=await fixture(t,{item_shape:shape}),listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false),asset=f.product.assets[0].id;
 f.respond(()=>chat({kind:'amazon-fields',candidates:[{field:'item_shape',nativeValue:[{value:'Round'}],evidenceIds:[asset],transformation:'infer',inferenceReason:'Visible source outline.'}],missing:[]}));
 const results=[];for(let i=0;i<2;i++){const r=await listing.suggest(f.reference);if(r.output.kind!=='amazon-fields')throw Error('fixture');r.output={...r.output,rejectedCandidates:r.output.candidates,candidates:[],missing:[{field:'item_shape',reason:'[FIELD_REFERENCE] legacy rejection'}]};const db=openDatabase(f.directory);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(r),r.id);db.close();results.push(r);}
 return {...f,listing,results};
}
test('DONE exhausted rounds recover locally with an atomic owner checkpoint, and preserve errors and backup provenance',async t=>{
 const f=await retained(t),op=f.listing.beginCompletion(f.reference);
 op.rounds=f.results.map((r,i)=>({context:r.listingContext!,contextHash:r.sourceSha256!,candidate:{id:r.callId,sent:true,resultId:r.id},review:null,resolved:i===0,adoptionId:null}));op.state='DONE';op.remaining=['item_shape: [FIELD_REFERENCE] legacy rejection'];f.ai.completionJournal.save(op);
 const rounds=JSON.stringify(op.rounds),calls=JSON.stringify(f.ai.listCalls());
 const result=await f.listing.complete(f.reference,undefined,op.id);
 assert.deepEqual(result.draft.attributes.item_shape,[{value:'Round'}]);assert.equal(result.aiCalls,0);assert.equal(f.requests.length,2);assert.equal(JSON.stringify(f.ai.listCalls()),calls);
 const after=f.ai.completionJournal.get(op.id);assert.equal(JSON.stringify(after.rounds),rounds);assert.equal(after.draftRevision,result.draft.revision);
 const {createWorkspaceBackup,prepareWorkspaceRestore}=await import('../src/main/backup.ts');const {join}=await import('node:path');const file=join(f.directory,'recovery.htcbackup');await createWorkspaceBackup(f.directory,file,'offline recovery fixture password');await prepareWorkspaceRestore(join(f.directory,'restored'),file,'offline recovery fixture password');
});
test('adoption failure rolls draft and owner back while retaining the replayable original',async t=>{
 const f=await retained(t),op=f.listing.beginCompletion(f.reference);op.state='DONE';f.ai.completionJournal.save(op);
 const old=f.amazon.getDraft(f.draft.id),owner=JSON.stringify(f.ai.completionJournal.get(op.id)),adopt=f.amazon.adoptFields.bind(f.amazon);
 f.amazon.adoptFields=(input,attrs,receipt,fresh,preserve,checkpoint)=>adopt(input,attrs,receipt,fresh,preserve,(d,db)=>{checkpoint?.(d,db);throw Error('fixture save failure');});
 assert.throws(()=>f.listing.recoverRetainedFieldCandidates(f.reference),/fixture save failure/);
 assert.equal((f.ai as any).db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='run.evidence' AND json_extract(detail_json,'$.event')='RESULT_ADOPTED'").get().n,0,'adoption evidence rolls back with the draft and owner');
 assert.deepEqual(f.amazon.getDraft(old.id),old);assert.equal(JSON.stringify(f.ai.completionJournal.get(op.id)),owner);assert.equal(f.requests.length,2);
 f.amazon.adoptFields=adopt;assert.deepEqual(f.listing.recoverRetainedFieldCandidates(f.reference).recoveredFields,['item_shape']);assert.equal(f.requests.length,2);
});
test('enabled review or submitted draft cannot silently adopt locally replayed candidates',async t=>{
 const f=await retained(t),reviewed=new ListingAiService(f.store,f.amazon,f.ai,()=>true);
 assert.deepEqual(reviewed.recoverRetainedFieldCandidates(f.reference).recoveredFields,[]);
 const get=f.amazon.getDraft.bind(f.amazon);f.amazon.getDraft=id=>({...get(id),state:'UNKNOWN'});assert.throws(()=>f.listing.recoverRetainedFieldCandidates(f.reference),/已提交/);assert.equal(f.requests.length,2);
});

test('one DONE continuation recovers every compatible retained response without another user retry',async t=>{
 const f=await fixture(t,{item_shape:shape,pattern:shape}),listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false);
 for(const [field,value] of [['item_shape','Round'],['pattern','Solid']]){
  f.respond(()=>chat({kind:'amazon-fields',candidates:[{field,nativeValue:[{value}],evidenceIds:[f.product.assets[0].id],transformation:'infer',inferenceReason:'Visible source'}],missing:[]}));
  const r=await listing.suggest(f.reference);if(r.output.kind!=='amazon-fields')throw Error('fixture');r.output={...r.output,rejectedCandidates:r.output.candidates,candidates:[],missing:[{field,reason:'[FIELD_REFERENCE] legacy'}]};const db=openDatabase(f.directory);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(r),r.id);db.close();
 }
 const op=listing.beginCompletion(f.reference);op.state='DONE';f.ai.completionJournal.save(op);const done=await listing.complete(f.reference,undefined,op.id);
 assert.deepEqual(done.draft.attributes.item_shape,[{value:'Round'}]);assert.deepEqual(done.draft.attributes.pattern,[{value:'Solid'}]);assert.equal(listing.hasRetainedFieldReferences(done.draft),false);assert.equal(done.aiCalls,0);assert.equal(f.requests.length,2);
});

test('local replay revisits an original when another response unlocks a dependent candidate',async t=>{
 const f=await fixture(t,{item_shape:shape,pattern:shape,style:shape}),listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false),p=(f.amazon as any).persistence,record=p.record(f.draft.id);
 record.draft.schema.schema.dependentRequired={pattern:['item_shape'],style:['pattern']};p.putRecord(record);f.amazon.getSchema=async()=>structuredClone(record.draft.schema);
 for(const fields of [['item_shape','style'],['pattern']]){
  f.respond(()=>chat({kind:'amazon-fields',candidates:fields.map(field=>({field,nativeValue:[{value:'Round'}],evidenceIds:[f.product.assets[0].id],transformation:'infer',inferenceReason:'Visible source'})),missing:[]}));
  const r=await listing.suggest(f.reference);if(r.output.kind!=='amazon-fields')throw Error('fixture');const rejected=[...r.output.candidates,...r.output.rejectedCandidates??[]];r.output={...r.output,rejectedCandidates:rejected,candidates:[],missing:fields.map(field=>({field,reason:'[FIELD_REFERENCE] legacy'}))};delete r.fieldRejections;const db=openDatabase(f.directory);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(r),r.id);db.close();
 }
 const result=listing.recoverRetainedFieldCandidates(f.reference);assert.deepEqual(new Set(result.recoveredFields),new Set(['item_shape','pattern','style']));assert.equal(listing.hasRetainedFieldReferences(result.draft),false);assert.equal(f.requests.length,2);
});
