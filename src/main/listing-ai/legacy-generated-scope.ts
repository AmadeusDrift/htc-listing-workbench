import type { DatabaseSync } from 'node:sqlite';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';

/** Only original, atomically recorded image adoptions can be removed from an old source snapshot. */
export function legacyCompletionAssets(db:DatabaseSync,product:ProductDetail,createdAt:string):ProductDetail['assets'] {
  const derived=new Set<string>();
  const rows=db.prepare("SELECT a.id,a.sha256,a.created_at,e.detail_json,w.record_json FROM assets a JOIN audit_events e ON e.product_id=a.product_id AND e.action='image.workflow.adopted' AND json_extract(CASE WHEN json_valid(e.detail_json) THEN e.detail_json ELSE '{}' END,'$.assetId')=a.id AND e.created_at=a.created_at JOIN image_workflow_runs w ON w.id=json_extract(CASE WHEN json_valid(e.detail_json) THEN e.detail_json ELSE '{}' END,'$.workflowId') WHERE a.product_id=? AND a.created_at>?").all(product.id,createdAt);
  for(const row of rows){
    let audit:{slot?:number;attempt?:number;candidateId?:string}|null,run:ImageWorkflowRun|null;
    try { audit=JSON.parse(String(row.detail_json));run=JSON.parse(String(row.record_json)); } catch { continue; }
    if(!audit||!run||!Array.isArray(run.slots)||!Number.isInteger(audit.slot)||audit.slot!<1||!Number.isInteger(audit.attempt)||audit.attempt!<1||typeof audit.candidateId!=='string'||!audit.candidateId)continue;
    const asset=product.assets.find(value=>value.id===row.id),slot=run.slots.find(value=>value?.index===audit.slot);
    if(!slot||!Array.isArray(slot.attempts))continue;
    const attempt=slot.attempts.find(value=>value?.number===audit.attempt);
    if(!asset||run.productId!==product.id||asset.createdAt!==row.created_at||asset.role!=='gallery'||asset.mimeType!=='image/png'||asset.variantIds.length!==1||asset.variantIds[0]!==run.variantId)continue;
    if(!slot||slot.status!=='PASSED'||slot.approvedAssetId!==asset.id||slot.approvedSha256!==row.sha256||attempt?.state!=='PASSED'||attempt.candidateId!==audit.candidateId)continue;
    if(!db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1 AND updated_at=?').get(asset.id,run.variantId,row.created_at))continue;
    derived.add(asset.id);
  }
  return product.assets.filter(asset=>!derived.has(asset.id));
}
