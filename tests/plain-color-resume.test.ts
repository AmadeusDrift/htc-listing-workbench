import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,saveInput} from './fixtures/listing-ai.ts';
import {confirmSourceConsistencyFixture} from './helpers/source-consistency-proof.ts';
const issue={code:'5882',source:'amazon' as const,severity:'ERROR' as const,category:'field' as const,attributeNames:['color'],autoFixable:false,message:'Brand conflict in color'};
async function oldColor(t:test.TestContext,color='Cherry Blossom Pink',priced=false){
 const measurement={type:'object',properties:{value:{type:'number'},unit:{enum:['inches']}},required:['value','unit']};
 const f=await fixture(t,priced?{item_package_dimensions:{type:'array',items:{type:'object',properties:{length:measurement,width:measurement,height:measurement},required:['length','width','height']}},item_package_weight:{type:'array',items:{type:'object',properties:{value:{type:'number'},unit:{enum:['pounds']}},required:['value','unit']}}}:{}),product=f.store.saveProduct({...saveInput(f.product),...(priced?{facts:[...f.product.facts,{id:randomUUID(),name:'采购币种',value:'CNY',source:'manual' as const,sourceRef:'fixture',state:'human_confirmed' as const}]}:{}),variants:saveInput(f.product).variants.map(v=>({...v,...(priced?{purchasePrice:'1'}:{}),originalSpec:'樱花粉',normalizedSpec:'樱花粉'}))});
 await confirmSourceConsistencyFixture(f.directory,f.store,product.id);
 let draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
 if(priced){const p=(f.amazon as any).persistence,r=p.record(draft.id);r.draft.listingProgram='haul';p.putRecord(r);draft=f.amazon.applyBusinessDefaults({id:draft.id,revision:draft.revision});f.amazon.assertPricingForPaid(draft.id);}
 const reference={draftId:draft.id,draftRevision:draft.revision},p=(f.amazon as any).persistence,r=p.record(draft.id);
 r.draft.listingProgram='haul';r.draft.attributes.brand=[{value:'Generic',marketplace_id:draft.marketplaceId}];r.draft.attributes.color=[{value:color,marketplace_id:draft.marketplaceId}];r.draft.localIssues=[];r.draft.previewIssues=[issue];r.draft.state='BLOCKED';r.previewResponse={issues:[issue],raw:'unchanged original response'};p.putRecord(r);
 const op=f.listing.beginCompletion(reference);op.state='DONE';op.remaining=['color: Brand conflict in color'];f.ai.completionJournal.save(op);
 return {...f,product,draft,reference,p,op};
}
for(const color of ['Cherry Blossom Pink','Sakura'])test(`cached Generic DONE refreshes ${color} locally and retains manual brand issue and original response`,async t=>{
 const f=await oldColor(t,color),raw=f.p.record(f.draft.id).previewResponse;
 const result=await f.listing.complete(f.reference,undefined,f.op.id);
 assert.equal((result.draft.attributes.color as any)[0].value,'Pink');
 assert.deepEqual(f.p.record(f.draft.id).previewResponse,raw);assert.deepEqual(result.draft.previewIssues,[issue]);
 assert.ok(result.remaining.some(s=>s.includes('5882')&&s.includes('人工')));
 assert.equal(result.aiCalls,0);assert.equal(result.previewAttempts,0);assert.equal(f.requests.length,0);
 assert.deepEqual(f.ai.completionJournal.get(f.op.id).rounds,f.op.rounds);
 const again=await f.listing.complete({draftId:result.draft.id,draftRevision:result.draft.revision},undefined,f.op.id);
 assert.equal(again.draft.revision,result.draft.revision);assert.equal(f.listing.completionOperations(f.draft.id).length,1);
});

test('image cached DONE color refresh survives interruption and preserves owner slots and budget',async t=>{
 const f=await oldColor(t,'Cherry Blossom Pink',true),{ImageWorkflowService}=await import('../src/main/image-workflow/service.ts');let seed=true;
 const listing={currentContext:(...args:Parameters<typeof f.listing.currentContext>)=>f.listing.currentContext(...args),beginCompletion:()=>f.ai.completionJournal.get(f.op.id),complete:async(...args:Parameters<typeof f.listing.complete>)=>seed?{draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:['color: Brand conflict in color']}:f.listing.complete(...args),reviewCurrentForImages:(...args:Parameters<typeof f.listing.reviewCurrentForImages>)=>f.listing.reviewCurrentForImages(...args)};
 const ai=new Proxy(f.ai,{get(target,key){if(key==='getProfile')return()=>({enabled:true,configured:true,generation:1});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const make=()=>new ImageWorkflowService(f.directory,f.store,f.amazon,ai,{getConnection:()=>({enabled:true,configured:true}),configurationScope:()=> 'fixture'} as any,{listing});
 let images=make();t.after(()=>images.close());
 const first=await images.complete(f.reference);assert.equal(first.workflow.contentPreparation?.state,'DONE',first.workflow.error??JSON.stringify(first.workflow));const slots=structuredClone(first.workflow.slots);seed=false;
 const complete=listing.complete;let once=true;listing.complete=async(...args)=>{const result=await complete(...args);if(once){once=false;throw Error('color owner checkpoint interruption');}return result;};
 const interrupted=await images.complete(f.reference);assert.equal(once,false);assert.equal(interrupted.workflow.contentPreparation?.state,'STARTED');
 await images.close();images=make();const draft=f.amazon.getDraft(f.draft.id),resumed=await images.complete({draftId:draft.id,draftRevision:draft.revision});
 assert.equal((resumed.draft.attributes.color as any)[0].value,'Pink');assert.equal(resumed.workflow.id,first.workflow.id);assert.equal(resumed.workflow.contentPreparation?.state,'DONE');assert.deepEqual(resumed.workflow.slots,slots);assert.match(resumed.workflow.error??'',/人工/);assert.equal(f.requests.length,0);assert.equal(f.listing.completionOperations(draft.id).length,1);assert.deepEqual(f.p.record(draft.id).previewResponse,{issues:[issue],raw:'unchanged original response'});await images.close();
});

test('direct local color migration retains platform receipt and issues but invalidates preview acceptance',async t=>{
 const f=await oldColor(t),record=f.p.record(f.draft.id),raw=structuredClone(record.previewResponse);
 record.draft.previewedAt=new Date().toISOString();f.p.putRecord(record);
 const result=await f.amazon.validateDraft({id:f.draft.id,revision:f.draft.revision});
 assert.equal((result.attributes.color as any)[0].value,'Pink');assert.deepEqual(result.previewIssues,[issue]);assert.deepEqual(f.p.record(f.draft.id).previewResponse,raw);assert.equal(result.previewedAt,null);assert.equal(f.requests.length,0);
});

test('unknown submission protects a cached color migration from local writes',async t=>{
 const f=await oldColor(t),record=f.p.record(f.draft.id);record.unresolvedWrite=true;record.draft.state='UNKNOWN';f.p.putRecord(record);
 const {completionDraftStamp}=await import('../src/main/listing-ai/completion-journal.ts');const operation=f.ai.completionJournal.get(f.op.id);operation.draftStamp=completionDraftStamp(record.draft);f.ai.completionJournal.save(operation);
 await assert.rejects(f.listing.complete(f.reference,undefined,f.op.id));assert.equal((f.amazon.getDraft(f.draft.id).attributes.color as any)[0].value,'Cherry Blossom Pink');assert.equal(f.requests.length,0);
});
