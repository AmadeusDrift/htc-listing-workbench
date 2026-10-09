import type { MiaoshouPreview } from './miaoshou-contracts.ts';

export type MiaoshouSyncItemState = 'pending' | 'ready' | 'unchanged' | 'failed';
export interface MiaoshouSyncStatus {
  importToInbox?: boolean; imported?: number; existing?: number;
  status: 'idle' | 'running' | 'paused' | 'completed'; stage: 'listing' | 'details';
  pageSize: number; nextPage: number; remoteTotal: number | null;
  discovered: number; ready: number; skipped: number; failed: number; pending: number; skuCount: number;
  updatedAt: string | null; lastError: string | null;
}
export interface MiaoshouSyncItem {
  importResult?: 'added' | 'existing';
  remoteId: string; title: string; remoteModified: string; status: MiaoshouSyncItemState;
  skuCount: number; updatedAt: string; error: string | null;
}
export interface MiaoshouSyncPage { page: number; pageSize: number; total: number; items: MiaoshouSyncItem[] }
export interface MiaoshouSyncPageInput { page: number; pageSize: number; filter: 'all' | MiaoshouSyncItemState }
export interface MiaoshouSyncApi {
  getMiaoshouSyncStatus(): Promise<MiaoshouSyncStatus>;
  startMiaoshouSync(input: { pageSize: number }): Promise<MiaoshouSyncStatus>;
  pauseMiaoshouSync(): Promise<MiaoshouSyncStatus>;
  resumeMiaoshouSync(): Promise<MiaoshouSyncStatus>;
  retryMiaoshouSyncFailures(): Promise<MiaoshouSyncStatus>;
  listMiaoshouSyncItems(input: MiaoshouSyncPageInput): Promise<MiaoshouSyncPage>;
  previewMiaoshouSyncedProduct(input: { id: string }): Promise<MiaoshouPreview>;
}
