import type { AiUsage } from '../../shared/ai-contracts.ts';
import { AiError, abortable, httpError, throwIfAborted } from './errors.ts';

export interface ProviderMetadata { requestId: string | null; usage: AiUsage; usageKnown: boolean }
export interface AdapterContext {
  thinking?: boolean;
  fetch: typeof fetch; now: () => Date; nonce: () => string; maxResponseBytes: number;
  onMetadata?: (metadata: ProviderMetadata) => void;
  /** Secret-checked JSON only; still unapproved and never eligible for adoption. */
  onUntrustedOutput?: (output: unknown, stage?: import('./output-diagnostics.ts').AiOutputRejectionStage) => void;
  /** Synchronous reservation at the last boundary before one paid POST. */
  beforeSend?: (body: string | Buffer) => void;
}
export const emptyUsage = (): AiUsage => ({ promptTokens: 0, completionTokens: 0, processedImages: 0 });
async function readBounded(response: Response, max: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if ((length !== null && (!/^\d+$/.test(length) || Number(length) > max)) || !response.body) {
    void response.body?.cancel().catch(() => {}); throw new AiError('OUTPUT_INVALID');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let size = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { value, done } = await abortable(reader.read(), signal, cancel);
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new AiError('OUTPUT_INVALID');
      chunks.push(value);
    }
    throwIfAborted(signal);
    if (!size) throw new AiError('OUTPUT_INVALID');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    cancel(); throwIfAborted(signal);
    if (error instanceof AiError) throw error;
    throw new AiError('OUTPUT_INVALID');
  } finally { reader.releaseLock(); }
}
/** One paid POST only. A redirect or ambiguous network failure is never retried automatically. */
export async function postJson(url: string, headers: Record<string, string>, body: string | Buffer, signal: AbortSignal, context: AdapterContext, onErrorResponse?: (body: unknown) => void): Promise<unknown> {
  throwIfAborted(signal);
  context.beforeSend?.(body);
  let response: Response;
  try {
    response = await abortable(context.fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : new Uint8Array(body), redirect: 'error', signal }), signal);
  } catch { throwIfAborted(signal); throw new AiError('NETWORK_ERROR'); }
  throwIfAborted(signal);
  if (!response.ok) {
    let code: unknown;
    try {
      const data = await readBounded(response, context.maxResponseBytes, signal);
      if (data && typeof data === 'object') code = (data as Record<string, unknown>).Code;
      onErrorResponse?.(data);
    } catch { throwIfAborted(signal); }
    throw httpError(response.status, code);
  }
  return readBounded(response, context.maxResponseBytes, signal);
}
