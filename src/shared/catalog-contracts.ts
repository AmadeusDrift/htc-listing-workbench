import type { ProductTypeOption } from './amazon-contracts.ts';
export interface CategoryLibrary {
  id: string; targetId: string; sellerId: string; marketplaceId: string; locale: string; mode: 'demo' | 'live';
  kind: 'product-types-v1'; fetchedAt: string; productTypes: ProductTypeOption[];
}
export interface CategoryMatch extends ProductTypeOption { score: number; reason: string }
export interface CatalogApi {
  getCategoryLibrary(targetId: string): Promise<CategoryLibrary | null>;
  syncCategoryLibrary(targetId: string): Promise<CategoryLibrary>;
  searchLocalCategories(input: { targetId: string; query: string }): Promise<CategoryMatch[]>;
}
