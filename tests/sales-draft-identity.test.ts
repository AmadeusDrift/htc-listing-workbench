import test from 'node:test';
import assert from 'node:assert/strict';
import { AmazonService } from '../src/main/amazon/service.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';

const hash='a'.repeat(64),target={id:'store',sellerId:'seller',marketplaceId:'US',mode:'live'};
const oldPlan={sku:'OLD',sourceGroupKey:`1688:source:${'b'.repeat(64)}`,recipe:{key:hash}} as SalesListingPlan;
const nextPlan={...oldPlan,sku:'NEW-A',sourceGroupKey:`1688:source:${'c'.repeat(64)}`};
const saved={id:'saved',targetId:'store',sellerId:'seller',marketplaceId:'US',mode:'live',productId:'product',sku:'OLD',schema:{parentageLevel:'NONE'},salesPlan:oldPlan,state:'SUBMITTED',submittedAt:'2026-10-09T10:00:00Z',updatedAt:'2026-10-09T10:00:00Z'};
function find(rows:unknown[],productId='product',plan=nextPlan){
 const subject={getTarget:()=>target,persistence:{records:()=>rows.map(draft=>({draft}))}};
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
