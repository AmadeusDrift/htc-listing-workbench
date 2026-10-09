import type { SalesListingPlan } from '../../shared/sales-plan-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';

/** Reclassification changes family membership, never the identity of a sale or its image recipe. */
export function reconcileSalesIdentity(previous:SalesListingPlan, proposed:SalesListingPlan):SalesListingPlan {
  const source=(key:string)=>key.replace(/:([a-f0-9]{64})$/u,'');
  if(previous.recipe.key!==proposed.recipe.key||source(previous.sourceGroupKey)!==source(proposed.sourceGroupKey))throw new UserFacingError('重组方案与原销售商品来源不一致');
  if(proposed.parentage!=='CHILD')return structuredClone(previous);
  if(previous.parentage==='CHILD'){
    if(previous.parentSku!==proposed.parentSku||previous.variationTheme!==proposed.variationTheme)throw new UserFacingError('已有父子关系不同，需单独核对后调整');
    return structuredClone(previous);
  }
  if(previous.parentage!=='NONE'||proposed.parentSku!==proposed.baseSku||!proposed.variationTheme||previous.sku===proposed.baseSku)throw new UserFacingError('重组父 SKU 无效');
  return {...structuredClone(previous),familyResolved:true,parentage:'CHILD',parentSku:proposed.parentSku,variationTheme:proposed.variationTheme,
    relationReason:'按已确认的同款颜色或数量重组；原销售 SKU 和图片保持不变',
    familyBinding:{parentNamingGroupId:proposed.namingGroupId,parentSourceGroupKey:proposed.sourceGroupKey,parentBaseSku:proposed.baseSku}};
}
