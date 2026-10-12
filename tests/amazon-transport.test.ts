import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import type { AmazonDraft, JsonObject } from '../src/shared/amazon-contracts.ts';

const implementation = await import('../src/main/amazon/service.ts').catch(() => null);
const secretStorage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(Buffer.from(s).map(b => b ^ 0xa5)), decryptString: (b: Buffer) => Buffer.from(b.map(v => v ^ 0xa5)).toString() };
const creds = { name: 'Fake network test', sellerId: 'SELLER_WITH_SPACE', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en_US',
  clientId: 'secret_client_id', clientSecret: 'secret_client_password', refreshToken: 'secret_refresh_token' };
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'request-test-1', ...headers } });
type Hook = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
function fixture(t: test.TestContext) {
  assert.ok(implementation?.AmazonService, 'AmazonService must be implemented');
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(join(parent, 'amazon-network-'));
  const store = new WorkspaceStore(directory); let product = store.createProduct(); product = store.saveProduct({ id: product.id, revision: product.revision, title: 'Known source title', sourceUrl: product.sourceUrl,
    description: product.description, status: product.status, facts: product.facts, variants: product.variants.map(({ id, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku: 'A / 中文?#', originalSpec, normalizedSpec, purchasePrice, inventory })) });
  let now = Date.parse('2026-01-01T00:00:00Z'); let hook: Hook = () => undefined; let version = 'v1'; let badChecksum = false;
  const requests: { url: URL; init: RequestInit }[] = []; const delays: number[] = [];
  const schema: JsonObject = { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object', properties: { item_name: { type: 'string', minLength: 1 } }, required: ['item_name'], additionalProperties: false };
  const meta = { $id: 'https://schemas.amazon.com/selling-partners/definitions/product-types/meta-schema/v1', $schema: 'https://json-schema.org/draft/2019-09/schema', type: ['object', 'boolean'] };
  const links = (kind: string, data: unknown) => ({ link: { resource: `https://htc-test.s3.amazonaws.com/${kind}.json`, verb: 'GET' }, checksum: badChecksum ? 'AAAAAAAAAAAAAAAAAAAAAA==' : createHash('md5').update(JSON.stringify(data)).digest('base64') });
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); requests.push({ url, init }); const override = await hook(url, init); if (override) return override;
    if (url.hostname === 'api.amazon.com') return json({ access_token: 'secret_access_token', token_type: 'bearer', expires_in: 3600 });
    if (url.hostname.endsWith('.s3.amazonaws.com')) return json(url.pathname === '/meta.json' ? meta : schema);
    if (url.pathname.endsWith('/productTypes')) return json({ productTypes: [{ name: 'STORAGE_BAG', displayName: 'Storage bag', marketplaceIds: ['ATVPDKIKX0DER'] }] });
    if (url.pathname.includes('/productTypes/')) return json({ marketplaceIds: ['ATVPDKIKX0DER'], productType: 'STORAGE_BAG', locale: url.searchParams.get('locale'), requirements: url.searchParams.get('requirements'), requirementsEnforced: 'ENFORCED', productTypeVersion: { version }, propertyGroups: { general: { title: 'General', propertyNames: ['item_name'] } }, schema: links('schema', schema), metaSchema: links('meta', meta) });
    if (init.method === 'PUT') return json({ sku: product.variants[0].sku, status: url.searchParams.has('mode') ? 'VALID' : 'ACCEPTED', submissionId: 'submit-1', issues: [] });
    if (url.pathname.includes('/listings/')) return json({ sku: product.variants[0].sku, summaries: [{ marketplaceId: 'ATVPDKIKX0DER', status: ['DISCOVERABLE'] }], issues: [] });
    throw new Error('Unexpected test endpoint');
  };
  const dependencies = { fetch: fetcher, sleep: async (ms: number) => { delays.push(ms); now += ms; }, now: () => now, random: () => 0,
    resolveAddresses: async () => ['52.0.0.1'], timeoutMs: 100 };
  let service = new implementation.AmazonService(directory, id => store.getProduct(id), secretStorage, dependencies);
  t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, product, requests, delays, schema, advance(ms: number) { now += ms; }, get service() { return service; }, hook(fn: Hook) { hook = fn; }, changeVersion(v: string) { version = v; }, corruptChecksum() { badChecksum = true; },
    reopen() { service.close(); service = new implementation!.AmazonService(directory, id => store.getProduct(id), secretStorage, dependencies); return service; } };
}
async function draft(f: ReturnType<typeof fixture>) {
  const target = await f.service.importCredentials(creds);
  return f.service.createDraft({ targetId: target.id, productId: f.product.id, variantId: f.product.variants[0].id, productType: 'STORAGE_BAG', requirements: 'LISTING', parentageLevel: 'NONE', locale: 'en_US' });
}
async function preview(f: ReturnType<typeof fixture>): Promise<AmazonDraft> { return f.service.previewDraft(await draft(f)); }

test('digit-leading Amazon product types work in full index, keyword search, selection and schema transport', async t => {
  const f = fixture(t), target = await f.service.importCredentials(creds);
  const types = ['3D_PRINTABLE_DESIGNS', '3D_PRINTED_PRODUCT', '3D_PRINTER'].map(name => ({ name, displayName: name, marketplaceIds: [target.marketplaceId] }));
  f.hook(url => {
    if (url.pathname.endsWith('/productTypes')) return json({ productTypes: types });
    if (url.pathname.endsWith('/productTypes/3D_PRINTER')) return json({ marketplaceIds: [target.marketplaceId], productType: '3D_PRINTER', locale: 'en_US', requirements: 'LISTING', requirementsEnforced: 'ENFORCED', productTypeVersion: { version: 'v1' },
      schema: { link: { resource: 'https://htc-test.s3.amazonaws.com/schema.json', verb: 'GET' }, checksum: createHash('md5').update(JSON.stringify(f.schema)).digest('base64') } });
  });
  assert.equal((await f.service.fetchProductTypeLibrary(target.id)).length, 3);
  assert.equal((await f.service.searchProductTypes({ targetId: target.id, keywords: '3D printer' })).length, 3);
  const selected = { targetId: target.id, productType: '3D_PRINTER', requirements: 'LISTING', parentageLevel: 'NONE', locale: 'en_US' };
  assert.equal((await f.service.getSchema(selected)).productType, '3D_PRINTER');
  const count = f.requests.length;
  for (const productType of ['../3D_PRINTER','3D_PRINTER/OTHER','3D_PRINTER?x=1','3d_printer']) await assert.rejects(f.service.getSchema({ ...selected, productType }));
  assert.equal(f.requests.length, count);
});

test('restored old observations cannot bypass a retained global unknown SKU write lock', async t => {
  const f = fixture(t), submitted = await f.service.submitDraft(await preview(f), true), read = await f.service.readListing(submitted);
  assert.ok(f.service.getListingObservation(read.id));
  const { openDatabase } = await import('../src/main/database.ts');
  const { listingHash } = await import('../src/main/amazon/context.ts');
  const db = openDatabase(f.directory);
  try {
    for (const state of ['UNKNOWN','SUBMITTING']) {
      db.prepare('INSERT OR REPLACE INTO amazon_write_locks(listing_hash,draft_id,state,created_at) VALUES(?,?,?,?)').run(listingHash(read, read.sku), 'a-later-lost-draft', state, new Date().toISOString());
      assert.equal(f.service.getListingObservation(read.id), null);
    }
  } finally { db.close(); }
});

test('full product type index omits keywords and retains more than the search result limit', async t => {
  const f = fixture(t), target = await f.service.importCredentials(creds);
  f.hook(url => url.pathname.endsWith('/productTypes') ? json({ productTypes: Array.from({ length: 150 }, (_, i) => ({ name: `TYPE_${i}`, displayName: `Type ${i}`, marketplaceIds: [target.marketplaceId] })) }) : undefined);
  assert.equal((await f.service.fetchProductTypeLibrary(target.id)).length, 150);
  const request = f.requests.find(item => item.url.pathname.endsWith('/productTypes'))!;
  assert.equal(request.url.searchParams.has('keywords'), false);
  assert.equal(request.url.searchParams.get('marketplaceIds'), target.marketplaceId);
  f.hook(url => url.pathname.endsWith('/productTypes') ? json({ productTypes: [{ name: 'WRONG_SITE', displayName: 'Wrong', marketplaceIds: ['WRONG'] }] }) : undefined);
  await assert.rejects(f.service.fetchProductTypeLibrary(target.id));
});

test('listing observation exposes only matched ASIN and FNSKU; queued read guards stop before sending', async t => {
  const f = fixture(t), prepared = await preview(f), submitted = await f.service.submitDraft(prepared, true);
  assert.equal(f.service.getListingObservation(submitted.id), null);
  const before = f.requests.length;
  await assert.rejects(f.service.readListing(submitted, () => { throw new Error('paused before send'); }));
  assert.equal(f.requests.length, before);
  f.hook(url => url.pathname.includes('/listings/') ? json({ sku: submitted.sku, summaries: [{ marketplaceId: submitted.marketplaceId, asin: 'B012345678', fnSku: 'X012345678', status: [] }], issues: [] }) : undefined);
  const read = await f.service.readListing(submitted), observation = f.service.getListingObservation(read.id)!;
  assert.equal(observation.asin, 'B012345678'); assert.equal(observation.fnsku, 'X012345678');
  assert.equal(observation.checkedAt, read.checkedAt); assert.equal('attributes' in observation, false);
  f.hook(url => url.pathname.includes('/listings/') ? json({ sku: submitted.sku, summaries: [{ marketplaceId: 'WRONG', asin: 'B012345678', status: [] }], issues: [] }) : undefined);
  await f.service.readListing(read); assert.equal(f.service.getListingObservation(read.id), null);
});

test('official paths encode SKU, preview mode is explicit and public schemas receive no credentials', async t => {
  const f = fixture(t); const d = await preview(f);
  assert.equal(d.state, 'AMAZON_VALIDATED');
  const ptd = f.requests.find(r => r.url.pathname.includes('/productTypes/STORAGE_BAG'))!;
  assert.equal(ptd.url.searchParams.get('sellerId'), creds.sellerId); assert.equal(ptd.url.searchParams.get('marketplaceIds'), creds.marketplaceId);
  assert.equal(ptd.url.searchParams.get('requirementsEnforced'), 'ENFORCED'); assert.equal(ptd.url.searchParams.get('parentageLevel'), 'NONE');
  const put = f.requests.find(r => r.init.method === 'PUT')!; assert.equal(put.url.searchParams.get('mode'), 'VALIDATION_PREVIEW');
  assert.ok(put.url.pathname.endsWith(encodeURIComponent(f.product.variants[0].sku))); assert.equal(JSON.parse(String(put.init.body)).requirements, 'LISTING');
  const headers = new Headers(put.init.headers); assert.equal(headers.get('x-amz-access-token'), 'secret_access_token'); assert.ok(headers.get('user-agent')); assert.ok(headers.get('x-amz-date'));
  for (const request of f.requests.filter(r => r.url.hostname.endsWith('.s3.amazonaws.com'))) {
    assert.equal(new Headers(request.init.headers).get('x-amz-access-token'), null); assert.equal(new Headers(request.init.headers).get('authorization'), null); assert.equal(request.init.redirect, 'manual');
  }
});

test('HTTP 200 preview is insufficient unless status is VALID with no ERROR issues', async t => {
  const f = fixture(t); const d = await draft(f); f.hook((url, init) => init.method === 'PUT' && url.searchParams.has('mode') ? json({ status: 'ACCEPTED', issues: [] }) : undefined);
  let result = await f.service.previewDraft(d); assert.equal(result.state, 'BLOCKED'); assert.equal(result.previewedAt, null);
  f.hook((url, init) => init.method === 'PUT' && url.searchParams.has('mode') ? json({ status: 'VALID', issues: [{ code: '123', severity: 'ERROR', message: 'Missing approval', categories: ['QUALIFICATION_REQUIRED'] }] }) : undefined);
  result = await f.service.previewDraft(d); assert.equal(result.state, 'BLOCKED'); assert.equal(result.previewIssues[0].category, 'qualification');
  await assert.rejects(f.service.submitDraft(result, true), /预览/);
});

test('changing current PTD version blocks the formal PUT even after successful preview', async t => {
  const f = fixture(t); const d = await preview(f); f.changeVersion('v2');
  await assert.rejects(f.service.submitDraft(d, true), /Schema|规则/);
  assert.equal(f.requests.filter(r => r.init.method === 'PUT' && !r.url.searchParams.has('mode')).length, 0);
});

test('a formal 5xx PUT is never replayed and UNKNOWN survives restart and readback across drafts', async t => {
  const f = fixture(t); const d = await preview(f);
  f.hook((url, init) => init.method === 'PUT' && !url.searchParams.has('mode') ? json({ message: 'secret_refresh_token' }, 503) : undefined);
  const result = await f.service.submitDraft(d, true); assert.equal(result.state, 'UNKNOWN');
  assert.equal(f.requests.filter(r => r.init.method === 'PUT' && !r.url.searchParams.has('mode')).length, 1);
  await assert.rejects(f.service.submitDraft(result, true), /未知|回读|未确认/);
  f.reopen(); assert.equal(f.service.getDraft(d.id).state, 'UNKNOWN');
  const read = await f.service.readListing(result); assert.equal(read.state, 'UNKNOWN'); assert.deepEqual(read.statuses, ['DISCOVERABLE']);
  await assert.rejects(f.service.createDraft({ ...d.schema, productId: d.productId, variantId: d.variantId }), /未知|回读|未确认/);
  assert.throws(() => f.service.saveDraft({ ...read, attributes: d.attributes }), /未知|回读|未确认/);
  assert.equal(f.requests.filter(r => r.init.method === 'PUT' && !r.url.searchParams.has('mode')).length, 1);
});

test('network failure after a PUT and interrupted SUBMITTING are persisted as UNKNOWN', async t => {
  const f = fixture(t); const d = await preview(f);
  f.hook((url, init) => { if (init.method === 'PUT' && !url.searchParams.has('mode')) throw new Error('secret_refresh_token in unsafe upstream error'); return undefined; });
  const result = await f.service.submitDraft(d, true); assert.equal(result.state, 'UNKNOWN'); assert.ok(!JSON.stringify(result).includes('secret_'));
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try { db.prepare("UPDATE listing_drafts SET state='SUBMITTING' WHERE id=?").run(d.id); } finally { db.close(); }
  f.reopen(); assert.equal(f.service.getDraft(d.id).state, 'UNKNOWN');
});

test('concurrent submission sends a formal PUT once; accepted rows retain independent status flags', async t => {
  const f = fixture(t); const d = await preview(f);
  const results = await Promise.allSettled([f.service.submitDraft(d, true), f.service.submitDraft(d, true)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.requests.filter(r => r.init.method === 'PUT' && !r.url.searchParams.has('mode')).length, 1);
  const submitted = f.service.getDraft(d.id); assert.equal(submitted.state, 'SUBMITTED');
  const read = await f.service.readListing(submitted); assert.equal(read.state, 'DISCOVERABLE'); assert.deepEqual(read.statuses, ['DISCOVERABLE']);
});

test('reads retry at most three times, honor Retry-After and rate, then pause on repeated 429', async t => {
  const f = fixture(t); const target = await f.service.importCredentials(creds);
  f.hook(url => url.pathname.endsWith('/productTypes') ? json({}, 429, { 'retry-after': '2', 'x-amzn-ratelimit-limit': '0.5' }) : undefined);
  await assert.rejects(f.service.searchProductTypes({ targetId: target.id, keywords: 'bag' }), /限流|暂停/);
  assert.equal(f.requests.filter(r => r.url.pathname.endsWith('/productTypes')).length, 3);
  assert.ok(f.delays.filter(ms => ms >= 2000).length >= 2); assert.equal(f.service.getTarget(target.id).paused, true);
  const count = f.requests.length; await assert.rejects(f.service.searchProductTypes({ targetId: target.id, keywords: 'bag' }), /暂停/); assert.equal(f.requests.length, count);
  const event = f.service.listCalls().find(call => call.operation === 'searchDefinitionsProductTypes')!; assert.equal(event.retries, 2); assert.equal(event.status, 429); assert.equal(event.rateLimit, '0.5');
});

test('401 and 403 pause immediately without refreshing or retrying the operation', async t => {
  for (const status of [401, 403]) {
    const f = fixture(t); const target = await f.service.importCredentials(creds);
    f.hook(url => url.pathname.endsWith('/productTypes') ? json({ message: 'secret_refresh_token' }, status) : undefined);
    await assert.rejects(f.service.searchProductTypes({ targetId: target.id, keywords: 'bag' }), /授权|暂停/);
    assert.equal(f.service.getTarget(target.id).paused, true); assert.equal(f.requests.filter(r => r.url.pathname.endsWith('/productTypes')).length, 1);
    assert.equal(f.requests.filter(r => r.url.hostname === 'api.amazon.com').length, 1);
    assert.ok(!JSON.stringify([f.service.listTargets(), f.service.listCalls()]).includes('secret_'));
  }
});

test('schema checksum corruption, redirects and untrusted hosts fail closed', async t => {
  const f = fixture(t); const target = await f.service.importCredentials(creds); const input = { targetId: target.id, productType: 'STORAGE_BAG', requirements: 'LISTING' as const, parentageLevel: 'NONE' as const, locale: 'en_US', forceRefresh: true };
  f.corruptChecksum(); await assert.rejects(f.service.getSchema(input), /校验|checksum|Schema/);
  f.hook(url => url.hostname.endsWith('.s3.amazonaws.com') ? new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } }) : undefined);
  await assert.rejects(f.service.getSchema(input), /重定向|Schema/);
  f.hook(url => url.pathname.includes('/productTypes/') ? json({ marketplaceIds: [creds.marketplaceId], productType: 'STORAGE_BAG', locale: 'en_US', requirements: 'LISTING', requirementsEnforced: 'ENFORCED', productTypeVersion: { version: 'x' }, schema: { link: { resource: 'https://127.0.0.1/schema', verb: 'GET' }, checksum: 'AAAAAAAAAAAAAAAAAAAAAA==' } }) : undefined);
  await assert.rejects(f.service.getSchema(input), /可信|地址|Schema/);
  assert.ok(!f.requests.some(r => r.url.hostname === '127.0.0.1'));
});

test('credential rotation invalidates previews and errors cannot leak secrets to DB or renderer', async t => {
  const f = fixture(t); const d = await preview(f); await f.service.importCredentials({ ...creds, refreshToken: 'secret_rotated_refresh_token' });
  await assert.rejects(f.service.submitDraft(d, true), /预览|授权/);
  f.hook(url => url.pathname.endsWith('/productTypes') ? json({ errors: [{ message: 'secret_refresh_token secret_client_password' }] }, 400) : undefined);
  await assert.rejects(f.service.searchProductTypes({ targetId: d.targetId, keywords: 'bag' }), error => !String(error).includes('secret_'));
  assert.ok(!JSON.stringify([f.service.getDraft(d.id), f.service.listCalls(), f.service.listTargets()]).includes('secret_'));
  for (const name of readdirSync(f.directory).filter(name => name.startsWith('red.sqlite'))) assert.ok(!readFileSync(join(f.directory, name)).includes(Buffer.from('secret_')));
});

test('official successful preview may omit optional issues but must echo the selected SKU', async t => {
  const f = fixture(t); const d = await draft(f);
  f.hook((url, init) => init.method === 'PUT' && url.searchParams.has('mode') ? json({ sku: d.sku, status: 'VALID', submissionId: 'preview-id' }) : undefined);
  const valid = await f.service.previewDraft(d); assert.equal(valid.state, 'AMAZON_VALIDATED');
  f.hook((url, init) => init.method === 'PUT' && url.searchParams.has('mode') ? json({ sku: 'ANOTHER_SKU', status: 'VALID', submissionId: 'preview-id', issues: [] }) : undefined);
  assert.equal((await f.service.previewDraft(d)).state, 'BLOCKED');
});

test('formal acceptance with a mismatched SKU remains UNKNOWN and is never replayed', async t => {
  const f = fixture(t); const d = await preview(f);
  f.hook((url, init) => init.method === 'PUT' && !url.searchParams.has('mode') ? json({ sku: 'ANOTHER_SKU', status: 'ACCEPTED', submissionId: 'submit-other', issues: [] }) : undefined);
  assert.equal((await f.service.submitDraft(d, true)).state, 'UNKNOWN');
});

test('preview freshness is checked again after access-token renewal immediately before PUT', async t => {
  const f = fixture(t);
  f.hook(url => url.hostname === 'api.amazon.com' ? json({ access_token: 'secret_access_token', token_type: 'bearer', expires_in: 65 }) : undefined);
  const d = await preview(f); f.advance(14 * 60_000);
  let renewals = 0;
  f.hook(url => { if (url.hostname === 'api.amazon.com') { if (++renewals === 2) f.advance(60_000); return json({ access_token: 'secret_access_token', token_type: 'bearer', expires_in: 65 }); }
    if (url.hostname.endsWith('.s3.amazonaws.com')) f.advance(8000); return undefined; });
  await assert.rejects(f.service.submitDraft(d, true), /过期|预览/);
  assert.equal(f.requests.filter(r => r.init.method === 'PUT' && !r.url.searchParams.has('mode')).length, 0);
});

test('uncertain write tombstone survives retention after raw draft deletion', async t => {
  const f = fixture(t); const d = await preview(f);
  f.hook((url, init) => init.method === 'PUT' && !url.searchParams.has('mode') ? json({}, 503) : undefined);
  await f.service.submitDraft(d, true); f.service.saveDataPolicy({ retentionDays: 1 }); f.advance(2 * 86_400_000); f.service.cleanupData();
  assert.equal(f.service.listDrafts(d.productId).length, 0); f.reopen();
  await assert.rejects(f.service.createDraft({ ...d.schema, productId: d.productId, variantId: d.variantId }), /未知|未确认|回读/);
});

test('a hanging formal fetch is bounded and never retried', async t => {
  const f = fixture(t); const d = await preview(f);
  f.hook((url, init) => init.method === 'PUT' && !url.searchParams.has('mode') ? new Promise<Response>(() => {}) : undefined);
  const result = await f.service.submitDraft(d, true); assert.equal(result.state, 'UNKNOWN');
  assert.equal(f.requests.filter(r => r.init.method === 'PUT' && !r.url.searchParams.has('mode')).length, 1);
});

test('live caches separate seller identity and schema context', async t => {
  const f = fixture(t); const a = await draft(f); const initial = a.schema;
  const other = await f.service.importCredentials({ ...creds, sellerId: 'ANOTHER_SELLER' });
  const b = await f.service.getSchema({ ...initial, targetId: other.id });
  assert.notEqual(initial.key, b.key); assert.equal(b.fromCache, false);
  assert.equal((await f.service.getSchema({ ...initial, targetId: other.id })).fromCache, true);
  const locale = await f.service.getSchema({ ...initial, targetId: other.id, locale: 'zh_CN' }); assert.notEqual(b.key, locale.key);
});

test('a failed credential metadata transaction restores the previous encrypted authorization', async t => {
  const f = fixture(t); const d = await preview(f); const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  db.exec(`CREATE TRIGGER reject_test_rotation BEFORE UPDATE ON amazon_targets WHEN json_extract(NEW.target_json,'$.name')='FAIL_ROTATION' BEGIN SELECT RAISE(ABORT,'simulated metadata failure'); END`);
  try { await assert.rejects(f.service.importCredentials({ ...creds, name: 'FAIL_ROTATION', clientSecret: 'secret_invalid_rotation' })); }
  finally { db.exec('DROP TRIGGER reject_test_rotation'); db.close(); }
  f.reopen(); f.hook((url, init) => url.hostname === 'api.amazon.com' && String(init.body).includes('secret_invalid_rotation') ? json({}, 401) : undefined);
  const types = await f.service.searchProductTypes({ targetId: d.targetId, keywords: 'bag' }); assert.equal(types[0].name, 'STORAGE_BAG');
});

test('saving and repeating preview retains prior raw requests and responses outside the renderer contract', async t => {
  const f = fixture(t); let d = await preview(f); const originalAttributes = d.attributes;
  d = f.service.saveDraft({ ...d, attributes: { item_name: 'Edited listing title' } }); d = await f.service.previewDraft(d);
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try {
    const stored = JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(d.id)!.record_json));
    assert.ok(Array.isArray(stored.exchanges), 'Historical exchanges must be stored separately');
    const previews = stored.exchanges.filter((entry: { operation: string }) => entry.operation === 'preview');
    assert.equal(previews.length, 2); assert.deepEqual(previews[0].request.attributes, originalAttributes);
    assert.equal(previews[0].response.status, 'VALID'); assert.equal(previews[0].schemaChecksum, d.schema.checksum);
    assert.equal(previews[1].request.attributes.item_name, 'Edited listing title');
    assert.equal((f.service.getDraft(d.id) as unknown as Record<string, unknown>).exchanges, undefined);
  } finally { db.close(); }
});

test('formal HTTP error body is retained with secret keys and values redacted', async t => {
  const f = fixture(t); const d = await preview(f);
  f.hook((url, init) => init.method === 'PUT' && !url.searchParams.has('mode') ? json({ errors: [{ code: 'InvalidInput', message: 'secret_refresh_token' }], secret_client_password: 'secret_client_id' }, 400) : undefined);
  await assert.rejects(f.service.submitDraft(d, true), /400/);
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try {
    const body = String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(d.id)!.record_json);
    assert.ok(!body.includes('secret_'));
    const record = JSON.parse(body); const response = record.exchanges.findLast((entry: { operation: string }) => entry.operation === 'submit').response;
    assert.equal(response.errors[0].code, 'InvalidInput'); assert.equal(response.errors[0].message, '[REDACTED]');
    assert.equal(record.exchanges.findLast((entry: { operation: string }) => entry.operation === 'submit').status, 400);
  } finally { db.close(); }
});

test('known secret pasted as an attributes key is rejected before persistence', async t => {
  const f = fixture(t); const d = await draft(f);
  assert.throws(() => f.service.saveDraft({ ...d, attributes: { ...d.attributes, [creds.clientSecret]: 'accidental key' } }), /授权|令牌|敏感/);
  assert.ok(!JSON.stringify(f.service.getDraft(d.id)).includes(creds.clientSecret));
});

test('dot-segment SKU is rejected before token exchange or API access', async t => {
  const f = fixture(t); const target = await f.service.importCredentials(creds);
  const product = f.store.getProduct(f.product.id); f.store.saveProduct({ id: product.id, revision: product.revision, title: product.title, sourceUrl: product.sourceUrl, description: product.description, status: product.status, facts: product.facts,
    variants: product.variants.map(({ id, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku: '..', originalSpec, normalizedSpec, purchasePrice, inventory })) });
  await assert.rejects(f.service.createDraft({ targetId: target.id, productId: product.id, variantId: product.variants[0].id, productType: 'STORAGE_BAG', requirements: 'LISTING', parentageLevel: 'NONE', locale: 'en_US' }), /SKU|路径/);
  assert.equal(f.requests.length, 0);
});

test('known secret echoed in request-id metadata never reaches records or renderer', async t => {
  const f = fixture(t); const d = await draft(f);
  f.hook((url, init) => init.method === 'PUT' && url.searchParams.has('mode') ? json({ sku: d.sku, status: 'VALID', submissionId: 'preview-id', issues: [] }, 200, { 'x-amzn-requestid': creds.clientSecret }) : undefined);
  const result = await f.service.previewDraft(d);
  assert.ok(!JSON.stringify([result, f.service.listCalls()]).includes(creds.clientSecret));
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try { assert.ok(!String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(d.id)!.record_json).includes(creds.clientSecret)); }
  finally { db.close(); }
});

test('preview proof and immutable raw history commit atomically', async t => {
  const f = fixture(t); const d = await draft(f); const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  db.exec(`CREATE TRIGGER reject_test_exchange BEFORE INSERT ON amazon_exchanges BEGIN SELECT RAISE(ABORT,'simulated exchange persistence failure'); END`);
  try { await assert.rejects(f.service.previewDraft(d)); assert.notEqual(f.service.getDraft(d.id).state, 'AMAZON_VALIDATED'); assert.equal(f.service.getDraft(d.id).previewedAt, null); }
  finally { db.exec('DROP TRIGGER reject_test_exchange'); db.close(); }
});

test('preview and formal PUT share the Listings Items rate window', async t => {
  const f = fixture(t); const d = await draft(f);
  f.hook((url, init) => init.method === 'PUT' && url.searchParams.has('mode') ? json({ sku: d.sku, status: 'VALID', submissionId: 'preview-id', issues: [] }, 200, { 'x-amzn-ratelimit-limit': '0.5' }) : undefined);
  const validated = await f.service.previewDraft(d); await f.service.submitDraft(validated, true);
  assert.ok(f.delays.some(ms => ms >= 2000), 'Formal PUT must respect the prior preview rate header for the same operation');
});

test('known 401 and 403 statuses survive oversized or stalled bodies without retries', async t => {
  for (const status of [401, 403]) for (const stalled of [false, true]) {
    const f = fixture(t); const target = await f.service.importCredentials(creds);
    f.hook(url => url.pathname.endsWith('/productTypes') ? new Response(stalled ? new ReadableStream() : '{}', { status, headers: stalled ? {} : { 'content-length': '2097153' } }) : undefined);
    await assert.rejects(f.service.searchProductTypes({ targetId: target.id, keywords: 'bag' }), error => !!error && typeof error === 'object' && 'status' in error && error.status === status);
    assert.equal(f.service.getTarget(target.id).paused, true); assert.equal(f.requests.filter(r => r.url.pathname.endsWith('/productTypes')).length, 1);
  }
});

test('readback retries a truncated successful response once and preserves the received status',async t=>{
  const f=fixture(t),d=await f.service.submitDraft(await preview(f),true);let reads=0;
  f.hook((url,init)=>{
    if(!url.pathname.includes('/listings/')||init.method!=='GET')return undefined;
    if(++reads===1)return new Response(new ReadableStream({start(controller){controller.error(new Error('body interrupted'));}}),{status:200,headers:{'x-amzn-requestid':'read-interrupted'}});
    return undefined;
  });
  const result=await f.service.readListing(d);
  assert.equal(result.state,'DISCOVERABLE');assert.equal(reads,2);
  const call=f.service.listCalls().find(call=>call.operation==='getListingsItem');assert.equal(call?.status,200);assert.equal(call?.retries,1);
});

test('readback body failures are bounded and identified separately from invalid JSON',async t=>{
  const f=fixture(t),d=await f.service.submitDraft(await preview(f),true);let reads=0;
  f.hook((url,init)=>{
    if(!url.pathname.includes('/listings/')||init.method!=='GET')return undefined;
    reads++;return new Response(new ReadableStream({start(controller){controller.error(new Error('body interrupted'));}}),{status:200,headers:{'x-amzn-requestid':'read-interrupted'}});
  });
  await assert.rejects(f.service.readListing(d),/响应正文.*读取|读取.*响应正文/);assert.equal(reads,3);
  assert.equal(f.service.getDraft(d.id).state,'SUBMITTED');
});

test('oversized read responses and interrupted formal submissions are never replayed',async t=>{
  const f=fixture(t),d=await f.service.submitDraft(await preview(f),true);let reads=0;
  f.hook((url,init)=>{
    if(!url.pathname.includes('/listings/')||init.method!=='GET')return undefined;
    reads++;return new Response('{}',{status:200,headers:{'content-length':'2097153'}});
  });
  await assert.rejects(f.service.readListing(d),/响应正文.*大小|响应超过/);assert.equal(reads,1);
  const second=fixture(t),draft=await preview(second);let writes=0;
  second.hook((url,init)=>{
    if(init.method!=='PUT'||url.searchParams.has('mode'))return undefined;
    writes++;return new Response(new ReadableStream({start(controller){controller.error(new Error('body interrupted'));}}),{status:200});
  });
  const result=await second.service.submitDraft(draft,true);assert.equal(result.state,'UNKNOWN');assert.equal(writes,1);
});

test('received preview is archived even when source changes during the request', async t => {
  const f = fixture(t); const d = await draft(f);
  f.hook((url, init) => {
    if (init.method !== 'PUT' || !url.searchParams.has('mode')) return undefined;
    const product = f.store.getProduct(f.product.id); f.store.saveProduct({ id: product.id, revision: product.revision, title: 'Changed during preview', sourceUrl: product.sourceUrl, description: product.description, status: product.status, facts: product.facts,
      variants: product.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })) });
    return json({ sku: d.sku, status: 'VALID', submissionId: 'preview-during-change', issues: [] });
  });
  await assert.rejects(f.service.previewDraft(d), /来源商品/); const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try { const rows = db.prepare('SELECT exchange_json FROM amazon_exchanges WHERE draft_id=?').all(d.id); assert.equal(rows.length, 1); assert.equal(JSON.parse(String(rows[0].exchange_json)).response.submissionId, 'preview-during-change'); }
  finally { db.close(); }
  assert.equal(f.service.getDraft(d.id).previewedAt, null); assert.equal(f.service.getDraft(d.id).state, 'BLOCKED');
});

test('a mismatched readback response is archived without accepting it as current listing state', async t => {
  const f = fixture(t); const d = await f.service.submitDraft(await preview(f), true);
  f.hook((url, init) => url.pathname.includes('/listings/') && init.method === 'GET' ? json({ sku: 'ANOTHER_SKU', summaries: [], issues: [] }) : undefined);
  await assert.rejects(f.service.readListing(d), /SKU|不匹配/); const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try { const rows = db.prepare("SELECT exchange_json FROM amazon_exchanges WHERE draft_id=? AND json_extract(exchange_json,'$.operation')='readback'").all(d.id); assert.equal(rows.length, 1); assert.equal(JSON.parse(String(rows[0].exchange_json)).response.sku, 'ANOTHER_SKU'); }
  finally { db.close(); }
  assert.deepEqual(f.service.getDraft(d.id).statuses, []);
});

test('live pre-submit readback rejects before token refresh or network access', async t => {
  const f = fixture(t); const d = await draft(f); f.advance(2 * 60 * 60_000); const count = f.requests.length;
  await assert.rejects(f.service.readListing(d), /提交|回读/);
  assert.equal(f.requests.length, count); assert.equal(f.service.getDraft(d.id).state, 'DRAFT');
});

test('Schema body read exhaustion is typed with validated selection and no signed URL', async t => {
  const f=fixture(t),target=await f.service.importCredentials(creds);
  const selected={targetId:target.id,productType:'STORAGE_BAG',requirements:'LISTING',parentageLevel:'NONE',locale:'en_US'};
  f.hook(url=>url.hostname.endsWith('.s3.amazonaws.com')?new Response(new ReadableStream({start(controller){controller.error(new Error('broken body'));}}),{status:200}):undefined);
  await assert.rejects(f.service.getSchema(selected),error=>{
    assert.equal((error as any).name,'SchemaTransientError');
    assert.deepEqual((error as any).selection,selected);
    assert.equal(JSON.stringify(error).includes('s3.amazonaws.com'),false);return true;
  });
  assert.equal(f.requests.filter(r=>r.url.hostname.endsWith('.s3.amazonaws.com')).length,3);
});

for(const failure of ['checksum','redirect','unauthorized','json'] as const)test(`permanent Schema ${failure} never becomes a delayed transient`,async t=>{
  const {SchemaTransientError}=await import('../src/main/amazon/schema-retry.ts');
  const f=fixture(t),target=await f.service.importCredentials(creds),selected={targetId:target.id,productType:'STORAGE_BAG',requirements:'LISTING',parentageLevel:'NONE',locale:'en_US'};
  if(failure==='checksum')f.corruptChecksum();
  else f.hook(url=>url.hostname.endsWith('.s3.amazonaws.com')?failure==='redirect'?new Response('',{status:302,headers:{location:'https://example.test'}}):failure==='unauthorized'?new Response('',{status:403}):new Response('broken JSON',{status:200}):undefined);
  await assert.rejects(f.service.getSchema(selected),e=>!(e instanceof SchemaTransientError));
});
