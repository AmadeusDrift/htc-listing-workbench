import { createHash, createHmac } from 'node:crypto';

const hmac=(key:string|Buffer,value:string)=>createHmac('sha256',key).update(value).digest();
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const encode=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
/** OSS V4, no query parameters. Used only for the moderation service's temporary upload. */
export function signOss4Put(input:{bucket:string;objectName:string;region:string;accessKeyId:string;accessKeySecret:string;now:Date;headers:Record<string,string>;additionalHeaders?:string[]}):Record<string,string> {
  const timestamp=input.now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'),day=timestamp.slice(0,8);
  const headers:Record<string,string>={...input.headers,'x-oss-content-sha256':'UNSIGNED-PAYLOAD','x-oss-date':timestamp};
  const additional=[...(input.additionalHeaders??[])].sort().join(';');
  const canonicalHeaders=Object.keys(headers).filter(name=>name.startsWith('x-oss-')||['content-type','content-md5',...(input.additionalHeaders??[])].includes(name)).sort().map(name=>`${name}:${headers[name].trim()}\n`).join('');
  const uri=`/${input.bucket}/${input.objectName}`.split('/').map(encode).join('/');
  const canonical=['PUT',uri,'',canonicalHeaders,additional,'UNSIGNED-PAYLOAD'].join('\n');
  const scope=`${day}/${input.region}/oss/aliyun_v4_request`;
  const signingKey=hmac(hmac(hmac(hmac(`aliyun_v4${input.accessKeySecret}`,day),input.region),'oss'),'aliyun_v4_request');
  const signature=hmac(signingKey,`OSS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).toString('hex');
  return {...headers,authorization:`OSS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},${additional?`AdditionalHeaders=${additional},`:''}Signature=${signature}`};
}
