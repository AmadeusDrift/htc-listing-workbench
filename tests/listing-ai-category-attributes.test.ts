import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fixture, chat, reviewFor } from './fixtures/listing-ai.ts';
import { buildListingContext, listingModelPayload } from '../src/main/listing-ai/context.ts';
import { assertListingEvidence, assertListingReview, listingFingerprint, validateListingFieldsOutput, validateListingReviewOutput } from '../src/main/listing-ai/validation.ts';
import { sourceAttributes, sourceFieldName, sourceMappingReport } from '../src/main/amazon/demo.ts';
import { candidateTextValues, validateFieldValues, wrapCandidateValues } from '../src/main/amazon/field-mapping.ts';
import { currentImageListingSnapshot } from '../src/main/image-workflow/image-facts.ts';
import { assertCurrentListingReview } from '../src/main/ai/image-validation.ts';
import { suggestListingFields } from '../src/main/ai/listing-adapters.ts';
import { validateAiResult, validateStoredAiResult } from '../src/main/ai/validation.ts';
import { buildFieldCatalog } from '../src/main/amazon/field-catalog.ts';
import { listingFieldPolicy, CATEGORY_INFERENCE_POLICY_VERSION } from '../src/shared/listing-ai-contracts.ts';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';

const inferableFields=['item_firmness_description','age_range_description','is_heat_sensitive','power_source_type','material_feature','is_expiration_dated_product','item_form','dental_floss_type','flavor','contains_liquid_contents','scent','specific_uses_for_product','surface_recommendation','closure','department','target_gender'];
const fields=[...inferableFields,'ingredients'];
const boolFields=['is_heat_sensitive','is_expiration_dated_product','contains_liquid_contents'];
const schemas=Object.fromEntries(fields.map(name=>[name,{type:'array',title:name,minItems:1,maxItems:1,items:{type:'object',properties:{value:{type:boolFields.includes(name)?'boolean':'string'},marketplace_id:{type:'string'}},required:['value','marketplace_id'],additionalProperties:false}}])) as JsonObject;
const output=(field:string,value:unknown,evidenceIds=['category'],extra:Record<string,unknown>={})=>({kind:'amazon-fields',candidates:[{field,items:[{value,evidenceIds,transformation:'translate',...extra}]}],missing:[]});
const inference={transformation:'infer',inferenceReason:'Based on the manual toothbrush category and plastic construction, this is an ordinary non-perishable product attribute, not a measured shelf-life claim.'};

test('schema-required product judgments and source-only ingredients are offered while compliance remains excluded',async t=>{
  const f=await fixture(t,schemas);f.draft.schema.schema.required=[...(f.draft.schema.schema.required as string[]),...fields];const context=buildListingContext(f.draft,f.product,1);
  for(const field of fields)assert.ok(context.fields.some(card=>card.name===field),field);
  assert.equal(context.fields.some(card=>String(card.name)==='batteries_required'),false);
  assert.equal(context.fields.some(card=>String(card.name)==='supplier_declared_dg_hz_regulation'),false);
});

test('unrequested optional category fields preserve old context fields and evidence until schema validation needs them',async t=>{
  const f=await fixture(t,schemas),product={...f.product,variants:[{...f.product.variants[0],normalizedSpec:'儿童硬毛牙刷',originalSpec:'儿童硬毛牙刷'}]};
  const context=buildListingContext(f.draft,product,1);
  assert.equal(context.fields.some(card=>fields.includes(card.name)),false);
  assert.equal(context.evidence.some(e=>e.id.endsWith(':age_range_description')||e.id.endsWith(':item_firmness_description')),false);
  const triggered={...f.draft,previewIssues:[{code:'90220',message:'Missing heat status',severity:'ERROR' as const,attributeNames:['is_heat_sensitive'],category:'field' as const,source:'amazon' as const,autoFixable:false}]};
  assert.deepEqual(buildListingContext(triggered,product,1).fields.filter(card=>fields.includes(card.name)).map(card=>card.name),['is_heat_sensitive']);
  f.draft.attributes.is_expiration_dated_product=[{value:false,marketplace_id:f.draft.marketplaceId}];
  assert.deepEqual(buildListingContext(f.draft,product,1).fields.filter(card=>fields.includes(card.name)).map(card=>card.name),['is_expiration_dated_product']);
});

test('limited inferred attributes retain a reason and real citations; native and text booleans normalize identically',()=>{
  const context:any={productType:'TOOTHBRUSH',fields:fields.map(name=>({name})),evidence:[{id:'category',name:'产品类别',value:'手动牙刷',meaning:'general',source:'source_confirmed'}]};
  for(const field of boolFields)for(const value of [true,false,'true','false']){
    const candidate=validateListingFieldsOutput(output(field,value,['category'],inference));
    assert.equal(candidate.candidates[0].items[0].value,String(value));
    assert.equal(candidate.candidates[0].items[0].transformation,'infer');
    assert.equal(candidate.candidates[0].items[0].inferenceReason,inference.inferenceReason);
    assert.doesNotThrow(()=>assertListingEvidence(candidate,context));
  }
  for(const value of ['yes','no',0,1])assert.throws(()=>validateListingFieldsOutput(output('is_heat_sensitive',value,['category'],inference)));
  for(const field of ['material','color','item_name','batteries_required'])assert.throws(()=>validateListingFieldsOutput(output(field,'Plastic',['category'],inference)));
  assert.throws(()=>validateListingFieldsOutput(output('is_heat_sensitive',false,['category'],{transformation:'infer'})));
  assert.throws(()=>validateListingFieldsOutput(output('is_heat_sensitive',false,[],inference)));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('is_heat_sensitive',false,['missing'],inference)),context));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('material_feature','BPA Free',['category'],inference)),context));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('material_feature','Heat Resistant to 200 C',['category'],inference)),context));
});

test('explicit selected toothbrush age and firmness override conflicting product-wide facts in both mapping and copy',async t=>{
  const f=await fixture(t,schemas);
  for(const [spec,field,value,bad] of [
    ['颜色: 亮洁雨儿童牙刷619','age_range_description','Child','Adult'],
    ['颜色: 佳洁净808（中毛）','item_firmness_description','Medium','Soft'],
    ['颜色: 卡白941（波浪硬毛）','item_firmness_description','Hard','Soft'],
    ['颜色: 卡白983（硬毛）','item_firmness_description','Hard','Soft'],
  ]){
    const product={...f.product,facts:[...f.product.facts,{id:randomUUID(),name:'适用人群',value:'成人',source:'1688' as const,sourceRef:'',state:'source_confirmed' as const},{id:randomUUID(),name:'功能',value:'软毛',source:'1688' as const,sourceRef:'',state:'source_confirmed' as const}],variants:[{...f.product.variants[0],normalizedSpec:spec,originalSpec:spec,sourceSpec:spec}]};
    const draft={...f.draft,listingProgram:'haul' as const,schema:{...f.draft.schema,productType:'TOOTHBRUSH',schema:{...f.draft.schema.schema,required:[...(f.draft.schema.schema.required as string[]),...fields]}}},context=buildListingContext(draft,product,1);
    const selected=context.evidence.filter(e=>e.source==='selected_sku').map(e=>e.id);
    assert.doesNotThrow(()=>assertListingEvidence(validateListingFieldsOutput(output(field,value,selected)),context));
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output(field,bad,selected,inference)),context));
    const badCopy=field==='age_range_description'?'Manual Toothbrush for Adults':'Soft Bristle Toothbrush';
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('item_name',badCopy,selected)),context));
    const attributes=sourceAttributes(product,product.variants[0],draft.schema,f.amazon.getTarget(draft.targetId),'haul');
    assert.equal((attributes[field] as any)?.[0]?.value,value);
    const mapping=sourceMappingReport(product,product.variants[0],draft.schema,f.amazon.getTarget(draft.targetId),'haul',attributes).find(entry=>entry.field===field)!;
    assert.equal(mapping.status,'mapped');assert.deepEqual(mapping.sourceFactIds,[],'selected SKU must not be attributed to conflicting global facts');
    assert.ok(context.evidence.some(e=>e.source==='selected_sku'&&e.value===value));
  }
});

test('explicit expiry and power facts cannot be reversed by a model inference',()=>{
  for(const [field,name,source,bad] of [['is_expiration_dated_product','是否有保质期','是','false'],['is_heat_sensitive','是否对热敏感','是','false'],['power_source_type','供电方式','手动','Battery Powered']]){
    const context:any={productType:'TOOTHBRUSH',fields:[{name:field}],evidence:[{id:'category',name:'产品类别',value:'牙刷',meaning:'general',source:'source_confirmed'},{id:'explicit',name,value:source,meaning:'general',source:'source_confirmed'}]};
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output(field,bad,['category'],inference)),context));
  }
});

test('an explicit manual product category supports translation and prevents a contradictory battery inference',()=>{
  const context:any={productType:'TOOTHBRUSH',fields:[{name:'power_source_type'},{name:'item_name'}],evidence:[{id:'category',name:'产品类别',value:'手动',meaning:'general',source:'source_confirmed'}]};
  assert.doesNotThrow(()=>assertListingEvidence(validateListingFieldsOutput(output('power_source_type','Manual')),context));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('power_source_type','Battery Powered',['category'],inference)),context));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('item_name','Electric Toothbrush')),context));
});

test('source aliases map category fields and boolean wrappers remain native through image-copy snapshots',async t=>{
  const f=await fixture(t,schemas),aliases:Record<string,string>={'刷毛硬度':'item_firmness_description','适用年龄':'age_range_description','是否对热敏感':'is_heat_sensitive','供电方式':'power_source_type','材料特性':'material_feature','是否有保质期':'is_expiration_dated_product'};
  for(const [name,field] of Object.entries(aliases))assert.equal(sourceFieldName(name,'haul'),field);
  const draft=structuredClone(f.draft);
  for(const field of boolFields){
    for(const value of [true,false,'true','false']){
      const wrapped=wrapCandidateValues(draft.schema,draft.marketplaceId,field,[value]);
      assert.equal((wrapped as any)[0].value,String(value)==='true');
      assert.deepEqual(candidateTextValues(field,wrapped),[String(value)]);
      assert.equal(validateFieldValues(draft.schema,draft.marketplaceId,field,[value]).length,0);
    }
    draft.attributes[field]=wrapCandidateValues(draft.schema,draft.marketplaceId,field,['false']);
  }
  const snapshot=currentImageListingSnapshot(draft,buildListingContext(draft,f.product,1));
  for(const field of boolFields)assert.deepEqual(snapshot.currentListingCopy.find(item=>item.field===field)?.values,['false']);
  assert.equal((wrapCandidateValues(draft.schema,draft.marketplaceId,'batteries_required',['false']) as any)[0].value,'false','new conversion must not alter battery policy');
});

test('a reviewed boolean inference can be adopted without changing source facts or recording it as confirmed evidence',async t=>{
  const f=await fixture(t,schemas),before=structuredClone(f.product.facts);
  const initial=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,is_expiration_dated_product:[{value:true,marketplace_id:f.draft.marketplaceId}]}}),reference={draftId:initial.id,draftRevision:initial.revision};
  f.respond(payload=>{
    if(payload.candidate)return chat(reviewFor(payload));
    const evidence=payload.evidence.find((entry:any)=>entry.name==='产品类型');
    return chat({kind:'amazon-fields',candidates:[{field:'is_expiration_dated_product',items:[{value:false,evidenceIds:[evidence.id],...inference}]}],missing:payload.fields.filter((card:any)=>card.name!=='is_expiration_dated_product').map((card:any)=>({field:card.name,reason:'Not part of this test'}))});
  });
  const suggestion=await f.listing.suggest(reference),review=await f.listing.review({...reference,suggestionResultId:suggestion.id});
  assert.equal(suggestion.output.kind,'amazon-fields');
  if(suggestion.output.kind!=='amazon-fields')return;
  const context=suggestion.listingContext!;
  assertListingReview(validateListingReviewOutput(review.output),suggestion.output,context);
  const adopted=await f.listing.adopt({...reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['is_expiration_dated_product']});
  assert.equal((adopted.attributes.is_expiration_dated_product as any)[0].value,false);
  assert.equal(suggestion.output.candidates[0].items[0].inferenceReason,inference.inferenceReason);
  assert.deepEqual(f.store.getProduct(f.product.id).facts,before);
  assert.ok(adopted.fieldAdoptions?.at(-1)?.changes[0].evidence.every(e=>e.name!=='is_expiration_dated_product'));
});

test('real floss, cleaner and keychain requirements follow bounded product judgment or source extraction',async t=>{
  const f=await fixture(t,schemas);
  for(const field of inferableFields)assert.equal(listingFieldPolicy(field),'product_judgment',field);
  assert.equal(listingFieldPolicy('ingredients'),'source_attribute');
  for(const field of ['item_volume','number_of_boxes','batteries_required','supplier_declared_dg_hz_regulation'])assert.notEqual(listingFieldPolicy(field),'product_judgment');
  for(const [productType,category,values] of [
    ['DENTAL_FLOSS','牙线签',{dental_floss_type:'Floss Pick',item_form:'Pick',flavor:'Unflavored'}],
    ['KEYCHAIN','钥匙扣',{closure:'Split Ring',department:'Unisex',target_gender:'unisex'}],
    ['CLEANING_AGENT','洁厕剂',{contains_liquid_contents:false,specific_uses_for_product:'Toilet Cleaning',surface_recommendation:'Toilet'}],
  ] as const){
    const context:any={productType,fields:fields.map(name=>({name})),evidence:[{id:'category',name:'产品类别',value:category,meaning:'general',source:'source_confirmed'}]};
    for(const [field,value] of Object.entries(values))assert.doesNotThrow(()=>assertListingEvidence(validateListingFieldsOutput(output(field,value,['category'],{transformation:'infer',inferenceReason:`根据来源商品类别 ${category} 判断该普通产品属性；未声明化学、量测或合规结论。`})),context),field);
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('ingredients','Sodium Hypochlorite',['category'])),context));
    assert.throws(()=>validateListingFieldsOutput(output('ingredients','Sodium Hypochlorite',['category'],inference)));
  }
  const source:Record<string,[string,string,string|boolean]>={物理形态:['item_form','块状','Solid'],香型:['scent','玫瑰','Rose'],成分:['ingredients','洁厕剂+香精','Toilet Cleaner + Fragrance'],适用场景:['specific_uses_for_product','厕所','Toilet Cleaning'],是否含液体:['contains_liquid_contents','否',false]};
  const product={...f.product,facts:Object.entries(source).map(([name,[,value]])=>({id:randomUUID(),name,value:String(value),source:'1688' as const,sourceRef:'',state:'source_confirmed' as const}))};
  const draft={...f.draft,listingProgram:'haul' as const,schema:{...f.draft.schema,productType:'CLEANING_AGENT',schema:{...f.draft.schema.schema,required:[...(f.draft.schema.schema.required as string[]),...fields]}}};
  const context=buildListingContext(draft,product,1),attributes=sourceAttributes(product,product.variants[0],draft.schema,f.amazon.getTarget(draft.targetId),'haul');
  for(const [name,[field,,value]] of Object.entries(source)){
    assert.equal(sourceFieldName(name,'haul'),field);
    assert.equal((attributes[field] as any)?.[0]?.value,value);
    const evidence=product.facts.find(f=>f.name===name)!;
    assert.doesNotThrow(()=>assertListingEvidence(validateListingFieldsOutput(output(String(field),value,[evidence.id])),context));
  }
  const scent=product.facts.find(f=>f.name==='香型')!,ingredient=product.facts.find(f=>f.name==='成分')!;
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('scent','Lavender',[scent.id])),context));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('ingredients','Sodium Hypochlorite and Fragrance',[ingredient.id])),context));
});

test('current listing review accepts a justified product judgment without requiring invented source facts',()=>{
  const context:any={productType:'DENTAL_FLOSS',fields:[{name:'is_expiration_dated_product'}],evidence:[{id:'category',name:'产品类别',value:'牙线签',meaning:'general',source:'source_confirmed'}]};
  const copy:any=[{field:'is_expiration_dated_product',values:['false']}];
  const review=validateListingReviewOutput({kind:'amazon-fields-review',verdict:'PASS',checks:[{field:'is_expiration_dated_product',index:0,verdict:'SUPPORTED',evidenceIds:['category'],reason:'基于普通牙线签类别作出非保质期产品的分类判断，没有推断保质期天数。',claims:[{text:'false',verdict:'SUPPORTED',evidenceIds:['category'],reason:'普通牙线签的产品判断。'}]}],issues:[]});
  assert.doesNotThrow(()=>assertCurrentListingReview(review,copy,context));
  const explicit={...context,evidence:[...context.evidence,{id:'expiry',name:'是否有保质期',value:'是',meaning:'general',source:'source_confirmed'}]};
  assert.throws(()=>assertCurrentListingReview(review,copy,explicit));
});

test('attribute reviews can split ingredient and use phrases without confusing ingredient names with SKU colors',()=>{
  for(const [field,value,source,claims] of [
    ['ingredients','Toilet Cleaner + Fragrance','洁厕剂+香精',['Toilet Cleaner','Fragrance']],
    ['specific_uses_for_product','Toilet Cleaning','厕所',['Toilet','Cleaning']],
    ['flavor','Orange','Orange',['Orange']],
  ] as const){
    const context:any={productType:'CLEANING_AGENT',fields:[{name:field}],evidence:[{id:'direct',name:field,value:source,meaning:'general',source:'source_confirmed'}]};
    const candidate=validateListingFieldsOutput(output(field,value,['direct']));
    const review=validateListingReviewOutput({kind:'amazon-fields-review',verdict:'PASS',checks:[{field,index:0,verdict:'SUPPORTED',evidenceIds:['direct'],reason:'Faithful source translation.',claims:claims.map(text=>({text,verdict:'SUPPORTED',evidenceIds:['direct'],reason:'Faithful source translation.'}))}],issues:[]});
    assert.doesNotThrow(()=>assertListingReview(review,candidate,context),field);
  }
});

test('repair accepts native boolean enum values but preserves exact schema enum restrictions',async()=>{
  for(const [field,value,allowedValues,accepted] of [
    ['contains_liquid_contents',false,[false,true],true],['is_heat_sensitive','false',[false],true],
    ['is_expiration_dated_product',false,[true],false],['target_gender','unisex',['unisex','male','female'],true],
    ['target_gender','Unisex',['unisex','male','female'],false],
  ] as const){
    const context:any={productType:'KEYCHAIN',fields:[{name:field,closedEnum:true,allowedValues}],evidence:[{id:'category',name:'产品类别',value:'钥匙扣',meaning:'general',source:'source_confirmed'}],repairRequest:{issues:[],currentValues:{}}};
    const result=await suggestListingFields(context,'deepseek-flash',{apiKey:'test-only'},new AbortController().signal,{now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,fetch:async()=>chat(output(field,value,['category'],inference))});
    assert.equal(result.output.candidates.length,accepted?1:0,`${field}:${value}`);
    if(!accepted)assert.match(result.output.missing[0].reason,/枚举/);
  }
});

test('saved legacy current-copy reviews survive reading while current and marked reviews reject old contradictions',async t=>{
  const f=await fixture(t),context=buildListingContext(f.draft,f.product,1);
  context.evidence=[{id:`${context.variantId}:spec`,name:'Selected SKU specification',value:'颜色: 佳洁净808（中毛） · 1 pc',meaning:'general',source:'selected_sku'}];
  const value='Manual Toothbrush with Soft Bristles, Medium Bristle Head',copy=[{field:'item_name' as const,values:[value]}];
  const review=validateListingReviewOutput({kind:'amazon-fields-review',verdict:'PASS',checks:[{field:'item_name',index:0,verdict:'SUPPORTED',evidenceIds:[context.evidence[0].id],reason:'Recorded legacy review.',claims:[{text:value,verdict:'SUPPORTED',evidenceIds:[context.evidence[0].id],reason:'Recorded legacy review.'}]}],issues:[]});
  const result={id:randomUUID(),callId:randomUUID(),providerId:'deepseek-review',productId:context.productId,productRevision:context.productRevision,variantId:context.variantId,assetId:null,assetSha256:null,sourceResultIds:[],model:'deepseek-v4-pro',createdAt:new Date().toISOString(),reviewState:'unreviewed',listingContext:context,sourceSha256:listingFingerprint(context),output:{...review,kind:'listing-current-review',currentListingCopy:copy,copySha256:listingFingerprint(copy)}};
  assert.throws(()=>assertCurrentListingReview(review,copy,context));
  assert.throws(()=>validateAiResult(result));
  assert.doesNotThrow(()=>validateStoredAiResult(result));
  context.categoryInferencePolicyVersion=CATEGORY_INFERENCE_POLICY_VERSION;result.sourceSha256=listingFingerprint(context);
  assert.throws(()=>validateStoredAiResult(result));
});

test('real KEYCHAIN nested closure schema preserves constraints and wraps, validates and reads back its text leaf',async t=>{
  const f=await fixture(t),snapshot={...f.draft.schema,schema:JSON.parse(readFileSync(new URL('./fixtures/amazon/keychain-closure.json',import.meta.url),'utf8'))};
  const card=buildFieldCatalog(snapshot).find(card=>card.name==='closure')!;
  assert.equal(card.closedEnum,false);assert.ok(card.suggestedValues.includes('Split Ring'));assert.equal(card.maxLength,500);
  const wrapped=wrapCandidateValues(snapshot,f.draft.marketplaceId,'closure',['Split Ring']);
  assert.deepEqual(wrapped,[{type:[{value:'Split Ring',language_tag:'en_US'}],marketplace_id:f.draft.marketplaceId}]);
  assert.deepEqual(candidateTextValues('closure',wrapped),['Split Ring']);
  assert.equal(validateFieldValues(snapshot,f.draft.marketplaceId,'closure',['Split Ring']).length,0);
  assert.ok(validateFieldValues(snapshot,f.draft.marketplaceId,'closure',['x'.repeat(501)]).length);
});

test('source category values map to actual schema enums without inventing a more specific form',async t=>{
  const f=await fixture(t),snapshot={...f.draft.schema,...JSON.parse(readFileSync(new URL('./fixtures/amazon/cleaning-agent-schema.json',import.meta.url),'utf8'))};
  const facts=[{id:'form',name:'物理形态',value:'块状',meaning:'general' as const,source:'source_confirmed' as const},{id:'use',name:'适用场景',value:'厕所',meaning:'general' as const,source:'source_confirmed' as const}];
  const context:any={productType:'CLEANING_AGENT',fields:[{name:'item_form'},{name:'specific_uses_for_product'}],evidence:facts};
  const currentAttributes={unit_count:[{value:10,type:{value:'Count',language_tag:'en_US'},marketplace_id:f.draft.marketplaceId}]};
  assert.ok(validateFieldValues(snapshot,f.draft.marketplaceId,'item_form',['Block'],currentAttributes).length,'actual Count dependency excludes Block');
  for(const [field,value,id] of [['item_form','Solid','form'],['specific_uses_for_product','Toilet','use']]){
    assert.equal(validateFieldValues(snapshot,f.draft.marketplaceId,field,[value],currentAttributes).length,0,field);
    assert.doesNotThrow(()=>assertListingEvidence(validateListingFieldsOutput(output(field,value,[id],{transformation:'enum_map'})),context));
  }
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('item_form','Tablet',['form'],{transformation:'enum_map'})),context));
  const product={...f.product,facts:facts.map(fact=>({id:randomUUID(),name:fact.name,value:fact.value,source:'1688' as const,sourceRef:'',state:'source_confirmed' as const}))};
  const attributes=sourceAttributes(product,product.variants[0],snapshot,f.amazon.getTarget(f.draft.targetId),'haul');
  assert.deepEqual(candidateTextValues('item_form',attributes.item_form),['Solid']);
  const flossContext:any={productType:'DENTAL_FLOSS',fields:[{name:'dental_floss_type'}],evidence:[{id:'type',name:'牙线类型',value:'牙线签',meaning:'general',source:'source_confirmed'}]};
  for(const value of ['dental_pick','flosser'])assert.doesNotThrow(()=>assertListingEvidence(validateListingFieldsOutput(output('dental_floss_type',value,['type'],{transformation:'enum_map'})),flossContext));
});

test('model input distinguishes fixed values, closed single-choice options and open text suggestions without changing stored context',()=>{
  const context:any={fields:[
    {name:'is_heat_sensitive',closedEnum:true,allowedValues:[false],suggestedValues:[]},
    {name:'target_gender',closedEnum:true,allowedValues:['unisex','male','female'],suggestedValues:[]},
    {name:'power_source_type',closedEnum:false,allowedValues:[],suggestedValues:['Battery Powered','Corded Electric','Solar Powered']},
  ],productType:'TOOTHBRUSH',evidence:[{id:'manual',name:'产品类别',value:'手动',meaning:'general',source:'source_confirmed'}]};
  const before=structuredClone(context),payload=listingModelPayload(context);
  assert.deepEqual(payload.fields.map(field=>field.valueMode),['fixed','single_choice','free_text']);
  assert.deepEqual(payload.fields[0].options,[false]);assert.deepEqual(payload.fields[1].options,['unisex','male','female']);
  assert.deepEqual(payload.fields[2].suggestedOptions,['Battery Powered','Corded Electric','Solar Powered']);
  assert.deepEqual(context,before);
  assert.doesNotThrow(()=>assertListingEvidence(validateListingFieldsOutput(output('power_source_type','Manual',['manual'])),context));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('target_gender','other',['manual'],inference)),context));
  assert.doesNotThrow(()=>assertListingEvidence(validateListingFieldsOutput(output('is_heat_sensitive',false,['manual'],inference)),context));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('is_heat_sensitive',true,['manual'],inference)),context));
});
