import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { assertImageSetPlan as checkImageSetPlan, validateImageSetPlan } from '../src/main/ai/image-validation.ts';
import type { ImageEvidenceOptions } from '../src/main/ai/image-validation.ts';
import { imageEvidence, sourceDimensionEvidence } from '../src/main/image-workflow/image-facts.ts';
import { sceneSet } from './fixtures/image-set.ts';
import { planProductImage } from '../src/main/ai/image-adapters.ts';

const variantId=randomUUID();
// New-response checks opt in explicitly; saved/service checks retain their prior semantics.
const assertImageSetPlan=(p:ReturnType<typeof sceneSet>,c:any,options:ImageEvidenceOptions={enforceDimensionScope:true})=>checkImageSetPlan(p,c,options);
const body={id:'body',name:'Product length',value:'10 cm',meaning:'general',source:'source_confirmed'};
const packageSize={id:`measurement:${variantId}:package.length`,name:'包装长度',value:'12 cm',variantId,sourceSha256:'a'.repeat(64)};
const context=():any=>({setPolicy:'seven-product-v2',listing:{variantId,evidence:[]},sourceMeasurements:[packageSize],referenceMeasurements:[]});
function dimensions(p:ReturnType<typeof sceneSet>,id:string,text:string){p.dimensionEvidenceIds=[id];p.dimensionReason='Verified scoped source.';p.slots[6]={...p.slots[6],role:'dimensions',focus:'Size diagram',evidenceIds:[id],textMode:'planned',expectedText:[{text,evidenceIds:[id]}]};}
const rejection=(reason:string,path:string)=>(error:any)=>error.code==='OUTPUT_INVALID'&&error.diagnosticReason===reason&&error.validationPath===path;

test('seven includes the dimension slot; eight or absent slots give a bounded count path without trimming',()=>{
 const p=sceneSet();assert.doesNotThrow(()=>validateImageSetPlan(p));
 p.slots.push({...p.slots[6],index:8});const before=structuredClone(p);
 assert.throws(()=>validateImageSetPlan(p),rejection('IMAGE_PLAN_SLOT_COUNT','setPlan.slots.length'));assert.deepEqual(p,before);
 assert.throws(()=>validateImageSetPlan({...p,slots:undefined}),rejection('IMAGE_PLAN_SLOT_COUNT','setPlan.slots.length'));
});
test('only package dimensions leave the dimension slot optional and keep the source evidence intact',()=>{
 const c=context(),before=structuredClone(c);assert.deepEqual(sourceDimensionEvidence(c),[]);
 assert.ok(imageEvidence(c).some(v=>v.id===packageSize.id));assert.doesNotThrow(()=>assertImageSetPlan(sceneSet(),c));assert.deepEqual(c,before);
});
test('stored approved plans keep their original scope semantics while numeric and evidence guards remain',()=>{
 const c=context(),p=sceneSet();c.listing.evidence.push(body);dimensions(p,packageSize.id,'Product length 12 cm');
 const before=structuredClone(p);assert.doesNotThrow(()=>assertImageSetPlan(p,c,{storedVersion:'listing-evidence/v5'}));assert.doesNotThrow(()=>checkImageSetPlan(p,c));assert.deepEqual(p,before);
 assert.throws(()=>assertImageSetPlan(p,c));p.slots[6].expectedText[0].text='Product length 99 cm';assert.throws(()=>assertImageSetPlan(p,c,{storedVersion:'listing-evidence/v5'}));
 p.slots[6].expectedText[0].text='Product length 12 cm';p.slots[6].expectedText[0].evidenceIds=['missing'];assert.throws(()=>assertImageSetPlan(p,c,{storedVersion:'listing-evidence/v5'}));
});
test('an optional package diagram must identify packaging in every measured caption',()=>{
 const c=context(),p=sceneSet();dimensions(p,packageSize.id,'Package length 12 cm');assert.doesNotThrow(()=>assertImageSetPlan(p,c));
 p.slots[6].expectedText[0].text='Product length 12 cm';assert.throws(()=>assertImageSetPlan(p,c),rejection('IMAGE_PLAN_DIMENSION_SCOPE','setPlan.slots[6].expectedText[0]'));
 p.slots[6].expectedText[0].text='Package length 99 cm';assert.throws(()=>assertImageSetPlan(p,c));
});
test('product body dimensions remain required even with package evidence selected',()=>{
 const c=context(),p=sceneSet();c.listing.evidence.push(body);
 assert.throws(()=>assertImageSetPlan(p,c),rejection('IMAGE_PLAN_DIMENSION_REQUIRED','setPlan.dimensionEvidenceIds'));
 dimensions(p,packageSize.id,'Package length 12 cm');assert.throws(()=>assertImageSetPlan(p,c),rejection('IMAGE_PLAN_DIMENSION_REQUIRED','setPlan.dimensionEvidenceIds'));
 p.dimensionEvidenceIds.push(body.id);assert.throws(()=>assertImageSetPlan(p,c),rejection('IMAGE_PLAN_DIMENSION_REQUIRED','setPlan.slots'));
 dimensions(p,body.id,'Product length 10 cm');assert.doesNotThrow(()=>assertImageSetPlan(p,c));
 p.slots[6].expectedText[0].text='Product length 12 cm';assert.throws(()=>assertImageSetPlan(p,c));
});
test('package and component listing facts and source OCR never force body dimensions',()=>{
 const c=context();c.sourceMeasurements=[];
 for(const name of ['Package dimensions','Component length','包装尺寸','来源组件长度']){c.listing.evidence=[{...body,name}];assert.deepEqual(sourceDimensionEvidence(c),[]);assert.doesNotThrow(()=>assertImageSetPlan(sceneSet(),c));}
 c.listing.evidence=[{...body,name:'Dimensions'}];assert.deepEqual(sourceDimensionEvidence(c),[]);assert.doesNotThrow(()=>assertImageSetPlan(sceneSet(),c));
 c.listing.evidence=[];const id='reference:'+randomUUID()+':0';c.referenceMeasurements=[{id,text:'Package length 12 cm'}];
 const p=sceneSet();dimensions(p,id,'Product length 12 cm');assert.throws(()=>assertImageSetPlan(p,c),rejection('IMAGE_PLAN_DIMENSION_SCOPE','setPlan.slots[6].expectedText[0]'));
});

test('adapter keeps exact rejection path and gives bounded specific feedback without an eighth slot',async()=>{
 const bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(32,16);bytes.writeUInt32BE(32,20);
 const assetId=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex'),c=context();c.purpose='main';c.policyVersion='product-image/ip-v3';c.referenceAssets=[{assetId,sha256,variantId}];
 const output:any={kind:'image-plan',prompt:'Realistic tabletop scene.',textMode:'none',expectedText:[],productUnderstanding:{summary:'An ordinary product.',referenceAssetIds:[assetId],uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS',findings:[]},setPlan:sceneSet()};
 const images:any=[{assetId,sha256,mimeType:'image/png',width:32,height:32,bytes}];
 let request:any;
 const adapter:any={imagePlanRetry:true,imagePlanValidationFeedback:{reason:'IMAGE_PLAN_SLOT_COUNT',jsonPath:'setPlan.slots.length'},now:()=>new Date(),nonce:()=>'',maxResponseBytes:1000000,fetch:async(_url:any,init:any)=>{request=JSON.parse(init.body);return new Response(JSON.stringify({id:'safe-fixture',usage:{prompt_tokens:1,completion_tokens:2},choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));}};
 await planProductImage(c,undefined,'deepseek-flash',{apiKey:'fixture-secret'},new AbortController().signal,adapter,images);
 const payload=JSON.parse(request.messages[1].content[0].text);
 assert.deepEqual(payload.requiredDimensionEvidenceIds,[]);assert.ok(payload.evidence.some((v:any)=>v.id===packageSize.id));
 assert.equal(payload.validationFailure.reason,'IMAGE_PLAN_SLOT_COUNT');assert.equal(payload.validationFailure.jsonPath,'setPlan.slots.length');assert.match(payload.validationFailure.correction,/including.*dimensions/i);assert.match(request.messages[0].content,/never append an eighth/i);
 output.setPlan.slots.push({...output.setPlan.slots[6],index:8});
 await assert.rejects(planProductImage(c,undefined,'deepseek-flash',{apiKey:'fixture-secret'},new AbortController().signal,adapter,images),rejection('IMAGE_PLAN_SLOT_COUNT','setPlan.slots.length'));
});
