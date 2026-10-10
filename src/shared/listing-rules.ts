import { UserFacingError } from './errors.ts';
import type { JsonValue } from './amazon-contracts.ts';

export interface DeliveryTier { upperOz: number | null; apparel: number; ordinary: number }
export interface PricingRules {
  fx: number; inboundCost: number; packingCost: number; targetRoi: number; margin: number; maxPrice: number;
  commissionPercent: number; commissionMinimum: number; reservePercent: number; apparel: boolean;
  lowPriceThreshold: number; lowPriceFee: number; deliveryTiers: DeliveryTier[];
  dimensionalDivisor: number; maxDimensionalWeightGrams: number;
  bundleEnabled: boolean; bundleThresholdUsd: number; bundleCapUsd: number; bundleSizes: number[];
  promoEnabled: boolean; promoDiscount: number; promoDelayDays: number; promoDays: number;
}
export interface ProductRules {
  brand: string; manufacturers: Record<string, string>; targetShops: Record<string, string>;
  listPrice: number; dimensionFallback: boolean; dimensions: [number, number, number]; dimensionUnit: 'cm' | 'inches';
  weightFallback: boolean; packageWeight: number; weightUnit: 'g' | 'pounds';
  ordinaryDeclarations: boolean; stockSets: number; variantLimit: number;
}
export interface ListingRules { version: 1 | 2; revision: number; product: ProductRules; pricing: PricingRules }
export interface ListingRulesApi { getListingRules(): Promise<ListingRules>; saveListingRules(input: ListingRules): Promise<ListingRules> }

export function defaultListingRules(): ListingRules {
  return { version: 2, revision: 0, product: {
    brand: 'Generic', manufacturers: { U8: 'Seannel', U2: 'EQUICK', U6: 'Lancholy' }, targetShops: {}, listPrice: 19.9,
    dimensionFallback: true, dimensions: [5,5,5], dimensionUnit: 'cm', weightFallback: true, packageWeight: 100, weightUnit: 'g',
    ordinaryDeclarations: true, stockSets: 5, variantLimit: 20,
  }, pricing: {
    fx: 7, inboundCost: 1, packingCost: 0.3, targetRoi: 1, margin: 0.1, maxPrice: 3,
    commissionPercent: 15, commissionMinimum: 0.3, reservePercent: 5, apparel: false,
    lowPriceThreshold: 3, lowPriceFee: 0.5,
    deliveryTiers: [[4,.99,.88],[8,2.05,1.77],[12,2.84,2.60],[16,3.48,3.22],[20,4.14,3.72],[24,4.90,4.42],
      [28,5.60,5.11],[32,6.31,5.81],[40,7.27,6.83],[48,8.70,8.19],[56,10.07,9.59],[64,11.15,11.05],[null,12.23,12.51]]
      .map(([upperOz, apparel, ordinary]) => ({ upperOz, apparel: apparel!, ordinary: ordinary! })),
    dimensionalDivisor: 139, maxDimensionalWeightGrams: 110,
    bundleEnabled: true, bundleThresholdUsd: 0.1, bundleCapUsd: 0.45, bundleSizes: [10,5,4],
    promoEnabled: true, promoDiscount: 0.1, promoDelayDays: 1, promoDays: 7,
  } };
}
function fail(message = '商品或定价规则格式无效'): never { throw new UserFacingError(message); }
function obj(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || Object.keys(data).some(key => !keys.includes(key))) return fail();
  return data;
}
function num(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return fail('规则数值超出允许范围');
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return fail(); return value; }
function label(value: unknown, max = 100): string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) return fail('规则名称不能为空或包含控制字符'); return value.trim(); }
function dictionary(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) return fail();
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key) || ['__proto__','constructor','prototype'].includes(key)) return fail('店铺编号格式无效');
    result[key] = label(entry);
  }
  return result;
}
export function parseListingRules(raw: unknown): ListingRules {
  const defaults = defaultListingRules(), value = obj(raw, Object.keys(defaults));
  if (value.version !== 1 && value.version !== 2) return fail('规则来自不支持的版本');
  const p = obj(value.product, Object.keys(defaults.product)), r = obj(value.pricing, Object.keys(defaults.pricing));
  if (!['cm','inches'].includes(String(p.dimensionUnit)) || !['g','pounds'].includes(String(p.weightUnit))) return fail('尺寸或重量单位无效');
  if (!Array.isArray(p.dimensions) || p.dimensions.length !== 3) return fail('需要完整的长、宽、高');
  if (!Array.isArray(r.deliveryTiers) || r.deliveryTiers.length < 2 || r.deliveryTiers.length > 50) return fail('配送费档位需要 2–50 行');
  let previous = 0;
  const deliveryTiers = r.deliveryTiers.map((rawTier, index) => {
    const tier = obj(rawTier, ['upperOz','apparel','ordinary']);
    const last = index === (r.deliveryTiers as unknown[]).length - 1;
    const upperOz = last ? null : num(tier.upperOz, 0.001, 100000);
    if (last ? tier.upperOz !== null : upperOz! <= previous) return fail('配送重量上界须递增，最后一档为以上');
    if (upperOz !== null) previous = upperOz;
    return { upperOz, apparel: num(tier.apparel, 0, 10000), ordinary: num(tier.ordinary, 0, 10000) };
  });
  if (!Array.isArray(r.bundleSizes) || !r.bundleSizes.length || r.bundleSizes.length > 20) return fail('组套候选需要 1–20 个件数');
  const bundleSizes = r.bundleSizes.map(value => num(value, 2, 1000, true));
  if (new Set(bundleSizes).size !== bundleSizes.length) return fail('组套候选件数不能重复');
  const result: ListingRules = { version: 2, revision: num(value.revision, 0, Number.MAX_SAFE_INTEGER - 1, true), product: {
    brand: label(p.brand), manufacturers: dictionary(p.manufacturers), targetShops: dictionary(p.targetShops), listPrice: num(p.listPrice, 0, 10000),
    dimensionFallback: bool(p.dimensionFallback), dimensions: p.dimensions.map(value => num(value, .001, 10000)) as [number,number,number], dimensionUnit: p.dimensionUnit as ProductRules['dimensionUnit'],
    weightFallback: bool(p.weightFallback), packageWeight: num(p.packageWeight, .001, 100000), weightUnit: p.weightUnit as ProductRules['weightUnit'],
    ordinaryDeclarations: bool(p.ordinaryDeclarations), stockSets: num(p.stockSets, 0, 999999, true), variantLimit: value.version === 1 && p.variantLimit === 3 ? 20 : num(p.variantLimit, 1, 200, true),
  }, pricing: {
    fx: num(r.fx, .001, 10000), inboundCost: num(r.inboundCost, 0, 100000), packingCost: num(r.packingCost, 0, 100000), targetRoi: num(r.targetRoi, 0, 100),
    margin: num(r.margin, 0, 1000), maxPrice: num(r.maxPrice, .01, 1000), commissionPercent: num(r.commissionPercent, 0, 99.99), commissionMinimum: num(r.commissionMinimum, 0, 1000), reservePercent: num(r.reservePercent, 0, 99.99), apparel: bool(r.apparel),
    lowPriceThreshold: num(r.lowPriceThreshold, .01, 1000), lowPriceFee: num(r.lowPriceFee, 0, 10000), deliveryTiers,
    dimensionalDivisor: num(r.dimensionalDivisor, .001, 100000), maxDimensionalWeightGrams: num(r.maxDimensionalWeightGrams, .001, 100000),
    bundleEnabled: bool(r.bundleEnabled), bundleThresholdUsd: num(r.bundleThresholdUsd, 0, 1000), bundleCapUsd: num(r.bundleCapUsd, .001, 10000), bundleSizes,
    promoEnabled: bool(r.promoEnabled), promoDiscount: num(r.promoDiscount, 0, 1000), promoDelayDays: num(r.promoDelayDays, 0, 365, true), promoDays: num(r.promoDays, 1, 365, true),
  } };
  if (result.pricing.commissionPercent + result.pricing.reservePercent >= 100) return fail('佣金和其他扣减比例之和必须小于 100%');
  if (result.pricing.promoEnabled && result.pricing.promoDiscount >= result.pricing.maxPrice) return fail('促销降价额须小于售价上限');
  return result;
}

export const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
export interface QuoteInput { costCny: number; dimensionsInches: [number, number, number]; weightPounds: number }
export const QUOTE_FAILURE_CODES = ['QUOTE_INVALID_INPUT', 'DIMENSIONAL_WEIGHT_LIMIT', 'ROI_MAX_PRICE', 'ROI_PROMOTION_OR_MARGIN'] as const;
export type QuoteFailureCode = typeof QUOTE_FAILURE_CODES[number];
export class ListingQuoteError extends UserFacingError {
  readonly code: QuoteFailureCode;
  constructor(code: QuoteFailureCode, message: string) { super(message); this.name = 'ListingQuoteError'; this.code = code; }
}
export type PricingDecisionCode = 'QUOTE_VALID' | QuoteFailureCode | 'COST_CNY_UNCONFIRMED' | 'MARKETPLACE_UNSUPPORTED'
  | 'PACKAGE_MEASUREMENTS_MISSING' | 'PACKAGE_INPUT_UNCONFIRMED' | 'PACKAGE_SCOPE_UNCONFIRMED'
  | 'SOURCE_QUANTITY_CONFLICT' | 'SOURCE_QUANTITY_UNCONFIRMED' | 'LEGACY_QUANTITY_CONFLICT' | 'SALE_QUANTITY_CHANGED' | 'PRICING_SYSTEM_ERROR';
export type PackageInputBasis = 'confirmed_source' | 'business_default' | 'unverified' | 'missing' | 'conflicting';
export interface PricingPackageInputs { dimensionsInches: [number, number, number] | null; weightPounds: number | null }
/** Evidence describes the inputs to this attempt, not the current editable draft. */
export interface PricingDecision {
  version: 1;
  status: 'quoted' | 'business_blocked' | 'needs_input' | 'system_error';
  code: PricingDecisionCode;
  quoteError: QuoteFailureCode | null;
  inputs: PricingPackageInputs & { costCny: number | null };
  evidence: {
    cost: 'confirmed_cny' | 'unconfirmed';
    dimensions: PackageInputBasis; weight: PackageInputBasis;
    packageScope: 'source_sale_unit' | 'unconfirmed';
    saleUnit: 'confirmed' | 'conflicting' | 'unconfirmed';
    /** Current confirmed source values, mapped through the same Schema/unit conversions. */
    sourcePackage: PricingPackageInputs;
  };
}
export interface ListingQuote { price: number; minimum: number; roi: number; deliveryFee: number; commission: number; upfrontCny: number; dimensionalWeightGrams: number; billableWeightGrams: number; promotionPrice: number | null; promotionRoi: number | null }
export interface ListingPricingBasis {
  kind: 'source_sale_unit' | 'source_piece_quote' | 'auto_bundle';
  sourceCostCny: number; quantity: number; saleUnitCostCny: number;
}
export interface BusinessRuleReport {
  revision: number; fields: Record<string, { value: JsonValue; reason: string }>;
  notices: string[]; quote: ListingQuote | null; bundleQuantity: number;
  pricingBasis?: ListingPricingBasis;
  pricingDecision?: PricingDecision;
}
export function quoteListing(input: QuoteInput, rules: PricingRules): ListingQuote {
  const { costCny, dimensionsInches, weightPounds } = input;
  if (!Number.isFinite(costCny) || costCny <= 0 || !Number.isFinite(weightPounds) || weightPounds <= 0 || dimensionsInches.length !== 3 || dimensionsInches.some(value => !Number.isFinite(value) || value <= 0)) throw new ListingQuoteError('QUOTE_INVALID_INPUT', '定价需要有效采购成本、完整包装尺寸和包装重量');
  const dimensionalWeightGrams = dimensionsInches.reduce((a,b) => a*b, 1) / rules.dimensionalDivisor * 453.59237;
  if (dimensionalWeightGrams > rules.maxDimensionalWeightGrams + 1e-8) throw new ListingQuoteError('DIMENSIONAL_WEIGHT_LIMIT', `包装抛重 ${round2(dimensionalWeightGrams)} g 超出上限 ${rules.maxDimensionalWeightGrams} g`);
  const billableWeightGrams = Math.max(weightPounds * 453.59237, dimensionalWeightGrams), oz = billableWeightGrams / 28.349523125;
  const upfrontCny = costCny + rules.inboundCost + rules.packingCost;
  const evaluate = (price: number) => {
    const tier = rules.deliveryTiers.find(tier => tier.upperOz === null || oz <= tier.upperOz + 1e-10)!;
    const small = oz <= rules.deliveryTiers[0].upperOz! + 1e-10;
    const deliveryFee = small && price <= rules.lowPriceThreshold ? rules.lowPriceFee : tier[rules.apparel ? 'apparel' : 'ordinary'];
    const commission = Math.max(price * rules.commissionPercent / 100, rules.commissionMinimum);
    const roi = (rules.fx * (price * (1 - rules.reservePercent / 100) - commission - deliveryFee) - upfrontCny) / upfrontCny;
    return { price, roi, deliveryFee, commission };
  };
  const cap = Math.floor(rules.maxPrice * 100 + 1e-8); let minimum: number | null = null;
  for (let cents = 1; cents <= cap; cents++) if (evaluate(cents / 100).roi > rules.targetRoi + 1e-10) { minimum = cents / 100; break; }
  if (minimum === null) throw new ListingQuoteError('ROI_MAX_PRICE', '售价上限内无法满足目标 ROI，请核对采购成本、包装参数或定价设置');
  for (let cents = Math.ceil((minimum + rules.margin) * 100 - 1e-8); cents <= cap; cents++) {
    const normal = evaluate(cents / 100), promotionPrice = rules.promoEnabled ? round2(normal.price - rules.promoDiscount) : null;
    const promotion = promotionPrice === null ? null : evaluate(promotionPrice);
    if (normal.roi <= rules.targetRoi + 1e-10 || (promotion && (promotion.price <= 0 || promotion.roi <= rules.targetRoi + 1e-10))) continue;
    return { ...normal, minimum, upfrontCny, dimensionalWeightGrams, billableWeightGrams, promotionPrice, promotionRoi: promotion?.roi ?? null };
  }
  throw new ListingQuoteError('ROI_PROMOTION_OR_MARGIN', '加价或促销后的报价无法同时满足 ROI 和售价上限');
}
export function bundleQuantity(costCny: number, skuCount: number, rules: PricingRules): number {
  if (!rules.bundleEnabled || skuCount !== 1 || !Number.isFinite(costCny) || costCny <= 0 || costCny / rules.fx >= rules.bundleThresholdUsd) return 1;
  return rules.bundleSizes.find(size => costCny / rules.fx * size <= rules.bundleCapUsd + 1e-10) ?? 1;
}
export function promotionSchedule(now: Date, rules: PricingRules): { start: string; end: string } {
  const offset = 8 * 3600000, local = new Date(now.getTime() + offset);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset;
  const start = midnight + rules.promoDelayDays * 86400000;
  return { start: new Date(start).toISOString(), end: new Date(start + rules.promoDays * 86400000).toISOString() };
}
