import type { ImageGenerationQuality, ImageGenerationSize, OpenAiImageModel } from '../../shared/image-generation-contracts.ts';
import { OPENAI_IMAGE_MODELS } from '../../shared/image-generation-contracts.ts';
import { AiError, abortable, throwIfAborted } from '../ai/errors.ts';
import { inspectRaster } from '../image-format.ts';
import { imageRequestNotSent, invalidImageOutput } from './errors.ts';

const API_ROOT = 'https://api.openai.com/v1';
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_PNG_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = 20 * 1024 * 1024;

export interface OpenAiImageRequest {
  apiKey: string; model: OpenAiImageModel; prompt: string;
  size: ImageGenerationSize; quality: ImageGenerationQuality; background: 'auto' | 'opaque' | 'transparent';
  references: { mimeType: 'image/png' | 'image/jpeg'; bytes: Buffer }[];
}
export interface OpenAiImageResult { bytes: Buffer; requestId: string | null; width: number; height: number }

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validateConnection(apiKey: string, model: OpenAiImageModel): void {
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(apiKey) || !OPENAI_IMAGE_MODELS.includes(model)) throw new AiError('INVALID_INPUT');
}
function requestBody(input: OpenAiImageRequest): string {
  if (!object(input)) throw new AiError('INVALID_INPUT');
  validateConnection(input.apiKey, input.model);
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000
    || !['auto', '1024x1024', '1536x1024', '1024x1536'].includes(input.size)
    || !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.quality)
    || !['auto', 'opaque', 'transparent'].includes(input.background)
    || !Array.isArray(input.references) || input.references.length > 16) throw new AiError('INVALID_INPUT');
  const base = { model: input.model, prompt: input.prompt, n: 1, output_format: 'png', size: input.size, quality: input.quality, background: input.background };
  // Estimate before allocating data URLs: JSON overhead is small and bounded; base64 dominates the request.
  let requestBytes = Buffer.byteLength(JSON.stringify(base)) + 12;
  for (const reference of input.references) {
    if (!object(reference) || !['image/png', 'image/jpeg'].includes(reference.mimeType) || !Buffer.isBuffer(reference.bytes)
      || reference.bytes.length < 1 || reference.bytes.length > MAX_REFERENCE_BYTES) throw new AiError('IMAGE_INVALID');
    try { if (inspectRaster(reference.bytes).mimeType !== reference.mimeType) throw new AiError('IMAGE_INVALID'); }
    catch { throw new AiError('IMAGE_INVALID'); }
    const dataUrlLength = `data:${reference.mimeType};base64,`.length + 4 * Math.ceil(reference.bytes.length / 3);
    requestBytes += dataUrlLength + 17;
    if (dataUrlLength > MAX_DATA_URL_LENGTH || requestBytes > MAX_JSON_BYTES) throw new AiError('IMAGE_INVALID');
  }
  const body = JSON.stringify(input.references.length ? { ...base, images: input.references.map(reference => ({ image_url: `data:${reference.mimeType};base64,${reference.bytes.toString('base64')}` })) } : base);
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw new AiError('IMAGE_INVALID');
  return body;
}

export async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if ((length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) || !response.body) {
    void response.body?.cancel().catch(() => {}); throw invalidImageOutput('response');
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
      if (size > maxBytes) throw invalidImageOutput('response');
      chunks.push(value);
    }
    throwIfAborted(signal);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    cancel(); throwIfAborted(signal); throw invalidImageOutput('response');
  } finally { reader.releaseLock(); }
}

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
export function safeRequestId(raw: string | null, input: Pick<OpenAiImageRequest, 'apiKey' | 'prompt'>): string | null {
  if (raw === null || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw) || raw.includes(input.apiKey) || raw.includes(input.prompt)) return null;
  return raw;
}
export function parseImage(body: unknown, requirePng = true): Omit<OpenAiImageResult, 'requestId'> {
  if (!object(body) || !Array.isArray(body.data) || body.data.length !== 1 || !object(body.data[0])) throw invalidImageOutput('shape');
  const item = body.data[0], encoded = item.b64_json;
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(MAX_PNG_BYTES / 3) || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || (item.url !== undefined && item.url !== null)) throw invalidImageOutput('encoding');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_PNG_BYTES || bytes.toString('base64') !== encoded) throw invalidImageOutput('encoding');
  try {
    const info = inspectRaster(bytes);
    if (requirePng && info.mimeType !== 'image/png') throw invalidImageOutput('raster');
    return { bytes, width: info.width, height: info.height };
  } catch { throw invalidImageOutput('raster'); }
}

export class OpenAiImageAdapter {
  private readonly fetch: typeof fetch;
  private readonly maxResponseBytes: number;
  constructor(deps: { fetch?: typeof fetch; maxResponseBytes?: number } = {}) {
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.maxResponseBytes = deps.maxResponseBytes ?? MAX_JSON_BYTES;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > MAX_JSON_BYTES) throw new AiError('INVALID_INPUT');
  }
  /** Exactly one official request; ambiguous network failures and paid POSTs are never retried. */
  private async request(path: string, apiKey: string, signal: AbortSignal, body?: string): Promise<{ body: unknown; requestId: string | null }> {
    try{throwIfAborted(signal);}catch(error){throw imageRequestNotSent(error);}
    let response: Response;
    try {
      let received: Response | undefined;
      const cancelReceived = () => { void received?.body?.cancel().catch(() => {}); };
      const pending = this.fetch(`${API_ROOT}${path}`, {
        method: body === undefined ? 'GET' : 'POST', body, signal, redirect: 'error',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      }).then(result => {
        // A transport may ignore abort and resolve after our cancellation promise has settled.
        received = result;
        if (signal.aborted) cancelReceived();
        return result;
      });
      response = await abortable(pending, signal, cancelReceived);
    } catch { throwIfAborted(signal); throw new AiError('NETWORK_ERROR'); }
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); throwIfAborted(signal); }
    if (!response.ok) {
      let errorBody: unknown;
      try { errorBody = await readJson(response, this.maxResponseBytes, signal); } catch { throwIfAborted(signal); }
      throw providerError(response.status, errorBody);
    }
    return { body: await readJson(response, this.maxResponseBytes, signal), requestId: response.headers.get('x-request-id') };
  }
  async generate(input: OpenAiImageRequest, signal: AbortSignal): Promise<OpenAiImageResult> {
    let body:string;
    try{throwIfAborted(signal);body=requestBody(input);}catch(error){throw imageRequestNotSent(error);}
    const result = await this.request(input.references.length ? '/images/edits' : '/images/generations', input.apiKey, signal, body);
    throwIfAborted(signal);
    return { ...parseImage(result.body), requestId: safeRequestId(result.requestId, input) };
  }
  /** This metadata lookup does not prove image-generation permission, quota or output quality. */
  async checkModel(apiKey: string, model: OpenAiImageModel, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal); validateConnection(apiKey, model);
    const result = await this.request(`/models/${model}`, apiKey, signal);
    throwIfAborted(signal);
    if (!object(result.body) || result.body.id !== model || result.body.object !== 'model') throw new AiError('OUTPUT_INVALID');
  }
}
