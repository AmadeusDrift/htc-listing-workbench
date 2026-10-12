import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {completionOwnerFixture} from './fixtures/completion-owners.ts';
import {realAmazonSchema} from './fixtures/amazon/schema-fixture.ts';
import {saveInput} from './fixtures/listing-ai.ts';
import {sourceStamp} from '../src/main/automatic-listing/records.ts';
import {imageWorkflowDraftStamp} from '../src/main/image-workflow/records.ts';
import {pricingBlockingReason} from '../src/main/image-workflow/deferred-fields.ts';

async function legacyOwner(t:test.TestContext){
 const f=await completionOwnerFixture(t,'automatic'),p=(f.amazon as any).persistence;
 const product=f.store.saveProduct({...saveInput(f.store.getProduct(f.product.id)),variants:saveInput(f.store.getProduct(f.product.id)).variants.map(v=>({...v,purchasePrice:'2.4'})),facts:[...f.product.facts,{id:randomUUID(),name:'采购币种',value:'CNY',source:'manual',sourceRef:'fixture',state:'human_confirmed'}]});
 const r=p.record(f.draft.id);r.draft.productRevision=product.revision;r.draft.listingProgram='haul';r.draft.schema.schema=realAmazonSchema().schema;r.draft.schema.schema.required=[];
 r.draft.businessRules={revision:0,fields:{},notices:['售价上限内无法满足目标 ROI'],quote:null,bundleQuantity:1};
 r.draft.previewIssues=[{code:'PLATFORM_KEEP',source:'amazon',severity:'ERROR',category:'field',attributeNames:['color'],autoFixable:false,message:'Independent platform error'}];p.putRecord(r);
 const op=f.listing.beginCompletion({draftId:r.draft.id,draftRevision:r.draft.revision});op.state='DONE';f.ai.completionJournal.save(op);
 const saved=p.db.prepare('SELECT id,record_json FROM automatic_listing_tasks').get(),task=JSON.parse(saved.record_json),row=task.items[0];task.status='NEEDS_ATTENTION';
 Object.assign(row,{productRevision:product.revision,sourceStamp:sourceStamp(product),status:'FAILED',error:pricingBlockingReason(r.draft),repairAttempts:2});
 row.repair={...row.repair,operationId:op.id,draftRevision:r.draft.revision,draftStamp:imageWorkflowDraftStamp(r.draft),remaining:[pricingBlockingReason(r.draft)!]};
 p.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),saved.id);await f.reopen();
 return {...f,p,taskId:task.id,op};
}

test('pricing draft commit interruption resumes durable automatic repair owner without losing errors or paid history',async t=>{
 const f=await legacyOwner(t),apply=f.amazon.applyBusinessDefaults.bind(f.amazon),before=structuredClone(f.op);
 let once=true;f.amazon.applyBusinessDefaults=(...args)=>{const result=apply(...args);if(once){once=false;throw Error('after pricing draft commit');}return result;};
 let owner=f.ownerService();(owner as any).deps.execution.pause=()=>f.child;(owner as any).deps.procurement.candidates=()=>[];assert.throws(()=>owner.startAuthorized(owner.prepareStart(f.taskId)),/after pricing draft commit/);
 assert.ok(f.amazon.getDraft(f.draft.id).businessRules?.quote,JSON.stringify(f.amazon.getDraft(f.draft.id).businessRules));
 await f.reopen();owner=f.ownerService();owner.startAuthorized(owner.prepareStart(f.taskId));owner.pause(f.taskId);await owner.waitForIdle();
 const draft=f.amazon.getDraft(f.draft.id),row=owner.get(f.taskId).items[0];
 assert.equal(row.repair?.draftRevision,draft.revision);assert.equal(row.repair?.draftStamp,imageWorkflowDraftStamp(draft));
 assert.equal(row.repairAttempts,2);assert.equal(row.repair?.operationId,f.op.id);assert.ok(row.repair?.remaining?.some(v=>v.includes('Independent platform error')));
 assert.deepEqual(f.ai.completionJournal.get(f.op.id),before);assert.equal(f.requests.length,0);assert.equal(f.previews(),0);
 await assert.rejects(f.run(),/Independent platform error/);assert.equal(f.requests.length,0);
});






for(const guard of ['started-repair','active-operation'] as const)test(`pricing refresh leaves ${guard} and its persisted draft untouched`,async t=>{
 const f=await legacyOwner(t),stored=f.p.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(f.taskId),task=JSON.parse(stored.record_json);
 if(guard==='started-repair')task.items[0].repair.phase='FIELDS_STARTED';
 else {const op=f.ai.completionJournal.get(f.op.id);op.state='ACTIVE';f.ai.completionJournal.save(op);}
 f.p.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),f.taskId);await f.reopen();
 const before=JSON.stringify(f.amazon.getDraft(f.draft.id)),operation=JSON.stringify(f.ai.completionJournal.get(f.op.id));let refreshes=0;const apply=f.amazon.applyBusinessDefaults.bind(f.amazon);
 f.amazon.applyBusinessDefaults=(...args)=>{refreshes++;return apply(...args);};
 const owner=f.ownerService();(owner as any).deps.execution.pause=()=>f.child;(owner as any).deps.procurement.candidates=()=>[];
 owner.startAuthorized(owner.prepareStart(f.taskId));owner.pause(f.taskId);await owner.waitForIdle();
 assert.equal(refreshes,0);assert.equal(JSON.stringify(f.amazon.getDraft(f.draft.id)),before);assert.equal(JSON.stringify(f.ai.completionJournal.get(f.op.id)),operation);assert.equal(f.requests.length,0);
});

test('failure inside pricing owner checkpoint rolls back draft and task together',async t=>{
 const f=await legacyOwner(t),owner=f.ownerService(),beforeDraft=JSON.stringify(f.amazon.getDraft(f.draft.id)),beforeTask=JSON.stringify(owner.get(f.taskId)),apply=f.amazon.applyBusinessDefaults.bind(f.amazon);
 f.amazon.applyBusinessDefaults=(input,op,revalidate,checkpoint)=>apply(input,op,revalidate,(draft,db)=>{checkpoint?.(draft,db);throw Error('inside atomic checkpoint');});
 assert.throws(()=>owner.startAuthorized(owner.prepareStart(f.taskId)),/inside atomic checkpoint/);
 assert.equal(JSON.stringify(f.amazon.getDraft(f.draft.id)),beforeDraft);assert.equal(JSON.stringify(owner.get(f.taskId)),beforeTask);
 await f.reopen();assert.equal(JSON.stringify(f.ownerService().get(f.taskId)),beforeTask);assert.equal(f.requests.length,0);
});

test('external edit after interrupted pricing commit cannot inherit its owner proof',async t=>{
 const f=await legacyOwner(t),apply=f.amazon.applyBusinessDefaults.bind(f.amazon);
 f.amazon.applyBusinessDefaults=(...args)=>{apply(...args);throw Error('after commit');};
 const owner=f.ownerService();assert.throws(()=>owner.startAuthorized(owner.prepareStart(f.taskId)),/after commit/);
 const draft=f.amazon.getDraft(f.draft.id);f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,is_value_stores_item:[{value:true,marketplace_id:draft.marketplaceId}],item_name:[{value:'External edit',marketplace_id:draft.marketplaceId,language_tag:'en_US'}]}});
 await f.reopen();const restarted=f.ownerService();assert.throws(()=>restarted.startAuthorized(restarted.prepareStart(f.taskId)),/本地定价恢复后草稿已变化/);assert.equal(f.requests.length,0);
});
