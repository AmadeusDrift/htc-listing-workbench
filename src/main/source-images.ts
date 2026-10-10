import type { DatabaseSync } from 'node:sqlite';
import type { CollectionReceipt } from '../shared/collection-contracts.ts';
import type { MiaoshouReceipt } from '../shared/miaoshou-contracts.ts';
import type { ProductDetail } from '../shared/contracts.ts';
import { getReceipt } from './miaoshou/persistence.ts';
import { validateCollectionReceipt } from './collection/validation.ts';
import { UserFacingError } from '../shared/errors.ts';

export type SourceImageReceipt = {kind:'native1688';receipt:CollectionReceipt} | {kind:'miaoshou';receipt:MiaoshouReceipt};
export class SourceImageIdentityError extends UserFacingError {}
export function sourceImageReceipt(native:CollectionReceipt|null|undefined,miaoshou:MiaoshouReceipt|null|undefined):SourceImageReceipt|null {
  if(native&&miaoshou)throw new SourceImageIdentityError('来源身份不明确：同时存在两种来源回执，请核对来源记录');
  return native?{kind:'native1688',receipt:native}:miaoshou?{kind:'miaoshou',receipt:miaoshou}:null;
}
export function readSourceImageReceipt(db:DatabaseSync,productId:string):SourceImageReceipt|null {
  return sourceImageReceipt(readNativeImageReceipt(db,productId),getReceipt(db,productId));
}
export function readNativeImageReceipt(db:DatabaseSync,productId:string):CollectionReceipt|null {
  const rows=db.prepare("SELECT id,record_json FROM collection_receipts WHERE json_extract(record_json,'$.productId')=?").all(productId);
  if(!rows.length)return null;
  if(rows.length!==1)throw new UserFacingError('来源回执身份不明确');
  const receipt=validateCollectionReceipt(JSON.parse(String(rows[0].record_json)));
  if(receipt.id!==rows[0].id||receipt.productId!==productId)throw new UserFacingError('来源回执身份已变化');
  return receipt;
}
export function sourceImageMappings(source:SourceImageReceipt) {
  if(source.kind==='miaoshou')return source.receipt.skuMappings.map(m=>({localVariantId:m.localVariantId,sourceSku:m.sourceKey,images:m.imageIds.map(imageId=>({imageId,basis:'miaoshou-mapping' as const,specName:null,specValue:null}))}));
  const {receipt}=source;
  return receipt.skuMappings.map(m=>({localVariantId:m.localVariantId,sourceSku:m.providerSkuId,images:receipt.snapshot.skuImages.filter(i=>i.providerSkuId===m.providerSkuId).map(i=>({imageId:i.imageId,basis:i.basis,specName:i.specName,specValue:i.specValue}))}));
}
export function allowSourceUnbound(product:ProductDetail,source:SourceImageReceipt|null):boolean {
  if(product.variants.length!==1)return false;
  if(!source)return true;
  if(source.kind==='native1688')return false;
  return source.receipt.snapshot.skus.length===1&&source.receipt.skuMappings.every(m=>m.localVariantId===product.variants[0].id);
}
