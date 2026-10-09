import type { AmazonDraft, JsonObject } from '../../shared/amazon-contracts.ts';
import type { ListingObservation } from '../../shared/followup-contracts.ts';
import { isObject } from './context.ts';

const themeKey=(theme:string)=>theme.split('/').map(axis=>axis==='COLOR_NAME'?'COLOR':axis).sort().join('/');
/** Only Amazon's returned VARIATION relationships prove that a child actually joined its family. */
export function observeFamilyRelationship(draft:AmazonDraft,response:JsonObject):NonNullable<ListingObservation['familyRelationship']> {
  const plan=draft.salesPlan;
  if(plan?.parentage!=='CHILD')return {status:'NOT_REQUIRED',parentSkus:[],variationTheme:null};
  const markets=Array.isArray(response.relationships)?response.relationships.filter(isObject).filter(m=>m.marketplaceId===draft.marketplaceId):[];
  const relations=markets.flatMap(m=>Array.isArray(m.relationships)?m.relationships.filter(isObject):[]).filter(r=>r.type==='VARIATION');
  const parents=[...new Set(relations.flatMap(r=>Array.isArray(r.parentSkus)?r.parentSkus.filter((sku):sku is string=>typeof sku==='string'):[]))];
  const themes=[...new Set(relations.flatMap(r=>isObject(r.variationTheme)&&typeof r.variationTheme.theme==='string'?[r.variationTheme.theme]:[]))];
  const mismatch=parents.some(sku=>sku!==plan.parentSku)||themes.some(theme=>themeKey(theme)!==themeKey(plan.variationTheme!));
  return {status:mismatch?'MISMATCHED':parents.length===1&&parents[0]===plan.parentSku&&themes.length===1?'MATCHED':'WAITING',parentSkus:parents,variationTheme:themes[0]??null};
}
