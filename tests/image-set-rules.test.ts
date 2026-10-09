import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertImagePlan, validateImagePlan, imageGenerationPrompt, assertImageTextReview } from '../src/main/ai/image-validation.ts';

const assetId=randomUUID();
const fact={id:'material',name:'Material',value:'Silicone',meaning:'material',source:'human_confirmed'};
function context():any{return {purpose:'main',policyVersion:'product-image/ip-v3',setPolicy:'seven-product-v2',listing:{evidence:[fact]},referenceAssets:[{assetId}],referenceMeasurements:[]};}
function plan():any{return {kind:'image-plan',prompt:'A tabletop scene.',textMode:'none',expectedText:[],productUnderstanding:{summary:'A round coaster.',referenceAssetIds:[assetId],uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS',findings:[]},setPlan:{style:'Soft daylight and calm warm colors.',dimensionEvidenceIds:[],dimensionReason:'No verified dimensions.',slots:Array.from({length:7},(_,i)=>({index:i+1,role:i===0?'main_scene':i===1?'selling_point':'scene',focus:i===1?'Silicone material':`Everyday scene ${i+1}`,evidenceIds:i===1?['material']:[],scene:`Tabletop setting ${i+1}`,prompt:`Show the source product in setting ${i+1}.`,textMode:i===1?'planned':'none',expectedText:i===1?[{text:'Silicone',evidenceIds:['material']}]:[]}))}};}
test('a complete seven-image blueprint accepts a text-free main scene, one feature, and scene fillers',()=>{
  const p=validateImagePlan(plan());assert.doesNotThrow(()=>assertImagePlan(p,context()));
});

test('saved set plans accept generic multicolor captions justified by the same selected SKU specification',()=>{
  const c=context(),p=plan(),variantId=randomUUID();c.listing.variantId=variantId;
  c.listing.evidence.push({id:`${variantId}:spec`,name:'Selected SKU specification',value:'定制款多色橙+绿+黄+蓝',meaning:'general',source:'selected_sku'});
  p.setPlan.slots[1].expectedText=[{text:'Multicolor silicone finish',evidenceIds:['material']}];
  assert.doesNotThrow(()=>assertImagePlan(validateImagePlan(p),c));
  c.listing.evidence[1].id=`${randomUUID()}:spec`;
  assert.throws(()=>assertImagePlan(validateImagePlan(p),c));
});

test('whole-set planning treats standalone lens-look directions as photography, not product dimensions',()=>{
  const p=plan();
  p.prompt='Show the source product, shallow depth of field, 50mm lens look, low eye-level angle, no text.';
  p.setPlan.slots[0].prompt=p.prompt;
  p.setPlan.slots[2].prompt='Show the source product, shallow depth of field, 100mm macro lens look, slightly high angle, no text.';
  p.setPlan.slots[5].prompt='Show the source product, shallow depth of field, 35mm lens look, slightly high angle, no text.';
  assert.doesNotThrow(()=>assertImagePlan(validateImagePlan(p),context()));
});

test('single-slot planning accepts camera look directions while keeping the approved text unchanged',()=>{
  const c=context(),p=plan();c.setPlan=p.setPlan;c.slot={index:1,total:7,provisional:true};delete p.setPlan;
  p.prompt='Camera at a low three-quarter angle, 50mm lens look, crisp focus on the product.';
  assert.doesNotThrow(()=>assertImagePlan(validateImagePlan(p),c));
  p.textMode='planned';p.expectedText=[{text:'50mm lens look',evidenceIds:[]}];
  assert.throws(()=>assertImagePlan(validateImagePlan(p),c));
});

test('lens-look exceptions never apply to captions, focus, scene, style or product understanding',()=>{
  for(const change of [
    (p:any)=>{p.setPlan.slots[2].focus='50mm lens look';},
    (p:any)=>{p.setPlan.slots[2].scene='50mm lens look';},
    (p:any)=>{p.setPlan.style='50mm lens look';},
    (p:any)=>{p.productUnderstanding.summary='50mm lens look';},
    (p:any)=>{p.productUnderstanding.uncertainties=['50mm lens look'];},
    (p:any)=>{p.setPlan.slots[2].textMode='planned';p.setPlan.slots[2].expectedText=[{text:'50mm lens look',evidenceIds:[]}];}
  ]){
    const p=plan();change(p);assert.throws(()=>assertImagePlan(validateImagePlan(p),context()));
  }
});

test('photography directions do not hide unsupported product dimensions or default sizes',()=>{
  for(const claim of ['Product length 50 mm.','Product dimensions 5×5×5 cm.','Product weight 100 g.','A 50mm lens.','Product focal length: 50mm lens look.','50mm lens look printed on the product.']){
    for(const field of ['top','slot']){
      const p=plan(),c=context();
      c.listing.evidence.push({id:'default',name:'业务默认尺寸',value:'5×5×5 cm',meaning:'general',source:'selected_sku'});
      const prompt='Show the source product, shallow depth of field, 100mm macro lens look, no text. '+claim;
      if(field==='top')p.prompt=prompt;else p.setPlan.slots[2].prompt=prompt;
      assert.throws(()=>assertImagePlan(validateImagePlan(p),c),claim);
    }
  }
});

test('camera-lens product specifications still require their own source evidence',()=>{
  const c=context(),p=plan();c.listing.productType='CAMERA_LENS';p.productUnderstanding.summary='A camera lens.';
  p.prompt='Show the 50mm lens, shallow depth of field, 100mm macro lens look, no text.';
  assert.throws(()=>assertImagePlan(validateImagePlan(p),c));
  c.listing.evidence.push({id:'focal',name:'Verified focal length',value:'50 mm',meaning:'general',source:'source_confirmed'});
  p.setPlan.dimensionEvidenceIds=['focal'];p.setPlan.dimensionReason='Verified lens specification.';
  p.setPlan.slots[6]={...p.setPlan.slots[6],role:'dimensions',evidenceIds:['focal'],textMode:'planned',expectedText:[{text:'Focal length 50 mm',evidenceIds:['focal']}]};
  assert.doesNotThrow(()=>assertImagePlan(validateImagePlan(p),c));
  p.prompt=p.prompt.replace('Show the 50mm lens','Show the 35mm lens');
  assert.throws(()=>assertImagePlan(validateImagePlan(p),c));
});
test('seven-image rules reject missing slots, text-free selling points, duplicate focuses and unsupported dimensions',()=>{
  for(const change of [(p:any)=>p.setPlan.slots.pop(),(p:any)=>{p.setPlan.slots[1].textMode='none';p.setPlan.slots[1].expectedText=[];},(p:any)=>{p.setPlan.slots[2]={...p.setPlan.slots[1],index:3};},(p:any)=>{p.setPlan.dimensionEvidenceIds=['invented'];},(p:any)=>{p.setPlan.slots[0].role='scene';}]){
    const p=plan();change(p);assert.throws(()=>assertImagePlan(validateImagePlan(p),context()));
  }
});
test('real source dimensions require one size image within the seven; default dimensions do not',()=>{
  const c=context(),p=plan();c.listing.evidence.push({id:'size',name:'Product diameter',value:'8 cm',meaning:'general',source:'source_confirmed'});
  assert.throws(()=>assertImagePlan(validateImagePlan(p),c));
  p.setPlan.dimensionEvidenceIds=['size'];p.setPlan.dimensionReason='Measured product diameter.';
  p.setPlan.slots[6]={...p.setPlan.slots[6],role:'dimensions',focus:'Product diameter',evidenceIds:['size'],textMode:'planned',expectedText:[{text:'Diameter 8 cm',evidenceIds:['size']}]};
  assert.doesNotThrow(()=>assertImagePlan(validateImagePlan(p),c));
  p.setPlan.slots[5]={...p.setPlan.slots[6],index:6};assert.throws(()=>assertImagePlan(validateImagePlan(p),c));
  const defaults=context();defaults.listing.evidence.push({id:'default',name:'业务默认尺寸',value:'5×5×5 cm',meaning:'general',source:'selected_sku'});
  assert.doesNotThrow(()=>assertImagePlan(validateImagePlan(plan()),defaults));
});
test('compatibility lengths do not force a product size chart or suppress checking the source images',()=>{
  const c=context();c.listing.evidence.push({id:'fits',name:'Compatibility',value:'Fits 10 cm cups',meaning:'general',source:'source_confirmed'});
  assert.doesNotThrow(()=>assertImagePlan(validateImagePlan(plan()),c));
});
test('scene captions may be empty or short nonfactual English; factual claims still need evidence',()=>{
  const p=plan();p.setPlan.slots[2].textMode='planned';p.setPlan.slots[2].expectedText=[{text:'A quiet moment',evidenceIds:[]}];
  assert.doesNotThrow(()=>assertImagePlan(validateImagePlan(p),context()));
  p.setPlan.slots[2].expectedText=[{text:'Waterproof silicone, 5 cm',evidenceIds:[]}];
  assert.throws(()=>assertImagePlan(validateImagePlan(p),context()));
});
test('the source-image size selected by the whole-set plan also supports its visual summary',()=>{
  const c=context(),p=plan(),id='reference:'+assetId+':0';
  c.referenceMeasurements=[{id,assetId,ocrResultId:randomUUID(),text:'Diameter 8 cm'}];
  p.setPlan.dimensionEvidenceIds=[id];p.setPlan.dimensionReason='Printed product diameter.';
  p.setPlan.slots[6]={...p.setPlan.slots[6],role:'dimensions',evidenceIds:[id],textMode:'planned',expectedText:[{text:'Diameter 8 cm',evidenceIds:[id]}]};
  p.productUnderstanding.summary+=' Printed diameter 8 cm.';
  assert.doesNotThrow(()=>assertImagePlan(validateImagePlan(p),c));
  p.productUnderstanding.summary+=' Height 80 cm.';assert.throws(()=>assertImagePlan(validateImagePlan(p),c));
});
test('provider handoff appends hard role/text rules and exactly the approved captions',()=>{
  const c=context(),p=plan();c.setPlan=p.setPlan;c.slot={index:1,total:7,provisional:true};delete p.setPlan;
  const prompt=imageGenerationPrompt(p,c);assert.match(prompt,/scene/i);assert.match(prompt,/no visible text/i);
  c.purpose='detail';c.slot.index=2;p.textMode='planned';p.expectedText=[{text:'Silicone',evidenceIds:['material']}];
  assert.match(imageGenerationPrompt(p,c),/Silicone/);assert.match(imageGenerationPrompt(p,c),/one selling point/i);
});

test('disabled risk interception preserves the recorded IP finding while still requiring identified source appearance',()=>{
  const c=context(),p=plan();c.setPlan=p.setPlan;c.slot={index:1,total:7,provisional:true};delete p.setPlan;
  p.ipRisk={verdict:'UNCERTAIN',findings:[{category:'uncertain',name:'Unclear mark',evidence:'Reference detail.',referenceAssetIds:[assetId]}]};
  const before=structuredClone(p);
  assert.throws(()=>imageGenerationPrompt(p,c));
  assert.doesNotThrow(()=>imageGenerationPrompt(p,c,false));assert.deepEqual(p,before);
  p.productUnderstanding.sufficient=false;p.productUnderstanding.uncertainties=['No identifiable source product.'];
  assert.throws(()=>imageGenerationPrompt(p,c,false));
});
test('new OCR rules cannot pass visible text on the main or a missing required selling-point caption',()=>{
  const c=context(),p=plan();c.setPlan=p.setPlan;delete p.setPlan;c.slot={index:1,total:7,provisional:true};
  const candidate={id:randomUUID(),sha256:'a'.repeat(64),width:256,height:256},planResult:any={id:randomUUID(),output:p},ocr:any={id:randomUUID(),output:{kind:'generated-image-ocr',candidate,text:'Silicone',lines:[]}};
  const review:any={kind:'image-text-review',candidate,planResultId:planResult.id,ocrResultId:ocr.id,verdict:'PASS',checks:[{source:'summary',index:0,text:'Silicone',verdict:'SUPPORTED',evidenceIds:['material'],reason:'Source material.'}],expectedTextChecks:[],noTextVerified:false,issues:[],visualReview:'not_performed'};
  assert.throws(()=>assertImageTextReview(review,c,planResult,ocr,candidate));
  c.purpose='detail';c.slot.index=2;p.textMode='planned';p.expectedText=[{text:'Silicone',evidenceIds:['material']}];ocr.output.text='';review.checks=[];review.noTextVerified=true;review.expectedTextChecks=[{index:0,present:false,reason:'Missing.'}];
  assert.throws(()=>assertImageTextReview(review,c,planResult,ocr,candidate));
  review.verdict='NEEDS_CHANGES';review.issues=['Add the missing selling-point caption.'];
  assert.doesNotThrow(()=>assertImageTextReview(review,c,planResult,ocr,candidate));
  review.verdict='PASS';review.issues=[];ocr.output.text='Silicone. Waterproof.';review.noTextVerified=false;review.expectedTextChecks[0].present=true;
  review.checks=[{source:'summary',index:0,text:ocr.output.text,verdict:'UNSUPPORTED',evidenceIds:['material'],reason:'Waterproof has no source support.'}];
  assert.throws(()=>assertImageTextReview(review,c,planResult,ocr,candidate));
});
