import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertImagePlan,validateImagePlan} from '../src/main/ai/image-validation.ts';
import {sceneSet} from './fixtures/image-set.ts';
const assetId=randomUUID();
const raw=()=>({kind:'image-plan',productUnderstanding:{summary:'One blue brush',referenceAssetIds:[assetId],uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS',findings:[]},prompt:'Photograph the brush.',textMode:'planned',expectedText:[{text:'For Kitchen Cleaning',evidenceIds:['source-title']}]});
const rejected=(reason:string,path:string)=>(error:any)=>error.code==='OUTPUT_INVALID'&&error.diagnosticReason===reason&&error.validationPath===path;
test('missing sufficient is a model response error with an exact path and never inferred true',()=>{
 const value:any=raw();delete value.productUnderstanding.sufficient;const before=structuredClone(value);
 assert.throws(()=>validateImagePlan(value),rejected('IMAGE_PLAN_SUFFICIENCY_REQUIRED','productUnderstanding.sufficient'));
 assert.deepEqual(value,before);
});
test('frozen slot captions allow one harmless sentence period and retain exact facts and citations',()=>{
 const set=sceneSet();set.slots[4].textMode='planned';set.slots[4].expectedText=raw().expectedText;
 const context:any={policyVersion:'product-image/vision-v2',setPolicy:'seven-product-v2',purpose:'detail',referenceAssets:[{assetId}],listing:{variantId:randomUUID(),evidence:[]},slot:{index:5,total:7,provisional:true},setPlan:set};
 const plan=validateImagePlan({...raw(),expectedText:[{text:'For Kitchen Cleaning.',evidenceIds:['source-title']}]});
 context.listing.evidence=[{id:'source-title',name:'Title',value:'Kitchen Cleaning',meaning:'general',source:'source_confirmed'}];
 assert.doesNotThrow(()=>assertImagePlan(plan,context));
 const changedText=validateImagePlan({...raw(),expectedText:[{text:'For Kitchen Cleanings',evidenceIds:['source-title']}]});
 assert.throws(()=>assertImagePlan(changedText,context),rejected('IMAGE_PLAN_FROZEN_CAPTION_MISMATCH','expectedText'));
 const changed=validateImagePlan({...raw(),textMode:'none',expectedText:[]});
 assert.throws(()=>assertImagePlan(changed,context),rejected('IMAGE_PLAN_FROZEN_TEXT_MODE','textMode'));
 const wrongId=validateImagePlan({...raw(),expectedText:[{text:'For Kitchen Cleaning',evidenceIds:['nearby-but-wrong-id']}]});
 assert.throws(()=>assertImagePlan(wrongId,context),rejected('IMAGE_PLAN_FROZEN_CAPTION_MISMATCH','expectedText'));
 for(const text of ['For Kitchen Cleaning..','For Kitchen Cleaning!','For Kitchen Cleaning 2','For kitchen cleaning']){
  assert.throws(()=>assertImagePlan(validateImagePlan({...raw(),expectedText:[{text,evidenceIds:['source-title']}]}),context),rejected('IMAGE_PLAN_FROZEN_CAPTION_MISMATCH','expectedText'));
 }
});
