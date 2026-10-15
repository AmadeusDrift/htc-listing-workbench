// Source-observation external wire fixture only. All unimplemented operations fail closed.
import assert from 'node:assert/strict';
export function requestPayload(body){
  const request=JSON.parse(body.toString()),content=request.messages?.[1]?.content;
  const payload=typeof content==='string'?JSON.parse(content):Array.isArray(content)?JSON.parse(content.find(p=>p.type==='text').text):request.state;
  return {request,payload};
}
export function normalChatOutput(payload){
  if(payload.operation==='source-image-consistency')return {kind:'source-image-consistency',version:'source-image-consistency/v2',assets:payload.referenceAssets.map(asset=>({assetId:asset.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Square blue product'],claims:[],contentPurpose:'product',observations:[]}))};
  throw Error('S10_NORMAL_FIXTURE_OPERATION_PENDING');
}
export function normalChatResponse(body,id){
  try{const {request,payload}=requestPayload(body);assert.ok(['openai/gpt-6-luna','openai/gpt-6.1-sol','deepseek-flash','deepseek-v4-pro'].includes(request.model));
    return {json:{id,choices:[{finish_reason:'stop',message:{content:JSON.stringify(normalChatOutput(payload))}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,cost:0.001}}};
  }catch{return {status:422,json:{error:{message:'S10 normal fixture has no response for this exact operation'}}};}
}
