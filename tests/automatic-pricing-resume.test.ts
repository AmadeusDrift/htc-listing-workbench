import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {completionOwnerFixture} from './fixtures/completion-owners.ts';
import {realAmazonSchema} from './fixtures/amazon/schema-fixture.ts';
import {saveInput} from './fixtures/listing-ai.ts';
import {sourceStamp} from '../src/main/automatic-listing/records.ts';
import {imageWorkflowDraftStamp} from '../src/main/image-workflow/records.ts';
import {buildSalesRecipes} from '../src/main/sales-plans/recipes.ts';
import {qualifiedPricing} from '../src/main/automatic-listing/outcomes.ts';
import {pricingOutcome,outcomeScope} from '../src/main/automatic-listing/outcomes.ts';
import {ListingRuleStore} from '../src/main/listing-rules.ts';
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


test('profit preview uses current cost and shipping rules locally and never edits historical draft',async t=>{
 const f=await legacyOwner(t);
 const initial=f.amazon.getDraft(f.draft.id),before=JSON.stringify(initial);
 const preview=()=> f.amazon.previewPricing(initial.id,f.store.getProduct(initial.productId));
 assert.ok(preview().businessRules!.quote);
 const input=saveInput(f.store.getProduct(initial.productId));input.variants[0].purchasePrice='100';f.store.saveProduct(input);
 assert.equal(preview().businessRules!.pricingDecision!.status,'business_blocked');
 const missing=saveInput(f.store.getProduct(initial.productId));missing.variants[0].purchasePrice='';f.store.saveProduct(missing);
 assert.equal(preview().businessRules!.pricingDecision!.status,'needs_input');
 assert.equal(JSON.stringify(f.amazon.getDraft(initial.id)),before);assert.equal(f.requests.length,0);assert.equal(f.previews(),0);
});


for(const change of ['copy','source-title','unrelated-rules','price-still-blocked','price-qualified','ceiling-qualified','shipping-still-blocked','package-default','missing-cost','quantity-conflict','manual-quantity','invalid-proof'] as const)
test(`historical profit queue requires qualified local repricing after ${change}`,async t=>{
 let rules:ListingRuleStore;t.after(()=>rules?.close());const f=await legacyOwner(t);rules=new ListingRuleStore(f.directory);
 const high=saveInput(f.store.getProduct(f.product.id));high.variants[0].purchasePrice='100';const source=f.store.saveProduct(high);
 const record=f.p.record(f.draft.id);record.draft.productRevision=source.revision;
 if(change==='manual-quantity')record.draft.salesPlan={namingGroupId:randomUUID(),sourceGroupKey:'same-source',collectedAt:source.createdAt,collectionBasis:'first_import',sku:record.draft.sku,baseSku:record.draft.sku,recipe:buildSalesRecipes(source,null,rules.get())[0],parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'fixture',familyResolved:true,namingChildKey:null};
 f.p.putRecord(record);
 const draft=f.amazon.applyBusinessDefaults({id:record.draft.id,revision:record.draft.revision});
 assert.equal(draft.businessRules!.pricingDecision!.status,'business_blocked');
 const owner=f.ownerService(),task=(owner as any).tasks.get(f.taskId),row=task.items[0];
 Object.assign(row,{productRevision:source.revision,sourceStamp:sourceStamp(source),status:'SCREENED',repair:null});
 if(draft.salesPlan){row.salesPlan=draft.salesPlan;row.key=row.productId+':'+draft.salesPlan.recipe.key;}
 row.outcome={version:1,...pricingOutcome(draft,rules.get()),message:'Historical profit rejection',classifiedAt:new Date().toISOString(),scope:outcomeScope(task,row),draftId:draft.id,draftRevision:draft.revision};task.status='COMPLETED';(owner as any).save(task);
 (owner as any).deps.rules=()=>rules.get();
 if(change==='manual-quantity'){(owner as any).deps.planSales=()=>[];(owner as any).deps.previewSales=()=>buildSalesRecipes(f.store.getProduct(source.id),null,rules.get());}
 const before=JSON.stringify(owner.get(f.taskId));
 if(change==='copy'){const r=f.p.record(draft.id);r.draft.revision++;r.draft.attributes.item_name=[{value:'Rewritten copy'}];f.p.putRecord(r);}
 if(change==='source-title'){const input=saveInput(f.store.getProduct(source.id));input.title='New title';f.store.saveProduct(input);}
 if(change==='unrelated-rules'){const r=rules.get();r.product.stockSets++;r.product.brand='Different display brand';rules.save(r);}
 if(change.startsWith('price-')||change==='missing-cost'){const input=saveInput(f.store.getProduct(source.id));input.variants[0].purchasePrice=change==='price-qualified'?'2.4':change==='missing-cost'?'':'110';f.store.saveProduct(input);}
 if(change==='ceiling-qualified'){const r=rules.get();r.pricing.maxPrice=100;rules.save(r);}
 if(change==='shipping-still-blocked'){const r=rules.get();r.pricing.deliveryTiers=r.pricing.deliveryTiers.map(tier=>({...tier,ordinary:tier.ordinary+1}));rules.save(r);}
 if(change==='package-default'){const r=rules.get();r.product.packageWeight=200;rules.save(r);}
 if(change==='quantity-conflict'){const input=saveInput(f.store.getProduct(source.id));input.variants[0].originalSpec='5 pc / 10 pc';input.variants[0].normalizedSpec='5 pc / 10 pc';f.store.saveProduct(input);}
 if(change==='manual-quantity'){
   const input=saveInput(f.store.getProduct(source.id));input.variants[0].purchasePrice='2.4';const current=f.store.saveProduct(input);
   const r=f.p.record(draft.id);r.draft.attributes.number_of_items=[{value:2,marketplace_id:draft.marketplaceId}];f.p.putRecord(r);
   const preview=f.amazon.previewPricing(draft.id,current);
   assert.ok(preview.businessRules!.quote,'low cost produces a numerical quote despite the manual contradiction');
   assert.equal(preview.businessRules!.pricingDecision!.evidence.saleUnit,'unconfirmed');
   assert.equal(qualifiedPricing(preview,rules.get()),false,'a numerical quote cannot authorize contradictory sale quantity');
   assert.equal(pricingOutcome(preview,rules.get())?.kind,'NEEDS_INPUT');
   const contradictory=structuredClone(preview);contradictory.businessRules!.pricingDecision!.evidence.saleUnit='confirmed';
   assert.equal(qualifiedPricing(contradictory,rules.get()),false,'a claimed confirmation cannot bypass disagreement with the current recipe');
 }
 if(change==='invalid-proof'){const r=f.p.record(draft.id);r.draft.businessRules.pricingDecision.inputs.costCny=0;f.p.putRecord(r);}
 const queue=await owner.queue({productIds:[source.id],targetId:f.target.id}),qualified=['price-qualified','ceiling-qualified'].includes(change);
 assert.equal(queue.products[0].eligibleCount,qualified?1:0);
 if(!['missing-cost','quantity-conflict','manual-quantity','invalid-proof'].includes(change)&&!qualified)assert.equal(queue.products[0].rows[0].kind,'RULE_FILTERED');
 if(change==='manual-quantity')assert.equal(queue.products[0].rows[0].kind,'NEEDS_INPUT');
 assert.equal(JSON.stringify(owner.get(f.taskId)),before,'queue must preserve task, attempts and original outcome');assert.equal(f.requests.length,0);assert.equal(f.previews(),0);
 if(!qualified)await assert.rejects(owner.create({productIds:[source.id],targetId:f.target.id,profileId:'alpha'}));
});

for(const change of ['unrelated','cost-still-blocked','cost-qualified'] as const)test(`W2 explicit apply classifies current real pricing and retains histories: ${change}`,async t=>{
 const f=await legacyOwner(t),owner=f.ownerService(),rules=new ListingRuleStore(f.directory);(owner as any).deps.images.getProgress=()=>null;
 let source=f.store.getProductSnapshot(f.product.id);source=f.store.saveProduct({...saveInput(source),variants:saveInput(source).variants.map(v=>({...v,purchasePrice:'100'}))});
 let r=f.p.record(f.draft.id);r.draft.productRevision=source.revision;f.p.putRecord(r);
 let blocked=f.amazon.applyBusinessDefaults({id:r.draft.id,revision:r.draft.revision},undefined,true);assert.equal(blocked.businessRules?.pricingDecision?.status,'business_blocked');
 const stored=(owner as any).tasks.get(f.taskId),row=stored.items[0];row.productRevision=source.revision;row.sourceStamp=sourceStamp(source);row.status='SCREENED';row.outcome={version:1,...pricingOutcome(blocked,rules.get())!,message:'saved ROI exclusion',classifiedAt:new Date().toISOString(),scope:outcomeScope(stored,row),draftId:blocked.id,draftRevision:blocked.revision};(owner as any).save(stored);
 const before=owner.get(f.taskId),journal=JSON.stringify(f.ai.completionJournal.list(f.draft.id));
 if(change==='unrelated'){const current=rules.get();current.product.stockSets++;rules.save(current);(owner as any).deps.rules=()=>rules.get();}
 else f.store.saveProduct({...saveInput(source),variants:saveInput(source).variants.map(v=>({...v,purchasePrice:change==='cost-qualified'?'2.4':'110'}))});
 const preview=owner.previewAdaptation(f.taskId);assert.equal(preview.canApply,true);assert.equal(preview.changes.some(c=>c.kind==='BLOCKED'),false,JSON.stringify(preview.changes));
 const applied=owner.applyAdaptation({taskId:f.taskId,token:preview.token}),next=applied.items[0];
 assert.equal(applied.status,'PAUSED');assert.equal(next.imageAttempts,before.items[0].imageAttempts);assert.equal(next.repairAttempts,2);assert.deepEqual(next.executionTaskIds,before.items[0].executionTaskIds);assert.equal(JSON.stringify(f.ai.completionJournal.list(f.draft.id)),journal);assert.equal(f.requests.length,0);
 assert.equal(next.status,change==='cost-qualified'?'PENDING':'SCREENED',JSON.stringify(next.outcome));assert.equal(next.outcome?.kind,change==='cost-qualified'?undefined:'RULE_FILTERED');rules.close();
});

test('W2 selection changes never overwrite a persistent profit exclusion or make unrelated re-selection eligible',async t=>{
 const f=await legacyOwner(t),owner=f.ownerService(),rules=new ListingRuleStore(f.directory);try{
  (owner as any).deps.images.getProgress=()=>null;(owner as any).deps.rules=()=>rules.get();
  let source=f.store.getProductSnapshot(f.product.id),input=saveInput(source);input.variants[0].purchasePrice='100';input.variants.push({...input.variants[0],id:randomUUID(),sku:'SECOND-FIXTURE-SKU',originalSpec:'Red',normalizedSpec:'Red',purchasePrice:'2.4'});source=f.store.saveProduct(input);
  const originalAsset=source.assets[0];source=f.store.updateAsset({productId:source.id,revision:source.revision,assetId:originalAsset.id,role:originalAsset.role,variantIds:source.variants.map(v=>v.id)});
  const record=f.p.record(f.draft.id);record.draft.productRevision=source.revision;f.p.putRecord(record);const draft=f.amazon.applyBusinessDefaults({id:record.draft.id,revision:record.draft.revision},undefined,true);assert.equal(draft.businessRules?.pricingDecision?.status,'business_blocked');
  const task=(owner as any).tasks.get(f.taskId),row=task.items[0];Object.assign(row,{productRevision:source.revision,sourceStamp:sourceStamp(source),status:'SCREENED'});row.outcome={version:1,...pricingOutcome(draft,rules.get())!,message:'Original profit exclusion',classifiedAt:new Date().toISOString(),scope:outcomeScope(task,row),draftId:draft.id,draftRevision:draft.revision};
  const second=source.variants[1];task.items.push({...structuredClone(row),key:source.id+':'+second.id,variantId:second.id,sku:second.sku,status:'PENDING',stage:'SOURCES',draftId:null,outcome:undefined,imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,executionTaskIds:[],error:null});(owner as any).save(task);
  (owner as any).deps.planSales=()=>{throw Error('readonly preview must not allocate');};const config=rules.get();config.product.variantLimit=1;rules.save(config);
  const originalReport=structuredClone(row.outcome.pricingReport),p=owner.previewAdaptation(task.id);assert.ok(p.changes.some(c=>c.key===row.key&&c.kind==='PRESERVED'&&c.message.includes('利润')));
  const applied=owner.applyAdaptation({taskId:task.id,token:p.token});assert.deepEqual(applied.items[0].outcome?.pricingReport,originalReport);assert.equal(applied.items[0].status,'SCREENED');assert.notEqual(applied.items[0].outcome?.code,'SKU_SELECTION_FILTERED');
  const reselect=rules.get();reselect.product.variantLimit=2;rules.save(reselect);const current=owner.previewAdaptation(task.id),again=owner.applyAdaptation({taskId:task.id,token:current.token});assert.equal(again.items[0].status,'SCREENED');assert.ok(again.items[0].outcome?.pricingReport);
  const queue=await owner.queue({productIds:[source.id],targetId:f.draft.targetId});assert.equal(queue.products[0].rows.find(r=>r.sku===row.sku)?.eligible,false);assert.equal(f.requests.length,0);
 }finally{rules.close();}
});
