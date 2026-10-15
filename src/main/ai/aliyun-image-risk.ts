import {aliyunFinalContext} from './aliyun-final-receipt.ts';
import { createHash } from 'node:crypto';
import type { CandidateImageIdentity, ImageIpReviewOutput } from '../../shared/image-ai-contracts.ts';
import { inspectRaster } from '../image-format.ts';
import { signAcs3 } from './acs3.ts';
import { signOss4Put } from './oss4.ts';
import { containsSecret } from './adapters.ts';
import type { AdapterResult } from './adapters.ts';
import { AiError, abortable, httpError, throwIfAborted } from './errors.ts';
import { imageIpVerdict, validateCandidateImageIdentity, validateImageIpReview } from './image-validation.ts';
import { emptyUsage, postJson,checkPaidAdapterEffect } from './transport.ts';
import type { AdapterContext } from './transport.ts';
import { boundedText, integer, object, requestId, uuid } from "./primitives.ts";
import type { AliyunCredentials } from "./primitives.ts";

const HOST='green-cip.cn-shanghai.aliyuncs.com';
function ok(raw:unknown):Record<string,unknown> {
  const body=object(raw);
  if(body.Code!==200)throw body.Code===403?new AiError('RATE_LIMITED'):body.Code===408?new AiError('SERVICE_PERMISSION_REQUIRED'):body.Code===405?new AiError('TIMEOUT'):httpError(typeof body.Code==='number'?body.Code:400,body.Code);
  return body;
}
function secret(raw:unknown,max=4096):string {
  const value=boundedText(raw,max); if(!/^[\x21-\x7e]+$/.test(value))throw new AiError('OUTPUT_INVALID'); return value;
}
function signGreen(action:string,body:Buffer,credentials:AliyunCredentials,context:AdapterContext) {
  const signed=signAcs3({host:HOST,action,version:'2022-03-02',query:{},body,contentType:'application/x-www-form-urlencoded',now:context.now(),nonce:context.nonce(),...credentials});
  return signed;
}
/** Local image -> provider-issued temporary OSS space -> one synchronous IP-risk check. No public hosting or retries. */
export async function reviewImageWithAliyun(bytes:Buffer,rawCandidate:CandidateImageIdentity,planResultId:string,credentials:AliyunCredentials,signal:AbortSignal,context:AdapterContext):Promise<AdapterResult<ImageIpReviewOutput>> {
  const candidate=validateCandidateImageIdentity(rawCandidate); uuid(planResultId);
  if(!bytes.length||bytes.length>20*1024*1024||createHash('sha256').update(bytes).digest('hex')!==candidate.sha256)throw new AiError('IMAGE_INVALID');
  const raster=inspectRaster(bytes);
  if(!['image/png','image/jpeg'].includes(raster.mimeType)||raster.width!==candidate.width||raster.height!==candidate.height)throw new AiError('IMAGE_INVALID');
  // Reserve one moderation attempt before even uploading bytes; failed prerequisites cannot bypass local limits.
  const tokenBody=Buffer.alloc(0),signedToken=signGreen('DescribeUploadToken',tokenBody,credentials,context);
  throwIfAborted(signal);checkPaidAdapterEffect(context,{service:'aliyun-upload-token',url:signedToken.url,method:'POST',body:tokenBody}); context.beforeSend?.(bytes);
  const transport={...context,beforeSend:undefined};
  const token=object(ok(await postJson(signedToken.url,signedToken.headers,tokenBody,signal,{...transport,onMetadata:undefined})).Data);
  context.onReviewEffect?.('token','received');
  const endpoint=boundedText(token.OssInternetEndPoint,200),match=/^https:\/\/oss-(cn-(?:shanghai|hangzhou|beijing|shenzhen|chengdu))\.aliyuncs\.com\/?$/.exec(endpoint);
  const bucket=boundedText(token.BucketName,63),prefix=boundedText(token.FileNamePrefix,250);
  if(!match||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/$/.test(prefix)||integer(token.Expiration,1,Number.MAX_SAFE_INTEGER)<=Math.floor(context.now().getTime()/1000))throw new AiError('OUTPUT_INVALID');
  const temporary={accessKeyId:secret(token.AccessKeyId),accessKeySecret:secret(token.AccessKeySecret),securityToken:secret(token.SecurityToken,16384)};
  const region=match[1],name=`${prefix}${candidate.id}.${raster.mimeType==='image/png'?'png':'jpg'}`;
  const headers=signOss4Put({bucket,objectName:name,region,now:context.now(),accessKeyId:temporary.accessKeyId,accessKeySecret:temporary.accessKeySecret,headers:{'content-type':raster.mimeType,'content-md5':createHash('md5').update(bytes).digest('base64'),'x-oss-security-token':temporary.securityToken}});
  throwIfAborted(signal);
  const uploadUrl=`https://${bucket}.oss-${region}.aliyuncs.com/${name}`;
  checkPaidAdapterEffect(context,{service:'aliyun-oss-put',url:uploadUrl,method:'PUT',body:bytes});
  let uploaded:Response;context.onReviewEffect?.('upload','permit');
  try { uploaded=await abortable(context.fetch(uploadUrl,{method:'PUT',headers,body:new Uint8Array(bytes),redirect:'error',signal}),signal); }
  catch {throwIfAborted(signal);throw new AiError('NETWORK_ERROR');}
  // OSS PutObject has no useful response body. Never log an error body or temporary credentials.
  void uploaded.body?.cancel().catch(()=>{}); throwIfAborted(signal);
  if(uploaded.status!==200)throw httpError(uploaded.status);context.onReviewEffect?.('upload','received');
  const body=Buffer.from(new URLSearchParams({Service:'aigcViolationDetection',ServiceParameters:JSON.stringify({ossBucketName:bucket,ossObjectName:name,ossRegionId:region,dataId:candidate.id})}).toString());
  const signedModeration=signGreen('ImageModeration',body,credentials,context);
  checkPaidAdapterEffect(context,{service:'aliyun-image-risk',url:signedModeration.url,method:'POST',body});
  context.onReviewEffect?.('moderation','permit');
  const reply=ok(await postJson(signedModeration.url,signedModeration.headers,body,signal,context.onReviewEffect?aliyunFinalContext(transport,{action:'ImageModeration',region:'cn-shanghai',host:HOST,apiVersion:'2022-03-02',candidateSha256:candidate.sha256},'aigcViolationDetection',[credentials,temporary]):transport));
  return parseAliyunRiskReply(reply,candidate,planResultId,credentials,context,[temporary]);
}
/** Parse original final response locally; never enters DescribeUploadToken or OSS transport. */
export function parseAliyunRiskReply(raw:unknown,candidate:CandidateImageIdentity,planResultId:string,credentials:AliyunCredentials,context:AdapterContext,otherSecrets:AliyunCredentials[]=[]):AdapterResult<ImageIpReviewOutput>{
  const reply=ok(raw);
  const meta={requestId:requestId(reply.RequestId),usage:{...emptyUsage(),processedImages:1},usageKnown:true};
  if(containsSecret(meta,credentials)||otherSecrets.some(secret=>containsSecret(meta,secret)))meta.requestId=null;
  context.onMetadata?.(meta);
  try {
    const data=object(reply.Data); if(data.DataId!==candidate.id || !Array.isArray(data.Result))throw new AiError('OUTPUT_INVALID');
    const labels=data.Result.map(raw=>{const item=object(raw);return {label:item.Label,confidence:item.Confidence??null,description:item.Description??''};});
    const output=validateImageIpReview({kind:'image-ip-review',candidate,planResultId,service:'aigcViolationDetection',riskLevel:data.RiskLevel,labels,verdict:imageIpVerdict(data.RiskLevel as ImageIpReviewOutput['riskLevel'],labels as ImageIpReviewOutput['labels'])});
    if(containsSecret(output,credentials)||otherSecrets.some(secret=>containsSecret(output,secret)))throw new AiError('OUTPUT_INVALID');
    return {...meta,output};
  }catch {throw new AiError('OUTPUT_INVALID');}
}
