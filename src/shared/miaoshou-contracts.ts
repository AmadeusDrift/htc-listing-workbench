import type { ProductDetail } from './contracts.ts';
import type { MiaoshouSyncApi } from './miaoshou-sync-contracts.ts';

export type MiaoshouMode = 'unconfigured' | 'demo' | 'live';
export type MiaoshouDimensionId = 'color' | 'size' | 'third';
export interface MiaoshouStatus { mode: MiaoshouMode; configured: boolean; appKeyHint: string; endpoint: string }
export interface MiaoshouPreferences { autoSyncOnInbox: boolean }
export interface MiaoshouInboxSummary {
  productId: string; imageId: string | null; price: string; size: string; weight: string;
  attributes: { name: string; value: string }[]; hasSourceUpdate: boolean; missing: string[];
}
export interface MiaoshouSourceLink { sourceItemId: string; source: string; sourceSite: string; sourceItemUrl: string }
export interface MiaoshouListItem { id: string; title: string; sourceUrl: string; sourceName: string; minPrice: string | null; maxPrice: string | null; updatedAt: string; status: string }
export interface MiaoshouList { mode: 'demo' | 'live'; pageNo: number; pageSize: number; total: number; items: MiaoshouListItem[] }
export interface MiaoshouDimension { id: MiaoshouDimensionId; name: string; values: { id: string; name: string; imageUrls: string[] }[] }
export interface MiaoshouSourceSku {
  key: string; itemNum: string; price: string | null; oriPrice: string | null;
  stock: string | null; oriStock: string | null; weight: string | null;
  packageLength: string | null; packageWidth: string | null; packageHeight: string | null;
}
export interface MiaoshouImage { id: string; url: string; role: 'main' | 'gallery' | 'detail' }
export interface MiaoshouProduct {
  remoteId: string; title: string; description: string; capturedAt: string;
  detailText?: string;
  sources: MiaoshouSourceLink[]; attributes: { name: string; value: string }[];
  dimensions: MiaoshouDimension[]; skus: MiaoshouSourceSku[]; images: MiaoshouImage[];
  warnings: string[];
}
export interface MiaoshouPreview { previewId: string; mode: 'demo' | 'live'; expiresAt: string; product: MiaoshouProduct; existingProductId?: string }
export interface MiaoshouSkuMapping { sourceKey: string; dimensions: Partial<Record<MiaoshouDimensionId, string>> }
export interface MiaoshouMapping { priceField: 'none' | 'price' | 'oriPrice'; currency: 'unknown' | 'CNY'; skus: MiaoshouSkuMapping[] }
export interface MiaoshouImportInput { previewId: string; mapping: MiaoshouMapping }
export interface MiaoshouImportResult { productId: string; duplicate: boolean; warnings: string[]; skuCount: number; imageCount: number }
export type SourceAttributeNormalizationRule = 'name-ascii-width' | 'name-trim' | 'value-ascii-width' | 'value-trim' | 'measurement-unit';
export interface SourceAttributeNormalizationEntry {
  factId: string; attributeIndex: number; rawName: string; rawValue: string; name: string; value: string;
  ruleIds: SourceAttributeNormalizationRule[];
}
/** Creation audit against sanitized snapshot attributes; later fact edits do not rewrite it. */
export interface SourceAttributeNormalizations { version: 'source-attribute-normalization/v1'; entries: SourceAttributeNormalizationEntry[] }
export interface MiaoshouReceipt {
  id: string; productId: string; fingerprint: string; accountScope: string; mode: 'demo' | 'live';
  receivedAt: string; snapshot: MiaoshouProduct; mapping: MiaoshouMapping;
  skuMappings: { sourceKey: string; localVariantId: string; imageIds: string[] }[];
  factNormalizations?: SourceAttributeNormalizations;
}
export interface MiaoshouDownloadInput { productId: string; revision: number; imageIds: string[] }
export interface MiaoshouDownloadResult { product: ProductDetail; downloaded: number; existing: number; failures: { imageId: string; message: string }[] }
export interface MiaoshouApi extends MiaoshouSyncApi {
  getMiaoshouPreferences(): Promise<MiaoshouPreferences>;
  saveMiaoshouPreferences(input: MiaoshouPreferences): Promise<MiaoshouPreferences>;
  syncMiaoshouInbox(input: { trigger: 'manual' | 'enter' | 'resume' | 'retry' }): Promise<import('./miaoshou-sync-contracts.ts').MiaoshouSyncStatus | null>;
  getMiaoshouInboxSummaries(input: { productIds: string[] }): Promise<MiaoshouInboxSummary[]>;
  previewMiaoshouImage(input: { productId: string; imageId: string; version?: 'imported' | 'latest' }): Promise<string>;
  getMiaoshouSourceUpdate(productId: string): Promise<MiaoshouProduct | null>;
  saveMiaoshouConfig(input: import('./connection-inputs.ts').MiaoshouConfigInput): Promise<MiaoshouStatus>;
  getMiaoshouStatus(): Promise<MiaoshouStatus>;
  importMiaoshouConfig(): Promise<{ cancelled: boolean; status?: MiaoshouStatus }>;
  exportMiaoshouConfigTemplate(): Promise<{ cancelled: boolean }>;
  setMiaoshouMode(mode: 'demo' | 'live'): Promise<MiaoshouStatus>;
  disconnectMiaoshou(): Promise<MiaoshouStatus>;
  listMiaoshouProducts(input: { pageNo: number; pageSize: number }): Promise<MiaoshouList>;
  previewMiaoshouProduct(input: { id: string }): Promise<MiaoshouPreview>;
  importMiaoshouProduct(input: MiaoshouImportInput): Promise<MiaoshouImportResult>;
  getMiaoshouReceipt(productId: string): Promise<MiaoshouReceipt | null>;
  downloadMiaoshouImages(input: MiaoshouDownloadInput): Promise<MiaoshouDownloadResult>;
}
