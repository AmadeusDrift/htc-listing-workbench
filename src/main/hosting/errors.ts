import { UserFacingError } from '../../shared/errors.ts';
import type { HostedAsset, HostingStage, HostingDelivery, HostingErrorCode } from '../../shared/hosting-contracts.ts';

const MESSAGES: Record<HostingErrorCode, string> = {
  PROXY_PASSIVE_UNSUPPORTED: '代理转发需要 FTP 服务器支持 EPSV，未回退到其他数据主机',
  PROXY_FAILED: 'SOCKS5 代理转发失败（未改走直连）', PROXY_AUTH_REQUIRED: '本地 SOCKS5 代理不接受免认证连接', TLS_FAILED: 'FTP 证书或 TLS 握手失败', DNS_FAILED: 'FTP 主机解析失败',
  INVALID_CONFIG: 'FTP 配置格式无效，请检查配置文件', INVALID_INPUT: '图片托管参数无效', PROFILE_DISABLED: 'FTP 配置尚未启用',
  PROFILE_CHANGED: 'FTP 配置已变更，请重新创建任务', CREDENTIAL_NOT_FOUND: 'FTP 凭据不可用，请重新导入配置',
  ENCRYPTION_UNAVAILABLE: '系统安全加密不可用，无法保存 FTP 配置', AUTH_FAILED: 'FTP 登录失败，请检查账号配置',
  CONNECT_TIMEOUT: 'FTP 连接或传输超时', CONNECTION_LIMIT: 'FTP 连接数量受限，请稍后重试',
  REMOTE_DIRECTORY_FAILED: 'FTP 图片目录无法创建', LOCAL_FILE_MISSING: '本地图片不存在或无法读取',
  LOCAL_FILE_CHANGED: '本地图片内容已变化，请重新导入并确认', ASSET_NOT_CONFIRMED: '图片用途或 SKU 关联尚未确认',
  UPLOAD_FAILED: 'FTP 图片上传失败', REMOTE_SIZE_UNAVAILABLE: 'FTP 图片大小无法核验', SIZE_MISMATCH: 'FTP 图片大小与本地不一致',
  PUBLIC_URL_NOT_FOUND: '公网图片暂未找到', PUBLIC_URL_TIMEOUT: '公网图片验证超时', PUBLIC_URL_UNSAFE: '公网图片地址不符合安全要求',
  PUBLIC_URL_CONTENT_MISMATCH: '公网图片内容或格式与本地不一致', PUBLIC_URL_UNAVAILABLE: '公网图片暂时无法访问',
  CANCELLED: '图片托管已取消', SERVICE_CLOSED: '图片托管服务已关闭',
};
export class HostingError extends UserFacingError {
  readonly code: HostingErrorCode;
  readonly stage?: HostingStage; readonly delivery?: HostingDelivery;
  constructor(code: HostingErrorCode, stage?: HostingStage, delivery?: HostingDelivery) { super(MESSAGES[code]); this.code = code; this.stage = stage; this.delivery = delivery; }
}
/** Never include server error messages, file paths or request options in a persisted error. */
export function classifyHostingError(error: unknown): HostingError {
  if (error instanceof HostingError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return new HostingError('DNS_FAILED');
  if (/CERT|TLS|SSL/.test(code)) return new HostingError('TLS_FAILED');
  if (['530', '532', '331'].includes(code)) return new HostingError('AUTH_FAILED');
  if (code === '421') return new HostingError('CONNECTION_LIMIT');
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) return new HostingError('CONNECT_TIMEOUT');
  // basic-ftp 6 emits these local socket timeout messages without a Node error code.
  if (error instanceof Error && /^Timeout \((control|data) socket\)$/.test(error.message)) return new HostingError('CONNECT_TIMEOUT');
  return new HostingError('UPLOAD_FAILED');
}
export function isTransient(error: HostingError): boolean {
  return ['CONNECT_TIMEOUT', 'CONNECTION_LIMIT', 'UPLOAD_FAILED', 'REMOTE_SIZE_UNAVAILABLE', 'SIZE_MISMATCH', 'PUBLIC_URL_NOT_FOUND', 'PUBLIC_URL_TIMEOUT', 'PUBLIC_URL_UNAVAILABLE'].includes(error.code);
}
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof HostingError ? signal.reason : new HostingError('CANCELLED');
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void = () => {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return; settled = true; cleanup();
      try { onAbort(); } catch { /* Cancellation must still settle if closing a transport fails. */ }
      reject(signal.reason instanceof HostingError ? signal.reason : new HostingError('CANCELLED'));
    };
    // A supplied operation may already have started. Observe it even when cancellation wins immediately.
    promise.then(value => { if (!settled) { settled = true; cleanup(); resolve(value); } }, error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try { await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal, () => clearTimeout(timer)); }
  finally { clearTimeout(timer!); }
}

/** Safe projection only: never persist raw FTP messages, paths or credentials. */
export function hostingFailureMessage(record: Pick<HostedAsset, 'errorCode' | 'attempts'> & Partial<Pick<HostedAsset, 'history'>>, slot?: number): string {
  const last = record.history?.at(-1), stages: Record<HostingStage, string> = { connect: '连接/登录', directory: '远程目录', size: '查大小', upload: '上传', 'public-get': '外链验证' };
  const delivery = last?.delivery === 'not-sent' ? '本次尚未发送图片' : last?.delivery === 'confirmed' ? '远端大小已确认，外链待核验' : '远端结果未知，下次先核对原路径';
  const code = record.errorCode && Object.hasOwn(MESSAGES, record.errorCode) ? record.errorCode : 'UPLOAD_FAILED';
  return `图片${slot ? `第${slot}张` : ''}托管失败：${MESSAGES[code]} [${code}]；阶段：${last?.stage ? stages[last.stage] : '历史记录未细分'}；已尝试${record.attempts ?? 0}次；${delivery}。保留原图与托管检查点`;
}
