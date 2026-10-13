import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import { actualOfferIssue } from '../src/main/pricing/offer.ts';
import { pricingEvidenceCurrent, pricingQualificationIssue } from '../src/main/pricing/qualification.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import type { AmazonDraft, AmazonTarget, JsonObject } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail, Variant } from '../src/shared/contracts.ts';
import { completionOwnerFixture } from './fixtures/completion-owners.ts';
import { ListingRuleStore } from '../src/main/listing-rules.ts';
import * as pricing from '../src/main/pricing/qualification.ts';

const marketplaceId = 'ATVPDKIKX0DER', now = Date.parse('2026-10-13T04:00:00Z');
const variant = { id:'variant', sku:'STABLE-SKU', originalSpec:'1 pc', normalizedSpec:'1 pc', purchasePrice:'2.4', sourcePurchasePrice:'2.4', sourceSpec:'1 pc', inventory:null } as Variant;
const product = { id:'product', title:'Coaster', description:'', facts:[], variants:[variant] } as unknown as ProductDetail;
const target = { id:'target', name:'U8', marketplaceId, mode:'demo' } as AmazonTarget;
function fixture(rules=defaultListingRules()) {
  const input = { product, variant, schema:realAmazonSchema(), target, attributes:{} as JsonObject, measurements:{}, costCny:2.4, now:new Date(now) };
  const result = applyBusinessRules(input,rules);
  const draft = { listingProgram:'haul', marketplaceId, schema:input.schema, attributes:result.attributes, businessRules:result.report } as AmazonDraft;
  return { input, draft, rules };
}
function offer(price:number, promotion?:{value:number;start:string;end:string}):JsonObject {
  return { purchasable_offer:[{ currency:'USD', audience:'BZR', marketplace_id:marketplaceId, our_price:[{schedule:[{value_with_tax:price}]}],
    ...(promotion?{discounted_price:[{schedule:[{value_with_tax:promotion.value,start_at:promotion.start,end_at:promotion.end}]}]}:{}) }] };
}

test('A01 actual low normal and promotion prices fail without changing the historical suggestion',()=>{
  const {draft,rules}=fixture(), before=JSON.stringify(draft.businessRules);
  assert.equal(pricingQualificationIssue(draft,rules,now),null);
  Object.assign(draft.attributes,offer(.1));
  assert.equal(pricingQualificationIssue(draft,rules,now)?.code,'ACTUAL_PRICE_ROI');
  Object.assign(draft.attributes,offer(3,{value:.1,start:'2026-10-14T00:00:00Z',end:'2026-10-20T00:00:00Z'}));
  assert.equal(pricingQualificationIssue(draft,rules,now)?.code,'ACTUAL_PRICE_ROI');
  assert.equal(JSON.stringify(draft.businessRules),before);
});

test('A02 valid manual price survives failed automatic promotion and explicit rule refresh',()=>{
  const rules=defaultListingRules(); rules.pricing.promoDiscount=2;
  const {draft,input}=fixture(rules);
  assert.equal(draft.businessRules!.pricingDecision!.status,'business_blocked');
  Object.assign(draft.attributes,offer(3));
  const before=JSON.stringify(draft.businessRules);
  assert.equal(pricingQualificationIssue(draft,rules,now),null);
  const updated=applyBusinessRules({...input,attributes:draft.attributes,previousBusinessReport:draft.businessRules},rules);
  assert.deepEqual(updated.attributes.purchasable_offer,draft.attributes.purchasable_offer);
  assert.equal(JSON.stringify(draft.businessRules),before);
});

test('A03 v3 ignores unrelated changes and rejects current cost or package rule changes',()=>{
  const {draft,rules}=fixture(), unrelated=structuredClone(rules);
  unrelated.revision++; unrelated.product.stockSets++; unrelated.product.brand='Another display brand';
  assert.equal(pricingEvidenceCurrent(draft,unrelated),true);
  const fee=structuredClone(unrelated); fee.pricing.inboundCost++;
  assert.equal(pricingEvidenceCurrent(draft,fee),false);
  const defaults=structuredClone(unrelated); defaults.product.packageWeight++;
  assert.equal(pricingEvidenceCurrent(draft,defaults),false);
});

test('A03 legacy v2 uses its saved rule revision and remains byte-identical',()=>{
  const {draft,rules}=fixture(); const old=draft.businessRules!.pricingDecision! as any;
  old.version=2; delete old.dependencies;
  const before=JSON.stringify(draft.businessRules);
  assert.equal(pricingEvidenceCurrent(draft,rules),true);
  assert.equal(pricingEvidenceCurrent(draft,{...rules,revision:rules.revision+1}),false);
  assert.equal(JSON.stringify(draft.businessRules),before);
});

test('manual offer is protected; an unchanged program offer refreshes when pricing changes',()=>{
  const {draft,rules,input}=fixture(); const changed=structuredClone(rules); changed.pricing.margin+=.2;
  const generated=applyBusinessRules({...input,attributes:draft.attributes,previousBusinessReport:draft.businessRules},changed);
  assert.notDeepEqual(generated.attributes.purchasable_offer,draft.attributes.purchasable_offer);
  const manual={...draft.attributes,...offer(3)};
  const retained=applyBusinessRules({...input,attributes:manual,previousBusinessReport:draft.businessRules},changed);
  assert.deepEqual(retained.attributes.purchasable_offer,manual.purchasable_offer);
});

test('expired promotion is not active; future promotion and malformed currency still block',()=>{
  const rules=defaultListingRules().pricing, input={costCny:2.4,dimensionsInches:[1.97,1.97,1.97] as [number,number,number],weightPounds:.22};
  assert.equal(actualOfferIssue(offer(3,{value:.1,start:'2026-10-01T00:00:00Z',end:'2026-10-12T00:00:00Z'}),marketplaceId,input,rules,now),null);
  assert.equal(actualOfferIssue(offer(3,{value:.1,start:'2026-10-14T00:00:00Z',end:'2026-10-20T00:00:00Z'}),marketplaceId,input,rules,now)?.code,'ACTUAL_PRICE_ROI');
  const invalid=offer(3); (invalid.purchasable_offer as JsonObject[])[0].currency='CNY';
  assert.equal(actualOfferIssue(invalid,marketplaceId,input,rules,now)?.code,'ACTUAL_OFFER_INVALID');
});

test('A04 pricing changes during awaited Schema refresh block before a submission intent or write lock',async t=>{
  let rules:ListingRuleStore; t.after(()=>rules?.close());
  const f=await completionOwnerFixture(t,'automatic',false,false,'1 pc',false,'haul');
  const persistence=(f.amazon as any).persistence;
  rules=new ListingRuleStore(f.directory);
  const initial=persistence.record(f.draft.id);
  initial.draft.schema.schema=realAmazonSchema().schema;
  persistence.putRecord(initial);
  f.amazon.applyBusinessDefaults({id:initial.draft.id,revision:initial.draft.revision});
  const record=persistence.record(f.draft.id), draft=record.draft;
  assert.equal(pricingQualificationIssue(draft,rules.get()),null);
  draft.state='AMAZON_VALIDATED'; draft.previewIssues=[]; draft.previewedAt=new Date().toISOString();
  record.preview={revision:draft.revision,productRevision:draft.productRevision,checksum:draft.schema.checksum,version:draft.schema.version,generation:persistence.generation(draft.targetId),at:draft.previewedAt};
  persistence.putRecord(record);
  let refreshes=0;
  t.mock.method(f.amazon,'getSchema',async()=>{
    await Promise.resolve(); refreshes++;
    const changed=rules.get(); changed.pricing.inboundCost+=100; rules.save(changed);
    return draft.schema;
  });
  await assert.rejects(f.amazon.submitDraft(draft,true),/定价依据|相关输入/);
  assert.equal(refreshes,1);
  assert.equal(persistence.db.prepare('SELECT count(*) AS n FROM amazon_write_locks').get().n,0);
  assert.equal(f.previews(),0); assert.equal(f.requests.length,0);
  assert.equal(persistence.record(draft.id).draft.events.filter((event:any)=>event.operation==='submit').length,0);
});

test('SKU pricing detail reports the actual manual price with the same fee calculation, without mutation',()=>{
  const {draft,rules}=fixture(); Object.assign(draft.attributes,offer(3));
  const before=JSON.stringify(draft);
  const read=Reflect.get(pricing,'qualifyActualOffer'); assert.equal(typeof read,'function');
  const detail=read(draft,rules,now);
  assert.equal(detail.qualified,true); assert.equal(detail.issue,null);
  assert.equal(detail.offers[0].price,3); assert.equal(detail.offers[0].commission,.45);
  assert.equal(detail.offers[0].deliveryFee,.5); assert.ok(Math.abs(detail.offers[0].upfrontCny-3.7)<1e-10);
  assert.ok(detail.offers[0].roi>1); assert.equal(JSON.stringify(draft),before);
});
