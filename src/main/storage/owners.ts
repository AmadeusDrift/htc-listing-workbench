import type { ModuleId } from '../../shared/workflow-context-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';

export type DataOwner=ModuleId|'maintenance'|'settings'|'connections';
/** Declares the target owner; legacy cross-owner writes remain migration work, not implicit permission. */
export const MODULE_TABLES:Readonly<Partial<Record<DataOwner,readonly string[]>>>=Object.freeze({
  source:['collection_receipts','collection_captures','miaoshou_receipts','miaoshou_sync_runs','miaoshou_sync_items','source_snapshots'],
  product:['products','variants','facts','variant_assets','product_workspaces','source_image_provenance','source_consistency_attempts','source_consistency_assessments','source_consistency_decisions','source_consistency_bindings','product_source_adoptions','product_fact_scopes'],
  sales:['sku_naming_sequences','sku_naming_groups','sku_naming_identities'],
  catalog:['schema_cache','category_libraries','schema_fetch_operations'],
  listing:['listing_drafts','issues','content_versions','listing_completion_operations'],
  ai:['ai_profiles','ai_calls','ai_results','ai_usage_policies','ai_usage_ledger','ai_purpose_profiles','ai_provider_receipts','ai_image_requests','ai_batches','ai_batch_items','ai_field_groups','ai_copy_review_upgrades'],
  images:['image_versions','image_selections','image_write_operations','image_workflow_runs'],
  assets:['assets','hosting_profiles','hosting_uploads','image_reference_pins'],
  publish:['amazon_write_locks','amazon_exchanges','amazon_calls','execution_tasks','listing_corrections','listing_correction_attempts'],
  tasks:['automatic_listing_tasks'],
  observations:['listing_followups'],
  procurement:['procurement_batches'],
  labels:['item_labels'],
  documents:['shipment_documents'],
  connections:['amazon_targets'],
  maintenance:['audit_events','module_migration_journal'],
});
const tableOwners=new Map<string,DataOwner>();
for(const [owner,tables] of Object.entries(MODULE_TABLES))for(const table of tables){
  if(tableOwners.has(table))throw Error(`Duplicate owner for ${table}`);
  tableOwners.set(table,owner as DataOwner);
}
const settingOwners:Readonly<Record<string,DataOwner>>={
  listing_rules_v1:'settings',sku_naming_v1:'sales',listing_copy_review_v1:'listing',
  image_risk_interception_v1:'images',item_label_format_v1:'labels',data_policy:'maintenance',
};
export function dataOwner(table:string,key?:string):DataOwner {
  if(table==='amazon_settings'){
    if(!key)throw new UserFacingError('共享设置必须提供记录键 key');
    if(key.startsWith('accepted_sku_v1:'))return 'publish';
    if(key.startsWith('item_label_download_v1:'))return 'labels';
    if(key.startsWith('item_label_response_v1:'))return 'labels';
    const owner=settingOwners[key];if(owner)return owner;
  }else{const owner=tableOwners.get(table);if(owner)return owner;}
  throw new UserFacingError(`数据所有者未登记：${table}${key?':'+key:''}`);
}
export function assertOwner(owner:DataOwner,table:string,key?:string):void {
  if(dataOwner(table,key)!==owner)throw new UserFacingError(`禁止跨所有者写入：${owner} → ${table}`);
}
