import {createHash} from 'node:crypto';
import {AiError} from './errors.ts';
export interface OpaqueResponseBytes {version:1;encoding:'raw-utf8-invalid/v1';reason:'RESPONSE_UTF8_INVALID';complete:true;byteSize:number;wireSha256:string;base64:string}
export function opaqueResponse(bytes:Buffer):OpaqueResponseBytes {
  return {version:1,encoding:'raw-utf8-invalid/v1',reason:'RESPONSE_UTF8_INVALID',complete:true,byteSize:bytes.length,wireSha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};
}
/** Reserved receipt encoding, not a generated model result. */
export function assertOpaqueResponse(raw:unknown):void {
  if(!raw||typeof raw!=='object')return;
  const encoding=Object.getOwnPropertyDescriptor(raw,'encoding');if(encoding&&!('value' in encoding))throw new AiError('INVALID_CONFIG');if(encoding?.value!=='raw-utf8-invalid/v1')return;
  if(Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).some(key=>typeof key!=='string')||Object.values(Object.getOwnPropertyDescriptors(raw)).some(value=>!('value' in value)))throw new AiError('INVALID_CONFIG');
  const r=raw as OpaqueResponseBytes;
  if(Object.keys(r).sort().join()!=='base64,byteSize,complete,encoding,reason,version,wireSha256'||r.version!==1||r.reason!=='RESPONSE_UTF8_INVALID'||r.complete!==true||!Number.isSafeInteger(r.byteSize)||r.byteSize<1||r.byteSize>32*1024*1024||typeof r.base64!=='string'||r.base64.length!==4*Math.ceil(r.byteSize/3)||!/^[a-f0-9]{64}$/.test(r.wireSha256))throw new AiError('INVALID_CONFIG');
  const bytes=Buffer.from(r.base64,'base64');if(bytes.length!==r.byteSize||bytes.toString('base64')!==r.base64||createHash('sha256').update(bytes).digest('hex')!==r.wireSha256)throw new AiError('INVALID_CONFIG');
  try{new TextDecoder('utf8',{fatal:true}).decode(bytes);}catch{return;}throw new AiError('INVALID_CONFIG');
}
