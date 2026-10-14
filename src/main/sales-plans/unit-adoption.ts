import type { ProductDetail } from '../../shared/contracts.ts';
import type { SalesRecipe } from '../../shared/sales-plan-contracts.ts';
import { productSourceQuantity, salesUnitIssue } from '../../shared/source-quantity.ts';

/** Inspect already-adopted source semantics without rewriting the saved recipe. */
export function salesUnitReviewNeeded(recipe:SalesRecipe,source:ProductDetail):string|null {
  const issue=salesUnitIssue(recipe);if(issue)return issue;
  if(recipe.quantityVersion===2)return null;
  for(const c of recipe.components){
    const variant=source.variants.find(v=>v.id===c.variantId);
    if(variant&&productSourceQuantity(source,variant).unitSemantics)return '历史套装的报价单位、附件组成与平台件数需分别核对；请查看计量对照并明确采用，原 SKU 不变';
  }
  return null;
}
