import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ListingRules } from '../../shared/listing-rules.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { assertPricingDecision } from './history.ts';
import { actualOfferIssue } from './offer.ts';
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
  if (decision.status !== 'quoted' || !report.quote) return {code:decision.code,message:report.notices.join('；')||'尚无合格的定价依据，请核对成本、包装与销售数量'};
  const {costCny,dimensionsInches,weightPounds}=decision.inputs;
  if (costCny===null || dimensionsInches===null || weightPounds===null) return {code:'PRICING_EVIDENCE_STALE',message:'实际报价缺少完整成本或包装输入'};
  return actualOfferIssue(draft.attributes,draft.marketplaceId,{costCny,dimensionsInches,weightPounds},rules.pricing,now);
}
/** Only blocks new work; never mutates a draft, paid journal or submission lock. */
export function assertCurrentPricingForPaid(draft: AmazonDraft, rules: ListingRules, now = Date.now()): void {
  const issue=pricingQualificationIssue(draft,rules,now);
  if (issue) throw new UserFacingError(issue.message);
}
export function qualifiedPricing(draft: AmazonDraft, rules: ListingRules): boolean {
  return !!draft.businessRules?.quote && draft.businessRules.pricingDecision?.status==='quoted'
    && pricingEvidenceCurrent(draft,rules) && pricingQualificationIssue(draft,rules)===null;
}
