import { AiError,throwIfAborted } from '../errors.ts';
import { inspectRaster } from '../../image-format.ts';
import type { AdapterContext } from '../transport.ts';
import { readBounded } from '../transport.ts';
import { postOpenRouter } from './openrouter-http.ts';

export const OPENROUTER_IMAGE_MODELS=['openai/gpt-image-2.5-sunburst','openai/gpt-image-2.5-flare'] as const;
export interface OpenRouterImageRequest{apiKey:string;model:string;prompt:string;size:string;quality:string;background:string;references:{mimeType:'image/png'|'image/jpeg';bytes:Buffer}[]}
export function decodeOpenRouterImage(raw:any):{bytes:Buffer;requestId:string|null;width:number;height:number}{
  if(!Array.isArray(raw?.data)||raw.data.length!==1||typeof raw.data[0].b64_json!=='string'||raw.data[0].b64_json.length>30*1024*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data[0].b64_json))throw new AiError('OUTPUT_INVALID');
  const bytes=Buffer.from(raw.data[0].b64_json,'base64');if(!bytes.length||bytes.length>20*1024*1024)throw new AiError('OUTPUT_INVALID');
  let raster;try{raster=inspectRaster(bytes);}catch{throw new AiError('OUTPUT_INVALID');}
  if(raster.mimeType!=='image/png'||raw.data[0].media_type!==undefined&&raw.data[0].media_type!=='image/png')throw new AiError('OUTPUT_INVALID');
  return{bytes,width:raster.width,height:raster.height,requestId:typeof raw.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw.id)?raw.id:null};
}
export class OpenRouterImageAdapter{
  private fetcher:typeof fetch;
  constructor(deps:{fetch?:typeof fetch}={}){this.fetcher=deps.fetch??globalThis.fetch;}
  async checkModel(apiKey:string,model:string,signal:AbortSignal):Promise<void>{
    if(!OPENROUTER_IMAGE_MODELS.includes(model as any))throw new AiError('INVALID_CONFIG');
    const response=await this.fetcher(`https://openrouter.ai/api/v1/images/models/${model}/endpoints`,{headers:{authorization:`Bearer ${apiKey}`},redirect:'error',signal});
    throwIfAborted(signal);if(!response.ok)throw new AiError('SERVICE_PERMISSION_REQUIRED');
    const raw=await readBounded(response,1024*1024,signal) as any;if(!raw||!(Array.isArray(raw.endpoints)||Array.isArray(raw.data?.endpoints)))throw new AiError('OUTPUT_INVALID');
  }
  async generate(input:OpenRouterImageRequest,signal:AbortSignal,hooks:Pick<AdapterContext,'onProviderReceipt'|'beforeSend'>={}){
    if(!OPENROUTER_IMAGE_MODELS.includes(input.model as any)||!input.apiKey||!input.prompt.trim()||input.prompt.length>32000||!['auto','1024x1024','1536x1024','1024x1536'].includes(input.size)||!['auto','low','medium','high'].includes(input.quality)||!['auto','transparent','opaque'].includes(input.background)||input.references.length>16)throw new AiError('INVALID_CONFIG');
    let total=0;for(const ref of input.references){total+=ref.bytes.length;if(!['image/png','image/jpeg'].includes(ref.mimeType)||ref.bytes.length>10*1024*1024||total>23*1024*1024||inspectRaster(ref.bytes).mimeType!==ref.mimeType)throw new AiError('IMAGE_INVALID');}
    const body={model:input.model,prompt:input.prompt,n:1,size:input.size,quality:input.quality,background:input.background,output_format:'png',provider:{only:['openai'],allow_fallbacks:false},...(input.references.length?{input_references:input.references.map(r=>({type:'image_url',image_url:{url:`data:${r.mimeType};base64,${r.bytes.toString('base64')}`}}))}:{})};
    const raw=await postOpenRouter('/api/v1/images',body,{apiKey:input.apiKey},signal,{fetch:this.fetcher,now:()=>new Date(),nonce:()=>'',maxResponseBytes:40*1024*1024,...hooks});
    return decodeOpenRouterImage(raw);
  }
}
