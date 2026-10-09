import type { AmazonDraft, AmazonTarget } from '../shared/amazon-contracts.ts';
import type { ProductSummary } from '../shared/contracts.ts';
import type { ProcurementCandidate } from '../shared/procurement-contracts.ts';

export type ProductInsightStatus = 'buyable' | 'recorded' | 'waiting' | 'attention' | 'not_submitted';
export const insightStatusLabels: Record<ProductInsightStatus, string> = {
  buyable: '可以销售', recorded: 'Amazon 已生成商品', waiting: '等待平台确认', attention: '需要处理', not_submitted: '还没提交',
};
export interface ProductInsightRow {
  draftId: string; productId: string; title: string; image: string | null; sku: string;
  targetName: string; targetId: string; mode: 'live' | 'demo'; asin: string | null; checkedAt: string | null;
  status: ProductInsightStatus; detail: string; sourcePrice: string;
  sales7d: number | null; sales30d: number | null; availableInventory: number | null; inboundInventory: number | null; replenishment: number | null;
}
/** Listing evidence and sales/inventory metrics have different sources. Missing metrics never become zero. */
export function productInsights(products: ProductSummary[], drafts: AmazonDraft[], candidates: ProcurementCandidate[], targets: AmazonTarget[], targetId: string) {
  const selected = targets.find(target => target.id === targetId), mode = selected?.mode ?? 'live';
  const latest = new Map<string, AmazonDraft>();
  const attempted = (draft: AmazonDraft) => Boolean(draft.submittedAt || ['UNKNOWN','SUBMITTING'].includes(draft.state));
  for (const draft of drafts) {
    if (draft.mode !== mode || targetId && draft.targetId !== targetId || draft.schema.parentageLevel === 'PARENT') continue;
    const key = JSON.stringify([draft.targetId,draft.sellerId,draft.marketplaceId,draft.sku]), prior = latest.get(key);
    if (!prior || attempted(draft) && !attempted(prior) || attempted(draft) === attempted(prior) && (draft.submittedAt ?? draft.updatedAt) > (prior.submittedAt ?? prior.updatedAt)) latest.set(key, draft);
  }
  const evidence = new Map(candidates.map(candidate => [candidate.draftId, candidate])), names = new Map(products.map(product => [product.id, product]));
  const rows: ProductInsightRow[] = [...latest.values()].map(draft => {
    const source = names.get(draft.productId), candidate = evidence.get(draft.id), target = targets.find(item => item.id === draft.targetId);
    const sameScope = !!target && target.mode === draft.mode && target.sellerId === draft.sellerId && target.marketplaceId === draft.marketplaceId;
    const trusted = sameScope && candidate?.eligible && candidate.sku === draft.sku && candidate.targetId === draft.targetId && candidate.sellerId === draft.sellerId && candidate.marketplaceId === draft.marketplaceId && candidate.mode === draft.mode && candidate.checkedAt === draft.checkedAt;
    const needsAttention = !sameScope || candidate?.requiresAttention === true || ['UNKNOWN','BLOCKED'].includes(draft.state) || draft.listingIssues.some(issue => issue.severity === 'ERROR');
    const status: ProductInsightStatus = needsAttention ? 'attention' : !draft.submittedAt && draft.state !== 'SUBMITTING' ? 'not_submitted' : trusted ? draft.statuses.includes('BUYABLE') ? 'buyable' : 'recorded' : 'waiting';
    return { draftId: draft.id, productId: draft.productId, title: source?.title ?? '原商品已不在本地列表', image: source?.coverUrl ?? null, sku: draft.sku, targetId: draft.targetId, targetName: draft.targetName, mode: draft.mode,
      asin: trusted ? candidate!.asin : null, checkedAt: draft.checkedAt, status, detail: !sameScope ? '店铺身份已变化，请先核对' : candidate?.reason ?? insightStatusLabels[status], sourcePrice: candidate?.sourcePurchasePrice ?? '',
      sales7d: null, sales30d: null, availableInventory: null, inboundInventory: null, replenishment: null };
  }).sort((a,b) => (b.checkedAt ?? '').localeCompare(a.checkedAt ?? '') || a.sku.localeCompare(b.sku));
  return { rows, metricsState: 'not_connected' as const, counts: { products: new Set(rows.map(row => row.productId)).size, skus: rows.length,
    buyable: rows.filter(row => row.status === 'buyable').length, attention: rows.filter(row => row.status === 'attention').length } };
}
