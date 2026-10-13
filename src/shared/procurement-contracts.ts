export interface ProcurementCandidate {
  /** Immutable input references captured when the procurement line is created. */
  basis?: { productRevision: number; sourceHash: string; recipeHash: string | null; observationHash: string | null };
  salesRecipe?: import('./sales-plan-contracts.ts').SalesRecipe;
  draftId: string; productId: string; variantId: string; title: string; spec: string; sku: string;
  targetId: string; targetName: string; sellerId: string; marketplaceId: string; mode: 'demo' | 'live';
  sourceUrl: string; sourceItemId: string; sourceSkuKey: string; sourceUrlBasis: 'product' | 'miaoshou' | 'item-id' | 'missing';
  imageAssetId: string | null; sourceImageUrl: string; sourcePurchasePrice: string; currency: 'CNY' | 'unknown';
  asin: string | null; fnsku: string | null; checkedAt: string | null; eligible: boolean; reason: string;
  /** A local identity or platform problem that waiting alone cannot resolve. */
  requiresAttention?: boolean;
}
export interface ProcurementLine extends Omit<ProcurementCandidate, 'eligible' | 'reason' | 'mode' | 'requiresAttention'> {
  id: string; purchaseQuantity: number | null; stockQuantity: number | null;
  purchasePrice: string; purchaseUnit: string; priceConfirmed: boolean; labelStatus: ItemLabelStatus;
}
export interface ProcurementBatch {
  id: string; code: string; name: string; revision: number; mode: 'demo' | 'live'; createdAt: string; updatedAt: string;
  lines: ProcurementLine[];
  automaticJobId?: string;
  shipment: { confirmationId: string; status: 'LINKED_UNVERIFIED'; linkedAt: string } | null;
}
export interface ProcurementBatchSummary { id: string; code: string; name: string; mode: 'demo' | 'live'; lineCount: number; updatedAt: string }
export interface UpdateProcurementBatch {
  id: string; revision: number;
  lines: { id: string; purchaseQuantity: number | null; stockQuantity: number | null; purchasePrice: string; purchaseUnit: string; priceConfirmed: boolean }[];
  shipmentConfirmationId: string;
}
export interface ProcurementApi {
  listProcurementCandidates(): Promise<ProcurementCandidate[]>;
  listProcurementBatches(): Promise<ProcurementBatchSummary[]>;
  getProcurementBatch(id: string): Promise<ProcurementBatch>;
  createProcurementBatch(input: { name: string; draftIds: string[] }): Promise<ProcurementBatch>;
  updateProcurementBatch(input: UpdateProcurementBatch): Promise<ProcurementBatch>;
  exportProcurementBatch(input: { id: string; format: 'csv' | 'html' }): Promise<{ cancelled: boolean }>;
  openProcurementSource(input: { batchId: string; lineId: string }): Promise<void>;
}
import type { ItemLabelStatus } from './item-label-contracts.ts';
