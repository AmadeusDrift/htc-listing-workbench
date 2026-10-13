export { isProductReference } from './source-reference-query.ts';
import { isProductReference } from './source-reference-query.ts';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { validateStoredImageWorkflowRun } from './image-workflow/records.ts';
import { listingFingerprint } from "./json-fingerprint.ts";
import { validateConsistencyDecision } from './source-image-consistency/history.ts';

/** SAVEPOINT also works while getProduct is called inside a store transaction. */
function atomicAttribution(db:DatabaseSync,write:()=>void):void {
  db.exec('SAVEPOINT source_image_attribution');
  try{write();db.exec('RELEASE source_image_attribution');}
  catch(error){db.exec('ROLLBACK TO source_image_attribution');db.exec('RELEASE source_image_attribution');throw error;}
}
function explicitlyCorrected(db:DatabaseSync,productId:string,assetId:string,variantId:string,since=''):boolean {
  const row=db.prepare("SELECT detail_json FROM audit_events WHERE product_id=? AND action='asset.updated' AND created_at>=? AND json_extract(detail_json,'$.after.assetId')=? ORDER BY rowid DESC LIMIT 1").get(productId,since,assetId);
  if(!row)return false;
  const after=JSON.parse(String(row.detail_json)).after;
  return !after.variantIds.includes(variantId)||after.confirmed===false||after.confirmed===0;
}
function confirmBinding(db:DatabaseSync,assetId:string,variantId:string,at:string):void {
  db.prepare('INSERT INTO variant_assets VALUES(?,?,1,?) ON CONFLICT(asset_id,variant_id) DO UPDATE SET confirmed=1,updated_at=excluded.updated_at').run(assetId,variantId,at);
}
/** Metadata repair must not change an already decided association epoch. The normal
 * source-proof path still checks the current specification; this creates no new authority. */
function hasDecidedAssociation(db:DatabaseSync,productId:string,variantId:string,assetId:string):boolean {
  const asset=db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
  if(!asset)return false;
  const binding=db.prepare('SELECT * FROM variant_assets WHERE asset_id=? AND variant_id=?').get(assetId,variantId);
  const epoch=db.prepare("SELECT id FROM source_consistency_bindings WHERE json_extract(record_json,'$.productId')=? AND json_extract(record_json,'$.variantId')=? AND json_extract(record_json,'$.assetId')=? ORDER BY rowid DESC LIMIT 1").get(productId,variantId,assetId);
  const bindingEpoch=listingFingerprint({epoch:epoch?.id??null,binding:binding??null,role:asset.role});
  return db.prepare("SELECT record_json FROM source_consistency_decisions WHERE json_extract(record_json,'$.context.productId')=? AND json_extract(record_json,'$.context.variantId')=?").all(productId,variantId).some(row=>{
    const decision=validateConsistencyDecision(JSON.parse(String(row.record_json)));
    return decision.context.referenceAssets.some(ref=>ref.assetId===assetId&&ref.sha256===asset.sha256&&ref.byteSize===asset.byte_size&&ref.bindingEpoch===bindingEpoch);
  });
}

/** Recover association metadata from the actual saved generation owner, including frozen runs.
 * No visual or byte-equality attribution gate: the generation reference is the authority.
 * Existing generated assets and explicit later user corrections remain untouched. */
export function restoreWorkflowSourceBindings(db:DatabaseSync,productId:string):void {
  const rows=db.prepare("SELECT record_json FROM image_workflow_runs WHERE json_extract(record_json,'$.productId')=? ORDER BY rowid DESC").all(productId);
  if(!rows.length)return;
  const runs=rows.flatMap(row=>{try{return [validateStoredImageWorkflowRun(JSON.parse(String(row.record_json)))];}catch{return [];}});
  const generated=new Set(runs.flatMap(run=>[run.approvedAssetId,...(run.slots??[]).map(s=>s.approvedAssetId)].filter(Boolean)));
  for(const run of runs)for(const ref of run.referenceAssets){
    if(run.status==='RUNNING')continue;
    if(generated.has(ref.id))continue;
    const explicit=run.imageContext?.referenceAssets.find(a=>a.assetId===ref.id);
    const variantId=explicit?.variantId??run.variantId;
    const asset=db.prepare('SELECT product_id FROM assets WHERE id=?').get(ref.id),variant=db.prepare('SELECT product_id FROM variants WHERE id=?').get(variantId);
    if(asset?.product_id!==productId||variant?.product_id!==productId)continue;
    if(db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=? AND variant_id=?').get(ref.id,variantId)?.confirmed===1)continue;
    if(explicitlyCorrected(db,productId,ref.id,variantId,run.createdAt))continue;
    if(hasDecidedAssociation(db,productId,variantId,ref.id))continue;
    const at=new Date().toISOString();
    atomicAttribution(db,()=>{
      confirmBinding(db,ref.id,variantId,at);
      db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),productId,'source-image.upstream-restored','沿用生成任务的 SKU 原图引用',JSON.stringify({basis:'workflow-reference',workflowId:run.id,variantId,assetId:ref.id}),at);
    });
  }
}

/** Product references support the selected specification, without claiming an exact thumbnail. */
export function bindProductReference(db:DatabaseSync,input:{productId:string;variantId:string;assetId:string;imageId:string;sourceSku:string;spec:string}):void {
  if(explicitlyCorrected(db,input.productId,input.assetId,input.variantId))return;
  const binding=db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=? AND variant_id=?').get(input.assetId,input.variantId);
  const scoped=isProductReference(db,input.productId,input.variantId,input.assetId);
  if(binding?.confirmed===1&&scoped)return;
  const at=new Date().toISOString();
  atomicAttribution(db,()=>{
    confirmBinding(db,input.assetId,input.variantId,at);
    if(!scoped)db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),input.productId,'source-image.product-reference','商品参考图＋所选 SKU 规格',JSON.stringify({basis:'product-reference+selected-spec',...input}),at);
  });
}
