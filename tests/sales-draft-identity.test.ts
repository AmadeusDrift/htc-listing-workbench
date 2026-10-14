import test from 'node:test';
import assert from 'node:assert/strict';
import { AmazonService } from '../src/main/amazon/service.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';

const hash='a'.repeat(64),target={id:'store',sellerId:'seller',marketplaceId:'US',mode:'live'};
const oldPlan={sku:'OLD',sourceGroupKey:`1688:source:${'b'.repeat(64)}`,recipe:{key:hash}} as SalesListingPlan;
const nextPlan={...oldPlan,sku:'NEW-A',sourceGroupKey:`1688:source:${'c'.repeat(64)}`};
const saved={id:'saved',targetId:'store',sellerId:'seller',marketplaceId:'US',mode:'live',productId:'product',sku:'OLD',schema:{parentageLevel:'NONE'},salesPlan:oldPlan,state:'SUBMITTED',submittedAt:'2026-10-09T10:00:00Z',updatedAt:'2026-10-09T10:00:00Z'};
function find(rows:unknown[],productId='product',plan=nextPlan){
 const subject={getTarget:()=>target,persistence:{salesCandidates:()=>rows.map(draft=>({draft}))}};
 return AmazonService.prototype.findSalesDraft.call(subject as never,productId,plan,'store');
}
test('family regrouping finds an existing submitted sale by canonical source recipe instead of publishing a duplicate',()=>{
 assert.equal(find([saved])?.id,'saved');
 assert.equal(find([saved],'reimported-product')?.id,'saved');
});
test('family regrouping does not cross seller, source item, marketplace, parent or quantity identities',()=>{
 for(const changed of [
  {...saved,sellerId:'other'}, {...saved,marketplaceId:'CA'}, {...saved,schema:{parentageLevel:'PARENT'}},
  {...saved,productId:'other',salesPlan:{...oldPlan,sourceGroupKey:`1688:other:${'b'.repeat(64)}`}},
  {...saved,salesPlan:{...oldPlan,recipe:{key:'d'.repeat(64)}}},
 ])assert.equal(find([changed]),undefined);
});
test('an uncertain prior submission takes precedence over newer unsent drafts of the same sale',()=>{
 const unknown={...saved,id:'unknown',state:'UNKNOWN',submittedAt:null};
 const unsent={...saved,id:'unsent',state:'DRAFT',submittedAt:null,updatedAt:'2026-10-09T11:00:00Z'};
 assert.equal(find([unsent,unknown])?.id,'unknown');
});

import { DatabaseSync } from 'node:sqlite';
import { AmazonPersistence } from '../src/main/amazon/persistence.ts';
test('sales identity lookup reads only candidate records and keeps reimport/legacy/UNKNOWN identities',()=>{
 const db=new DatabaseSync(':memory:');
 try{
 db.exec('CREATE TABLE listing_drafts(id TEXT PRIMARY KEY, product_id TEXT, record_json TEXT, created_at TEXT)');
 const put=db.prepare('INSERT INTO listing_drafts VALUES(?,?,?,?)');
 for(let i=0;i<1000;i++)put.run('history-'+i,'unrelated',JSON.stringify({draft:{...saved,id:'history-'+i,sku:'OTHER-'+i,salesPlan:{...oldPlan,recipe:{key:'different-'+i}},schema:{parentageLevel:'NONE',padding:'x'.repeat(1000)}}}),'');
 put.run(saved.id,saved.productId,JSON.stringify({draft:{...saved,state:'UNKNOWN',submittedAt:null}}),'');
 const persistence=Object.create(AmazonPersistence.prototype) as AmazonPersistence;persistence.db=db;
 const rows=persistence.salesCandidates('reimported-product',nextPlan.sku,nextPlan.recipe.key);
 assert.equal(rows.length,1);assert.equal(rows[0].draft.id,'saved');
 const subject={getTarget:()=>target,persistence};assert.equal(AmazonService.prototype.findSalesDraft.call(subject as never,'reimported-product',nextPlan,'store')?.state,'UNKNOWN');
 }finally{db.close();}
});

test('indexed candidate lookup agrees with complete history for SKU, legacy quantity and cross-store guards',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec('CREATE TABLE listing_drafts(id TEXT PRIMARY KEY,product_id TEXT,record_json TEXT,created_at TEXT)');
 const rows=[saved,{...saved,id:'other-store',sellerId:'other'}, {...saved,id:'legacy',productId:'legacy-product',sku:'LEGACY',salesPlan:undefined,variantId:'v',businessRules:{bundleQuantity:2}}, {...saved,id:'same-sku',productId:'other-source',sku:'SAME-SKU',salesPlan:undefined,variantId:'other-v'}];
 for(const row of rows)db.prepare('INSERT INTO listing_drafts VALUES(?,?,?,?)').run(row.id,row.productId,JSON.stringify({draft:row}),'');
 const persistence=Object.create(AmazonPersistence.prototype) as AmazonPersistence;persistence.db=db;
 const full=Object.create(persistence) as AmazonPersistence;full.salesCandidates=()=>persistence.records();
 for(const [productId,plan] of [['reimport',nextPlan],['legacy-product',{...nextPlan,recipe:{key:'none',components:[{variantId:'v'}],totalPieces:2}}],['legacy-product',{...nextPlan,recipe:{key:'none',components:[{variantId:'v'}],totalPieces:3}}],['different',{...nextPlan,sku:'SAME-SKU'}]] as [string,SalesListingPlan][]){
  const lookup=(p:AmazonPersistence)=>AmazonService.prototype.findSalesDraft.call({getTarget:()=>target,persistence:p} as never,productId,plan,'store');assert.deepEqual(lookup(persistence),lookup(full));
 }
 }finally{db.close();}
});
