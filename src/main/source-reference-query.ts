import type { DatabaseSync } from 'node:sqlite';
export function isProductReference(db:DatabaseSync,productId:string,variantId:string,assetId:string):boolean {
  return !!db.prepare("SELECT 1 FROM audit_events WHERE product_id=? AND action='source-image.product-reference' AND json_extract(detail_json,'$.variantId')=? AND json_extract(detail_json,'$.assetId')=?").get(productId,variantId,assetId);
}
