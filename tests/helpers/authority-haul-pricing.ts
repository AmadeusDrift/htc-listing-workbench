import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import type { AmazonDraft } from '../../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../../src/shared/contracts.ts';
import { WorkspaceStore } from '../../src/main/store.ts';
import { AmazonService } from '../../src/main/amazon/service.ts';
import { applyBusinessRules } from '../../src/main/amazon/business-rules.ts';
import { readListingRules } from '../../src/main/listing-rules.ts';
import { assertCurrentPricingForPaid } from '../../src/main/pricing/qualification.ts';
import { saveInput } from '../fixtures/listing-ai.ts';
import { confirmSourceConsistencyFixture } from './source-consistency-proof.ts';

/** Seed real confirmed synthetic cost/package inputs; generate the report and actual offer with production rules. */
export async function seedAuthorityHaulPricing(f:{directory:string;store:WorkspaceStore;amazon:AmazonService;product:ProductDetail},draft:AmazonDraft){
  let product=f.store.getProduct(draft.productId);
  product=f.store.saveProduct({...saveInput(product),variants:saveInput(product).variants.map(v=>({...v,purchasePrice:'2.4'})),facts:[...product.facts,...[['采购币种','CNY'],['包装长度','5 cm'],['包装宽度','5 cm'],['包装高度','5 cm'],['包装重量','100 g']].map(([name,value])=>({id:randomUUID(),name,value,source:'manual' as const,state:'human_confirmed' as const,sourceRef:'Synthetic authority regression input'}))]});
  await confirmSourceConsistencyFixture(f.directory,f.store,product.id);
  Object.assign(f.product,product);draft.productRevision=product.revision;
  const properties=draft.schema.schema.properties as Record<string,any>;
  const measurement={type:'object',properties:{value:{type:'number'},unit:{enum:['inches','cm']}},required:['value','unit'],additionalProperties:false};
  properties.item_package_dimensions={type:'array',items:{type:'object',properties:{length:measurement,width:measurement,height:measurement,marketplace_id:{type:'string'}},required:['length','width','height'],additionalProperties:false}};
  properties.item_package_weight={type:'array',items:{type:'object',properties:{value:{type:'number'},unit:{enum:['pounds','g']},marketplace_id:{type:'string'}},required:['value','unit'],additionalProperties:false}};
  const p=(f.amazon as any).persistence,rules=readListingRules(p.db),attributes=structuredClone(draft.attributes);
  delete attributes.purchasable_offer;
  const result=applyBusinessRules({product,variant:product.variants.find(v=>v.id===draft.variantId)!,target:f.amazon.getTarget(draft.targetId),schema:draft.schema,attributes,measurements:{},costCny:2.4,now:new Date()},rules);
  const pricingFields=['purchasable_offer','item_package_dimensions','item_package_weight','number_of_items','unit_count'];
  for(const field of pricingFields)if(result.attributes[field]!==undefined)draft.attributes[field]=result.attributes[field];
  draft.businessRules={...result.report,fields:Object.fromEntries(Object.entries(result.report.fields).filter(([field])=>pricingFields.includes(field)))};
  assert.equal(draft.businessRules.pricingDecision?.status,'quoted',JSON.stringify(result.report));
  assertCurrentPricingForPaid(draft,rules);
  draft.schema.checksum=createHash('md5').update(JSON.stringify(draft.schema.schema)).digest('base64');
  f.amazon.getSchema=async()=>structuredClone(draft.schema);
}

