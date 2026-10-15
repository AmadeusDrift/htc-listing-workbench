export const OPENAI_IMAGE_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] as const;
export type OpenAiImageModel = typeof OPENAI_IMAGE_MODELS[number];
export const DEFAULT_OPENAI_IMAGE_MODEL: OpenAiImageModel = 'gpt-image-2.5-sunburst';
/** Offline suggestions only. A relay model identifier is not a fixed allowlist. */
export const TYAI_IMAGE_MODELS = ['gpt-image-2', 'gpt-image-2-4k-high', 'gpt-image-2-4k', 'gpt-image-2-4K', 'gpt-image-2-1k', 'gpt-image-2-逆向', 'gpt-image-2.5', 'gpt-image-2.5-sunburst-1k', 'gpt-image-2.5-flare-1k', 'gpt-image-2.5-sunburst-4k-max', 'gpt-image-2.5-flare-4k-max', 'gpt-image-2.5-逆向', 'gpt-image2-Pro4K', 'gemini-nano-banana-2.1', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview'] as const;
export type TyaiImageModel = string;
export const DEFAULT_TYAI_IMAGE_MODEL: TyaiImageModel = 'gpt-image-2.5-sunburst-4k-max';
/** Legacy values are read-only candidate provenance, never active connection choices. */
export type ImageGenerationProvider = 'openai' | 'tyai' | 'openrouter';
export const OPENROUTER_IMAGE_MODELS=['openai/gpt-image-2.5-sunburst','openai/gpt-image-2.5-flare'] as const;
export const DEFAULT_OPENROUTER_IMAGE_MODEL=OPENROUTER_IMAGE_MODELS[0];
export type ImageGenerationModel = OpenAiImageModel | TyaiImageModel;
export type ImageGenerationQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ImageGenerationSize = 'auto' | `${number}x${number}`;
export interface ImageModelOption { id: string; protocol: 'images' | 'gemini' | 'unsupported'; endpoints: string[] }
export interface ImageModelCatalog { source: 'builtin' | 'remote'; fetchedAt: string | null; models: ImageModelOption[] }
export interface ImageGenerationConnection {
  provider: ImageGenerationProvider; activeProvider: ImageGenerationProvider;
  model: ImageGenerationModel; size: ImageGenerationSize; quality: ImageGenerationQuality;
  configured: boolean; enabled: boolean;
  credentialState: 'absent' | 'encryption-unavailable' | 'unreadable' | 'ready';
  /** A models lookup is only an access check, never a successful image-generation test. */
  accessCheck: 'not-checked' | 'accessible' | 'failed'; checkedAt: string | null;
}
export interface SaveImageGenerationConnection {
  /** Saving a provider selects it for subsequent automatic image work. Omitted uses the active provider. */
  provider?: ImageGenerationProvider;
  model: ImageGenerationModel; enabled: boolean; size?: ImageGenerationSize; quality?: ImageGenerationQuality;
  /** Omitted or empty preserves the existing key. Keys are never returned. */
  apiKey?: string;
}
export interface GenerateImageCandidateInput {
  productId: string; productRevision: number; prompt: string;
  /** Empty means text-to-image; otherwise edit using this product's managed reference images. */
  referenceAssetIds: string[];
  size: ImageGenerationSize; quality: ImageGenerationQuality;
  background: 'auto' | 'opaque' | 'transparent';
}
/** Internal workflow producer only; absent manual SKU identity remains broad. */
export interface ImageGenerationOwner {draftId:string;sku:string;targetId:string;marketplaceId:string;variantIds:string[];slot:number}
export interface GeneratedImageCandidate {
  id: string; provider: ImageGenerationProvider; model: ImageGenerationModel; mode: 'generate' | 'edit';
  productId: string; productRevision: number; createdAt: string; requestId: string | null;
  sourceAssets: { id: string; sha256: string }[];
  reviewState: 'unreviewed'; mimeType: 'image/png'; width: number; height: number;
  byteSize: number; sha256: string; previewUrl: string;
  /** A failed candidate used for targeted editing; it is never a verified product reference. */
  editSource?: { id:string; sha256:string };
}
export interface ImageGenerationApi {
  getImageGenerationSpendStatus():Promise<import('./ai-spend-contracts.ts').ImageGenerationSpendStatus>;
  setImageGenerationDailySpendLimit(input:import('./ai-spend-contracts.ts').SetImageDailySpendLimit):Promise<import('./ai-spend-contracts.ts').ImageGenerationSpendStatus>;
  getImageGenerationModels(): Promise<ImageModelCatalog>;
  refreshImageGenerationModels(): Promise<ImageModelCatalog>;
  getImageGenerationConnection(provider?: ImageGenerationProvider): Promise<ImageGenerationConnection>;
  saveImageGenerationConnection(input: SaveImageGenerationConnection): Promise<ImageGenerationConnection>;
  disconnectImageGenerationConnection(provider?: ImageGenerationProvider): Promise<ImageGenerationConnection>;
  checkImageGenerationConnection(provider?: ImageGenerationProvider): Promise<ImageGenerationConnection>;
  generateImageCandidate(input: GenerateImageCandidateInput): Promise<GeneratedImageCandidate>;
  cancelImageGeneration(): Promise<void>;
}
