import type { AutomaticListingItem, AutomaticListingOutcome, AutomaticListingTask } from '../../shared/automatic-listing-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ListingRules } from '../../shared/listing-rules.ts';
import { fingerprint } from '../execution/records.ts';
import { assertPricingDecision } from '../listing-ai/history.ts';
import { convertMeasurement } from '../amazon/field-mapping.ts';
import { validateSalesRecipe } from '../sales-plans/records.ts';

export const recipeKey=(row:AutomaticListingItem)=>row.salesPlan?.recipe.key??row.variantId;
export const recipeStamp=(row:AutomaticListingItem)=>fingerprint(row.salesPlan?validateSalesRecipe(row.salesPlan.recipe):{variantId:row.variantId});
export function outcomeScope(task:AutomaticListingTask,row:AutomaticListingItem):AutomaticListingOutcome['scope'] {
  return {mode:task.mode,sellerId:task.sellerId,marketplaceId:task.marketplaceId,productId:row.productId,recipeKey:recipeKey(row),recipeStamp:recipeStamp(row),sourceStamp:row.sourceStamp,rulesStamp:task.rulesStamp,ruleRevision:task.ruleRevision};
}
export function pricingEvidenceCurrent(draft:AmazonDraft,rules:ListingRules):boolean {
  const report=draft.businessRules,decision=report?.pricingDecision;if(!report||!decision||report.revision!==rules.revision)return false;
  try{assertPricingDecision(report,draft);}catch{return false;}
  const entry=(field:string):any=>Array.isArray(draft.attributes[field])&&draft.attributes[field].length===1?draft.attributes[field][0]:null;
  const converted=(value:any,kind:'length'|'weight')=>{if(!value)return null;const result=convertMeasurement(value.value,value.unit,kind);return result.status==='mapped'?result.value:null;};
  const dimensions=entry('item_package_dimensions'),axes=['length','width','height'].map(axis=>converted(dimensions?.[axis],'length'));
  const current={dimensionsInches:axes.every(value=>value!==null)?axes:null,weightPounds:converted(entry('item_package_weight'),'weight')};
  if(JSON.stringify(current.dimensionsInches)!==JSON.stringify(decision.inputs.dimensionsInches)||current.weightPounds!==decision.inputs.weightPounds)return false;
  if(draft.attributes.number_of_items!==undefined&&entry('number_of_items')?.value!==report.bundleQuantity)return false;
  if(report.fields.unit_count&&JSON.stringify(draft.attributes.unit_count)!==JSON.stringify(report.fields.unit_count.value))return false;
  return true;
}
export function pricingOutcome(draft:AmazonDraft,rules:ListingRules):Pick<AutomaticListingOutcome,'kind'|'code'|'pricingReport'>|null {
  const report=draft.businessRules;if(!report)return null;
  if(report.quote)return report.revision!==rules.revision?{kind:'NEEDS_INPUT',code:'PRICING_EVIDENCE_STALE'}:null;
  if(!report.pricingDecision)return {kind:'UNCLASSIFIED',code:'LEGACY_FAILURE'};
  if(!pricingEvidenceCurrent(draft,rules))return {kind:'NEEDS_INPUT',code:'PRICING_EVIDENCE_STALE'};
  const decision=report.pricingDecision;
  return {kind:decision.status==='business_blocked'?'RULE_FILTERED':decision.status==='system_error'?'SYSTEM_REPAIR':'NEEDS_INPUT',code:decision.code,
    pricingReport:{...structuredClone(report),fields:{},notices:[]}};
}
