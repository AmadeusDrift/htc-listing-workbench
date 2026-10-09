export const MIAOSHOU_INDEXES = [
  { name: 'miaoshou_receipts_fingerprint', table: 'miaoshou_receipts', expressions: 1, sql: "CREATE INDEX miaoshou_receipts_fingerprint ON miaoshou_receipts(json_extract(record_json,'$.fingerprint'))" },
  { name: 'miaoshou_receipts_product', table: 'miaoshou_receipts', expressions: 1, sql: "CREATE INDEX miaoshou_receipts_product ON miaoshou_receipts(json_extract(record_json,'$.productId'))" },
] as const;
