import type { JsonObject, JsonValue } from '../../shared/amazon-contracts.ts';
import { actualListingPriceFailure, ListingQuoteError } from '../../shared/listing-rules.ts';
import type { ActualPriceFailureCode, QuoteInput, PricingRules } from '../../shared/listing-rules.ts';
import { isObject } from '../amazon/context.ts';

export type ActualOfferCode = ActualPriceFailureCode | 'ACTUAL_OFFER_INVALID';
export interface ActualOfferIssue { code: ActualOfferCode; message: string }
export const ACTUAL_OFFER_CODES: readonly ActualOfferCode[] = ['ACTUAL_OFFER_INVALID','ACTUAL_PRICE_INVALID','ACTUAL_PRICE_CAP','ACTUAL_PRICE_ROI','ACTUAL_PRICE_MARGIN'];

/** Validate every supplied Haul schedule, including promotions when generation is off. */
export function actualOfferIssue(attributes: JsonObject, marketplaceId: string, input: QuoteInput, rules: PricingRules, now = Date.now()): ActualOfferIssue | null {
  const invalid = (path: string, detail: string): ActualOfferIssue => ({ code:'ACTUAL_OFFER_INVALID', message:`实际报价 ${path}：${detail}` });
  const offers = attributes.purchasable_offer;
  if (marketplaceId !== 'ATVPDKIKX0DER' || !Array.isArray(offers) || !offers.length) return invalid('purchasable_offer','需要当前美国站的完整美元报价');
  const prices: { value:number; promotion:boolean; path:string }[] = [];
  const validScope = (value: JsonObject) => (value.currency===undefined||value.currency==='USD')
    && (value.audience===undefined||value.audience==='BZR') && (value.marketplace_id===undefined||value.marketplace_id===marketplaceId);
  for (const [i, offer] of offers.entries()) {
    const path = `purchasable_offer[${i}]`;
    if (!isObject(offer) || offer.currency !== 'USD' || offer.audience !== 'BZR'
      || offer.marketplace_id !== undefined && offer.marketplace_id !== marketplaceId) return invalid(path,'币种须为 USD、受众须为 BZR，站点须与当前草稿一致');
    for (const field of ['our_price','discounted_price'] as const) {
      if (field === 'discounted_price' && !Object.hasOwn(offer,field)) continue;
      const groups = offer[field];
      if (!Array.isArray(groups) || !groups.length) return invalid(`${path}.${field}`,'缺少有效价格计划');
      for (const [j, group] of groups.entries()) {
        if (!isObject(group) || !validScope(group) || !Array.isArray(group.schedule) || !group.schedule.length) return invalid(`${path}.${field}[${j}]`,'价格计划结构或报价范围无效');
        for (const [k, schedule] of group.schedule.entries()) {
          const location = `${path}.${field}[${j}].schedule[${k}]`;
          if (!isObject(schedule) || !validScope(schedule)) return invalid(location,'价格计划结构或报价范围无效');
          if (typeof schedule.value_with_tax !== 'number' || !Number.isFinite(schedule.value_with_tax) || schedule.value_with_tax <= 0) return invalid(location,'售价须为有限正数');
          const validDate = (value: JsonValue | undefined) => typeof value === 'string' && !!value.trim() && Number.isFinite(Date.parse(value));
          if (schedule.start_at !== undefined && !validDate(schedule.start_at) || schedule.end_at !== undefined && !validDate(schedule.end_at)
            || field === 'discounted_price' && (!validDate(schedule.start_at) || !validDate(schedule.end_at))
            || typeof schedule.start_at === 'string' && typeof schedule.end_at === 'string' && Date.parse(schedule.start_at) >= Date.parse(schedule.end_at)) return invalid(location,'价格起止日期无效');
          if (typeof schedule.end_at !== 'string' || Date.parse(schedule.end_at) > now)
            prices.push({value:schedule.value_with_tax,promotion:field==='discounted_price',path:location});
        }
      }
    }
  }
  if (!prices.some(price=>!price.promotion)) return invalid('our_price','缺少仍然适用的正常售价计划');
  // Shape/scope errors take precedence over a business result from a different schedule.
  for (const price of prices) {
    let code: ActualPriceFailureCode | null;
    try { code = actualListingPriceFailure(input,rules,price.value,price.promotion); }
    catch (error) { if (error instanceof ListingQuoteError) return invalid(price.path,error.message); throw error; }
    if (code) {
      const reasons = { ACTUAL_PRICE_INVALID:'售价无效', ACTUAL_PRICE_CAP:`超过售价上限 $${rules.maxPrice.toFixed(2)}`,
        ACTUAL_PRICE_ROI:`按当前费表计算未满足 ROI > ${rules.targetRoi}`, ACTUAL_PRICE_MARGIN:'低于最低合格售价加已设置加价额' };
      return {code,message:`实际${price.promotion?'促销':'正常'}售价 $${price.value}（${price.path}）${reasons[code]}，请修改实际报价或重新核对定价输入`};
    }
  }
  return null;
}
