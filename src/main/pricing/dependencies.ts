import type { JsonObject, JsonValue } from '../../shared/amazon-contracts.ts';
import type { ListingRules, PricingDecision } from '../../shared/listing-rules.ts';
import { defaultListingRules, parseListingRules } from '../../shared/listing-rules.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { attributesObject, isObject } from '../amazon/context.ts';
import type { SalesRecipe } from '../../shared/sales-plan-contracts.ts';
import { semanticJson } from '../amazon/preparation.ts';

/** Excludes global revision, brand, stock, copy and images. */
export function pricingRuleInputs(rules: ListingRules, evidence: Pick<PricingDecision['evidence'],'dimensions'|'weight'>): string {
  const p = rules.product;
  return semanticJson({ pricing: rules.pricing as unknown as JsonValue, packageDefaults: {
    ...(evidence.dimensions==='business_default'?{dimensionFallback:p.dimensionFallback,dimensions:p.dimensions,dimensionUnit:p.dimensionUnit}:{}),
    ...(evidence.weight==='business_default'?{weightFallback:p.weightFallback,packageWeight:p.packageWeight,weightUnit:p.weightUnit}:{}),
  } });
}
/** Strictly parse only the prospective dependency format; no historical data upgrade. */
export function readPricingRuleInputs(value: string, evidence: Pick<PricingDecision['evidence'],'dimensions'|'weight'>): ListingRules {
  const snapshot=attributesObject(JSON.parse(value));
  if (!isObject(snapshot.packageDefaults)) throw new UserFacingError('定价规则依赖格式无效');
  const defaults=defaultListingRules();
  const rules=parseListingRules({...defaults,pricing:snapshot.pricing,product:{...defaults.product,...snapshot.packageDefaults}});
  if (pricingRuleInputs(rules,evidence)!==value) throw new UserFacingError('定价规则依赖格式无效');
  return rules;
}
export function pricingSaleUnit(recipe?: Pick<SalesRecipe, 'totalPieces' | 'totalCostCny'> & Partial<Pick<SalesRecipe, 'components'>>): JsonValue {
  if (!recipe) return null;
  return { totalPieces: recipe.totalPieces, totalCostCny: recipe.totalCostCny,
    components: recipe.components?.map(c => ({ variantId: c.variantId, quantity: c.quantity,
      quotedCostCny: c.quotedCostCny, piecesPerQuote: c.piecesPerQuote, sourcePackPieces: c.sourcePackPieces })) ?? null };
}
export function pricingQuantityInputs(attributes: JsonObject): JsonObject {
  return Object.fromEntries(['number_of_items','unit_count'].filter(key => Object.hasOwn(attributes,key)).map(key => [key,structuredClone(attributes[key])]));
}
