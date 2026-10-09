import type { ProductRecordQuery, RecordPage } from './record-query-contracts.ts';

export interface ImageVersion {
  id: string; productId: string; productRevision: number; sourceAssetId: string; sourceSha256: string;
  resultId: string; version: number; width: number; height: number; byteSize: number; sha256: string;
  originalPath: string; previewPath: string; previewSha256: string; previewByteSize: number;
  createdAt: string; reviewState: 'unreviewed';
  checks: { transparentPixels: number; subjectPixels: number };
}
/** Append-only local selection history; source assets and listing image fields remain independent. */
export interface ImageSelection {
  id: string; productId: string; sourceAssetId: string; sourceSha256: string;
  versionId: string | null; selectedAt: string; reviewState: 'human-selected';
}
export interface SaveImageResultInput { productId: string; productRevision: number; resultId: string }
export interface SelectImageVersionInput { productId: string; productRevision: number; sourceAssetId: string; versionId: string | null }
export interface ImageVersionApi {
  saveImageResult(input: SaveImageResultInput): Promise<ImageVersion>;
  listImageVersions(productId: string): Promise<ImageVersion[]>;
  selectImageVersion(input: SelectImageVersionInput): Promise<ImageSelection>;
  listImageSelections(productId: string): Promise<ImageSelection[]>;
  queryImageVersions(input: ProductRecordQuery): Promise<RecordPage<ImageVersion>>;
  queryImageSelections(input: ProductRecordQuery): Promise<RecordPage<ImageSelection>>;
  getImageVersionPreview(versionId: string): Promise<string>;
}
