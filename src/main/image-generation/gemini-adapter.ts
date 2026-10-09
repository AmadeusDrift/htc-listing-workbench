import type { TyaiImageRequest } from './tyai-adapter.ts';
import type { OpenAiImageResult } from './adapter.ts';
import { parseImage, safeRequestId } from './adapter.ts';
import { imageApiKey, imageModel, validImageSize } from './vault.ts';
import { geminiImageConfig, isGeminiImageModel } from '../../shared/image-models.ts';
import { AiError, throwIfAborted } from '../ai/errors.ts';
import { inspectRaster } from '../image-format.ts';
import { relayJson } from './relay-request.ts';
import { imageRequestNotSent, invalidImageOutput } from './errors.ts';

const object = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw);
export class GeminiRelayAdapter {
  private fetcher: typeof fetch; private normalize?: (bytes: Buffer) => Buffer;
  constructor(deps: { fetch?: typeof fetch; normalizeImage?: (bytes: Buffer) => Buffer } = {}) { this.fetcher = deps.fetch ?? globalThis.fetch; this.normalize = deps.normalizeImage; }
  async generate(input: TyaiImageRequest, signal: AbortSignal): Promise<OpenAiImageResult> {
    let body:string;
    try{
    throwIfAborted(signal);
    try { imageApiKey(input.apiKey); imageModel(input.model, 'tyai'); }
    catch { throw new AiError('INVALID_INPUT'); }
    if (!isGeminiImageModel(input.model) || !validImageSize(input.size, 'tyai', input.model) || typeof input.prompt !== 'string' || !input.prompt.trim()
      || input.prompt.length > 32000 || input.prompt.includes('\0') || !Array.isArray(input.references) || input.references.length > 14) throw new AiError('INVALID_INPUT');
    let referenceBytes = 0;
    for (const reference of input.references) {
      try {
        if (!Buffer.isBuffer(reference?.bytes) || !['image/png', 'image/jpeg'].includes(reference.mimeType) || reference.bytes.length > 10 * 1024 * 1024
          || inspectRaster(reference.bytes).mimeType !== reference.mimeType) throw new Error();
        referenceBytes += reference.bytes.length;
      } catch { throw new AiError('IMAGE_INVALID'); }
    }
    if (referenceBytes > 20 * 1024 * 1024) throw new AiError('IMAGE_INVALID');
    const imageConfig = geminiImageConfig(input.size);
    body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: input.prompt }, ...input.references.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.bytes.toString('base64') } }))] }],
      generationConfig: { candidateCount: 1, responseModalities: ['TEXT', 'IMAGE'], ...(imageConfig ? { imageConfig } : {}) } });
    if (Buffer.byteLength(body) > 32 * 1024 * 1024) throw new AiError('IMAGE_INVALID');
    }catch(error){throw imageRequestNotSent(error);}
    const { data, response } = await relayJson(this.fetcher, `/v1beta/models/${encodeURIComponent(input.model)}:generateContent`, input.apiKey, signal, body);
    if (!object(data) || !Array.isArray(data.candidates) || data.candidates.length !== 1 || !object(data.candidates[0])) throw invalidImageOutput('shape');
    const candidate = data.candidates[0];
    if ((candidate.finishReason !== undefined && candidate.finishReason !== 'STOP') || !object(candidate.content) || !Array.isArray(candidate.content.parts)) throw invalidImageOutput('shape');
    const images = candidate.content.parts.filter(part => object(part) && part.thought !== true && (part.inlineData !== undefined || part.inline_data !== undefined));
    if (images.length !== 1) throw invalidImageOutput('shape');
    const inline: unknown = images[0].inlineData ?? images[0].inline_data;
    if (!object(inline) || !['image/png', 'image/jpeg'].includes(String(inline.mimeType ?? inline.mime_type))) throw invalidImageOutput('shape');
    let result = parseImage({ data: [{ b64_json: inline.data }] }, false);
    if (inspectRaster(result.bytes).mimeType !== (inline.mimeType ?? inline.mime_type)) throw invalidImageOutput('raster');
    if (inspectRaster(result.bytes).mimeType !== 'image/png') {
      try {
        if (!this.normalize) throw new Error();
        const bytes = this.normalize(result.bytes), shape = inspectRaster(bytes);
        if (shape.mimeType !== 'image/png' || bytes.length > 20 * 1024 * 1024 || shape.width !== result.width || shape.height !== result.height) throw new Error();
        result = { bytes, width: shape.width, height: shape.height };
      } catch { throw invalidImageOutput('normalize'); }
    }
    throwIfAborted(signal);
    return { ...result, requestId: safeRequestId(response.headers.get('x-request-id'), input) };
  }
}
