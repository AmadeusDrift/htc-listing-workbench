import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertListingEvidence, assertListingReview, validateListingFieldsOutput, validateListingContext, listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { buildListingContext, listingModelPayload } from '../src/main/listing-ai/context.ts';
import { fixture, saveInput, chat } from './fixtures/listing-ai.ts';
import type { CandidateField, ListingAiContext, ListingEvidence } from '../src/shared/listing-ai-contracts.ts';
import { validateAiResult } from '../src/main/ai/validation.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { join } from 'node:path';
import { currentDraftEvidenceIssues, CONTRACT_ADOPTION_FIELDS } from '../src/main/listing-ai/current-evidence.ts';
import { decideEvidence } from '../src/main/listing-ai/evidence-contract-v1.ts';
import { categoryAttributeValues } from '../src/main/listing-ai/evidence-category-v1.ts';

const fact=(name:string,value:string):ListingEvidence=>({id:randomUUID(),name,value,meaning:'general',source:'source_confirmed'});
const candidate=(field:CandidateField,value:string,evidence:ListingEvidence[],infer=false)=>validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field,items:[{value,evidenceIds:evidence.map(e=>e.id),transformation:infer?'infer':'translate',...(infer?{inferenceReason:'Selected product category supports this ordinary judgment.'}:{})}]}],missing:[]});
const scope=(field:CandidateField,evidence:ListingEvidence[])=>({fields:[{name:field,closedEnum:false,allowedValues:[]}],evidence,productType:'CLEANING_AGENT'}) as unknown as ListingAiContext;

test('equivalent explicit age and manual power aliases support their related semantic fields',()=>{
  for(const [field,value,name,source] of [
    ['target_audience','Adults','适用人群','成人'],['target_audience','Adults','适用年龄','成人'],
    ['target_audience','Children','年龄范围','儿童'],['operation_mode','Manual','操作方式','手动'],['operation_mode','Manual','供电方式','手动'],
  ] as const){const evidence=[fact(name,source)];assert.doesNotThrow(()=>assertListingEvidence(candidate(field,value,evidence),scope(field,evidence)),name);}
});

for(const [name,source] of [['operation_mode','Manual operation'],['操作方式','手动操作'],['工作方式','手动操作']] as const)test(`explicit operation wording retains support and power consistency: ${name}`,()=>{
  const evidence=[fact(name,source)];
  assert.doesNotThrow(()=>assertListingEvidence(candidate('operation_mode','Manual',evidence),scope('operation_mode',evidence)));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('power_source_type','Manual',evidence),scope('power_source_type',evidence)));
  assert.throws(()=>assertListingEvidence(candidate('power_source_type','Electric',evidence),scope('power_source_type',evidence)));
  evidence[0].value=name==='operation_mode'?'Not manual operation':'非手动操作';
  assert.throws(()=>assertListingEvidence(candidate('operation_mode','Manual',evidence),scope('operation_mode',evidence)));
});

test('only explicit affirmative power values can bridge to operation mode',()=>{
  for(const name of ['供电方式','电源类型','动力来源','power_source_type'])for(const source of ['手动','Manual','手动操作','Manual operation','非手动','非电动']){
    const evidence=[fact(name,source)],run=()=>assertListingEvidence(candidate('operation_mode','Manual',evidence),scope('operation_mode',evidence));
    if(['手动','Manual'].includes(source))assert.doesNotThrow(run,`${name}=${source}`);else assert.throws(run,`${name}=${source}`);
  }
});

test('present unparsed source is never a wildcard or an inference permission',()=>{
  for(const [field,value,name,source] of [
    ['age_range_description','Adult','适用年龄','三岁以上'],['is_expiration_dated_product','false','是否有保质期','待确认'],
    ['ingredients','Sodium Hypochlorite','成分','未知配方'],
  ] as const){
    const direct=fact(name,source),category=fact('产品类别','清洁剂'),evidence=[direct,category];
    assert.throws(()=>assertListingEvidence(candidate(field,value,evidence),scope(field,evidence)),name);
    if(field!=='ingredients')assert.throws(()=>assertListingEvidence(candidate(field,value,evidence,true),scope(field,evidence)),`${name}: infer`);
  }
});

test('ingredient translation is finite, set-equivalent and never adds concentration',()=>{
  for(const [source,value,accepted] of [['柠檬酸','Citric Acid',true],['柠檬酸','Sodium Hypochlorite',false],['水+香精','Fragrance + Water',true],['Sodium Citrate','Sodium Citrate',true],['未知配方','Sodium Citrate',false],['柠檬酸','10% Citric Acid',false]] as const){
    const evidence=[fact('成分',source)],run=()=>assertListingEvidence(candidate('ingredients',value,evidence),scope('ingredients',evidence));
    if(accepted)assert.doesNotThrow(run,`${source}=>${value}`);else assert.throws(run,`${source}=>${value}`);
  }
});

for(const source of ['constructor','__proto__'])test(`v1 audience dictionary ignores inherited properties: ${source}`,()=>{
  const evidence=[fact('适用年龄',source)],decision=decideEvidence('target_audience','Adults',{evidence});
  assert.equal(decision.status,source==='constructor'?'conflict':'unparsed');
  assert.throws(()=>assertListingEvidence(candidate('target_audience','Adults',evidence),scope('target_audience',evidence)));
});

test('v1 ingredient dictionary preserves plain English and rejects unsupported inherited property names',()=>{
  for(const source of ['constructor','toString']){
    assert.deepEqual(categoryAttributeValues('ingredients',source),[source]);
    const evidence=[fact('成分',source)];
    assert.doesNotThrow(()=>assertListingEvidence(candidate('ingredients',source,evidence),scope('ingredients',evidence)));
    assert.throws(()=>assertListingEvidence(candidate('ingredients','Citric Acid',evidence),scope('ingredients',evidence)));
  }
  assert.deepEqual(categoryAttributeValues('ingredients','__proto__'),[]);
});

test('General and unrelated category evidence cannot become adult or powered operation',()=>{
  for(const [field,value,name,source] of [['target_audience','Adults','适用人群','通用'],['target_audience','Adults','适用年龄','General'],['operation_mode','Automatic','供电方式','手动'],['ingredients','Citric Acid','产品类别','清洁剂']] as const){
    const evidence=[fact(name,source)];assert.throws(()=>assertListingEvidence(candidate(field,value,evidence),scope(field,evidence)));
  }
});

test('explicit Chinese general audience retains its finite legacy translations across intended-user aliases',()=>{
  for(const name of ['适用人群','适用对象','目标人群','使用人群','target_audience','intended users']){
    const evidence=[fact(name,'通用')];
    for(const value of ['General','All','General Use','Unisex'])assert.doesNotThrow(()=>assertListingEvidence(candidate('target_audience',value,evidence),scope('target_audience',evidence)),`${name} -> ${value}`);
    for(const value of ['Adults','Kids','All Ages','Baby','Men and Women'])assert.throws(()=>assertListingEvidence(candidate('target_audience',value,evidence),scope('target_audience',evidence)),`${name} -> ${value}`);
  }
  const evidence=[fact('适用人群','男女通用')];
  for(const value of ['Unisex','Men and Women'])assert.doesNotThrow(()=>assertListingEvidence(candidate('target_audience',value,evidence),scope('target_audience',evidence)));
});

test('general-to-unisex compatibility does not erase source scope conflicts or broaden age bridges',()=>{
  for(const [name,source,value] of [['适用人群','General','Unisex'],['适用人群','Unisex','General'],['适用人群','男女通用','General'],['适用年龄','通用','Unisex'],['产品名称','通用','Unisex']] as const){
    const evidence=[fact(name,source)];assert.throws(()=>assertListingEvidence(candidate('target_audience',value,evidence),scope('target_audience',evidence)));
  }
  const general=fact('适用人群','通用');
  for(const other of [fact('target_audience','Children'),fact('target_audience','Unisex'),fact('适用年龄','三岁以上'),fact('target_audience','General')]){
    const evidence=[general,other];assert.throws(()=>assertListingEvidence(candidate('target_audience','Unisex',[general]),scope('target_audience',evidence)));
  }
  const child={...fact('适用年龄','儿童'),source:'selected_sku' as const},selected=[general,child];
  assert.throws(()=>assertListingEvidence(candidate('target_audience','Unisex',[general]),scope('target_audience',selected)));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('target_audience','Children',[child]),scope('target_audience',selected)));
  const blocked={...scope('target_audience',[general]),evidenceBlockers:[{field:'age_range_description' as const,reason:'source_conflict' as const,facts:[{id:randomUUID(),name:'适用人群',value:'通用'}]}]};
  assert.throws(()=>assertListingEvidence(candidate('target_audience','Unisex',[general]),blocked));
});

test('new cross-field aliases do not grant permission from negative age or power facts',()=>{
  for(const [field,value,name,source] of [['target_audience','Adults','适用年龄','不适合成人'],['operation_mode','Manual','供电方式','非手动'],['operation_mode','Electric','供电方式','非电动']] as const){const evidence=[fact(name,source)];assert.throws(()=>assertListingEvidence(candidate(field,value,evidence),scope(field,evidence)));}
});

test('canonical and semantic audience aliases share direct age conflicts and agreement',()=>{
  for(const name of ['target_audience','target audience','目标人群']){
    const age=fact('适用年龄','成人'),child=fact(name,'Children'),evidence=[age,child];
    assert.throws(()=>assertListingEvidence(candidate('target_audience','Adults',[age]),scope('target_audience',evidence)),name);
    child.value='Adults';assert.doesNotThrow(()=>assertListingEvidence(candidate('target_audience','Adults',[age]),scope('target_audience',evidence)),name);
    child.value='General';assert.throws(()=>assertListingEvidence(candidate('target_audience','Adults',[age]),scope('target_audience',evidence)),`${name}: General`);
  }
});

test('a PASS review cannot license unsupported source translation',()=>{
  const evidence=[fact('成分','未知配方')],output=candidate('ingredients','Sodium Hypochlorite',evidence),item=output.candidates[0].items[0];
  assert.throws(()=>assertListingReview({kind:'amazon-fields-review',verdict:'PASS',checks:[{field:'ingredients',index:0,verdict:'SUPPORTED',evidenceIds:item.evidenceIds,reason:'Translated.',claims:[{text:item.value,verdict:'SUPPORTED',evidenceIds:item.evidenceIds,reason:'Translated.'}]}],issues:[]},output,scope('ingredients',evidence)));
});

test('conflicting source facts survive as bounded non-citation blockers and block only related copy',async t=>{
  const f=await fixture(t),product=structuredClone(f.product),adult=fact('适用年龄','成人'),child=fact('年龄范围','儿童');
  product.facts.push(...[adult,child].map((e,index)=>({id:e.id,name:e.name,value:e.value,source:'manual' as const,sourceRef:'fixture',state:index?'conflicting' as const:'human_confirmed' as const})));
  const context=buildListingContext(f.draft,product,1),blockers=(context as any).evidenceBlockers;
  assert.deepEqual(blockers,[{field:'age_range_description',reason:'source_conflict',facts:[{id:child.id,name:child.name,value:child.value}]}]);
  assert.equal(context.evidence.some(e=>e.id===adult.id||e.id===child.id),false);
  assert.deepEqual((listingModelPayload(context) as any).evidenceBlockers,blockers);
  const material=context.evidence.filter(e=>e.meaning==='material');
  assert.throws(()=>assertListingEvidence(candidate('item_name','Adult Coaster',material),context));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Silicone Coaster',material),context));
  assert.throws(()=>assertListingEvidence(candidate('item_name','Adult Coaster',[child]),context));
  for(const mutate of [(c:any)=>c.evidenceBlockers.push(c.evidenceBlockers[0]),(c:any)=>c.evidenceBlockers[0].reason='SUPPORTED',(c:any)=>c.evidenceBlockers[0].facts.push(c.evidenceBlockers[0].facts[0]),(c:any)=>c.evidenceBlockers[0].extra=true]){
    const invalid=structuredClone(context);mutate(invalid);assert.throws(()=>validateListingContext(invalid));
  }
});

for(const [source,shape] of [['Round','Round'],['圆形','Round'],['方形','Square'],['正方形','Square'],['长方形','Rectangular']] as const)test(`finite known shape translation in prose respects its blocker: ${source}`,async t=>{
  const f=await fixture(t),product=structuredClone(f.product);
  product.facts.push({id:randomUUID(),name:'形状',value:source,source:'manual',sourceRef:'fixture',state:'conflicting'});
  const context=buildListingContext(f.draft,product,1),material=context.evidence.filter(e=>e.meaning==='material');
  assert.equal(context.evidenceBlockers?.[0].field,'item_shape');
  assert.throws(()=>assertListingEvidence(candidate('item_name',`${shape} Silicone Coaster`,material),context));
  if(source==='长方形')assert.throws(()=>assertListingEvidence(candidate('item_name','Rectangle Silicone Coaster',material),context));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Surround Silicone Coaster',material),context));
  if(source==='圆形'){
    const unknownShape=structuredClone(context);unknownShape.evidenceBlockers![0].facts[0].value='constructor';
    assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Silicone Coaster',material),unknownShape));
  }
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Silicone Coaster',material),context));
});

test('conflicting explicit operation wording continues blocking operation and power fields',async t=>{
  const f=await fixture(t),product=structuredClone(f.product);
  product.facts.push({id:randomUUID(),name:'操作方式',value:'手动操作',source:'manual',sourceRef:'fixture',state:'conflicting'});
  const context=buildListingContext(f.draft,product,1),material=context.evidence.filter(e=>e.meaning==='material');
  assert.equal(context.evidenceBlockers?.[0].field,'power_source_type');
  for(const field of ['operation_mode','power_source_type'] as const)assert.throws(()=>assertListingEvidence(candidate(field,'Manual',material),context));
});

test('selected SKU overrides global conflicts; a sibling never clears the selected unknown blocker',async t=>{
  const f=await fixture(t),product=structuredClone(f.product);
  product.facts.push({id:randomUUID(),name:'适用年龄',value:'成人',source:'manual',sourceRef:'',state:'conflicting'});
  product.variants[0].normalizedSpec='Children Blue';product.variants[0].originalSpec='Children Blue';
  assert.equal((buildListingContext(f.draft,product,1) as any).evidenceBlockers,undefined);
  product.variants.push({...product.variants[0],id:randomUUID(),sku:'SIBLING',normalizedSpec:'Adult'});
  product.variants[0].normalizedSpec='Blue';product.variants[0].originalSpec='Blue';
  const context=buildListingContext(f.draft,product,1);
  assert.equal((context as any).evidenceBlockers?.[0].field,'age_range_description');
  assert.ok(context.evidence.some(e=>e.meaning==='material'));
});

test('out-of-scope multi-SKU color conflicts do not enter blockers and clean contexts keep their old hash',async t=>{
  const f=await fixture(t),clean=buildListingContext(f.draft,f.product,1);
  assert.equal(Object.hasOwn(clean,'evidenceBlockers'),false);
  const product=structuredClone(f.product);product.variants.push({...product.variants[0],id:randomUUID(),sku:'OTHER'});
  const baseline=buildListingContext(f.draft,product,1);
  product.facts.push({id:randomUUID(),name:'颜色',value:'Red',source:'manual',sourceRef:'',state:'conflicting'});
  const context=buildListingContext(f.draft,product,1);assert.equal(Object.hasOwn(context,'evidenceBlockers'),false);assert.equal(listingFingerprint(context),listingFingerprint(baseline));
});

test('current result validation rejects false semantics even without a version marker',async t=>{
  const f=await fixture(t),result=structuredClone(await f.listing.suggest(f.reference));
  const evidence=[fact('适用年龄','三岁以上')];
  result.listingContext!.fields=[{name:'age_range_description',title:'Age',requirement:'required',closedEnum:false,allowedValues:[],suggestedValues:[]}];
  result.listingContext!.evidence=evidence;result.output=candidate('age_range_description','Adult',evidence);result.sourceSha256=listingFingerprint(result.listingContext);
  delete (result as any).listingEvidenceContractVersion;
  assert.throws(()=>validateAiResult(result));
});

test('stored legacy malformed semantic records remain readable without granting current adoption',async t=>{
  const schema={type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}};
  const f=await fixture(t,{age_range_description:schema}),result=structuredClone(await f.listing.suggest(f.reference));
  const context=result.listingContext!,evidence=fact('适用年龄','三岁以上');
  context.fields.push({name:'age_range_description',title:'Age',requirement:'required',closedEnum:false,allowedValues:[],suggestedValues:[]});context.evidence.push(evidence);
  result.output=candidate('age_range_description','Adult',[evidence]);result.sourceSha256=listingFingerprint(context);delete (result as any).listingEvidenceContractVersion;
  const db=openDatabase(f.directory);try{db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(result),result.id);}finally{db.close();}
  assert.deepEqual(f.ai.getResult(result.id),result);
  assert.ok(f.ai.listResults(f.product.id).some(r=>r.id===result.id));
  assert.throws(()=>assertListingEvidence(result.output as any,context));
  await assert.rejects(f.listing.adopt({...f.reference,suggestionResultId:result.id,reviewResultId:null,fields:['age_range_description']}));
});

test('main process stamps new results while model output cannot set the evidence contract version',async t=>{
  const f=await fixture(t),result=await f.listing.suggest(f.reference);
  assert.equal((result as any).listingEvidenceContractVersion,'listing-evidence/v3');
  assert.throws(()=>validateListingFieldsOutput({...result.output,listingEvidenceContractVersion:'listing-evidence/v1'}));
});

test('selected raw age remains effective when it overrides a blocker without an active age card',async t=>{
  const f=await fixture(t),product=structuredClone(f.product),draft=structuredClone(f.draft);
  (draft.schema.schema.properties as any).target_audience={type:'array',items:{type:'object',properties:{value:{type:'string'}}}};
  product.variants[0].sourceSpec='儿童';product.variants[0].originalSpec='Blue';product.variants[0].normalizedSpec='Blue';
  const adult=fact('适用年龄','成人');product.facts.push({id:adult.id,name:adult.name,value:adult.value,source:'manual',sourceRef:'',state:'human_confirmed'},{id:randomUUID(),name:'适用年龄',value:'待确认',source:'manual',sourceRef:'',state:'conflicting'});
  const context=buildListingContext(draft,product,1);
  assert.equal(context.fields.some(field=>field.name==='age_range_description'),false);
  assert.throws(()=>assertListingEvidence(candidate('target_audience','Adults',[adult]),context));
  const selected=context.evidence.find(e=>e.source==='selected_sku'&&e.value==='Child');assert.ok(selected);
  assert.doesNotThrow(()=>assertListingEvidence(candidate('target_audience','Children',[selected]),context));
});

test('a translated known ingredient claim in prose cannot bypass an ingredient blocker',async t=>{
  const f=await fixture(t),product=structuredClone(f.product);
  product.facts.push({id:randomUUID(),name:'成分',value:'柠檬酸',source:'manual',sourceRef:'',state:'conflicting'});
  const context=buildListingContext(f.draft,product,1),material=context.evidence.filter(e=>e.meaning==='material');
  assert.throws(()=>assertListingEvidence(candidate('item_name','Citric Acid Cleaner',material),context));
  assert.doesNotThrow(()=>assertListingEvidence(candidate('item_name','Silicone Coaster',material),context));
});

async function ageDraft(t:test.TestContext){
  const schema={type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}};
  const f=await fixture(t,{age_range_description:schema});
  const product=f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,{id:randomUUID(),name:'适用年龄',value:'三岁以上',source:'manual',sourceRef:'',state:'human_confirmed'}]});
  let draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  draft=f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,age_range_description:[{value:'Adult'}],item_name:[{value:'Silicone Coaster'}]}});
  return {...f,product,draft,reference:{draftId:draft.id,draftRevision:draft.revision}};
}

test('review-disabled image snapshot blocks present unparsed source without spending a call',async t=>{
  const f=await ageDraft(t),before=f.requests.length;
  await assert.rejects(f.listing.snapshotCurrentForImages(f.reference));assert.equal(f.requests.length,before);
});

test('repair isolates an unparsed category value while retaining valid material evidence',async t=>{
  const f=await ageDraft(t),context=buildListingContext(f.draft,f.product,1),age=context.evidence.find(e=>e.name==='适用年龄')!,material=context.evidence.find(e=>e.meaning==='material')!;
  context.fields=context.fields.filter(field=>['material','age_range_description'].includes(field.name));
  context.repairRequest={issues:[],currentValues:{}};
  f.respond(()=>chat({kind:'amazon-fields',candidates:[...candidate('material','Silicone',[material]).candidates,...candidate('age_range_description','Adult',[age],true).candidates],missing:[]}));
  const result=await f.ai.listingFields(context,async()=>{});if(result.output.kind!=='amazon-fields')throw Error('fields');const output=result.output;
  assert.deepEqual(output.candidates.map(c=>c.field),['material']);assert.deepEqual(output.missing.map(m=>m.field),['age_range_description']);assert.match(output.missing[0].reason,/无法解析/);
});

test('known adopted AI judgment cannot use source absence to omit its inference obligation',async t=>{
  const schema={type:'array',items:{type:'object',properties:{value:{type:'string'}}}},f=await fixture(t,{age_range_description:schema});
  const draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,age_range_description:[{value:'Adult'}]}}),context=buildListingContext(draft,f.product,1),material=context.evidence.filter(e=>e.meaning==='material');
  const result={id:randomUUID(),output:candidate('age_range_description','Adult',material,true),listingContext:context,sourceSha256:listingFingerprint(context)} as any;
  draft.fieldAdoptions=[{id:'fixture',suggestionResultId:result.id,reviewResultId:null,contextSha256:result.sourceSha256,fromRevision:1,toRevision:draft.revision,fields:['age_range_description'],changes:[{field:'age_range_description',before:null,after:draft.attributes.age_range_description,evidence:material}],at:new Date().toISOString()}];
  const options={adoptionFields:CONTRACT_ADOPTION_FIELDS,adoptionContext:'stored' as const};
  assert.deepEqual(currentDraftEvidenceIssues(draft,context,()=>result,options),[]);
  result.output.candidates[0].items[0].transformation='compose';delete result.output.candidates[0].items[0].inferenceReason;
  assert.ok(currentDraftEvidenceIssues(draft,context,()=>result,options).some(issue=>issue.includes('infer')));
});

test('DONE completion preserves its journal and reports current unparsed evidence with zero calls',async t=>{
  const f=await ageDraft(t),op=f.listing.beginCompletion(f.reference);op.state='DONE';op.remaining=[];f.ai.completionJournal.save(op);
  const before=JSON.stringify(f.listing.getCompletion(op.id)),result=await f.listing.complete(f.reference,undefined,op.id);
  assert.equal(result.aiCalls,0);assert.equal(result.previewAttempts,0);assert.ok(result.remaining.some(value=>value.includes('age_range_description')));
  assert.equal(JSON.stringify(f.listing.getCompletion(op.id)),before);assert.equal(f.requests.length,0);
});

for(const age of ['三岁以上','成人'])test(`first completion keeps current evidence decisions after repairing other valid fields: ${age}`,async t=>{
  const schema={type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}};
  const f=await fixture(t,{age_range_description:schema});
  const product=f.store.saveProduct({...saveInput(f.product),facts:[...f.product.facts,{id:randomUUID(),name:'适用年龄',value:age,source:'manual',sourceRef:'fixture',state:'human_confirmed'}]});
  let draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING_PRODUCT_ONLY',locale:'en_US'});
  draft=f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,age_range_description:[{value:'Adult'}],item_name:[{value:'Silicone Coaster',marketplace_id:draft.marketplaceId,language_tag:'en_US'}]}});
  const result=await f.listing.complete({draftId:draft.id,draftRevision:draft.revision});
  assert.equal(result.remaining.some(value=>value.includes('age_range_description')),age==='三岁以上');
  if(age==='成人')assert.deepEqual(result.remaining,[]);
  assert.equal(result.aiCalls,2);assert.equal(f.requests.length,2);assert.equal(result.previewAttempts,2);
  assert.ok(result.draft.fieldAdoptions?.some(adoption=>adoption.fields.includes('color')));
  assert.equal((result.draft.attributes.color as any)[0].value,'Blue');
  const operation=f.listing.completionOperations(draft.id)[0],before=JSON.stringify(operation);
  assert.deepEqual(operation.remaining,result.remaining);
  const resumed=await f.listing.complete({draftId:draft.id,draftRevision:result.draft.revision},undefined,operation.id);
  assert.deepEqual(resumed.remaining,result.remaining);assert.equal(resumed.aiCalls,0);assert.equal(resumed.previewAttempts,0);assert.equal(f.requests.length,2);
  assert.equal(JSON.stringify(f.listing.getCompletion(operation.id)),before);
});

for(const missingOnly of [true,false])test(`completion reports malformed current fields and finishes after ${missingOnly?'missing-only':'partial adoption'} responses`,async t=>{
  const schema={type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}};
  const f=await fixture(t,{age_range_description:schema});
  const draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,age_range_description:[{value:3}],item_name:[{value:'Silicone Coaster',marketplace_id:f.draft.marketplaceId,language_tag:'en_US'}]}});
  if(missingOnly)f.respond(payload=>chat({kind:'amazon-fields',candidates:[],missing:payload.fields.map((field:any)=>({field:field.name,reason:'No safe replacement is available.'}))}));
  const result=await f.listing.complete({draftId:draft.id,draftRevision:draft.revision});
  const schemaIssues=result.draft.localIssues.filter(issue=>issue.severity==='ERROR'&&issue.attributeNames.includes('age_range_description'));
  assert.ok(schemaIssues.length);
  for(const issue of schemaIssues)assert.ok(result.remaining.some(value=>value.includes('age_range_description')&&value.includes(issue.message)));
  assert.ok(result.remaining.includes('age_range_description：当前字段格式不完整，无法检查来源依据'));
  assert.ok(result.remaining.some(value=>value.includes('age_range_description')&&value.includes(missingOnly?'No safe replacement is available.':'More verified facts needed.')));
  assert.deepEqual(result.draft.attributes.age_range_description,[{value:3}]);
  assert.equal(result.aiCalls,missingOnly?1:3);assert.equal(f.requests.length,result.aiCalls);assert.equal(result.previewAttempts,missingOnly?1:2);
  assert.equal(result.draft.fieldAdoptions?.some(adoption=>adoption.fields.includes('color'))??false,!missingOnly);
  const operation=f.listing.completionOperations(draft.id)[0],before=JSON.stringify(operation);
  assert.equal(operation.state,'DONE');assert.deepEqual(operation.remaining,result.remaining);
  const resumed=await f.listing.complete({draftId:draft.id,draftRevision:result.draft.revision},undefined,operation.id);
  assert.deepEqual(resumed.remaining,result.remaining);assert.equal(resumed.aiCalls,0);assert.equal(resumed.previewAttempts,0);assert.equal(f.requests.length,result.aiCalls);
  assert.equal(JSON.stringify(f.listing.getCompletion(operation.id)),before);
  await assert.rejects(f.listing.snapshotCurrentForImages({draftId:draft.id,draftRevision:result.draft.revision}),/当前文案字段格式不完整/);
  assert.equal(f.requests.length,result.aiCalls);
});

test('idempotent adoption still observes cancellation after schema readback',async t=>{
  const f=await fixture(t),suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});
  const input={...f.reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['material' as const]};
  const adopted=await f.listing.adopt(input),getSchema=f.amazon.getSchema.bind(f.amazon);
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),began=new Promise<void>(r=>entered=r);
  f.amazon.getSchema=async input=>{entered();await held;return getSchema(input);};
  const controller=new AbortController(),pending=f.listing.adopt(input,controller.signal);await began;controller.abort();release();
  await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(f.amazon.getDraft(adopted.id),adopted);
});

test('existing source-absent ordinary judgment is preserved without inventing inference provenance',async t=>{
  const schema={type:'array',items:{type:'object',properties:{value:{type:'string'}}}},f=await fixture(t,{age_range_description:schema});
  const draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,age_range_description:[{value:'Adult'}],item_name:[{value:'Silicone Coaster'}]}});
  const snapshot=await f.listing.snapshotCurrentForImages({draftId:draft.id,draftRevision:draft.revision});
  assert.ok(snapshot.currentListingCopy.some(item=>item.field==='age_range_description'));assert.equal(f.requests.length,0);
  assert.equal(JSON.stringify(snapshot).includes('inferenceReason'),false);
});

test('legacy semantic result bytes and hashes survive encrypted backup while associations remain checked',async t=>{
  const f=await ageDraft(t),result=structuredClone(await f.listing.suggest(f.reference));
  const context=result.listingContext!,direct=context.evidence.find(e=>e.name==='适用年龄')!;
  result.output=candidate('age_range_description','Adult',[direct]);delete result.listingEvidenceContractVersion;
  const raw=JSON.stringify(result),hash=result.sourceSha256;
  const db=openDatabase(f.directory);try{db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(raw,result.id);}finally{db.close();}
  assert.ok(f.ai.queryResults({productId:f.product.id}).items.some(r=>r.id===result.id));
  const path=join(f.directory,'legacy.htcbackup'),target=join(f.directory,'restored'),password='isolated evidence contract backup';
  await createWorkspaceBackup(f.directory,path,password);const prepared=await prepareWorkspaceRestore(target,path,password);await commitWorkspaceRestore(target,prepared);
  const restored=openDatabase(target);try{const saved=String(restored.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json);assert.equal(saved,raw);assert.equal(JSON.parse(saved).sourceSha256,hash);}finally{restored.close();}
  const altered=openDatabase(f.directory);try{const invalid=structuredClone(result);invalid.sourceSha256='0'.repeat(64);altered.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(invalid),result.id);}finally{altered.close();}
  await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'tampered.htcbackup'),password));
});
