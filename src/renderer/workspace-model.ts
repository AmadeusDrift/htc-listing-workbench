import type { ProductSummary } from '../shared/contracts.ts';
import type { AmazonDraft } from '../shared/amazon-contracts.ts';

type Placement = { productId: string; lane: 'inbox' | 'manual' | 'automatic' | 'ignored' };
export function productsInLane(products: ProductSummary[], placements: Placement[], lane: Placement['lane']): ProductSummary[] {
  const byId = new Map(placements.map(item => [item.productId, item.lane]));
  return products.filter(product => (byId.get(product.id) ?? 'manual') === lane);
}
export function resultCounts(drafts: AmazonDraft[]) {
  const live = drafts.filter(draft => draft.mode === 'live');
  return {
    submitted: live.filter(draft => draft.submittedAt).length,
    buyable: live.filter(draft => draft.statuses.includes('BUYABLE')).length,
    attention: live.filter(draft => ['UNKNOWN', 'BLOCKED'].includes(draft.state)).length,
    demo: drafts.length - live.length,
  };
}
export function productGaps(product: ProductSummary): string[] {
  return [!product.title.trim() && '商品标题', !product.variantCount && 'SKU 规格', !product.assetCount && '商品图片'].filter((value): value is string => Boolean(value));
}
