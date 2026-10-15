import { imageRequestNotSent,invalidImageOutput } from '../../image-generation/errors.ts';
import { AiError,throwIfAborted } from '../errors.ts';
import { inspectRaster } from '../../image-format.ts';
import type { AdapterContext } from '../transport.ts';
import { readBounded } from '../transport.ts';
import { postOpenRouter } from './openrouter-http.ts';

export const OPENROUTER_IMAGE_MODELS=['openai/gpt-image-2.5-sunburst','openai/gpt-image-2.5-flare'] as const;
export interface OpenRouterImageRequest{apiKey:string;model:string;prompt:string;size:string;quality:string;background:string;references:{mimeType:'image/png'|'image/jpeg';bytes:Buffer}[]}
export function decodeOpenRouterImage(raw:any):{bytes:Buffer;requestId:string|null;width:number;height:number}{
  if(!raw||!Array.isArray(raw.data)||raw.data.length!==1||!raw.data[0]||typeof raw.data[0]!=='object')throw invalidImageOutput('shape');
  const item=raw.data[0],encoded=item.b64_json;
  if(typeof encoded!=='string'||!encoded.length||encoded.length>4*Math.ceil(20*1024*1024/3)||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||item.url!=null)throw invalidImageOutput('encoding');
  const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>20*1024*1024||bytes.toString('base64')!==encoded)throw invalidImageOutput('encoding');
  let raster;try{raster=inspectRaster(bytes);}catch{throw invalidImageOutput('raster');}
  if(raster.mimeType!=='image/png'||item.media_type!==undefined&&item.media_type!=='image/png')throw invalidImageOutput('raster');
  return{bytes,width:raster.width,height:raster.height,requestId:typeof raw.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw.id)?raw.id:null};
}
export class OpenRouterImageAdapter{
  private fetcher:typeof fetch;private maxResponseBytes:number;
  constructor(deps:{fetch?:typeof fetch;maxResponseBytes?:number}={}){this.fetcher=deps.fetch??globalThis.fetch;this.maxResponseBytes=deps.maxResponseBytes??32*1024*1024;if(!Number.isSafeInteger(this.maxResponseBytes)||this.maxResponseBytes<1||this.maxResponseBytes>32*1024*1024)throw new AiError('INVALID_INPUT');}
  async checkModel(apiKey:string,model:string,signal:AbortSignal):Promise<void>{
    throwIfAborted(signal);if(typeof apiKey!=='string'||!/^[\x21-\x7e]{8,4096}$/.test(apiKey)||!OPENROUTER_IMAGE_MODELS.includes(model as any))throw new AiError('INVALID_INPUT');
    const response=await this.fetcher(`https://openrouter.ai/api/v1/images/models/${model}/endpoints`,{method:'GET',headers:{authorization:`Bearer ${apiKey}`},redirect:'error',signal});
    throwIfAborted(signal);if(!response.ok)throw new AiError('SERVICE_PERMISSION_REQUIRED');
    const raw=await readBounded(response,1024*1024,signal) as any;if(!raw||!(Array.isArray(raw.endpoints)||Array.isArray(raw.data?.endpoints)))throw new AiError('OUTPUT_INVALID');
  }
  async generate(input:OpenRouterImageRequest,signal:AbortSignal,hooks:Pick<AdapterContext,'onProviderReceipt'|'beforeSend'|'onRunEvidence'|'responseDeadlineAt'|'responseTimeoutMs'|'responseBodyTimeoutMs'>={}){
    try{
      throwIfAborted(signal);
      if(!input||typeof input!=='object'||!OPENROUTER_IMAGE_MODELS.includes(input.model as any)||typeof input.apiKey!=='string'||!/^[\x21-\x7e]{8,4096}$/.test(input.apiKey)||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>32000||!['auto','1024x1024','1536x1024','1024x1536'].includes(input.size)||!['auto','low','medium','high'].includes(input.quality)||!['auto','transparent','opaque'].includes(input.background)||!Array.isArray(input.references)||input.references.length>16)throw new AiError('INVALID_INPUT');
      let total=0;for(const ref of input.references){
        if(!ref||!Buffer.isBuffer(ref.bytes)||!['image/png','image/jpeg'].includes(ref.mimeType)||!ref.bytes.length||ref.bytes.length>10*1024*1024)throw new AiError('IMAGE_INVALID');
        total+=ref.bytes.length;if(total>23*1024*1024)throw new AiError('IMAGE_INVALID');
        try{if(inspectRaster(ref.bytes).mimeType!==ref.mimeType)throw new Error();}catch{throw new AiError('IMAGE_INVALID');}
      }
    }catch(error){throw imageRequestNotSent(error);}
    const body={model:input.model,prompt:input.prompt,n:1,size:input.size,quality:input.quality,background:input.background,output_format:'png',provider:{allow_fallbacks:true,require_parameters:true},...(input.references.length?{input_references:input.references.map(r=>({type:'image_url',image_url:{url:`data:${r.mimeType};base64,${r.bytes.toString('base64')}`}}))}:{})};
    let raw;try{raw=await postOpenRouter('/api/v1/images',body,{apiKey:input.apiKey},signal,{fetch:this.fetcher,now:()=>new Date(),nonce:()=>'',maxResponseBytes:this.maxResponseBytes,...hooks});}catch(error){if(error instanceof AiError&&error.code==='OUTPUT_INVALID')error.message=invalidImageOutput('response').message;throw error;}
    let result:ReturnType<typeof decodeOpenRouterImage>;try{result=decodeOpenRouterImage(raw);}catch(error){if(error instanceof AiError&&error.code==='OUTPUT_INVALID')error.certainty??='RECEIVED_INVALID';throw error;}if(result.requestId?.includes(input.apiKey)||result.requestId?.includes(input.prompt))result.requestId=null;return result;
  }
}
