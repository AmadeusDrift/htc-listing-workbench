import type { AutomaticListingItem, AutomaticListingOutcome, AutomaticListingTask } from '../../shared/automatic-listing-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ListingRules } from '../../shared/listing-rules.ts';
import { fingerprint } from '../execution/records.ts';
import { validateSalesRecipe } from '../sales-plans/records.ts';
import { pricingEvidenceCurrent, pricingExempt, pricingQualificationIssue } from '../pricing/qualification.ts';
export { pricingEvidenceCurrent, assertCurrentPricingForPaid, qualifiedPricing } from '../pricing/qualification.ts';

export const recipeKey=(row:AutomaticListingItem)=>row.salesPlan?.recipe.key??row.variantId;
export const recipeStamp=(row:AutomaticListingItem)=>fingerprint(row.salesPlan?validateSalesRecipe(row.salesPlan.recipe):{variantId:row.variantId});
export function outcomeScope(task:AutomaticListingTask,row:AutomaticListingItem):AutomaticListingOutcome['scope'] {
  return {mode:task.mode,sellerId:task.sellerId,marketplaceId:task.marketplaceId,productId:row.productId,recipeKey:recipeKey(row),recipeStamp:recipeStamp(row),sourceStamp:row.sourceStamp,rulesStamp:task.rulesStamp,ruleRevision:task.ruleRevision};
}
export function pricingOutcome(draft:AmazonDraft,rules:ListingRules):Pick<AutomaticListingOutcome,'kind'|'code'|'pricingReport'>|null {
  if(pricingExempt(draft))return null;
  const report=draft.businessRules;
  if(!report||!pricingEvidenceCurrent(draft,rules))return {kind:'NEEDS_INPUT',code:'PRICING_EVIDENCE_STALE'};
  const decision=report.pricingDecision!;
  if(report.quote){
    const issue=pricingQualificationIssue(draft,rules);
    return issue?{kind:'NEEDS_INPUT',code:issue.code}:null;
  }
  return {kind:decision.status==='business_blocked'?'RULE_FILTERED':decision.status==='system_error'?'SYSTEM_REPAIR':'NEEDS_INPUT',code:decision.code,
    pricingReport:{...structuredClone(report),fields:{},notices:[]}};
}
