import { startVisiblePolling } from './visible-polling.ts';
import type { AmazonDraft, AmazonTarget } from '../shared/amazon-contracts.ts';
import type { ProductDetail, RedApi } from '../shared/contracts.ts';
import type { ListingRules } from '../shared/listing-rules.ts';
import type { ImageWorkflowApi, ImageWorkflowRun } from '../shared/image-workflow-contracts.ts';
import { hasSevenApprovedImages } from '../shared/image-workflow-contracts.ts';
import { errorText } from './utils.ts';

export interface AutomaticPreparationItem {
  key: string; productId: string; productRevision: number; productTitle: string; variantId: string; sku: string; stockSets: number;
}
export interface AutomaticPreparationPlan {
  ruleRevision: number; variantLimit: number; stockSets: number;
  products: { productId: string; title: string; selected: number; omitted: number }[];
  rows: AutomaticPreparationItem[];
}
export interface AutomaticPreparationProgress extends AutomaticPreparationItem {
  state: 'pending' | 'syncing' | 'preparing' | 'completing' | 'done' | 'blocked' | 'failed' | 'skipped' | 'stopped';
  draft: AmazonDraft | null; workflow: ImageWorkflowRun | null; reused: boolean; aiCalls: number | null; previewAttempts: number | null; remaining: string[]; error: string | null;
}
export type AutomaticPreparationApi = Pick<RedApi, 'listAmazonDrafts' | 'prepareAmazonDrafts'> & ImageWorkflowApi;

export function createAutomaticPreparationPlan(products: ProductDetail[], rules: ListingRules): AutomaticPreparationPlan {
  const { variantLimit, stockSets } = rules.product;
  return { ruleRevision: rules.revision, variantLimit, stockSets,
    products: products.map(product => ({ productId: product.id, title: product.title, selected: Math.min(product.variants.length, variantLimit), omitted: Math.max(0, product.variants.length - variantLimit) })),
    // Source order is deliberate: sorting by SKU would select different variants.
    rows: products.flatMap(product => product.variants.slice(0, variantLimit).map(variant => ({ key: `${product.id}:${variant.id}`, productId: product.id,
      productRevision: product.revision, productTitle: product.title, variantId: variant.id, sku: variant.sku, stockSets }))),
  };
}

export function plannedStockPieces(row: Pick<AutomaticPreparationProgress, 'draft' | 'stockSets'>): number | null {
  const report = row.draft?.businessRules;
  return report?.quote ? row.stockSets * report.bundleQuantity : null;
}

const editableStates = new Set<AmazonDraft['state']>(['DRAFT', 'BLOCKED', 'LOCAL_VALIDATED', 'AMAZON_VALIDATED']);
function matchesListing(draft: AmazonDraft, row: AutomaticPreparationItem, target: AmazonTarget): boolean {
  return draft.sku === row.sku && draft.sellerId === target.sellerId && draft.marketplaceId === target.marketplaceId && draft.mode === target.mode;
}
function reusableDraft(drafts: AmazonDraft[], row: AutomaticPreparationItem, target: AmazonTarget, productType: string): AmazonDraft | undefined {
  return drafts.filter(draft => matchesListing(draft, row, target) && draft.targetId === target.id && draft.productId === row.productId && draft.variantId === row.variantId &&
    draft.productRevision === row.productRevision && !draft.submittedAt && editableStates.has(draft.state) && draft.listingProgram === (target.mode === 'live' ? 'haul' : 'standard') &&
    draft.schema.targetId === target.id && draft.schema.productType === productType && draft.schema.requirements === 'LISTING' && draft.schema.parentageLevel === 'NONE' && draft.schema.locale === target.locale)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.revision - left.revision)[0];
}

/** A bounded preparation run that downloads mapped sources but never submits listings. */
export async function runAutomaticPreparation(api: AutomaticPreparationApi, input: { plan: AutomaticPreparationPlan; target: AmazonTarget; productType: string },
  options: { signal?: AbortSignal; isProgressVisible?: () => boolean; onProgress?: (rows: AutomaticPreparationProgress[]) => void } = {}): Promise<AutomaticPreparationProgress[]> {
  const { plan, target } = input, productType = input.productType.trim(), { signal } = options;
  if (!target.configured || target.paused) throw new Error('请选择已配置且启用的目标店铺');
  if (!productType) throw new Error('请先确认商品类型');
  const rows: AutomaticPreparationProgress[] = plan.rows.map(row => ({ ...row, state: 'pending', draft: null, workflow: null, reused: false, aiCalls: null, previewAttempts: null, remaining: [], error: null }));
  const indexes = new Map(rows.map((row, index) => [row.key, index]));
  const publish = (row: AutomaticPreparationItem, patch: Partial<AutomaticPreparationProgress>) => {
    const index = indexes.get(row.key)!; rows[index] = { ...rows[index], ...patch }; options.onProgress?.([...rows]);
  };
  let activeDraft: string | null = null, activeSource: string | null = null;
  const cancelActive = () => {
    if (activeSource) void api.cancelAutomaticProductSources(activeSource).catch(() => undefined);
    if (activeDraft) void api.cancelAutomaticProduct(activeDraft).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancelActive, { once: true });
  options.onProgress?.([...rows]);
  const knownDrafts = new Map<string, AmazonDraft[]>(), preparedProducts = new Set<string>();
  const prepareSourcesForProduct = async (productId: string) => {
    if (preparedProducts.has(productId)) return;
    preparedProducts.add(productId);
    const productRows = rows.filter(row => row.productId === productId);
    let drafts: AmazonDraft[];
    try { drafts = await api.listAmazonDrafts(productId); knownDrafts.set(productId, drafts); }
    catch (error) { productRows.forEach(row => publish(row, { state: signal?.aborted ? 'stopped' : 'failed', error: errorText(error) })); return; }
    if (signal?.aborted) return;
    const eligible = productRows.filter(row => {
      if (!drafts.some(draft => matchesListing(draft, row, target) && (draft.submittedAt || !editableStates.has(draft.state)))) return true;
      publish(row, { state: 'skipped', error: '同一 SKU 已提交、正在提交或结果未知，请转手动核对，未重试。' }); return false;
    });
    if (!eligible.length || signal?.aborted) return;
    eligible.forEach(row => publish(row, { state: 'syncing' }));
    if (signal?.aborted) return;
    activeSource = productId;
    try {
      const result = await api.prepareAutomaticProductSources({ productId, productRevision: eligible[0].productRevision, variantIds: eligible.map(row => row.variantId) });
      // A single source download can advance the whole product's revision. Update
      // every selected row, including rows beyond the current 50-item chunk.
      productRows.forEach(row => publish(row, { productRevision: result.product.revision }));
      const missing = new Map(result.missing.map(value => [value.variantId, value.message]));
      eligible.forEach(row => publish(row, { state: signal?.aborted ? 'stopped' : missing.has(row.variantId) ? 'blocked' : 'pending', error: signal?.aborted ? null : missing.get(row.variantId) ?? null }));
    } catch (error) {
      eligible.forEach(row => publish(row, { state: signal?.aborted ? 'stopped' : 'failed', error: errorText(error) }));
    } finally { activeSource = null; }
  };
  try {
    for (let offset = 0; offset < rows.length && !signal?.aborted; offset += 50) {
      const chunk = rows.slice(offset, offset + 50), create: AutomaticPreparationItem[] = [];
      for (const original of chunk) {
        if (signal?.aborted) break;
        await prepareSourcesForProduct(original.productId);
        if (signal?.aborted) break;
        const row = rows[indexes.get(original.key)!];
        if (row.state !== 'pending') continue;
        const drafts = knownDrafts.get(row.productId)!;
        const draft = reusableDraft(drafts, row, target, productType);
        if (draft) publish(row, { draft, reused: true });
        else create.push(row);
      }
      if (create.length && !signal?.aborted) {
        create.forEach(row => publish(row, { state: 'preparing' }));
        try {
          const result = await api.prepareAmazonDrafts({ targetId: target.id, productType, parentageLevel: 'NONE', requirements: 'LISTING', locale: target.locale,
            listingProgram: target.mode === 'live' ? 'haul' : 'standard',
            items: create.map(row => ({ productId: row.productId, productRevision: row.productRevision, variantId: row.variantId, attributes: {} })),
          });
          for (const row of create) {
            const item = result.items.find(item => item.productId === row.productId && item.variantId === row.variantId);
            if (!item?.draft || item.disposition === 'REJECTED') publish(row, { state: 'failed', error: item?.error || item?.issues.map(issue => issue.message).join('；') || '草稿准备未返回结果' });
            else publish(row, { state: 'pending', draft: item.draft, reused: item.disposition === 'REUSED' });
          }
        } catch (error) { create.forEach(row => publish(row, { state: 'failed', error: errorText(error) })); }
      }
      for (const original of chunk) {
        if (signal?.aborted) break;
        const row = rows[indexes.get(original.key)!];
        if (!row.draft || row.state !== 'pending') continue;
        activeDraft = row.draft.id;
        publish(row, { state: 'completing' });
        if (signal?.aborted) break;
        let polling = true;
        let stopRead = () => {};
        const stopPolling = () => { polling = false; stopRead(); };
        const poll = async () => {
          try {
            const workflow = await api.getAutomaticProductProgress(row.draft!.id);
            if (polling && workflow) publish(row, { workflow });
          } catch { /* A transient progress read must not retry the active paid operation. */ }
          return 1500;
        };
        try {
          const pending = api.completeAutomaticProduct({ draftId: row.draft.id, draftRevision: row.draft.revision });
          stopRead = startVisiblePolling(poll, { visible: () => !signal?.aborted && (options.isProgressVisible?.() ?? true) });
          const result = await pending;
          stopPolling();
          const { workflow } = result;
          const imageReady = hasSevenApprovedImages(workflow);
          const done = imageReady && result.draft.state === 'AMAZON_VALIDATED' && !result.remaining.length;
          const state = signal?.aborted || workflow.status === 'CANCELLED' ? 'stopped' : done ? 'done' : workflow.status === 'FAILED' ? 'failed' : 'blocked';
          const error = workflow.error || (done || result.remaining.length ? null : imageReady ? '草稿验证预览尚未通过，请核对待处理字段。' : '图片流程尚未完成，尚无通过审核并采用的图片。');
          publish(row, { state, draft: result.draft, workflow, aiCalls: result.aiCalls, previewAttempts: result.previewAttempts, remaining: result.remaining, error });
        } catch (error) {
          stopPolling();
          let current = row.draft, message = errorText(error);
          // Fields and stage records may have been saved before a later step failed.
          const [drafts, progress] = await Promise.allSettled([api.listAmazonDrafts(row.productId), api.getAutomaticProductProgress(row.draft.id)]);
          if (drafts.status === 'fulfilled') current = drafts.value.find(draft => draft.id === row.draft!.id) ?? current;
          else message += '；暂无法刷新已保存草稿，请在手动页核对。';
          const workflow = progress.status === 'fulfilled' ? progress.value : rows[indexes.get(row.key)!].workflow;
          const state = signal?.aborted || workflow?.status === 'CANCELLED' ? 'stopped' : workflow && ['BLOCKED', 'INTERRUPTED'].includes(workflow.status) ? 'blocked' : 'failed';
          publish(row, { state, draft: current, workflow, error: workflow?.error || message });
        } finally { stopPolling(); activeDraft = null; }
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelActive);
    for (const row of rows) if (['pending', 'syncing', 'preparing', 'completing'].includes(row.state)) publish(row, { state: 'stopped' });
  }
  return rows;
}
