import { isSchemaTransientError } from '../amazon/schema-retry.ts';
import { AiError } from '../ai/errors.ts';

/** Main-only proof: validation failed before any generation POST could be dispatched. */
export function imageRequestNotSent(error:unknown):AiError&{notSent:true}{
  if(isSchemaTransientError(error))return Object.assign(error,{notSent:true as const});
  const safe=new AiError(error instanceof AiError?error.code:'PROVIDER_ERROR');
  if(error instanceof AiError)safe.message=error.message;
  return Object.assign(safe,{notSent:true as const});
}

export function unsupportedRelayJpeg(): AiError {
  const error = new AiError('OUTPUT_INVALID');
  error.message = '中转服务返回了 JPEG；当前图片流程只接收 PNG，未保存候选图。请核对服务的输出格式。';
  return error;
}

/** Static stages only: never include response text, credentials, URLs or image bytes. */
export function invalidImageOutput(stage: 'response'|'shape'|'encoding'|'raster'|'download'|'normalize'|'preview'|'save'): AiError {
  const labels = {response:'响应读取',shape:'响应结构',encoding:'图片编码',raster:'图片格式',download:'图片下载',normalize:'图片转换',preview:'预览生成',save:'候选保存'};
  const error = new AiError('OUTPUT_INVALID');
  error.message = `生图${labels[stage]}阶段未通过校验，未保存候选图；生成结果未确认，不自动重发付费请求`;
  return error;
}

const object = (value:unknown):value is Record<string,unknown> => value!==null && typeof value==='object' && !Array.isArray(value);
export function providerError(status: number, body: unknown): AiError {
  const error = object(body) && object(body.error) ? body.error : {};
  const code = typeof error.code === 'string' ? error.code : error.type;
  const value=status===401?'AUTH_FAILED':status===403?'SERVICE_PERMISSION_REQUIRED':status===402||code==='insufficient_quota'||code==='billing_hard_limit_reached'?'QUOTA_EXCEEDED':status===429?'RATE_LIMITED':'PROVIDER_ERROR';
  // Gateway/server failures can occur after the provider generated and charged for an image.
  // Only explicit request rejections permit a new paid attempt; everything else needs reconciliation.
  const definitive=[400,401,402,403,404,405,413,415,422,429].includes(status);
  const safe=Object.assign(new AiError(value),{definitive,...(Number.isInteger(status)&&status>=400&&status<=599?{httpStatus:status}:{})});
  safe.message+=`${'httpStatus' in safe?`（HTTP ${safe.httpStatus}）`:''}；${definitive?'明确拒绝 [DEFINITIVE_FAILURE]':'结果未知 [RESULT_UNKNOWN]'}`;
  return safe;
}
