import type { AiUsage } from '../../shared/ai-contracts.ts';
import { AiError, abortable, httpError, throwIfAborted } from './errors.ts';
import type { ReasoningEffort,AiPurposeSnapshot } from '../../shared/ai-purpose-contracts.ts';
import { responseCollection, transportEvidence } from './response-lifecycle.ts';
import type { TransportRunEvidence } from '../../shared/run-evidence-contracts.ts';

export interface ProviderMetadata { requestId: string | null; usage: AiUsage; usageKnown: boolean }
export interface AdapterContext {
  /** Main-only collector policy. Date.now clock, never the fixture/provider timestamp. */
  responseDeadlineAt?: number;
  responseTimeoutMs?: number;
  responseBodyTimeoutMs?: number;
  onRunEvidence?: (event: TransportRunEvidence) => void;
  deferOpenRouter?:(endpoint:string,body:Record<string,unknown>)=>Promise<{body:any}|null>;
  gateway?:'openrouter'|'deepseek';
  effectiveEffort?:ReasoningEffort;
  purposeSnapshot?:AiPurposeSnapshot;
  onProviderReceipt?:(receipt:ProviderReceiptCapture)=>void|Promise<void>;
  captureRawResponse?:(status:number,text:string)=>Promise<void>;
  /** Complete undecodable bytes are opaque receipt evidence, never domain data. */
  captureRawBytes?:(status:number,bytes:Buffer)=>Promise<void>;
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
export async function readBounded(response: Response, max: number, signal: AbortSignal, onInvalidResponseText?: (text:string)=>void, captureRawResponse?:(status:number,text:string)=>Promise<void>,captureRawBytes?:(status:number,bytes:Buffer)=>Promise<void>): Promise<unknown> {
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
    if (!size) {await captureRawResponse?.(response.status,'');throw invalid('RESPONSE_BODY_EMPTY');}
    const received=Buffer.concat(chunks);
    let text:string;try{text=new TextDecoder('utf-8', { fatal: true }).decode(received);}catch{await captureRawBytes?.(response.status,received);throw invalid('RESPONSE_UTF8_INVALID');}
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
  const collection=context.captureRawResponse?responseCollection(signal,context):undefined;
  const transportSignal=collection?.signal??signal;
  let response: Response|undefined,complete=false,dispatched=false;
  const captureRaw=context.captureRawResponse?async(status:number,text:string)=>{complete=true;transportEvidence(context,{event:'BODY_COMPLETED',httpStatus:status,receivedBytes:Buffer.byteLength(text)});await context.captureRawResponse!(status,text);}:undefined;
  const captureBytes=context.captureRawBytes?async(status:number,bytes:Buffer)=>{complete=true;transportEvidence(context,{event:'BODY_COMPLETED',httpStatus:status,receivedBytes:bytes.length});await context.captureRawBytes!(status,bytes);}:undefined;
  try {
  context.beforeSend?.(body);
  dispatched=true;
  transportEvidence(context,{event:'DISPATCH_ATTEMPTED',certainty:'SENT_UNKNOWN'});
  try {
    const request=context.fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : new Uint8Array(body), redirect: 'error', signal:transportSignal });
    response = await abortable(request,transportSignal);
  } catch { throwIfAborted(transportSignal); throw new AiError('NETWORK_ERROR'); }
  collection?.headers();transportEvidence(context,{event:'HEADERS_RECEIVED',httpStatus:response.status,certainty:'SENT_UNKNOWN'});
  if(!context.captureRawResponse)throwIfAborted(signal);
  const captureSignal=transportSignal;
  if (!response.ok) {
    let code: unknown;
    try {
      const data = await readBounded(response, context.maxResponseBytes, captureSignal,undefined,captureRaw,captureBytes);
      if (data && typeof data === 'object') code = (data as Record<string, unknown>).Code;
      onErrorResponse?.(data);
    } catch(error) { if(collection)throw error;throwIfAborted(signal); }
    throw httpError(response.status, code);
  }
  const value=await readBounded(response, context.maxResponseBytes, captureSignal, context.onInvalidResponseText,captureRaw,captureBytes);
  throwIfAborted(signal);return value;
  } catch(error) {
    const failure=error instanceof AiError?error:new AiError('NETWORK_ERROR');
    failure.certainty??=!dispatched?'NOT_SENT':complete&&failure.code==='OUTPUT_INVALID'&&failure.diagnosticReason!=='RESPONSE_SECRET_ECHO'?'RECEIVED_INVALID':'SENT_UNKNOWN';
    transportEvidence(context,{event:'STAGE_BLOCKED',certainty:failure.certainty,abortSource:failure.abortSource??'NONE',errorCode:failure.code,...(response?{httpStatus:response.status}:{}),receivedBytes:failure.responseDiagnostic?.byteCount??0});
    throw error;
  } finally { collection?.close(); }
}
