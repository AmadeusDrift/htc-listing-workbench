// External provider response fixtures only. No service completion/DB writes.
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
export function normalPng(index){
  const width=1024,height=1024,crc=bytes=>{let v=0xffffffff;for(const b of bytes){v^=b;for(let k=0;k<8;k++)v=v&1?0xedb88320^(v>>>1):v>>>1;}return(v^0xffffffff)>>>0;};
  const chunk=(name,bytes)=>{const type=Buffer.from(name),size=Buffer.alloc(4),check=Buffer.alloc(4);size.writeUInt32BE(bytes.length);check.writeUInt32BE(crc(Buffer.concat([type,bytes])));return Buffer.concat([size,type,bytes,check]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const pixels=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*4+1)+1+x*4,product=x>270&&x<754&&y>270&&y<754;pixels[i]=product?30:240-index;pixels[i+1]=product?100:236-index;pixels[i+2]=product?220:232-index;pixels[i+3]=255;}
  if(index===2){const font=['11111/10001/10001/11111/00001/00001/11111','00000/00000/00000/00000/00000/00000/00000','00000/00000/01111/10000/10000/10000/01111','00000/00000/11011/10101/10101/10101/10101'];for(const [letter,glyph]of font.entries())for(const [y,row]of glyph.split('/').entries())for(const [x,value]of [...row].entries())if(value==='1')for(let dy=0;dy<5;dy++)for(let dx=0;dx<5;dx++){const i=(850+y*5+dy)*(width*4+1)+1+(440+letter*32+x*5+dx)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;}}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
export function requestPayload(body){
  const request=JSON.parse(body.toString()),content=request.messages?.[1]?.content;
  const payload=typeof content==='string'?JSON.parse(content):Array.isArray(content)?JSON.parse(content.find(p=>p.type==='text').text):request.state;
  return {request,payload};
}
function ids(payload,field){
  const evidence=payload.evidence??[],meaning=field==='color'?'color':field==='material'?'material':null;
  return evidence.filter(e=>!meaning||e.meaning===meaning||field==='color'&&e.name==='Selected SKU specification').map(e=>e.id);
}
function native(payload,field,value){
  const shape=payload.fullSchema.schema.properties[field];assert.ok(shape,'S10_FULL_SCHEMA_FIELD');
  if(shape.type!=='array')return value;const properties=shape.items?.properties;
  return (Array.isArray(value)?value:[value]).map(value=>properties?{value,...(properties.marketplace_id?{marketplace_id:payload.marketplaceId}:{}),...(properties.language_tag?{language_tag:payload.locale}:{})}:value);
}
export function normalChatOutput(payload){
  if(payload.operation==='source-image-consistency')return {kind:'source-image-consistency',version:'source-image-consistency/v2',assets:payload.referenceAssets.map(asset=>({assetId:asset.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Square blue product'],claims:[],contentPurpose:'product',observations:[]}))};
  if(payload.operation==='source-color')return {kind:'source-color',verdict:'DETERMINED',colors:['Blue'],reason:'The synthetic reference pixels show the blue product.',referenceAssetIds:payload.referenceImages.map(i=>i.assetId)};
  if(payload.phase==='keywords')return {kind:'category-decision',phase:'keywords',keywords:['drink coaster','coaster'],productType:null,reason:'The supplied source is a blue silicone drink coaster.',ambiguous:false};
  if(payload.operation==='image-plan'){
    const prompt='Show the selected blue square silicone drink coaster from the original references in a distinct tabletop use scene. Preserve its appearance and one-unit count. No text, labels, lettering, marks or invented claims.';
    const dimension=(payload.requiredDimensionEvidenceIds??[]).find(id=>id.endsWith(':item.length')),expectedText=dimension?[{text:'9 cm',evidenceIds:[dimension]}]:[],frozen=payload.slot?payload.frozenSetPlan.slots[payload.slot.index-1]:null;
    return {kind:'image-plan',...(!payload.slot?{setPlan:{style:'Natural soft light and neutral surfaces.',dimensionEvidenceIds:dimension?[dimension]:[],dimensionReason:'The original source explicitly gives the product length in cm.',slots:Array.from({length:7},(_,i)=>({index:i+1,role:i===0?'main_scene':i===1&&dimension?'dimensions':'scene',focus:i===1?'Product length':'Tabletop context '+(i+1),evidenceIds:i===1&&dimension?[dimension]:[],scene:'Distinct tabletop setting '+(i+1),prompt:i===1&&dimension?'Show the selected blue square coaster with an accurate 9 cm product-length label.':'Scene '+(i+1)+'. '+prompt,textMode:i===1&&dimension?'planned':'none',expectedText:i===1?expectedText:[]}))}}:{}),ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{summary:'Blue square silicone drink coaster matching the selected source',referenceAssetIds:payload.referenceImages.map(i=>i.assetId),uncertainties:['No hidden or unsupported features are inferred.'],sufficient:true},prompt:frozen?.prompt??prompt,textMode:frozen?.textMode??'none',expectedText:frozen?.expectedText??[]};
  }
  if(payload.operation==='image-appearance-review')return {verdict:'PASS',checks:[{aspect:'identity',expected:'Blue square coaster from the selected source',observed:'Blue square coaster in the generated fixture',reason:'Synthetic independent appearance response; IDs and actual candidate bytes remain checked by the real service.',referenceAssetIds:payload.referenceImages.map(i=>i.assetId)}]};
  if(payload.operation==='image-text-review')return {verdict:'PASS',checks:payload.reviewItems.map(item=>({...item,verdict:'SUPPORTED',evidenceIds:payload.plan.expectedText.flatMap(line=>line.evidenceIds),reason:'The OCR label matches the original measured source evidence.'})),expectedTextChecks:payload.plan.expectedText.map((_,index)=>({index,present:true,reason:'The planned label occurs in the OCR text.'})),noTextVerified:payload.reviewItems.length===0,issues:[]};
  if(payload.candidate){return {kind:'amazon-fields-review',verdict:'PASS',checks:payload.candidate.candidates.flatMap(c=>c.items.map((item,index)=>({field:c.field,index,verdict:'SUPPORTED',evidenceIds:item.evidenceIds??ids(payload,c.field),reason:'Matches the explicit synthetic source facts.',claims:[{text:item.value,verdict:'SUPPORTED',evidenceIds:item.evidenceIds??ids(payload,c.field),reason:'Matches the explicit synthetic source facts.'}]}))),issues:[]};}
  if(payload.contract==='listing-full-schema/v1'){
    const values={item_name:'Blue Silicone Drink Coaster',product_description:'A blue silicone drink coaster. One coaster per sales unit.',bullet_point:['Blue silicone drink coaster.','One coaster per sales unit.','Measures 9 cm by 9 cm by 0.5 cm.'],material:'Silicone',color:'Blue',size:'9 x 9 x 0.5 cm',item_type_keyword:'coasters'};
    return {kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:payload.fields.filter(f=>Object.hasOwn(values,f.name)&&!Object.hasOwn(payload.currentAttributes??{},f.name)).map(f=>({field:f.name,nativeValue:native(payload,f.name,values[f.name]),evidenceIds:ids(payload,f.name),transformation:'compose'})),missing:[]};
  }
  throw Error('S10_NORMAL_FIXTURE_OPERATION_PENDING: '+String(payload.operation??payload.phase??'unknown'));
}
export function normalChatResponse(body,id){
  try{const {request,payload}=requestPayload(body);assert.ok(['openai/gpt-6-luna','openai/gpt-6.1-sol','deepseek-flash','deepseek-v4-pro'].includes(request.model));
    return {json:{id,choices:[{finish_reason:'stop',message:{content:JSON.stringify(normalChatOutput(payload))}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,cost:0.001}}};
  }catch{return {status:422,json:{error:{message:'S10 normal fixture has no response for this exact operation'}}};}
}
export function normalDecisionResponse(body,id){
  try{const request=JSON.parse(body.toString());assert.equal(request.model,'openai/gpt-6-luna-decisions');assert.deepEqual(Object.keys(request.questions).sort(),['category','review']);assert.ok(Object.hasOwn(request.questions.category.criteria,'DRINK_COASTER'));assert.ok(Object.hasOwn(request.questions.review.criteria,'clear'));
    return {json:{id,answers:{category:{type:'choice',choice:'DRINK_COASTER',confidence:1},review:{type:'choice',choice:'clear',confidence:1}},usage:{input_tokens:100,output_tokens:50,cost:0.001}}};
  }catch{return {status:422,json:{error:{message:'S10 normal fixture has no response for this exact decision'}}};}
}
