import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ProductDetail } from '../src/shared/contracts.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { projectSalesProduct, validateSalesPlan } from '../src/main/sales-plans/records.ts';
import { chooseVariationTheme, relationshipAttributes } from '../src/main/sales-plans/families.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';

const makeProduct = (): ProductDetail => ({ id:randomUUID(),title:'收纳夹',sourceUrl:'',description:'',revision:1,status:'draft',origin:'manual',createdAt:'2026-10-08T01:00:00Z',updatedAt:'2026-10-08T01:00:00Z',assets:[],facts:[],
  variants:['红色','蓝色'].map((color,index)=>({id:randomUUID(),sku:`SOURCE-${index}`,originalSpec:`颜色: ${color} / 尺寸: 小号`,sourceSpec:'',normalizedSpec:'',purchasePrice:'.1',sourcePurchasePrice:'.1',inventory:null})) });
function plan(product:ProductDetail):SalesListingPlan { return { namingGroupId:randomUUID(),sourceGroupKey:'1688:123:small',collectedAt:product.createdAt,collectionBasis:'first_import',sku:'H2-261008-1-C',baseSku:'H2-261008-1',
  recipe:buildSalesRecipes(product,null,defaultListingRules()).at(-1)!,parentage:'CHILD',parentSku:'H2-261008-1',variationTheme:'COLOR',relationReason:'当前 Schema 支持颜色变体',familyResolved:true,namingChildKey:null }; }

test('sales projection keeps source unchanged, binds all components and exposes exact sales quantity/cost',()=>{
  const product=makeProduct(),before=structuredClone(product),sale=plan(product);sale.namingChildKey=sale.recipe.key;
  assert.deepEqual(validateSalesPlan(sale),sale);
  const projected=projectSalesProduct(product,sale,sale.recipe.components[0].variantId);
  assert.deepEqual(product,before);
  const variant=projected.variants.find(v=>v.id===sale.recipe.components[0].variantId)!;
  assert.equal(variant.sku,sale.sku);assert.equal(variant.purchasePrice,'1');assert.match(variant.normalizedSpec,/10 pc/);
  assert.equal(projected.facts.find(f=>f.name==='销售件数')?.value,'10');
  product.variants[0].sku='DIFFERENT';
  assert.throws(()=>projectSalesProduct(product,sale,sale.recipe.components[0].variantId),/来源/);
});
test('persisted recipes reject altered totals and duplicate components',()=>{
  const sale=plan(makeProduct());sale.namingChildKey=sale.recipe.key;
  assert.throws(()=>validateSalesPlan({...sale,recipe:{...sale.recipe,totalPieces:999}}));
  assert.throws(()=>validateSalesPlan({...sale,recipe:{...sale.recipe,components:[sale.recipe.components[0],sale.recipe.components[0]]}}));
});
test('family theme must be allowed, current and cover actual differences; unsupported families stay independent',()=>{
  const recipes=buildSalesRecipes(makeProduct(),null,defaultListingRules()),schema=realAmazonSchema();
  Object.assign(schema.schema.properties!,{
    variation_theme:{type:'array',items:{type:'object',properties:{name:{type:'string',enum:['COLOR','COLOR/NUMBER_OF_ITEMS'], $lifecycle:{enumDeprecated:['COLOR']}}}}},
    parentage_level:{type:'array',items:{type:'object',properties:{value:{enum:['parent','child']}}}},
    child_parent_sku_relationship:{type:'array',items:{type:'object',properties:{child_relationship_type:{const:'variation'},parent_sku:{type:'string'}}}},
  });
  assert.equal(chooseVariationTheme(schema,recipes),'COLOR/NUMBER_OF_ITEMS');
  assert.equal(chooseVariationTheme(realAmazonSchema(),recipes),null);
  const sale=plan(makeProduct());sale.namingChildKey=sale.recipe.key;
  const attrs=relationshipAttributes(schema,sale);
  assert.equal((attrs.child_parent_sku_relationship as any)[0].parent_sku,sale.baseSku);
  assert.equal((attrs.parentage_level as any)[0].value,'child');
});

test('quantity-only families use an allowed number-of-items theme without a fictitious color',()=>{
  const p=makeProduct();p.variants[0].originalSpec='型号: 标准牙签 / 规格: 50支盒装';p.variants[1].originalSpec='型号: 标准牙签 / 规格: 100支盒装';
  const rules=defaultListingRules();rules.pricing.bundleEnabled=false;
  const recipes=buildSalesRecipes(p,null,rules),schema=realAmazonSchema();
  Object.assign(schema.schema.properties!,{
    variation_theme:{type:'array',items:{type:'object',properties:{name:{type:'string',enum:['COLOR','NUMBER_OF_ITEMS','COLOR/NUMBER_OF_ITEMS']}}}},
    parentage_level:{type:'array',items:{type:'object',properties:{value:{enum:['parent','child']}}}},
    child_parent_sku_relationship:{type:'array',items:{type:'object',properties:{child_relationship_type:{const:'variation'},parent_sku:{type:'string'}}}},
  });
  assert.equal(chooseVariationTheme(schema,recipes),'NUMBER_OF_ITEMS');
  (schema.schema.properties as Record<string,any>).variation_theme.items.properties.name.enum=['COLOR'];assert.equal(chooseVariationTheme(schema,recipes),null);
});
