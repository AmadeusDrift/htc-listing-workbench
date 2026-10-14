import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import type { ProductDetail } from '../src/shared/contracts.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { sourceQuantity, sourcePackCost } from '../src/shared/source-quantity.ts';
import { buildSalesRecipes, procurementComponents } from '../src/main/sales-plans/recipes.ts';
import { validateSalesRecipe } from '../src/main/sales-plans/records.ts';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import { pricingQualificationIssue, pricingEvidenceCurrent } from '../src/main/pricing/qualification.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import type { AmazonDraft, AmazonTarget } from '../src/shared/amazon-contracts.ts';
import { adaptationState } from '../src/main/automatic-listing/adaptation.ts';
import { sourceStamp } from '../src/main/automatic-listing/records.ts';
import { fingerprint } from '../src/main/execution/records.ts';
import { DatabaseSync } from 'node:sqlite';
import { assertStoredPricingForPaid } from '../src/main/amazon/pricing-guard.ts';

export function kitProduct(): ProductDetail {
 return {id:randomUUID(),title:'过滤网支架',description:'',sourceUrl:'',status:'draft',origin:'manual',revision:1,createdAt:'2026-10-08T00:00:00Z',updatedAt:'2026-10-08T00:00:00Z',assets:[],facts:[],
 variants:['黄色','米色'].map((color,i)=>({id:randomUUID(),sku:'SOURCE-'+i,originalSpec:`颜色: ${color} / 支架+贴片+50只过滤网`,sourceSpec:'',normalizedSpec:'',purchasePrice:'8.2',sourcePurchasePrice:'8.2',inventory:null}))};
}
test('kit accessory count never becomes the quote divisor or a cheap mixed ten-piece sale',()=>{
 const p=kitProduct(),before=JSON.stringify(p),recipes=buildSalesRecipes(p,null,defaultListingRules());
 assert.equal(recipes.length,2,'the old implementation generates a third mixed ten-piece recipe at 1.64 CNY');
 assert.ok(recipes.every(r=>r.totalCostCny===8.2));
 assert.ok(recipes.every(r=>r.quantityVersion===2&&r.platformPieces===null));
 assert.ok(recipes.every(r=>r.totalPieces===1&&r.components[0].piecesPerQuote===1));
 assert.equal(JSON.stringify(p),before);
});
test('source units retain kit contents while leaving platform and unnumbered main quantities unknown',()=>{
 const q=sourceQuantity('支架+贴片+50只过滤网');
 assert.equal(q.piecesPerQuote,1);assert.equal(sourcePackCost(8.2,q),8.2);
 assert.equal(q.unitSemantics?.kind,'kit');
 assert.equal(q.unitSemantics?.mainQuantity,null);
 assert.ok(q.unitSemantics?.contents.some(c=>c.name==='过滤网'&&c.quantity===50&&c.role==='accessory'));
});
test('pure consumables and proven homogeneous packs still allow priced split color recipes',()=>{
 const p=kitProduct();p.variants.forEach(v=>{v.originalSpec=v.originalSpec.split('/')[0]+'/ 50只过滤网整包价格';v.purchasePrice='1.5';});
 const recipes=buildSalesRecipes(p,null,defaultListingRules()),mixed=recipes.find(r=>r.components.length>1)!;
 assert.equal(mixed.totalPieces,10);assert.equal(mixed.totalCostCny,.3);assert.equal(mixed.platformPieces,10);
 assert.equal(procurementComponents([{recipe:mixed,sets:5}]).reduce((sum,c)=>sum+(c.costCny??0),0),1.5);
});
test('kit procurement expands complete kits and preserves accessory composition, without splitting contents',()=>{
 const r=buildSalesRecipes(kitProduct(),null,defaultListingRules())[0],line=procurementComponents([{recipe:r,sets:5}])[0];
 assert.equal(line.quoteUnits,5);assert.equal(line.originalPacks,5);assert.equal(line.costCny,41);assert.equal(line.needsSplit,false);
 assert.equal(line.unit,'kit');assert.ok(line.contents?.some(c=>c.name==='过滤网'&&c.quantity===250));
});
test('explicitly unknown quote units cannot establish a cost from a numeric package count',()=>{
 const p=kitProduct();p.variants=p.variants.slice(0,1);p.variants[0].originalSpec='50只过滤网，报价单位不明';
 const r=buildSalesRecipes(p,null,defaultListingRules())[0];
 assert.equal(r.totalCostCny,null);assert.equal(r.platformPieces,null);
 assert.throws(()=>sourcePackCost(8.2,sourceQuantity(p.variants[0].originalSpec)),/计价|单位/);
});
test('legacy erroneous recipe reader preserves its exact historical bytes and hash',()=>{
 const p=kitProduct(),components=p.variants.map(v=>({variantId:v.id,sourceKey:v.id,sourceSku:v.sku,specification:v.originalSpec,color:'',quantity:5,quotedCostCny:8.2,piecesPerQuote:50,sourcePackPieces:50}));
 const key=createHash('sha256').update(JSON.stringify([...components].sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey)).map(c=>[c.sourceKey,c.quantity]))).digest('hex');
 const old={key,groupKey:'a'.repeat(64),specification:'混色 10 pc',color:'Mixed colors',components,totalPieces:10,totalCostCny:1.64},before=JSON.stringify(old);
 assert.deepEqual(validateSalesRecipe(old),old);assert.equal(JSON.stringify(old),before);
});
test('actual pricing cannot qualify a self-consistent legacy kit recipe',()=>{
 const p=kitProduct(),v=p.variants[0],components=[{variantId:v.id,sourceKey:v.id,sourceSku:v.sku,specification:v.originalSpec,color:'Yellow',quantity:50,quotedCostCny:8.2,piecesPerQuote:50,sourcePackPieces:50}];
 const key=createHash('sha256').update(JSON.stringify(components.map(c=>[c.sourceKey,c.quantity]))).digest('hex');
 const legacy={key,groupKey:'a'.repeat(64),specification:'50 pc',color:'Yellow',components,totalPieces:50,totalCostCny:8.2};
 const rules=defaultListingRules();rules.pricing.maxPrice=100;
 const schema=realAmazonSchema(),target={id:'target',name:'U2',mode:'demo',marketplaceId:'ATVPDKIKX0DER'} as AmazonTarget;
 const historicallyInterpreted={...legacy,components:components.map(c=>({...c,specification:'50 pc'}))};
 const result=applyBusinessRules({product:p,variant:v,target,schema,attributes:{},measurements:{},costCny:8.2,saleUnit:historicallyInterpreted,packageMatchesSaleUnit:true,now:new Date('2026-10-13T00:00:00Z')},rules);
 assert.equal(result.report.pricingDecision?.status,'quoted','freeze a numerically valid historical quote before attaching the original kit words');
 const d={listingProgram:'haul',marketplaceId:target.marketplaceId,schema,attributes:result.attributes,businessRules:result.report,salesPlan:{recipe:legacy}} as AmazonDraft,before=JSON.stringify(d);
 assert.ok(pricingQualificationIssue(d,rules));assert.equal(pricingEvidenceCurrent(d,rules),false);assert.equal(JSON.stringify(d),before);
});
test('new kit business rules leave platform count and actual quote pending instead of inventing one or 52',()=>{
 const p=kitProduct(),recipe=buildSalesRecipes(p,null,defaultListingRules())[0],v=p.variants[0],rules=defaultListingRules();rules.pricing.maxPrice=100;
 const result=applyBusinessRules({product:p,variant:v,target:{id:'target',name:'U2',mode:'demo',marketplaceId:'ATVPDKIKX0DER'} as AmazonTarget,schema:realAmazonSchema(),attributes:{},measurements:{},costCny:8.2,saleUnit:recipe,packageMatchesSaleUnit:true,now:new Date()},rules);
 assert.equal(result.report.pricingDecision?.status,'needs_input');assert.equal(result.report.quote,null);
 assert.equal(result.attributes.number_of_items,undefined);assert.equal(result.attributes.unit_count,undefined);
 assert.match(result.report.notices.join(';'),/平台.*待|平台.*确认/);
});
test('ordinary task adaptation blocks legacy kit count changes instead of allocating NEW replacement sales',()=>{
 const p=kitProduct(),rules=defaultListingRules(),recipe=buildSalesRecipes(p,null,rules)[0],c={...recipe.components[0],quantity:50,piecesPerQuote:50,sourcePackPieces:50};delete c.unitSemantics;
 const old={...recipe,components:[c],key:createHash('sha256').update(JSON.stringify([[c.sourceKey,50]])).digest('hex'),totalPieces:50};delete old.quantityVersion;delete old.platformPieces;
 const task={id:randomUUID(),revision:1,status:'PAUSED',targetId:'target',profileId:'profile',targetStamp:fingerprint({}),profileStamp:fingerprint({}),rulesStamp:fingerprint(rules),items:[{key:'original',productId:p.id,variantId:c.variantId,productRevision:p.revision,sourceStamp:sourceStamp(p),sku:'KEEP-SKU',salesPlan:{recipe:old},stage:'SOURCES',status:'FAILED',draftId:null}]};
 const deps={store:{getProductSnapshot:()=>p},rules:()=>rules,planSales:()=>[],amazon:{executionTargetScope:()=>({})},hosting:{getProfile:()=>({})},images:{getProgress:()=>null},execution:{list:()=>[]}};
 const before=JSON.stringify(task),result=adaptationState(task as any,deps as any,false);
 assert.ok(result.preview.changes.some(c=>c.key==='original'&&c.kind==='BLOCKED'));
 assert.ok(!result.preview.changes.some(c=>c.kind==='NEW'));assert.equal(JSON.stringify(task),before);
});
test('stored paid guard catches kit composition from the current adopted revision when old recipe only said color',()=>{
 const p=kitProduct(),rules=defaultListingRules(),v=p.variants[0],schema=realAmazonSchema(),target={id:'target',name:'U2',mode:'demo',marketplaceId:'ATVPDKIKX0DER'} as AmazonTarget;
 const normal={...p,title:'收纳夹',variants:[{...v,originalSpec:'黄色 50pc'}]};
 const recipe=buildSalesRecipes(normal,null,rules)[0];delete recipe.quantityVersion;delete recipe.platformPieces;recipe.components[0].specification='黄色';
 const result=applyBusinessRules({product:normal,variant:normal.variants[0],target,schema,attributes:{},measurements:{},costCny:2.4,saleUnit:recipe,packageMatchesSaleUnit:true,now:new Date()},rules);
 const draft={id:'draft',productId:p.id,productRevision:1,variantId:v.id,listingProgram:'haul',marketplaceId:target.marketplaceId,schema,attributes:result.attributes,businessRules:result.report,salesPlan:{recipe}};
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE listing_drafts(id TEXT,record_json TEXT); CREATE TABLE products(id TEXT,title TEXT,description TEXT,revision INTEGER); CREATE TABLE variants(id TEXT,product_id TEXT,original_spec TEXT,normalized_spec TEXT); CREATE TABLE amazon_settings(key TEXT,value_json TEXT)');
  db.prepare('INSERT INTO listing_drafts VALUES(?,?)').run('draft',JSON.stringify({draft}));db.prepare('INSERT INTO products VALUES(?,?,?,?)').run(p.id,'支架+贴片+50只过滤网','',1);db.prepare('INSERT INTO variants VALUES(?,?,?,?)').run(v.id,p.id,'黄色','');
  const before=JSON.stringify(db.prepare('SELECT record_json FROM listing_drafts').all());
  assert.throws(()=>assertStoredPricingForPaid(db,'draft'),/套装|整套|计量/);
  assert.equal(JSON.stringify(db.prepare('SELECT record_json FROM listing_drafts').all()),before);
  db.prepare("UPDATE products SET description='仅补备注',revision=2").run();assert.throws(()=>assertStoredPricingForPaid(db,'draft'),/原.*依据|计量|套装/,'unrelated revision cannot release an erroneous quote without original unit evidence');
 }finally{db.close();}
});
test('stored guard uses exact original source revision from owner history instead of an unadopted new title',()=>{
 const p=kitProduct();p.variants=p.variants.slice(0,1);const v=p.variants[0];v.originalSpec='黄色';p.title='家庭牙签50支盒装';v.purchasePrice='2.4';
 const rules=defaultListingRules(),recipe=buildSalesRecipes(p,null,rules)[0];delete recipe.quantityVersion;delete recipe.platformPieces;
 const schema=realAmazonSchema(),target={id:'target',name:'U2',mode:'demo',marketplaceId:'ATVPDKIKX0DER'} as AmazonTarget;
 const result=applyBusinessRules({product:p,variant:v,target,schema,attributes:{},measurements:{},costCny:2.4,saleUnit:recipe,packageMatchesSaleUnit:true,now:new Date()},rules);
 const draft={id:'draft',productId:p.id,productRevision:1,variantId:v.id,listingProgram:'haul',marketplaceId:target.marketplaceId,schema,attributes:result.attributes,businessRules:result.report,salesPlan:{recipe}};
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE listing_drafts(id TEXT,record_json TEXT); CREATE TABLE products(id TEXT,title TEXT,description TEXT,revision INTEGER); CREATE TABLE variants(id TEXT,product_id TEXT,original_spec TEXT,normalized_spec TEXT); CREATE TABLE amazon_settings(key TEXT,value_json TEXT); CREATE TABLE audit_events(product_id TEXT,action TEXT,detail_json TEXT)');
  db.prepare('INSERT INTO listing_drafts VALUES(?,?)').run('draft',JSON.stringify({draft}));db.prepare('INSERT INTO products VALUES(?,?,?,?)').run(p.id,'未采用的新支架+贴片+50只过滤网标题','',2);db.prepare('INSERT INTO variants VALUES(?,?,?,?)').run(v.id,p.id,'黄色','');
  db.prepare('INSERT INTO audit_events VALUES(?,?,?)').run(p.id,'product.updated',JSON.stringify({before:p,after:{...p,revision:1,title:'未采用的新支架+贴片+50只过滤网标题'}}));
  const before=JSON.stringify(db.prepare('SELECT record_json FROM listing_drafts').all());assert.doesNotThrow(()=>assertStoredPricingForPaid(db,'draft'));assert.equal(JSON.stringify(db.prepare('SELECT record_json FROM listing_drafts').all()),before);
  const kitBefore={...p,title:'支架+贴片+50只过滤网'};db.prepare('UPDATE audit_events SET detail_json=?').run(JSON.stringify({before:kitBefore,after:{...kitBefore,revision:1,description:'仅新增备注'}}));
  assert.throws(()=>assertStoredPricingForPaid(db,'draft'),/套装|计量/);assert.equal(result.report.pricingDecision?.status,'quoted','historical quoted result remains history');
 }finally{db.close();}
});
test('UNKNOWN and submitted/readback rows preserve old identity and suppress replacement NEW recipes',()=>{
 for(const [state,stage] of [['UNKNOWN','READBACK'],['SUBMITTED','IMAGES'],['SUBMITTING','IMAGES'],['DRAFT','READBACK'],['DRAFT','LABELS'],['DRAFT','COMPLETE']]){
  const p=kitProduct(),rules=defaultListingRules(),recipe=buildSalesRecipes(p,null,rules)[0],c={...recipe.components[0],quantity:50,piecesPerQuote:50,sourcePackPieces:50};delete c.unitSemantics;
  const old={...recipe,components:[c],key:createHash('sha256').update(JSON.stringify([[c.sourceKey,50]])).digest('hex'),totalPieces:50};delete old.quantityVersion;delete old.platformPieces;
  const task={id:randomUUID(),revision:1,status:'PAUSED',targetId:'target',profileId:'profile',targetStamp:fingerprint({}),profileStamp:fingerprint({}),rulesStamp:fingerprint(rules),items:[{key:'original',productId:p.id,variantId:c.variantId,productRevision:p.revision,sourceStamp:sourceStamp(p),sku:'KEEP-SKU',salesPlan:{recipe:old},stage,status:'FAILED',draftId:'draft'}]};
  const deps={store:{getProductSnapshot:()=>p},rules:()=>rules,planSales:()=>[],amazon:{executionTargetScope:()=>({}),getDraft:()=>({id:'draft',state,submittedAt:null})},hosting:{getProfile:()=>({})},images:{getProgress:()=>null},execution:{list:()=>[]}};
  const before=JSON.stringify(task),result=adaptationState(task as any,deps as any,false);
  assert.ok(result.preview.changes.some(c=>c.key==='original'&&c.kind==='PRESERVED'),state+'/'+stage);
  assert.ok(!result.preview.changes.some(c=>c.kind==='NEW'),state+'/'+stage+' must not create another SKU for the original kit');assert.equal(JSON.stringify(task),before);
 }
});
test('explicit homogeneous SKU wording wins over generic kit prose, while original kit wording survives normalization',()=>{
 const p=kitProduct();p.title='支架+50只过滤网';p.description='支架+贴片+50只过滤网';p.variants=p.variants.slice(0,1);p.variants[0].originalSpec='50只过滤网';p.variants[0].normalizedSpec='黄色 50pc';
 let r=buildSalesRecipes(p,null,defaultListingRules())[0];assert.equal(r.platformPieces,50);assert.equal(r.components[0].unitSemantics,undefined);
 p.variants[0].originalSpec='黄色 / 支架+贴片+50只过滤网';r=buildSalesRecipes(p,null,defaultListingRules())[0];assert.equal(r.platformPieces,null);assert.equal(r.totalCostCny,8.2);
});
test('a per-piece quote inside heterogeneous kit wording is not silently treated as the complete kit price',()=>{
 const p=kitProduct();p.variants=p.variants.slice(0,1);p.variants[0].originalSpec+='，单只价格';
 const r=buildSalesRecipes(p,null,defaultListingRules())[0];assert.equal(r.totalCostCny,null);
 assert.throws(()=>sourcePackCost(8.2,sourceQuantity(p.variants[0].originalSpec)),/计价|单位/);
});
