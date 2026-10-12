import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/listing-ai.ts';
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
 r.draft.listingProgram='haul';p.putRecord(r);
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
});

test('ordinary brand schema errors are not classified as brand approval disputes',async t=>{
 const {manualBrandIssues}=await import('../src/main/image-workflow/policy-reevaluation.ts');
 const f=await fixture(t,{brand:brandSchema}),draft={...f.draft,listingProgram:'haul' as const,attributes:{...f.draft.attributes,brand:[{value:'Generic'}]}};
 assert.deepEqual(manualBrandIssues(draft,[{...brandingIssue('90220'),message:'Missing required marketplace_id'}]),[]);
 assert.deepEqual(manualBrandIssues(draft,[{...brandingIssue(),severity:'WARNING'}]),[]);
});
