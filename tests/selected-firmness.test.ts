import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedFirmnessCorrection } from '../src/main/listing-ai/selected-firmness.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
function proof(){
 const generic={id:'generic',name:'功能',value:'软毛',meaning:'general',source:'source_confirmed'};
 const context:any={variantId:'selected',evidence:[{id:'selected:spec',source:'selected_sku',value:'颜色: 卡白983（硬毛） · 1 pc'}]};
 const oldContext:any={variantId:'selected',evidence:[generic]};const hash=listingFingerprint(oldContext);
 const value=[{value:'Soft Bristles',marketplace_id:'US',language_tag:'en_US'}];
 const adoption:any={id:'adoption',suggestionResultId:'result',contextSha256:hash,changes:[{field:'special_feature',after:value,evidence:[generic]}]};
 const draft:any={variantId:'selected',attributes:{special_feature:value},fieldAdoptions:[adoption]};
 const result:any={id:'result',sourceSha256:hash,listingContext:oldContext,output:{kind:'amazon-fields',candidates:[{field:'special_feature',items:[{value:'Soft Bristles',evidenceIds:['generic']}]}]}};
 return {draft,context,result};
}
test('only proven old single soft feature becomes hard preserving metadata and history',()=>{
 const f=proof(),before=structuredClone(f);const correction=selectedFirmnessCorrection(f.draft,f.context,()=>f.result);
 assert.deepEqual(correction?.after,[{value:'Hard Bristles',marketplace_id:'US',language_tag:'en_US'}]);assert.equal(correction?.adoptionId,'adoption');assert.deepEqual(f,before);
});
for(const spec of ['颜色: 软毛','颜色: 非硬毛','颜色: 不是硬毛','颜色: 硬毛或软毛','颜色: 硬毛/中毛','颜色: 硬毛?','颜色: 卡白983','颜色: 不确定（硬毛）','not（硬毛）','Soft（硬毛）'])test(`ambiguous selected spec remains untouched: ${spec}`,()=>{const f=proof();f.context.evidence[0].value=spec;assert.equal(selectedFirmnessCorrection(f.draft,f.context,()=>f.result),null);});
for(const kind of ['multiple','sentence','missing-result','bad-hash','unproven','wrong-sku','extra-key'])test(`does not correct ${kind}`,()=>{const f=proof();if(kind==='multiple')f.draft.attributes.special_feature.push({value:'Portable'});if(kind==='sentence')f.draft.attributes.special_feature[0].value='Soft Bristles for gentle cleaning';if(kind==='bad-hash')f.result.sourceSha256='bad';if(kind==='unproven')f.result.output.candidates[0].items[0].evidenceIds=[];if(kind==='wrong-sku')f.context.evidence[0].id='other:spec';if(kind==='extra-key')f.draft.attributes.special_feature[0].other='Soft';assert.equal(selectedFirmnessCorrection(f.draft,f.context,()=>kind==='missing-result'?undefined:f.result),null);});

import { fixture } from './fixtures/listing-ai.ts';
import { completionDraftStamp } from '../src/main/listing-ai/completion-journal.ts';
async function migrationFixture(t:test.TestContext){
 const f=await fixture(t,{special_feature:{type:'array',items:{type:'object',properties:{value:{type:'string'}}}}}),p=(f.amazon as any).persistence,r=p.record(f.draft.id);
 r.draft.attributes.special_feature=[{value:'Soft Bristles',marketplace_id:r.draft.marketplaceId,language_tag:'en_US'}];p.putRecord(r);
 const op=f.listing.beginCompletion(f.reference);op.state='DONE';op.remaining=['special_feature conflict'];f.ai.completionJournal.save(op);
 const evidence=proof();evidence.draft.attributes.special_feature=structuredClone(r.draft.attributes.special_feature);evidence.draft.fieldAdoptions[0].changes[0].after=structuredClone(r.draft.attributes.special_feature);
 const correction=selectedFirmnessCorrection(evidence.draft,evidence.context,()=>evidence.result)!;
 return {...f,p,op,correction};
}
test('local DONE migration atomically preserves history, updates journal, and is idempotent',async t=>{
 const f=await migrationFixture(t),before=f.p.record(f.draft.id);
 const updated=f.amazon.migrateSelectedFirmness({id:f.draft.id,revision:f.draft.revision},f.op.id,()=>f.correction,()=>[]);
 assert.equal((updated.attributes.special_feature as any)[0].value,'Hard Bristles');assert.equal(updated.revision,before.draft.revision+1);
 const op=f.ai.completionJournal.get(f.op.id);assert.equal(op.draftStamp,completionDraftStamp(updated));assert.deepEqual(op.remaining,[]);assert.deepEqual(op.rounds,f.op.rounds);assert.deepEqual(updated.fieldAdoptions,before.draft.fieldAdoptions);
 assert.equal(f.amazon.migrateSelectedFirmness({id:updated.id,revision:updated.revision},op.id,()=>null,()=>[]).revision,updated.revision);
 assert.equal(f.p.db.prepare("SELECT count(*) n FROM audit_events WHERE action='listing.selected-firmness-corrected'").get().n,1);assert.equal(f.requests.length,0);
});
for(const guard of ['submitted','unknown','stamp','source','lock','audit-abort'])test(`local correction refuses or rolls back ${guard}`,async t=>{
 const f=await migrationFixture(t),r=f.p.record(f.draft.id);
 if(guard==='submitted')r.draft.submittedAt=new Date().toISOString();if(guard==='unknown')r.unresolvedWrite=true;if(guard==='source')r.draft.productRevision++;if(guard==='stamp')r.draft.attributes.color=[{value:'Changed'}];if(guard==='lock')f.p.locked=()=>true;f.p.putRecord(r);
 if(guard==='audit-abort')f.p.db.exec("CREATE TRIGGER abort_firmness BEFORE INSERT ON audit_events WHEN NEW.action='listing.selected-firmness-corrected' BEGIN SELECT RAISE(ABORT,'interruption'); END");
 const before=f.p.record(f.draft.id),op=f.ai.completionJournal.get(f.op.id);
 assert.throws(()=>f.amazon.migrateSelectedFirmness({id:r.draft.id,revision:r.draft.revision},op.id,()=>f.correction,()=>[]));assert.deepEqual(f.p.record(r.draft.id),before);assert.deepEqual(f.ai.completionJournal.get(op.id),op);assert.equal(f.requests.length,0);
});

import { completionOwnerFixture } from './fixtures/completion-owners.ts';
import { imageWorkflowDraftStamp } from '../src/main/image-workflow/records.ts';
for(const hasRepair of [false,true])test(`automatic owner ${hasRepair?'with checkpoint':'repair=null'} stays consistent after local migration`,async t=>{
 const f=await completionOwnerFixture(t,'automatic'),p=(f.amazon as any).persistence,r=p.record(f.draft.id);
 r.draft.attributes.special_feature=[{value:'Soft Bristles'}];p.putRecord(r);
 const op=f.listing.beginCompletion(f.reference());op.state='DONE';f.ai.completionJournal.save(op);
 const saved=p.db.prepare('SELECT id,record_json FROM automatic_listing_tasks').get(),task=JSON.parse(saved.record_json),row=task.items[0];
 row.repair=hasRepair?{...row.repair,operationId:op.id,draftRevision:r.draft.revision,draftStamp:imageWorkflowDraftStamp(r.draft)}:null;row.repairAttempts=0;p.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),saved.id);
 const original=String(p.db.prepare('SELECT record_json FROM automatic_listing_tasks').get().record_json);
 const evidence=proof(),correction=selectedFirmnessCorrection(evidence.draft,evidence.context,()=>evidence.result)!;
 const updated=f.amazon.migrateSelectedFirmness({id:r.draft.id,revision:r.draft.revision},op.id,()=>correction,()=>[]);
 const current=JSON.parse(p.db.prepare('SELECT record_json FROM automatic_listing_tasks').get().record_json);
 assert.equal(current.items[0].repairAttempts,0);
 if(hasRepair){assert.equal(current.items[0].repair.draftRevision,updated.revision);assert.equal(current.items[0].repair.draftStamp,imageWorkflowDraftStamp(updated));}else assert.equal(JSON.stringify(current),original);
 await f.reopen();assert.equal((f.progress() as any).repair?.draftRevision,hasRepair?updated.revision:undefined);assert.equal(f.requests.length,0);
});
test('automatic DONE repair interruption restores committed checkpoint in place',async t=>{
 const f=await completionOwnerFixture(t,'automatic'),p=(f.amazon as any).persistence,r=p.record(f.draft.id);r.draft.attributes.special_feature=[{value:'Soft Bristles'}];p.putRecord(r);
 const op=f.listing.beginCompletion(f.reference());op.state='DONE';f.ai.completionJournal.save(op);
 const saved=p.db.prepare('SELECT id,record_json FROM automatic_listing_tasks').get(),task=JSON.parse(saved.record_json);task.items[0].repairAttempts=1;Object.assign(task.items[0].repair,{operationId:op.id,phase:'FIELDS_STARTED',draftRevision:r.draft.revision,draftStamp:imageWorkflowDraftStamp(r.draft)});p.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),saved.id);await f.reopen();
 const owner:any=f.ownerService(),live=owner.tasks.get(saved.id),row=live.items[0],items=live.items,evidence=proof(),correction=selectedFirmnessCorrection(evidence.draft,evidence.context,()=>evidence.result)!;
 owner.deps.repairFields=async()=>{f.amazon.migrateSelectedFirmness({id:r.draft.id,revision:r.draft.revision},op.id,()=>correction,()=>[]);throw Error('after local commit');};
 await assert.rejects(f.run(),/after local commit/);assert.equal(live.items,items);assert.equal(live.items[0],row);assert.equal(row.repair.draftRevision,r.draft.revision+1);
 assert.equal(JSON.parse(p.db.prepare('SELECT record_json FROM automatic_listing_tasks').get().record_json).items[0].repair.draftRevision,r.draft.revision+1);assert.equal(f.requests.length,0);
});
