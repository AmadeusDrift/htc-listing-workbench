import type { DatabaseSync } from 'node:sqlite';

/** Exclusion only: a derived image must never become a supplier original. Read
 * references across every draft/status, intersect with actual product assets,
 * and return no workflow proof. Business use still validates workflowRuns.
 * json_each includes duplicate/escaped reference keys: exclusion is conservative,
 * never first-key selection that could hide a later derived-asset reference. */
export function derivedAssetIdsForProduct(db:DatabaseSync,productId:string):Set<string>{
  const rows=db.prepare(`WITH generated(asset_id) AS MATERIALIZED (
      SELECT member.value FROM image_workflow_runs AS workflow,json_each(workflow.record_json) AS member
      WHERE member.key='approvedAssetId' AND member.type='text'
      UNION ALL
      SELECT member.value FROM image_workflow_runs AS workflow,json_each(workflow.record_json) AS root,
        json_each(CASE WHEN root.key='slots' AND root.type='array' THEN root.value ELSE '[]' END) AS slot,
        json_each(CASE WHEN slot.type='object' THEN slot.value ELSE '{}' END) AS member
      WHERE member.key='approvedAssetId' AND member.type='text'
    ) SELECT DISTINCT asset.id FROM generated
      JOIN assets AS asset ON asset.id=generated.asset_id WHERE asset.product_id=?`).all(productId);
  return new Set(rows.map(row=>String(row.id)));
}
