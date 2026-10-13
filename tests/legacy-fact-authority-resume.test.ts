import { seedAuthorityHaulPricing } from './helpers/authority-haul-pricing.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/listing-ai.ts';
import {ListingRuleStore} from '../src/main/listing-rules.ts';
const message='manufacturer 缺少匹配当前销售规格的已确认事实或有效 SKU 回执；规则默认和直接保存的数值不构成事实确认';
async function legacy(t:test.TestContext,reordered=false,withPricing=false){
 const f=await fixture(t,{manufacturer:{type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'},language_tag:{type:'string'}},required:['value']}},is_value_stores_item:{type:'array',items:{type:'object',properties:{value:{type:'boolean'},marketplace_id:{type:'string'}},required:['value']}}});
 const rules=new ListingRuleStore(f.directory);try{const value=rules.get();value.product.targetShops[f.draft.targetId]='U2';rules.save(value);}finally{rules.close();}
 const p=(f.amazon as any).persistence,r=p.record(f.draft.id);r.draft.listingProgram='haul';r.draft.attributes.manufacturer=[reordered?{value:'EQUICK',language_tag:'en_US',marketplace_id:r.draft.marketplaceId}:{value:'EQUICK',marketplace_id:r.draft.marketplaceId,language_tag:'en_US'}];r.draft.attributes.is_value_stores_item=[{value:true,marketplace_id:r.draft.marketplaceId}];r.draft.attributes.purchasable_offer=[{audience:'BZR',marketplace_id:r.draft.marketplaceId,currency:'USD',our_price:[{schedule:[{value_with_tax:2.5}]}]}];r.draft.localIssues=[{code:'FACT_AUTHORITY_REQUIRED',source:'local',severity:'ERROR',category:'fact',attributeNames:['manufacturer'],autoFixable:false,message}];r.draft.state='BLOCKED';if(withPricing)await seedAuthorityHaulPricing(f,r.draft);p.putRecord(r);
 const op=f.listing.beginCompletion(f.reference);op.state='DONE';op.remaining=[message];f.ai.completionJournal.save(op);return{...f,p,op};
}
test('old DONE fact failure reapplies current rules locally without resetting operation, requests or budget',async t=>{
 const f=await legacy(t),before=f.ai.listCalls(),rounds=structuredClone(f.op.rounds);
 const result=await f.listing.complete(f.reference,undefined,f.op.id);
 assert.ok(!result.draft.localIssues.some(i=>i.code==='FACT_AUTHORITY_REQUIRED'));assert.ok(!result.remaining.some(s=>s.includes('不构成事实确认')));
 assert.equal((result.draft.attributes.brand as any)[0].value,'Generic');assert.equal(result.aiCalls,0);assert.equal(result.previewAttempts,0);assert.deepEqual(f.ai.listCalls(),before);
 const op=f.ai.completionJournal.get(f.op.id);assert.equal(op.state,'DONE');assert.deepEqual(op.rounds,rounds);assert.equal(f.listing.completionOperations(f.draft.id).length,1);
 const again=await f.listing.complete({draftId:result.draft.id,draftRevision:result.draft.revision},undefined,op.id);assert.equal(again.draft.revision,result.draft.revision);assert.deepEqual(f.ai.listCalls(),before);
});
test('restart boundary after local rule write resumes same DONE operation without another request',async t=>{
 const f=await legacy(t),apply=f.amazon.applyBusinessDefaults.bind(f.amazon);let once=true;
 f.amazon.applyBusinessDefaults=(...args)=>{const value=apply(...args);if(once){once=false;throw Error('after local write');}return value;};
 await assert.rejects(f.listing.complete(f.reference,undefined,f.op.id),/after local write/);
 const draft=f.amazon.getDraft(f.draft.id),result=await f.listing.complete({draftId:draft.id,draftRevision:draft.revision},undefined,f.op.id);
 assert.ok(!result.remaining.some(s=>s.includes('不构成事实确认')));assert.equal(f.requests.length,0);assert.equal(f.listing.completionOperations(draft.id).length,1);
});

test('image cached DONE owner checkpoints the local refresh before resuming, preserving slots and zero requests',async t=>{
 const f=await legacy(t,false,true),{ImageWorkflowService}=await import('../src/main/image-workflow/service.ts');let seed=true;
 const listing={currentContext:(...args:Parameters<typeof f.listing.currentContext>)=>f.listing.currentContext(...args),beginCompletion:()=>f.ai.completionJournal.get(f.op.id),complete:async(...args:Parameters<typeof f.listing.complete>)=>seed?{draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[message]}:f.listing.complete(...args),reviewCurrentForImages:(...args:Parameters<typeof f.listing.reviewCurrentForImages>)=>f.listing.reviewCurrentForImages(...args)};
 const ai=new Proxy(f.ai,{get(target,key){if(key==='getProfile')return()=>({enabled:true,configured:true,generation:1});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 let images=new ImageWorkflowService(f.directory,f.store,f.amazon,ai,{getConnection:()=>({enabled:true,configured:true}),configurationScope:()=> 'fixture'} as any,{listing});t.after(()=>images.close());
 const first=await images.complete(f.reference);assert.ok(first.workflow.error?.includes('不构成事实确认'));const slots=structuredClone(first.workflow.slots);seed=false;
 const complete=listing.complete;let once=true;listing.complete=async(...args)=>{const value=await complete(...args);if(once){once=false;throw Error('owner checkpoint interruption');}return value;};
 const interrupted=await images.complete(f.reference);assert.equal(once,false,JSON.stringify(interrupted.workflow));assert.ok(interrupted.workflow.error);assert.equal(interrupted.workflow.contentPreparation?.state,'STARTED');
 await images.close();images=new ImageWorkflowService(f.directory,f.store,f.amazon,ai,{getConnection:()=>({enabled:true,configured:true}),configurationScope:()=> 'fixture'} as any,{listing});
 const d=f.amazon.getDraft(f.draft.id),resumed=await images.complete({draftId:d.id,draftRevision:d.revision});
 assert.equal(resumed.workflow.id,first.workflow.id);assert.equal(resumed.workflow.contentPreparation?.state,'DONE');assert.ok(!resumed.workflow.error?.includes('不构成事实确认'));assert.deepEqual(resumed.workflow.slots,slots);assert.equal(f.requests.length,0);assert.equal(f.listing.completionOperations(d.id).length,1);await images.close();
});


for(const interruption of [false,true])test(`exhausted automatic repair preserves actual color and two-attempt budget (owner interruption: ${interruption})`,async t=>{
 const {completionOwnerFixture}=await import('./fixtures/completion-owners.ts'),{imageWorkflowDraftStamp}=await import('../src/main/image-workflow/records.ts');
 const f=await completionOwnerFixture(t,'automatic'),p=(f.amazon as any).persistence,r=p.record(f.draft.id),market=r.draft.marketplaceId;
 const scalar=(type:string)=>({type:'array',items:{type:'object',properties:{value:{type},marketplace_id:{type:'string'}},required:['value']}});
 r.draft.listingProgram='haul';Object.assign(r.draft.schema.schema.properties,{brand:scalar('string'),manufacturer:scalar('string'),is_value_stores_item:scalar('boolean'),purchasable_offer:{type:'array',items:{type:'object',properties:{audience:{enum:['BZR']}}}}});r.draft.schema.schema.required=['color'];delete r.draft.attributes.color;r.draft.attributes.brand=[{value:'Generic',marketplace_id:market}];r.draft.attributes.is_value_stores_item=[{value:true,marketplace_id:market}];r.draft.attributes.purchasable_offer=[{audience:'BZR'}];r.draft.localIssues=[{code:'FACT_AUTHORITY_REQUIRED',source:'local',severity:'ERROR',category:'fact',attributeNames:['brand'],autoFixable:false,message}];r.draft.state='BLOCKED';p.putRecord(r);f.amazon.getSchema=async()=>structuredClone(r.draft.schema);
 const op=f.listing.beginCompletion(f.reference());op.state='DONE';op.remaining=[message];f.ai.completionJournal.save(op);
 const saved=p.db.prepare('SELECT id,record_json FROM automatic_listing_tasks').get(),task=JSON.parse(saved.record_json),row=task.items[0];row.repairAttempts=2;delete row.categoryFieldPolicyVersion;row.repair={...row.repair,phase:'FIELDS_PENDING',operationId:op.id,draftRevision:r.draft.revision,draftStamp:imageWorkflowDraftStamp(r.draft),remaining:[message]};p.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),saved.id);await f.reopen();
 if(interruption){const complete=f.listing.complete.bind(f.listing);let once=true;f.listing.complete=async(...args)=>{const result=await complete(...args);if(once){once=false;throw Error('automatic checkpoint interruption');}return result;};await assert.rejects(f.run(),/checkpoint interruption/);await f.reopen();}
 await assert.rejects(f.run(),/color/);const after=f.progress() as any;assert.equal(after.repairAttempts,2);assert.equal(after.repair.operationId,op.id);assert.ok(after.repair.remaining.every((s:string)=>!s.includes('不构成事实确认')));assert.ok(after.repair.remaining.some((s:string)=>s.includes('color')));assert.equal(f.requests.length,0);assert.equal(f.previews(),0);assert.equal(f.listing.completionOperations(f.draft.id).length,1);
 await f.reopen();await assert.rejects(f.run());assert.equal((f.progress() as any).repairAttempts,2);assert.equal((f.progress() as any).categoryFieldRepair,undefined);assert.equal((f.progress() as any).sourceColorRepair,undefined);assert.equal(f.requests.length,0);
});

test('local refresh retains independent platform errors even after write interruption',async t=>{
 const f=await legacy(t),r=f.p.record(f.draft.id);r.draft.previewIssues=[{code:'REMOTE_FIX',source:'amazon',severity:'ERROR',category:'field',attributeNames:['material'],autoFixable:false,message:'Actual platform issue'}];f.p.putRecord(r);
 const apply=f.amazon.applyBusinessDefaults.bind(f.amazon);let once=true;f.amazon.applyBusinessDefaults=(...args)=>{const saved=apply(...args);if(once){once=false;throw Error('interrupted');}return saved;};
 await assert.rejects(f.listing.complete(f.reference,undefined,f.op.id));const draft=f.amazon.getDraft(f.draft.id);
 const result=await f.listing.complete({draftId:draft.id,draftRevision:draft.revision},undefined,f.op.id);assert.ok(result.remaining.some(v=>v.includes('Actual platform issue')));assert.equal(result.draft.previewedAt,null);assert.equal(f.requests.length,0);
});
test('unsupported direct value is re-evaluated, never removed as an old fact message',async t=>{
 const f=await legacy(t),r=f.p.record(f.draft.id);r.draft.attributes.manufacturer=[{value:'Unsupported direct value',marketplace_id:r.draft.marketplaceId}];f.p.putRecord(r);
 const {completionDraftStamp}=await import('../src/main/listing-ai/completion-journal.ts');const op=f.ai.completionJournal.get(f.op.id);op.draftStamp=completionDraftStamp(r.draft);f.ai.completionJournal.save(op);
 const result=await f.listing.complete(f.reference,undefined,op.id);assert.ok(result.draft.localIssues.some(i=>i.code==='FACT_AUTHORITY_REQUIRED'&&i.attributeNames.includes('manufacturer')));assert.equal(f.requests.length,0);
});


test('explicit legacy-contract DONE refresh retains its original scope and operation ID across repeats',async t=>{
 const f=await legacy(t),draft=f.amazon.getDraft(f.draft.id),op=f.ai.completionJournal.get(f.op.id);
 op.scopeHash=(f.listing as any).completionScope(draft,true);f.ai.completionJournal.save(op);
 const result=await f.listing.complete(f.reference,undefined,op.id);assert.equal(result.aiCalls,0);assert.equal(f.requests.length,0);assert.equal(f.listing.completionOperations(draft.id).length,1);
 assert.equal(f.ai.completionJournal.get(op.id).scopeHash,op.scopeHash);
 await f.listing.complete({draftId:draft.id,draftRevision:result.draft.revision},undefined,op.id);assert.equal(f.requests.length,0);assert.equal(f.listing.completionOperations(draft.id).length,1);
});

test('unknown paid field request prevents business refresh and preserves the original draft',async t=>{
 const f=await legacy(t),{randomUUID}=await import('node:crypto'),{listingFingerprint}=await import('../src/main/listing-ai/validation.ts');
 const context=f.listing.currentContext(f.amazon.getDraft(f.draft.id),f.product,f.amazon.executionTargetScope(f.draft.targetId).generation),op=f.ai.completionJournal.get(f.op.id);
 op.state='ACTIVE';op.rounds=[{context,contextHash:listingFingerprint(context),candidate:{id:randomUUID(),sent:true,resultId:null},review:{id:randomUUID(),sent:false,resultId:null},resolved:false,adoptionId:null}];f.ai.completionJournal.save(op);
 const before=JSON.stringify(f.amazon.getDraft(f.draft.id));await assert.rejects(f.listing.complete(f.reference,undefined,op.id));assert.equal(JSON.stringify(f.amazon.getDraft(f.draft.id)),before);assert.equal(f.requests.length,0);assert.equal(f.ai.completionJournal.get(op.id).rounds.length,1);
});
test('failed local validation rolls back rules and completion checkpoint together',async t=>{
 const f=await legacy(t),draft=JSON.stringify(f.p.record(f.draft.id)),op=JSON.stringify(f.ai.completionJournal.get(f.op.id));
 const validate=(f.amazon as any).validate;(f.amazon as any).validate=()=>{throw Error('validation interruption');};
 await assert.rejects(f.listing.complete(f.reference,undefined,f.op.id),/validation interruption/);
 assert.equal(JSON.stringify(f.p.record(f.draft.id)),draft);assert.equal(JSON.stringify(f.ai.completionJournal.get(f.op.id)),op);assert.equal(f.requests.length,0);
 (f.amazon as any).validate=validate;
});

test('local-only automatic refresh can persist STARTED without inventing a paid attempt',async t=>{
 const {completionOwnerFixture}=await import('./fixtures/completion-owners.ts'),{validateAutomaticListingTask}=await import('../src/main/automatic-listing/records.ts');const f=await completionOwnerFixture(t,'automatic'),p=(f.amazon as any).persistence;
 const task=JSON.parse(p.db.prepare('SELECT record_json FROM automatic_listing_tasks').get().record_json),row=task.items[0];const op=f.listing.beginCompletion(f.reference());op.state='DONE';f.ai.completionJournal.save(op);
 row.repairAttempts=0;row.repair={...row.repair,phase:'FIELDS_STARTED',operationId:op.id,businessAuthorityRefresh:'business-authority/v1'};
 assert.equal(validateAutomaticListingTask(task).items[0].repairAttempts,0);
 row.repair.businessAuthorityRefresh='invalid';assert.throws(()=>validateAutomaticListingTask(task));row.repair.businessAuthorityRefresh='business-authority/v1';delete row.repair.operationId;assert.throws(()=>validateAutomaticListingTask(task));
});


test('historical manufacturer key order does not revoke current configured rule authority',async t=>{
 const f=await legacy(t,true),result=await f.listing.complete(f.reference,undefined,f.op.id);
 assert.ok(!result.draft.localIssues.some(i=>i.code==='FACT_AUTHORITY_REQUIRED'&&i.attributeNames.includes('manufacturer')));assert.equal(result.draft.sourceMapping?.find(m=>m.field==='manufacturer')?.status,'mapped');assert.equal(f.requests.length,0);
});

test('equivalent saved brand key order retains mapped rule provenance without a new revision',async t=>{
 const f=await legacy(t),first=await f.listing.complete(f.reference,undefined,f.op.id),r=f.p.record(first.draft.id);
 const brand=(r.draft.attributes.brand as any[])[0];r.draft.attributes.brand=[Object.fromEntries(Object.entries(brand).reverse())];f.p.putRecord(r);
 const {completionDraftStamp}=await import('../src/main/listing-ai/completion-journal.ts');const op=f.ai.completionJournal.get(f.op.id);op.draftStamp=completionDraftStamp(r.draft);op.remaining=[message];f.ai.completionJournal.save(op);
 const next=await f.listing.complete({draftId:r.draft.id,draftRevision:r.draft.revision},undefined,op.id);
 assert.equal(next.draft.revision,r.draft.revision);assert.equal(next.draft.sourceMapping?.find(m=>m.field==='brand')?.status,'mapped');assert.equal(f.requests.length,0);
});
