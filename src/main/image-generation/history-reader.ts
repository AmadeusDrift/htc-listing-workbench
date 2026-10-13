/** Read-only materialization of an already received historical response. No generation, key or model lookup. */
import {AiError,throwIfAborted} from '../ai/errors.ts';
import {inspectRaster} from '../image-format.ts';
import {invalidImageOutput,unsupportedRelayJpeg} from './errors.ts';
import {createRelayImageDownloader,type RelayDownloadDependencies} from './download.ts';
const MAX_PNG_BYTES=20*1024*1024;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function parseImage(body: unknown, requirePng = true): {bytes:Buffer;width:number;height:number} {
  if (!object(body) || !Array.isArray(body.data) || body.data.length !== 1 || !object(body.data[0])) throw invalidImageOutput('shape');
  const item = body.data[0], encoded = item.b64_json;
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(MAX_PNG_BYTES / 3) || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || (item.url !== undefined && item.url !== null)) throw invalidImageOutput('encoding');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_PNG_BYTES || bytes.toString('base64') !== encoded) throw invalidImageOutput('encoding');
  try {
    const info = inspectRaster(bytes);
    if (requirePng && info.mimeType !== 'image/png') throw invalidImageOutput('raster');
    return { bytes, width: info.width, height: info.height };
  } catch { throw invalidImageOutput('raster'); }
}

export function createHistoricalImageReader(deps:RelayDownloadDependencies={}){
 const download=createRelayImageDownloader(deps);
 return async(raw:unknown,signal:AbortSignal)=>{
  throwIfAborted(signal);
  if(object(raw)&&Array.isArray(raw.data)&&raw.data.length===1&&object(raw.data[0])&&typeof raw.data[0].url==='string'&&!('b64_json' in raw.data[0])){
   const bytes=await download(raw.data[0].url,signal);throwIfAborted(signal);
   try{const info=inspectRaster(bytes);if(info.mimeType!=='image/png')throw unsupportedRelayJpeg();return{bytes,width:info.width,height:info.height};}catch(error){throw error instanceof AiError?error:invalidImageOutput('raster');}
  }
  const parsed=parseImage(raw,false);if(inspectRaster(parsed.bytes).mimeType!=='image/png')throw unsupportedRelayJpeg();return parsed;
 };
}
