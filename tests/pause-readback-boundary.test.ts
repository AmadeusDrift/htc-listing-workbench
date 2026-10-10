import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { AmazonPersistence, type DraftRecord } from '../src/main/amazon/persistence.ts';
import { listingHash } from '../src/main/amazon/context.ts';
import { FollowupService } from '../src/main/followup/service.ts';
import { ProcurementService } from '../src/main/procurement/service.ts';
import type { AmazonDraft } from '../src/shared/amazon-contracts.ts';
import { ExecutionService } from '../src/main/execution/service.ts';
import { AutomaticListingService } from '../src/main/automatic-listing/service.ts';
import { ImageWorkflowService } from '../src/main/image-workflow/service.ts';
import { ItemLabelService } from '../src/main/item-labels/service.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { simplePdf } from './fixtures/simple-pdf.ts';
import type { AutomaticListingTask } from '../src/shared/automatic-listing-contracts.ts';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { salesStoreScope } from '../src/main/sales-plans/planning.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';
import { UserFacingError } from '../src/shared/errors.ts';

const secretStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)), decryptString: (value: Buffer) => Buffer.from(value.map(byte => byte ^ 0xa5)).toString() };
const credentials = { name: 'Synthetic pause boundary', sellerId: 'SYNTHETIC_SELLER', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en_US', clientId: 'synthetic_client', clientSecret: 'synthetic_secret', refreshToken: 'synthetic_refresh_1' };
const json = (data: unknown, status = 200, requestId = 'synthetic-request') => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'x-amzn-requestid': requestId } });
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
type Counts = { oauthPost: number; listingsGet: number; previewPut: number; formalPut: number; paidProvider: number; labelPost: number; unexpected: number; realNetwork: number };
const zero = (): Counts => ({ oauthPost: 0, listingsGet: 0, previewPut: 0, formalPut: 0, paidProvider: 0, labelPost: 0, unexpected: 0, realNetwork: 0 });
const delta = (after: Counts, before: Counts): Counts => Object.fromEntries(Object.keys(after).map(key => [key, after[key as keyof Counts] - before[key as keyof Counts]])) as Counts;
type Hook = (url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>;

/** Real local services/storage; only external transport, time, and scheduling are replaced. */
async function fixture(t: test.TestContext) {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(join(parent, 'pause-readback-'));
  const counts = zero(); let now = Date.parse('2026-10-10T00:00:00.000Z'), hook: Hook = () => undefined;
  t.mock.method(Date, 'now', () => now); // Execution's preview freshness shares the injected transport clock.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { counts.realNetwork++; throw new Error('REAL_NETWORK_DENIED'); };
  let store = new WorkspaceStore(directory), amazon: AmazonService, followup: FollowupService, procurement: ProcurementService;
  let automatic: AutomaticListingService, execution: ExecutionService, images: ImageWorkflowService, labels: ItemLabelService;
  const schema = { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object', properties: {
    item_name: { type: 'string', minLength: 1 }, main_product_image_locator: { type: 'array', items: { type: 'object', properties: { media_location: { type: 'string' } } } },
    parentage_level: { type: 'array', items: { type: 'object', properties: { value: { type: 'string', enum: ['parent', 'child'] } } } },
    variation_theme: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', enum: ['COLOR'] } } } },
    child_parent_sku_relationship: { type: 'array', items: { type: 'object', properties: { child_relationship_type: { type: 'string' }, parent_sku: { type: 'string' } } } },
  }, required: ['item_name'], additionalProperties: false };
  const labelUrl = 'https://test-labels.s3.amazonaws.com/synthetic.pdf?X-Amz-Signature=synthetic';
  const meta = { $id: 'https://schemas.amazon.com/selling-partners/definitions/product-types/meta-schema/v1', $schema: 'https://json-schema.org/draft/2019-09/schema', type: ['object', 'boolean'] };
  const link = (kind: string, data: unknown) => ({ link: { resource: `https://htc-test.s3.amazonaws.com/${kind}.json`, verb: 'GET' }, checksum: createHash('md5').update(JSON.stringify(data)).digest('base64') });
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET';
    if (url.hostname === 'api.amazon.com' && url.pathname === '/auth/o2/token' && method === 'POST') {
      counts.oauthPost++; return await hook(url, init) ?? json({ access_token: 'synthetic_access', token_type: 'bearer', expires_in: 3600 });
    }
    if (url.hostname === 'htc-test.s3.amazonaws.com' && ['/schema.json', '/meta.json'].includes(url.pathname) && method === 'GET') return json(url.pathname === '/meta.json' ? meta : schema);
    if (url.hostname === 'sellingpartnerapi-na.amazon.com' && url.pathname === '/inbound/fba/2024-03-20/items/labels' && method === 'POST') { counts.labelPost++; return await hook(url, init) ?? json({ documentDownloads: [{ uri: labelUrl, downloadType: 'URL' }] }); }
    if (url.href === labelUrl && method === 'GET') return new Response(new Uint8Array(simplePdf()), { headers: { 'content-type': 'application/pdf' } });
    if (url.hostname === 'sellingpartnerapi-na.amazon.com' && url.pathname === '/definitions/2020-09-01/productTypes/STORAGE_BAG' && method === 'GET') return json({ marketplaceIds: [credentials.marketplaceId], productType: 'STORAGE_BAG', locale: url.searchParams.get('locale'), requirements: url.searchParams.get('requirements'), requirementsEnforced: 'ENFORCED', productTypeVersion: { version: 'v1' }, propertyGroups: { general: { title: 'General', propertyNames: ['item_name'] } }, schema: link('schema', schema), metaSchema: link('meta', meta) });
    if (url.hostname === 'sellingpartnerapi-na.amazon.com' && url.pathname.startsWith('/listings/2021-08-01/items/')) {
      const sku = decodeURIComponent(url.pathname.split('/').at(-1)!);
      if (method === 'PUT') { const preview = url.searchParams.get('mode') === 'VALIDATION_PREVIEW'; counts[preview ? 'previewPut' : 'formalPut']++; return await hook(url, init) ?? json({ sku, status: preview ? 'VALID' : 'ACCEPTED', submissionId: `accepted-${sku}`, issues: [] }); }
      if (method === 'GET') { counts.listingsGet++; return await hook(url, init) ?? json({ sku, summaries: [{ marketplaceId: credentials.marketplaceId, asin: 'B012345678', status: ['BUYABLE', 'DISCOVERABLE'] }], issues: [] }); }
    }
    counts.unexpected++; throw new Error(`UNEXPECTED_SYNTHETIC_ENDPOINT ${method} ${url.hostname}${url.pathname}`);
  };
  const dependencies = { fetch: fetcher, schemaFetch: fetcher, dataFetch: fetcher, now: () => now, sleep: async (milliseconds: number) => { now += milliseconds; }, random: () => 0, resolveAddresses: async () => ['52.0.0.1'], timeoutMs: 5000 };
  const timers: { callback: () => void; cancelled: boolean }[] = [];
  const profile = { id: 'alpha' as const, name: 'Alpha' as const, generation: 1, enabled: true, configured: true, host: 'ftp.example.test', port: 21, secure: true, remoteRoot: '/', publicBaseUrl: 'https://images.example.test/' };
  const uploads = new Map<string, { id: string; assetId: string; profileId: string; generation: number; sha256: string; publicUrl: string; status: string }>();
  // Hosting is an external boundary. No FTP or print surface is opened by these service tests.
  const hosting = { getProfile: () => structuredClone(profile), upload: async (input: { assetId: string }) => structuredClone(uploads.get(input.assetId)!), verify: async (id: string) => structuredClone([...uploads.values()].find(row => row.id === id)!) };
  const rules = defaultListingRules(); rules.pricing.bundleEnabled = false;
  // Real image orchestration is present; an unexpected paid service call fails closed.
  const paidBoundary = new Proxy({}, { get: () => () => { counts.paidProvider++; throw new Error('PAID_PROVIDER_DENIED'); } });
  const open = () => {
    amazon = new AmazonService(directory, id => store.getProduct(id), secretStorage, dependencies);
    followup = new FollowupService(directory, amazon, { now: () => now, setTimeout: callback => { const timer = { callback, cancelled: false }; timers.push(timer); return timer; }, clearTimeout: timer => { (timer as typeof timers[number]).cancelled = true; } });
    procurement = new ProcurementService(directory, store, amazon);
    labels = new ItemLabelService(directory, amazon, procurement, { now: () => now, sleep: async ms => { now += ms; } });
    execution = new ExecutionService(directory, store, amazon, hosting, { scheduleFollowup: id => followup.schedule(id) });
    images = new ImageWorkflowService(directory, store, amazon, paidBoundary as ConstructorParameters<typeof ImageWorkflowService>[3], paidBoundary as ConstructorParameters<typeof ImageWorkflowService>[4]);
    automatic = new AutomaticListingService(directory, { store, amazon, followup, procurement, labels, execution, images, hosting, rules: () => structuredClone(rules) });
  };
  const close = async () => { await automatic.close(); await execution.close(); await images.close(); await labels.close(); await followup.close(); procurement.close(); amazon.close(); store.close(); };
  open(); const target = await amazon!.importCredentials(credentials);
  t.after(async () => { await close(); globalThis.fetch = originalFetch; assert.equal(counts.realNetwork, 0); assert.equal(counts.unexpected, 0); assert.equal(counts.paidProvider, 0); rmSync(directory, { recursive: true, force: true }); });
  const persistence = () => new AmazonPersistence(directory);
  const prepared = async (suffix: string, withAsset = false, parentageLevel = 'NONE') => {
    let product = store.createProduct(); product = store.saveProduct({ id: product.id, revision: product.revision, title: 'Synthetic accepted product', sourceUrl: product.sourceUrl, description: product.description, status: product.status, facts: product.facts,
      variants: product.variants.map(({ id, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku: `PAUSE-${suffix}`, originalSpec, normalizedSpec, purchasePrice, inventory })) });
    if (withAsset) {
      const assetId = randomUUID(), sha256 = 'a'.repeat(64);
      product = store.addAssets({ productId: product.id, revision: product.revision }, [{ id: assetId, fileName: 'synthetic.png', mimeType: 'image/png', width: 1000, height: 1000, byteSize: 10, originalPath: `assets/${assetId}.png`, previewPath: `assets/${assetId}.preview.png`, sha256 }]);
      product = store.updateAsset({ productId: product.id, revision: product.revision, assetId, role: 'main', variantIds: [product.variants[0].id] });
      uploads.set(assetId, { id: randomUUID(), assetId, profileId: 'alpha', generation: 1, sha256, publicUrl: `https://images.example.test/${assetId}.png`, status: 'AVAILABLE' });
    }
    return amazon.createDraft({ targetId: target.id, productId: product.id, variantId: product.variants[0].id, productType: 'STORAGE_BAG', requirements: 'LISTING', parentageLevel, locale: 'en_US' });
  };
  return {
    directory, counts, target, timers, uploads, get store() { return store; }, get amazon() { return amazon; }, get followup() { return followup; }, get procurement() { return procurement; },
    get automatic() { return automatic; }, get execution() { return execution; }, get images() { return images; }, get labels() { return labels; },
    advance(milliseconds = 30 * 60_000) { now += milliseconds; }, hook(value: Hook) { hook = value; },
    record(id: string) { const db = persistence(); try { return db.record(id); } finally { db.close(); } },
    editRecord(id: string, action: (record: DraftRecord) => void) { const db = persistence(); try { const record = db.record(id); action(record); db.putRecord(record); } finally { db.close(); } },
    lock(draft: AmazonDraft) { const db = persistence(); try { return db.lock(listingHash(draft, draft.sku)); } finally { db.close(); } },
    async rotate() { await amazon.importCredentials({ ...credentials, refreshToken: 'synthetic_refresh_2' }); },
    async reopen() { await close(); store = new WorkspaceStore(directory); open(); },
    prepared,
    async accepted(suffix = 'ONE', parentageLevel = 'NONE') {
      let draft = await prepared(suffix, false, parentageLevel);
      draft = await amazon.previewDraft(draft); return amazon.submitDraft(draft, true);
    },
  };
}

test('generation rotated during a real Followup GET never creates a trusted Amazon observation or procurement batch', async t => {
  const f = await fixture(t), draft = await f.accepted(), entered = deferred(), release = deferred();
  f.followup.schedule(draft.id); const before = structuredClone(f.counts); f.advance();
  f.hook(async (url, init) => { if (init.method === 'GET' && url.pathname.includes('/listings/')) { entered.release(); await release.promise; } return undefined; });
  const running = f.followup.runDue(); await entered.promise; await f.rotate(); release.release(); await running;
  assert.equal(f.followup.get(draft.id).reason, 'TARGET_CHANGED');
  assert.equal(f.amazon.getDraft(draft.id).state, 'SUBMITTED');
  assert.equal(f.amazon.getDraft(draft.id).checkedAt, null);
  assert.equal(f.amazon.getListingObservation(draft.id), null);
  assert.equal(f.lock(draft)?.state, 'SUBMITTED');
  assert.equal(f.procurement.candidates()[0].eligible, false);
  assert.throws(() => f.procurement.ensureAutomaticBatch(randomUUID(), [draft.id], { [draft.id]: 5 }), /回读/);
  assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 1 });
  await f.reopen(); await f.followup.runDue();
  assert.equal(f.amazon.getListingObservation(draft.id), null); assert.equal(f.procurement.candidates()[0].eligible, false); assert.equal(f.procurement.list().length, 0);
  assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 1 });
});

test('generation rotation before due processing stops the old Followup with zero requests', async t => {
  const f = await fixture(t), draft = await f.accepted(); f.followup.schedule(draft.id); await f.rotate(); f.advance();
  const before = structuredClone(f.counts); await f.followup.runDue();
  assert.equal(f.followup.get(draft.id).reason, 'TARGET_CHANGED'); assert.equal(f.amazon.getListingObservation(draft.id), null); assert.equal(f.lock(draft)?.state, 'SUBMITTED');
  assert.deepEqual(delta(f.counts, before), zero());
});

for (const status of [200, 404, 400]) for (const observed of [false, true]) test(`late ${status} after credential rotation preserves ${observed ? 'the previous valid observation' : 'the accepted lock'}`, async t => {
  const f = await fixture(t); let draft = await f.accepted(); if (observed) draft = await f.amazon.readListing(draft);
  const trusted = f.record(draft.id), observation = f.amazon.getListingObservation(draft.id), lock = f.lock(draft), entered = deferred(), release = deferred();
  const before = structuredClone(f.counts); f.advance();
  f.hook(async (url, init) => {
    if (init.method === 'GET' && url.pathname.includes('/listings/')) {
      entered.release(); await release.promise;
      return json(status === 200 ? { sku: draft.sku, summaries: [{ marketplaceId: draft.marketplaceId, asin: 'B999999999', status: ['DISCOVERABLE'] }] } : { errors: [{ code: 'SyntheticLateFailure' }] }, status, 'late-response');
    }
  });
  const read = f.amazon.readListing(draft), rejected = assert.rejects(read, /变化|不匹配/);
  await entered.promise; await f.rotate(); release.release(); await rejected;
  assert.deepEqual(f.record(draft.id), trusted); assert.deepEqual(f.amazon.getListingObservation(draft.id), observation); assert.deepEqual(f.lock(draft), lock);
  assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 1 });
  await f.reopen(); assert.deepEqual(f.amazon.getListingObservation(draft.id), observation); assert.deepEqual(f.lock(draft), lock);
});

for (const change of ['revision', 'attributes', 'schema', 'sku', 'submission', 'target', 'missing'] as const) test(`a ${change} change during GET cannot adopt or restore the stale draft`, async t => {
  const f = await fixture(t), draft = await f.accepted(), entered = deferred(), release = deferred();
  f.hook(async (url, init) => { if (init.method === 'GET' && url.pathname.includes('/listings/')) { entered.release(); await release.promise; } });
  const read = f.amazon.readListing(draft), rejected = assert.rejects(read, /变化|不存在|不匹配|清理/); await entered.promise;
  if (change === 'target' || change === 'missing') {
    const db = new AmazonPersistence(f.directory);
    try { if (change === 'target') db.putTarget({ ...db.target(draft.targetId), sellerId: 'ANOTHER_SELLER' }); else db.db.prepare('DELETE FROM listing_drafts WHERE id=?').run(draft.id); } finally { db.close(); }
  } else f.editRecord(draft.id, record => {
    if (change === 'revision') record.draft.revision++;
    if (change === 'attributes') record.draft.attributes.item_name = 'new submitted content';
    if (change === 'schema') record.draft.schema.version = 'changed';
    if (change === 'sku') record.draft.sku = 'NEW-SKU';
    if (change === 'submission') record.draft.submissionId = 'a-new-submission';
  });
  const current = change === 'missing' ? null : f.record(draft.id); release.release(); await rejected;
  if (current) assert.deepEqual(f.record(draft.id), current); else assert.throws(() => f.amazon.getDraft(draft.id), /不存在|清理/);
  assert.equal(f.lock(draft)?.state, 'SUBMITTED');
});

test('a compatible in-flight response preserves other-instance audit updates and legacy observations survive restart', async t => {
  const f = await fixture(t), draft = await f.accepted(), entered = deferred(), release = deferred();
  f.hook(async (url, init) => { if (init.method === 'GET' && url.pathname.includes('/listings/')) { entered.release(); await release.promise; } });
  const read = f.amazon.readListing(draft); await entered.promise;
  f.editRecord(draft.id, record => { record.draft.events.push({ at: draft.updatedAt, operation: 'readback', state: draft.state, requestId: 'another-instance-audit', summary: 'Concurrent local audit' }); });
  release.release(); assert.equal((await read).state, 'BUYABLE');
  assert.ok(f.amazon.getDraft(draft.id).events.some(event => event.requestId === 'another-instance-audit'));
  const observation = f.amazon.getListingObservation(draft.id); assert.ok(observation); assert.equal(f.lock(draft), null);
  // No new persistent generation field is required for this pre-existing record shape.
  await f.reopen(); assert.deepEqual(f.amazon.getListingObservation(draft.id), observation); assert.equal(f.procurement.candidates()[0].eligible, true);
});

test('normal 404 and errors retain finite retry and accepted-lock behavior', async t => {
  const f = await fixture(t), draft = await f.accepted(); f.followup.schedule(draft.id); f.advance();
  f.hook((url, init) => init.method === 'GET' && url.pathname.includes('/listings/') ? json({ errors: [{ code: 'NotFound' }] }, 404) : undefined);
  await f.followup.runDue(); assert.equal(f.amazon.getDraft(draft.id).state, 'PROCESSING'); assert.equal(f.followup.get(draft.id).status, 'PROCESSING'); assert.ok(f.followup.get(draft.id).nextDueAt); assert.equal(f.lock(draft)?.state, 'SUBMITTED');
  f.advance(); f.hook((url, init) => init.method === 'GET' && url.pathname.includes('/listings/') ? json({ errors: [{ code: 'ServiceUnavailable' }] }, 503) : undefined);
  const before = structuredClone(f.counts); await f.followup.runDue(); assert.equal(delta(f.counts, before).listingsGet, 3); assert.equal(f.followup.get(draft.id).status, 'PROCESSING'); assert.equal(f.lock(draft)?.state, 'SUBMITTED');
  f.hook(() => undefined); f.advance(60 * 60_000); await f.followup.runDue(); assert.equal(f.followup.get(draft.id).status, 'READY'); assert.equal(f.lock(draft), null);
});

test('draft and target identity must match before a manual read is sent', async t => {
  const f = await fixture(t), draft = await f.accepted(); f.editRecord(draft.id, record => { record.draft.sellerId = 'OLD_SELLER'; });
  const before = structuredClone(f.counts); await assert.rejects(f.amazon.readListing(draft), /身份|不匹配|变化/); assert.deepEqual(delta(f.counts, before), zero());
});

async function waitingTask(f: Awaited<ReturnType<typeof fixture>>, draft: AmazonDraft) {
  const task = await f.automatic.create({ productIds: [draft.productId], targetId: draft.targetId, profileId: 'alpha', productType: 'STORAGE_BAG' });
  f.automatic.startAuthorized(f.automatic.prepareStart(task.id)); await f.automatic.waitForIdle();
  assert.equal(f.automatic.get(task.id).status, 'WAITING'); assert.equal(f.followup.get(draft.id).status, 'WAITING');
  return task;
}

for (const action of ['pause', 'cancel'] as const) for (const moment of ['scheduled', 'inflight'] as const) test(`real task ${action} at ${moment} permits accepted-only readback but no procurement or labels, including restart`, async t => {
  const f = await fixture(t), draft = await f.accepted(), task = await waitingTask(f, draft), entered = deferred(), release = deferred();
  const before = structuredClone(f.counts); f.advance();
  if (moment === 'inflight') f.hook(async (url, init) => { if (init.method === 'GET' && url.pathname.includes('/listings/')) { entered.release(); await release.promise; } });
  if (moment === 'scheduled') f.automatic[action](task.id);
  const running = f.followup.runDue();
  if (moment === 'inflight') { await entered.promise; f.automatic[action](task.id); release.release(); }
  await running; await f.automatic.refreshWaiting(); await f.labels.runDue();
  assert.equal(f.followup.get(draft.id).status, 'READY'); assert.equal(f.amazon.getDraft(draft.id).state, 'BUYABLE');
  assert.equal(f.automatic.get(task.id).status, action === 'pause' ? 'PAUSED' : 'CANCELLED');
  assert.equal(f.procurement.list().length, 0); assert.equal(f.labels.list().length, 0);
  assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 1 });
  await f.reopen(); await f.automatic.refreshWaiting(); await f.followup.runDue(); await f.labels.runDue();
  assert.equal(f.automatic.get(task.id).status, action === 'pause' ? 'PAUSED' : 'CANCELLED'); assert.equal(f.procurement.list().length, 0); assert.equal(f.labels.list().length, 0);
  assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 1 });
});

test('stopping one task keeps another task and independent Followups progressing through real procurement and label PDF', async t => {
  const f = await fixture(t), first = await f.accepted('FIRST'), second = await f.accepted('SECOND');
  const stopped = await waitingTask(f, first), continued = await waitingTask(f, second), before = structuredClone(f.counts);
  f.automatic.pause(stopped.id); f.advance(); await f.followup.runDue(); await f.automatic.refreshWaiting(); await f.labels.runDue(); await f.automatic.refreshWaiting();
  assert.equal(f.followup.get(first.id).status, 'READY'); assert.equal(f.followup.get(second.id).status, 'READY');
  assert.equal(f.automatic.get(stopped.id).status, 'PAUSED'); assert.equal(f.automatic.get(continued.id).status, 'COMPLETED', f.automatic.get(continued.id).error ?? 'healthy sibling completes');
  const batches = f.procurement.list(); assert.equal(batches.length, 1); assert.equal(f.procurement.get(batches[0].id).automaticJobId, continued.id);
  const label = f.labels.list()[0]; assert.equal(label.jobId, continued.id); assert.equal(label.status, 'READY'); assert.equal((await f.labels.verifyFiles(label.id)).files.length, 1);
  assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 2, labelPost: 1 });
});

for (const action of ['pause', 'cancel'] as const) test(`task ${action} stops an already queued real label request across restart`, async t => {
  const f = await fixture(t), draft = await f.accepted(), task = await waitingTask(f, draft);
  f.advance(); await f.followup.runDue(); await f.automatic.refreshWaiting();
  assert.equal(f.procurement.list().length, 1); assert.equal(f.labels.list()[0].status, 'QUEUED');
  const before = structuredClone(f.counts); f.automatic[action](task.id); await f.labels.runDue(); await f.automatic.refreshWaiting();
  assert.equal(f.labels.list()[0].paused, true); assert.equal(f.labels.list()[0].status, action === 'pause' ? 'QUEUED' : 'CANCELLED'); assert.deepEqual(delta(f.counts, before), zero());
  await f.reopen(); await f.labels.runDue(); await f.automatic.refreshWaiting();
  assert.equal(f.automatic.get(task.id).status, action === 'pause' ? 'PAUSED' : 'CANCELLED'); assert.equal(f.labels.list()[0].paused, true); assert.deepEqual(delta(f.counts, before), zero());
});

test('maintenance pause allows the in-flight GET to settle but blocks the next due SKU', async t => {
  const f = await fixture(t), first = await f.accepted('FIRST'), second = await f.accepted('SECOND'), entered = deferred(), release = deferred();
  f.followup.schedule(first.id); f.followup.schedule(second.id); f.advance(); const before = structuredClone(f.counts);
  f.hook(async (url, init) => { if (init.method === 'GET' && url.pathname.includes('/listings/')) { entered.release(); await release.promise; } });
  const running = f.followup.runDue(); await entered.promise; f.followup.pause(); release.release(); await running;
  assert.equal(f.followup.get(first.id).status, 'READY'); assert.equal(f.followup.get(second.id).attempts, 0); assert.equal(f.amazon.getListingObservation(second.id), null);
  assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 1 }); await assert.rejects(f.followup.runDue(), /暂停/);
  f.followup.resume(); await f.followup.runDue(); assert.equal(f.followup.get(second.id).status, 'READY'); assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 2 });
});

test('maintenance pause during OAuth blocks the Listings beforeSend and all later due SKUs', async t => {
  const f = await fixture(t), first = await f.accepted('FIRST'), second = await f.accepted('SECOND'), entered = deferred(), release = deferred();
  f.followup.schedule(first.id); f.followup.schedule(second.id); f.advance(60 * 60_000); const before = structuredClone(f.counts);
  f.hook(async url => { if (url.hostname === 'api.amazon.com') { entered.release(); await release.promise; } });
  const running = f.followup.runDue(); await entered.promise; f.followup.pause(); release.release(); await running;
  assert.equal(f.followup.get(first.id).status, 'PROCESSING'); assert.equal(f.followup.get(second.id).attempts, 0);
  assert.equal(f.amazon.getListingObservation(first.id), null); assert.deepEqual(delta(f.counts, before), { ...zero(), oauthPost: 1 });
  f.followup.resume(); await f.followup.runDue(); assert.equal(f.followup.get(second.id).status, 'READY');
  f.advance(60 * 60_000); await f.followup.runDue(); assert.equal(f.followup.get(first.id).status, 'READY');
});

test('UNKNOWN writes persist across the real combination restart: no automatic GET, PUT, batch or labels; explicit read never clears the lock', async t => {
  const f = await fixture(t); f.hook((url, init) => init.method === 'PUT' && !url.searchParams.has('mode') ? json({ errors: [{ code: 'Unavailable' }] }, 503) : undefined);
  const draft = await f.accepted(); assert.equal(draft.state, 'UNKNOWN'); f.followup.schedule(draft.id); f.hook(() => undefined);
  const before = structuredClone(f.counts); f.advance(); await f.followup.runDue(); await f.automatic.refreshWaiting(); await f.labels.runDue();
  assert.deepEqual(delta(f.counts, before), zero()); assert.equal(f.followup.get(draft.id).reason, 'UNKNOWN_WRITE');
  await f.reopen(); await f.followup.runDue(); await f.automatic.refreshWaiting(); await f.labels.runDue(); assert.deepEqual(delta(f.counts, before), zero());
  const read = await f.amazon.readListing(draft); assert.equal(read.state, 'UNKNOWN'); assert.equal(f.amazon.getListingObservation(draft.id), null); assert.equal(f.lock(draft)?.state, 'UNKNOWN');
  assert.equal(f.procurement.candidates()[0].eligible, false); assert.equal(f.procurement.list().length, 0); assert.equal(f.labels.list().length, 0);
  assert.deepEqual(delta(f.counts, before), { ...zero(), oauthPost: 1, listingsGet: 1 });
});

test('a durable SUBMITTING checkpoint cannot auto-read or unlock after explicit read and restart', async t => {
  const f = await fixture(t), draft = await f.prepared('SUBMITTING'), db = new AmazonPersistence(f.directory);
  try {
    const record = db.record(draft.id); record.draft.state = 'SUBMITTING';
    db.beginWrite(listingHash(draft, draft.sku), record);
  } finally { db.close(); }
  f.followup.schedule(draft.id); f.advance(); const before = structuredClone(f.counts); await f.followup.runDue();
  assert.equal(f.followup.get(draft.id).reason, 'UNKNOWN_WRITE'); assert.deepEqual(delta(f.counts, before), zero());
  assert.equal((await f.amazon.readListing(draft)).state, 'UNKNOWN'); assert.equal(f.lock(draft)?.state, 'SUBMITTING'); assert.equal(f.amazon.getListingObservation(draft.id), null);
  await f.reopen(); await f.followup.runDue(); await f.automatic.refreshWaiting(); await f.labels.runDue();
  assert.equal(f.amazon.getDraft(draft.id).state, 'UNKNOWN'); assert.ok(f.lock(draft)); assert.equal(f.amazon.getListingObservation(draft.id), null);
  assert.equal(f.procurement.candidates()[0].eligible, false); assert.equal(f.procurement.list().length, 0); assert.equal(f.labels.list().length, 0);
  assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 1 });
});

/** Explicit synthetic setup checkpoint: not a claim that seven-image preparation ran. */
function checkpoint(f: Awaited<ReturnType<typeof fixture>>, id: string, change: (task: AutomaticListingTask) => void, parentGrant = false) {
  const internals = f.automatic as unknown as { tasks: Map<string, AutomaticListingTask>; grants: Set<string>; save(task: AutomaticListingTask): void };
  const task = internals.tasks.get(id)!; change(task); internals.save(task);
  if (parentGrant) internals.grants.add(id);
}

async function waitingFamily(f: Awaited<ReturnType<typeof fixture>>) {
  const source = await f.prepared('FAMILY-SOURCE'), product = f.store.getProduct(source.productId), naming = new SkuNamingService(f.directory);
  const rules = defaultListingRules(); rules.pricing.bundleEnabled = false;
  const recipe = buildSalesRecipes(product, null, rules)[0]; let plan: SalesListingPlan;
  try {
    const sourceGroupKey = `local:${product.id}:${recipe.groupKey}`;
    const group = naming.allocate({ storeScope: salesStoreScope(f.target), storeCode: 'U2', sourceGroupKey, collectedAt: product.createdAt, childKeys: [recipe.key] });
    plan = { namingGroupId: group.id, sourceGroupKey, collectedAt: group.collectedAt, collectionBasis: 'first_import', sku: group.children[0].sku, baseSku: group.baseSku, recipe,
      parentage: 'CHILD', parentSku: group.baseSku, variationTheme: 'COLOR', relationReason: 'Synthetic resolved color family checkpoint', familyResolved: true, namingChildKey: recipe.key };
  } finally { naming.close(); }
  const selection = { targetId: source.targetId, productType: 'STORAGE_BAG', requirements: 'LISTING', locale: 'en_US', listingProgram: 'standard', items: [{ productId: product.id, productRevision: product.revision, variantId: source.variantId, attributes: { item_name: product.title } }] };
  const children = await f.amazon.prepareDrafts({ ...selection, parentageLevel: 'CHILD' }, [plan]); const child = children.items[0].draft; assert.ok(child, children.items[0].error ?? 'real child preparation');
  const parentPlan = f.amazon.familyParentPlan(child), parents = await f.amazon.prepareDrafts({ ...selection, parentageLevel: 'PARENT' }, [parentPlan]); let parent = parents.items[0].draft; assert.ok(parent, parents.items[0].error ?? 'real parent preparation');
  parent = await f.amazon.previewDraft(parent); parent = await f.amazon.submitDraft(parent, true);
  assert.equal(parent.productId, child.productId); assert.equal(child.salesPlan?.parentSku, parent.sku); assert.equal(child.schema.parentageLevel, 'CHILD');
  const task = await f.automatic.create({ productIds: [product.id], targetId: source.targetId, profileId: 'alpha', productType: 'STORAGE_BAG' });
  checkpoint(f, task.id, saved => { saved.status = 'WAITING'; Object.assign(saved.items[0], { key: product.id + ':' + plan.recipe.key, sku: child.sku, salesPlan: plan, draftId: child.id, parentDraftId: parent.id, stage: 'PARENT', status: 'WAITING', sourcesPrepared: true }); }, true);
  return { parent, child, task };
}

for (const action of ['pause', 'cancel', 'continue'] as const) test(`parent READY after ${action} resumes only a still-authorized child at the next preparation boundary`, async t => {
  const f = await fixture(t), { parent, child, task } = await waitingFamily(f);
  // A paired positive control reaches the real scheduler's next preparation entry;
  // stop there deliberately instead of constructing an unrelated seven-image flow.
  let preparations = 0;
  t.mock.method(f.automatic as unknown as { prepareItem(): Promise<void> }, 'prepareItem', async () => { preparations++; throw new UserFacingError('NEXT_PREPARATION_SENTINEL'); });
  f.followup.schedule(parent.id); f.advance(); const entered = deferred(), release = deferred(), before = structuredClone(f.counts);
  f.hook(async (url, init) => { if (init.method === 'GET' && url.pathname.includes('/listings/')) { entered.release(); await release.promise; } });
  const running = f.followup.runDue(); await entered.promise; if (action !== 'continue') f.automatic[action](task.id); release.release(); await running;
  await f.automatic.refreshWaiting(); await f.automatic.waitForIdle(); await f.labels.runDue();
  assert.equal(f.followup.get(parent.id).status, 'READY'); assert.equal(f.amazon.getDraft(child.id).submittedAt, null);
  assert.equal(preparations, action === 'continue' ? 1 : 0);
  assert.equal(f.automatic.get(task.id).status, action === 'continue' ? 'NEEDS_ATTENTION' : action === 'pause' ? 'PAUSED' : 'CANCELLED');
  if (action === 'continue') assert.match(f.automatic.get(task.id).items[0].error!, /NEXT_PREPARATION_SENTINEL/);
  assert.equal(f.execution.list().length, 0); assert.equal(f.procurement.list().length, 0); assert.equal(f.labels.list().length, 0);
  assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 1 });
  if (action !== 'continue') {
    await f.reopen(); await f.automatic.refreshWaiting(); await f.automatic.waitForIdle(); await f.labels.runDue();
    assert.equal(f.automatic.get(task.id).status, action === 'pause' ? 'PAUSED' : 'CANCELLED'); assert.equal(f.execution.list().length, 0); assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 1 });
  }
});

for (const action of ['pause', 'cancel', 'continue'] as const) test(`real Execution late ACCEPTED ${action} preserves the receipt and stops revoked downstream work`, async t => {
  const f = await fixture(t), draft = await f.prepared('EXECUTION', true);
  const child = f.execution.create({ draftIds: [draft.id], profileId: 'alpha' });
  const task = await f.automatic.create({ productIds: [draft.productId], targetId: draft.targetId, profileId: 'alpha', productType: 'STORAGE_BAG' });
  // Link a real prepared Execution task at the ownership checkpoint; upload, fill,
  // validation, preview, submission and callbacks below remain real service code.
  checkpoint(f, task.id, saved => { saved.status = 'WAITING'; Object.assign(saved.items[0], { draftId: draft.id, stage: 'READBACK', status: 'WAITING', sourcesPrepared: true, executionTaskIds: [child.id] }); });
  const entered = deferred(), release = deferred();
  f.hook(async (url, init) => { if (init.method === 'PUT' && !url.searchParams.has('mode')) { entered.release(); await release.promise; } });
  f.execution.startAuthorized(f.execution.prepareStart(child.id));
  await Promise.race([entered.promise, f.execution.waitForIdle().then(() => { assert.equal(f.counts.formalPut, 1, f.execution.get(child.id).error ?? 'formal PUT reached'); })]);
  const before = structuredClone(f.counts); assert.deepEqual(before, { ...zero(), oauthPost: 1, previewPut: 1, formalPut: 1 });
  if (action !== 'continue') f.automatic[action](task.id);
  release.release(); await f.execution.waitForIdle(); await f.automatic.refreshWaiting();
  assert.equal(f.amazon.getDraft(draft.id).state, 'SUBMITTED'); assert.equal(f.lock(draft)?.state, 'SUBMITTED');
  assert.equal(f.execution.get(child.id).status, action === 'continue' ? 'COMPLETED' : action === 'pause' ? 'PAUSED' : 'CANCELLED');
  if (action === 'continue') {
    assert.equal(f.followup.get(draft.id).status, 'WAITING'); f.advance(); await f.followup.runDue(); await f.automatic.refreshWaiting(); await f.labels.runDue(); await f.automatic.refreshWaiting();
    assert.equal(f.automatic.get(task.id).status, 'COMPLETED'); assert.equal(f.procurement.list().length, 1); assert.equal(f.labels.list()[0].status, 'READY');
    assert.deepEqual(delta(f.counts, before), { ...zero(), listingsGet: 1, labelPost: 1 });
  } else {
    await f.followup.runDue(); await f.labels.runDue(); assert.equal(f.followup.list().length, 0); assert.equal(f.procurement.list().length, 0); assert.equal(f.labels.list().length, 0);
    assert.deepEqual(delta(f.counts, before), zero()); await f.reopen(); await f.followup.runDue(); await f.automatic.refreshWaiting(); await f.labels.runDue();
    assert.equal(f.automatic.get(task.id).status, action === 'pause' ? 'PAUSED' : 'CANCELLED'); assert.equal(f.execution.get(child.id).status, action === 'pause' ? 'PAUSED' : 'CANCELLED');
    assert.equal(f.procurement.list().length, 0); assert.equal(f.labels.list().length, 0); assert.deepEqual(delta(f.counts, before), zero());
  }
});
