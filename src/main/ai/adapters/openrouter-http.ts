import { AiError,httpError,throwIfAborted,abortable } from '../errors.ts';
import type { AdapterContext } from '../transport.ts';
import type { ProviderMetadata } from '../transport.ts';
import { emptyUsage } from '../transport.ts';
import { responseCollection, transportEvidence } from '../response-lifecycle.ts';

export type OpenRouterEndpoint='/api/v1/chat/completions'|'/api/alpha/decisions'|'/api/v1/images'|'/api/v1/batches';
export function openRouterHttpError(status:number,raw?:unknown):AiError&{httpStatus:number;definitive:boolean}{
  const message=(raw as any)?.error?.message;
  const region=typeof message==='string'&&/^This model is not available in your region\.?$/i.test(message.trim());
  const noProvider=[404,503].includes(status)&&typeof message==='string'&&message.length<=1000&&/^(?:No allowed providers are available for the selected model\.(?: |$)|No endpoints found that support(?: |$)|No available providers(?: found)? for the selected model\.?$)/i.test(message.trim());
  const error=noProvider?new AiError('ROUTING_FORBIDDEN'):status===403?new AiError(region?'MODEL_REGION_RESTRICTED':'ROUTING_FORBIDDEN'):httpError(status);
  if(noProvider){error.diagnosticReason='NO_AVAILABLE_PROVIDER';error.message='当前模型没有符合本次参数与路由条件的可用提供商；未切换模型，请核对模型能力及路由限制';}
  return Object.assign(error,{httpStatus:status,definitive:noProvider||[400,401,402,403,404,405,413,415,422,429].includes(status)});
}
/** Used both at the first response and by read-only receipt recovery. A 200
 * error may follow provider processing; it is never proof of a free rejection. */
export function openRouterFailure(status:number,raw?:unknown):(AiError&{httpStatus:number;definitive:boolean})|null {
  if(status<200||status>=300)return openRouterHttpError(status,raw);
  const data=raw as any,upstream=data?.error??(Array.isArray(data?.choices)?data.choices.find((choice:any)=>choice?.error)?.error:undefined);
  if(upstream==null)return null;
  const error=new AiError('PROVIDER_ERROR');
  error.diagnosticReason='PROVIDER_ERROR_ENVELOPE';
  return Object.assign(error,{httpStatus:status,definitive:false});
}
export function openRouterMetadata(raw:any):ProviderMetadata{
  const usage=emptyUsage(),prompt=raw?.usage?.prompt_tokens??raw?.usage?.input_tokens,completion=raw?.usage?.completion_tokens??raw?.usage?.output_tokens;
  const usageKnown=[prompt,completion].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000)&&(raw?.usage?.total_tokens===undefined||raw.usage.total_tokens===prompt+completion);
  if(usageKnown){usage.promptTokens=prompt;usage.completionTokens=completion;}
  return{requestId:typeof raw?.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw.id)?raw.id:null,usage,usageKnown};
}
export function safeResponse(text:string,key:string):boolean{
  let value=text;
  for(let i=0;i<8;i++){
    if(value.includes(key)||value.includes(encodeURIComponent(key)))return false;
    const decoded=value.replace(/\\u([a-f0-9]{4})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))).replace(/\\(["\\/])/g,'$1');
    if(value===decoded)return true;value=decoded;
  }return false;
}
/** One POST only. Capture the received response before domain parsing, including late responses. */
export async function postOpenRouter(endpoint:OpenRouterEndpoint,body:Record<string,unknown>,credentials:{apiKey:string},signal:AbortSignal,context:AdapterContext):Promise<any>{
  if(!['/api/v1/chat/completions','/api/alpha/decisions','/api/v1/images','/api/v1/batches'].includes(endpoint)||typeof credentials.apiKey!=='string'||!/^[\x21-\x7e]{8,4096}$/.test(credentials.apiKey))throw new AiError('INVALID_CONFIG');
  throwIfAborted(signal);
  if(context.deferOpenRouter){const deferred=await context.deferOpenRouter(endpoint,body);if(deferred){context.onMetadata?.(openRouterMetadata(deferred.body));return deferred.body;}}
  const serialized=JSON.stringify(body),collection=responseCollection(signal,context);
  let response:Response|undefined,size=0,dispatched=false,complete=false;
  try {
  throwIfAborted(collection.signal);
  context.beforeSend?.(serialized);
  throwIfAborted(collection.signal);dispatched=true;
  transportEvidence(context,{event:'DISPATCH_ATTEMPTED',certainty:'SENT_UNKNOWN'});
  try{response=await abortable(context.fetch('https://openrouter.ai'+endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json',...(endpoint==='/api/v1/chat/completions'?{'X-OpenRouter-Metadata':'enabled'}:{}),authorization:`Bearer ${credentials.apiKey}`},body:serialized,redirect:'error',signal:collection.signal}),collection.signal);}
  catch{throwIfAborted(collection.signal);throw new AiError('NETWORK_ERROR');}
  collection.headers();transportEvidence(context,{event:'HEADERS_RECEIVED',httpStatus:response.status,receivedBytes:0,certainty:'SENT_UNKNOWN'});
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>context.maxResponseBytes)){void response.body?.cancel().catch(()=>{});throw new AiError('OUTPUT_INVALID');}
  const reader=response.body?.getReader();if(!reader)throw new AiError('OUTPUT_INVALID');
  const chunks:Uint8Array[]=[];
  try{for(;;){const part=await abortable(reader.read(),collection.signal,()=>{void reader.cancel().catch(()=>{});});if(part.done)break;size+=part.value.length;if(size>context.maxResponseBytes)throw new AiError('OUTPUT_INVALID');chunks.push(part.value);}}
  catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  transportEvidence(context,{event:'BODY_COMPLETED',httpStatus:response.status,receivedBytes:size});
  complete=true;
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{throw new AiError('OUTPUT_INVALID');}
  const safe=safeResponse(text,credentials.apiKey);let raw:any;let valid=true;
  try{raw=JSON.parse(text);}catch{raw=text;valid=false;}
  const id=typeof raw?.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw.id)&&!raw.id.includes(credentials.apiKey)?raw.id:null;
  const cost=typeof raw?.usage?.cost==='number'&&Number.isFinite(raw.usage.cost)&&raw.usage.cost>=0?raw.usage.cost:null;
  const metadata=openRouterMetadata(raw);metadata.requestId=id;context.onMetadata?.(metadata);
  await context.onProviderReceipt?.({gateway:'openrouter',endpoint,model:String(body.model??''),status:response.status,requestId:id,receivedAt:context.now().toISOString(),body:safe?raw:'[omitted: credential echo]',costUsd:cost});
  throwIfAborted(signal);const failure=openRouterFailure(response.status,safe?raw:undefined);if(failure)throw failure;
  if(!safe)throw Object.assign(new AiError('OUTPUT_INVALID'),{diagnosticReason:'RESPONSE_SECRET_ECHO',responseDiagnostic:{status:response.status,byteCount:size}});
  if(!valid)throw Object.assign(new AiError('OUTPUT_INVALID'),{diagnosticReason:size?'RESPONSE_ENVELOPE_JSON_INVALID':'RESPONSE_BODY_EMPTY'});return raw;
  } catch(error) {
    const known=error instanceof AiError?error:new AiError('NETWORK_ERROR');
    known.certainty=!dispatched?'NOT_SENT':complete&&'definitive' in known&&known.definitive===true?'DEFINITIVE_REJECTION':complete&&size>0&&known.code==='OUTPUT_INVALID'&&known.diagnosticReason!=='RESPONSE_SECRET_ECHO'?'RECEIVED_INVALID':'SENT_UNKNOWN';
    transportEvidence(context,{event:'STAGE_BLOCKED',certainty:known.certainty,abortSource:known.abortSource??'NONE',errorCode:known.code,...(response?{httpStatus:response.status}:{}),receivedBytes:size});
    throw known;
  } finally { collection.close(); }
}
