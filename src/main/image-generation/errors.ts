import { AiError } from '../ai/errors.ts';

/** Main-only proof: validation failed before any generation POST could be dispatched. */
export function imageRequestNotSent(error:unknown):AiError&{notSent:true}{
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
