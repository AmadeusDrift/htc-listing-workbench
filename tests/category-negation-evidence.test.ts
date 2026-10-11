import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { categoryAttributeValues, selectedSkuCategoryAttributes, sourceAttributes, sourceMappingReport } from '../src/main/amazon/demo.ts';
// Frozen v0-v3 category parsing and persisted-history compatibility; v4 uses full-schema evidence.
import { buildListingContext } from './helpers/legacy-listing-context.ts';
import { assertListingEvidence, assertListingReview, validateListingFieldsOutput, listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { assertListingEvidence as assertV2Evidence } from '../src/main/listing-ai/evidence-validation-v2.ts';
import { currentCopyIssues, assertCurrentImageCategoryExclusions } from '../src/main/listing-ai/current-evidence.ts';
import { parseCategorySource } from '../src/main/listing-ai/evidence-category-v2.ts';
import { sceneSet } from './fixtures/image-set.ts';
import { legacyFixture as fixture, saveInput, chat } from './fixtures/listing-ai.ts';
import { validateAiResult, validateStoredAiResult } from '../src/main/ai/validation.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { join } from 'node:path';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import type { CandidateField, ListingAiContext, ListingEvidence } from '../src/shared/listing-ai-contracts.ts';

const schema={type:'array',items:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}};
const fact=(name:string,value:string,source:ListingEvidence['source']='source_confirmed'):ListingEvidence=>({id:randomUUID(),name,value,meaning:'general',source});
const candidate=(field:CandidateField,value:string,evidence:ListingEvidence[],infer=false)=>validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field,items:[{value,evidenceIds:evidence.map(e=>e.id),transformation:infer?'infer':'translate',...(infer?{inferenceReason:'Ordinary judgment from the actual product category.'}:{})}]}],missing:[]});
const scope=(field:CandidateField,evidence:ListingEvidence[])=>({fields:[{name:field,closedEnum:false,allowedValues:[]}],evidence,productType:'TOOTHBRUSH'}) as unknown as ListingAiContext;

test('bounded category parsing excludes negative age, firmness and power without inferring opposites',()=>{
  for(const [field,raw,expected] of [
    ['age_range_description','不适合儿童',[]],['age_range_description','不适合儿童；适用成人',['Adult']],
    ['age_range_description','非织物；适用成人',['Adult']],['age_range_description','Not suitable for children; adults',['Adult']],
    ['power_source_type','非电动',[]],['power_source_type','无电池',[]],['power_source_type','手动；非电动',['Manual']],
    ['power_source_type','Manual; not electric',['Manual']],['item_firmness_description','非软毛；硬毛',['Hard']],
    ['age_range_description','不是不适合儿童',[]],['age_range_description','三岁以上',[]],
  ] as const)assert.deepEqual(categoryAttributeValues(field,raw),expected,raw);
});

test('negative sources reject typed candidates, infer and PASS reviews while mixed clauses retain support',()=>{
  for(const [field,value,name,raw,accepted] of [
    ['age_range_description','Child','适用年龄','不适合儿童',false],['age_range_description','Adult','适用年龄','不适合儿童',false],
    ['age_range_description','Adult','适用年龄','不适合儿童；适用成人',true],['target_audience','Adults','适用人群','不适合儿童；适用成人',true],
    ['target_audience','Adults','适用人群','非织物；适用成人',true],['power_source_type','Manual','供电方式','非电动',false],
    ['power_source_type','Electric','供电方式','非电动',false],['power_source_type','Manual','供电方式','无电池',false],
    ['operation_mode','Manual','操作方式','手动；非电动',true],['operation_mode','Manual','供电方式','手动；非电动',true],
    ['operation_mode','Manual','操作方式','非手动',false],
  ] as const){
    const e=[fact(name,raw)],context=scope(field,e),output=candidate(field,value,e);
    const check=()=>assertListingEvidence(output,context);
    if(accepted)assert.doesNotThrow(check,raw);else{
      assert.throws(check,`${field}: ${raw}`);
      if(['age_range_description','power_source_type'].includes(field))assert.throws(()=>assertListingEvidence(candidate(field,value,e,true),context));
      const item=output.candidates[0].items[0];
      assert.throws(()=>assertListingReview({kind:'amazon-fields-review',verdict:'PASS',checks:[{field,index:0,verdict:'SUPPORTED',evidenceIds:item.evidenceIds,reason:'Recorded claim.',claims:[{text:value,verdict:'SUPPORTED',evidenceIds:item.evidenceIds,reason:'Recorded claim.'}]}],issues:[]},output,context));
    }
  }
});

test('a selected specification containing only exclusions is present evidence, never an infer escape',()=>{
  for(const [field,raw,value] of [['age_range_description','不适合儿童','Adult'],['power_source_type','非电动','Manual'],['power_source_type','无电池','Manual']] as const){
    const e=[fact('Selected SKU specification',raw,'selected_sku'),fact('产品类别','Toothbrush')];
    assert.throws(()=>assertListingEvidence(candidate(field,value,e,true),scope(field,e)),raw);
  }
});

test('valid negative-looking category literals and boolean false retain their exact meaning',()=>{
  for(const [field,raw,value] of [['flavor','无味','Unflavored'],['scent','无香','Unscented'],['dental_floss_type','无蜡牙线','Unwaxed'],['contains_liquid_contents','false','false'],['is_heat_sensitive','非热敏','false']] as const){
    assert.deepEqual(categoryAttributeValues(field,raw),[value]);const e=[fact(field,raw)];assert.doesNotThrow(()=>assertListingEvidence(candidate(field,value,e),scope(field,e)));
  }
});

test('finite nonnegative modifiers do not turn affirmed categories or operation into exclusions',()=>{
  assert.deepEqual(categoryAttributeValues('item_firmness_description','非常柔软'),['Soft']);
  assert.deepEqual(categoryAttributeValues('power_source_type','non-slip manual'),['Manual']);
  const e=[fact('操作方式','Manual with non-slip handle')];
  assert.doesNotThrow(()=>assertListingEvidence(candidate('operation_mode','Manual',e),scope('operation_mode',e)));
  const audience=[fact('目标人群','Non-smokers')];
  assert.doesNotThrow(()=>assertListingEvidence(candidate('target_audience','Non-smokers',audience),scope('target_audience',audience)));
});

for(const raw of ['不适合儿童','适用年龄：三岁以上'])test(`selected original source cannot fall through to normalized affirmative or common facts: ${raw}`,async t=>{
  const f=await fixture(t,{age_range_description:schema}),product=structuredClone(f.product),draft=structuredClone(f.draft),variant=product.variants[0];
  variant.sourceSpec=raw;variant.originalSpec='Children Blue';variant.normalizedSpec='Children Blue';
  product.facts.push({id:randomUUID(),name:'适用年龄',value:'成人',source:'manual',sourceRef:'fixture',state:'human_confirmed'});
  draft.attributes.age_range_description=[{value:'Child'}];
  assert.equal(selectedSkuCategoryAttributes(variant).age_range_description,undefined);
  const attributes=sourceAttributes(product,variant,draft.schema,f.amazon.getTarget(draft.targetId),'haul');
  assert.equal(attributes.age_range_description,undefined);
  const report=sourceMappingReport(product,variant,draft.schema,f.amazon.getTarget(draft.targetId),'haul',attributes).find(field=>field.field==='age_range_description')!;
  assert.equal(report.status,'needs_input');
  const context=buildListingContext(draft,product,1),selected=context.evidence.find(e=>e.source==='selected_sku'&&e.name==='适用人群');
  assert.equal(selected?.value,raw);
  for(const value of ['Child','Adult'])assert.throws(()=>assertListingEvidence(candidate('age_range_description',value,context.evidence,true),context));
});

test('a named negative category fact cannot be seeded as an affirmative or raw canonical attribute',async t=>{
  const f=await fixture(t,{age_range_description:schema,power_source_type:schema}),product=structuredClone(f.product);
  product.facts.push(...[['适用年龄','不适合儿童'],['供电方式','非电动']].map(([name,value])=>({id:randomUUID(),name,value,source:'manual' as const,sourceRef:'fixture',state:'human_confirmed' as const})));
  const attributes=sourceAttributes(product,product.variants[0],f.draft.schema,f.amazon.getTarget(f.draft.targetId),'haul');
  assert.equal(attributes.age_range_description,undefined);assert.equal(attributes.power_source_type,undefined);
});

test('selected negative age survives a hidden age card and cannot clear a real blocker or use sibling age',async t=>{
  const f=await fixture(t),product=structuredClone(f.product),draft=structuredClone(f.draft),variant=product.variants[0];
  (draft.schema.schema.properties as any).target_audience=schema;
  variant.sourceSpec='不适合儿童';variant.originalSpec='Blue';variant.normalizedSpec='Blue';
  product.variants.push({...variant,id:randomUUID(),sku:'SIBLING',sourceSpec:'成人',originalSpec:'Adult',normalizedSpec:'Adult'});
  let context=buildListingContext(draft,product,1);assert.equal(context.fields.some(field=>field.name==='age_range_description'),false);
  assert.ok(context.evidence.some(e=>e.source==='selected_sku'&&e.value==='不适合儿童'));
  assert.throws(()=>assertListingEvidence(candidate('target_audience','Children',context.evidence),context));
  assert.ok(currentCopyIssues([{field:'item_name',values:['Child Coaster']}],context).length);
  product.facts.push({id:randomUUID(),name:'适用年龄',value:'成人',source:'manual',sourceRef:'fixture',state:'conflicting'});
  context=buildListingContext(draft,product,1);assert.equal(context.evidenceBlockers?.[0].field,'age_range_description');
});

test('explicit product-wide exclusions also reject positive prose without rejecting unrelated copy',()=>{
  const e=[fact('适用年龄','不适合儿童'),fact('供电方式','非电动')],context=scope('item_name',e);
  for(const value of ['Child Coaster','Electric Coaster'])assert.throws(()=>assertListingEvidence(candidate('item_name',value,e),context));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Coaster',e),context));
});

test('a bounded exclusion also blocks its named narrower category without inferring an alternative',()=>{
  for(const [name,raw,value] of [['供电方式','非电动','Corded Electric Coaster'],['刷毛硬度','非软毛','Extra Soft Bristles']] as const){
    const e=[fact(name,raw)];assert.throws(()=>assertListingEvidence(candidate('item_name',value,e),scope('item_name',e)),raw);
  }
});

test('unresolved negative scope retains the affected categories as prose constraints',()=>{
  for(const raw of ['不适合儿童和婴儿','not for children or babies','不是不适合儿童']){
    const e=[fact('适用年龄',raw)],context=scope('item_name',e);
    assert.throws(()=>assertListingEvidence(candidate('item_name','Child Coaster',e),context),raw);
    assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Coaster',e),context),raw);
  }
});

test('unresolved subtype lists retain each separately named category in candidate and current copy constraints',()=>{
  for(const [field,name,raw,terms,claims] of [
    ['power_source_type','供电方式','not electric or corded electric',['Electric','Corded Electric'],['Electric Coaster','Corded Electric Coaster']],
    ['power_source_type','供电方式','非电动或有线电动',['Electric','Corded Electric'],['Electric Coaster','Corded Electric Coaster']],
    ['power_source_type','供电方式','not corded electric or electric',['Electric','Corded Electric'],['Electric Coaster','Corded Electric Coaster']],
    ['power_source_type','供电方式','非有线电动或电动',['Electric','Corded Electric'],['Electric Coaster','Corded Electric Coaster']],
    ['item_firmness_description','刷毛硬度','not soft or extra soft',['Soft','Extra Soft'],['Soft Bristles','Extra Soft Bristles']],
    ['item_firmness_description','刷毛硬度','非软毛或超软毛',['Soft','Extra Soft'],['Soft Bristles','Extra Soft Bristles']],
    ['item_firmness_description','刷毛硬度','not extra soft or soft',['Soft','Extra Soft'],['Soft Bristles','Extra Soft Bristles']],
    ['item_firmness_description','刷毛硬度','非超软毛或软毛',['Soft','Extra Soft'],['Soft Bristles','Extra Soft Bristles']],
  ] as const){
    const parsed=parseCategorySource(field,raw);
    assert.deepEqual(new Set(parsed.unresolved),new Set(terms),raw);
    assert.equal(parsed.unparsed,true);assert.deepEqual(parsed.values,[]);
    const e=[fact(name,raw)],context=scope('item_name',e);
    for(const value of claims){
      assert.throws(()=>assertListingEvidence(candidate('item_name',value,e),context),`${raw}: ${value}`);
      assert.ok(currentCopyIssues([{field:'item_name',values:[value]}],context).length,`${raw}: ${value}`);
    }
    assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Coaster',e),context));
    assert.deepEqual(currentCopyIssues([{field:'item_name',values:['Coaster']}],context),[]);
  }
});

test('a subtype token alone never excludes its broader category and clean affirmative normalization stays stable',()=>{
  for(const [field,name,raw,term,broaderClaim] of [
    ['power_source_type','供电方式','not corded electric','Corded Electric','Electric Coaster'],
    ['power_source_type','供电方式','非有线电动','Corded Electric','Electric Coaster'],
    ['item_firmness_description','刷毛硬度','not extra soft','Extra Soft','Soft Bristles'],
    ['item_firmness_description','刷毛硬度','非超软毛','Extra Soft','Soft Bristles'],
    ['item_firmness_description','刷毛硬度','not not extra soft','Extra Soft','Soft Bristles'],
  ] as const){
    const parsed=parseCategorySource(field,raw);
    assert.deepEqual([...parsed.excluded,...parsed.unresolved],[term],raw);
    const e=[fact(name,raw)],context=scope('item_name',e);
    assert.doesNotThrow(()=>assertV2Evidence(candidate('item_name',broaderClaim,e),context),raw);
    // v2 exclusions never invent a broader exclusion. v3 also requires positive support.
    assert.throws(()=>assertListingEvidence(candidate('item_name',broaderClaim,e),context),raw);
    assert.ok(currentCopyIssues([{field:'item_name',values:[broaderClaim]}],context).length,raw);
  }
  assert.deepEqual(categoryAttributeValues('power_source_type','electric or corded electric'),['Corded Electric']);
  assert.deepEqual(categoryAttributeValues('item_firmness_description','soft or extra soft'),['Extra Soft']);
  assert.deepEqual(categoryAttributeValues('item_firmness_description','超软毛；非硬毛'),['Extra Soft']);
});

const checkOldCaption=(text:string,context:ListingAiContext)=>{
  const set=sceneSet();set.slots[1].expectedText=[{text,evidenceIds:context.evidence.map(item=>item.id)}];
  assertCurrentImageCategoryExclusions(context,{setPlan:set,plans:[]});
};
for(const channel of ['candidate','current copy','old caption'] as const)test(`unrelated candidate negation never erases source exclusions in ${channel}`,()=>{
  for(const [name,raw,text] of [
    ['适用年龄','不适合儿童','Child Coaster with no battery'],
    ['适用年龄','不适合儿童','Child Coaster, non-electric'],
    ['适用年龄','不适合儿童','Child Coaster without batteries'],
    ['供电方式','非电动','Electric Coaster for non-smokers'],
    ['刷毛硬度','非软毛','Soft Bristles with no battery'],
    ['适用年龄','not for children or adults','Child Coaster with no battery'],
    ['适用年龄','不适合儿童','Child Coaster; not for children'],
  ]){
    const e=[fact(name,raw)],context=scope('item_name',e);
    if(channel==='candidate')assert.throws(()=>assertListingEvidence(candidate('item_name',text,e),context),text);
    else if(channel==='current copy')assert.ok(currentCopyIssues([{field:'item_name',values:[text]}],context).length,text);
    else assert.throws(()=>checkOldCaption(text,context),text);
  }
});

test('candidate exclusions and broad terms are not promoted to affirmative or narrower category claims',()=>{
  for(const [name,raw,text] of [
    ['适用年龄','不适合儿童','Coaster not for children'],['适用年龄','不适合儿童','Coaster; not for children'],['适用年龄','不适合儿童','Coaster'],
    ['刷毛硬度','非超软毛','Soft Bristles with no battery'],['供电方式','非有线电动','Electric Coaster for non-smokers'],
    ['供电方式','非电动','Non-electric Coaster'],
  ]){
    const e=[fact(name,raw)],context=scope('item_name',e);
    assert.doesNotThrow(()=>assertV2Evidence(candidate('item_name',text,e),context),text);
    if(text==='Soft Bristles with no battery'||text==='Electric Coaster for non-smokers'){
      assert.throws(()=>assertListingEvidence(candidate('item_name',text,e),context),text);
      assert.ok(currentCopyIssues([{field:'item_name',values:[text]}],context).length,text);
      assert.throws(()=>checkOldCaption(text,context),text);
    }else{
      assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name',text,e),context),text);
      assert.deepEqual(currentCopyIssues([{field:'item_name',values:[text]}],context),[],text);
      assert.doesNotThrow(()=>checkOldCaption(text,context),text);
    }
  }
});

for(const [name,raw,text] of [
  ['刷毛硬度','非超软毛','Soft Bristles with no battery; not extra soft'],
  ['供电方式','非有线电动','Electric Coaster for non-smokers; non-corded electric'],
])test(`candidate subtype constraints stay within their own clause: ${name}`,()=>{
  const e=[fact(name,raw)],context=scope('item_name',e);
  assert.doesNotThrow(()=>assertV2Evidence(candidate('item_name',text,e),context));
  assert.throws(()=>assertListingEvidence(candidate('item_name',text,e),context));
  assert.ok(currentCopyIssues([{field:'item_name',values:[text]}],context).length);
  assert.throws(()=>checkOldCaption(text,context));
});

test('an affirmative or unresolved subtype in its own clause remains constrained despite other negative clauses',()=>{
  for(const [name,raw,text] of [
    ['适用年龄','不适合儿童','Child Coaster; not for children'],
    ['刷毛硬度','非超软毛','Extra Soft Bristles; not extra soft'],
    ['刷毛硬度','非超软毛','Soft Bristles; extra soft bristles with no battery'],
    ['供电方式','非有线电动','Corded Electric Coaster; non-corded electric'],
    ['供电方式','非有线电动','Electric Coaster; corded electric for non-smokers'],
  ]){
    const e=[fact(name,raw)],context=scope('item_name',e);
    assert.throws(()=>assertListingEvidence(candidate('item_name',text,e),context),text);
    assert.ok(currentCopyIssues([{field:'item_name',values:[text]}],context).length,text);
    assert.throws(()=>checkOldCaption(text,context),text);
  }
});

test('unrelated candidate negation cannot hide real age or power blockers',()=>{
  for(const [field,name,text] of [
    ['age_range_description','适用年龄','Child Coaster with no battery'],
    ['power_source_type','供电方式','Electric Coaster for non-smokers'],
  ] as const){
    const e=[fact('Material','Silicone')],context=scope('item_name',e);
    context.evidenceBlockers=[{field,reason:'source_conflict',facts:[{id:randomUUID(),name,value:'conflicting source'}]}];
    assert.throws(()=>assertListingEvidence(candidate('item_name',text,e),context),text);
    assert.ok(currentCopyIssues([{field:'item_name',values:[text]}],context).length,text);
    assert.deepEqual(currentCopyIssues([{field:'item_name',values:['Coaster']}],context),[]);
  }
});

test('comma and slash within negative category lists never reset the next item to affirmative',()=>{
  for(const raw of ['不适合儿童/成人','not for children/adults','not for children, adults']){
    assert.deepEqual(categoryAttributeValues('age_range_description',raw),[],raw);
    const e=[fact('适用年龄',raw)];
    for(const value of ['Adult','Child'])assert.throws(()=>assertListingEvidence(candidate('age_range_description',value,e),scope('age_range_description',e)),raw);
    for(const value of ['Adult Coaster','Child Coaster'])assert.throws(()=>assertListingEvidence(candidate('item_name',value,e),scope('item_name',e)),raw);
    assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Coaster',e),scope('item_name',e)),raw);
  }
});

test('an explicit affirmative introducer after a comma starts its own bounded category clause',()=>{
  for(const raw of ['不适合儿童，适用成人','not for children, suitable for adults']){
    assert.deepEqual(categoryAttributeValues('age_range_description',raw),['Adult']);const e=[fact('适用年龄',raw)];
    assert.doesNotThrow(()=>assertListingEvidence(candidate('age_range_description','Adult',e),scope('age_range_description',e)));
    assert.throws(()=>assertListingEvidence(candidate('age_range_description','Child',e),scope('age_range_description',e)));
  }
});

test('irrelevant negative clauses leave a clean context evidence order, values and hash unchanged',async t=>{
  const f=await fixture(t),product=structuredClone(f.product),before=buildListingContext(f.draft,product,1);
  product.variants[0].sourceSpec='非织物';
  assert.equal(listingFingerprint(buildListingContext(f.draft,product,1)),listingFingerprint(before));
});

test('sales recipe normalization does not replace the anchored supplier exclusion with a sibling affirmative',async t=>{
  const f=await fixture(t,{age_range_description:schema}),product=structuredClone(f.product);
  product.variants=['红色','蓝色'].map((color,index)=>({...product.variants[0],id:index?randomUUID():product.variants[0].id,sku:`SOURCE-${index}`,sourceSpec:index?'成人':'不适合儿童',originalSpec:`颜色: ${color} / 尺寸: 小号`,normalizedSpec:`颜色: ${color} / 尺寸: 小号`,purchasePrice:'.1'}));
  const recipe=buildSalesRecipes(product,null,defaultListingRules()).find(recipe=>recipe.components.length>1)!;
  recipe.specification='Children mixed colors';
  const draft={...f.draft,variantId:recipe.components[0].variantId,sku:'H2-261010-1-C',attributes:{...f.draft.attributes,age_range_description:[{value:'Child'}]},salesPlan:{namingGroupId:randomUUID(),sourceGroupKey:'manual:group',collectedAt:product.createdAt,collectionBasis:'first_import' as const,sku:'H2-261010-1-C',baseSku:'H2-261010-1',recipe,parentage:'NONE' as const,parentSku:null,variationTheme:null,relationReason:'Independent',familyResolved:true,namingChildKey:recipe.key}};
  const anchor=product.variants.find(variant=>variant.id===draft.variantId)!;anchor.sourceSpec='不适合儿童';
  const context=buildListingContext(draft,product,1);
  assert.ok(context.evidence.some(e=>e.source==='selected_sku'&&e.value==='不适合儿童'));
  assert.throws(()=>assertListingEvidence(candidate('age_range_description','Child',context.evidence,true),context));
  assert.ok(context.evidence.some(e=>e.id.endsWith(':sale-color')&&e.value==='Mixed colors'));
});

async function negativeAgeDraft(t:test.TestContext){
  const f=await fixture(t,{age_range_description:schema});
  const product=f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,{id:randomUUID(),name:'适用年龄',value:'不适合儿童',source:'manual',sourceRef:'fixture',state:'human_confirmed'}]});
  let draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  draft=f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,age_range_description:[{value:'Child'}],item_name:[{value:'Silicone Coaster'}]}});
  return {...f,product,draft,reference:{draftId:draft.id,draftRevision:draft.revision}};
}

test('legacy results stamp v3 and partial repair retains legal fields without a policy retry',async t=>{
  const f=await negativeAgeDraft(t),context=buildListingContext(f.draft,f.product,1),age=context.evidence.find(e=>e.name==='适用年龄')!,material=context.evidence.find(e=>e.meaning==='material')!;
  context.fields=context.fields.filter(field=>['material','age_range_description'].includes(field.name));context.repairRequest={issues:[],currentValues:{}};
  f.respond(()=>chat({kind:'amazon-fields',candidates:[...candidate('material','Silicone',[material]).candidates,...candidate('age_range_description','Child',[age],true).candidates],missing:[]}));
  const result=await f.ai.listingFields(context,async()=>{});
  assert.equal(result.listingEvidenceContractVersion,'listing-evidence/v3');
  if(result.output.kind!=='amazon-fields')throw Error('fields');
  assert.deepEqual(result.output.candidates.map(item=>item.field),['material']);assert.deepEqual(result.output.missing.map(item=>item.field),['age_range_description']);
  assert.equal(f.requests.length,1);assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);
  assert.throws(()=>validateListingFieldsOutput({...result.output,listingEvidenceContractVersion:'listing-evidence/v2'}));
});

for(const version of [undefined,'listing-evidence/v1','listing-evidence/v2'] as const)test(`saved ${version??'v0'} listing result keeps its literal and bytes while current rejects negative claims`,async t=>{
  const f=await negativeAgeDraft(t),result=structuredClone(await f.listing.suggest(f.reference)),context=result.listingContext!,age=context.evidence.find(e=>e.name==='适用年龄')!;
  if(version==='listing-evidence/v2')age.value='不适合儿童；适用成人';
  delete result.fieldRejections; // This literal historical payload predates presentation sidecars.
  result.output=candidate('age_range_description',version==='listing-evidence/v2'?'Adult':'Child',[age]);
  if(version===undefined)delete result.listingEvidenceContractVersion;else (result as any).listingEvidenceContractVersion=version;
  result.sourceSha256=listingFingerprint(context);
  assert.deepEqual(validateStoredAiResult(result),result);
  if(version==='listing-evidence/v2')assert.deepEqual(validateAiResult(result),result);else assert.throws(()=>validateAiResult(result));
  const raw=JSON.stringify(result),db=openDatabase(f.directory);try{const call=JSON.parse(String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(result.callId)!.record_json));delete call.presentationContext;db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),result.callId);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(raw,result.id);}finally{db.close();}
  assert.deepEqual(f.ai.getResult(result.id),result);assert.ok(f.ai.queryResults({productId:f.product.id}).items.some(item=>item.id===result.id));
  const before=f.requests.length;
  await assert.rejects(f.listing.review({...f.reference,suggestionResultId:result.id}));
  await assert.rejects(f.listing.adopt({...f.reference,suggestionResultId:result.id,reviewResultId:null,fields:['age_range_description']}));
  await assert.rejects(f.listing.snapshotCurrentForImages(f.reference));assert.equal(f.requests.length,before);
  const path=join(f.directory,'versioned.htcbackup'),target=join(f.directory,'restored'),password='isolated negation evidence backup';
  await createWorkspaceBackup(f.directory,path,password);await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,path,password));
  const restored=openDatabase(target);try{assert.equal(restored.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json,raw);}finally{restored.close();}
  const invalid=structuredClone(result);(invalid as any).listingEvidenceContractVersion='listing-evidence/v999';assert.throws(()=>validateStoredAiResult(invalid));
});

test('current validation stays strict for unmarked, v1 and v2 results',async t=>{
  const f=await negativeAgeDraft(t),result=structuredClone(await f.listing.suggest(f.reference)),context=result.listingContext!,age=context.evidence.find(e=>e.name==='适用年龄')!;
  delete result.fieldRejections; // This literal historical payload predates presentation sidecars.
  result.output=candidate('age_range_description','Child',[age]);
  for(const version of [undefined,'listing-evidence/v1','listing-evidence/v2']){
    const input={...result,listingEvidenceContractVersion:version};if(version===undefined)delete input.listingEvidenceContractVersion;
    assert.throws(()=>validateAiResult(input),String(version));
    if(version==='listing-evidence/v2')assert.throws(()=>validateStoredAiResult(input));else assert.doesNotThrow(()=>validateStoredAiResult(input));
  }
});

test('DONE completion reports the excluded category with zero new calls and preserves its journal',async t=>{
  const f=await negativeAgeDraft(t),operation=f.listing.beginCompletion(f.reference);operation.state='DONE';operation.remaining=[];f.ai.completionJournal.save(operation);
  const before=JSON.stringify(f.listing.getCompletion(operation.id)),result=await f.listing.complete(f.reference,undefined,operation.id);
  assert.equal(result.aiCalls,0);assert.equal(result.previewAttempts,0);assert.equal(f.requests.length,0);
  assert.ok(result.remaining.some(value=>value.includes('age_range_description')));assert.equal(JSON.stringify(f.listing.getCompletion(operation.id)),before);
});
