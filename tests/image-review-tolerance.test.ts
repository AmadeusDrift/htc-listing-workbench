import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { planProductImage, reviewProductImageText, reviewCurrentListing } from '../src/main/ai/image-adapters.ts';
import { sceneSet } from './fixtures/image-set.ts';
import { chat } from './fixtures/listing-ai.ts';

function sample() {
  const assetId=randomUUID(), candidate={id:randomUUID(),sha256:'a'.repeat(64),width:256,height:256};
  const size={id:'size',name:'Product length',value:'15.5 cm',meaning:'general',source:'source_confirmed'};
  const set=sceneSet();set.dimensionEvidenceIds=['size'];set.dimensionReason='Verified product length.';
  set.slots[3]={...set.slots[3],role:'dimensions',focus:'Length',evidenceIds:['size'],textMode:'planned',expectedText:[{text:'15.5 cm',evidenceIds:['size']}]};
  const c:any={purpose:'detail',policyVersion:'product-image/ip-v3',setPolicy:'seven-product-v2',slot:{index:4,total:7,provisional:true},setPlan:set,listing:{sku:'CHILD-BLUE',parentageLevel:'CHILD',evidence:[size],fields:[]},referenceAssets:[{assetId,sha256:'b'.repeat(64),variantId:randomUUID()}],referenceMeasurements:[]};
  const plan:any={id:randomUUID(),output:{kind:'image-plan',prompt:'Show the supplied product with a dimension arrow.',textMode:'planned',expectedText:set.slots[3].expectedText,productUnderstanding:{summary:'The selected product.',referenceAssetIds:[assetId],uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS',findings:[]}}};
  const ocr:any={id:randomUUID(),output:{kind:'generated-image-ocr',candidate,text:'< → 15.5cm ',lines:[{text:'<'},{text:'→'},{text:'15.5cm'}]}};
  return {c,plan,ocr,candidate};
}
function transport(respond:(body:any)=>unknown) {
  return {now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,fetch:async (_url:unknown,init:any)=>chat(respond(JSON.parse(String(init.body))))} as any;
}
const signal=()=>new AbortController().signal;

test('dimension review preserves raw OCR and permits layout arrows and unit spacing while checking factual size',async()=>{
  const {c,plan,ocr,candidate}=sample();
  let request:any;
  const result=await reviewProductImageText(c,plan,ocr,candidate,'deepseek-v4-pro',{apiKey:'test-only'},signal(),transport(body=>{
    request=body;
    const payload=JSON.parse(body.messages[1].content);
    return {verdict:'PASS',checks:payload.reviewItems.map((item:any)=>({...item,verdict:'SUPPORTED',evidenceIds:/15/.test(item.text)?['size']:[],reason:'Correct dimension or harmless layout symbol.'})),expectedTextChecks:[{index:0,present:true,reason:'Equivalent spacing.'}],noTextVerified:false,issues:[]};
  }));
  assert.match(request.messages[0].content,/dimension arrows.*layout graphics/i);
  assert.match(request.messages[0].content,/15\.5cm.*15\.5 cm/);
  const payload=JSON.parse(request.messages[1].content);
  assert.equal(payload.unverifiedOcr.text,ocr.output.text);
  assert.deepEqual(payload.unverifiedOcr.lines,ocr.output.lines);
  assert.equal(result.output.verdict,'PASS');assert.equal(result.output.checks[0].text,'< → 15.5cm ');
});

test('layout tolerance never overrides a wrong measurement even when reviewer returns PASS',async()=>{
  const {c,plan,ocr,candidate}=sample();ocr.output.text='< → 155cm ';ocr.output.lines=[{text:'155cm'}];
  await assert.rejects(reviewProductImageText(c,plan,ocr,candidate,'deepseek-v4-pro',{apiKey:'test-only'},signal(),transport(body=>{
    const payload=JSON.parse(body.messages[1].content);
    return {verdict:'PASS',checks:payload.reviewItems.map((item:any)=>({...item,verdict:'SUPPORTED',evidenceIds:['size'],reason:'Claimed equivalent.'})),expectedTextChecks:[{index:0,present:true,reason:'Claimed equivalent.'}],noTextVerified:false,issues:[]};
  })));
});

test('dimension OCR exposes a low-confidence isolated glyph as uncertainty without erasing it or treating numbers as noise',async()=>{
  const {c,plan,ocr,candidate}=sample();
  ocr.output.text='心 → 15.5cm ';
  ocr.output.lines=[{text:'心',confidence:0.76},{text:'→',confidence:0.99},{text:'15.5cm',confidence:0.99},{text:'155cm',confidence:0.2},{text:'白色',confidence:0.2},{text:'商',confidence:0.99}];
  let request:any;
  const result=await reviewProductImageText(c,plan,ocr,candidate,'deepseek-v4-pro',{apiKey:'test-only'},signal(),transport(body=>{
    request=body;const p=JSON.parse(body.messages[1].content);
    return {verdict:'NEEDS_CHANGES',checks:p.reviewItems.map((item:any)=>({...item,verdict:'UNSUPPORTED',evidenceIds:[],reason:'Unresolved OCR.'})),expectedTextChecks:[{index:0,present:true,reason:'Dimension present.'}],noTextVerified:false,issues:['Review unresolved text; do not silently discard it.']};
  }));
  const payload=JSON.parse(request.messages[1].content);
  assert.deepEqual(payload.possibleLayoutNoise,[{index:0,text:'心',confidence:0.76}]);
  assert.equal(payload.reviewItems.find((i:any)=>i.source==='line'&&i.index===0).text,'心');
  assert.equal(result.output.verdict,'NEEDS_CHANGES');
  c.slot.index=1;c.purpose='main';plan.output.textMode='none';plan.output.expectedText=[];
  await reviewProductImageText(c,plan,ocr,candidate,'deepseek-v4-pro',{apiKey:'test-only'},signal(),transport(body=>{
    request=body;const p=JSON.parse(body.messages[1].content);
    return {verdict:'NEEDS_CHANGES',checks:p.reviewItems.map((item:any)=>({...item,verdict:'UNSUPPORTED',evidenceIds:[],reason:'Text on main.'})),expectedTextChecks:[],noTextVerified:false,issues:['Main image has text.']};
  }));
  assert.equal(JSON.parse(request.messages[1].content).possibleLayoutNoise,undefined);
});

test('each listing level gets a text-free scene brief and explicit selected-SKU color and mixed-recipe rules',async()=>{
  for(const parentageLevel of ['NONE','PARENT','CHILD']){
    const {c,plan}=sample();delete c.slot;delete c.setPlan;c.purpose='main';c.listing.parentageLevel=parentageLevel;c.listing.evidence=[];
    const bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(256,16);bytes.writeUInt32BE(256,20);
    const sha256=createHash('sha256').update(bytes).digest('hex');c.referenceAssets[0].sha256=sha256;
    const images=[{assetId:c.referenceAssets[0].assetId,sha256,mimeType:'image/png',width:256,height:256,bytes}] as any;
    let request:any;
    await planProductImage(c,undefined,'deepseek-flash',{apiKey:'test-only'},signal(),transport(body=>{
      request=body;
      return {...plan.output,prompt:'A realistic desk scene.',textMode:'none',expectedText:[],setPlan:sceneSet()};
    }),images);
    const payload=JSON.parse(request.messages[1].content[0].text), system=request.messages[0].content;
    assert.equal(payload.parentageLevel,parentageLevel);
    assert.match(system,/Each child SKU.*own.*color/i);
    assert.match(system,/mixed sales recipes.*all component identities/i);
    assert.match(system,/Main slot 1 MUST.*SCENE with no visible text/);
  }
});

test('copy review allows grounded decorative scene wording without relaxing factual claims',async()=>{
  const c:any={fields:[{name:'product_description'}],evidence:[{id:'display',name:'摆挂形式',value:'摆饰',meaning:'general',source:'source_confirmed'}]};
  const text='A decorative accent for a desk or shelf.';
  let request:any;
  const result=await reviewCurrentListing(c,[{field:'product_description',values:[text]}],'deepseek-v4-pro',{apiKey:'test-only'},signal(),transport(body=>{
    request=body;
    return {kind:'amazon-fields-review',verdict:'PASS',checks:[{field:'product_description',index:0,verdict:'SUPPORTED',evidenceIds:['display'],reason:'Ordinary display context.',claims:[{text,verdict:'SUPPORTED',evidenceIds:['display'],reason:'Decorative use grounded in display evidence.'}]}],issues:[]};
  }));
  assert.match(request.messages[0].content,/subjective aesthetic.*decorative accent/i);
  assert.match(request.messages[0].content,/safety.*performance.*explicit/i);
  assert.match(request.messages[0].content,/color evidence or an explicit color in the selected SKU specification/i);
  assert.equal(result.output.verdict,'PASS');
});
