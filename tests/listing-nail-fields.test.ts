import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildFieldCatalog } from '../src/main/amazon/field-catalog.ts';
import { wrapCandidateValues, validateFieldValues } from '../src/main/amazon/field-mapping.ts';
import { assertListingEvidence, assertListingReview, validateListingFieldsOutput } from '../src/main/listing-ai/validation.ts';
import { currentImageListingSnapshot } from '../src/main/image-workflow/image-facts.ts';
import { chat, fixture } from './fixtures/listing-ai.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { reviewListingFields, suggestListingFields } from '../src/main/ai/listing-adapters.ts';
import { reviewCurrentListing } from '../src/main/ai/image-adapters.ts';

const schema=JSON.parse(readFileSync(new URL('./fixtures/nail-clipper-fields.json',import.meta.url),'utf8'));
const snapshot:any={schema,locale:'en_US',propertyGroups:{},metaSchema:{}};
const candidate=(field:string,value:string)=>validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field,items:[{value,evidenceIds:['fact'],transformation:'translate'}]}],missing:[]});

test('real nail clipper schema exposes nested blade material suggestions and wraps the exact required structure',()=>{
  const card=buildFieldCatalog(snapshot).find(f=>f.name==='blade')!;
  assert.ok(card.suggestedValues.includes('Metal'));assert.equal(card.closedEnum,false);
  const wrapped=wrapCandidateValues(snapshot,'ATVPDKIKX0DER','blade',['Metal']);
  assert.deepEqual(wrapped,[{material:[{value:'Metal',language_tag:'en_US'}],marketplace_id:'ATVPDKIKX0DER'}]);
  assert.deepEqual(validateFieldValues(snapshot,'ATVPDKIKX0DER','blade',['Metal']),[]);
  const existing=[{edge:[{value:'Straight',language_tag:'en_US'}]}];
  assert.deepEqual(wrapCandidateValues(snapshot,'ATVPDKIKX0DER','blade',['Metal'],existing),[{...(wrapped as any)[0],...existing[0]}]);
});

test('blade-specific material translations never upgrade generic metal to a steel alloy',()=>{
  const c:any={fields:[{name:'blade'}],evidence:[{id:'fact',name:'刀刃材质',value:'金属',meaning:'general',source:'source_confirmed'}]};
  assert.doesNotThrow(()=>assertListingEvidence(candidate('blade','Metal'),c));
  assert.throws(()=>assertListingEvidence(candidate('blade','Stainless Steel'),c));
  c.evidence[0].name='材质';c.evidence[0].meaning='material';assert.throws(()=>assertListingEvidence(candidate('blade','Metal'),c));
  c.evidence[0].name='刀片材质';c.evidence[0].value='不锈钢';assert.doesNotThrow(()=>assertListingEvidence(candidate('blade','Stainless Steel'),c));
});

const metalClipperContext=()=>({productType:'NAIL_CLIPPER',fields:[{name:'blade'}],evidence:[
  {id:'fact',name:'材质',value:'金属',meaning:'material',source:'source_confirmed'},
  {id:'category',name:'产品类别',value:'指甲刀',meaning:'general',source:'source_confirmed'},
]}) as any;
const metalClipperCandidate=()=>{const result=candidate('blade','Metal');result.candidates[0].items[0].evidenceIds.push('category');return result;};

test('confirmed metal nail clipper facts support the broad Metal blade value in generation and independent review',()=>{
  const context=metalClipperContext(),output=metalClipperCandidate();
  assert.doesNotThrow(()=>assertListingEvidence(output,context));
  const review:any={kind:'amazon-fields-review',verdict:'PASS',checks:[{field:'blade',index:0,verdict:'SUPPORTED',evidenceIds:['fact','category'],reason:'Supported material and product category',claims:[{text:'Metal',verdict:'SUPPORTED',evidenceIds:['fact','category'],reason:'Broad source material'}]}],issues:[]};
  assert.doesNotThrow(()=>assertListingReview(review,output,context));
  for(const value of ['Stainless Steel','Alloy Steel','Carbon Steel','High Carbon Steel']){
    output.candidates[0].items[0].value=value;assert.throws(()=>assertListingEvidence(output,context));
  }
});

test('broad nail clipper blade mapping needs both source facts and cannot override a different component material',()=>{
  for(const mutate of [
    (c:any)=>{c.productType='KITCHEN_KNIFE';},
    (c:any)=>{delete c.productType;},
    (c:any)=>{c.evidence[0].name='手柄材质';},
    (c:any)=>{c.evidence[0].name='外壳材质';},
    (c:any)=>{c.evidence[0].value='金属色';},
    (c:any)=>{c.evidence[0].value='塑料';},
    (c:any)=>{c.evidence[1].value='小刀';},
    (c:any)=>{c.evidence[1].name='未核验标题';},
    (c:any)=>{c.evidence.push({id:'other-blade',name:'刀刃材质',value:'陶瓷',meaning:'general',source:'source_confirmed'});},
  ]){const c=metalClipperContext();mutate(c);assert.throws(()=>assertListingEvidence(metalClipperCandidate(),c));}
  const noCategoryCitation=metalClipperCandidate();noCategoryCitation.candidates[0].items[0].evidenceIds=['fact'];
  assert.throws(()=>assertListingEvidence(noCategoryCitation,metalClipperContext()));
  const noMaterialCitation=metalClipperCandidate();noMaterialCitation.candidates[0].items[0].evidenceIds=['category'];
  assert.throws(()=>assertListingEvidence(noMaterialCitation,metalClipperContext()));
});

test('generation and both review adapters share the limited broad Metal mapping',async()=>{
  const c=metalClipperContext(),output=metalClipperCandidate();
  const review:any={kind:'amazon-fields-review',verdict:'PASS',checks:[{field:'blade',index:0,verdict:'SUPPORTED',evidenceIds:['fact','category'],reason:'Supported material and product category',claims:[{text:'Metal',verdict:'SUPPORTED',evidenceIds:['fact','category'],reason:'Broad source material'}]}],issues:[]};
  const systems:string[]=[];
  const adapter=(raw:unknown)=>({now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,fetch:async(_url:any,init:any)=>{systems.push(JSON.parse(init.body).messages[0].content);return chat(raw);}});
  const signal=new AbortController().signal,credentials={apiKey:'test-only'};
  assert.equal((await suggestListingFields(c,'deepseek-flash',credentials,signal,adapter(output))).output.candidates[0].items[0].value,'Metal');
  assert.equal((await reviewListingFields(c,output,'deepseek-flash',credentials,signal,adapter(review))).output.verdict,'PASS');
  assert.equal((await reviewCurrentListing(c,[{field:'blade',values:['Metal']}],'deepseek-flash',credentials,signal,adapter(review))).output.verdict,'PASS');
  for(const system of systems){assert.match(system,/NAIL_CLIPPER/);assert.match(system,/cite BOTH facts/i);assert.match(system,/Metal never implies Stainless Steel/);}
});

test('general audience translates explicit intended-user evidence without adding age groups or guessing from a title',()=>{
  const c:any={fields:[{name:'target_audience'}],evidence:[{id:'fact',name:'适用人群',value:'通用',meaning:'general',source:'source_confirmed'}]};
  for(const value of ['General','All','Unisex'])assert.doesNotThrow(()=>assertListingEvidence(candidate('target_audience',value),c));
  for(const value of ['Adults','Kids','All Ages','Baby'])assert.throws(()=>assertListingEvidence(candidate('target_audience',value),c));
  c.evidence[0].name='产品名称';assert.throws(()=>assertListingEvidence(candidate('target_audience','General'),c));
});

test('listing context includes actual blade and audience fields and image review reads nested blade material',async t=>{
  const f=await fixture(t),draft={...f.draft,schema:{...f.draft.schema,schema}};
  const context=buildListingContext(draft,f.product,1);assert.ok(context.fields.some(f=>f.name==='blade'));assert.ok(context.fields.some(f=>f.name==='target_audience'));
  draft.attributes={blade:[{material:[{value:'Metal',language_tag:'en_US'}],marketplace_id:'ATVPDKIKX0DER'}],target_audience:[{value:'General',language_tag:'en_US'}]};
  const image=currentImageListingSnapshot(draft,context);
  assert.deepEqual(image.currentListingCopy,[{field:'blade',values:['Metal']},{field:'target_audience',values:['General']}]);
});
