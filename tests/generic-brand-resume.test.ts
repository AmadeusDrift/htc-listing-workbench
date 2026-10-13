import { seedAuthorityHaulPricing } from './helpers/authority-haul-pricing.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,legacyFixture} from './fixtures/listing-ai.ts';
import {needsBusinessAuthorityRefresh} from '../src/main/image-workflow/policy-reevaluation.ts';
const brandSchema={type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'}},required:['value']}};
const brandingIssue=(code='5665',field='brand')=>({code,source:'amazon' as const,severity:'ERROR' as const,category:'field' as const,attributeNames:[field],autoFixable:false,message:`Brand approval required (${code})`});
async function oldBrand(t:test.TestContext){
 const f=await fixture(t,{brand:brandSchema}),p=(f.amazon as any).persistence,r=p.record(f.draft.id);
 r.draft.listingProgram='haul';r.draft.attributes.brand=[{value:'豪美',marketplace_id:r.draft.marketplaceId}];r.draft.localIssues=[];r.draft.previewIssues=[brandingIssue()];r.draft.state='BLOCKED';delete r.draft.businessRules;
 r.previewResponse={issues:[brandingIssue()],raw:'original response'};p.putRecord(r);
 const op=f.listing.beginCompletion(f.reference);op.state='DONE';op.remaining=['brand：Brand approval required (5665)'];f.ai.completionJournal.save(op);return {...f,p,op};
}
test('brand-only legacy DONE refreshes Generic without FACT marker or another paid call',async t=>{
 const f=await oldBrand(t),before=f.amazon.getDraft(f.draft.id),raw=f.p.record(f.draft.id).previewResponse;
 assert.equal(needsBusinessAuthorityRefresh(before,f.op.remaining),true);
 const result=await f.listing.complete(f.reference,undefined,f.op.id);
 assert.equal((result.draft.attributes.brand as any)[0].value,'Generic');assert.ok(result.draft.businessRules?.fields.brand);
 assert.ok(!result.draft.localIssues.some(i=>i.attributeNames.includes('brand')&&i.code==='FACT_AUTHORITY_REQUIRED'));
 assert.equal(result.aiCalls,0);assert.equal(result.previewAttempts,0);assert.equal(f.requests.length,0);
 assert.deepEqual(f.p.record(f.draft.id).previewResponse,raw);assert.deepEqual(result.draft.previewIssues,before.previewIssues);
 assert.equal(needsBusinessAuthorityRefresh(result.draft),false);
 const repeated=await f.listing.complete({draftId:result.draft.id,draftRevision:result.draft.revision},undefined,f.op.id);
 assert.equal(repeated.draft.revision,result.draft.revision);assert.equal(f.listing.completionOperations(f.draft.id).length,1);
});
for(const code of ['5665','5882'])test(`Generic platform ${code} in color requires manual handling without AI repair`,async t=>{
 const f=await fixture(t,{brand:brandSchema}),p=(f.amazon as any).persistence,r=p.record(f.draft.id);
 r.draft.listingProgram='haul';await seedAuthorityHaulPricing(f,r.draft);p.putRecord(r);
 f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[brandingIssue(code,'color')]});
 const result=await f.listing.complete(f.reference);
 assert.equal((result.draft.attributes.brand as any)[0].value,'Generic');assert.equal(result.aiCalls,0);assert.equal(f.requests.length,0);
 assert.ok(result.remaining.some(s=>s.includes(code)&&s.includes('color')&&s.includes('人工')));
});
test('unknown Amazon write still prevents legacy brand mutation',async t=>{
 const f=await oldBrand(t),r=f.p.record(f.draft.id);r.unresolvedWrite=true;r.draft.state='UNKNOWN';f.p.putRecord(r);
 const {completionDraftStamp}=await import('../src/main/listing-ai/completion-journal.ts');const op=f.ai.completionJournal.get(f.op.id);op.draftStamp=completionDraftStamp(r.draft);f.ai.completionJournal.save(op);
 await assert.rejects(f.listing.complete(f.reference,undefined,op.id));assert.equal((f.amazon.getDraft(f.draft.id).attributes.brand as any)[0].value,'豪美');assert.equal(f.requests.length,0);
});

test('brand-only local refresh interrupted after write resumes without another revision or request',async t=>{
 const f=await oldBrand(t),apply=f.amazon.applyBusinessDefaults.bind(f.amazon);let once=true;
 f.amazon.applyBusinessDefaults=(...args)=>{const result=apply(...args);if(once){once=false;throw Error('checkpoint interruption');}return result;};
 await assert.rejects(f.listing.complete(f.reference,undefined,f.op.id),/checkpoint interruption/);
 const draft=f.amazon.getDraft(f.draft.id),result=await f.listing.complete({draftId:draft.id,draftRevision:draft.revision},undefined,f.op.id);
 assert.equal(result.draft.revision,draft.revision);assert.equal((result.draft.attributes.brand as any)[0].value,'Generic');assert.ok(result.remaining.some(s=>s.includes('5665')&&s.includes('人工')));assert.equal(f.requests.length,0);
});

test('automatic owner keeps brand dispute manual and does not consume a repair attempt',async t=>{
 const {completionOwnerFixture}=await import('./fixtures/completion-owners.ts'),{imageWorkflowDraftStamp}=await import('../src/main/image-workflow/records.ts');
 const f=await completionOwnerFixture(t,'automatic'),p=(f.amazon as any).persistence,r=p.record(f.draft.id);
 r.draft.listingProgram='haul';r.draft.attributes.brand=[{value:'Generic',marketplace_id:r.draft.marketplaceId}];r.draft.previewIssues=[brandingIssue('5882','color')];p.putRecord(r);
 const saved=p.db.prepare('SELECT id,record_json FROM automatic_listing_tasks').get(),task=JSON.parse(saved.record_json),row=task.items[0];
 row.repairAttempts=0;row.repair.draftStamp=imageWorkflowDraftStamp(r.draft);p.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),saved.id);await f.reopen();
 await assert.rejects(f.run(),/人工/);assert.equal((f.progress() as any).repairAttempts,0);assert.equal(f.requests.length,0);assert.equal(f.previews(),0);
 const outcome=await f.classifyFailure();assert.equal(outcome.kind,'NEEDS_INPUT');assert.equal(outcome.code,'AMAZON_BRAND_MANUAL');
 await f.reopen();assert.deepEqual((f.progress() as any).outcome,outcome);
 const {validateAutomaticListingTask}=await import('../src/main/automatic-listing/records.ts');
 const persisted=JSON.parse(p.db.prepare('SELECT record_json FROM automatic_listing_tasks').get().record_json);
 assert.doesNotThrow(()=>validateAutomaticListingTask(persisted));
 for(const kind of ['SYSTEM_REPAIR','UNKNOWN','RULE_FILTERED']){const invalid=structuredClone(persisted);invalid.items[0].outcome.kind=kind;assert.throws(()=>validateAutomaticListingTask(invalid));}
 for(const patch of [{draftId:null,draftRevision:null},{draftRevision:0}]){const invalid=structuredClone(persisted);Object.assign(invalid.items[0].outcome,patch);assert.throws(()=>validateAutomaticListingTask(invalid));}
 const {presentRejection}=await import('../src/shared/rejection-presentation.ts');assert.match(presentRejection(outcome.code),/Generic.*人工/);

});

test('ordinary brand schema errors are not classified as brand approval disputes',async t=>{
 const {manualBrandIssues}=await import('../src/main/image-workflow/policy-reevaluation.ts');
 const f=await fixture(t,{brand:brandSchema}),draft={...f.draft,listingProgram:'haul' as const,attributes:{...f.draft.attributes,brand:[{value:'Generic'}]}};
 assert.deepEqual(manualBrandIssues(draft,[{...brandingIssue('90220'),message:'Missing required marketplace_id'}]),[]);
 assert.deepEqual(manualBrandIssues(draft,[{...brandingIssue(),severity:'WARNING'}]),[]);
});

for(const pending of ['candidate','review'] as const)test(`resumed ACTIVE ${pending} dispatch stops for Generic brand dispute and retains journal`,async t=>{
 const {randomUUID}=await import('node:crypto'),{listingFingerprint}=await import('../src/main/listing-ai/validation.ts');
 const f=await legacyFixture(t,{brand:brandSchema}),p=(f.amazon as any).persistence,r=p.record(f.draft.id);
 r.draft.listingProgram='haul';await seedAuthorityHaulPricing(f,r.draft);r.draft.attributes.brand=[{value:'Generic',marketplace_id:r.draft.marketplaceId}];r.draft.previewIssues=[brandingIssue()];delete r.draft.attributes.material;p.putRecord(r);
 const op=f.listing.beginCompletion(f.reference),context=f.listing.currentContext(f.amazon.getDraft(f.draft.id),f.product,f.amazon.executionTargetScope(f.draft.targetId).generation);
 context.fields=context.fields.filter(field=>field.name==='material');context.repairRequest={issues:[{field:'material',code:'90220',message:'Missing material'}],currentValues:{material:null}};
 const round={context,contextHash:listingFingerprint(context),candidate:{id:randomUUID(),sent:false,resultId:null},review:{id:randomUUID(),sent:false,resultId:null},resolved:false,adoptionId:null};op.rounds=[round];f.ai.completionJournal.save(op);
 if(pending==='review')await f.ai.listingFields(context,async()=>{},undefined,undefined,{operationId:op.id,callId:round.candidate.id,contextHash:round.contextHash});
 const before=f.ai.completionJournal.get(op.id),calls=f.requests.length,history=f.ai.listCalls();
 f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[brandingIssue()]});
 const result=await f.listing.complete(f.reference,undefined,op.id);
 assert.equal(f.requests.length,calls);assert.equal(result.aiCalls,0);assert.ok(result.remaining.some(s=>s.includes('人工')));
 const after=f.ai.completionJournal.get(op.id);assert.deepEqual(after.rounds,before.rounds);assert.deepEqual(f.ai.listCalls(),history);
 assert.equal(after.state,'DONE');assert.equal(after.rounds[0].review?.sent,false);
 if(pending==='review')assert.ok(f.ai.getResult(after.rounds[0].candidate.resultId!));
});

test('scoped DONE receives an independent audited brand-only migration and retires only proven stale preview 5665',async t=>{
 const {randomUUID}=await import('node:crypto');
 const f=await oldBrand(t),op=f.ai.completionJournal.get(f.op.id),record=f.p.record(f.draft.id);
 op.scopedRepair={version:'legacy-theme-parser/v1',fields:['theme'],sourceResultId:randomUUID(),sourceCallId:randomUUID(),sourceContextHash:'a'.repeat(64),sourceWorkflowId:randomUUID(),originalDraftStamp:op.draftStamp,previousAttempts:4};f.ai.completionJournal.save(op);
 record.draft.attributes.theme=[{value:'Animal/Cartoon'}];record.draft.previewIssues.push({...brandingIssue('OTHER','material')});
 record.exchanges=[{id:randomUUID(),at:new Date().toISOString(),operation:'preview',revision:record.draft.revision,request:{attributes:{brand:record.draft.attributes.brand}},response:{issues:[brandingIssue()]},status:200,requestId:null,schemaChecksum:record.draft.schema.checksum,schemaVersion:record.draft.schema.version}];f.p.putRecord(record);
 const {completionDraftStamp}=await import('../src/main/listing-ai/completion-journal.ts');op.draftStamp=completionDraftStamp(record.draft);f.ai.completionJournal.save(op);
 const before=f.p.record(f.draft.id),raw=f.p.db.prepare('SELECT * FROM amazon_exchanges').all();
 const result=await f.listing.complete(f.reference,undefined,op.id);
 assert.equal((result.draft.attributes.brand as any)[0].value,'Generic');
 assert.deepEqual(result.draft.attributes.theme,before.draft.attributes.theme);
 assert.deepEqual(result.draft.previewIssues.map(i=>i.code),['OTHER']);
 assert.deepEqual(f.p.record(f.draft.id).previewResponse,before.previewResponse);
 assert.deepEqual(f.p.db.prepare('SELECT * FROM amazon_exchanges').all(),raw);
 const afterOp=f.ai.completionJournal.get(op.id);assert.deepEqual(afterOp.rounds,op.rounds);assert.deepEqual(afterOp.scopedRepair,op.scopedRepair);
 assert.equal(f.p.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='listing.fixed-brand-migrated'").get().n,1);
 const again=await f.listing.complete({draftId:result.draft.id,draftRevision:result.draft.revision},undefined,op.id);assert.equal(again.draft.revision,result.draft.revision);assert.equal(f.requests.length,0);
});


for(const guard of ['submitted','stamp','source','lock'] as const)test(`scoped brand migration refuses ${guard} without writes`,async t=>{
 const {randomUUID}=await import('node:crypto');
 const f=await oldBrand(t),op=f.ai.completionJournal.get(f.op.id),r=f.p.record(f.draft.id);
 op.scopedRepair={version:'legacy-theme-parser/v1',fields:['theme'],sourceResultId:randomUUID(),sourceCallId:randomUUID(),sourceContextHash:'a'.repeat(64),sourceWorkflowId:randomUUID(),originalDraftStamp:op.draftStamp,previousAttempts:4};
 if(guard==='submitted')r.draft.submittedAt=new Date().toISOString();
 if(guard==='source')r.draft.productRevision++;
 if(guard==='stamp')r.draft.attributes.material=[{value:'Changed'}];
 if(guard==='lock')f.p.locked=()=>true;
 f.p.putRecord(r);f.ai.completionJournal.save(op);const before=f.p.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(r.draft.id).record_json;
 assert.throws(()=>f.amazon.migrateFixedBrand({id:r.draft.id,revision:r.draft.revision},op.id));assert.equal(f.p.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(r.draft.id).record_json,before);assert.equal(f.requests.length,0);
});

for(const code of ['5665','5882'])test(`scoped migration retains unproven ${code} and fresh Generic refusal stays manual`,async t=>{
 const {randomUUID}=await import('node:crypto'),f=await oldBrand(t),op=f.ai.completionJournal.get(f.op.id),r=f.p.record(f.draft.id);
 op.scopedRepair={version:'legacy-theme-parser/v1',fields:['theme'],sourceResultId:randomUUID(),sourceCallId:randomUUID(),sourceContextHash:'a'.repeat(64),sourceWorkflowId:randomUUID(),originalDraftStamp:op.draftStamp,previousAttempts:4};f.ai.completionJournal.save(op);
 r.draft.previewIssues=[brandingIssue(code)];f.p.putRecord(r);
 const result=await f.listing.complete(f.reference,undefined,op.id);assert.ok(result.remaining.some(message=>message.includes('人工')));assert.equal(result.draft.previewIssues[0].code,code);
 const fresh=f.p.record(f.draft.id);fresh.draft.previewIssues=[brandingIssue(code)];f.p.putRecord(fresh);
 const again=await f.listing.complete({draftId:f.draft.id,draftRevision:result.draft.revision},undefined,op.id);assert.ok(again.remaining.some(message=>message.includes('人工')));assert.equal(again.draft.revision,result.draft.revision);assert.equal(f.requests.length,0);
});
