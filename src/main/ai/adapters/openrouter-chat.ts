import { AiError } from '../errors.ts';
import { emptyUsage } from '../transport.ts';
import type { AdapterContext,ProviderMetadata } from '../transport.ts';
import type { DeepSeekReferenceImage } from '../vision.ts';
import { visionContent,MAX_VISION_REQUEST_BYTES } from '../vision.ts';
import { checkReasoning } from '../model-capabilities.ts';
import { postOpenRouter,openRouterFailure,openRouterReceiptState } from './openrouter-http.ts';

export async function requestOpenRouterJson(payload:unknown,system:string,model:string,credentials:{apiKey:string},signal:AbortSignal,context:AdapterContext,maxTokens=4096,images:readonly DeepSeekReferenceImage[]=[]):Promise<ProviderMetadata&{content:unknown}>{
  const effort=context.effectiveEffort??'medium',capability=checkReasoning('openrouter',model,effort);
  if(context.gateway==='deepseek'||capability.endpoint==='decisions'||images.length&&!capability.vision)throw new AiError('INVALID_CONFIG');
  const body={model,messages:[{role:'system',content:system+'\nReturn only a valid JSON object.'},{role:'user',content:images.length?visionContent(payload,images):JSON.stringify(payload)}],reasoning:{effort},response_format:{type:'json_object'},stream:false,max_tokens:effort==='none'?maxTokens:Math.max(maxTokens,32768),provider:{allow_fallbacks:true,require_parameters:true}};
  if(Buffer.byteLength(JSON.stringify(body))>MAX_VISION_REQUEST_BYTES)throw new AiError('IMAGE_INVALID');
  const raw=await postOpenRouter('/api/v1/chat/completions',body,credentials,signal,context);
  // Deferred responses can return before the ordinary transport classification.
  const failure=openRouterFailure(200,raw);if(failure)throw failure;
  const invalidOutput=(diagnosticReason?:string)=>Object.assign(new AiError('OUTPUT_INVALID'),{certainty:openRouterReceiptState(200,raw)==='unknown'?'SENT_UNKNOWN' as const:'RECEIVED_INVALID' as const,...(diagnosticReason?{diagnosticReason}:{})});
  const usage=emptyUsage();let usageKnown=false;
  if(raw?.usage&&['prompt_tokens','completion_tokens'].every(k=>Number.isSafeInteger(raw.usage[k])&&raw.usage[k]>=0&&raw.usage[k]<=1_000_000_000)
    &&(raw.usage.total_tokens===undefined||raw.usage.total_tokens===raw.usage.prompt_tokens+raw.usage.completion_tokens)){
    usage.promptTokens=raw.usage.prompt_tokens;usage.completionTokens=raw.usage.completion_tokens;usageKnown=true;
  }
  const metadata={requestId:typeof raw?.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw.id)?raw.id:null,usage,usageKnown};context.onMetadata?.(metadata);
  if(!Array.isArray(raw?.choices)||raw.choices.length!==1||raw.choices[0]?.finish_reason!=='stop'||raw.choices[0].message?.refusal||raw.choices[0].message?.tool_calls?.length||typeof raw.choices[0].message?.content!=='string')throw invalidOutput('RESPONSE_NOT_CONTENT');
  let content:unknown;try{content=JSON.parse(raw.choices[0].message.content);}catch{throw invalidOutput();}
  context.onUntrustedOutput?.(structuredClone(content));return{...metadata,content};
}
