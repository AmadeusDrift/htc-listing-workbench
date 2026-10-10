import type { AutomaticListingItem } from '../shared/automatic-listing-contracts.ts';
import type { ProductDetail, ProductSummary, Variant } from '../shared/contracts.ts';

export type AutomaticItemOutcome = 'completed' | 'submittedAwaitingReadback' | 'labels' | 'running' | 'waiting' | 'pending' | 'ruleFiltered' | 'needsInput' | 'systemRepair' | 'unknown' | 'unclassified';
export function automaticItemOutcome(item: AutomaticListingItem): AutomaticItemOutcome {
  if (item.status === 'FAILED'||item.status==='SCREENED') {
    return item.outcome?({RULE_FILTERED:'ruleFiltered',SYSTEM_REPAIR:'systemRepair',NEEDS_INPUT:'needsInput',UNKNOWN:'unknown',UNCLASSIFIED:'unclassified'} as const)[item.outcome.kind]:'unclassified';
  }
  if (item.status === 'DONE') return 'completed';
  if (item.stage === 'READBACK') return 'submittedAwaitingReadback';
  if (item.stage === 'LABELS') return 'labels';
  return item.status === 'RUNNING' ? 'running' : item.status === 'WAITING' ? 'waiting' : 'pending';
}
export function summarizeAutomaticItems(items: AutomaticListingItem[]): Record<AutomaticItemOutcome, number> {
  const counts: Record<AutomaticItemOutcome, number> = { completed: 0, submittedAwaitingReadback: 0, labels: 0, running: 0, waiting: 0, pending: 0, ruleFiltered: 0, needsInput: 0, systemRepair: 0, unknown:0,unclassified:0 };
  for (const item of items) counts[automaticItemOutcome(item)]++;
  return counts;
}

export interface AutomaticProductGroup {
  productId: string;
  title: string;
  sourceUrl: string;
  coverUrl: string | null;
  sourceVariantCount: number | null;
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
      sourceVariantCount: detail ? detail.variants.length : null,
      excludedCount: detail ? sourceVariants.filter(row => !row.items.length).length : null,
      sourceVariants, items: rows, families: [...families.values()], parentSkus: [...new Set(rows.flatMap(item => item.salesPlan?.parentSku ? [item.salesPlan.parentSku] : []))], statusCounts, stageCounts, outcomeCounts: summarizeAutomaticItems(rows),
    };
  });
}

export function filterAutomaticProductGroups(groups: AutomaticProductGroup[], search: string): AutomaticProductGroup[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return groups;
  return groups.filter(group => [group.title, group.sourceUrl, ...group.parentSkus,
    ...group.items.flatMap(item => [item.sku, item.salesPlan?.recipe.specification ?? '', item.salesPlan?.recipe.color ?? '']),
    ...group.sourceVariants.flatMap(({ variant }) => [variant.sku, variant.originalSpec, variant.normalizedSpec, variant.sourceSpec]),
  ].some(value => value?.toLocaleLowerCase().includes(query)));
}
