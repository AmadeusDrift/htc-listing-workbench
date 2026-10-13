import type { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from '../../shared/errors.ts';

/** M02 association command; the caller supplies its already checked attribution evidence. */
export function confirmAssetBinding(db:DatabaseSync,input:{productId:string;assetId:string;variantId:string;at:string}):void {
  if(!db.isTransaction)throw new UserFacingError('素材关联必须加入调用方事务');
  const {productId,assetId,variantId,at}=input;
  if(db.prepare('SELECT product_id FROM assets WHERE id=?').get(assetId)?.product_id!==productId
    ||db.prepare('SELECT product_id FROM variants WHERE id=?').get(variantId)?.product_id!==productId)throw new UserFacingError('素材与规格必须属于当前商品');
  db.prepare('INSERT INTO variant_assets VALUES(?,?,1,?) ON CONFLICT(asset_id,variant_id) DO UPDATE SET confirmed=1,updated_at=excluded.updated_at').run(assetId,variantId,at);
}
