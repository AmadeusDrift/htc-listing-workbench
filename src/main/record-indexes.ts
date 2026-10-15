/** Exact declarations shared by migration and the backup schema allowlist. Never infer trust from a name alone. */
export const COMPLETION_PRODUCT_INDEXES = [
  { table: 'listing_completion_operations', name: 'record_completion_product', expressions: 1, sql: "CREATE INDEX record_completion_product ON listing_completion_operations(json_extract(record_json,'$.safetyIdentity.productId'))" },
] as const;
export const RESULT_CALL_INDEXES = [
  { table: 'ai_results', name: 'record_ai_results_call', expressions: 1, sql: "CREATE INDEX record_ai_results_call ON ai_results(json_extract(record_json,'$.callId'))" },
] as const;
export const SALES_IDENTITY_INDEXES = [
  { table: 'listing_drafts', name: 'record_drafts_sku', expressions: 1, sql: "CREATE INDEX record_drafts_sku ON listing_drafts(json_extract(record_json,'$.draft.sku'))" },
  { table: 'listing_drafts', name: 'record_drafts_recipe', expressions: 1, sql: "CREATE INDEX record_drafts_recipe ON listing_drafts(json_extract(record_json,'$.draft.salesPlan.recipe.key'))" },
] as const;
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
