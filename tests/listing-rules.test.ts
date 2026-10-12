import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultListingRules, parseListingRules, quoteListing, bundleQuantity, promotionSchedule } from '../src/shared/listing-rules.ts';
import { ListingRuleStore } from '../src/main/listing-rules.ts';

test('legacy ROI example and CNY source cost are reproduced without a second exchange conversion', () => {
  const rules = defaultListingRules();
  const quote = quoteListing({ costCny: 2.4, dimensionsInches: [5/2.54, 5/2.54, 5/2.54], weightPounds: 100/453.59237 }, rules.pricing);
  assert.equal(quote.minimum, 1.96); assert.equal(quote.price, 2.06); assert.equal(quote.deliveryFee, 0.5);
  assert.ok(Math.abs(quote.roi - 1.1718918918918921) < 1e-10);
  assert.equal(quote.promotionPrice, 1.96);
});
test('all delivery thresholds, fees, divisor, costs and ROI influence pricing; infeasible packages fail clearly', () => {
  const rules = defaultListingRules();
  const input = { costCny: 2.4, dimensionsInches: [1,1,1] as [number,number,number], weightPounds: 0.2 };
  const first = quoteListing(input, rules.pricing);
  rules.pricing.lowPriceFee = 0.6;
  assert.ok(quoteListing(input, rules.pricing).price > first.price);
  rules.pricing.maxDimensionalWeightGrams = 1;
  assert.throws(() => quoteListing(input, rules.pricing), /抛重/);
  assert.throws(() => quoteListing({ ...input, costCny: 999 }, defaultListingRules().pricing), /售价上限/);
});

test('quote failures expose stable typed causes while retaining their existing messages', () => {
  const input = { costCny: 2.4, dimensionsInches: [1,1,1] as [number,number,number], weightPounds: .2 };
  const pricing = defaultListingRules().pricing;
  for (const [changedInput, changedRules, code, message] of [
    [{ ...input, costCny: 0 }, pricing, 'QUOTE_INVALID_INPUT', /有效采购成本/],
    [input, { ...pricing, maxDimensionalWeightGrams: 1 }, 'DIMENSIONAL_WEIGHT_LIMIT', /抛重/],
    [{ ...input, costCny: 999 }, pricing, 'ROI_MAX_PRICE', /售价上限内/],
    [input, { ...pricing, margin: 10 }, 'ROI_PROMOTION_OR_MARGIN', /加价或促销/],
  ] as const) {
    assert.throws(() => quoteListing(changedInput, changedRules), error => {
      assert.equal((error as Error).name, 'ListingQuoteError');
      assert.equal((error as any).code, code);
      assert.match((error as Error).message, message);
      return true;
    });
  }
});
test('invalid numbers, unordered tiers and unknown configuration keys cannot enter saved rules', () => {
  const rules = defaultListingRules();
  assert.throws(() => parseListingRules({ ...rules, unsupported: true }));
  assert.throws(() => parseListingRules({ ...rules, pricing: { ...rules.pricing, fx: 0 } }));
  assert.throws(() => parseListingRules({ ...rules, pricing: { ...rules.pricing, commissionPercent: 99, reservePercent: 5 } }));
  const changed = structuredClone(rules); changed.pricing.deliveryTiers[1].upperOz = 2;
  assert.throws(() => parseListingRules(changed));
  const empty = structuredClone(rules); empty.product.brand = '';
  assert.throws(() => parseListingRules(empty));
});

test('legacy default three-variant cap migrates without overriding a newly chosen limit',()=>{
  const rules=defaultListingRules();
  assert.equal(parseListingRules({...rules,version:1,product:{...rules.product,variantLimit:3}}).product.variantLimit,20);
  assert.equal(parseListingRules({...rules,version:2,product:{...rules.product,variantLimit:3}}).product.variantLimit,3);
});
test('bundle selection obeys eligibility and ordered candidates; promotions follow Beijing dates', () => {
  const rules = defaultListingRules();
  assert.equal(bundleQuantity(0.04 * 7, 1, rules.pricing), 10);
  assert.equal(bundleQuantity(0.08 * 7, 1, rules.pricing), 5);
  assert.equal(bundleQuantity(0.04 * 7, 2, rules.pricing), 1);
  assert.deepEqual(promotionSchedule(new Date('2026-10-07T18:00:00Z'), rules.pricing), { start: '2026-10-08T16:00:00.000Z', end: '2026-10-15T16:00:00.000Z' });
});
test('rules persist through restart and stale settings writes cannot discard another save', () => {
  const directory = mkdtempSync(join(tmpdir(), 'htc-rules-'));
  const first = new ListingRuleStore(directory); const initial = first.get();
  initial.product.manufacturers.U8 = 'Seannel'; initial.pricing.fx = 7.2;
  const saved = first.save(initial); assert.equal(saved.revision, initial.revision + 1);
  assert.throws(() => first.save(initial), /已更新/); first.close();
  const second = new ListingRuleStore(directory);
  assert.equal(second.get().pricing.fx, 7.2); assert.equal(second.get().revision, saved.revision); second.close();
});

for(const cost of [5.3,10,100])test(`blocked pricing explains exact required price at cost ${cost} without changing configured cap`,()=>{
  const rules=defaultListingRules().pricing,input={costCny:cost,dimensionsInches:[1,1,1] as [number,number,number],weightPounds:.2};
  const expected=quoteListing(input,{...rules,maxPrice:1000}).price;
  assert.throws(()=>quoteListing(input,rules),(error:Error)=>{assert.ok(error.message.includes(`所需售价 $${expected.toFixed(2)}`),error.message);return true;});
  assert.equal(rules.maxPrice,3);
});
