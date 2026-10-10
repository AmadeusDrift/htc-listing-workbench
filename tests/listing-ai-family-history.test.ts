import { confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture as listingFixture, saveInput } from './fixtures/listing-ai.ts';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { salesStoreScope } from '../src/main/sales-plans/planning.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { assertListingHistory } from '../src/main/listing-ai/history.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';
import type { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';

async function fixture(t:test.TestContext) {
  let naming:SkuNamingService|undefined;t.after(()=>naming?.close());
  const f=await listingFixture(t);naming=new SkuNamingService(f.directory);
  const input=saveInput(f.product),product=f.store.saveProduct({...input,variants:input.variants.map(v=>({...v,originalSpec:'颜色: 蓝色 / 包装: 1个装',normalizedSpec:'Blue',purchasePrice:'20'}))});
  await confirmSourceConsistencyFixture(f.directory,f.store,product.id);
  const target=f.amazon.executionTargetScope(f.draft.targetId).target,recipe=buildSalesRecipes(product,null,defaultListingRules())[0];
  const oldGroup=naming.allocate({storeScope:salesStoreScope(target),storeCode:'U2',sourceGroupKey:`local:${product.id}:${'a'.repeat(64)}`,collectedAt:product.createdAt,childKeys:[]});
  const parent=naming.allocate({storeScope:salesStoreScope(target),storeCode:'U2',sourceGroupKey:`local:${product.id}:family:${recipe.groupKey}`,collectedAt:product.createdAt,childKeys:[]});
  const plan:SalesListingPlan={namingGroupId:oldGroup.id,sourceGroupKey:oldGroup.sourceGroupKey,collectedAt:oldGroup.collectedAt,collectionBasis:'first_import',sku:oldGroup.baseSku,baseSku:oldGroup.baseSku,
    recipe:{...recipe,color:'',groupKey:'a'.repeat(64)},parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'Legacy standalone',familyResolved:true,namingChildKey:null};
  const next:SalesListingPlan={...structuredClone(plan),parentage:'CHILD',parentSku:parent.baseSku,variationTheme:'COLOR',relationReason:'Verified same family',familyBinding:{parentNamingGroupId:parent.id,parentSourceGroupKey:parent.sourceGroupKey,parentBaseSku:parent.baseSku}};
  const prepared=await f.amazon.prepareDrafts({targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US',items:[{productId:product.id,productRevision:product.revision,variantId:product.variants[0].id,attributes:f.draft.attributes}]},[plan]);
  const initial=prepared.items[0].draft;assert.ok(initial,prepared.items[0].error??'missing fixture draft');
  const ref={draftId:initial.id,draftRevision:initial.revision},suggestion=await f.listing.suggest(ref),review=await f.listing.review({...ref,suggestionResultId:suggestion.id});
  const adopted=await f.listing.adopt({...ref,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['material']});
  const getSchema=f.amazon.getSchema.bind(f.amazon);
  f.amazon.getSchema=async input=>{const schema=await getSchema(input);if(schema.parentageLevel!=='CHILD')return schema;
    const fields=schema.schema.properties as JsonObject,marketplace_id={type:'string',const:adopted.marketplaceId};
    fields.parentage_level={type:'array',items:{type:'object',properties:{value:{const:'child'},marketplace_id},required:['value','marketplace_id']}};
    fields.variation_theme={type:'array',items:{type:'object',properties:{name:{enum:['COLOR']},marketplace_id},required:['name','marketplace_id']}};
    fields.child_parent_sku_relationship={type:'array',items:{type:'object',properties:{child_relationship_type:{const:'variation'},parent_sku:{type:'string'},marketplace_id},required:['child_relationship_type','parent_sku','marketplace_id']}};
    // Old adopted material used no language wrapper. The new schema does, so
    // accepting the old context without also selecting its schema is insufficient.
    const material=fields.material as JsonObject,items=material.items as JsonObject;
    (items.properties as JsonObject).language_tag={type:'string'};
    schema.checksum='child-checksum';return schema;
  };
  const migrated=await f.amazon.rebindUnsubmittedFamily({id:adopted.id,revision:adopted.revision,plan:next});
  const persistence=(f.amazon as unknown as {persistence:AmazonPersistence}).persistence;
  const row=persistence.db.prepare("SELECT id,detail_json FROM audit_events WHERE action='listing.family.rebound'").get()!;
  const results=new Map(f.ai.listResults(product.id).map(result=>[result.id,result])),calls=new Map(f.ai.listCalls().map(call=>[call.id,call]));
  return {...f,adopted,migrated,persistence,row,results,calls};
}

test('recorded NONE to CHILD migration proves the original adoption schema and survives encrypted backup restore',async t=>{
  const f=await fixture(t);
  assert.throws(()=>assertListingHistory(f.migrated,f.results,f.calls),'no database proof cannot use an obsolete schema');
  assert.doesNotThrow(()=>assertListingHistory(f.migrated,f.results,f.calls,f.persistence.db));
  const backup=join(f.directory,'family-history.htcbackup'),restoredDirectory=join(f.directory,'restored-family-history');
  await createWorkspaceBackup(f.directory,backup,'isolated family history passphrase');
  const prepared=await prepareWorkspaceRestore(restoredDirectory,backup,'isolated family history passphrase');await commitWorkspaceRestore(restoredDirectory,prepared);
  const restored=openDatabase(restoredDirectory);try{
    const saved=JSON.parse(String(restored.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.migrated.id)!.record_json));
    assert.deepEqual(saved.draft.fieldAdoptions,f.adopted.fieldAdoptions);
    assert.doesNotThrow(()=>assertListingHistory(saved.draft,f.results,f.calls,restored));
    assert.equal(restored.prepare("SELECT count(*) AS n FROM audit_events WHERE action='listing.family.rebound'").get()!.n,1);
  }finally{restored.close();}
});

test('later manual draft edits preserve the proven historical schema without changing the adoption',async t=>{
  const f=await fixture(t),attributes=structuredClone(f.migrated.attributes);attributes.material=[{value:'Manual value',marketplace_id:f.migrated.marketplaceId}];
  const saved=f.amazon.saveDraft({id:f.migrated.id,revision:f.migrated.revision,attributes});
  assert.ok(saved.revision>f.migrated.revision);assert.deepEqual(saved.fieldAdoptions,f.adopted.fieldAdoptions);
  assert.doesNotThrow(()=>assertListingHistory(saved,f.results,f.calls,f.persistence.db));
});

for(const kind of ['missing','wrong-draft','wrong-product','revision-gap','changed-schema','changed-current-schema','changed-value','changed-history','changed-recipe','changed-unrelated-field','missing-event','submitted-before','duplicate','invalid-time'] as const){
  test(`old adoption schema rejects invalid family lineage: ${kind}`,async t=>{
    const f=await fixture(t),proof=JSON.parse(String(f.row.detail_json)),draft=structuredClone(f.migrated),db=f.persistence.db;
    if(kind==='wrong-draft')proof.draftId=f.draft.id;
    if(kind==='wrong-product')proof.before.draft.productId=f.draft.id;
    if(kind==='revision-gap')proof.after.draft.revision++;
    if(kind==='changed-schema')proof.before.draft.schema.schema.title='forged old schema';
    if(kind==='changed-current-schema')draft.schema.schema.title='unproven next schema';
    if(kind==='changed-value')for(const saved of [draft,proof.before.draft,proof.after.draft])saved.fieldAdoptions[0].changes[0].after=[{value:'Cotton'}];
    if(kind==='changed-history')proof.before.draft.fieldAdoptions=[];
    if(kind==='changed-recipe')proof.after.draft.salesPlan.recipe.totalPieces++;
    if(kind==='changed-unrelated-field')proof.after.draft.attributes.item_name=[{value:'Rewritten title'}];
    if(kind==='missing-event')proof.after.draft.events.pop();
    if(kind==='submitted-before')proof.before.draft.submittedAt=proof.before.draft.updatedAt;
    if(kind==='invalid-time')proof.before.draft.updatedAt='invalid-time';
    db.prepare('UPDATE audit_events SET detail_json=? WHERE id=?').run(JSON.stringify(proof),f.row.id);
    if(kind==='missing')db.prepare('DELETE FROM audit_events WHERE id=?').run(f.row.id);
    if(kind==='duplicate')db.prepare("INSERT INTO audit_events SELECT 'duplicate-lineage',product_id,action,summary,detail_json,created_at FROM audit_events WHERE id=?").run(f.row.id);
    assert.throws(()=>assertListingHistory(draft,f.results,f.calls,db));
  });
}
