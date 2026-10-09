import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { planProductImage } from '../src/main/ai/image-adapters.ts';
import { assertImagePlan } from '../src/main/ai/image-validation.ts';
import { sceneSet } from './fixtures/image-set.ts';
import { chat } from './fixtures/listing-ai.ts';

function sample(caption='Multicolor rainbow gradient finish') {
  const variantId=randomUUID(),assetId=randomUUID();
  const bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(256,16);bytes.writeUInt32BE(256,20);
  const sha256=createHash('sha256').update(bytes).digest('hex'),specId=`${variantId}:spec`;
  const c:any={purpose:'main',policyVersion:'product-image/ip-v3',setPolicy:'seven-product-v2',listing:{variantId,sku:'SELECTED',evidence:[{id:specId,name:'Selected SKU specification',value:'炫彩多色红蓝绿多色',meaning:'general',source:'selected_sku'},{id:'shape',name:'造型',value:'青蛙',meaning:'item_shape',source:'source_confirmed'},{id:'size',name:'Product length',value:'15.5 cm',meaning:'general',source:'source_confirmed'}]},referenceAssets:[{assetId,sha256,variantId}],referenceMeasurements:[]};
  const set=sceneSet();set.dimensionEvidenceIds=['size'];set.dimensionReason='Verified length.';
  const ids=caption==='Red Eyes'?['shape']:[specId];
  set.slots[3]={...set.slots[3],role:'selling_point',focus:caption,evidenceIds:ids,textMode:'planned',expectedText:[{text:caption,evidenceIds:ids}],prompt:`Product close-up. Short text overlay: '${caption}'.`};
  set.slots[4]={...set.slots[4],role:'dimensions',evidenceIds:['size'],textMode:'planned',expectedText:[{text:'15.5 cm',evidenceIds:['size']}]};
  const p:any={kind:'image-plan',prompt:'Show the actual selected product in a desk scene.',textMode:'none',expectedText:[],productUnderstanding:{summary:'The reference frog figurine.',referenceAssetIds:[assetId],uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS',findings:[]},setPlan:set};
  let captured:unknown,calls=0;
  const invoke=()=>planProductImage(c,undefined,'deepseek-flash',{apiKey:'test-only'},new AbortController().signal,{now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,onUntrustedOutput:value=>{captured=value;},fetch:async()=>{calls++;return chat(p);}},[{assetId,sha256,mimeType:'image/png',width:256,height:256,bytes}]);
  return {c,p,invoke,raw:()=>captured,calls:()=>calls};
}

test('initial seven-image planning removes only an unsupported gradient modifier from a supported multicolor caption',async()=>{
  const f=sample(),before=structuredClone(f.p),result=await f.invoke(),p=result.output;
  assert.equal(p.setPlan!.slots.length,7);assert.equal(p.setPlan!.slots[3].role,'selling_point');
  assert.equal(p.setPlan!.slots[3].expectedText[0].text,'Multicolor rainbow finish');
  assert.doesNotMatch(p.setPlan!.slots[3].prompt,/gradient/i);
  assert.deepEqual(p.setPlan!.slots[4],before.setPlan.slots[4]);
  assert.deepEqual(p.setPlan!.slots[0],before.setPlan.slots[0]);
  assert.deepEqual(f.raw(),before);assert.equal(f.calls(),1);assert.doesNotThrow(()=>assertImagePlan(p,f.c));
});

test('an unsupported red-eye selling point becomes a text-free reference scene without retaining the bad caption',async()=>{
  const f=sample('Red Eyes'),result=await f.invoke(),slot=result.output.setPlan!.slots[3];
  assert.equal(slot.role,'scene');assert.equal(slot.textMode,'none');assert.deepEqual(slot.expectedText,[]);
  assert.doesNotMatch([slot.focus,slot.scene,slot.prompt].join(' '),/red eyes|overlay:/i);
  assert.match(slot.prompt,/selected SKU/i);assert.match(slot.prompt,/no visible text/i);
  assert.equal(result.output.setPlan!.slots.length,7);assert.doesNotThrow(()=>assertImagePlan(result.output,f.c));
});

test('caption recovery cannot hide unknown references, foreign SKU facts, wrong sizes or text on the main image',async()=>{
  for(const alter of [
    (f:ReturnType<typeof sample>)=>{f.p.setPlan.slots[3].evidenceIds=['unknown'];f.p.setPlan.slots[3].expectedText[0].evidenceIds=['unknown'];},
    (f:ReturnType<typeof sample>)=>{const other={...f.c.listing.evidence[0],id:`${randomUUID()}:spec`};f.c.listing.evidence.push(other);f.p.setPlan.slots[3].evidenceIds=[other.id];f.p.setPlan.slots[3].expectedText[0].evidenceIds=[other.id];},
    (f:ReturnType<typeof sample>)=>{f.p.setPlan.slots[3].expectedText[0].text='Length 99 cm';},
    (f:ReturnType<typeof sample>)=>{f.p.setPlan.slots[4].expectedText[0].text='155 cm';},
    (f:ReturnType<typeof sample>)=>{f.p.setPlan.slots[0].textMode='planned';f.p.setPlan.slots[0].expectedText=[{text:'Hello',evidenceIds:[]}];}
  ]){const f=sample();alter(f);await assert.rejects(f.invoke());}
});

test('a frozen child slot cannot silently replace its approved captions through initial-plan recovery',async()=>{
  const f=sample();f.c.slot={index:4,total:7,provisional:true};f.c.setPlan=structuredClone(f.p.setPlan);f.c.purpose='detail';
  f.p.textMode='planned';f.p.expectedText=f.p.setPlan.slots[3].expectedText;delete f.p.setPlan;
  await assert.rejects(f.invoke());
});

test('new plans translate numeric camera directions to qualitative photography without changing product measurements',async()=>{
  for(const style of ['Natural light, consistent 50mm lens look across all seven images.','Natural light, consistent 50mm-look perspective, soft colors.','Natural light, consistent 50mm three-quarter angle, clean compositions.','柔和自然光，50mm 视角，产品为视觉中心。']){
    const f=sample();f.p.setPlan.style=style;f.p.setPlan.slots[1].prompt='Product close-up, shallow depth of field, 85mm macro look, no text.';
    const result=await f.invoke();assert.doesNotMatch(result.output.setPlan!.style,/50\s*mm/i);assert.doesNotMatch(result.output.setPlan!.slots[1].prompt,/85\s*mm/i);
    assert.deepEqual(result.output.setPlan!.slots[4].expectedText,[{text:'15.5 cm',evidenceIds:['size']}]);
    assert.equal((f.raw() as any).setPlan.style,style);
  }
  for(const wording of ['Product length: 50mm lens look.','50mm lens look printed on the product.','Product dimensions 50 mm.']){
    const f=sample();f.p.setPlan.style=wording;await assert.rejects(f.invoke());
  }
});
