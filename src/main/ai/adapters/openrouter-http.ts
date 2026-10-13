import { AiError,httpError,throwIfAborted,abortable } from '../errors.ts';
import type { AdapterContext } from '../transport.ts';
import type { ProviderMetadata } from '../transport.ts';
import { emptyUsage } from '../transport.ts';

export type OpenRouterEndpoint='/api/v1/chat/completions'|'/api/alpha/decisions'|'/api/v1/images'|'/api/v1/batches';
export function openRouterHttpError(status:number):AiError&{httpStatus:number;definitive:boolean}{
  return Object.assign(httpError(status),{httpStatus:status,definitive:[400,401,402,403,404,405,413,415,422,429].includes(status)});
}
export function openRouterMetadata(raw:any):ProviderMetadata{
  const usage=emptyUsage(),prompt=raw?.usage?.prompt_tokens??raw?.usage?.input_tokens,completion=raw?.usage?.completion_tokens??raw?.usage?.output_tokens;
  const usageKnown=[prompt,completion].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000)&&(raw?.usage?.total_tokens===undefined||raw.usage.total_tokens===prompt+completion);
  if(usageKnown){usage.promptTokens=prompt;usage.completionTokens=completion;}
  return{requestId:typeof raw?.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw.id)?raw.id:null,usage,usageKnown};
}
function safeResponse(text:string,key:string):boolean{
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
  throwIfAborted(signal);const serialized=JSON.stringify(body);context.beforeSend?.(serialized);
  let response:Response;
  try{response=await context.fetch('https://openrouter.ai'+endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json',authorization:`Bearer ${credentials.apiKey}`},body:serialized,redirect:'error',signal});}
  catch{throwIfAborted(signal);throw new AiError('NETWORK_ERROR');}
  const reader=response.body?.getReader();if(!reader)throw new AiError('OUTPUT_INVALID');
  const captureSignal=AbortSignal.timeout(30_000),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await abortable(reader.read(),captureSignal,()=>{void reader.cancel().catch(()=>{});});if(part.done)break;size+=part.value.length;if(size>context.maxResponseBytes)throw new AiError('OUTPUT_INVALID');chunks.push(part.value);}}
  catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{throw new AiError('OUTPUT_INVALID');}
  const safe=safeResponse(text,credentials.apiKey);let raw:any;let valid=true;
  try{raw=JSON.parse(text);}catch{raw=text;valid=false;}
  const id=typeof raw?.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw.id)&&!raw.id.includes(credentials.apiKey)?raw.id:null;
  const cost=typeof raw?.usage?.cost==='number'&&Number.isFinite(raw.usage.cost)&&raw.usage.cost>=0?raw.usage.cost:null;
  const metadata=openRouterMetadata(raw);metadata.requestId=id;context.onMetadata?.(metadata);
  await context.onProviderReceipt?.({gateway:'openrouter',endpoint,model:String(body.model??''),status:response.status,requestId:id,receivedAt:context.now().toISOString(),body:safe?raw:'[omitted: credential echo]',costUsd:cost});
  throwIfAborted(signal);if(!response.ok)throw openRouterHttpError(response.status);
  if(!safe)throw Object.assign(new AiError('OUTPUT_INVALID'),{diagnosticReason:'RESPONSE_SECRET_ECHO',responseDiagnostic:{status:response.status,byteCount:size}});
  if(!valid)throw new AiError('OUTPUT_INVALID');return raw;
}
