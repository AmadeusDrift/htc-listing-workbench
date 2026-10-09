import type { DatabaseSync } from 'node:sqlite';
import { validateSalesPlan } from './records.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { validateSkuNamingGroup } from '../sku-naming/records.ts';
import { getSalesParentIdentity } from './family-binding.ts';

// Allocation keys end in the model hash; migrated parent containers add a family namespace.
const canonicalSource=(key:string):string|null=>key.match(/^(.+?):(?:family:)?[a-f0-9]{64}$/u)?.[1]??null;

/** Also used before changing a local draft, without relaxing its original SKU identity. */
export function assertSalesPlanNamingIdentity(db:DatabaseSync,raw:unknown,mode:string,sellerId:string):void {
  const plan=validateSalesPlan(raw),scope=JSON.stringify([mode,sellerId]);
  const group=db.prepare('SELECT id,record_json FROM sku_naming_groups WHERE store_scope=? AND source_group_key=?').get(scope,plan.sourceGroupKey);
  const identity=db.prepare('SELECT group_id,child_key FROM sku_naming_identities WHERE store_scope=? AND sku=?').get(scope,plan.sku);
  const snapshot=group?JSON.parse(String(group.record_json)):null;
  if(group?.id!==plan.namingGroupId||identity?.group_id!==plan.namingGroupId||identity?.child_key!==(plan.namingChildKey??'')||snapshot?.collectedAt!==plan.collectedAt||snapshot?.baseSku!==plan.baseSku)
    throw new UserFacingError('销售组合与持久 SKU 命名记录不一致');
  if(!plan.familyBinding) return;
  const parent=getSalesParentIdentity(plan)!;
  const parentGroup=db.prepare('SELECT id,record_json FROM sku_naming_groups WHERE store_scope=? AND source_group_key=?').get(scope,parent.sourceGroupKey);
  const parentIdentity=db.prepare('SELECT sku,group_id,child_key,child_index FROM sku_naming_identities WHERE store_scope=? AND sku=?').get(scope,parent.baseSku);
  const parentSnapshot=parentGroup?validateSkuNamingGroup(JSON.parse(String(parentGroup.record_json))):null;
  const source=canonicalSource(plan.sourceGroupKey);
  if(parentGroup?.id!==parent.namingGroupId||parentSnapshot?.id!==parent.namingGroupId||parentSnapshot?.storeScope!==scope
    ||parentSnapshot?.sourceGroupKey!==parent.sourceGroupKey||parentSnapshot?.baseSku!==parent.baseSku
    ||parentIdentity?.sku!==parent.baseSku||parentIdentity?.group_id!==parent.namingGroupId||parentIdentity?.child_key!==''||parentIdentity?.child_index!==0
    ||!source||canonicalSource(parent.sourceGroupKey)!==source)
    throw new UserFacingError('销售组合的父体引用与同店铺、同来源的 SKU 命名记录不一致');
}

/** Saved tasks/drafts may outlive source edits; their immutable naming ledger must still agree. */
export function assertSalesPlanHistory(db:DatabaseSync):void {
  for(const row of db.prepare('SELECT record_json FROM listing_drafts WHERE record_json IS NOT NULL').all()){
    const draft=JSON.parse(String(row.record_json)).draft;if(draft?.salesPlan)assertSalesPlanNamingIdentity(db,draft.salesPlan,draft.mode,draft.sellerId);
  }
  for(const row of db.prepare('SELECT record_json FROM automatic_listing_tasks').all()){
    const task=JSON.parse(String(row.record_json));
    for(const item of task.items){
      if(item.salesPlan)assertSalesPlanNamingIdentity(db,item.salesPlan,task.mode,task.sellerId);
      if(item.familyTransition)assertSalesPlanNamingIdentity(db,item.familyTransition.plan,task.mode,task.sellerId);
    }
  }
}
