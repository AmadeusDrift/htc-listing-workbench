/** Version 10 declarations remain separate from version 9's backup schema allowlist. */
export const COLLECTION_INDEXES = [
  { name: 'collection_receipts_fingerprint', table: 'collection_receipts', expressions: 1, sql: "CREATE INDEX collection_receipts_fingerprint ON collection_receipts(json_extract(record_json,'$.fingerprint'))" },
  { name: 'collection_receipts_product', table: 'collection_receipts', expressions: 1, sql: "CREATE INDEX collection_receipts_product ON collection_receipts(json_extract(record_json,'$.productId'))" },
] as const;
