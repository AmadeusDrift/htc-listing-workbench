import type { SourceUnitSemantics } from './source-quantity.ts';
export interface SalesComponent {
  variantId: string; sourceKey: string; sourceSku: string; specification: string; color: string;
  quantity: number; quotedCostCny: number | null; piecesPerQuote: number; sourcePackPieces: number;
  unitSemantics?:SourceUnitSemantics;
}
export interface SalesRecipe {
  key: string; groupKey: string; specification: string; color: string;
  components: SalesComponent[]; totalPieces: number; totalCostCny: number | null;
  /** v2 totalPieces counts sale units; platform pieces are separately confirmed for heterogeneous kits. */
  quantityVersion?:2; platformPieces?:number|null;
}
/** Actual family membership is separate from the sale's immutable naming allocation. */
export interface SalesFamilyBinding {
  parentNamingGroupId: string; parentSourceGroupKey: string; parentBaseSku: string;
}
export interface SalesListingPlan {
  namingGroupId: string; sourceGroupKey: string; collectedAt: string; collectionBasis: 'source' | 'first_import';
  sku: string; baseSku: string; recipe: SalesRecipe;
  parentage: 'NONE' | 'PARENT' | 'CHILD'; parentSku: string | null;
  variationTheme: string | null; relationReason: string;
  familyResolved: boolean; namingChildKey: string | null;
  familyBinding?: SalesFamilyBinding;
  unitAdoption?:{version:1;originalRecipeKey:string;previousRecipe:SalesRecipe;at:string;basis:string};
}
