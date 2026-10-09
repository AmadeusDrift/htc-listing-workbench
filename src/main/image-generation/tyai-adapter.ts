import type { TyaiImageModel } from '../../shared/image-generation-contracts.ts';
import { AiError, abortable, throwIfAborted } from '../ai/errors.ts';
import { inspectRaster } from '../image-format.ts';
import type { OpenAiImageRequest, OpenAiImageResult } from './adapter.ts';
import { parseImage, providerError, readJson, safeRequestId } from './adapter.ts';
import { imageApiKey, imageModel, imageQuality, validImageSize } from './vault.ts';
import { createRelayImageDownloader } from './download.ts';
import type { RelayDownloadDependencies } from './download.ts';
import { relayQuality } from '../../shared/image-models.ts';
import { imageRequestNotSent, unsupportedRelayJpeg, invalidImageOutput } from './errors.ts';

export interface TyaiImageRequest extends Omit<OpenAiImageRequest, 'model'> { model: TyaiImageModel }

function requestBody(input: TyaiImageRequest): string | FormData {
  try { imageApiKey(input.apiKey); imageModel(input.model, 'tyai'); imageQuality(input.quality); }
  catch { throw new AiError('INVALID_INPUT'); }
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000 || input.prompt.includes('\0')
    || !validImageSize(input.size, 'tyai') || !Array.isArray(input.references) || input.references.length > 16) throw new AiError('INVALID_INPUT');
  const quality = relayQuality(input.model, input.quality);
  const fields = { model: input.model, prompt: input.prompt, n: 1, size: input.size, ...(quality ? { quality } : {}) };
  if (!input.references.length) return JSON.stringify(fields);
  const form = new FormData(); let bytes = 0;
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  for (const [index, reference] of input.references.entries()) {
    try {
      if (!reference || !Buffer.isBuffer(reference.bytes) || !['image/png', 'image/jpeg'].includes(reference.mimeType)
        || reference.bytes.length < 1 || reference.bytes.length > 10 * 1024 * 1024 || inspectRaster(reference.bytes).mimeType !== reference.mimeType) throw new Error();
      bytes += reference.bytes.length;
      if (bytes > 20 * 1024 * 1024) throw new Error();
    } catch { throw new AiError('IMAGE_INVALID'); }
    form.append('image[]', new Blob([new Uint8Array(reference.bytes)], { type: reference.mimeType }), `reference-${index + 1}.${reference.mimeType === 'image/png' ? 'png' : 'jpg'}`);
  }
  return form;
}

/** A removable relay connector. No model-discovery calls and no automatic paid POST retry. */
export class TyaiImageAdapter {
  private readonly fetch: typeof fetch;
  private readonly download: (url: string, signal: AbortSignal) => Promise<Buffer>;
  constructor(deps: { fetch?: typeof fetch; downloadDependencies?: RelayDownloadDependencies } = {}) {
    this.fetch = deps.fetch ?? globalThis.fetch; this.download = createRelayImageDownloader(deps.downloadDependencies);
  }
  async generate(input: TyaiImageRequest, signal: AbortSignal): Promise<OpenAiImageResult> {
    let body:string|FormData;
    try{throwIfAborted(signal);body=requestBody(input);}catch(error){throw imageRequestNotSent(error);}
    let received: Response | undefined;
    const cancel = () => { void received?.body?.cancel().catch(() => {}); };
    let response: Response;
    try {
      response = await abortable(this.fetch(`https://tyaiapi.com/v1/images/${input.references.length ? 'edits' : 'generations'}`, {
        method: 'POST', body, signal, redirect: 'error',
        headers: { authorization: `Bearer ${input.apiKey}`, accept: 'application/json', ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}) },
      }).then(value => { received = value; if (signal.aborted) cancel(); return value; }), signal, cancel);
    } catch { throwIfAborted(signal); throw new AiError('NETWORK_ERROR'); }
    if (signal.aborted) { cancel(); throwIfAborted(signal); }
    let data: unknown;
    try { data = await readJson(response, 32 * 1024 * 1024, signal); }
    catch (error) { throwIfAborted(signal); if (response.ok) throw error; }
    if (!response.ok) throw providerError(response.status, data);
    const requestId = safeRequestId(response.headers.get('x-request-id'), input);
    if (data !== null && typeof data === 'object' && 'data' in data && Array.isArray(data.data) && data.data.length === 1) {
      const item: unknown = data.data[0];
      if (item !== null && typeof item === 'object' && 'url' in item && typeof item.url === 'string' && !('b64_json' in item)) {
        const bytes = await this.download(item.url, signal); throwIfAborted(signal);
        try { const shape = inspectRaster(bytes); if (shape.mimeType !== 'image/png') throw unsupportedRelayJpeg(); return { bytes, width: shape.width, height: shape.height, requestId }; }
        catch (error) { throw error instanceof AiError ? error : invalidImageOutput('raster'); }
      }
    }
    const parsed = parseImage(data, false);
    if (inspectRaster(parsed.bytes).mimeType !== 'image/png') throw unsupportedRelayJpeg();
    return { ...parsed, requestId };
  }
}
