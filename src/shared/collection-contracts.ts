export const COLLECTION_PROTOCOL_VERSION = 1;
export const COLLECTION_MAX_MESSAGE_BYTES = 512 * 1024;
export const COLLECTION_WARNING_CODES = ['MISSING_TITLE', 'MISSING_SKUS', 'SKU_STRUCTURE_UNRECOGNIZED', 'MISSING_PRICE', 'MISSING_IMAGES', 'REMOTE_IMAGES_ONLY', 'PRICE_PRECISION_UNSUPPORTED', 'INCOMPLETE_SKU_IMAGES'] as const;
export type CollectionWarningCode = typeof COLLECTION_WARNING_CODES[number];
export const COLLECTION_ERROR_CODES = ['INVALID_MESSAGE', 'UNSUPPORTED_VERSION', 'UNAUTHORIZED', 'TOO_LARGE', 'TOO_MANY_SKUS', 'INVALID_SOURCE', 'INVALID_SNAPSHOT', 'CAPTURE_CONFLICT', 'APP_UNAVAILABLE', 'APP_BUSY', 'TIMEOUT', 'INTERNAL_ERROR'] as const;
export type CollectionErrorCode = typeof COLLECTION_ERROR_CODES[number];
export interface CollectionSourceSku { providerSkuId: string; originalSpec: string; attributes: { name: string; value: string }[]; purchasePrice: string | null }
export interface CollectionPricing { currency: 'CNY'; unitPrice: string | null; range: { min: string; max: string } | null; tiers: { minQuantity: number; unitPrice: string }[] }
export interface CollectionSourceImage { id: string; url: string; role: 'main' | 'gallery' | 'detail' }
export interface CollectionSkuImage { providerSkuId: string; imageId: string; basis: 'provider-sku-id' | 'spec-value'; specName: string | null; specValue: string | null }
export interface CollectionSnapshot {
  source: '1688'; offerId: string; sourceUrl: string; capturedAt: string; title: string;
  skus: CollectionSourceSku[]; pricing: CollectionPricing; images: CollectionSourceImage[]; skuImages: CollectionSkuImage[]; warnings: CollectionWarningCode[];
}
export interface CollectionReceiveResult { captureId: string; receiptId: string; productId: string; duplicate: boolean; receivedAt: string; warnings: CollectionWarningCode[]; variantCount: number }
export interface CollectionReceipt {
  id: string; firstCaptureId: string; productId: string; fingerprint: string; receivedAt: string;
  snapshot: CollectionSnapshot; skuMappings: { providerSkuId: string; localVariantId: string }[];
}
export interface CollectionCaptureRecord { id: string; receiptId: string; fingerprint: string; capturedAt: string; receivedAt: string; duplicate: boolean }
export type CollectionRequest = { version: 1; type: 'status'; requestId: string } | { version: 1; type: 'capture'; requestId: string; captureId: string; snapshot: CollectionSnapshot };
export type CollectionResponse = { version: 1; type: 'status'; requestId: string; ok: true; state: 'ready' | 'paused' }
  | { version: 1; type: 'receipt'; requestId: string; ok: true; receipt: CollectionReceiveResult }
  | { version: 1; type: 'error'; requestId: string | null; ok: false; code: CollectionErrorCode };
export interface CollectionStatus {
  state: 'unprepared' | 'ready' | 'paused' | 'closed' | 'unavailable'; protocolVersion: 1; nativeHostName: string; extensionId: string; connectionPrepared: boolean; activeConnections: number;
}
export interface CollectionApi {
  getCollectionStatus(): Promise<CollectionStatus>;
  prepareCollectionConnection(): Promise<CollectionStatus>;
  openCollectionConnectionFolder(): Promise<void>;
  getCollectionReceipt(productId: string): Promise<CollectionReceipt | null>;
  onCollectionReceived(listener: (event: CollectionReceiveResult) => void): () => void;
}
