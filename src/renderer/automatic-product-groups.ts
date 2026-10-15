import { presentRejection } from '../shared/rejection-presentation.ts';
import type { AutomaticQueueRow, AutomaticListingItem } from '../shared/automatic-listing-contracts.ts';
import type { ProductDetail, ProductSummary, Variant } from '../shared/contracts.ts';

import { automaticItemReason, summarizeAutomaticItems, automaticQueueDisplayKind, legacySourceServiceReason } from '../shared/automatic-status-projection.ts';
import type { AutomaticItemOutcome } from '../shared/automatic-status-projection.ts';
export { automaticQueueDisplayKind, automaticItemOutcome, automaticItemReason, summarizeAutomaticItems } from '../shared/automatic-status-projection.ts';
export type { AutomaticItemOutcome } from '../shared/automatic-status-projection.ts';

export interface AutomaticProductGroup {
  productId: string;
  title: string;
  sourceUrl: string;
  coverUrl: string | null;
  sourceVariantCount: number | null;
  sourceCountSnapshot?: boolean;
  excludedCount: number | null;
  sourceVariants: { variant: Variant; items: AutomaticListingItem[] }[];
  items: AutomaticListingItem[];
  families: { key: string; parentSku: string | null; label: string; items: AutomaticListingItem[] }[];
  parentSkus: string[];
  statusCounts: Record<AutomaticListingItem['status'], number>;
  stageCounts: Partial<Record<AutomaticListingItem['stage'], number>>;
  outcomeCounts: Record<AutomaticItemOutcome, number>;
}

/** Source products are presentation groups; only a persisted parentSku proves a parent family. */
export function buildAutomaticProductGroups(items: AutomaticListingItem[], products: ProductDetail[], summaries: ProductSummary[] = []): AutomaticProductGroup[] {
  const details = new Map(products.map(product => [product.id, product]));
  const summaryById = new Map(summaries.map(product => [product.id, product]));
  const grouped = new Map<string, AutomaticListingItem[]>();
  for (const item of items) {
    const siblings = grouped.get(item.productId) ?? [];
    siblings.push(item);
    grouped.set(item.productId, siblings);
  }
  return [...grouped].map(([productId, rows]) => {
    const detail = details.get(productId), summary = summaryById.get(productId);
    const byVariant = new Map<string, AutomaticListingItem[]>();
    const statusCounts: AutomaticProductGroup['statusCounts'] = { PENDING: 0, RUNNING: 0, WAITING: 0, DONE: 0, FAILED: 0, SCREENED:0 };
    const stageCounts: AutomaticProductGroup['stageCounts'] = {};
    const families = new Map<string, AutomaticProductGroup['families'][number]>();
    for (const item of rows) {
      statusCounts[item.status]++;
      stageCounts[item.stage] = (stageCounts[item.stage] ?? 0) + 1;
      const sourceIds = new Set([item.variantId, ...(item.salesPlan?.recipe.components.map(component => component.variantId) ?? [])]);
      for (const id of sourceIds) byVariant.set(id, [...(byVariant.get(id) ?? []), item]);
      const parentSku = item.salesPlan?.parentSku ?? null;
      const key = parentSku ? `parent:${parentSku}` : item.salesPlan?.sourceGroupKey ? `source:${item.salesPlan.sourceGroupKey}` : 'unresolved';
      const family = families.get(key) ?? { key, parentSku, label: parentSku ? `父 SKU：${parentSku}` : item.salesPlan?.recipe.specification || '待确定销售关系', items: [] };
      family.items.push(item);
      families.set(key, family);
    }
    const sourceVariants = detail?.variants.map(variant => ({ variant, items: byVariant.get(variant.id) ?? [] })) ?? [];
    const sourceAssets = detail?.assets.filter(asset => !asset.fileName.startsWith('自动生成-')) ?? [];
    return {
      productId, title: detail?.title || summary?.title || rows[0].productTitle || '未命名商品', sourceUrl: detail?.sourceUrl ?? summary?.sourceUrl ?? '',
      coverUrl: sourceAssets.find(asset => asset.role === 'main')?.previewUrl ?? sourceAssets[0]?.previewUrl ?? summary?.coverUrl ?? null,
      sourceVariantCount: detail ? detail.variants.length : summary?.variantCount ?? null,
      excludedCount: detail ? sourceVariants.filter(row => !row.items.length).length : null,
      sourceVariants, items: rows, families: [...families.values()], parentSkus: [...new Set(rows.flatMap(item => item.salesPlan?.parentSku ? [item.salesPlan.parentSku] : []))], statusCounts, stageCounts, outcomeCounts: summarizeAutomaticItems(rows),
    };
  });
}

export function filterAutomaticProductGroups(groups: AutomaticProductGroup[], search: string): AutomaticProductGroup[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return groups;
  return groups.filter(group => [group.title, group.sourceUrl, ...group.parentSkus,
    ...group.items.flatMap(item => [item.sku, item.salesPlan?.recipe.specification ?? '', item.salesPlan?.recipe.color ?? '', automaticItemReason(item)]),
    ...group.sourceVariants.flatMap(({ variant }) => [variant.sku, variant.originalSpec, variant.normalizedSpec, variant.sourceSpec]),
  ].some(value => value?.toLocaleLowerCase().includes(query)));
}

export function automaticQueueReason(row:AutomaticQueueRow):string {
 if(row.kind==='NEEDS_INPUT'&&automaticQueueDisplayKind(row)==='SYSTEM_REPAIR')return legacySourceServiceReason;
 if(row.kind==='UNKNOWN')return presentRejection(undefined,true);
 if(row.kind==='COMPLETED')return '流程已完成';
 if(row.kind==='SUBMITTED')return '已提交，等待平台回读';
 const notices:Record<string,string>={RULES_CHANGED:'上架规则已变化，重新评估',SOURCE_CHANGED:'来源资料已变化，重新评估',RECIPE_CHANGED:'销售配方已变化，重新评估',DRAFT_CHANGED:'草稿资料已变化，重新评估',PRICING_CHANGED:'当前定价已在本地重算合格',IMAGE_EVIDENCE_CHANGED:'图片证据或风险设置已变化，重新评估',UNKNOWN_RECONCILED:'原未知结果已核对，可重新准备；历史未知记录保留，不会自动重试',EVIDENCE_READ_FAILED:'暂无法核对已保存证据，记录保留待修复'};
 const notice=row.noticeCode&&Object.hasOwn(notices,row.noticeCode)?notices[row.noticeCode]:undefined;
 const text=notice?(notice+(['UNKNOWN_RECONCILED','EVIDENCE_READ_FAILED'].includes(row.noticeCode!)?'':'；原淘汰记录保留，旧任务不会自动重启')):row.reasonCode||row.message?presentRejection(row.reasonCode):'';
 return [text,row.continuationRequired?'请继续或取消原任务':''].filter(Boolean).join('；');
}
