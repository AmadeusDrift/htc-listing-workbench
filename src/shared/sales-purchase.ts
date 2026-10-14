import type { SalesRecipe } from './sales-plan-contracts.ts';
import type { SourceContent } from './source-quantity.ts';
export interface PurchaseComponent {sourceKey:string;variantId:string;specification:string;pieces:number;originalPacks:number;quoteUnits:number;costCny:number|null;needsSplit:boolean;unit?:'kit'|'unknown';contents?:SourceContent[]}
/** Quote units may be fractional when the supplier agrees to split an original pack. */
export function salesPurchaseComponents(recipe:SalesRecipe,sets:number):PurchaseComponent[] {
  if(!Number.isSafeInteger(sets)||sets<0||sets>1000000)throw new Error('备货套数无效');
  return recipe.components.map(c=>({sourceKey:c.sourceKey,variantId:c.variantId,specification:c.specification,pieces:c.quantity*sets,originalPacks:c.quantity*sets/c.sourcePackPieces,quoteUnits:c.quantity*sets/c.piecesPerQuote,
    costCny:c.quotedCostCny===null?null:Math.round((c.quotedCostCny*c.quantity*sets/c.piecesPerQuote+Number.EPSILON)*1e8)/1e8,
    needsSplit:c.quantity%c.sourcePackPieces!==0||recipe.components.length>1,...(c.unitSemantics?{unit:c.unitSemantics.saleUnit,contents:c.unitSemantics.contents.map(item=>({...item,quantity:item.quantity===null?null:item.quantity*c.quantity*sets}))}:{}),
    ...(c.unitSemantics?.quoteUnit==='unknown'?{costCny:null}: {})}));
}
export function salesPurchaseDescription(recipe:SalesRecipe,sets:number):string {
  return salesPurchaseComponents(recipe,sets).map(c=>`${c.specification || c.sourceKey}：${c.pieces} ${c.unit==='kit'?'整套':c.unit==='unknown'?'单位待确认':'件'}；原包数 ${Number(c.originalPacks.toFixed(6))}；计价单位 ${Number(c.quoteUnits.toFixed(6))}；成本 ${c.costCny===null?'待确认':Number(c.costCny.toFixed(4))}${c.contents?.length?`；组成 ${c.contents.map(item=>`${item.name}×${item.quantity??'数量未知'}`).join('、')}`:''}${c.needsSplit?'（拆包／混装）':''}`).join(' | ');
}
