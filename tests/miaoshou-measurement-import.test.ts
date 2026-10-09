import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { MiaoshouService } from '../src/main/miaoshou/service.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { schemaKey } from '../src/main/amazon/context.ts';
import { toSaveInput } from '../src/renderer/utils.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { detailFixture, mappingFor, testMiaoshouClock, testMiaoshouStorage } from './helpers/miaoshou-fixture.ts';

async function fixture(t: test.TestContext) {
  const root = resolve('.test-data'); mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'miaoshou-measurement-'));
  const store = new WorkspaceStore(directory), storage = testMiaoshouStorage(), raw = detailFixture();
  const source = raw.data.editCommonCollectBoxDetail;
  source.notesText = '来源说明'; source.notes = '<p>包装尺寸：25×15×8</p><p>包装毛重：250</p>';
  source.sourceAttrs = []; source.saleProp3Map = {} as never;
  source.colorMap = { red: { name: '红色' } } as never;
  source.sizeMap = { small: { name: '12×8×3cm；净重120g' }, large: { name: '20×10×5cm；净重180g' } } as never;
  source.skuMap = Object.fromEntries([';red;small;', ';red;large;'].map(key => [key, { weight: '0.5', packageLength: '1', packageWidth: '1', packageHeight: '1' }])) as never;
  const miaoshou = new MiaoshouService(directory, store, storage, { rateLimitClock: testMiaoshouClock(), fetch: async () => new Response(JSON.stringify(raw)) });
  const amazon = new AmazonService(directory, id => store.getProduct(id), storage, { fetch: async () => { throw new Error('offline tests must not publish or call Amazon'); } });
  t.after(async () => { amazon.close(); await miaoshou.close(); store.close(); assert.ok(directory.startsWith(root + sep)); rmSync(directory, { recursive: true, force: true }); });
  miaoshou.importConfig({ appKey: 'fixture-only', appSecret: 'fixture-only-secret' });
  const preview = await miaoshou.previewProduct({ id: source.commonCollectBoxDetailId });
  const imported = miaoshou.importProduct({ previewId: preview.previewId, mapping: mappingFor(preview.product) });
  const product = store.getProduct(imported.productId), target = amazon.enableDemo();
  const selection = { targetId: target.id, productType: 'DRINK_COASTER', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' } as const;
  amazon.getSchema = async () => ({ ...realAmazonSchema(), ...selection, key: schemaKey(target, selection) });
  return { store, miaoshou, amazon, product, selection, imported };
}
test('imported receipt keeps detail text and its matching SKU measurements fill new Haul drafts', async t => {
  const f = await fixture(t), receipt = f.miaoshou.getReceipt(f.product.id)!;
  assert.match(receipt.snapshot.detailText ?? '', /包装毛重：250/);
  for (const [key, length, mass] of [[';red;small;', 4.72, 0.26], [';red;large;', 7.87, 0.4]] as const) {
    const variantId = receipt.skuMappings.find(row => row.sourceKey === key)!.localVariantId;
    const draft = await f.amazon.createDraft({ ...f.selection, productId: f.product.id, variantId, listingProgram: 'haul' });
    const attributes = draft.attributes as any;
    assert.equal(attributes.item_length_width?.[0].length.value, length);
    assert.equal(attributes.item_length_width?.[0].length.unit, 'inches');
    assert.equal(attributes.item_weight?.[0].value, mass);
    assert.equal(attributes.item_package_dimensions?.[0].length.value, 9.84);
    assert.equal(attributes.item_package_weight?.[0].value, 0.55);
    assert.equal(attributes.item_package_weight?.[0].unit, 'pounds');
    assert.ok(draft.sourceMapping?.find(row => row.field === 'item_length_width' && row.status === 'mapped'));
  }
  assert.deepEqual(f.store.getProduct(f.product.id), f.product, 'derivation does not alter product facts or revisions');
});
test('manual measurement facts take precedence and saved draft overrides are never refreshed from receipt', async t => {
  const f = await fixture(t);
  const single = { ...f.product, variants: f.product.variants.slice(0, 1), facts: [{ id: crypto.randomUUID(), name: '包装重量', value: '1 pounds', state: 'human_confirmed' as const, source: 'manual' as const, sourceRef: '人工称重' }] };
  const saved = f.store.saveProduct(toSaveInput(single));
  const draft = await f.amazon.createDraft({ ...f.selection, productId: saved.id, variantId: saved.variants[0].id, listingProgram: 'haul' });
  assert.equal((draft.attributes.item_package_weight as any)[0].value, 1);
  const updated = f.amazon.saveDraft({ id: draft.id, revision: draft.revision, attributes: { ...draft.attributes, item_package_weight: [{ value: 2, unit: 'pounds', marketplace_id: 'ATVPDKIKX0DER' }] } });
  assert.equal((updated.attributes.item_package_weight as any)[0].value, 2);
});
test('batch preparation derives each SKU and explicit batch values still take precedence', async t => {
  const f = await fixture(t);
  const result = await f.amazon.prepareDrafts({ ...f.selection, listingProgram: 'haul', items: f.product.variants.map(variant => ({ productId: f.product.id, productRevision: f.product.revision, variantId: variant.id,
    attributes: { item_package_weight: [{ value: 2, unit: 'pounds', marketplace_id: 'ATVPDKIKX0DER' }] } })) });
  assert.ok(result.items.every(item => item.disposition === 'CREATED'));
  for (const item of result.items) {
    assert.ok(item.draft?.attributes.item_length_width);
    assert.equal((item.draft?.attributes.item_package_weight as any)[0].value, 2);
  }
});
test('a conflicting manual packaging fact blocks receipt fallback for that field', async t => {
  const f = await fixture(t);
  const saved = f.store.saveProduct(toSaveInput({ ...f.product, variants: f.product.variants.slice(0, 1), facts: [{ id: crypto.randomUUID(), name: '包装重量', value: '1 pounds', state: 'conflicting', source: 'manual', sourceRef: '待确认' }] }));
  const draft = await f.amazon.createDraft({ ...f.selection, productId: saved.id, variantId: saved.variants[0].id, listingProgram: 'haul' });
  assert.equal(draft.attributes.item_package_weight, undefined);
});
