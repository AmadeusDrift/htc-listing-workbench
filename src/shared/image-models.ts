import type { ImageGenerationQuality, ImageGenerationSize, ImageModelOption } from './image-generation-contracts.ts';

export function validRelayModelId(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length <= 200 && /^[\p{L}\p{N}][\p{L}\p{N}._:/+@-]*$/u.test(raw) && !raw.includes('..') && !raw.includes('://');
}
export const isGeminiImageModel = (model: string): boolean => /^gemini-/i.test(model);
export function relayModelProtocol(model: string, endpoints: string[] = []): ImageModelOption['protocol'] {
  if (isGeminiImageModel(model) && /image|banana/i.test(model)) return 'gemini';
  if (/^gpt-image/i.test(model) || endpoints.includes('image-generation') || endpoints.includes('image-edits')) return 'images';
  return 'unsupported';
}
export function relayQuality(model: string, quality: ImageGenerationQuality): ImageGenerationQuality | undefined {
  if (isGeminiImageModel(model) || /-1k$/i.test(model) || model === 'gpt-image-2-逆向') return undefined;
  if (/^gpt-image-2-4k(?:-high)?$/i.test(model)) return 'high';
  if (model.endsWith('-4k-max')) return quality === 'auto' ? 'max' : quality;
  return quality === 'auto' ? undefined : quality;
}
export const fixedRelayQuality = (model: string): boolean => isGeminiImageModel(model) || /-1k$/i.test(model) || /^gpt-image-2-4k(?:-high)?$/i.test(model) || model === 'gpt-image-2-逆向';
export const relayDefaultQuality = (model: string): ImageGenerationQuality => relayQuality(model, 'auto') ?? 'auto';

// These saved size presets encode Gemini resolution + aspect ratio; actual output pixels are returned by the model.
export const GEMINI_IMAGE_SIZES: Record<string, { imageSize: '1K' | '2K' | '4K'; aspectRatio: string }> = {
  '1024x1024': { imageSize: '1K', aspectRatio: '1:1' }, '1536x1024': { imageSize: '1K', aspectRatio: '3:2' }, '1024x1536': { imageSize: '1K', aspectRatio: '2:3' },
  '1376x768': { imageSize: '1K', aspectRatio: '16:9' }, '768x1376': { imageSize: '1K', aspectRatio: '9:16' },
  '2048x2048': { imageSize: '2K', aspectRatio: '1:1' }, '3072x2048': { imageSize: '2K', aspectRatio: '3:2' }, '2048x3072': { imageSize: '2K', aspectRatio: '2:3' },
  '2752x1536': { imageSize: '2K', aspectRatio: '16:9' }, '1536x2752': { imageSize: '2K', aspectRatio: '9:16' },
  '4096x4096': { imageSize: '4K', aspectRatio: '1:1' }, '6144x4096': { imageSize: '4K', aspectRatio: '3:2' }, '4096x6144': { imageSize: '4K', aspectRatio: '2:3' },
  '5504x3072': { imageSize: '4K', aspectRatio: '16:9' }, '3072x5504': { imageSize: '4K', aspectRatio: '9:16' },
};
export function geminiImageConfig(size: ImageGenerationSize) { return size === 'auto' ? undefined : GEMINI_IMAGE_SIZES[size]; }
