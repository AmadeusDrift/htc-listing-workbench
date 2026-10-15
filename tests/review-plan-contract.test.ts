// Independent review probes for f2cb09c and 71847cf; no provider calls or writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {assertImagePlan,validateImagePlan,imageGenerationPrompt} from '../src/main/ai/image-validation.ts';
import {planProductImage} from '../src/main/ai/image-adapters.ts';
import {signAcs3} from '../src/main/ai/acs3.ts';
import {sceneSet} from './fixtures/image-set.ts';
import {chat} from './fixtures/listing-ai.ts';
const require=createRequire(import.meta.url),{verifyProtocol}=require('./fixtures/stabilization/pipeline-protocol.cjs'),{normalPng,normalChatResponse}=require('./fixtures/stabilization/pipeline-normal-responses.mjs');

function sample(text='For Kitchen Cleaning',evidenceIds=['title','fact']){
 const assetId=randomUUID(),set=sceneSet();set.slots[4].textMode='planned';set.slots[4].expectedText=[{text,evidenceIds}];
 const context:any={policyVersion:'product-image/ip-v3',setPolicy:'seven-product-v2',purpose:'detail',referenceAssets:[{assetId}],listing:{variantId:randomUUID(),evidence:[{id:'title',name:'Title',value:'Kitchen cleaning brush',meaning:'general',source:'source_confirmed'},{id:'fact',name:'Material',value:'Silicone',meaning:'material',source:'source_confirmed'},{id:'size',name:'Product length',value:'15.5 cm',meaning:'general',source:'source_confirmed'}]},slot:{index:5,total:7,provisional:true},setPlan:set};
 const raw:any={kind:'image-plan',productUnderstanding:{summary:'One blue brush',referenceAssetIds:[assetId],uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS',findings:[]},prompt:'Photograph the brush.',textMode:'planned',expectedText:[{text,evidenceIds}]};
 return {context,raw};
}
const frozenError=(error:any)=>error.code==='OUTPUT_INVALID'&&error.diagnosticReason==='IMAGE_PLAN_FROZEN_CAPTION_MISMATCH';

test('independent P03 period allowance is nonmutating and changes no caption facts',()=>{
 for(const [frozen,returned,ids] of [['For Kitchen Cleaning','For Kitchen Cleaning.',['title','fact']],['For Kitchen Cleaning.','For Kitchen Cleaning',['title','fact']],['15.5 cm','15.5 cm.',['size']]] as const){
  const {raw,context}=sample(frozen,[...ids]);raw.expectedText[0].text=returned;const before=JSON.stringify({raw,context});
  const plan=validateImagePlan(raw);assert.doesNotThrow(()=>assertImagePlan(plan,context));assert.equal(plan.expectedText[0].text,returned);assert.equal(JSON.stringify({raw,context}),before);
  assert.match(imageGenerationPrompt(plan,context),new RegExp(returned.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 }
 for(const text of ['For kitchen cleaning.','For Kitchen Cleaning..','For Kitchen Cleaning!','For Kitchen Cleaning 2.','For Kitchen Cleanings.']){
  const {raw,context}=sample();raw.expectedText[0].text=text;assert.throws(()=>assertImagePlan(validateImagePlan(raw),context),frozenError);
 }
 for(const text of ['15.50 cm.','15.6 cm.','155 mm.','15.5 in.','15.5 CM.']){
  const {raw,context}=sample('15.5 cm',['size']);raw.expectedText[0].text=text;assert.throws(()=>assertImagePlan(validateImagePlan(raw),context),frozenError);
 }
 const numeric=sample('Pack of 50');numeric.raw.expectedText[0].text='Pack of 50.';assert.throws(()=>assertImagePlan(validateImagePlan(numeric.raw),numeric.context),frozenError);
});

test('independent P03 keeps evidence identifiers and order, caption order/count and source binding exact',()=>{
 for(const evidenceIds of [['fact','title'],['title'],['title','wrong-id'],['title','fact','size']]){
  const {raw,context}=sample();raw.expectedText[0].evidenceIds=evidenceIds;assert.throws(()=>assertImagePlan(validateImagePlan(raw),context),frozenError);
 }
 const {raw,context}=sample();context.setPlan.slots[4].expectedText.push({text:'Silicone',evidenceIds:['fact']});raw.expectedText.push({text:'Silicone',evidenceIds:['fact']});
 assert.doesNotThrow(()=>assertImagePlan(validateImagePlan(raw),context));raw.expectedText.reverse();assert.throws(()=>assertImagePlan(validateImagePlan(raw),context),frozenError);
 raw.expectedText.pop();assert.throws(()=>assertImagePlan(validateImagePlan(raw),context),frozenError);
 const source=sample();source.raw.productUnderstanding.referenceAssetIds=[randomUUID()];assert.throws(()=>assertImagePlan(validateImagePlan(source.raw),source.context));
});

test('independent P03 never infers sufficiency, and an explicit refusal cannot generate',()=>{
 for(const value of [undefined,null,'true',1,{},[]]){const {raw}=sample();raw.productUnderstanding.sufficient=value;assert.throws(()=>validateImagePlan(raw),(error:any)=>error.diagnosticReason==='IMAGE_PLAN_SUFFICIENCY_REQUIRED');}
 const {raw,context}=sample();raw.productUnderstanding.sufficient=false;raw.productUnderstanding.uncertainties=['Reference obscured.'];
 const plan=validateImagePlan(raw);assert.equal(plan.productUnderstanding!.sufficient,false);assert.throws(()=>imageGenerationPrompt(plan,context));
});

test('independent P03 specific feedback stays in a single adapter call with copied source IDs',async()=>{
 for(const reason of ['IMAGE_PLAN_SUFFICIENCY_REQUIRED','IMAGE_PLAN_FROZEN_TEXT_MODE','IMAGE_PLAN_FROZEN_CAPTION_MISMATCH']){
  const {raw,context}=sample(),bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(256,16);bytes.writeUInt32BE(256,20);
  const sha256=createHash('sha256').update(bytes).digest('hex');context.referenceAssets[0].sha256=sha256;let calls=0;
  await planProductImage(context,undefined,'deepseek-flash',{apiKey:'offline-review-only'},new AbortController().signal,{now:()=>new Date(),nonce:randomUUID,maxResponseBytes:100000,imagePlanRetry:true,imagePlanValidationFeedback:{reason,jsonPath:'expectedText'},fetch:async(_url,options)=>{
   calls++;const request=JSON.parse(String(options?.body)),payload=JSON.parse(request.messages[1].content[0].text);assert.equal(payload.validationFailure.reason,reason);assert.ok(payload.validationFailure.correction);assert.deepEqual(payload.referenceImages.map((r:any)=>r.assetId),raw.productUnderstanding.referenceAssetIds);return chat(raw);
  }},[{assetId:context.referenceAssets[0].assetId,sha256,mimeType:'image/png',width:256,height:256,bytes}]);assert.equal(calls,1);
 }
});

test('independent pipeline ACS3 omission preserves URL/Host binding and cryptographic signature',()=>{
 const body=Buffer.from('ServiceParameters=synthetic'),now='2026-10-15T00:00:00.000Z',protocol={kind:'acs3',accessKeyId:'s10-acs-id',accessKeySecret:'s10-acs-secret',action:'ImageModeration',version:'2022-03-02',contentType:'application/x-www-form-urlencoded',now,nonce:'s10-protocol-nonce',bodySha256:createHash('sha256').update(body).digest('hex')};
 const signed=signAcs3({...protocol,host:'green-cip.cn-shanghai.aliyuncs.com',query:{},body,now:new Date(now)}),route={method:'POST',publicUrl:signed.url,protocol};
 const headers={...signed.headers};delete headers.host;assert.equal(verifyProtocol(route,headers,body),true);assert.equal(verifyProtocol(route,signed.headers,body),true);
 assert.throws(()=>verifyProtocol(route,{...headers,host:'wrong.invalid'},body));assert.throws(()=>verifyProtocol({...route,publicUrl:'https://wrong.invalid/'},headers,body));
 assert.throws(()=>verifyProtocol(route,{...headers,authorization:headers.authorization.replace('host;','')},body));assert.throws(()=>verifyProtocol(route,headers,Buffer.from('changed')));
 const forged=signAcs3({...protocol,host:'wrong.invalid',query:{},body,now:new Date(now)});delete forged.headers.host;assert.throws(()=>verifyProtocol(route,forged.headers,body));
});

test('independent direct fixture rejects missing/multiple candidate pixels and wrong dimensions or SHA',()=>{
 const pixels=normalPng(1),candidate={sha256:createHash('sha256').update(pixels).digest('hex'),width:1024,height:1024},image={type:'image_url',image_url:{url:'data:image/png;base64,'+pixels.toString('base64')}};
 const response=(c:any,images:any[])=>normalChatResponse(Buffer.from(JSON.stringify({model:'openai/gpt-6-luna',messages:[{role:'system',content:'fixture'},{role:'user',content:[{type:'text',text:JSON.stringify({operation:'image-text-review',method:'candidate-vision/v1',candidate:c,plan:{textMode:'none',expectedText:[]}})},...images]}]})),'independent-review');
 const negatives:[typeof candidate,typeof image[]][]=[[candidate,[]],[candidate,[image,image]],[{...candidate,width:512},[image]],[{...candidate,height:512},[image]],[{...candidate,sha256:'f'.repeat(64)},[image]]];
 assert.ok(response(candidate,[image]).json.choices);for(const [c,images] of negatives)assert.equal(response(c,images).status,422);
});
