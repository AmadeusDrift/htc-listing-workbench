import { UserFacingError } from '../../shared/errors.ts';
import type { AiErrorCode } from '../../shared/ai-contracts.ts';

export const AI_ERROR_CODES: readonly AiErrorCode[] = ['INVALID_INPUT', 'INVALID_CONFIG', 'NOT_CONFIGURED', 'DISABLED', 'CONFIG_CHANGED', 'SOURCE_CHANGED', 'IMAGE_INVALID', 'HOSTED_IMAGE_REQUIRED', 'ENCRYPTION_UNAVAILABLE', 'AUTH_FAILED', 'MODEL_REGION_RESTRICTED', 'ROUTING_FORBIDDEN', 'SERVICE_PERMISSION_REQUIRED', 'QUOTA_EXCEEDED', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_ERROR', 'OUTPUT_INVALID', 'BUSY', 'CANCELLED', 'INTERRUPTED', 'SERVICE_CLOSED'];
const MESSAGES: Record<AiErrorCode, string> = {
  INVALID_INPUT: 'AI 请求参数无效', INVALID_CONFIG: 'AI 配置或记录格式无效，请检查所填字段或配置文件', NOT_CONFIGURED: 'AI 凭据不可用，请在设置中重新填写或导入配置', DISABLED: 'AI 接口尚未启用',
  CONFIG_CHANGED: 'AI 配置已变更，请重新发起请求', SOURCE_CHANGED: '商品或来源图片已变化，请重新加载后再试', IMAGE_INVALID: '图片格式、尺寸或大小不符合接口要求',
  HOSTED_IMAGE_REQUIRED: '请先为当前图片准备并验证可用的托管记录', ENCRYPTION_UNAVAILABLE: '系统安全加密不可用，无法保存 AI 配置', AUTH_FAILED: 'AI 接口鉴权失败，请检查配置',
  MODEL_REGION_RESTRICTED: '所选模型在当前请求地区不可用；请核对模型与提供商可用范围，此错误不是密钥无效',
  ROUTING_FORBIDDEN: 'OpenRouter 拒绝此请求；请核对提供商权限、路由或内容限制，此错误不等于密钥无效',
  SERVICE_PERMISSION_REQUIRED: '当前凭据没有此功能的服务权限，请检查对应服务是否开通及账号授权；无需因此重新填写已保存的密钥',
  QUOTA_EXCEEDED: 'AI 接口额度不足', RATE_LIMITED: 'AI 接口请求频率受限，请稍后重试', TIMEOUT: 'AI 请求超时，请先核对调用记录再决定是否重试', NETWORK_ERROR: 'AI 网络请求未完成，请先核对调用记录',
  PROVIDER_ERROR: 'AI 服务未完成请求，请核对服务状态和调用记录', OUTPUT_INVALID: 'AI 返回内容未通过校验，未保存为商品资料', BUSY: 'AI 请求数量已达上限，请等待当前请求完成',
  CANCELLED: 'AI 请求已取消', INTERRUPTED: '上次 AI 请求被中断，未自动重发', SERVICE_CLOSED: 'AI 服务已关闭',
};
/** Only fixed messages cross the IPC boundary; upstream errors and request options never do. */
/** Fixed, diagnostic-only detail for a rejected output. The user-facing message stays the fixed one above. */
export type AiRejectionReason = 'EMPTY_PROMPT' | 'UNSUPPORTED_MEASUREMENT';
export class AiError extends UserFacingError {
  readonly code: AiErrorCode;
  rejection?: import('../../shared/rejection-presentation.ts').OutputRejection;
  callId?:string;
  requestId?:string;
  diagnosticReason?:string;
  validationPath?:string;
  validationField?:string;
  networkDiagnostic?: import('../../shared/error-evidence-contracts.ts').NetworkDiagnostic;
  responseDiagnostic?:{status:number;byteCount:number};
  abortSource?: import('../../shared/run-evidence-contracts.ts').AbortSource;
  certainty?: import('../../shared/run-evidence-contracts.ts').RequestCertainty;
  readonly reason?: AiRejectionReason;
  constructor(code: AiErrorCode, reason?: AiRejectionReason) { super(MESSAGES[code]); this.code = code; if (reason) this.reason = reason; }
}
/** Local planning-budget guard; never creates a provider call or changes its recorded reason. */
export class ImagePlanningLimitError extends AiError {
  constructor(callId?:string){
    super('OUTPUT_INVALID');this.diagnosticReason='IMAGE_PLAN_ATTEMPTS_EXHAUSTED';this.callId=callId;
    this.message='图片规划已达到 3 次尝试，已保留原图和请求记录。请先核对失败规划；已通过图片保留。';
  }
}
export function abortError(reason: unknown): AiError {
  if (reason instanceof AiError) { if(!reason.abortSource&&reason.code==='CANCELLED')reason.abortSource='USER';if(!reason.abortSource&&reason.code==='TIMEOUT')reason.abortSource='TOTAL_TIMEOUT';return reason; }
  if (reason instanceof DOMException && reason.name === 'TimeoutError') return Object.assign(new AiError('TIMEOUT'), { abortSource: 'TOTAL_TIMEOUT' as const });
  return Object.assign(new AiError('CANCELLED'), { abortSource: 'USER' as const });
}
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void = () => {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return; settled = true; cleanup();
      try { onAbort(); } catch { /* Cancellation must settle even when transport cleanup fails. */ }
      reject(abortError(signal.reason));
    };
    promise.then(value => { if (!settled) { settled = true; cleanup(); resolve(value); } }, error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
export function safeError(error: unknown, signal?: AbortSignal): AiError {
  if (signal?.aborted) return abortError(signal.reason);
  return error instanceof AiError ? error : new AiError('PROVIDER_ERROR');
}
export function httpError(status: number, providerCode?: unknown): AiError {
  const code = typeof providerCode === 'string' ? providerCode : '';
  if (code === 'NoPermission' && (status === 400 || status === 403)) return new AiError('SERVICE_PERMISSION_REQUIRED');
  if (code === 'unsupportedImageFormat' && (status === 400 || status === 415)) return new AiError('IMAGE_INVALID');
  if (status === 401 || status === 403 || /^(InvalidAccessKeyId|SignatureDoesNotMatch|InvalidSecurityToken|Forbidden|Unauthorized|AuthenticationError)(\.|$)/i.test(code)) return new AiError('AUTH_FAILED');
  if (status === 402 || /^(QuotaExceeded|InsufficientBalance|Arrearage|InsufficientQuota|FreeQuotaExhausted)/i.test(code)) return new AiError('QUOTA_EXCEEDED');
  if (status === 429 || /^(Throttling|RateLimit)/i.test(code)) return new AiError('RATE_LIMITED');
  return new AiError('PROVIDER_ERROR');
}
/** Requires independently verified complete receipt bytes at the caller. A
 * rejection does not establish zero cost or permission for another request. */
export function receivedDeepSeekRejection(status:number,body:unknown,errorCode:string):boolean {
  if(![401,402,403,429].includes(status)||body===undefined||body==='[omitted: credential echo]'||typeof body==='string'&&!body.trim())return false;
  return httpError(status,(body as any)?.error?.code).code===errorCode;
}

/** Diagnostic-only allowlist: no original cause/message/URL is retained. */
export function networkFailure(error:unknown,stage:import('../../shared/error-evidence-contracts.ts').NetworkDiagnostic['stage'],httpStatus?:number,receivedBytes=0):AiError {
  const codes:Record<string,import('../../shared/error-evidence-contracts.ts').NetworkDiagnostic['cause']>={ENOTFOUND:'DNS',EAI_AGAIN:'DNS',ECONNRESET:'CONNECTION_RESET',ECONNREFUSED:'CONNECTION_REFUSED',ETIMEDOUT:'TIMEOUT',UND_ERR_CONNECT_TIMEOUT:'TIMEOUT',CERT_HAS_EXPIRED:'TLS',DEPTH_ZERO_SELF_SIGNED_CERT:'TLS',UNABLE_TO_VERIFY_LEAF_SIGNATURE:'TLS',ERR_TLS_CERT_ALTNAME_INVALID:'TLS',ERR_PROXY_CONNECTION_FAILED:'PROXY',ERR_TUNNEL_CONNECTION_FAILED:'PROXY'};
  let cause:import('../../shared/error-evidence-contracts.ts').NetworkDiagnostic['cause']='UNKNOWN';
  let localArgument=false;
  try{let current=error;for(let i=0;i<3&&current&&typeof current==='object';i++){const code=Reflect.get(current,'code');if(code==='ERR_INVALID_ARGUMENT'||code==='ERR_INVALID_ARG_TYPE'||code==='ERR_INVALID_ARG_VALUE'||Reflect.get(current,'message')==='net::ERR_INVALID_ARGUMENT'){localArgument=true;break;}if(typeof code==='string'&&Object.hasOwn(codes,code)){cause=codes[code];break;}current=Reflect.get(current,'cause');}}catch{/* Untrusted accessors cannot replace the failure. */}
  return Object.assign(new AiError('NETWORK_ERROR'),{...(localArgument?{diagnosticReason:'TRANSPORT_INVALID_ARGUMENT'}:{}),networkDiagnostic:{cause,stage,...(Number.isInteger(httpStatus)&&httpStatus!>=100&&httpStatus!<=599?{httpStatus}:{}),receivedBytes:Number.isSafeInteger(receivedBytes)&&receivedBytes>=0?receivedBytes:0}});
}
