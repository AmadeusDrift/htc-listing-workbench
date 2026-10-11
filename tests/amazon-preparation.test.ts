import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import { listingHash } from '../src/main/amazon/context.ts';
import type { AmazonPersistence, DraftRecord } from '../src/main/amazon/persistence.ts';
import type { AmazonDraft, JsonObject, ListingIssue, SchemaSelection } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail, SaveProductInput } from '../src/shared/contracts.ts';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { planSalesListings } from '../src/main/sales-plans/planning.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';

const implementation = await import('../src/main/amazon/service.ts');
type Service = InstanceType<typeof implementation.AmazonService>;
type BatchInput = SchemaSelection & { items: { productId: string; productRevision: number; variantId: string; attributes: JsonObject }[] };
type BatchResult = { items: { productId: string; variantId: string; sku: string | null; disposition: 'CREATED' | 'REUSED' | 'REJECTED'; draft: AmazonDraft | null; issues: ListingIssue[]; error: string | null }[] };
const key = randomBytes(32);
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
  decryptString(value: Buffer) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'); },
};
const credentials = { name: 'Preparation test', sellerId: 'PREPARATION_SELLER', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en_US',
  clientId: 'PREPARATION_CLIENT_PRIVATE', clientSecret: 'PREPARATION_SECRET_PRIVATE', refreshToken: 'PREPARATION_REFRESH_PRIVATE' };
function productInput(product: ProductDetail): SaveProductInput {
  return { id: product.id, revision: product.revision, title: product.title, sourceUrl: product.sourceUrl, description: product.description, status: product.status, facts: product.facts,
    variants: product.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })) };
}
function fixture(t: test.TestContext, variantCount = 3) {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(join(parent, 'amazon-preparation-'));
  const store = new WorkspaceStore(directory); let now = Date.parse('2026-01-01T00:00:00Z');
  const openService = () => new implementation.AmazonService(directory, id => store.getProduct(id), safeStorage,
    { now: () => now, fetch: async () => { throw new Error('Preparation tests must not access the network'); } });
  let service = openService();
  t.after(() => { service.close(); store.close(); assert.ok(directory.startsWith(parent + '\\')); rmSync(directory, { recursive: true, force: true }); });
  let product = store.createProduct(); const first = product.variants[0];
  product = store.saveProduct({ ...productInput(product), title: 'Source bag', description: 'Confirmed source description',
    variants: Array.from({ length: variantCount }, (_, index) => ({ id: index === 0 ? first.id : randomUUID(), sku: `${first.sku}-${index + 1}`,
      originalSpec: `Supplier original spec ${index}`, normalizedSpec: `Human spec ${index}`, purchasePrice: ['92.35', '83.20', '75.00'][index] ?? '10.00', inventory: index < 3 ? [0, null, 7][index] : 1 })),
    facts: [
      { id: randomUUID(), name: 'color', value: 'PRODUCT_BLUE', source: 'manual', sourceRef: 'Product label', state: 'human_confirmed' },
      { id: randomUUID(), name: 'size', value: 'PRODUCT_SIZE', source: 'manual', sourceRef: 'Product label', state: 'source_confirmed' },
      { id: randomUUID(), name: 'brand', value: 'AI_BRAND', source: 'ai', sourceRef: '', state: 'ai_suggested' },
    ] });
  const target = service.enableDemo();
  const selected: SchemaSelection = { targetId: target.id, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' };
  return { directory, store, product, target, selected, get service() { return service; }, advance(ms: number) { now += ms; },
    reopen() { service.close(); service = openService(); return service; } };
}
function prepare(service: Service, input: unknown): Promise<BatchResult> {
  const method = Reflect.get(service, 'prepareDrafts');
  assert.equal(typeof method, 'function', 'AmazonService.prepareDrafts must be implemented');
  return method.call(service, input);
}
function configured(marketplaceId: string, color = 'Blue', price = 12.5): JsonObject {
  return { brand: [{ value: 'Configured Brand', marketplace_id: marketplaceId }], color: [{ value: color, marketplace_id: marketplaceId }],
    purchasable_offer: [{ marketplace_id: marketplaceId, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: price }] }] }] };
}
function batch(f: ReturnType<typeof fixture>, product = f.product): BatchInput {
  return { ...f.selected, items: product.variants.map((variant, index) => ({ productId: product.id, productRevision: product.revision, variantId: variant.id,
    attributes: configured(f.target.marketplaceId, ['Blue', 'Red', 'Green'][index] ?? 'Black', 12.5 + index) })) };
}
function internals(service: Service) { return service as unknown as { persistence: AmazonPersistence; busy: Set<string> }; }
async function gatedSchema(service: Service) {
  const original = service.getSchema.bind(service); let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  service.getSchema = async input => { const schema = await original(input); entered(); await gate; return schema; };
  return { waiting, release };
}
function reversed<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversed) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reversed(child)])) as T;
  return value;
}

test('AmazonService exposes batch draft preparation', () => {
  assert.equal(typeof Reflect.get(implementation.AmazonService.prototype, 'prepareDrafts'), 'function', 'AmazonService.prepareDrafts must be implemented');
});

test('automatic sales SKU drafts preserve source identities and reuse durable recipe identities',async t=>{
  const f=fixture(t,2),naming=new SkuNamingService(f.directory);
  try{
    const product=f.store.saveProduct({...productInput(f.product),facts:[{id:randomUUID(),name:'采购币种',value:'CNY',state:'human_confirmed',source:'manual',sourceRef:''}],
      variants:productInput(f.product).variants.map((v,i)=>({...v,originalSpec:`颜色: ${i?'蓝色':'红色'} / 尺寸: 小号`,normalizedSpec:'',purchasePrice:'0.1'}))});
    const original=structuredClone(product),plans=planSalesListings(product,null,f.target,defaultListingRules(),naming).map(p=>({...p,familyResolved:true,relationReason:'本地演示不支持变体'}));
    assert.equal(plans.length,3);assert.ok(plans.every(p=>p.sku.startsWith('H2-')));
    for(const plan of plans){
      const result=await f.service.prepareDrafts({...f.selected,items:[{productId:product.id,productRevision:product.revision,variantId:plan.recipe.components[0].variantId,attributes:configured(f.target.marketplaceId)}]},[plan]);
      assert.equal(result.items[0].disposition,'CREATED',result.items[0].error??'');
      const draft=result.items[0].draft!;assert.equal(draft.sku,plan.sku);assert.deepEqual(draft.salesPlan,plan);
      const context=buildListingContext(draft,product,0);assert.equal(context.sku,plan.sku);assert.equal(context.sourceProduct?.salesRecipe?.recipe.totalPieces,10);assert.deepEqual(context.sourceProduct?.salesRecipe,plan);
      assert.doesNotThrow(()=>f.service.validateDraft({id:draft.id,revision:draft.revision}));
    }
    assert.deepEqual(f.store.getProduct(product.id),original);
    const reordered={...product,variants:[...product.variants].reverse()};
    assert.deepEqual(planSalesListings(reordered,null,f.target,defaultListingRules(),naming).map(p=>p.sku).sort(),plans.map(p=>p.sku).sort());
    const forged={...plans[0],sku:'H2-000000-999'};
    await assert.rejects(f.service.prepareDrafts({...f.selected,items:[{productId:product.id,productRevision:product.revision,variantId:forged.recipe.components[0].variantId,attributes:{}}]},[forged]),/命名身份/);
  }finally{naming.close();}
});

test('trusted family prepares a separate parent SKU with relationships and no selling logistics',async t=>{
  const f=fixture(t,2),naming=new SkuNamingService(f.directory),getSchema=f.service.getSchema.bind(f.service);
  f.service.getSchema=async input=>{
    const schema=await getSchema(input),value={type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}};
    Object.assign(schema.schema.properties!,{model_number:value,parentage_level:value,
      variation_theme:{type:'array',items:{type:'object',properties:{name:{enum:['COLOR']},marketplace_id:{type:'string'}},required:['name'],additionalProperties:false}},
      child_parent_sku_relationship:{type:'array',items:{type:'object',properties:{child_relationship_type:{const:'variation'},parent_sku:{type:'string'},marketplace_id:{type:'string'}},required:['child_relationship_type'],additionalProperties:false}}});return schema;
  };
  try{
    const product=f.store.saveProduct({...productInput(f.product),variants:productInput(f.product).variants.map((v,i)=>({...v,originalSpec:`颜色: ${i?'蓝色':'红色'} / 尺寸: 小号`,normalizedSpec:''}))});
    const first=planSalesListings(product,null,f.target,defaultListingRules(),naming)[0];
    const childPlan={...first,parentage:'CHILD' as const,parentSku:first.baseSku,variationTheme:'COLOR',familyResolved:true};
    const childResult=await f.service.prepareDrafts({...f.selected,parentageLevel:'CHILD',items:[{productId:product.id,productRevision:product.revision,variantId:childPlan.recipe.components[0].variantId,attributes:{}}]},[childPlan]);
    assert.equal(childResult.items[0].disposition,'CREATED',childResult.items[0].error??'');
    const parentPlan={...childPlan,parentage:'PARENT' as const,sku:first.baseSku,parentSku:null,namingChildKey:null};
    const result=await f.service.prepareDrafts({...f.selected,parentageLevel:'PARENT',items:[{productId:product.id,productRevision:product.revision,variantId:childPlan.recipe.components[0].variantId,attributes:{}}]},[parentPlan]);
    assert.equal(result.items[0].disposition,'CREATED',result.items[0].error??'');const parent=result.items[0].draft!;
    assert.equal(parent.sku,first.baseSku);
    assert.equal((parent.attributes.child_parent_sku_relationship as any)[0].parent_sku,undefined);assert.equal((parent.attributes.parentage_level as any)[0].value,'parent');
    assert.equal(parent.attributes.purchasable_offer,undefined);assert.equal(parent.attributes.item_package_weight,undefined);
    assert.ok(!buildListingContext(parent,product,1).evidence.some(e=>e.id.endsWith(':sale-count')));
    assert.equal(f.service.useFamilyImage(parent.id,childResult.items[0].draft!.id).parentImageSourceDraftId,childResult.items[0].draft!.id);
    assert.deepEqual(f.store.getProduct(product.id).variants,product.variants);
  }finally{naming.close();}
});

test('three SKU drafts use independent configured prices and facts, known zero/null inventory, and one schema read', async t => {
  const f = fixture(t); const input = batch(f); const source = f.store.getProduct(f.product.id); const original = f.service.getSchema.bind(f.service); let reads = 0;
  f.service.getSchema = async selection => { reads++; return original(selection); };
  const result = await prepare(f.service, input);
  assert.equal(reads, 1); assert.deepEqual(result.items.map(item => item.disposition), ['CREATED', 'CREATED', 'CREATED']);
  assert.equal(new Set(result.items.map(item => item.draft!.id)).size, 3);
  for (const [index, item] of result.items.entries()) {
    const draft = item.draft!;
    assert.equal(draft.sku, source.variants[index].sku); assert.equal(draft.variantId, source.variants[index].id);
    assert.deepEqual(draft.attributes.purchasable_offer, input.items[index].attributes.purchasable_offer);
    assert.deepEqual(draft.attributes.color, input.items[index].attributes.color);
    assert.equal(draft.state, 'LOCAL_VALIDATED'); assert.deepEqual(item.issues, []); assert.equal(item.error, null);
    assert.equal(JSON.stringify(draft.attributes).includes(source.variants[index].purchasePrice), false);
    assert.equal(JSON.stringify(draft.attributes).includes('AI_BRAND'), false);
    assert.equal(draft.previewedAt, null); assert.equal(draft.submittedAt, null);
    assert.deepEqual(draft.events.map(event => event.operation), ['create', 'local_validation']);
    const record = internals(f.service).persistence.record(draft.id);
    assert.deepEqual(record.request, { productType: draft.schema.productType, requirements: draft.schema.requirements, attributes: draft.attributes });
    assert.deepEqual(record.exchanges, []);
  }
  assert.deepEqual(result.items[0].draft!.attributes.fulfillment_availability, [{ quantity: 0, marketplace_id: f.target.marketplaceId }]);
  assert.equal(result.items[1].draft!.attributes.fulfillment_availability, undefined);
  assert.deepEqual(result.items[2].draft!.attributes.fulfillment_availability, [{ quantity: 7, marketplace_id: f.target.marketplaceId }]);
  assert.deepEqual(f.store.getProduct(f.product.id), source);
  assert.ok(f.service.listCalls().every(call => call.operation === 'getDefinitionsProductType'));
});

test('multiple variants never inherit product color/size and missing or conditional fields persist as actual local issues', async t => {
  const f = fixture(t); const original = f.service.getSchema.bind(f.service);
  f.service.getSchema = async input => { const schema = await original(input); (schema.schema.properties as JsonObject).size = { type: 'string' }; return schema; };
  const input = batch(f); input.items[0].attributes = {};
  input.items[1].attributes = { ...configured(f.target.marketplaceId, 'Explicit red'), size: 'Explicit medium', batteries_required: [{ value: true, marketplace_id: f.target.marketplaceId }] };
  const result = await prepare(f.service, input);
  const first = result.items[0]; assert.equal(first.disposition, 'CREATED'); assert.equal(first.draft!.state, 'BLOCKED');
  assert.equal(first.draft!.attributes.color, undefined); assert.equal(first.draft!.attributes.size, undefined); assert.equal(first.draft!.attributes.purchasable_offer, undefined);
  assert.ok(['brand', 'color', 'purchasable_offer'].every(name => first.issues.some(issue => issue.attributeNames.includes(name))));
  const second = result.items[1]; assert.equal(second.draft!.state, 'BLOCKED'); assert.equal(second.draft!.attributes.size, 'Explicit medium');
  assert.ok(second.issues.some(issue => issue.attributeNames.includes('battery_type'))); assert.deepEqual(second.issues, second.draft!.localIssues);
  assert.equal(result.items[2].draft!.state, 'LOCAL_VALIDATED');
});

test('a single SKU retains confirmed product color and respects caller overrides', async t => {
  const f = fixture(t, 1); const input = batch(f); delete input.items[0].attributes.color;
  const result = await prepare(f.service, input);
  assert.deepEqual(result.items[0].draft!.attributes.color, [{ value: 'PRODUCT_BLUE', marketplace_id: f.target.marketplaceId }]);
});

test('malformed batch structure, duplicate references, parentage, invalid JSON and combined size fail before schema or drafts', async t => {
  const f = fixture(t); const base = batch(f); let reads = 0; const original = f.service.getSchema.bind(f.service);
  f.service.getSchema = async selection => { reads++; return original(selection); };
  let deep: unknown = 'end'; for (let i = 0; i < 52; i++) deep = { deep };
  const invalid: unknown[] = [null, [], { ...base, extra: true }, { ...base, forceRefresh: true }, { ...base, locale: undefined },
    { ...base, items: [] }, { ...base, items: Array.from({ length: 51 }, () => base.items[0]) },
    { ...base, parentageLevel: 'PARENT' }, { ...base, parentageLevel: 'CHILD' },
    { ...base, items: [base.items[0], base.items[0]] },
    ...[0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1].map(productRevision => ({ ...base, items: [{ ...base.items[0], productRevision }] })),
    { ...base, items: [{ ...base.items[0], productId: 'not-a-stable-id' }] },
    { ...base, items: [{ ...base.items[0], variantId: ` ${base.items[0].variantId}` }] },
    { ...base, items: [{ ...base.items[0], extra: true }] },
    ...[undefined, [], new Date(), { number: Number.NaN }, { invalid: undefined }, { deep }, JSON.parse('{"__proto__":{"polluted":true}}'), { prototype: {} }, { constructor: {} }]
      .map(attributes => ({ ...base, items: [{ ...base.items[0], attributes }] })),
    { ...base, items: base.items.slice(0, 2).map(item => ({ ...item, attributes: { payload: 'x'.repeat(1_060_000) } })) },
  ];
  for (const input of invalid) await assert.rejects(prepare(f.service, input));
  assert.equal(reads, 0); assert.deepEqual(f.service.listDrafts(f.product.id), []);
});

for (const shape of ['all holes', 'valid item followed by a hole'] as const) {
  test(`sparse items (${shape}) reject before any schema read or draft write`, async t => {
    const f = fixture(t); const input = batch(f); let reads = 0; const original = f.service.getSchema.bind(f.service);
    f.service.getSchema = async selection => { reads++; return original(selection); };
    const items = new Array<BatchInput['items'][number]>(shape === 'all holes' ? 1 : 2);
    if (shape !== 'all holes') items[0] = input.items[0];
    await assert.rejects(prepare(f.service, { ...input, items }));
    assert.equal(reads, 0, 'sparse item structure must be rejected before getSchema');
    assert.deepEqual(f.service.listDrafts(f.product.id), []);
    assert.deepEqual(f.service.listCalls(), []);
  });
}

test('equivalent reordered attributes reuse drafts across repeated, concurrent and restarted preparation', async t => {
  const f = fixture(t); const input = batch(f);
  const [first, concurrent] = await Promise.all([prepare(f.service, input), prepare(f.service, reversed(input))]);
  assert.deepEqual(first.items.map(item => item.disposition), ['CREATED', 'CREATED', 'CREATED']);
  assert.deepEqual(concurrent.items.map(item => item.disposition), ['REUSED', 'REUSED', 'REUSED']);
  assert.deepEqual(concurrent.items.map(item => item.draft), first.items.map(item => item.draft));
  const before = first.items.map(item => internals(f.service).persistence.record(item.draft!.id));
  f.advance(86_400_001);
  const repeated = await prepare(f.service, input); assert.deepEqual(repeated.items.map(item => item.disposition), ['REUSED', 'REUSED', 'REUSED']);
  f.reopen(); const restored = await prepare(f.service, input);
  assert.deepEqual(restored.items.map(item => item.draft!.id), first.items.map(item => item.draft!.id));
  assert.deepEqual(restored.items.map(item => item.disposition), ['REUSED', 'REUSED', 'REUSED']);
  assert.deepEqual(restored.items.map(item => internals(f.service).persistence.record(item.draft!.id)), before);
  assert.equal(f.service.listDrafts(f.product.id).length, 3);
});

test('reuse computes current issues without clearing an existing preview or changing record history', async t => {
  const f = fixture(t, 1); const input = batch(f); const created = (await prepare(f.service, input)).items[0].draft!;
  await f.service.previewDraft(created); const before = internals(f.service).persistence.record(created.id);
  const result = (await prepare(f.service, input)).items[0];
  assert.equal(result.disposition, 'REUSED'); assert.deepEqual(result.issues, []); assert.deepEqual(result.draft, before.draft);
  assert.deepEqual(internals(f.service).persistence.record(created.id), before);
});

test('manual edits reject only the conflicting SKU and preserve edits and sibling drafts', async t => {
  const f = fixture(t); const input = batch(f); const created = await prepare(f.service, input); const first = created.items[0].draft!;
  const edited = f.service.saveDraft({ ...first, attributes: { ...first.attributes, brand: [{ value: 'Manual brand', marketplace_id: f.target.marketplaceId }] } });
  const before = internals(f.service).persistence.record(edited.id); const result = await prepare(f.service, input);
  assert.deepEqual(result.items.map(item => item.disposition), ['REJECTED', 'REUSED', 'REUSED']);
  assert.match(result.items[0].error!, /修改|不同|冲突/); assert.equal(result.items[0].draft, null);
  assert.deepEqual(internals(f.service).persistence.record(edited.id), before); assert.equal(f.service.listDrafts(f.product.id).length, 3);
});

test('a new source revision can prepare fresh drafts without modifying old drafts', async t => {
  const f = fixture(t, 1); const first = (await prepare(f.service, batch(f))).items[0].draft!;
  const changed = f.store.saveProduct({ ...productInput(f.product), title: 'New source title' });
  const second = (await prepare(f.service, batch(f, changed))).items[0];
  assert.equal(second.disposition, 'CREATED'); assert.notEqual(second.draft!.id, first.id); assert.equal(second.draft!.productRevision, changed.revision);
  assert.deepEqual(f.service.getDraft(first.id), first);
});

test('busy drafts and unfinished persistent locks reject individual SKUs', async t => {
  const f = fixture(t); const input = batch(f); const created = await prepare(f.service, input); const state = internals(f.service);
  state.busy.add(created.items[0].draft!.id);
  const locked = state.persistence.record(created.items[1].draft!.id); locked.draft.state = 'SUBMITTING'; state.persistence.beginWrite(listingHash(locked.draft, locked.draft.sku), locked);
  let result = await prepare(f.service, input);
  assert.deepEqual(result.items.map(item => item.disposition), ['REJECTED', 'REJECTED', 'REUSED']);
  assert.match(result.items[0].error!, /处理|等待/); assert.match(result.items[1].error!, /核对|提交|回读/);
  f.reopen(); result = await prepare(f.service, input);
  assert.deepEqual(result.items.map(item => item.disposition), ['REUSED', 'REJECTED', 'REUSED']);
  assert.equal(internals(f.service).persistence.lock(listingHash(locked.draft, locked.draft.sku))!.state, 'UNKNOWN');
});

test('a submitted listing blocks batch preparation even after readback releases its accepted lock', async t => {
  const f = fixture(t, 1); const input = batch(f); let draft = (await prepare(f.service, input)).items[0].draft!;
  draft = await f.service.previewDraft(draft); draft = await f.service.submitDraft(draft, true); draft = await f.service.readListing(draft);
  assert.equal(draft.state, 'BUYABLE'); assert.equal(internals(f.service).persistence.locked(listingHash(draft, draft.sku)), false);
  const source = f.store.saveProduct({ ...productInput(f.product), title: 'Updated source' });
  const result = (await prepare(f.service, batch(f, source))).items[0];
  assert.equal(result.disposition, 'REJECTED'); assert.match(result.error!, /人工|提交|核对/); assert.equal(f.service.listDrafts(f.product.id).length, 1);
});

test('submittedAt and final states on any record with the same seller/marketplace/mode/SKU block a new target scope', async t => {
  const f = fixture(t, 1); const input = batch(f); const draft = (await prepare(f.service, input)).items[0].draft!; const state = internals(f.service);
  const record = state.persistence.record(draft.id); const alias = { ...f.target, id: randomUUID(), name: 'Same seller other local target' }; state.persistence.putTarget(alias);
  record.draft.state = 'BLOCKED'; record.draft.submittedAt = '2026-01-01T00:00:00Z'; state.persistence.putRecord(record);
  const result = (await prepare(f.service, { ...input, targetId: alias.id })).items[0];
  assert.equal(result.disposition, 'REJECTED'); assert.equal(f.service.listDrafts(f.product.id).length, 1);
});

test('missing products, wrong variants and stale revisions reject individually while valid source items continue', async t => {
  const f = fixture(t); const other = f.store.createProduct(); const input = batch(f);
  input.items = [{ ...input.items[0], productId: randomUUID() }, { ...input.items[1], variantId: other.variants[0].id }, { ...input.items[2], productRevision: f.product.revision + 1 },
    { productId: other.id, productRevision: other.revision, variantId: other.variants[0].id, attributes: {} }];
  const result = await prepare(f.service, input);
  assert.deepEqual(result.items.map(item => item.disposition), ['REJECTED', 'REJECTED', 'REJECTED', 'CREATED']);
  assert.ok(result.items.slice(0, 3).every(item => item.error && item.draft === null)); assert.equal(result.items[0].sku, null);
  assert.deepEqual(f.service.listDrafts(f.product.id), []); assert.equal(f.service.listDrafts(other.id).length, 1);
});

test('source changes during schema await reject that product while another unchanged product continues', async t => {
  const f = fixture(t, 1); const other = f.store.createProduct(); const input = batch(f);
  input.items.push({ productId: other.id, productRevision: other.revision, variantId: other.variants[0].id, attributes: {} });
  const gate = await gatedSchema(f.service); const pending = prepare(f.service, input); await gate.waiting;
  f.store.saveProduct({ ...productInput(f.product), title: 'Edited while fetching schema' }); gate.release();
  const result = await pending; assert.deepEqual(result.items.map(item => item.disposition), ['REJECTED', 'CREATED']);
  assert.match(result.items[0].error!, /变化|更新|版本/); assert.equal(f.service.listDrafts(f.product.id).length, 0);
});

test('SKU identity is checked again after schema await even if a broken source writer omits its revision bump', async t => {
  const f = fixture(t); const gate = await gatedSchema(f.service); const pending = prepare(f.service, batch(f)); await gate.waiting;
  const db = new DatabaseSync(join(f.directory, 'red.sqlite')); db.prepare('UPDATE variants SET sku=? WHERE id=?').run('CHANGED-SKU', f.product.variants[0].id); db.close(); gate.release();
  const result = await pending; assert.deepEqual(result.items.map(item => item.disposition), ['REJECTED', 'CREATED', 'CREATED']);
});

test('paused or rotated targets during schema await reject the whole batch without drafts', async t => {
  for (const change of ['pause', 'generation', 'identity'] as const) {
    const f = fixture(t); const gate = await gatedSchema(f.service); const pending = prepare(f.service, batch(f)); await gate.waiting;
    if (change === 'pause') f.service.pauseTarget({ targetId: f.target.id, paused: true });
    else internals(f.service).persistence.putTarget(change === 'identity' ? { ...f.target, sellerId: 'CHANGED_SELLER' } : f.target, change === 'generation');
    gate.release(); await assert.rejects(pending, /暂停|变化|重新|匹配/); assert.deepEqual(f.service.listDrafts(f.product.id), []);
  }
});

test('source snapshots and target generation are read before getSchema starts', async t => {
  const f = fixture(t, 1); const original = f.service.getSchema.bind(f.service);
  f.service.getSchema = async selection => { f.store.saveProduct({ ...productInput(f.product), title: 'Immediate schema side effect' }); return original(selection); };
  const result = await prepare(f.service, batch(f)); assert.equal(result.items[0].disposition, 'REJECTED');
  const g = fixture(t, 1); const originalG = g.service.getSchema.bind(g.service);
  g.service.getSchema = async selection => { internals(g.service).persistence.putTarget(g.target, true); return originalG(selection); };
  await assert.rejects(prepare(g.service, batch(g)), /变化|重新/); assert.deepEqual(g.service.listDrafts(g.product.id), []);
});

test('unusable schema and schema retrieval failure reject the batch before drafts', async t => {
  const f = fixture(t); const original = f.service.getSchema.bind(f.service);
  f.service.getSchema = async input => { const schema = await original(input); schema.schema = { type: 'object', unsupported_constraint: true }; return schema; };
  await assert.rejects(prepare(f.service, batch(f)), /Schema|约束/); assert.deepEqual(f.service.listDrafts(f.product.id), []);
  f.service.getSchema = async () => { throw new Error('schema unavailable'); };
  await assert.rejects(prepare(f.service, batch(f)), /schema unavailable/); assert.deepEqual(f.service.listDrafts(f.product.id), []);
});

test('secret-bearing caller or source attributes are rejected before persistence', async t => {
  const f = fixture(t); await f.service.importCredentials(credentials); const input = batch(f);
  input.items[0].attributes.brand = [{ value: `Leaked ${credentials.clientSecret}`, marketplace_id: f.target.marketplaceId }];
  input.items[1].attributes.authorization = 'not allowed';
  const result = await prepare(f.service, input); assert.deepEqual(result.items.map(item => item.disposition), ['REJECTED', 'REJECTED', 'CREATED']);
  assert.ok(result.items.slice(0, 2).every(item => /授权|令牌|敏感/.test(item.error!)));
  assert.equal(JSON.stringify(internals(f.service).persistence.records()).includes(credentials.clientSecret), false);
  const source = f.store.saveProduct({ ...productInput(f.product), title: `Source ${credentials.refreshToken}` });
  const rejected = await prepare(f.service, batch(f, source)); assert.ok(rejected.items.every(item => item.disposition === 'REJECTED'));
  assert.equal(f.service.listDrafts(f.product.id).length, 1);
});

test('a lock or conflicting draft created during schema await is re-read inside the preparation transaction', async t => {
  const f = fixture(t); const input = batch(f); const gate = await gatedSchema(f.service); const pending = prepare(f.service, input); await gate.waiting;
  const schema = await implementation.AmazonService.prototype.getSchema.call(f.service, f.selected);
  const original = f.service.getSchema; f.service.getSchema = async () => schema;
  const other = await f.service.createDraft({ ...f.selected, productId: f.product.id, variantId: f.product.variants[0].id });
  f.service.getSchema = original;
  const record = internals(f.service).persistence.record(other.id); record.draft.state = 'SUBMITTING'; internals(f.service).persistence.beginWrite(listingHash(record.draft, record.draft.sku), record);
  gate.release(); const result = await pending;
  assert.deepEqual(result.items.map(item => item.disposition), ['REJECTED', 'CREATED', 'CREATED']); assert.equal(f.service.listDrafts(f.product.id).length, 3);
});

test('all newly prepared records roll back together when a later SQLite write fails', async t => {
  const f = fixture(t); const persistence = internals(f.service).persistence; const original = persistence.putRecord.bind(persistence); let writes = 0;
  persistence.putRecord = (record: DraftRecord) => { assert.equal(persistence.db.isTransaction, true); if (++writes === 2) throw new Error('Injected local persistence failure'); original(record); };
  await assert.rejects(prepare(f.service, batch(f)), /Injected local persistence failure/);
  assert.deepEqual(f.service.listDrafts(f.product.id), []); assert.equal(persistence.db.isTransaction, false);
  persistence.putRecord = original; const result = await prepare(f.service, batch(f)); assert.ok(result.items.every(item => item.disposition === 'CREATED'));
});
