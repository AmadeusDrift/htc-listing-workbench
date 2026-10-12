import { completionOwnerFixture } from './fixtures/completion-owners.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, chat } from './fixtures/listing-ai.ts';
import { CompletionJournal, completionDraftStamp, completionSafetyIdentity, completionSafetyScope } from '../src/main/listing-ai/completion-journal.ts';
import { imageWorkflowDraftStamp } from '../src/main/image-workflow/records.ts';


const reason='仅推断候选可以携带推断理由；已保留其他合格字段';
async function setup(t:any){
 const f=await fixture(t,{theme:{type:'array',items:{type:'object',properties:{value:{type:'string'}},required:['value']}}});
 const context=f.listing.currentContext(f.draft,f.product,0,true);context.fields=context.fields.filter(x=>x.name==='theme');context.repairRequest={issues:[{field:'theme',code:'90220',message:'Missing theme'}],currentValues:{theme:null}};
 f.respond(()=>chat({kind:'amazon-fields',candidates:[],missing:[{field:'theme',reason}]}));
 const result=await f.ai.listingFields(context,async()=>{},undefined);
 const workflow:any={id:randomUUID(),draftId:f.draft.id,productId:f.draft.productId,productRevision:f.draft.productRevision,variantId:f.draft.variantId,sku:f.draft.sku,status:'COMPLETED',stage:'complete',approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64),slots:Array.from({length:7},()=>({status:'PASSED',approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64)}))};
 const row:any={draftId:f.draft.id,repairAttempts:4,repairPolicyMigration:{grantedAttempts:1},sourceColorRepair:{grantedAttempts:1},categoryFieldPolicyVersion:'category-inference/v1',imageStarted:true,repair:{phase:'FIELDS_PENDING',sourceWorkflowId:workflow.id,draftRevision:f.draft.revision,draftStamp:imageWorkflowDraftStamp(f.draft)}};
 const input={draftId:f.draft.id,scopeHash:'b'.repeat(64),safetyScopeHash:completionSafetyScope(f.draft),safetyIdentity:completionSafetyIdentity(f.draft),copyReviewEnabled:true,draftRevision:f.draft.revision,draftStamp:completionDraftStamp(f.draft)};
 const db=(f.ai as any).db;const journal=new CompletionJournal(db,f.directory);
 return {...f,context,result,workflow,row,input,db,journal,begin:()=>journal.beginLegacyThemeRepair(input,f.draft,context,row,workflow)};
}
test('legacy finite-parser loss creates exactly one scoped successor and preserves history',async t=>{
 const f=await setup(t),before=f.db.prepare('select record_json from ai_results').all();
 const op=f.begin();assert.ok(op);assert.deepEqual(op.scopedRepair?.fields,['theme']);assert.equal(op.scopedRepair?.sourceResultId,f.result.id);assert.equal(f.begin()?.id,op.id);assert.equal(f.journal.list(f.draft.id).length,1);assert.deepEqual(f.db.prepare('select record_json from ai_results').all(),before);assert.equal(f.row.repairAttempts,4);
});
for(const change of ['ordinary','similar','source','present','unknown','candidate','images'])test(`legacy repair refuses ${change}`,async t=>{
 const f=await setup(t);
 if(change==='ordinary')f.row.repairAttempts=2;
 if(change==='similar'){const result=structuredClone(f.result);(result.output as any).missing[0].reason=reason+'!';f.db.prepare('update ai_results set record_json=? where id=?').run(JSON.stringify(result),result.id);}
 if(change==='source')f.context.unverifiedSourceTitle+='changed';
 if(change==='present')f.draft.attributes.theme=[{value:'Existing'}];
 if(change==='unknown'){const call=f.ai.getCall(f.result.callId)!;call.status='RUNNING';call.finishedAt=null;f.db.prepare('update ai_calls set record_json=? where id=?').run(JSON.stringify(call),call.id);}
 if(change==='candidate'){
   const context=f.listing.currentContext(f.draft,f.product,0);
   f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'theme',nativeValue:[{value:'Coaster'}],evidenceIds:[],transformation:'infer',inferenceReason:'Category inferred from the source product'}],missing:[]}));
   await f.ai.listingFields(context,async()=>{},undefined);
 }
 if(change==='images')f.workflow.slots.pop();
 assert.equal(f.begin(),undefined);assert.equal(f.journal.list(f.draft.id).length,0);
});



async function automaticLegacy(t:any){
 const f=await completionOwnerFixture(t,'automatic',false,false,'Blue',true);
 const context=f.listing.currentContext(f.draft,f.product,1,true);context.fields=context.fields.filter(x=>x.name==='theme');context.repairRequest={issues:[{field:'theme',code:'90220',message:'Missing theme'}],currentValues:{theme:null}};
 f.respond(()=>chat({kind:'amazon-fields',candidates:[],missing:[{field:'theme',reason}]}));await f.ai.listingFields(context,async()=>{},undefined);
 const service=f.ownerService() as any,task=[...service.tasks.values()][0] as any,row=task.items[0],at=new Date().toISOString();
 Object.assign(row,{repairAttempts:4,repairPolicyMigration:{version:'field-evidence/v2',previousAttempts:2,grantedAttempts:1,grantedAt:at,fields:['theme']},sourceColorEvidenceSha256:'c'.repeat(64),sourceColorRepair:{previousAttempts:3,grantedAttempts:1,grantedAt:at,evidenceSha256:'c'.repeat(64)}});service.save(task);
 const before=structuredClone(f.amazon.getDraft(f.draft.id));
 f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'theme',nativeValue:[{value:'Nature'}],evidenceIds:[],transformation:'infer',inferenceReason:'A broad product theme from the source'},{field:'material',nativeValue:[{value:'Wood'}],evidenceIds:[],transformation:'infer'}],missing:[]}));
 return {...f,before};
}
test('automatic owner consumes one scoped grant before send; resume preserves old attempts/images/history and rechecks',async t=>{
 const f=await automaticLegacy(t),initialCalls=f.ai.listCalls().length,images=structuredClone((f.ownerService() as any).deps.images.getProgress(f.draft.id));
 let intercepted=false;const fields=f.ai.listingFields.bind(f.ai);
 f.ai.listingFields=async(...args)=>{const result=await fields(...args);if(!intercepted){intercepted=true;throw Error('after scoped result');}return result;};
 await assert.rejects(f.run(),/after scoped result/);
 const row=f.progress() as any;assert.equal(row.repairAttempts,5);assert.deepEqual(row.legacyThemeRepair.fields,['theme']);assert.equal(row.sourceColorRepair.previousAttempts,3);assert.equal(row.repairPolicyMigration.previousAttempts,2);
 const operation=f.listing.getCompletion(row.repair.operationId);assert.deepEqual(operation.rounds[0].context.fields.map(field=>field.name),['theme']);
 await f.reopen();await assert.rejects(f.run(),/Downstream image recheck sentinel/);
 assert.equal(f.ai.listCalls().length,initialCalls+1);assert.equal((f.progress() as any).repairAttempts,5);assert.equal((f.progress() as any).repair.phase,'RECHECK_PENDING');
 const draft=f.amazon.getDraft(f.draft.id);assert.deepEqual(draft.attributes.material,f.before.attributes.material);assert.equal((draft.attributes.theme as any)[0].value,'Nature');assert.deepEqual(draft.fieldAdoptions?.at(-1)?.fields,['theme']);
 assert.deepEqual((f.ownerService() as any).deps.images.getProgress(f.draft.id),images);
 await f.reopen();await assert.rejects(f.run(),/Downstream image recheck sentinel/);assert.equal(f.ai.listCalls().length,initialCalls+1);
});
test('successor created before owner checkpoint resumes once, with no duplicate grant',async t=>{
 const f=await automaticLegacy(t),service=f.ownerService() as any,begin=service.deps.beginLegacyThemeRepair;let stopped=false;
 service.deps.beginLegacyThemeRepair=(...args:any[])=>{const id=begin(...args);if(!stopped){stopped=true;throw Error('before owner checkpoint');}return id;};
 await assert.rejects(f.run(),/before owner checkpoint/);assert.equal((f.progress() as any).repairAttempts,4);const id=f.listing.completionOperations(f.draft.id)[0].id;
 await f.reopen();await assert.rejects(f.run(),/Downstream image recheck sentinel/);assert.equal(f.listing.completionOperations(f.draft.id).length,1);assert.equal((f.progress() as any).legacyThemeRepair.operationId,id);assert.equal((f.progress() as any).repairAttempts,5);
});
test('scoped operation retains its theme scope in both rounds and cannot adopt unrelated output',async t=>{
 const f=await automaticLegacy(t);let count=0;
 f.respond(()=>chat(++count===1?{kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[],missing:[{field:'theme',reason:'[FIELD_REFERENCE] Missing initial observation'}]}:{kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'theme',nativeValue:[{value:'Nature'}],evidenceIds:[],transformation:'infer'},{field:'material',nativeValue:[{value:'Wood'}],evidenceIds:[],transformation:'infer'}],missing:[]}));
 await assert.rejects(f.run(),/Downstream image recheck sentinel/);const op=f.listing.completionOperations(f.draft.id)[0];assert.equal(op.rounds.length,2);assert.ok(op.rounds.every(r=>r.context.fields.length===1&&r.context.fields[0].name==='theme'));assert.deepEqual(f.amazon.getDraft(f.draft.id).attributes.material,f.before.attributes.material);
 const resultId=op.rounds[1].candidate.resultId!;await assert.rejects(f.listing.adopt({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision,suggestionResultId:resultId,reviewResultId:null,fields:['material']}),/仅允许采纳 theme/);
});
test('scoped exhaustion preserves five attempts and cannot create a third round or another grant',async t=>{
 const f=await automaticLegacy(t);f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[],missing:[{field:'theme',reason:'[FIELD_REFERENCE] Still missing'}]}));
 await assert.rejects(f.run());const calls=f.ai.listCalls().length;assert.equal((f.progress() as any).repairAttempts,5);assert.equal(f.listing.completionOperations(f.draft.id)[0].rounds.length,2);
 await f.reopen();await assert.rejects(f.run());assert.equal(f.ai.listCalls().length,calls);assert.equal(f.listing.completionOperations(f.draft.id).length,1);
});
import { parseFullGeneration } from '../src/main/listing-ai/full-schema.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
test('modern full-schema parser retains a non-infer explanatory theme candidate',async t=>{
 const f=await setup(t),context=f.listing.currentContext(f.draft,f.product,0);
 const output=parseFullGeneration({kind:'amazon-fields',candidates:[{field:'theme',nativeValue:[{value:'Coaster'}],evidenceIds:[],transformation:'copy',inferenceReason:'Explanatory annotation retained'}],missing:[]},context);
 assert.equal(output.candidates[0].items[0].inferenceReason,'Explanatory annotation retained');assert.deepEqual(output.missing,[]);
});
test('scoped journal refuses a send without the persisted consumed owner grant',async t=>{
 const f=await setup(t),op=f.begin()!,id=randomUUID();op.rounds.push({context:f.context,contextHash:listingFingerprint(f.context),candidate:{id,sent:false,resultId:null},review:{id:randomUUID(),sent:false,resultId:null},resolved:false,adoptionId:null});f.journal.save(op);
 const call={...f.ai.getCall(f.result.callId)!,id};
 assert.throws(()=>f.journal.markSent({operationId:op.id,callId:id,contextHash:listingFingerprint(f.context)},call),/额度尚未持久化/);assert.equal(f.journal.get(op.id).rounds[0].candidate.sent,false);
});
