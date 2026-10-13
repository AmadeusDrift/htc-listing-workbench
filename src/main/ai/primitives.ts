import { AI_PROVIDER_IDS } from '../../shared/ai-contracts.ts';
import type { AiProviderId,AiErrorCode,AiProfile,AiUsage,RecognizeImageInput,ReviewContentInput,SegmentImageInput,SuggestContentInput } from '../../shared/ai-contracts.ts';
import { AI_VENDOR_IDS } from '../../shared/ai-connection-contracts.ts';
import type { AiVendorId } from '../../shared/ai-connection-contracts.ts';
import { AiError } from './errors.ts';
import { textModelCapability } from './model-capabilities.ts';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OCR_TEXT = 100000;
export const MODELS = { 'aliyun-ocr': 'RecognizeAllText/Commerce', 'aidge-segmentation': 'ImageMatting', deepseek: 'deepseek-flash', 'deepseek-review': 'deepseek-v4-pro', 'aliyun-image-risk':'aigcViolationDetection',openrouter:'openai/gpt-6-luna','openrouter-review':'openai/gpt-6-luna' } as const;
export const CAPABILITIES = { 'aliyun-ocr': 'ocr', 'aidge-segmentation': 'segmentation', deepseek: 'text', 'deepseek-review': 'text-review', 'aliyun-image-risk':'image-risk',openrouter:'text','openrouter-review':'text-review' } as const;
export type DeepSeekModel = 'deepseek-flash' | 'deepseek-v4-pro' | 'openai/gpt-6-luna' | 'openai/gpt-6.1-sol' | 'openai/gpt-6-astra';
export interface AliyunCredentials { accessKeyId: string; accessKeySecret: string; securityToken?: string }
export interface DeepSeekCredentials { apiKey: string }
export type AiCredentials = AliyunCredentials | DeepSeekCredentials;
export type ProfileImport = { id: 'aliyun-ocr' | 'aidge-segmentation' | 'aliyun-image-risk'; model: string; credentials: AliyunCredentials } | { id: 'deepseek' | 'deepseek-review' | 'openrouter' | 'openrouter-review'; model: DeepSeekModel; credentials: DeepSeekCredentials };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function invalid(code: AiErrorCode = 'INVALID_CONFIG'): never { throw new AiError(code); }
export function object(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) invalid(); return raw as Record<string, unknown>; }
export function keys(raw: unknown, names: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const o = object(raw);
  if (names.some(name => !Object.hasOwn(o, name)) || Object.keys(o).some(key => !names.includes(key) && !optional.includes(key))) invalid();
  return o;
}
export function providerId(raw: unknown): AiProviderId { if (typeof raw !== 'string' || !AI_PROVIDER_IDS.includes(raw as AiProviderId)) invalid('INVALID_INPUT'); return raw as AiProviderId; }
export function vendorId(raw: unknown): AiVendorId { if (typeof raw !== 'string' || !AI_VENDOR_IDS.includes(raw as AiVendorId)) invalid('INVALID_INPUT'); return raw as AiVendorId; }
export function uuid(raw: unknown): string { if (typeof raw !== 'string' || !UUID.test(raw)) invalid('INVALID_INPUT'); return raw; }
export function integer(raw: unknown, min: number, max: number): number { if (!Number.isSafeInteger(raw) || Number(raw) < min || Number(raw) > max) invalid(); return Number(raw); }
export function boundedText(raw: unknown, max: number, empty = false): string { if (typeof raw !== 'string' || raw.length > max || (!empty && !raw.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) invalid(); return raw; }
export function flag(raw: unknown): boolean { if (typeof raw !== 'boolean') invalid(); return raw; }
export function date(raw: unknown): string { const value = boundedText(raw, 24); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value; }
export function sha256(raw: unknown): string { if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) invalid(); return raw; }
export function uuidList(raw: unknown, max: number, min = 0): string[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) invalid();
  const result = Array.from(raw, uuid); if (new Set(result).size !== result.length) invalid(); return result;
}
export function isDeepSeek(id: AiProviderId): id is 'deepseek' | 'deepseek-review' { return id === 'deepseek' || id === 'deepseek-review'; }
export function isChatProvider(id:AiProviderId):id is 'deepseek'|'deepseek-review'|'openrouter'|'openrouter-review'{return isDeepSeek(id)||id==='openrouter'||id==='openrouter-review';}
export function isGenerationProvider(id:unknown):id is 'deepseek'|'openrouter'{return id==='deepseek'||id==='openrouter';}
export function isReviewProvider(id:unknown):id is 'deepseek-review'|'openrouter-review'{return id==='deepseek-review'||id==='openrouter-review';}
export function modelFor(id:AiProviderId,raw:unknown):string{if(typeof raw!=='string')invalid();if(isChatProvider(id)){try{textModelCapability(id.startsWith('openrouter')?'openrouter':'deepseek',raw);}catch{invalid();}}else if(raw!==MODELS[id])invalid();return raw;}
export function parseFunctionSettings(raw: unknown) {
  const o = keys(raw, ['id', 'model', 'enabled'], ['thinking']), id = providerId(o.id), model = modelFor(id, o.model);
  if (typeof o.enabled !== 'boolean' || o.thinking !== undefined && (typeof o.thinking !== 'boolean' || !isChatProvider(id))) invalid('INVALID_INPUT');
  return { id, model, enabled: o.enabled, ...(o.thinking === undefined ? {} : { thinking: o.thinking as boolean }) };
}
function secret(raw: unknown): string { const text = boundedText(raw, 4096); if (text.length < 8 || /[^\x21-\x7e]/.test(text)) invalid(); return text; }
export function parseProfileImport(raw: unknown): ProfileImport {
  const id = providerId(object(raw).id);
  const o = isChatProvider(id) ? keys(raw, ['id', 'model', 'apiKey']) : keys(raw, ['id', 'accessKeyId', 'accessKeySecret'], ['securityToken']);
  const model = isChatProvider(id) ? modelFor(id, o.model) : MODELS[id];
  const credentials: AiCredentials = isChatProvider(id) ? { apiKey: secret(o.apiKey) } : { accessKeyId: secret(o.accessKeyId), accessKeySecret: secret(o.accessKeySecret), ...(o.securityToken === undefined || o.securityToken === '' ? {} : { securityToken: secret(o.securityToken) }) };
  if (Object.values(credentials).some(value => [id, model, CAPABILITIES[id]].some(publicValue => publicValue.includes(value)))) invalid();
  return { id, model, credentials } as ProfileImport;
}
export function parseConnectionInput(raw: unknown): { id: AiVendorId; credentials: AiCredentials } {
  const id = vendorId(object(raw).id);
  const o = id !== 'aliyun' ? keys(raw, ['id', 'apiKey']) : keys(raw, ['id', 'accessKeyId', 'accessKeySecret'], ['securityToken']);
  const parsed = parseProfileImport(id !== 'aliyun' ? { id, model: MODELS[id], apiKey: o.apiKey }
    : { id: 'aliyun-ocr', accessKeyId: o.accessKeyId, accessKeySecret: o.accessKeySecret, ...(o.securityToken === undefined ? {} : { securityToken: o.securityToken }) });
  return { id, credentials: parsed.credentials };
}
export function validateAiProfile(raw: unknown): AiProfile {
  const o = keys(raw, ['id', 'capability', 'model', 'enabled', 'configured', 'generation'], ['thinking']), id = providerId(o.id);
  const enabled = flag(o.enabled), configured = flag(o.configured), generation = integer(o.generation, 0, Number.MAX_SAFE_INTEGER - 1);
  if (o.capability !== CAPABILITIES[id] || (enabled && !configured) || (configured && !generation)) invalid();
  if(o.thinking!==undefined&&(!isChatProvider(id)||typeof o.thinking!=='boolean'))invalid();
  return { id, capability: CAPABILITIES[id], model: modelFor(id, o.model), enabled, configured, generation, ...(o.thinking===undefined?{}:{thinking:flag(o.thinking)}) };
}
export function validateUsage(raw: unknown): AiUsage {
  const o = keys(raw, ['promptTokens', 'completionTokens', 'processedImages']);
  return { promptTokens: integer(o.promptTokens, 0, 1000000000), completionTokens: integer(o.completionTokens, 0, 1000000000), processedImages: integer(o.processedImages, 0, 1000000) };
}
export function requestId(raw: unknown): string | null { if (raw === null || raw === undefined) return null; if (typeof raw !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw)) invalid(); return raw; }
function parseInput<T>(operation: () => T): T { try { return operation(); } catch { throw new AiError('INVALID_INPUT'); } }
export function parseRecognizeInput(raw: unknown): RecognizeImageInput { return parseInput(() => { const o = keys(raw, ['productId', 'productRevision', 'assetId']); return { productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), assetId: uuid(o.assetId) }; }); }
export function parseSegmentInput(raw: unknown): SegmentImageInput { return parseInput(() => { const o = keys(raw, ['productId', 'productRevision', 'assetId', 'hostedAssetId']); return { productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), assetId: uuid(o.assetId), hostedAssetId: uuid(o.hostedAssetId) }; }); }
export function parseSuggestInput(raw: unknown): SuggestContentInput { return parseInput(() => { const o = keys(raw, ['productId', 'productRevision', 'variantId', 'ocrResultIds']); return { productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), variantId: uuid(o.variantId), ocrResultIds: uuidList(o.ocrResultIds, 10) }; }); }
export function parseReviewInput(raw: unknown): ReviewContentInput { return parseInput(() => { const o = keys(raw, ['productId', 'productRevision', 'suggestionResultId']); return { productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), suggestionResultId: uuid(o.suggestionResultId) }; }); }

