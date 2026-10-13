import type { SourceConsistencyApi } from './source-image-consistency-contracts.ts';
import type { AmazonApi } from './amazon-contracts.ts';
import type { SkuNamingApi } from './sku-naming.ts';
import type { BackupApi } from './backup-contracts.ts';
import type { WorkspaceApi } from './workspace-contracts.ts';
import type { HostingApi } from './hosting-api.ts';
import type { ExecutionApi } from './execution-contracts.ts';
import type { AiApi } from './ai-contracts.ts';
import type { ImageVersionApi } from './image-version-contracts.ts';
import type { ContentApi } from './content-contracts.ts';
import type { DiagnosticApi } from './diagnostic-contracts.ts';
import type { MiaoshouApi } from './miaoshou-contracts.ts';
import type { CollectionApi } from './collection-contracts.ts';
import type { ListingRulesApi } from './listing-rules.ts';
import type { CatalogApi } from './catalog-contracts.ts';
import type { ProcurementApi } from './procurement-contracts.ts';
import type { AutomaticListingApi } from './automatic-listing-contracts.ts';
import type { ItemLabelApi } from './item-label-contracts.ts';
import type { ShipmentDocumentApi } from './shipment-document-contracts.ts';
import type { FollowupApi } from './followup-contracts.ts';
import type { ProductDataApi } from './product-data-contracts.ts';
import type { AppearanceApi } from './appearance-contracts.ts';
import type { ImageGenerationApi } from './image-generation-contracts.ts';
import type { ImageWorkflowApi } from './image-workflow-contracts.ts';

export type ProductStatus = 'draft' | 'ready' | 'archived';
export type ProductOrigin = 'manual' | 'import' | 'sample';
export type AssetRole = 'main' | 'gallery' | 'detail';
export type FactState = 'source_confirmed' | 'human_confirmed' | 'missing' | 'ai_suggested' | 'conflicting';

export interface VariantInput {
  id: string;
  sku: string;
  originalSpec: string;
  normalizedSpec: string;
  purchasePrice: string;
  inventory: number | null;
}
export interface Variant extends VariantInput {
  sourceSpec: string;
  sourcePurchasePrice: string;
}
export interface Fact {
  /** Absent only for historical unscoped records. */
  scope?: 'common' | 'variant' | 'unknown';
  variantId?: string;
  id: string;
  name: string;
  value: string;
  source: 'manual' | '1688' | 'import' | 'ai';
  sourceRef: string;
  state: FactState;
}
export interface Asset {
  id: string;
  fileName: string;
  role: AssetRole;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  previewUrl: string;
  variantIds: string[];
  createdAt: string;
}
export interface ProductSummary {
  id: string;
  title: string;
  sourceUrl: string;
  status: ProductStatus;
  origin: ProductOrigin;
  variantCount: number;
  assetCount: number;
  coverUrl: string | null;
  updatedAt: string;
}
export interface ProductDetail {
  id: string;
  title: string;
  sourceUrl: string;
  description: string;
  status: ProductStatus;
  origin: ProductOrigin;
  revision: number;
  createdAt: string;
  updatedAt: string;
  variants: Variant[];
  facts: Fact[];
  assets: Asset[];
}
export interface SaveProductInput {
  id: string;
  revision: number;
  title: string;
  sourceUrl: string;
  description: string;
  status: ProductStatus;
  variants: VariantInput[];
  facts: Fact[];
}
export interface ProductMutation { productId: string; revision: number }
export interface AssetUpdateInput extends ProductMutation {
  assetId: string;
  role: AssetRole;
  variantIds: string[];
}
export interface AuditEvent {
  id: string;
  productId: string | null;
  action: string;
  summary: string;
  createdAt: string;
}
export interface LocalCheck {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
}
export interface ListingReadiness {
  productId: string;
  checkedAt: string;
  mode: 'local';
  checks: LocalCheck[];
  amazonConnected: false;
  note: string;
}
export interface AppSettings {
  appVersion: string;
  dataDirectory: string;
  databasePath: string;
  assetDirectory: string;
  schemaVersion: number;
  amazonStatus: 'not_configured' | 'configured' | 'demo' | 'paused';
  productCount: number;
  assetCount: number;
}
export interface ImportResult { cancelled: boolean; count: number; productIds: string[] }
export interface ExportResult { cancelled: boolean; path?: string }

/** Narrow IPC boundary. File system paths are selected by native dialogs, never submitted by the renderer. */
export interface RedApi extends SourceConsistencyApi, AmazonApi, BackupApi, WorkspaceApi, HostingApi, ExecutionApi, AiApi, ImageVersionApi, ContentApi, DiagnosticApi, CollectionApi, MiaoshouApi, ListingRulesApi, CatalogApi, ProcurementApi, FollowupApi, ProductDataApi, AppearanceApi, ImageGenerationApi, ImageWorkflowApi, AutomaticListingApi, ItemLabelApi, ShipmentDocumentApi, SkuNamingApi {
  onUnsavedCloseRequested(listener: () => void): () => void;
  listProducts(): Promise<ProductSummary[]>;
  getProduct(id: string): Promise<ProductDetail>;
  createProduct(): Promise<ProductDetail>;
  saveProduct(input: SaveProductInput): Promise<ProductDetail>;
  importImages(input: ProductMutation): Promise<ProductDetail>;
  updateAsset(input: AssetUpdateInput): Promise<ProductDetail>;
  importProducts(): Promise<ImportResult>;
  exportProduct(id: string): Promise<ExportResult>;
  loadExamples(): Promise<ProductSummary[]>;
  loadWorkspaceExamples(lane: 'inbox' | 'automatic'): Promise<ProductSummary[]>;
  checkProduct(id: string): Promise<ListingReadiness>;
  listAudit(productId?: string): Promise<AuditEvent[]>;
  getSettings(): Promise<AppSettings>;
  openDataFolder(): Promise<void>;
}

declare global { interface Window { red: RedApi } }
