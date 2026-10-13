import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ListingRules } from '../../shared/listing-rules.ts';
import { ListingQuoteError, quoteListing, listingPriceEvaluator } from '../../shared/listing-rules.ts';
import { isObject } from '../amazon/context.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { assertPricingDecision } from './history.ts';
import { actualOfferIssue, hasActualOffer } from './offer.ts';
import { pricingQuantityInputs, pricingRuleInputs, pricingSaleUnit } from './dependencies.ts';
import { convertMeasurement } from '../amazon/field-mapping.ts';
import { semanticJson } from '../amazon/preparation.ts';
import { pricingAttributeInputs } from '../amazon/pricing-inputs.ts';

export function pricingExempt(draft: AmazonDraft): boolean {
  return draft.listingProgram !== 'haul' || draft.schema?.parentageLevel === 'PARENT';
}
export function pricingEvidenceCurrent(draft: AmazonDraft, rules: ListingRules): boolean {
  const report=draft.businessRules,decision=report?.pricingDecision;
  if (!report || !decision) return false;
  try { assertPricingDecision(report,draft); } catch { return false; }
  if (decision.version === 3) {
    if (decision.dependencies.rules !== pricingRuleInputs(rules,decision.evidence)
      || semanticJson(decision.dependencies.saleUnit) !== semanticJson(pricingSaleUnit(draft.salesPlan?.recipe))
      || semanticJson(decision.dependencies.quantityInputs) !== semanticJson(pricingQuantityInputs(draft.attributes))) return false;
  } else if (report.revision !== rules.revision) return false;
  if (decision.status === 'quoted' && (decision.evidence.saleUnit !== 'confirmed' || draft.salesPlan && report.bundleQuantity !== draft.salesPlan.recipe.totalPieces)) return false;
  const entry=(field:string):any=>Array.isArray(draft.attributes[field])&&draft.attributes[field].length===1?draft.attributes[field][0]:null;
  const converted=(value:any,kind:'length'|'weight')=>{if(!value)return null;const result=convertMeasurement(value.value,value.unit,kind);return result.status==='mapped'?result.value:null;};
  if (decision.version !== 1) {
    if (semanticJson(pricingAttributeInputs(draft.attributes)) !== semanticJson(decision.attributeInputs)) return false;
  } else {
    const dimensions=entry('item_package_dimensions'),axes=['length','width','height'].map(axis=>converted(dimensions?.[axis],'length'));
    if (JSON.stringify(axes.every(value=>value!==null)?axes:null)!==JSON.stringify(decision.inputs.dimensionsInches)
      || converted(entry('item_package_weight'),'weight')!==decision.inputs.weightPounds) return false;
  }
  if (draft.attributes.number_of_items!==undefined && entry('number_of_items')?.value!==report.bundleQuantity) return false;
  if (report.fields.unit_count && semanticJson(draft.attributes.unit_count??null)!==semanticJson(report.fields.unit_count.value)) return false;
  return true;
}
export interface PricingQualificationIssue { code: string; message: string }
/** Runtime qualification is separate from the frozen historical suggestion report. */
export function pricingQualificationIssue(draft: AmazonDraft, rules: ListingRules, now = Date.now()): PricingQualificationIssue | null {
  if (pricingExempt(draft)) return null;
  if (!pricingEvidenceCurrent(draft,rules)) return {code:'PRICING_EVIDENCE_STALE',message:'定价依据缺失或相关输入已变化，请重新应用商品规则后核对实际报价'};
  const report=draft.businessRules!,decision=report.pricingDecision!;
  const historicalIssue = {code:decision.code,message:report.notices.join('；')||'尚无合格的定价依据，请核对成本、包装与销售数量'};
  // A failed automatic suggestion is not proof that a supplied manual offer fails.
  // Unknown input/system failures still cannot establish usable cost and quantity.
  if (!['quoted','business_blocked'].includes(decision.status)) return historicalIssue;
  if (decision.evidence.saleUnit!=='confirmed' || draft.salesPlan && report.bundleQuantity!==draft.salesPlan.recipe.totalPieces)
    return {code:'PRICING_EVIDENCE_STALE',message:'实际报价的销售数量或成本口径尚未确认'};
  const {costCny,dimensionsInches,weightPounds}=decision.inputs;
  if (costCny===null || dimensionsInches===null || weightPounds===null) return {code:'PRICING_EVIDENCE_STALE',message:'实际报价缺少完整成本或包装输入'};
  if (decision.status==='business_blocked' && !hasActualOffer(draft.attributes,draft.marketplaceId)) return historicalIssue;
  const input={costCny,dimensionsInches,weightPounds};
  const actualIssue=actualOfferIssue(draft.attributes,draft.marketplaceId,input,rules.pricing,now);
  if (!actualIssue || actualIssue.code==='ACTUAL_OFFER_INVALID' || actualIssue.code==='ACTUAL_PRICE_INVALID') return actualIssue;
  if (decision.status==='business_blocked') {
    // Distinguish a fixable manual price from a genuinely impossible normal price.
    // This calculation uses only the original numeric rules; it does not create a report.
    try { quoteListing(input,{...rules.pricing,promoEnabled:false}); }
    catch (error) { if (error instanceof ListingQuoteError) return historicalIssue; throw error; }
  }
  return actualIssue;
}
/** Only blocks new work; never mutates a draft, paid journal or submission lock. */
export function assertCurrentPricingForPaid(draft: AmazonDraft, rules: ListingRules, now = Date.now()): void {
  const issue=pricingQualificationIssue(draft,rules,now);
  if (issue) throw new UserFacingError(issue.message);
}
export function qualifiedPricing(draft: AmazonDraft, rules: ListingRules): boolean {
  return !pricingExempt(draft) && pricingEvidenceCurrent(draft,rules) && pricingQualificationIssue(draft,rules)===null;
}

/** Read-only SKU/draft detail; historical suggestions never replace actual offers. */
export function qualifyActualOffer(draft: AmazonDraft, rules: ListingRules, now = Date.now()) {
  const issue=pricingQualificationIssue(draft,rules,now), exempt=pricingExempt(draft);
  const offers: { price:number; promotion:boolean; roi:number; commission:number; deliveryFee:number; upfrontCny:number; profitCny:number; billableWeightGrams:number }[]=[];
  const inputs=draft.businessRules?.pricingDecision?.inputs;
  if (!exempt && issue?.code!=='ACTUAL_OFFER_INVALID' && issue?.code!=='ACTUAL_PRICE_INVALID'
    && pricingEvidenceCurrent(draft,rules) && inputs?.costCny!=null && inputs.dimensionsInches && inputs.weightPounds!=null) {
    try {
      const calculation=listingPriceEvaluator({costCny:inputs.costCny,dimensionsInches:inputs.dimensionsInches,weightPounds:inputs.weightPounds},rules.pricing);
      for (const offer of Array.isArray(draft.attributes.purchasable_offer)?draft.attributes.purchasable_offer:[]) {
        if(!isObject(offer)||offer.currency!=='USD'||offer.audience!=='BZR'||offer.marketplace_id!==undefined&&offer.marketplace_id!==draft.marketplaceId)continue;
        for(const field of ['our_price','discounted_price'] as const) {
          const groups=offer[field]; if(!Array.isArray(groups))continue;
          for(const group of groups) {
            if(!isObject(group)||!Array.isArray(group.schedule))continue;
            for(const schedule of group.schedule) {
              if(!isObject(schedule)||typeof schedule.value_with_tax!=='number'||!Number.isFinite(schedule.value_with_tax)||schedule.value_with_tax<=0)continue;
              if(typeof schedule.end_at==='string'&&Date.parse(schedule.end_at)<=now)continue;
              const value=calculation.evaluate(schedule.value_with_tax);
              offers.push({...value,promotion:field==='discounted_price',upfrontCny:calculation.upfrontCny,profitCny:value.roi*calculation.upfrontCny,billableWeightGrams:calculation.billableWeightGrams});
            }
          }
        }
      }
    } catch(error) { if(!(error instanceof ListingQuoteError))throw error; }
  }
  return {qualified:!exempt&&issue===null,exempt,issue,offers,currency:'USD' as const,costCurrency:'CNY' as const};
}
