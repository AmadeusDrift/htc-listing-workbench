import {safeResponse} from './adapters/openrouter-http.ts';
import {AiError} from './errors.ts';
import type {AdapterContext,AliyunFinalIdentity} from './transport.ts';
import type {AiCredentials} from './primitives.ts';
import {containsSecret} from './adapters.ts';
import {requestId} from './primitives.ts';
import {opaqueResponse} from './opaque-response.ts';
/** Final OCR/moderation only. Temporary upload credentials never enter this collector. */
export function aliyunFinalContext(context:AdapterContext,identity:AliyunFinalIdentity,model:string,credentials:readonly AiCredentials[]):AdapterContext {
 const safeText=(text:string)=>credentials.every(c=>Object.values(c).every(value=>typeof value!=='string'||safeResponse(text,value)));
 const emit=async(status:number,body:unknown)=>{
  const safe=credentials.some(secret=>containsSecret(body,secret))?'[omitted: credential echo]':body;let id:string|null=null;
  try{id=requestId((safe as any)?.RequestId);}catch{/* Invalid IDs are not retained. */}
  await context.onProviderReceipt?.({gateway:'aliyun',aliyun:identity,endpoint:identity.action==='RecognizeAllText'?'/?Type=Commerce':'/',model,status,requestId:id,receivedAt:context.now().toISOString(),body:safe,costUsd:null});
 };
 return {...context,captureRawResponse:async(status,text)=>{let body:unknown;try{body=JSON.parse(text);}catch{body=text;}if(!safeText(text))body='[omitted: credential echo]';await emit(status,body);if(body==='[omitted: credential echo]')throw Object.assign(new AiError('OUTPUT_INVALID'),{diagnosticReason:'RESPONSE_SECRET_ECHO'});},captureRawBytes:async(status,bytes)=>{const text=bytes.toString('utf8');await emit(status,!safeText(text)?'[omitted: credential echo]':opaqueResponse(bytes));}};
}
