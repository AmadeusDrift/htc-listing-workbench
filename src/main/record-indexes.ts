/** Exact declarations shared by migration and the backup schema allowlist. Never infer trust from a name alone. */
export const RECORD_INDEXES = [
  { table: 'ai_results', name: 'record_ai_results_product', expressions: 1, sql: "CREATE INDEX record_ai_results_product ON ai_results(json_extract(record_json,'$.productId'))" },
  { table: 'ai_calls', name: 'record_ai_calls_product', expressions: 1, sql: "CREATE INDEX record_ai_calls_product ON ai_calls(json_extract(record_json,'$.productId'))" },
  { table: 'ai_calls', name: 'record_ai_calls_provider', expressions: 1, sql: "CREATE INDEX record_ai_calls_provider ON ai_calls(json_extract(record_json,'$.providerId'))" },
  { table: 'ai_calls', name: 'record_ai_calls_status', expressions: 1, sql: "CREATE INDEX record_ai_calls_status ON ai_calls(json_extract(record_json,'$.status'))" },
  { table: 'image_versions', name: 'record_image_versions_product', expressions: 1, sql: "CREATE INDEX record_image_versions_product ON image_versions(json_extract(record_json,'$.productId'))" },
  { table: 'image_selections', name: 'record_image_selections_product', expressions: 1, sql: "CREATE INDEX record_image_selections_product ON image_selections(json_extract(record_json,'$.productId'))" },
  { table: 'content_versions', name: 'record_content_versions_product', expressions: 1, sql: "CREATE INDEX record_content_versions_product ON content_versions(json_extract(record_json,'$.productId'))" },
  { table: 'ai_usage_ledger', name: 'record_ai_usage_provider_day', expressions: 2, sql: "CREATE INDEX record_ai_usage_provider_day ON ai_usage_ledger(json_extract(record_json,'$.providerId'),json_extract(record_json,'$.day'))" },
  { table: 'ai_usage_ledger', name: 'record_ai_usage_state', expressions: 1, sql: "CREATE INDEX record_ai_usage_state ON ai_usage_ledger(json_extract(record_json,'$.state'))" },
] as const;
