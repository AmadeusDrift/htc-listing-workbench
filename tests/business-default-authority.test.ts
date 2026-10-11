import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import { currentFactAuthority } from '../src/main/amazon/fact-authority.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import type { ProductDetail, Variant } from '../src/shared/contracts.ts';
import type { AmazonTarget } from '../src/shared/amazon-contracts.ts';
const variant={id:'v',sku:'H2-261012-1A',originalSpec:'Plain',sourceSpec:'Plain',normalizedSpec:'',purchasePrice:'2.4',sourcePurchasePrice:'2.4'} as Variant;
const product={id:'p',title:'Plain coaster',description:'',facts:[],variants:[variant]} as unknown as ProductDetail;
const schema=realAmazonSchema();
const run=(name='U2',extra:Partial<Parameters<typeof applyBusinessRules>[0]>={})=>applyBusinessRules({product,variant,schema,target:{id:'t',name,marketplaceId:'ATVPDKIKX0DER',mode:'demo'} as AmazonTarget,attributes:{},measurements:{},costCny:2.4,now:new Date('2026-10-12T00:00:00Z'),...extra},defaultListingRules());
for(const [shop,manufacturer] of [['U2','EQUICK'],['U6','Lancholy'],['U8','Seannel']])test(`${shop} configured defaults fill listing values with reusable rule provenance`,()=>{
  const result=run(shop),a=result.attributes as any;
  assert.equal(a.manufacturer?.[0].value,manufacturer);assert.equal(a.brand?.[0].value,'Generic');assert.equal(a.country_of_origin?.[0].value,'CN');
  assert.equal(a.item_package_weight?.[0].value,.22);assert.equal(a.item_dimensions?.[0].length.value,1.97);assert.equal(a.item_weight,undefined);
  assert.match(result.report.fields.item_package_weight.reason,/业务默认/);
  const repeated=run(shop,{attributes:a,previousBusinessReport:result.report});assert.deepEqual(repeated.attributes,a);assert.match(repeated.report.fields.item_package_weight.reason,/业务默认/);
});
test('new real measurements replace unchanged prior defaults and child identifiers use their own SKU',()=>{
  const initial=run(),result=run('U2',{attributes:initial.attributes,previousBusinessReport:initial.report,baseSku:'H2-261012-1',measurements:{package:{weight:{value:200,unit:'g'}}}});
  assert.equal((result.attributes.item_package_weight as any)?.[0].value,.44);
  assert.equal((run('U2',{baseSku:'H2-261012-1'}).attributes.model_number as any)?.[0].value,variant.sku);
});

test('current rule values provide authority without trusting a historical report or arbitrary value',()=>{
  const result=run(),target={marketplaceId:'ATVPDKIKX0DER'},values=Object.fromEntries(Object.entries(result.report.fields).map(([field,entry])=>[field,entry.value]));
  assert.deepEqual(currentFactAuthority(product,schema,target,result.attributes,{},values).issues,[]);
  const changed=structuredClone(result.attributes);changed.manufacturer=[{value:'Made Up'}];
  assert.ok(currentFactAuthority(product,schema,target,changed,{},values).issues.some(i=>i.attributeNames.includes('manufacturer')));
  const conflict={...product,facts:[{id:'c',name:'原产国',value:'US',source:'manual' as const,sourceRef:'',state:'conflicting' as const}]};
  assert.ok(currentFactAuthority(conflict,schema,target,result.attributes,{},values).issues.some(i=>i.code==='FACT_SOURCE_CONFLICT'));
});

test('fixed listing brand overrides supplier brand while original product remains unchanged',()=>{
  const source={...product,facts:[{id:'brand',name:'品牌',value:'Acme',source:'1688' as const,sourceRef:'source',state:'source_confirmed' as const}]},before=structuredClone(source);
  const result=run('U2',{product:source});assert.equal((result.attributes.brand as any)[0].value,'Generic');assert.deepEqual(source,before);
});
test('reapplying current rules updates unchanged manufacturer defaults but preserves manually changed manufacturer',()=>{
  const initial=run(),rules=defaultListingRules();rules.revision=1;rules.product.manufacturers.U2='NewManufacturer';
  const args={product,variant,schema,target:{id:'t',name:'U2',marketplaceId:'ATVPDKIKX0DER',mode:'demo'} as AmazonTarget,attributes:initial.attributes,previousBusinessReport:initial.report,measurements:{},costCny:2.4,now:new Date()};
  assert.equal((applyBusinessRules(args,rules).attributes.manufacturer as any)[0].value,'NewManufacturer');
  const manual={...initial.attributes,manufacturer:[{value:'Manual Maker',marketplace_id:'ATVPDKIKX0DER',language_tag:'en_US'}]};
  assert.deepEqual(applyBusinessRules({...args,attributes:manual},rules).attributes.manufacturer,manual.manufacturer);
});

test('legacy child SKU-derived model identifiers refresh while actual models remain unchanged',()=>{
  const result=run('U2'),old=structuredClone(result);
  (old.attributes.model_number as any)[0].value='H2-261012-1';old.report.fields.model_number={value:structuredClone(old.attributes.model_number),reason:'缺失型号标识使用商品组基础 SKU'};
  const fixed=run('U2',{attributes:old.attributes,previousBusinessReport:old.report,baseSku:'H2-261012-1'});
  assert.equal((fixed.attributes.model_number as any)[0].value,variant.sku);
  const actual={...old.attributes,model_number:[{value:'Actual-Model',marketplace_id:'ATVPDKIKX0DER'}]};
  assert.deepEqual(run('U2',{attributes:actual,previousBusinessReport:old.report}).attributes.model_number,actual.model_number);
});
