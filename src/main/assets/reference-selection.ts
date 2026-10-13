import type { ProductDetail,Asset } from '../../shared/contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
export function selectImageReferences(product: ProductDetail, variantId: string, derived: Set<string>, confirmed: (assetId: string, variantId: string) => boolean, allowUnboundSingleSku = false, sourceVariantIds = [variantId], maximum=sourceVariantIds.length>1?10:3): Asset[] {
  if (!product.variants.some(v => v.id === variantId)) throw new UserFacingError('商品 SKU 已变化');
  if(!sourceVariantIds.length||new Set(sourceVariantIds).size!==sourceVariantIds.length||sourceVariantIds.some(id=>!product.variants.some(v=>v.id===id)))throw new UserFacingError('销售组合来源 SKU 已变化');
  const belongs=(asset:Asset,id:string)=>asset.variantIds.includes(id)?confirmed(asset.id,id):allowUnboundSingleSku&&product.variants.length===1&&asset.variantIds.length===0;
  const refs = product.assets.filter(asset => !derived.has(asset.id) && sourceVariantIds.some(id=>belongs(asset,id))).sort((a,b) => Number(b.variantIds.length === 1) - Number(a.variantIds.length === 1) || Number(b.role === 'main') - Number(a.role === 'main') || a.createdAt.localeCompare(b.createdAt));
  let bytes = 0;
  const selected:Asset[]=[];
  const add=(asset:Asset)=>{if(selected.some(value=>value.id===asset.id))return true;if(selected.length>=maximum||asset.byteSize>10*1024*1024||bytes+asset.byteSize>20*1024*1024)return false;selected.push(asset);bytes+=asset.byteSize;return true;};
  for(const id of sourceVariantIds)if(!selected.some(asset=>belongs(asset,id))&&!refs.some(asset=>belongs(asset,id)&&add(asset)))throw new UserFacingError('销售组合的每个来源 SKU 均需确认参考图，当前缺图或超出参考预算');
  for(const asset of refs)add(asset);
  if (!selected.length) throw new UserFacingError('缺少可确定属于当前 SKU 的参考图，请先完成来源图片同步');
  return selected;
}

