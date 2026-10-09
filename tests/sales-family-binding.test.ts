import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { SalesFamilyBinding, SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';
import { validateSalesPlan } from '../src/main/sales-plans/records.ts';
import { assertSalesPlanHistory } from '../src/main/sales-plans/history.ts';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { assertSkuNamingHistory } from '../src/main/sku-naming/records.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source = '1688:935812340001', collectedAt = '2026-10-08T01:00:00.000Z';
function standalone(): SalesListingPlan {
  // The historical standalone sales have no naming child key and an empty recipe color.
  const sourceKey = 'supplier:small:ivory', quantity = 1;
  return { namingGroupId: randomUUID(), sourceGroupKey: `${source}:${digest('old-ivory')}`, collectedAt,
    collectionBasis: 'first_import', sku: 'H2-261008-13', baseSku: 'H2-261008-13',
    recipe: { key: digest([[sourceKey, quantity]]), groupKey: digest('old-ivory'), specification: '小号12cm-象牙白', color: '',
      components: [{ variantId: randomUUID(), sourceKey, sourceSku: 'SUPPLIER-IVORY', specification: '小号12cm-象牙白', color: '', quantity,
        quotedCostCny: 1, piecesPerQuote: 1, sourcePackPieces: 1 }], totalPieces: 1, totalCostCny: 1 },
    parentage: 'NONE', parentSku: null, variationTheme: null, relationReason: '单一销售规格', familyResolved: true, namingChildKey: null };
}
const binding = (): SalesFamilyBinding => ({ parentNamingGroupId: randomUUID(), parentSourceGroupKey: `${source}:family:${digest('small')}`, parentBaseSku: 'H2-261008-22' });
function bound(original = standalone(), family = binding()) {
  return { ...original, parentage: 'CHILD' as const, parentSku: family.parentBaseSku, variationTheme: 'COLOR',
    relationReason: '原销售 SKU 加入已核对的颜色家族', familyResolved: true, familyBinding: family };
}

test('explicit family membership preserves a historical standalone sale and the entire image recipe', () => {
  const original = standalone(), proposal = bound(original), before = structuredClone(proposal);
  const parsed = validateSalesPlan(proposal);
  assert.deepEqual(parsed, proposal);
  assert.deepEqual(proposal, before);
  for (const key of ['sku', 'baseSku', 'namingGroupId', 'sourceGroupKey', 'collectedAt', 'collectionBasis', 'namingChildKey', 'recipe'] as const) {
    assert.deepEqual(parsed[key], original[key]);
  }
  assert.equal(digest(parsed.recipe), digest(original.recipe));
  assert.notStrictEqual(parsed.recipe, proposal.recipe);
});

test('legacy plans retain their exact shape and original parent restrictions', () => {
  const original = standalone();
  assert.deepEqual(validateSalesPlan(original), original);
  assert.equal(Object.hasOwn(validateSalesPlan(original), 'familyBinding'), false);
  assert.throws(() => validateSalesPlan({ ...original, parentage: 'CHILD', parentSku: original.baseSku, variationTheme: 'COLOR' }));
  const child = { ...original, sku: original.baseSku + '-A', parentage: 'CHILD', parentSku: original.baseSku,
    variationTheme: 'COLOR', namingChildKey: original.recipe.key };
  assert.deepEqual(validateSalesPlan(child), child);
  assert.deepEqual(validateSalesPlan(bound(child as SalesListingPlan)).recipe, original.recipe);
});

test('family binding is exact, child-only and cannot disguise a self-parent or malformed recipe', () => {
  const valid = bound();
  const invalid = [
    { ...valid, familyBinding: null }, { ...valid, familyBinding: undefined },
    { ...valid, familyBinding: { ...valid.familyBinding, extra: true } },
    { ...valid, familyBinding: { parentNamingGroupId: valid.familyBinding.parentNamingGroupId, parentBaseSku: valid.parentSku } },
    { ...valid, familyBinding: { ...valid.familyBinding, parentNamingGroupId: 'not-an-id' } },
    { ...valid, familyBinding: { ...valid.familyBinding, parentBaseSku: 'bad/sku' } },
    { ...valid, familyBinding: { ...valid.familyBinding, parentSourceGroupKey: '' } },
    { ...valid, parentage: 'NONE', parentSku: null, variationTheme: null },
    { ...valid, parentage: 'PARENT', sku: valid.baseSku, parentSku: null },
    { ...valid, parentSku: valid.baseSku }, { ...valid, sku: valid.parentSku },
    { ...valid, variationTheme: null }, { ...valid, familyResolved: false },
    { ...valid, recipe: { ...valid.recipe, totalPieces: 9 } },
    { ...valid, namingChildKey: 'b'.repeat(64) },
  ];
  for (const value of invalid) assert.throws(() => validateSalesPlan(value), JSON.stringify(value));
});

test('family helpers resolve actual parent identity without changing original sale identity', async () => {
  const helper = await import('../src/main/sales-plans/family-binding.ts').catch(() => null);
  assert.ok(helper, 'the shared family identity helper must exist');
  const original = standalone(), child = bound(original), family = child.familyBinding;
  const parent = { ...original, namingGroupId: family.parentNamingGroupId, sourceGroupKey: family.parentSourceGroupKey,
    sku: family.parentBaseSku, baseSku: family.parentBaseSku, parentage: 'PARENT' as const, variationTheme: 'COLOR' };
  const before = structuredClone(child);
  assert.deepEqual(helper.getSalesParentIdentity(child), { namingGroupId: family.parentNamingGroupId, sourceGroupKey: family.parentSourceGroupKey, baseSku: family.parentBaseSku });
  assert.deepEqual(helper.getSalesParentIdentity(parent), helper.getSalesParentIdentity(child));
  assert.equal(helper.getSalesFamilySourceGroupKey(child), family.parentSourceGroupKey);
  assert.equal(helper.getSalesFamilySourceGroupKey(original), original.sourceGroupKey);
  assert.equal(helper.getSalesParentIdentity(original), null);
  assert.equal(helper.getSalesParentIdentity(undefined), null);
  assert.equal(helper.isSameSalesFamily(parent, child), true);
  assert.equal(helper.isSameSalesFamily(child, bound({ ...original, sku: 'H2-261008-19', baseSku: 'H2-261008-19' }, family)), true);
  for (const other of [undefined, original, { ...parent, variationTheme: 'NUMBER_OF_ITEMS' },
    { ...parent, namingGroupId: randomUUID() }, { ...parent, sourceGroupKey: `${source}:${digest('other')}` },
    { ...parent, sku: 'OTHER-PARENT', baseSku: 'OTHER-PARENT' }]) assert.equal(helper.isSameSalesFamily(child, other), false);
  assert.deepEqual(child, before);
  assert.equal(child.sourceGroupKey, original.sourceGroupKey);
});

function historyFixture(t: test.TestContext) {
  const root = resolve('.test-data'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'sales-family-binding-'));
  const service = new SkuNamingService(directory), store = new WorkspaceStore(directory), db = openDatabase(directory);
  t.after(() => { db.close(); store.close(); service.close(); assert.ok(resolve(directory).startsWith(root + sep)); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const product = store.createProduct(), storeScope = JSON.stringify(['live', 'seller']);
  const allocate = (sourceGroupKey: string, scope = storeScope, childKeys: string[] = []) => service.allocate({ storeScope: scope,
    storeCode: 'U2', sourceGroupKey, collectedAt, childKeys });
  const original = standalone(), oldGroup = allocate(original.sourceGroupKey);
  Object.assign(original, { namingGroupId: oldGroup.id, sku: oldGroup.baseSku, baseSku: oldGroup.baseSku });
  const parentGroup = allocate(`${source}:family:${digest('small')}`, storeScope, ['reserved-child']);
  const proposal = bound(original, { parentNamingGroupId: parentGroup.id, parentSourceGroupKey: parentGroup.sourceGroupKey, parentBaseSku: parentGroup.baseSku });
  const taskId = randomUUID(), draftId = randomUUID();
  db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(taskId, JSON.stringify({ mode: 'live', sellerId: 'seller', items: [] }));
  db.prepare('INSERT INTO listing_drafts(id,product_id,request_json,schema_checksum,validation_json,state,created_at,record_json) VALUES(?,?,?,?,?,?,?,?)')
    .run(draftId, product.id, '{}', 'schema', '[]', 'DRAFT', collectedAt, JSON.stringify({ draft: {} }));
  const save = (plan: unknown, location: 'draft' | 'task' = 'task') => {
    db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify({ mode: 'live', sellerId: 'seller', items: location === 'task' ? [{ salesPlan: plan }] : [] }), taskId);
    db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify({ draft: location === 'draft' ? { mode: 'live', sellerId: 'seller', salesPlan: plan } : {} }), draftId);
  };
  const ledger = () => db.prepare('SELECT * FROM sku_naming_groups ORDER BY id').all();
  return { db, allocate, original, proposal, oldGroup, parentGroup, save, ledger, taskId };
}

test('history accepts explicit family links in both tasks and drafts without rewriting either ledger', t => {
  const f = historyFixture(t), before = f.ledger();
  f.save(f.original); assert.doesNotThrow(() => assertSalesPlanHistory(f.db));
  for (const location of ['task', 'draft'] as const) {
    f.save(f.proposal, location); assert.doesNotThrow(() => assertSalesPlanHistory(f.db));
  }
  assert.doesNotThrow(() => assertSkuNamingHistory(f.db));
  assert.deepEqual(f.ledger(), before);
});

test('history refuses forged own identity, unrelated source, foreign scope or non-base parent identities', async t => {
  const f = historyFixture(t);
  const history = await import('../src/main/sales-plans/history.ts');
  assert.equal(typeof history.assertSalesPlanNamingIdentity, 'function', 'the same ledger guard must be usable before a live local rebind');
  assert.doesNotThrow(() => history.assertSalesPlanNamingIdentity(f.db, f.proposal, 'live', 'seller'));
  const unrelated = f.allocate(`1688:different:family:${digest('small')}`);
  const foreignSeller = f.allocate(`${source}:family:${digest('small')}`, JSON.stringify(['live', 'other-seller']));
  const foreignMode = f.allocate(`${source}:family:${digest('small')}`, JSON.stringify(['demo', 'seller']));
  const rebind = (group: typeof f.parentGroup) => bound(f.original, { parentNamingGroupId: group.id, parentSourceGroupKey: group.sourceGroupKey, parentBaseSku: group.baseSku });
  for (const invalid of [
    { ...f.proposal, namingGroupId: randomUUID() }, { ...f.proposal, collectedAt: '2026-10-09T00:00:00Z' },
    { ...f.proposal, baseSku: 'FORGED-BASE' }, { ...f.proposal, sku: 'UNRESERVED' },
    { ...f.proposal, sourceGroupKey: f.parentGroup.sourceGroupKey },
    rebind(unrelated), rebind(foreignSeller), rebind(foreignMode),
    bound(f.original, { ...f.proposal.familyBinding, parentNamingGroupId: randomUUID() }),
    bound(f.original, { ...f.proposal.familyBinding, parentSourceGroupKey: `${source}:family:${digest('missing')}` }),
    bound(f.original, { ...f.proposal.familyBinding, parentBaseSku: f.parentGroup.children[0].sku }),
  ]) {
    f.save(invalid); assert.throws(() => assertSalesPlanHistory(f.db));
    assert.throws(() => history.assertSalesPlanNamingIdentity(f.db, invalid, 'live', 'seller'));
  }
  f.save(f.proposal);
  f.db.prepare('UPDATE sku_naming_identities SET sku=? WHERE group_id=? AND child_key=?').run(f.parentGroup.baseSku.toLowerCase(), f.parentGroup.id, '');
  assert.throws(() => assertSalesPlanHistory(f.db), 'parent base identity must match exact reserved spelling');
  f.db.prepare('UPDATE sku_naming_identities SET sku=? WHERE group_id=? AND child_key=?').run(f.parentGroup.baseSku, f.parentGroup.id, '');
  f.db.prepare('UPDATE sku_naming_identities SET child_key=?,child_index=? WHERE group_id=? AND child_key=?').run('forged', 99, f.parentGroup.id, '');
  assert.throws(() => assertSalesPlanHistory(f.db));
});

test('a binding can target an existing canonical family but cannot bypass missing source evidence', t => {
  const f = historyFixture(t), existing = f.allocate(`${source}:${digest('regrouped')}`);
  f.save(bound(f.original, { parentNamingGroupId: existing.id, parentSourceGroupKey: existing.sourceGroupKey, parentBaseSku: existing.baseSku }));
  assert.doesNotThrow(() => assertSalesPlanHistory(f.db));
  const opaque = f.allocate('opaque-unverifiable-family');
  f.save(bound(f.original, { parentNamingGroupId: opaque.id, parentSourceGroupKey: opaque.sourceGroupKey, parentBaseSku: opaque.baseSku }));
  assert.throws(() => assertSalesPlanHistory(f.db));
});

test('every persisted family transition validates its pending parent identity before restore or resume', t => {
  const f = historyFixture(t);
  const saveTransition = (phase: 'BIND' | 'RECHECK' | 'READY', plan: unknown) => {
    f.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify({ mode: 'live', sellerId: 'seller', items: [{
      salesPlan: phase === 'BIND' ? f.original : f.proposal,
      familyTransition: { phase, plan, sourceWorkflowId: randomUUID(), draftRevision: phase === 'BIND' ? 4 : 5, draftStamp: 'a'.repeat(64) },
    }] }), f.taskId);
  };
  const foreign = f.allocate(`${source}:family:${digest('foreign')}`, JSON.stringify(['live', 'other-seller']));
  const invalidPlans = [
    bound(f.original, { ...f.proposal.familyBinding, parentNamingGroupId: randomUUID() }),
    bound(f.original, { parentNamingGroupId: foreign.id, parentSourceGroupKey: foreign.sourceGroupKey, parentBaseSku: foreign.baseSku }),
    bound(f.original, { ...f.proposal.familyBinding, parentBaseSku: f.parentGroup.children[0].sku }),
  ];
  for (const phase of ['BIND', 'RECHECK', 'READY'] as const) {
    saveTransition(phase, f.proposal); assert.doesNotThrow(() => assertSalesPlanHistory(f.db));
    for (const plan of invalidPlans) {
      saveTransition(phase, plan);
      assert.throws(() => assertSalesPlanHistory(f.db), `untrusted ${phase} plan cannot bypass the parent ledger guard`);
    }
  }
});
