import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ProductDetail } from '../src/shared/contracts.ts';
import type { AmazonDraft } from '../src/shared/amazon-contracts.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { AutomaticListingService } from '../src/main/automatic-listing/service.ts';
import type { AutomaticListingDependencies } from '../src/main/automatic-listing/service.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at = '2026-10-08T01:00:00.000Z';
function source(sku: string): ProductDetail {
  return { id: randomUUID(), revision: 1, title: 'Same supplier sale', sourceUrl: '', description: '', status: 'draft', origin: 'manual',
    createdAt: at, updatedAt: at, facts: [], assets: [], variants: [{ id: randomUUID(), sku, originalSpec: '小号-象牙白', normalizedSpec: '',
      sourceSpec: '小号-象牙白', purchasePrice: '1', sourcePurchasePrice: '1', inventory: null }] };
}
function plan(product: ProductDetail, changedGroup = false): SalesListingPlan {
  const component = { variantId: product.variants[0].id, sourceKey: 'supplier-small-ivory', sourceSku: product.variants[0].sku,
    specification: '小号-象牙白', color: '', quantity: 1, quotedCostCny: 1, piecesPerQuote: 1, sourcePackPieces: 1 };
  const groupKey = hash(changedGroup ? 'new-small-family' : 'old-small-ivory'), key = hash([[component.sourceKey, 1]]);
  return { namingGroupId: randomUUID(), sourceGroupKey: `1688:935812340001:${groupKey}`, collectedAt: at, collectionBasis: 'first_import',
    sku: changedGroup ? 'NEW-PARENT-A' : 'OLD-SKU', baseSku: changedGroup ? 'NEW-PARENT' : 'OLD-SKU',
    recipe: { key, groupKey, specification: component.specification, color: changedGroup ? 'Ivory' : '', components: [component], totalPieces: 1, totalCostCny: 1 },
    parentage: 'NONE', parentSku: null, variationTheme: null, relationReason: 'Await current schema', familyResolved: !changedGroup,
    namingChildKey: changedGroup ? key : null };
}
function fixture(t: test.TestContext) {
  const root = resolve('.test-data'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'automatic-family-identity-'));
  const oldSource = source('OLD-SUPPLIER-SKU'), imported = source('REIMPORTED-SUPPLIER-SKU'), oldPlan = plan(oldSource);
  const target = { id: 'target', name: 'Store', configured: true, paused: false, sellerId: 'seller', marketplaceId: 'market', mode: 'demo', locale: 'en_US' };
  const oldDraft = { id: randomUUID(), productId: oldSource.id, productRevision: oldSource.revision, variantId: oldSource.variants[0].id,
    sku: oldPlan.sku, salesPlan: oldPlan, state: 'DRAFT', submittedAt: null } as AmazonDraft;
  let selected = oldPlan, existing: AmazonDraft | undefined;
  const reads: string[] = [];
  const dependencies = { store: { getProduct(id: string) { reads.push(id); const product = [oldSource, imported].find(p => p.id === id); assert.ok(product); return structuredClone(product); } },
    rules: () => defaultListingRules(), hosting: { getProfile: () => ({ id: 'alpha', enabled: true, configured: true }) },
    amazon: { executionTargetScope: () => ({ target, generation: 1 }) }, labels: {},
    planSales: () => [structuredClone(selected)], existingSale: () => existing ? structuredClone(existing) : undefined,
    previewSales: () => [structuredClone(selected.recipe)],
  } as unknown as AutomaticListingDependencies;
  const service = new AutomaticListingService(directory, dependencies);
  t.after(async () => { await service.close(); assert.ok(resolve(directory).startsWith(root + sep)); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const create = (product = oldSource) => service.create({ productIds: [product.id], targetId: target.id, profileId: 'alpha', productType: 'FIGURINE' });
  return { service, oldSource, imported, oldPlan, oldDraft, reads, create,
    select(next: SalesListingPlan, draft: AmazonDraft | undefined = oldDraft) { selected = next; existing = draft; } };
}

test('changed grouping cannot evade an existing automatic task by allocating a new SKU for the same unsent sale', async t => {
  const f = fixture(t), originalTask = await f.create();
  f.select(plan(f.oldSource, true));
  await assert.rejects(() => f.create(), /已在自动任务|继续.*原任务/);
  assert.equal(f.service.list().length, 1);
  assert.deepEqual(f.service.get(originalTask.id), originalTask);
});

test('a reimport with new local IDs still conflicts with the canonical old unsent task', async t => {
  const f = fixture(t), originalTask = await f.create();
  f.select(plan(f.imported, true));
  await assert.rejects(() => f.create(f.imported), /已在自动任务|继续.*原任务/);
  assert.equal(f.service.list().length, 1);
  assert.deepEqual(f.service.get(originalTask.id), originalTask);
  assert.equal(f.reads.at(-1), f.oldSource.id, 'canonical old plan must resolve against the old source, never the reimported variant');
});

test('an orphaned unsent old-family draft blocks new-task takeover rather than discarding its existing images', async t => {
  const f = fixture(t);
  f.select(plan(f.imported, true));
  await assert.rejects(() => f.create(f.imported), /OLD-SKU.*原草稿|原草稿.*OLD-SKU/);
  assert.equal(f.service.list().length, 0);
  assert.equal(f.reads.at(-1), f.oldSource.id);
});

test('same-group unsent source refresh keeps its allocated SKU while refreshing component IDs and cost', async t => {
  const f = fixture(t), refreshed = plan(f.imported);
  refreshed.sku = 'UNUSED-FRESH-SKU'; refreshed.baseSku = 'UNUSED-FRESH-SKU';
  refreshed.recipe.components[0].quotedCostCny = 2; refreshed.recipe.totalCostCny = 2;
  f.select(refreshed);
  const created = await f.create(f.imported), item = created.items[0];
  assert.equal(item.productId, f.imported.id); assert.equal(item.variantId, f.imported.variants[0].id);
  assert.equal(item.sku, f.oldPlan.sku); assert.equal(item.salesPlan!.namingGroupId, f.oldPlan.namingGroupId);
  assert.equal(item.salesPlan!.recipe.totalCostCny, 2);
  assert.equal(item.salesPlan!.recipe.components[0].variantId, f.imported.variants[0].id);
});

test('already submitted and UNKNOWN canonical sales retain the original product, variant, SKU and frozen recipe', async t => {
  for (const state of ['SUBMITTED', 'UNKNOWN'] as const) {
    const f = fixture(t), submitted = { ...f.oldDraft, state, submittedAt: state === 'SUBMITTED' ? at : null };
    f.select(plan(f.imported, true), submitted);
    const item = (await f.create(f.imported)).items[0];
    assert.equal(item.productId, f.oldSource.id); assert.equal(item.variantId, f.oldSource.variants[0].id);
    assert.equal(item.sku, f.oldPlan.sku); assert.deepEqual(item.salesPlan, f.oldPlan);
  }
});
