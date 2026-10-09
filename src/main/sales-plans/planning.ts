import type { ProductDetail } from '../../shared/contracts.ts';
import type { AmazonTarget } from '../../shared/amazon-contracts.ts';
import type { ListingRules } from '../../shared/listing-rules.ts';
import type { MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import type { SalesListingPlan } from '../../shared/sales-plan-contracts.ts';
import type { SkuNamingService } from '../sku-naming/service.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { buildSalesRecipes } from './recipes.ts';
import { confirmedPurchaseCurrency } from '../amazon/business-currency.ts';

export const salesStoreScope=(target:Pick<AmazonTarget,'mode'|'sellerId'>)=>JSON.stringify([target.mode,target.sellerId]);
export function planSalesListings(product:ProductDetail,receipt:MiaoshouReceipt|null,target:AmazonTarget,rules:ListingRules,naming:SkuNamingService):SalesListingPlan[] {
  const settings=naming.getSettings(),binding=settings.bindings.find(b=>b.targetId===target.id);
  const inferred=target.name.match(/(?:^|[^a-z0-9])(U[268])(?:$|[^a-z0-9])/i)?.[1].toUpperCase();
  const storeCode=binding?.storeCode??rules.product.targetShops[target.id]??inferred??(target.mode==='demo'?'U2':null);
  if(!storeCode) throw new UserFacingError('请在设置 → SKU 命名中绑定当前店铺编号，之后自动任务会沿用此模板');
  const currency=confirmedPurchaseCurrency(product.facts,!!receipt?.snapshot.sources.some(s=>s.source==='1688')||receipt?.mapping.currency==='CNY');
  const recipes=buildSalesRecipes(currency.cny?product:{...product,variants:product.variants.map(v=>({...v,purchasePrice:''}))},currency.cny?receipt:null,rules);
  const source=receipt?.snapshot.sources.find(s=>s.source==='1688'&&s.sourceItemId);
  const sourceId=source?`1688:${source.sourceItemId}`:receipt?`miaoshou:${receipt.accountScope}:${receipt.snapshot.remoteId}`:`local:${product.id}`;
  const grouped=new Map<string,typeof recipes>(),result:SalesListingPlan[]=[];
  for(const recipe of recipes){const group=grouped.get(recipe.groupKey)??[];group.push(recipe);grouped.set(recipe.groupKey,group);}
  for(const [groupKey,groupRecipes] of grouped){
    const sourceGroupKey=`${sourceId}:${groupKey}`,scope=salesStoreScope(target),existing=naming.lookup(scope,sourceGroupKey);
    // The connector currently exposes read/import time, not the original collection timestamp.
    const collectedAt=existing?.collectedAt??receipt?.receivedAt??product.createdAt;
    const hasChildren=groupRecipes.length>1||!!existing?.children.length;
    const group=naming.allocate({storeScope:scope,storeCode,sourceGroupKey,collectedAt,childKeys:hasChildren?groupRecipes.map(r=>r.key).sort():[],targetId:target.id});
    for(const recipe of groupRecipes){
      const child=group.children.find(c=>c.key===recipe.key);
      result.push({namingGroupId:group.id,sourceGroupKey,collectedAt:group.collectedAt,collectionBasis:'first_import',sku:child?.sku??group.baseSku,baseSku:group.baseSku,
        recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:hasChildren?'待类目 Schema 确定关系':'单一销售规格',familyResolved:!hasChildren,namingChildKey:child?.key??null});
    }
  }
  return result;
}
