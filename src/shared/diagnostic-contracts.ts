import type { ImageWriteCode, ImageWriteState } from './image-write-contracts.ts';

export const DIAGNOSTIC_ERROR_CODES = ['DATABASE_MISSING', 'DATABASE_UNAVAILABLE', 'DATABASE_BUSY', 'DATABASE_CORRUPT', 'DATABASE_SCHEMA_UNSUPPORTED', 'INVALID_RECORD', 'UNSAFE_PATH', 'IO_ERROR'] as const;
export type DiagnosticErrorCode = typeof DIAGNOSTIC_ERROR_CODES[number];
export const DIAGNOSTIC_ASSET_STATUSES = ['VERIFIED', 'READABLE_UNVERIFIED', 'MISSING', 'CONTENT_MISMATCH', 'INVALID_RECORD', 'UNSAFE_PATH', 'IO_ERROR', 'CHANGED_DURING_READ', 'SKIPPED_FILE_LIMIT', 'SKIPPED_BYTE_LIMIT'] as const;
export type DiagnosticAssetStatus = typeof DIAGNOSTIC_ASSET_STATUSES[number];
export type DiagnosticAssetKind = 'ASSET_ORIGINAL' | 'ASSET_PREVIEW' | 'IMAGE_VERSION_ORIGINAL' | 'IMAGE_VERSION_PREVIEW';
export interface DiagnosticServices { aiBusy: boolean; imageWritesBusy: boolean; executionBusy: boolean }
export interface LocalDiagnosticReport {
  reportVersion: 1;
  generatedAt: string;
  appVersion: string | null;
  schemaVersion: number | null;
  runtime: { nodeMajor: number; electronMajor: number };
  services: DiagnosticServices;
  counts: {
    products: number | null; assets: number | null; aiCalls: number | null; aiResults: number | null;
    imageVersions: number | null; imageSelections: number | null; contentVersions: number | null;
    imageWriteOperations: number | null; usageLedger: number | null;
  };
  recovery: {
    total: number | null; inspected: number; invalid: number;
    items: { operationId: string; state: ImageWriteState; code: ImageWriteCode }[];
    truncated: boolean;
  };
  assets: {
    total: number | null; inspected: number; bytesRead: number;
    limits: { maxFiles: 100; maxFileBytes: 20971520; maxTotalBytes: 67108864 };
    items: { kind: DiagnosticAssetKind; recordId: string | null; status: DiagnosticAssetStatus }[];
    truncated: boolean;
  };
  errors: DiagnosticErrorCode[];
  truncated: boolean;
}
/** All values are projected by the main process. No paths or arbitrary stored strings cross this boundary. */
export interface DiagnosticApi {
  getLocalDiagnostics(): Promise<LocalDiagnosticReport>;
  exportLocalDiagnostics(): Promise<{ cancelled: boolean }>;
}
