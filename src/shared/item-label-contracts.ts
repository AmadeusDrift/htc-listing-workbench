export const ITEM_LABEL_PAGE_TYPES = ['A4_21','A4_24','A4_24_64x33','A4_24_66x35','A4_24_70x36','A4_24_70x37','A4_24i','A4_27','A4_40_52x29','A4_44_48x25','Letter_30'] as const;
export type ItemLabelFormat = { labelType: 'STANDARD_FORMAT'; pageType: typeof ITEM_LABEL_PAGE_TYPES[number]; localeCode: string } | { labelType: 'THERMAL_PRINTING'; width: number; height: number; localeCode: string };
export const DEFAULT_ITEM_LABEL_FORMAT: ItemLabelFormat = { labelType: 'STANDARD_FORMAT', pageType: 'A4_21', localeCode: 'en_US' };
export const ITEM_LABEL_STATUSES = ['NOT_REQUESTED','WAITING_SKU','WAITING_QUANTITY','QUEUED','REQUESTING','DOWNLOADING','READY','STALE','FAILED','CANCELLED'] as const;
export type ItemLabelStatus = typeof ITEM_LABEL_STATUSES[number];
export interface ItemLabelFile { relativePath: string; sha256: string; byteSize: number; index: number }
export interface ItemLabelRecord {
  id: string; jobId: string | null; batchId: string; lineId: string; draftId: string; productId: string; variantId: string;
  targetId: string; sellerId: string; marketplaceId: string; sku: string; mode: 'live' | 'demo'; targetGeneration: number;
  quantity: number | null; format: ItemLabelFormat; fingerprint: string; version: number; current: boolean;
  status: ItemLabelStatus; paused: boolean; attempts: number; nextDueAt: string | null; createdAt: string; updatedAt: string;
  /** Persisted before sending; survives a transition to a historical version. */
  requestPending?: boolean;
  responseReceived?: boolean;
  downloadAttempts?: number;
  batchRevision?: number;
  requestedAt?: string;
  requestId: string | null; errorCode: string | null; message: string; files: ItemLabelFile[];
}
export interface ItemLabelApi {
  getItemLabelFormat(): Promise<ItemLabelFormat>;
  saveItemLabelFormat(input: ItemLabelFormat): Promise<ItemLabelFormat>;
  listItemLabels(input?: { batchId?: string; jobId?: string }): Promise<ItemLabelRecord[]>;
  getItemLabel(id: string): Promise<ItemLabelRecord>;
  prepareItemLabels(batchId: string): Promise<ItemLabelRecord[]>;
  retryItemLabel(id: string): Promise<ItemLabelRecord>;
  openItemLabel(input: { id: string; fileIndex: number }): Promise<void>;
  exportItemLabels(batchId: string): Promise<{ cancelled: boolean }>;
}
