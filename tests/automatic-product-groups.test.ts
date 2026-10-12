import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutomaticListingItem } from '../src/shared/automatic-listing-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import { automaticItemOutcome, buildAutomaticProductGroups, filterAutomaticProductGroups } from '../src/renderer/automatic-product-groups.ts';

function product(id: string, count: number): ProductDetail {
  return { id, title: `商品 ${id}`, sourceUrl: `https://detail.1688.com/offer/${id}.html`, description: '', status: 'draft', origin: 'import', revision: 1, createdAt: '', updatedAt: '', facts: [], assets: [],
    variants: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, sku: `SOURCE-${id}-${index}`, originalSpec: `颜色 ${index}`, normalizedSpec: '', sourceSpec: '', purchasePrice: '', sourcePurchasePrice: '', inventory: null })) };
}
function item(source: ProductDetail, index: number, patch: Partial<AutomaticListingItem> = {}): AutomaticListingItem {
  return { key: `item-${source.id}-${index}`, productId: source.id, productRevision: 1, sourceStamp: '', productTitle: source.title, variantId: source.variants[index].id, sku: `SALE-${source.id}-${index}`, stockSets: 5, sourcesPrepared: false, status: 'PENDING', stage: 'SOURCES', draftId: null, executionTaskIds: [], imageStarted: false, imageAttempts: 0, repairAttempts: 0, repair: null, batchId: null, error: null, ...patch };
}

test('12 source products retain all 192 variants while only 103 sales SKUs execute', () => {
  const products = [1, 54, 56, 1, 7, 12, 7, 1, 7, 39, 5, 2].map((count, index) => product(String(index), count));
  const items = products.flatMap(source => source.variants.slice(0, 20).map((_, index) => item(source, index)));
  const before = structuredClone({ products, items });
  const groups = buildAutomaticProductGroups(items, products);
  assert.equal(groups.length, 12);
  assert.equal(groups.reduce((sum, group) => sum + group.sourceVariants.length, 0), 192);
  assert.equal(groups.reduce((sum, group) => sum + group.items.length, 0), 103);
  assert.equal(groups.reduce((sum, group) => sum + (group.excludedCount ?? 0), 0), 89);
  assert.equal(new Set(groups.flatMap(group => group.sourceVariants.map(row => row.variant.id))).size, 192);
  assert.deepEqual(groups.map(group => group.productId), products.map(source => source.id));
  assert.deepEqual({ products, items }, before);
});

test('combined recipes include each source component once and retain distinct sales SKUs and actual parent families', () => {
  const source = product('mix', 4);
  const combined = item(source, 0, { status: 'FAILED', stage: 'IMAGES', salesPlan: {
    namingGroupId: 'group', sourceGroupKey: 'source-group', collectedAt: '', collectionBasis: 'source', sku: 'SALE-mix-0', baseSku: 'BASE',
    recipe: { key: 'recipe', groupKey: 'group', specification: '红蓝组合', color: '红蓝', totalPieces: 2, totalCostCny: null,
      components: source.variants.slice(0, 2).map(variant => ({ variantId: variant.id, sourceKey: variant.id, sourceSku: variant.sku, specification: variant.originalSpec, color: '', quantity: 1, quotedCostCny: null, piecesPerQuote: 1, sourcePackPieces: 1 })) },
    parentage: 'CHILD', parentSku: 'PARENT-RED-BLUE', variationTheme: 'COLOR_NAME', relationReason: '按颜色变体', familyResolved: true, namingChildKey: 'child',
  } });
  const pending = item(source, 2, { status: 'RUNNING', stage: 'DRAFT' });
  const [group] = buildAutomaticProductGroups([combined, pending], [source]);
  assert.equal(group.sourceVariantCount, 4);
  assert.equal(group.excludedCount, 1);
  assert.deepEqual(group.sourceVariants.map(row => row.items.map(value => value.key)), [[combined.key], [combined.key], [pending.key], []]);
  assert.deepEqual(group.parentSkus, ['PARENT-RED-BLUE']);
  assert.deepEqual(group.statusCounts, { PENDING: 0, RUNNING: 1, WAITING: 0, DONE: 0, FAILED: 1, SCREENED:0 });
  assert.equal(group.stageCounts.IMAGES, 1);
  assert.equal(group.stageCounts.DRAFT, 1);
});

test('unavailable source details are unknown and never presented as zero variants or excluded', () => {
  const source = product('unavailable', 2), saved = item(source, 0);
  const [group] = buildAutomaticProductGroups([saved], []);
  assert.equal(group.title, source.title);
  assert.equal(group.sourceVariantCount, null);
  assert.equal(group.excludedCount, null);
  assert.equal(group.items[0], saved);
  assert.deepEqual(group.parentSkus, []);
});

test('search finds an excluded source SKU and a renamed sales SKU without losing their product context', () => {
  const source = product('search', 3), other = product('other', 1);
  const groups = buildAutomaticProductGroups([item(source, 0), item(other, 0)], [source, other]);
  const sourceMatch = filterAutomaticProductGroups(groups, 'source-search-2');
  assert.equal(sourceMatch.length, 1);
  assert.equal(sourceMatch[0].sourceVariants.length, 3);
  assert.equal(filterAutomaticProductGroups(groups, 'sale-search-0')[0].productId, source.id);
  assert.equal(filterAutomaticProductGroups(groups, 'not found').length, 0);
});

test('legacy error wording never classifies rule rejection and submissions are not counted as complete', () => {
  const source = product('outcomes', 7);
  const items = [
    item(source, 0, { status: 'FAILED', stage: 'DRAFT', error: '定价未通过：售价上限内无法满足目标 ROI' }),
    item(source, 1, { status: 'FAILED', stage: 'SOURCES', error: '来源图片映射为空' }),
    item(source, 2, { status: 'FAILED', stage: 'IMAGES', error: '生图响应结果未知' }),
    item(source, 3, { status: 'WAITING', stage: 'READBACK' }),
    item(source, 4, { status: 'RUNNING', stage: 'LABELS' }),
    item(source, 5, { status: 'DONE', stage: 'COMPLETE' }),
    item(source, 6),
  ];
  const before = structuredClone(items);
  const [group] = buildAutomaticProductGroups(items, [source]);
  assert.equal((group.outcomeCounts as any).unclassified,3);assert.equal((group.outcomeCounts as any).ruleFiltered,0);assert.equal(group.outcomeCounts.completed,1);assert.equal(group.outcomeCounts.submittedAwaitingReadback,1);
  assert.deepEqual(items, before, 'presentation classification never changes persisted status or errors');
});
test('structured rule, repair, input and unknown results remain separate in task summaries',()=>{
  const source=product('typed',5);
  for(const [kind,expected] of [['RULE_FILTERED','ruleFiltered'],['SYSTEM_REPAIR','systemRepair'],['NEEDS_INPUT','needsInput'],['UNKNOWN','unknown'],['UNCLASSIFIED','unclassified']] as const){
    const row=item(source,0,{status:kind==='RULE_FILTERED'?'SCREENED':'FAILED',outcome:{kind} as any,error:'same display text'});
    assert.equal(automaticItemOutcome(row),expected);
  }
});


test('historical 103 SKUs count selection, profit and exceptions exactly once',()=>{
  const source=product('historical',103);
  const rows=source.variants.map((_,index)=>item(source,index,index<75?{status:'SCREENED',outcome:{kind:'RULE_FILTERED',code:index<60?'SKU_SELECTION_FILTERED':'ROI_MAX_PRICE',...(index>=60?{pricingReport:{}}:{})} as any}:index<99?{status:'FAILED',outcome:{kind:index<93?'SYSTEM_REPAIR':index===93?'NEEDS_INPUT':'UNKNOWN'} as any}:index<102?{status:'WAITING',stage:'READBACK'}:{status:'WAITING',stage:'LABELS'}));
  const counts=buildAutomaticProductGroups(rows,[source])[0].outcomeCounts as any;
  assert.equal(counts.notSelected,60);assert.equal(counts.profitFiltered,15);assert.equal(counts.systemRepair,18);assert.equal(counts.needsInput,1);assert.equal(counts.unknown,5);
  assert.equal(counts.submittedAwaitingReadback,3);assert.equal(counts.labels,1);
  assert.equal(Object.values(counts).reduce((a:number,b:any)=>a+b,0),103);
});
