import type { AiUsage } from '../../shared/ai-contracts.ts';
import { AiError, abortable, httpError, throwIfAborted } from './errors.ts';
import type { ReasoningEffort,AiPurposeSnapshot } from '../../shared/ai-purpose-contracts.ts';

export interface ProviderMetadata { requestId: string | null; usage: AiUsage; usageKnown: boolean }
export interface AdapterContext {
  gateway?:'openrouter'|'deepseek';
  effectiveEffort?:ReasoningEffort;
  purposeSnapshot?:AiPurposeSnapshot;
  onProviderReceipt?:(receipt:ProviderReceiptCapture)=>void|Promise<void>;
  captureRawResponse?:(status:number,text:string)=>Promise<void>;
  thinking?: boolean;
  imagePlanRetry?:boolean;
  /** Adapter-owned safe capture, enabled only for source observation and image planning responses. */
  onInvalidResponseText?: (text:string)=>void;
  fetch: typeof fetch; now: () => Date; nonce: () => string; maxResponseBytes: number;
  onMetadata?: (metadata: ProviderMetadata) => void;
  /** Secret-checked JSON or safely captured raw provider text; still unapproved and never eligible for adoption. */
  onUntrustedOutput?: (output: unknown, stage?: import('./output-diagnostics.ts').AiOutputRejectionStage) => void;
  /** Synchronous reservation at the last boundary before one paid POST. */
  beforeSend?: (body: string | Buffer) => void;
}
export interface ProviderReceiptCapture{gateway:'openrouter'|'deepseek';endpoint:string;model:string;status:number;requestId:string|null;receivedAt:string;body:unknown;costUsd:number|null}
export const emptyUsage = (): AiUsage => ({ promptTokens: 0, completionTokens: 0, processedImages: 0 });
export async function readBounded(response: Response, max: number, signal: AbortSignal, onInvalidResponseText?: (text:string)=>void, captureRawResponse?:(status:number,text:string)=>Promise<void>): Promise<unknown> {
  let size=0;
  const invalid=(reason:string):AiError=>{const error=new AiError('OUTPUT_INVALID');error.diagnosticReason=reason;error.responseDiagnostic={status:response.status,byteCount:size};return error;};
  const length = response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max)){
    void response.body?.cancel().catch(()=>{});throw invalid(/^\d+$/.test(length)?'RESPONSE_SIZE_LIMIT':'RESPONSE_LENGTH_INVALID');
  }
  if(!response.body)throw invalid('RESPONSE_BODY_MISSING');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  try {
    for (;;) {
      throwIfAborted(signal);
      const { value, done } = await abortable(reader.read(), signal, cancel);
      if (done) break;
      size += value.byteLength;
      if (size > max) throw invalid('RESPONSE_SIZE_LIMIT');
      chunks.push(value);
    }
    throwIfAborted(signal);
    if (!size) throw invalid('RESPONSE_BODY_EMPTY');
    let text:string;try{text=new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));}catch{throw invalid('RESPONSE_UTF8_INVALID');}
    await captureRawResponse?.(response.status,text);
    try{return JSON.parse(text);}catch{
      try{onInvalidResponseText?.(text);}catch{/* Adapter capture must not replace the original parse failure. */}
      throw invalid('RESPONSE_ENVELOPE_JSON_INVALID');
    }
  } catch (error) {
    cancel(); throwIfAborted(signal);
    if (error instanceof AiError) throw error;
    throw invalid('RESPONSE_READ_FAILED');
  } finally { reader.releaseLock(); }
}
/** One paid POST only. A redirect or ambiguous network failure is never retried automatically. */
export async function postJson(url: string, headers: Record<string, string>, body: string | Buffer, signal: AbortSignal, context: AdapterContext, onErrorResponse?: (body: unknown) => void): Promise<unknown> {
  throwIfAborted(signal);
  context.beforeSend?.(body);
  let response: Response;
  try {
    const request=context.fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : new Uint8Array(body), redirect: 'error', signal });
    response = await (context.captureRawResponse?request:abortable(request,signal));
  } catch { throwIfAborted(signal); throw new AiError('NETWORK_ERROR'); }
  if(!context.captureRawResponse)throwIfAborted(signal);
  const captureSignal=context.captureRawResponse?AbortSignal.timeout(30_000):signal;
  if (!response.ok) {
    let code: unknown;
    try {
      const data = await readBounded(response, context.maxResponseBytes, captureSignal,undefined,context.captureRawResponse);
      if (data && typeof data === 'object') code = (data as Record<string, unknown>).Code;
      onErrorResponse?.(data);
    } catch { throwIfAborted(signal); }
    throw httpError(response.status, code);
  }
  const value=await readBounded(response, context.maxResponseBytes, captureSignal, context.onInvalidResponseText,context.captureRawResponse);
  throwIfAborted(signal);return value;
}
