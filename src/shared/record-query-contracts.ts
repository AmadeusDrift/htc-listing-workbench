/** Cursors are opaque and valid only for the current service instance and unchanged filters. */
export interface RecordPageOptions { pageSize?: number; cursor?: string }
export interface ProductRecordQuery extends RecordPageOptions { productId: string }
/** Insertion order; records appended after the first page are excluded from this traversal. */
export interface RecordPage<T> { items: T[]; nextCursor: string | null }
