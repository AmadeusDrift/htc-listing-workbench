import { AiError } from '../errors.ts';
import { emptyUsage } from '../transport.ts';
import type { AdapterContext,ProviderMetadata } from '../transport.ts';
import { textModelCapability } from '../model-capabilities.ts';
import { postOpenRouter } from './openrouter-http.ts';

export type DecisionQuestion={type:'choice';criteria:Record<string,string|null>;instructions:string}|{type:'noul';instructions:string;criteria?:{true:string;false:string}}|{type:'score';instructions:string;criteria:string[]};
export type DecisionAnswer={type:'choice';choice:string;confidence?:number;probabilities?:Record<string,number>}|{type:'noul';noul:number}|{type:'score';score:number;confidence?:number;probabilities?:Record<string,number>};
export async function requestOpenRouterDecisions(model:string,state:unknown,questions:Record<string,DecisionQuestion>,credentials:{apiKey:string},signal:AbortSignal,context:AdapterContext):Promise<ProviderMetadata&{answers:Record<string,DecisionAnswer>}>{
  if(textModelCapability('openrouter',model).endpoint!=='decisions'||!Object.keys(questions).length||Object.keys(questions).length>200||Object.entries(questions).some(([id,q])=>!id||id.length>100||!q.instructions?.trim()||q.type==='choice'&&!Object.keys(q.criteria).length))throw new AiError('INVALID_INPUT');
  const raw=await postOpenRouter('/api/alpha/decisions',{model,state,questions,provider:{allow_fallbacks:false}},credentials,signal,context);
  const usage=emptyUsage();let usageKnown=false;
  if(raw?.usage&&['input_tokens','output_tokens'].every(key=>Number.isSafeInteger(raw.usage[key])&&raw.usage[key]>=0&&raw.usage[key]<=1_000_000_000)){usage.promptTokens=raw.usage.input_tokens;usage.completionTokens=raw.usage.output_tokens;usageKnown=true;}
  const metadata={requestId:typeof raw?.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw.id)?raw.id:null,usage,usageKnown};context.onMetadata?.(metadata);
  if(!raw?.answers||typeof raw.answers!=='object'||Array.isArray(raw.answers)||Object.keys(raw.answers).sort().join()!==Object.keys(questions).sort().join())throw new AiError('OUTPUT_INVALID');
  const probability=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1;
  for(const [id,q] of Object.entries(questions)){
    const a=raw.answers[id];if(!a||a.type!==q.type||q.type==='choice'&&(typeof a.choice!=='string'||!Object.hasOwn(q.criteria,a.choice))||q.type==='noul'&&!probability(a.noul)||q.type==='score'&&(typeof a.score!=='number'||!Number.isFinite(a.score)||a.score<0||a.score>q.criteria.length-1)||a.confidence!==undefined&&!probability(a.confidence))throw new AiError('OUTPUT_INVALID');
    if(a.probabilities!==undefined&&(typeof a.probabilities!=='object'||Array.isArray(a.probabilities)||Object.values(a.probabilities).some(n=>!probability(n))))throw new AiError('OUTPUT_INVALID');
  }
  return{...metadata,answers:raw.answers};
}
