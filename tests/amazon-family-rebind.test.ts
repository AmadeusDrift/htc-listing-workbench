import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AmazonService, FAMILY_REBIND_EVENT_SUMMARY } from '../src/main/amazon/service.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { salesStoreScope } from '../src/main/sales-plans/planning.ts';
import { listingHash } from '../src/main/amazon/context.ts';
import { assertSalesPlanHistory } from '../src/main/sales-plans/history.ts';
import type { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import type { AmazonDraft, JsonObject } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';

const productInput=(product:ProductDetail)=>({id:product.id,revision:product.revision,title:product.title,sourceUrl:product.sourceUrl,description:product.description,status:product.status,facts:product.facts,
  variants:product.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory}))});

async function fixture(t:test.TestContext, specification='型号: A / 颜色: 松针绿 / 包装: 1个装') {
  const root=resolve('.test-data');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'family-rebind-'));
  const store=new WorkspaceStore(directory),naming=new SkuNamingService(directory);
  const service=new AmazonService(directory,id=>store.getProduct(id),{isEncryptionAvailable:()=>false,encryptString:()=>Buffer.alloc(0),decryptString:()=>''},{fetch:async()=>{throw Error('No network in family migration tests')}});
  t.after(()=>{service.close();naming.close();store.close();assert.ok(directory.startsWith(root+'\\'));rmSync(directory,{recursive:true,force:true})});
  let product=store.createProduct();product=store.saveProduct({...productInput(product),title:'Preserved source',description:'Source description',variants:productInput(product).variants.map(v=>({...v,originalSpec:specification,normalizedSpec:'',purchasePrice:'20'}))});
  const target=service.enableDemo(),recipe=buildSalesRecipes(product,null,defaultListingRules())[0];
  const oldGroup=naming.allocate({storeScope:salesStoreScope(target),storeCode:'U2',sourceGroupKey:`local:${product.id}:${'a'.repeat(64)}`,collectedAt:product.createdAt,childKeys:[]});
  const parent=naming.allocate({storeScope:salesStoreScope(target),storeCode:'U2',sourceGroupKey:`local:${product.id}:family:${recipe.groupKey}`,collectedAt:new Date(Date.parse(product.createdAt)+86400000).toISOString(),childKeys:[]});
  const plan:SalesListingPlan={namingGroupId:oldGroup.id,sourceGroupKey:oldGroup.sourceGroupKey,collectedAt:oldGroup.collectedAt,collectionBasis:'first_import',sku:oldGroup.baseSku,baseSku:oldGroup.baseSku,
    recipe:{...recipe,color:'',groupKey:'a'.repeat(64)},parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'Legacy independent sale',familyResolved:true,namingChildKey:null};
  const binding={parentNamingGroupId:parent.id,parentSourceGroupKey:parent.sourceGroupKey,parentBaseSku:parent.baseSku};
  const nextPlan={...structuredClone(plan),parentage:'CHILD',parentSku:parent.baseSku,variationTheme:'COLOR',relationReason:'Exact source color family',familyBinding:binding} as SalesListingPlan;
  const market=target.marketplaceId;
  const prepared=await service.prepareDrafts({targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US',items:[{productId:product.id,productRevision:product.revision,variantId:product.variants[0].id,attributes:{item_name:[{value:'Preserved listing copy',marketplace_id:market,language_tag:'en_US'}],color:[{value:'Wrong old shade',marketplace_id:market}],brand:[{value:'Generic',marketplace_id:market}],main_product_image_locator:[{media_location:'https://images.example.test/main.png',marketplace_id:market}],fulfillment_availability:[{quantity:5,marketplace_id:market}]}}]},[plan]);
  const draft=prepared.items[0].draft;assert.ok(draft,prepared.items[0].error??'draft fixture');
  const originalSchema=service.getSchema.bind(service),schemaReads:string[]=[];
  service.getSchema=async input=>{const selected=input as {parentageLevel:string};schemaReads.push(selected.parentageLevel);const value=await originalSchema(input);if(selected.parentageLevel==='NONE')return value;
    const fields=value.schema.properties as JsonObject,marketplace_id={type:'string',const:market};
    fields.parentage_level={type:'array',items:{type:'object',properties:{value:{const:selected.parentageLevel.toLowerCase()},marketplace_id},required:['value','marketplace_id'],additionalProperties:false}};
    fields.variation_theme={type:'array',items:{type:'object',properties:{name:{enum:['COLOR','NUMBER_OF_ITEMS','COLOR/NUMBER_OF_ITEMS']},marketplace_id},required:['name','marketplace_id'],additionalProperties:false}};
    fields.child_parent_sku_relationship={type:'array',items:{type:'object',properties:{child_relationship_type:{const:'variation'},parent_sku:{type:'string'},marketplace_id},required:['child_relationship_type','parent_sku','marketplace_id'],additionalProperties:false}};
    fields.number_of_items={type:'array',items:{type:'object',properties:{value:{type:'integer',minimum:1},marketplace_id},required:['value','marketplace_id'],additionalProperties:false}};
    return value;
  };
  const persistence=(service as unknown as {persistence:AmazonPersistence}).persistence;
  return {service,store,product,target,draft,plan,nextPlan,parent,naming,persistence,schemaReads};
}
async function rebind(service:AmazonService,input:unknown,signal?:AbortSignal):Promise<AmazonDraft>{
  const method=Reflect.get(service,'rebindUnsubmittedFamily');assert.equal(typeof method,'function','same-ID family rebinding must be implemented');return method.call(service,input as Parameters<AmazonService['rebindUnsubmittedFamily']>[0],signal);
}

test('same-ID NONE to CHILD changes only proven family fields and keeps legacy naming, recipe, copy, images and history',async t=>{
  const f=await fixture(t),record=f.persistence.record(f.draft.id);
  record.preview={revision:record.draft.revision,productRevision:record.draft.productRevision,checksum:record.draft.schema.checksum,version:record.draft.schema.version,generation:0,at:record.draft.updatedAt};
  record.previewResponse={status:'VALID',issues:[]};record.draft.previewedAt=record.draft.updatedAt;
  record.exchanges=[{id:randomUUID(),at:record.draft.updatedAt,operation:'preview',revision:record.draft.revision,request:structuredClone(record.request),response:record.previewResponse,status:200,requestId:'old-preview',schemaChecksum:record.draft.schema.checksum,schemaVersion:record.draft.schema.version}];
  f.persistence.putRecord(record);const before=f.persistence.record(f.draft.id);
  const after=await rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:f.nextPlan});
  assert.equal(after.id,before.draft.id);assert.equal(after.sku,before.draft.sku);assert.equal(after.variantId,before.draft.variantId);assert.equal(after.productRevision,before.draft.productRevision);assert.equal(after.revision,before.draft.revision+1);
  assert.equal(after.schema.parentageLevel,'CHILD');assert.equal(after.state,'DRAFT');assert.deepEqual(after.salesPlan!.recipe,before.draft.salesPlan!.recipe);
  for(const key of ['namingGroupId','sourceGroupKey','sku','baseSku','namingChildKey','collectedAt','collectionBasis'] as const)assert.deepEqual(after.salesPlan![key],before.draft.salesPlan![key]);
  assert.deepEqual(after.attributes.color,[{value:'Pine Needle Green',marketplace_id:f.target.marketplaceId}]);
  const changed=new Set(['parentage_level','variation_theme','child_parent_sku_relationship','color']);
  assert.deepEqual(Object.fromEntries(Object.entries(after.attributes).filter(([key])=>!changed.has(key))),Object.fromEntries(Object.entries(before.draft.attributes).filter(([key])=>!changed.has(key))));
  assert.deepEqual(after.events.slice(0,-1),before.draft.events);assert.equal(after.events.at(-1)!.summary,FAMILY_REBIND_EVENT_SUMMARY);assert.equal(after.events.at(-1)!.at,after.updatedAt);assert.deepEqual(after.salesPlan,f.nextPlan);
  const saved=f.persistence.record(after.id);assert.equal(saved.preview,null);assert.equal(saved.previewResponse,null);assert.equal(after.previewedAt,null);assert.deepEqual(saved.exchanges,before.exchanges);
  assert.equal(f.service.listDrafts(f.product.id).length,1);assert.deepEqual(f.schemaReads,['CHILD']);assert.equal(f.persistence.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='listing.family.rebound'").get()!.n,1);
});

test('family rebind rejects changed recipe or original naming identity before any schema read',async t=>{
  const f=await fixture(t),before=f.persistence.record(f.draft.id);
  for(const change of [{sku:'RENAMED'},{baseSku:'NEW-BASE'},{sourceGroupKey:`local:${f.product.id}:${'b'.repeat(64)}`},{recipe:{...f.plan.recipe,color:'Green'}},{recipe:{...f.plan.recipe,groupKey:'b'.repeat(64)}}]){
    await assert.rejects(rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:{...f.nextPlan,...change}}));
  }
  assert.deepEqual(f.persistence.record(f.draft.id),before);assert.deepEqual(f.schemaReads,[]);
});

test('submitted, unknown, write-locked and stale drafts cannot be rebound',async t=>{
  const f=await fixture(t),before=f.persistence.record(f.draft.id);
  for(const state of ['SUBMITTED','UNKNOWN','SUBMITTING'] as const){const record=structuredClone(before);record.draft.state=state;f.persistence.putRecord(record);await assert.rejects(rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:f.nextPlan}));assert.deepEqual(f.persistence.record(f.draft.id),record)}
  f.persistence.putRecord(before);await assert.rejects(rebind(f.service,{id:f.draft.id,revision:f.draft.revision+1,plan:f.nextPlan}));
  f.persistence.beginWrite(listingHash(f.draft,f.draft.sku),before);await assert.rejects(rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:f.nextPlan}));
  assert.deepEqual(f.schemaReads,[]);
});

test('unsupported theme, missing exact source color and tampered parent naming references are rejected',async t=>{
  const f=await fixture(t);await assert.rejects(rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:{...f.nextPlan,variationTheme:'SIZE'}}));
  await assert.rejects(rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:{...f.nextPlan,familyBinding:{parentNamingGroupId:randomUUID(),parentSourceGroupKey:f.parent.sourceGroupKey,parentBaseSku:f.parent.baseSku}}}));
  const unclear=await fixture(t,'型号: A / 颜色: 可备注颜色 / 包装: 1个装');await assert.rejects(rebind(unclear.service,{id:unclear.draft.id,revision:unclear.draft.revision,plan:unclear.nextPlan}),/颜色|来源/);
});

test('quantity axis uses the unchanged recipe quantity while copy and prices remain untouched',async t=>{
  const f=await fixture(t,'型号: A / 包装: 20支盒装'),plan={...f.nextPlan,variationTheme:'NUMBER_OF_ITEMS'};
  const after=await rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan});
  assert.deepEqual(after.attributes.number_of_items,[{value:20,marketplace_id:f.target.marketplaceId}]);assert.deepEqual(after.attributes.color,f.draft.attributes.color);assert.deepEqual(after.salesPlan!.recipe,f.plan.recipe);
});

test('schema await rechecks source, target, cancellation and persisted draft version before atomic save',async t=>{
  for(const kind of ['source','draft','target','abort'] as const){
    const f=await fixture(t),original=f.service.getSchema.bind(f.service);let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve),abort=new AbortController();
    f.service.getSchema=async input=>{const schema=await original(input);entered();await gate;return schema};
    const operation=rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:f.nextPlan},abort.signal);await started;
    if(kind==='source')f.store.saveProduct({...productInput(f.product),title:'Changed source'});
    if(kind==='draft'){const record=f.persistence.record(f.draft.id);record.draft.revision++;record.draft.attributes.item_name=[{value:'Concurrent edit'}];f.persistence.putRecord(record)}
    if(kind==='target')f.persistence.putTarget({...f.target,marketplaceId:'OTHER'},true);
    if(kind==='abort')abort.abort();
    const before=f.persistence.record(f.draft.id);release();await assert.rejects(operation);assert.deepEqual(f.persistence.record(f.draft.id),before);
  }
});

test('a same-source parent for another model cannot receive this recipe',async t=>{
  const f=await fixture(t),wrong=f.naming.allocate({storeScope:salesStoreScope(f.target),storeCode:'U2',sourceGroupKey:`local:${f.product.id}:family:${'b'.repeat(64)}`,collectedAt:f.product.createdAt,childKeys:[]});
  await assert.rejects(rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:{...f.nextPlan,parentSku:wrong.baseSku,familyBinding:{parentNamingGroupId:wrong.id,parentSourceGroupKey:wrong.sourceGroupKey,parentBaseSku:wrong.baseSku}}}),/同款|规格|来源/);
});

test('unsupported CHILD schema and deprecated theme cannot be persisted',async t=>{
  for(const kind of ['unsupported','deprecated','wrong-scope'] as const){const f=await fixture(t),original=f.service.getSchema.bind(f.service),before=f.persistence.record(f.draft.id);
    f.service.getSchema=async input=>{const schema=await original(input);if(kind==='unsupported')schema.schema.unsupportedMigrationConstraint=true;if(kind==='wrong-scope')schema.locale='fr_FR';if(kind==='deprecated')((schema.schema.properties as any).variation_theme.items.properties.name).$lifecycle={enumDeprecated:['COLOR']};return schema};
    await assert.rejects(rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:f.nextPlan}));assert.deepEqual(f.persistence.record(f.draft.id),before);
  }
});

test('new CHILD non-image validation errors reject atomically and identify the required repair fields',async t=>{
  for(const kind of ['required','changed-type'] as const){const f=await fixture(t),original=f.service.getSchema.bind(f.service),before=f.persistence.record(f.draft.id);
    f.service.getSchema=async input=>{const schema=await original(input);if(kind==='required')(schema.schema.required as string[]).push('material');else ((schema.schema.properties as any).brand.items.properties.value).type='integer';return schema;};
    await assert.rejects(rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:f.nextPlan}),kind==='required'?/CHILD.*material/:/CHILD.*brand/);
    assert.deepEqual(f.persistence.record(f.draft.id),before);assert.equal(f.persistence.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='listing.family.rebound'").get()!.n,0);
  }
});

test('new required image locators remain deferred when seven existing images can supply them',async t=>{
  const f=await fixture(t),original=f.service.getSchema.bind(f.service);
  f.service.getSchema=async input=>{const schema=await original(input);(schema.schema.required as string[]).push('other_product_image_locator_1');return schema;};
  assert.equal((await rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:f.nextPlan})).schema.parentageLevel,'CHILD');
});

test('parent plan uses its own allocation date and family image linkage supports the unchanged legacy child group',async t=>{
  const f=await fixture(t),child=await rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:f.nextPlan}),parentPlan=f.service.familyParentPlan(child);
  assert.equal(parentPlan.collectedAt,f.parent.collectedAt);assert.notEqual(parentPlan.collectedAt,child.salesPlan!.collectedAt);assert.equal(parentPlan.sku,f.parent.baseSku);assert.equal(parentPlan.namingGroupId,f.parent.id);assert.equal(parentPlan.sourceGroupKey,f.parent.sourceGroupKey);assert.equal(parentPlan.parentage,'PARENT');assert.equal(parentPlan.parentSku,null);assert.equal(parentPlan.namingChildKey,null);assert.equal(parentPlan.familyBinding,undefined);assert.deepEqual(parentPlan.recipe,child.salesPlan!.recipe);
  const batch=await f.service.prepareDrafts({targetId:f.target.id,productType:child.schema.productType,parentageLevel:'PARENT',requirements:child.schema.requirements,locale:child.schema.locale,items:[{productId:f.product.id,productRevision:f.product.revision,variantId:child.variantId,attributes:{}}]},[parentPlan]);
  const parent=batch.items[0].draft;assert.ok(parent,batch.items[0].error??'parent');assert.notEqual(parent.salesPlan!.sourceGroupKey,child.salesPlan!.sourceGroupKey);
  const linked=f.service.useFamilyImage(parent.id,child.id);assert.equal(linked.parentImageSourceDraftId,child.id);assert.doesNotThrow(()=>assertSalesPlanHistory(f.persistence.db));
  const before=f.persistence.record(child.id);assert.deepEqual(before.draft,child);
  const wrong=f.persistence.record(parent.id);wrong.draft.salesPlan!.variationTheme='NUMBER_OF_ITEMS';f.persistence.putRecord(wrong);assert.throws(()=>f.service.useFamilyImage(parent.id,child.id),/同商品组/);
});

test('audit persistence failure rolls back the draft migration and releases the busy guard',async t=>{
  const f=await fixture(t),before=f.persistence.record(f.draft.id);
  f.persistence.db.exec("CREATE TRIGGER deny_family_audit BEFORE INSERT ON audit_events WHEN NEW.action='listing.family.rebound' BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
  await assert.rejects(rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:f.nextPlan}),/test audit failure/);assert.deepEqual(f.persistence.record(f.draft.id),before);
  f.persistence.db.exec('DROP TRIGGER deny_family_audit');assert.equal((await rebind(f.service,{id:f.draft.id,revision:f.draft.revision,plan:f.nextPlan})).schema.parentageLevel,'CHILD');
});
