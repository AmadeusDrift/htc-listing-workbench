import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reconcileSalesIdentity } from '../src/main/sales-plans/reconciliation.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';

const oldPlan=():SalesListingPlan=>({namingGroupId:randomUUID(),sourceGroupKey:'1688:123:'+ 'a'.repeat(64),collectedAt:'2026-10-08T00:00:00.000Z',collectionBasis:'first_import',sku:'H2-261008-13',baseSku:'H2-261008-13',parentage:'NONE',parentSku:null,variationTheme:null,namingChildKey:null,familyResolved:true,relationReason:'old single',recipe:{key:'b'.repeat(64),groupKey:'a'.repeat(64),specification:'松针绿',color:'',totalPieces:1,totalCostCny:1,components:[]}});
function proposal(old:SalesListingPlan):SalesListingPlan{return {...old,namingGroupId:randomUUID(),sourceGroupKey:'1688:123:'+ 'c'.repeat(64),sku:'H2-261008-50-A',baseSku:'H2-261008-50',namingChildKey:old.recipe.key,parentage:'CHILD',parentSku:'H2-261008-50',variationTheme:'COLOR',recipe:{...old.recipe,groupKey:'c'.repeat(64),color:'Pine Green'}};}
test('family regroup retains old sales identity and exact image recipe, including its old blank color',()=>{
 const old=oldPlan(),fresh=proposal(old),result=reconcileSalesIdentity(old,fresh);
 for(const field of ['sku','baseSku','sourceGroupKey','namingGroupId','namingChildKey','collectedAt','recipe'] as const)assert.deepEqual(result[field],old[field]);
 assert.equal(result.parentage,'CHILD');assert.equal(result.parentSku,fresh.baseSku);
 assert.deepEqual(result.familyBinding,{parentNamingGroupId:fresh.namingGroupId,parentSourceGroupKey:fresh.sourceGroupKey,parentBaseSku:fresh.baseSku});
});
test('regroup cannot cross sources or recipes or silently move an existing child to another parent',()=>{
 const old=oldPlan(),fresh=proposal(old);
 assert.throws(()=>reconcileSalesIdentity(old,{...fresh,sourceGroupKey:'1688:999:'+'c'.repeat(64)}));
 assert.throws(()=>reconcileSalesIdentity(old,{...fresh,recipe:{...fresh.recipe,key:'d'.repeat(64)}}));
 assert.throws(()=>reconcileSalesIdentity({...old,parentage:'CHILD',parentSku:'OLD-PARENT',variationTheme:'COLOR'},fresh));
 assert.deepEqual(reconcileSalesIdentity(old,{...fresh,parentage:'NONE',parentSku:null,variationTheme:null}),old);
});
