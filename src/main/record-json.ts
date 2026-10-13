import type { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from '../shared/errors.ts';

const tables = ['source_consistency_attempts','source_consistency_assessments','source_consistency_decisions','source_consistency_bindings','source_image_provenance', 'listing_completion_operations', 'automatic_listing_tasks', 'item_labels', 'shipment_documents', 'image_workflow_runs', 'listing_followups', 'category_libraries', 'procurement_batches', 'hosting_profiles', 'hosting_uploads', 'execution_tasks', 'ai_profiles', 'ai_calls', 'ai_results',
  'source_snapshots','product_source_adoptions','product_fact_scopes','schema_fetch_operations','ai_purpose_profiles','ai_provider_receipts','ai_image_requests','ai_batches','ai_batch_items',
  'image_versions', 'image_selections', 'content_versions', 'image_write_operations', 'ai_usage_policies', 'ai_usage_ledger', 'collection_receipts', 'collection_captures', 'miaoshou_receipts', 'miaoshou_sync_runs', 'miaoshou_sync_items'];

/** SQL JSON selectors take the first duplicate key, while JSON.parse takes the last.
 * Establish a shared, unambiguous representation at migration/backup boundaries;
 * ordinary application writes already serialize validated objects with JSON.stringify.
 * json_tree decodes escaped keys. Parent identity keeps separate objects/array elements independent.
 */
export function assertUnambiguousRecordJson(db: DatabaseSync, table: string): void {
  if (!tables.includes(table)) throw new Error('Unsupported record table');
  const duplicate = db.prepare(`SELECT 1 FROM ${table} WHERE EXISTS (
    SELECT 1 FROM json_tree(${table}.record_json) AS member WHERE member.parent IS NOT NULL
    GROUP BY member.parent,member.key COLLATE BINARY HAVING COUNT(*)>1
  ) LIMIT 1`).get();
  if (duplicate) throw new UserFacingError('数据记录包含重复 JSON 字段，请修复来源后重试');
}
