export const IMAGE_WRITE_STATES = ['WRITING', 'CLEANED', 'COMMITTED', 'NEEDS_ATTENTION'] as const;
export type ImageWriteState = typeof IMAGE_WRITE_STATES[number];
export const IMAGE_WRITE_CODES = ['WRITE_INTENT', 'UNCOMMITTED_REMOVED', 'VERSION_COMMITTED', 'INVALID_RECORD',
  'INVALID_HISTORY', 'REGISTERED_PATH', 'VERSION_CONFLICT', 'UNSAFE_PATH', 'CONTENT_MISMATCH', 'IO_ERROR'] as const;
export type ImageWriteCode = typeof IMAGE_WRITE_CODES[number];
/** Safe, bounded diagnostic view. Candidate paths, hashes and image bytes are never returned. */
export interface ImageWriteSummary { id: string; state: ImageWriteState; code: ImageWriteCode; createdAt: string; updatedAt: string }
export interface ImageWriteRecoveryStatus { total: number; counts: Record<ImageWriteState, number>; items: ImageWriteSummary[] }
