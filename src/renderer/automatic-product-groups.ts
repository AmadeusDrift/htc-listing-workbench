import { sanitizeFailureReason } from '../shared/automatic-resume.ts';
import { presentRejection } from '../shared/rejection-presentation.ts';
import type { AutomaticQueueRow, AutomaticListingItem } from '../shared/automatic-listing-contracts.ts';
import type { ProductDetail, ProductSummary, Variant } from '../shared/contracts.ts';

export function automaticItemReason(item:AutomaticListingItem):string{return sanitizeFailureReason(itemReason(item));}
function itemReason(item: AutomaticListingItem): string {
  const code = item.outcome?.kind === 'RULE_FILTERED' ? item.outcome.code : item.rejection?.detail.code ?? item.outcome?.code;
  const reasons: Record<string, string> = {
    FIELD_RESULT_UNKNOWN: '字段请求结果未知，请查看已保存的字段调用记录与恢复进度。',
    IMAGE_RESULT_UNKNOWN: '图片请求结果未知，请查看已保存的图片调用记录与恢复进度；已完成图片保留。',
    SOURCE_CONSISTENCY_SENT_UNKNOWN: '来源观察请求结果未知，请查看已保存的来源调用记录与恢复进度。',
    SUBMISSION_UNKNOWN: 'Amazon 正式提交结果未知，禁止自动重发。请查询原提交结果。',
    READBACK_BRAND_REQUIRES_MANUAL: '品牌已为 Generic，Amazon 仍返回品牌问题，需人工处理；请查看平台字段及错误代码。',
    LABELS_FAILED: '商品标签处理失败，请查看备货与标签中的具体原因；已提交商品和已保存文件保留。',
  };
  if(item.status==='FAILED'&&(item.error||item.outcome?.message))return sanitizeFailureReason(item.error||item.outcome!.message);
  if (code && Object.hasOwn(reasons, code)) return reasons[code];
  if (item.stage === 'READBACK' && (!['DONE', 'FAILED', 'SCREENED'].includes(item.status) || code === 'READBACK_FAILED')) return item.error || item.outcome?.message || '已提交，等待 Amazon 回读确认；接受提交不等于已可售。';
  if (item.outcome?.kind === 'UNKNOWN') return '结果待核对，请查看当前步骤已保存的调用与恢复记录；正式提交结果未知时禁止自动重发。';
  if (['FAILED', 'SCREENED'].includes(item.status)) return presentRejection(code);
  if (item.stage === 'LABELS') return '平台建档结果待核对，请查看备货与标签中的进度；已提交商品保留。';
  const waiting: Record<AutomaticListingItem['stage'], string> = {
    PLAN: '等待销售规格处理。', SOURCES: '等待来源资料与参考图处理。', CLASSIFY: '等待商品类目判断返回。',
    DRAFT: '等待字段处理返回。', IMAGES: '等待图片生成或检测返回；已完成图片保留。', PARENT: '等待父体建档结果。',
    EXECUTION: '等待图片上传、验证或正式提交处理结果。', READBACK: '', LABELS: '', COMPLETE: '流程已完成。',
  };
  return item.status === 'WAITING' ? waiting[item.stage] : presentRejection(code);
}
export type AutomaticItemOutcome = 'completed' | 'submittedAwaitingReadback' | 'labels' | 'running' | 'waiting' | 'pending' | 'ruleFiltered' | 'notSelected' | 'profitFiltered' | 'needsInput' | 'systemRepair' | 'unknown' | 'unclassified';
export function automaticItemOutcome(item: AutomaticListingItem): AutomaticItemOutcome {
  if (item.status === 'FAILED'||item.status==='SCREENED') {
    if(item.outcome?.kind==='RULE_FILTERED'){
      if(item.outcome.code==='SKU_SELECTION_FILTERED')return 'notSelected';
      if(item.outcome.pricingReport)return 'profitFiltered';
    }
    return item.outcome?({RULE_FILTERED:'ruleFiltered',SYSTEM_REPAIR:'systemRepair',NEEDS_INPUT:'needsInput',UNKNOWN:'unknown',UNCLASSIFIED:'unclassified'} as const)[item.outcome.kind]:'unclassified';
  }
  if (item.status === 'DONE') return 'completed';
  if (item.stage === 'READBACK') return 'submittedAwaitingReadback';
  if (item.stage === 'LABELS') return 'labels';
  return item.status === 'RUNNING' ? 'running' : item.status === 'WAITING' ? 'waiting' : 'pending';
}
export function summarizeAutomaticItems(items: AutomaticListingItem[]): Record<AutomaticItemOutcome, number> {
  const counts: Record<AutomaticItemOutcome, number> = { completed: 0, submittedAwaitingReadback: 0, labels: 0, running: 0, waiting: 0, pending: 0, ruleFiltered: 0, notSelected:0, profitFiltered:0, needsInput: 0, systemRepair: 0, unknown:0,unclassified:0 };
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
    ...group.items.flatMap(item => [item.sku, item.salesPlan?.recipe.specification ?? '', item.salesPlan?.recipe.color ?? '', automaticItemReason(item)]),
    ...group.sourceVariants.flatMap(({ variant }) => [variant.sku, variant.originalSpec, variant.normalizedSpec, variant.sourceSpec]),
  ].some(value => value?.toLocaleLowerCase().includes(query)));
}

export function automaticQueueReason(row:AutomaticQueueRow):string {
 if(row.kind==='UNKNOWN')return presentRejection(undefined,true);
 if(row.kind==='COMPLETED')return '流程已完成';
 if(row.kind==='SUBMITTED')return '已提交，等待平台回读';
 const notices:Record<string,string>={RULES_CHANGED:'上架规则已变化，重新评估',SOURCE_CHANGED:'来源资料已变化，重新评估',RECIPE_CHANGED:'销售配方已变化，重新评估',DRAFT_CHANGED:'草稿资料已变化，重新评估',PRICING_CHANGED:'当前定价已在本地重算合格',IMAGE_EVIDENCE_CHANGED:'图片证据或风险设置已变化，重新评估',UNKNOWN_RECONCILED:'原未知结果已核对，可重新准备；历史未知记录保留，不会自动重试',EVIDENCE_READ_FAILED:'暂无法核对已保存证据，记录保留待修复'};
 const notice=row.noticeCode&&Object.hasOwn(notices,row.noticeCode)?notices[row.noticeCode]:undefined;
 const text=notice?(notice+(['UNKNOWN_RECONCILED','EVIDENCE_READ_FAILED'].includes(row.noticeCode!)?'':'；原淘汰记录保留，旧任务不会自动重启')):row.reasonCode||row.message?presentRejection(row.reasonCode):'';
 return [text,row.continuationRequired?'请继续或取消原任务':''].filter(Boolean).join('；');
}
