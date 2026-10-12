import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildSalesRecipes, procurementComponents } from '../src/main/sales-plans/recipes.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';

const product = (colors: string[], prices = colors.map(()=>'.1')): ProductDetail => ({id:randomUUID(),title:'普通收纳夹',description:'',sourceUrl:'',status:'draft',origin:'manual',revision:1,createdAt:'2026-10-08T00:00:00.000Z',updatedAt:'2026-10-08T00:00:00.000Z',assets:[],facts:[],
  variants:colors.map((color,i)=>({id:randomUUID(),sku:`source-${i}`,originalSpec:`颜色: ${color} / 尺寸: 小号`,sourceSpec:`颜色: ${color} / 尺寸: 小号`,normalizedSpec:'',purchasePrice:prices[i],sourcePurchasePrice:prices[i],inventory:null}))});

test('more than three same-spec colors get single-color packs plus one bounded mixed recipe',()=>{
  const p = product(['红色','黑色','白色','蓝色','绿色']);
  const recipes = buildSalesRecipes(p,null,defaultListingRules());
  assert.equal(recipes.filter(recipe=>recipe.components.length===1).length,5);
  const mixed=recipes.find(recipe=>recipe.components.length>1)!;
  assert.equal(mixed.totalPieces,10); assert.equal(mixed.components.length,5);
  assert.ok(mixed.components.every(component=>component.quantity===2));
  const totals=procurementComponents([{recipe:mixed,sets:5}]);
  assert.ok(totals.every(component=>component.pieces===10));
  assert.equal(totals.reduce((sum,item)=>sum+(item.costCny??0),0),5);
});
test('size or model differences never mix and recipe identity survives source reordering',()=>{
  const p=product(['红色','黑色','白色']);p.variants[2].originalSpec='颜色: 白色 / 尺寸: 大号';
  const before=buildSalesRecipes(p,null,defaultListingRules());
  const mixed=before.find(recipe=>recipe.components.length>1)!;
  assert.ok(!mixed.components.some(c=>c.variantId===p.variants[2].id));
  p.variants.reverse();
  assert.deepEqual(buildSalesRecipes(p,null,defaultListingRules()).map(recipe=>recipe.key).sort(),before.map(recipe=>recipe.key).sort());
});
test('mixed cost uses every source quote and supplier packs convert to procurement package quantities',()=>{
  const p=product(['红色','黑色'],['.1','.2']);
  const recipe=buildSalesRecipes(p,null,defaultListingRules()).find(item=>item.components.length>1)!;
  assert.equal(recipe.totalCostCny,1.5);
  p.variants[0].originalSpec='颜色: 红色 / 50支/盒，整盒价格';p.variants=p.variants.slice(0,1);p.variants[0].purchasePrice='1.5';
  const box=buildSalesRecipes(p,null,defaultListingRules())[0];
  assert.equal(box.totalPieces,50);assert.equal(box.totalCostCny,1.5);
  assert.equal(procurementComponents([{recipe:box,sets:5}])[0].quoteUnits,5);
});

test('swapped supplier axes and compound color labels cannot combine different sizes or models',()=>{
  const p=product(['白色','白色','红色']);
  p.variants[0].originalSpec='尺寸: 白色 / 颜色: 小号12厘米长青蛙（带磁铁）';
  p.variants[1].originalSpec='尺寸: 白色 / 颜色: 中号15.5厘米长青蛙（带磁铁）';
  p.variants[2].originalSpec='尺寸: 红色 / 颜色: 小号12厘米长青蛙（带磁铁）';
  const mixed=buildSalesRecipes(p,null,defaultListingRules()).filter(r=>r.components.length>1);
  assert.equal(mixed.length,1);
  assert.deepEqual(new Set(mixed[0].components.map(c=>c.variantId)),new Set([p.variants[0].id,p.variants[2].id]));
  p.variants[0].originalSpec='颜色: 红色整机 / 尺寸: 小号';
  p.variants[1].originalSpec='颜色: 蓝色替换芯 / 尺寸: 小号';p.variants=p.variants.slice(0,2);
  assert.ok(buildSalesRecipes(p,null,defaultListingRules()).every(r=>r.components.length===1));
});

test('unambiguous package description and confirmed count facts precede the one-piece fallback',()=>{
  const p=product(['透明盒'],['1.5']);p.title='盒装牙签';p.variants[0].originalSpec='透明盒';
  p.description='50支/盒，整盒价格1.50元';
  let sale=buildSalesRecipes(p,null,defaultListingRules())[0];
  assert.equal(sale.totalPieces,50);assert.equal(sale.totalCostCny,1.5);
  p.variants[0].originalSpec='20支盒装';sale=buildSalesRecipes(p,null,defaultListingRules())[0];
  assert.equal(sale.totalPieces,20);
  p.variants[0].originalSpec='透明盒';p.description='';
  p.facts=[{id:randomUUID(),name:'售卖件数',value:'50',state:'source_confirmed',sourceRef:'供应商',source:'1688'}];
  assert.equal(buildSalesRecipes(p,null,defaultListingRules())[0].totalPieces,50);
  p.facts=[];p.variants[0].originalSpec='【10个装】';p.variants[0].purchasePrice='0.38';p.description='此链接为单个价格';
  sale=buildSalesRecipes(p,null,defaultListingRules())[0];assert.equal(sale.totalPieces,10);assert.equal(sale.totalCostCny,3.8);assert.equal(sale.components[0].piecesPerQuote,1);
});

test('named supplier colors and swapped axes stay in same-model families instead of one parent per source SKU',()=>{
  const shades=['夜光本色','春茶色渐变','松针绿单色','樱花粉单色','定制款多色橙+绿+黄+蓝','炫彩多色红蓝绿多色'];
  const p=product(shades.flatMap(shade=>[shade,shade]));
  p.variants.forEach((v,index)=>{v.originalSpec=`尺寸: ${shades[Math.floor(index/2)]} / 颜色: ${index%2?'中号15.5':'小号12'}厘米长青蛙（带磁铁）`;});
  const rules=defaultListingRules();rules.pricing.bundleEnabled=false;
  const recipes=buildSalesRecipes(p,null,rules);
  assert.equal(new Set(recipes.map(r=>r.groupKey)).size,2);
  assert.ok(recipes.every(r=>r.color));
  assert.notEqual(recipes[0].groupKey,recipes[1].groupKey);
  for(let i=2;i<recipes.length;i++)assert.equal(recipes[i].groupKey,recipes[i%2].groupKey);
});

test('explicit quantity variants share a model family but model numbers and accessories remain separate',()=>{
  const p=product(['红色','红色','红色','红色']);
  p.variants[0].originalSpec='型号: A / 颜色: 红色 / 包装: 20支盒装';
  p.variants[1].originalSpec='型号: A / 颜色: 红色 / 包装: 50支盒装';
  p.variants[2].originalSpec='型号: B / 颜色: 红色 / 包装: 20支盒装';
  p.variants[3].originalSpec='型号: A替换芯 / 颜色: 红色 / 包装: 20支盒装';
  const rules=defaultListingRules();rules.pricing.bundleEnabled=false;
  const recipes=buildSalesRecipes(p,null,rules);
  assert.equal(recipes[0].groupKey,recipes[1].groupKey);
  assert.notEqual(recipes[0].groupKey,recipes[2].groupKey);
  assert.notEqual(recipes[0].groupKey,recipes[3].groupKey);
  assert.deepEqual(recipes.map(r=>r.totalPieces),[20,50,20,20]);
});

test('quantity-only variation can form a family without inventing a color',()=>{
  const p=product(['','']);p.variants[0].originalSpec='型号: 标准牙签 / 规格: 50支盒装';p.variants[1].originalSpec='型号: 标准牙签 / 规格: 100支盒装';
  const rules=defaultListingRules();rules.pricing.bundleEnabled=false;const recipes=buildSalesRecipes(p,null,rules);
  assert.equal(recipes[0].groupKey,recipes[1].groupKey);assert.ok(recipes.every(r=>r.color===''));
});

test('material and accessory-count axes remain part of the model identity',()=>{
  const p=product(['红色','蓝色']);
  p.variants[0].originalSpec='材质: 金 / 颜色: 红色';p.variants[1].originalSpec='材质: 银 / 颜色: 蓝色';
  let recipes=buildSalesRecipes(p,null,defaultListingRules());assert.equal(recipes.length,2);assert.notEqual(recipes[0].groupKey,recipes[1].groupKey);
  p.variants[0].originalSpec='型号: A / 颜色: 红色 / 配件数量: 1个';p.variants[1].originalSpec='型号: A / 颜色: 蓝色 / 配件数量: 2个';
  recipes=buildSalesRecipes(p,null,defaultListingRules());assert.equal(recipes.length,2);assert.notEqual(recipes[0].groupKey,recipes[1].groupKey);
});

test('color aliases cannot create a fictitious mixed-color recipe or unique color children',()=>{
  for(const aliases of [['红','红色'],['松针绿','松针绿色'],['red','红色'],['樱花粉','樱花粉色']]){
    const p=product(aliases),recipes=buildSalesRecipes(p,null,defaultListingRules());
    assert.equal(recipes.length,2,aliases.join('/'));assert.equal(recipes[0].color,recipes[1].color);
  }
});

import { previewSalesRecipes } from '../src/main/sales-plans/planning.ts';

test('automatic selection excludes service options before quantity parsing and caps complete ordinary products at four',()=>{
 const p=product(['春夏秋冬-可备注颜色','更低价格请咨询客服~','红色','蓝色','黑色','白色','绿色']);
 const before=structuredClone(p), rules=defaultListingRules();rules.pricing.bundleEnabled=false;
 const selected=previewSalesRecipes(p,null,rules);
 assert.equal(selected.length,4);
 assert.ok(selected.every(r=>!r.specification.includes('客服')&&!r.specification.includes('春夏秋冬')));
 assert.deepEqual(p,before);
});
test('automatic selection preserves genuine configurations with remarks and never pads with service rows',()=>{
 const p=product(['红色整机（可备注颜色）','更低价格请咨询客服~']);
 assert.equal(previewSalesRecipes(p,null,defaultListingRules()).length,1);
 assert.match(previewSalesRecipes(p,null,defaultListingRules())[0].specification,/红色整机/);
});
test('automatic selection ranks complete products before explicit accessory-only options and diversifies equal candidates',()=>{
 const p=product(['替换芯','红色','红色','蓝色','白色','黑色']);
 const rules=defaultListingRules();rules.pricing.bundleEnabled=false;
 const selected=previewSalesRecipes(p,null,rules);
 assert.equal(selected.length,4);assert.ok(selected.every(r=>!r.specification.includes('替换芯')));
 assert.equal(new Set(selected.map(r=>r.color)).size,4);
});

test('automatic ranking uses supplier image mapping before downloads without rejecting unlinked real colors',()=>{
 const p=product(['红色','蓝色','黑色','白色','绿色']);const rules=defaultListingRules();rules.pricing.bundleEnabled=false;
 const receipt={snapshot:{sources:[],attributes:[],description:'',dimensions:[],skus:[],images:[{id:'image-five'}]},mapping:{skus:[]},skuMappings:[{localVariantId:p.variants[4].id,imageIds:['image-five']}]} as any;
 const candidates=buildSalesRecipes(p,null,rules),chosen=selectSalesRecipes(p,candidates,rules,receipt);
 assert.equal(chosen.length,4);assert.ok(chosen.some(r=>r.components[0].variantId===p.variants[4].id));
 assert.equal(selectSalesRecipes(p,candidates.slice(0,1),rules,receipt).length,1);
});
import { selectSalesRecipes } from '../src/main/sales-plans/selection.ts';

test('informational option on swapped supplier axis stays excluded alongside a real size',()=>{
 const p=product(['red']);Object.assign(p.variants[0],{originalSpec:'尺寸:春夏秋冬-可备注颜色 / 颜色:大号21厘米长青蛙',sourceSpec:'',normalizedSpec:''});
 assert.equal(previewSalesRecipes(p,null,defaultListingRules()).length,0);
});
