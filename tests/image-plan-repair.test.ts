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
  let captured:unknown,calls=0,body='';
  const invoke=()=>planProductImage(c,undefined,'deepseek-flash',{apiKey:'test-only'},new AbortController().signal,{now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,onUntrustedOutput:value=>{captured=value;},fetch:async(_url:unknown,init?:{body?:unknown})=>{calls++;body=String(init?.body??'');return chat(p);}},[{assetId,sha256,mimeType:'image/png',width:256,height:256,bytes}]);
  return {c,p,invoke,raw:()=>captured,calls:()=>calls,body:()=>body};
}

test('current seven-image planning preserves ordinary AI interpretation instead of removing modifiers through a finite whitelist',async()=>{
  const f=sample(),before=structuredClone(f.p),result=await f.invoke(),p=result.output;
  assert.equal(p.setPlan!.slots.length,7);assert.equal(p.setPlan!.slots[3].role,'selling_point');
  assert.equal(p.setPlan!.slots[3].expectedText[0].text,'Multicolor rainbow gradient finish');
  assert.match(p.setPlan!.slots[3].prompt,/gradient/i);
  assert.deepEqual(p.setPlan!.slots[4],before.setPlan.slots[4]);
  assert.deepEqual(p.setPlan!.slots[0],before.setPlan.slots[0]);
  assert.deepEqual(f.raw(),before);assert.equal(f.calls(),1);assert.doesNotThrow(()=>assertImagePlan(p,f.c));
});

test('current planning preserves an AI-visible detail when the source has no explicit contradiction',async()=>{
  const f=sample('Red Eyes'),result=await f.invoke(),slot=result.output.setPlan!.slots[3];
  assert.equal(slot.role,'selling_point');assert.equal(slot.textMode,'planned');assert.deepEqual(slot.expectedText,[{text:'Red Eyes',evidenceIds:['shape']}]);
  assert.match(slot.prompt,/Red Eyes/);
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
  f.p.textMode='planned';f.p.expectedText=[{text:'Different caption',evidenceIds:[f.c.listing.evidence[0].id]}];delete f.p.setPlan;
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

test('bare lens focal lengths in generation prompts become qualitative photography; product measurements stay strict',async()=>{
  // Phrasing taken from a rejected live plan: the model wrote camera lenses as "<n>mm lens" without "look".
  const prompts=['Frog figurine on a dark wooden desk at night, shallow depth of field, 50mm lens, slightly above eye level.','Close-up of the back and hind legs, shallow depth of field, 100mm macro lens, no text, no logos.','Soft light on the body surface, shallow depth of field, 85mm lens, no text, no logos.'];
  const f=sample();f.p.prompt=prompts[0];f.p.setPlan.slots[0].prompt=prompts[0];f.p.setPlan.slots[1].prompt=prompts[1];f.p.setPlan.slots[5].prompt=prompts[2];
  const result=await f.invoke(),all=[result.output.prompt,...result.output.setPlan!.slots.map(slot=>slot.prompt)].join('\n');
  assert.doesNotMatch(all,/\d\s*mm/i);assert.match(result.output.setPlan!.slots[1].prompt,/natural photographic perspective/);
  assert.match(result.output.setPlan!.slots[1].prompt,/^Close-up of the back and hind legs, shallow depth of field,/);assert.match(result.output.setPlan!.slots[1].prompt,/no text, no logos\.$/);
  assert.deepEqual(result.output.setPlan!.slots[4].expectedText,[{text:'15.5 cm',evidenceIds:['size']}]);
  assert.equal((f.raw() as any).setPlan.slots[1].prompt,prompts[1]);assert.doesNotThrow(()=>assertImagePlan(result.output,f.c));
  // Not a standalone camera direction: stays on the strict measurement path and is rejected.
  for(const wording of ['Product length: 50mm lens, no text.','The product includes a 50mm lens, no text.','Product close-up, 50mm wide, no text.','Product close-up, 50mm lens cap included, no text.']){
    const g=sample();g.p.setPlan.slots[1].prompt=wording;await assert.rejects(g.invoke(),wording);
  }
  // A caption is product text, never a camera direction.
  const caption=sample();caption.p.setPlan.slots[3].expectedText[0].text='Multicolor finish, 50mm lens';await assert.rejects(caption.invoke());
  // When the product itself is described by a lens or focal length, a bare lens number may be a product fact.
  const optical=sample();optical.c.listing.evidence.push({id:'optic',name:'Lens',value:'35 mm lens',meaning:'general',source:'source_confirmed'});
  optical.p.setPlan.slots[1].prompt=prompts[2];await assert.rejects(optical.invoke());
});

test('an empty top-level prompt in initial set planning is filled from slot 1 and still strictly checked',async()=>{
  // Seen live: the model wrote all seven slot prompts but returned the outer prompt as "".
  for(const empty of ['','  \n']){
    const f=sample();f.p.prompt=empty;const before=structuredClone(f.p),result=await f.invoke();
    assert.equal(result.output.prompt,result.output.setPlan!.slots[0].prompt);assert.ok(result.output.prompt.trim());
    assert.deepEqual(result.output.setPlan!.slots[4],before.setPlan.slots[4]);
    assert.deepEqual(f.raw(),before,'the captured provider reply keeps the empty prompt');assert.equal(f.calls(),1);
    assert.doesNotThrow(()=>assertImagePlan(result.output,f.c));
  }
  // The copied prompt gets no exemption from the measurement check.
  const wrong=sample();wrong.p.prompt='';wrong.p.setPlan.slots[0].prompt='Desk scene with the product, 99 cm long.';
  await assert.rejects(wrong.invoke(),(error:any)=>error.code==='OUTPUT_INVALID'&&error.reason==='UNSUPPORTED_MEASUREMENT');
  // Nothing to copy: the reply is incomplete and stays rejected, with a specific reason.
  const hollow=sample();hollow.p.prompt='';hollow.p.setPlan.slots[0].prompt='';
  await assert.rejects(hollow.invoke(),(error:any)=>error.code==='OUTPUT_INVALID'&&error.reason==='EMPTY_PROMPT');
  for(const value of [null,undefined,7]){const typed=sample();typed.p.prompt=value;if(value===undefined)delete typed.p.prompt;await assert.rejects(typed.invoke(),(error:any)=>error.code==='OUTPUT_INVALID');}
  // A source refusal keeps its deliberately empty prompt: a refusal must never become a generation instruction.
  const refusal=sample();refusal.p.prompt='';refusal.p.productUnderstanding={...refusal.p.productUnderstanding,sufficient:false,uncertainties:['The reference does not show the selected SKU clearly.']};
  const refused=await refusal.invoke().then(result=>result.output.prompt,(error:any)=>error.code);assert.notEqual(refused,refusal.p.setPlan.slots[0].prompt);
  // A single frozen slot plan has no set to copy from; an empty prompt there is never filled.
  const child=sample();child.c.slot={index:1,total:7,provisional:true};child.c.setPlan=structuredClone(child.p.setPlan);delete child.p.setPlan;child.p.prompt='';
  await assert.rejects(child.invoke(),(error:any)=>error.code==='OUTPUT_INVALID'&&error.reason==='EMPTY_PROMPT');
});

test('the set-planning instructions state what the outer prompt must contain',async()=>{
  const f=sample();await f.invoke();const system=f.body();
  assert.match(system,/top-level prompt MUST be non-empty/);assert.match(system,/slot 1/i);
});
