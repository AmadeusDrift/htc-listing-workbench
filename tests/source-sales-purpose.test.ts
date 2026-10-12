import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {informationalVariant} from '../src/main/sales-plans/selection.ts';
import {explicitRandomFulfillment} from '../src/main/sales-plans/source-meaning.ts';
const variant=(spec:string)=>({id:randomUUID(),sku:'fixture',sourceSpec:spec,originalSpec:spec,normalizedSpec:'',purchasePrice:'1',sourcePurchasePrice:'1',inventory:null});
test('supplier selection instructions are not physical random goods or real configurations with remarks',()=>{
 assert.equal(informationalVariant(variant('颜色分类: 底座颜色随机不支持选')),true);
 assert.equal(informationalVariant(variant('颜色: 多种款式 随机发货 / 高度: 11厘米')),false);
 assert.equal(informationalVariant(variant('颜色: 红色整机（可备注颜色）')),false);
 assert.equal(informationalVariant(variant('型号: 儿童牙刷619')),false);
});
for(const value of ['多种款式 随机发货','颜色随机发货','randomly shipped style'])test(`explicit unknown fulfillment stays sales exception under v2: ${value}`,()=>{
 assert.equal(explicitRandomFulfillment(value),true);
});
for(const value of ['儿童牙刷619','红蓝混色两件装','red or blue light indicator','不随机发货，按所选颜色发货'])test(`ordinary ambiguity or defined mixture does not become sales refusal: ${value}`,()=>{
 assert.equal(explicitRandomFulfillment(value),false);
});

import {fixture,saveInput} from './fixtures/listing-ai.ts';
import {productReferenceImages} from '../src/main/image-workflow/reference-purpose.ts';
import {normalizeSourceObservations} from '../src/main/source-image-consistency/comparison.ts';
test('explicit random SKU stops before paid source observation; another known model remains independent',async t=>{
 const f=await fixture(t),p=f.store.saveProduct({...saveInput(f.product),variants:saveInput(f.product).variants.map(v=>({...v,originalSpec:'多种款式 随机发货',normalizedSpec:'',purchasePrice:'1'}))});
 await assert.rejects(()=>f.ai.prepareSourceConsistency({productId:p.id,productRevision:p.revision,variantId:p.variants[0].id}),/销售规格异常/);assert.equal(f.requests.length,0);
});
test('explicit instructions-only image is excluded without rejecting product text and dimensions',async t=>{
 const f=await fixture(t),a=f.product.assets[0],ids=[a.id,randomUUID(),randomUUID(),randomUUID()];const product={...f.product,assets:ids.map(id=>({...a,id}))};
 const raw={assets:ids.map((assetId,index)=>({assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:[],appearance:[],claims:[],contentPurpose:['instructions-only','product','product','unknown'][index]}))};
 const output=normalizeSourceObservations(raw,{claims:[],referenceAssets:ids.map(assetId=>({assetId})) as any});
 const observations=[{variantId:f.product.variants[0].id,images:output.assets} as any],before=JSON.stringify(product);
 assert.deepEqual(productReferenceImages(product,observations).assets.map(a=>a.id),ids.slice(1));assert.equal(JSON.stringify(product),before);
 assert.deepEqual(productReferenceImages(product,[]),product);
});
