import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AmazonDraft, AmazonTarget, JsonObject } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import type { ProductDataSnapshot } from '../src/shared/product-data-contracts.ts';
import { acceptedSkuFromRecord } from '../src/main/product-data/accepted-skus.ts';

const implementation = await import('../src/main/product-data/service.ts').catch(() => null);
const NOW = Date.parse('2026-10-07T10:15:00.000Z');
type Kind = 'listings' | 'inventory' | 'sales';
interface Call { kind: Kind; query: Record<string, string> }
function product(id: string, sku: string, origin: ProductDetail['origin'] = 'manual'): ProductDetail {
  return { id, title: `Local ${id}`, sourceUrl: '', description: '', status: 'ready', origin, revision: 1,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', facts: [], assets: [],
    variants: [{ id: `${id}-variant`, sku, originalSpec: '', normalizedSpec: '', purchasePrice: '', inventory: null, sourceSpec: '', sourcePurchasePrice: '' }] };
}
function draft(p: ProductDetail, patch: Partial<AmazonDraft> = {}): AmazonDraft {
  return { id: `draft-${p.id}`, productId: p.id, variantId: p.variants[0].id, productRevision: 1, sku: p.variants[0].sku,
    listingProgram: 'haul', targetId: 'target', targetName: 'Live', sellerId: 'seller', marketplaceId: 'market', mode: 'live',
    revision: 1, schema: { targetId: 'target', productType: 'ITEM', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US',
      key: 'schema', mode: 'live', schema: {}, metaSchema: {}, checksum: '', version: '', propertyGroups: {}, fetchedAt: '', expiresAt: '', fromCache: false },
    attributes: {}, state: 'SUBMITTED', localIssues: [], previewIssues: [], listingIssues: [], statuses: [], submissionId: 'accepted', requestId: null,
    previewedAt: null, submittedAt: '2026-10-01T12:00:00.000Z', checkedAt: null, createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z', events: [], ...patch };
}
function daily(interval: string, count = 1): JsonObject {
  const [from, to] = interval.split('--').map(Date.parse); const payload: JsonObject[] = [];
  for (let at = from; at < to;) {
    const day = new Date(at); day.setUTCHours(0, 0, 0, 0); const end = Math.min(day.getTime() + 86_400_000, to);
    payload.push({ interval: `${new Date(at).toISOString()}--${new Date(end).toISOString()}`, unitCount: count }); at = end;
  }
  return { payload };
}
function fixture(t: test.TestContext, values: ProductDetail[] = [product('p', 'NEW-SKU')]) {
  assert.ok(implementation?.ProductDataService, 'ProductDataService must be implemented');
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(join(parent, 'product-data-'));
  let now = NOW; let generation = 1;
  let target: AmazonTarget = { id: 'target', name: 'Live', mode: 'live', sellerId: 'seller', marketplaceId: 'market', marketplaceName: 'US',
    region: 'na', locale: 'en_US', paused: false, configured: true, credentialUpdatedAt: '2026-10-01T00:00:00.000Z', lastError: null };
  const products = new Map(values.map(p => [p.id, p])); let drafts = values.map(p => draft(p)); const calls: Call[] = [];
  let handler: (call: Call) => JsonObject | Promise<JsonObject> = call => call.kind === 'listings' ? { items: [] }
    : call.kind === 'inventory' ? { payload: { granularity: { granularityType: 'Marketplace', granularityId: target.marketplaceId }, inventorySummaries: [] } }
    : daily(call.query.interval);
  const store = { listProducts: () => [...products.values()].map(p => ({ ...p, variantCount: p.variants.length, assetCount: 0, coverUrl: null })),
    getProduct: (id: string) => { const p = products.get(id); if (!p) throw new Error('missing'); return p; } };
  const amazon = { executionTargetScope: () => ({ target: structuredClone(target), generation }), listAcceptedSkus: () => drafts.flatMap(d => {
    const entry = acceptedSkuFromRecord({ draft: d, preview: null, request: {}, previewResponse: null, readResponse: null, unresolvedWrite: false,
      submitResponse: { status: 'ACCEPTED', sku: d.sku, submissionId: d.submissionId } }); return entry ? [entry] : [];
  }),
    readProductData: async (_targetId: string, kind: Kind, query: Record<string, string>) => {
      const call = { kind, query: structuredClone(query) }; calls.push(call); return { data: await handler(call), status: 200, requestId: 'test' };
    } };
  let service = new implementation.ProductDataService(directory, store, amazon, { now: () => now });
  t.after(() => { service.close(); const absolute = resolve(directory); assert.ok(absolute.startsWith(parent + '\\')); rmSync(absolute, { recursive: true, force: true }); });
  return { directory, products, calls, get service() { return service; }, get drafts() { return drafts; },
    setDrafts(next: AmazonDraft[]) { drafts = next; }, setHandler(next: typeof handler) { handler = next; },
    advance(ms: number) { now += ms; }, changeTarget(patch: Partial<AmazonTarget>, bump = true) { target = { ...target, ...patch }; if (bump) generation++; },
    reopen() { service.close(); service = new implementation!.ProductDataService(directory, store, amazon, { now: () => now }); return service; } };
}
async function done(f: ReturnType<typeof fixture>): Promise<ProductDataSnapshot> {
  for (let i = 0; i < 200; i++) { const result = f.service.get('target'); if (result.job.state !== 'running') return result; await new Promise<void>(r => setImmediate(r)); }
  throw new Error('Background job did not finish');
}
function listing(sku: string, marketplaceId = 'market'): JsonObject {
  return { sku, summaries: [{ marketplaceId, asin: 'B000000001', status: ['BUYABLE'], itemName: 'Remote title' }], issues: [] };
}

test('only accepted live local non-sample child SKUs are tracked, deduped from earliest accepted submission', t => {
  const p = product('p', 'NEW'); const pending = product('pending', 'PENDING'); const sample = product('sample', 'SAMPLE', 'sample');
  const parent = product('parent', 'PARENT'); const demo = product('demo', 'DEMO'); const other = product('other', 'OTHER');
  const f = fixture(t, [p, pending, sample, parent, demo, other]);
  f.setDrafts([draft(p, { id: 'later', submittedAt: '2026-10-03T10:00:00.000Z' }), draft(p), draft(p, { id: 'older', submittedAt: '2026-09-28T08:00:00.000Z' }),
    draft(pending, { submittedAt: null }), draft(sample), draft(parent, { schema: { ...draft(parent).schema, parentageLevel: 'PARENT' } }),
    draft(demo, { mode: 'demo' }), draft(other, { sellerId: 'previous-seller' }), draft(other, { marketplaceId: 'elsewhere' }),
    draft(other, { targetId: 'previous-target' }), draft(product('deleted', 'REMOTE-OLD'))]);
  const result = f.service.get('target'); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].sku, 'NEW');
  assert.equal(result.rows[0].salesSince, '2026-09-28T08:00:00.000Z'); assert.equal(f.calls.length, 0);
});

test('zero tracked SKUs waits for the first accepted submission without remote calls', async t => {
  const f = fixture(t); f.setDrafts([]); const result = f.service.start('target');
  assert.equal(result.rows.length, 0); assert.notEqual(result.job.state, 'running'); assert.match(result.message ?? '', /首次|正式提交/);
  await done(f); assert.equal(f.calls.length, 0);
});

test('changed and missing local variants stay visible as needing attention and are never queried', async t => {
  const f = fixture(t, [product('p', 'BEFORE'), product('q', 'REMOVED')]);
  f.products.get('p')!.variants[0].sku = 'AFTER'; f.products.get('q')!.variants = [];
  const result = f.service.start('target'); assert.equal(result.rows.length, 2); assert.ok(result.rows.every(r => r.trackingIssue));
  await done(f); assert.equal(f.calls.length, 0);
});

test('listing and inventory pagination retains SKU filters, excludes unrelated remote records and preserves unknown quantities', async t => {
  const f = fixture(t, [product('p', 'NEW-1'), product('q', 'NEW-2')]);
  f.setHandler(({ kind, query }): JsonObject => {
    if (kind === 'listings') return query.pageToken
      ? { items: [listing('NEW-2'), listing('OLD-STORE-SKU')] }
      : { items: [listing('NEW-1'), listing('NEW-2', 'wrong-market')], pagination: { nextToken: 'listing-page-2' } };
    if (kind === 'inventory') return { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'market' },
      inventorySummaries: query.nextToken ? [{ sellerSku: 'OLD-STORE-SKU', totalQuantity: 999 }] : [
        { sellerSku: 'NEW-1', totalQuantity: 0, inventoryDetails: { fulfillableQuantity: 0, reservedQuantity: { totalReservedQuantity: 2 }, inboundWorkingQuantity: 1, inboundShippedQuantity: 2 } }] },
      ...(query.nextToken ? {} : { pagination: { nextToken: 'inventory-page-2' } }) };
    return daily(query.interval, 0);
  });
  assert.equal(f.service.start('target').job.state, 'running'); const result = await done(f);
  assert.equal(result.rows.length, 2); assert.equal(result.rows[0].inventory.value?.total, 0); assert.equal(result.rows[0].inventory.value?.fulfillable, 0);
  assert.equal(result.rows[0].inventory.value?.inbound, null); assert.equal(result.rows[1].inventory.value, null);
  assert.equal(result.rows[1].inventory.status, 'missing'); assert.equal(result.rows[1].listing.value?.asin, 'B000000001');
  const listingCalls = f.calls.filter(c => c.kind === 'listings'); const inventoryCalls = f.calls.filter(c => c.kind === 'inventory');
  assert.equal(listingCalls.length, 2); assert.equal(inventoryCalls.length, 2);
  assert.deepEqual(listingCalls.map(c => c.query.identifiers), ['NEW-1,NEW-2', 'NEW-1,NEW-2']);
  assert.ok(listingCalls.every(c => c.query.identifiersType === 'SKU' && c.query.includedData === 'summaries,attributes,issues' && c.query.pageSize === '20'));
  assert.ok(inventoryCalls.every(c => c.query.sellerSkus === 'NEW-1,NEW-2' && c.query.details === 'true' && c.query.granularityId === 'market' && c.query.marketplaceIds === 'market'));
  assert.equal(result.job.completed, result.job.total);
});

test('Haul sales uses one bounded UTC daily request per SKU and excludes pre-submission sales', async t => {
  const f = fixture(t); f.setDrafts([draft(f.products.get('p')!, { submittedAt: '2026-10-04T15:00:00.000Z' })]);
  f.setHandler(({ kind, query }): JsonObject => kind === 'sales' ? { payload: [
    { interval: '2026-10-01T00:00:00.000Z--2026-10-02T00:00:00.000Z', unitCount: 999 }, ...(daily(query.interval, 2).payload as JsonObject[])] }
    : kind === 'listings' ? { items: [] } : { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'market' }, inventorySummaries: [] } });
  f.service.start('target'); const result = await done(f); const calls = f.calls.filter(c => c.kind === 'sales'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].query, { marketplaceIds: 'market', sku: 'NEW-SKU', amazonProgram: 'AmazonHaul', granularity: 'Day', granularityTimeZone: 'UTC',
    interval: '2026-10-04T15:00:00.000Z--2026-10-07T10:15:00.000Z' });
  assert.equal(result.rows[0].sales.value?.units7d, 8); assert.equal(result.rows[0].sales.value?.units30d, 8);
  assert.equal(result.rows[0].sales.value?.window7dStart, '2026-10-04T15:00:00.000Z');
});

test('UTC windows include today and 6 or 29 preceding calendar days and standard listings skip Haul sales', async t => {
  const f = fixture(t, [product('p', 'HAUL'), product('q', 'STANDARD')]);
  f.setDrafts(f.drafts.map(d => ({ ...d, submittedAt: '2026-08-01T12:00:00.000Z', listingProgram: d.sku === 'HAUL' ? 'haul' : 'standard' })));
  f.service.start('target'); const result = await done(f); const sales = result.rows.find(r => r.sku === 'HAUL')!.sales.value!;
  assert.equal(sales.window30dStart, '2026-09-08T00:00:00.000Z'); assert.equal(sales.window7dStart, '2026-10-01T00:00:00.000Z');
  assert.equal(sales.units30d, 30); assert.equal(sales.units7d, 7); assert.equal(f.calls.filter(c => c.kind === 'sales').length, 1);
  assert.equal(result.rows.find(r => r.sku === 'STANDARD')!.sales.status, 'not_applicable');
});

test('missing sales buckets or unitCount stay unknown while explicit zero remains zero', async t => {
  const f = fixture(t); f.setHandler(({ kind, query }) => {
    if (kind === 'sales') { const data = daily(query.interval, 0); delete (data.payload as JsonObject[])[0].unitCount; return data; }
    return kind === 'listings' ? { items: [] } : { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'market' }, inventorySummaries: [] } };
  });
  f.service.start('target'); let result = await done(f); assert.equal(result.rows[0].sales.value?.units30d, null); assert.equal(result.rows[0].sales.value?.units7d, null);
  f.advance(6 * 3_600_000 + 1); f.setHandler(({ kind, query }) => kind === 'sales' ? daily(query.interval, 0) : kind === 'listings' ? { items: [] }
    : { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'market' }, inventorySummaries: [] } });
  f.service.start('target'); result = await done(f); assert.equal(result.rows[0].sales.value?.units30d, 0);
});

test('a failed refresh keeps previous successful values, and one failed interface does not block others', async t => {
  const f = fixture(t); f.setHandler(({ kind, query }) => kind === 'listings' ? { items: [listing('NEW-SKU')] }
    : kind === 'sales' ? daily(query.interval) : { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'market' }, inventorySummaries: [{ sellerSku: 'NEW-SKU', totalQuantity: 12 }] } });
  f.service.start('target'); const before = await done(f); f.advance(6 * 3_600_000 + 1);
  f.setHandler(({ kind, query }) => { if (kind === 'inventory') throw Object.assign(new Error('SECRET_DO_NOT_EXPOSE'), { status: 403 });
    return kind === 'sales' ? daily(query.interval, 2) : { items: [listing('NEW-SKU')] }; });
  f.service.start('target'); const after = await done(f);
  assert.equal(after.rows[0].inventory.value?.total, 12); assert.equal(after.rows[0].inventory.fetchedAt, before.rows[0].inventory.fetchedAt);
  assert.equal(after.rows[0].inventory.status, 'error'); assert.match(after.rows[0].inventory.error ?? '', /403|权限/);
  assert.doesNotMatch(JSON.stringify(after), /SECRET_DO_NOT_EXPOSE/); assert.ok(after.rows[0].sales.value!.units30d! > before.rows[0].sales.value!.units30d!);
});

test('successful sales observations are reused for six hours only within the same UTC date', async t => {
  const f = fixture(t); f.service.start('target'); await done(f); f.service.start('target'); await done(f);
  assert.equal(f.calls.filter(c => c.kind === 'sales').length, 1);
  f.advance(6 * 3_600_000); f.service.start('target'); await done(f); assert.equal(f.calls.filter(c => c.kind === 'sales').length, 2);
  f.advance(5 * 3_600_000); f.service.start('target'); await done(f); assert.equal(f.calls.filter(c => c.kind === 'sales').length, 2);
  f.advance(3 * 3_600_000); f.service.start('target'); await done(f); assert.equal(f.calls.filter(c => c.kind === 'sales').length, 3);
});

test('configuration generation changes discard an in-flight result and invalidate cached values', async t => {
  const f = fixture(t); let finish!: (v: JsonObject) => void;
  f.setHandler(() => new Promise(resolve => { finish = resolve; })); f.service.start('target'); await new Promise<void>(r => setImmediate(r));
  f.changeTarget({ sellerId: 'another-seller' }); finish({ items: [listing('NEW-SKU')] }); await new Promise<void>(r => setImmediate(r));
  const result = f.service.get('target'); assert.equal(result.scope.generation, 2); assert.equal(result.rows.length, 0); assert.equal(f.calls.length, 1);
});

test('stop and close prevent pending results and subsequent interface requests from committing', async t => {
  const f = fixture(t); let finish!: (v: JsonObject) => void;
  f.setHandler(() => new Promise(resolve => { finish = resolve; })); f.service.start('target'); await new Promise<void>(r => setImmediate(r));
  const stopped = f.service.stop('target'); assert.equal(stopped.job.state, 'stopped'); finish({ items: [listing('NEW-SKU')] });
  await new Promise<void>(r => setImmediate(r)); assert.equal(f.service.get('target').rows[0].listing.value, null); assert.equal(f.calls.length, 1);
  f.service.start('target'); await new Promise<void>(r => setImmediate(r)); f.service.close(); finish({ items: [listing('NEW-SKU')] });
  await new Promise<void>(r => setImmediate(r)); assert.equal(f.calls.length, 2); assert.throws(() => f.service.get('target'), /关闭/);
});

test('consecutive service failures bound sales requests instead of retrying every tracked SKU', async t => {
  const f = fixture(t, Array.from({ length: 12 }, (_, i) => product(`p${i}`, `SKU-${i}`)));
  f.setHandler(({ kind }): JsonObject => { if (kind === 'sales') throw new Error('offline'); return kind === 'listings' ? { items: [] }
    : { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'market' }, inventorySummaries: [] } }; });
  f.service.start('target'); const result = await done(f); assert.ok(f.calls.filter(c => c.kind === 'sales').length <= 3);
  assert.equal(result.job.completed, result.job.total); assert.ok(result.rows.every(r => r.sales.status === 'error'));
});

test('derived cache survives restart, never adds untracked SKUs, and ignores invalid cached JSON', async t => {
  const f = fixture(t); f.service.start('target'); await done(f); const priorSalesCalls = f.calls.filter(c => c.kind === 'sales').length;
  f.reopen(); assert.equal(f.service.get('target').rows[0].sales.value?.units30d, 7); f.service.start('target'); await done(f);
  assert.equal(f.calls.filter(c => c.kind === 'sales').length, priorSalesCalls);
  f.setDrafts([]); assert.equal(f.service.get('target').rows.length, 0);
  f.service.close(); const cacheFiles = readdirSync(f.directory, { recursive: true }).filter(name => String(name).endsWith('.json'));
  assert.ok(cacheFiles.length > 0); for (const name of cacheFiles) writeFileSync(join(f.directory, String(name)), '{broken-json');
  f.setDrafts([draft(f.products.get('p')!)]); f.reopen(); assert.equal(f.service.get('target').rows[0].sales.value, null);
});

test('requests stay within 20 listing and 50 inventory SKU limits, and comma SKUs use single-SKU inventory', async t => {
  const f = fixture(t, [...Array.from({ length: 51 }, (_, i) => product(`p${i}`, `SKU-${i}`)), product('comma', 'BLUE,LARGE')]);
  f.setDrafts(f.drafts.map(d => ({ ...d, listingProgram: 'standard' })));
  f.service.start('target'); const result = await done(f);
  const listings = f.calls.filter(c => c.kind === 'listings'); const inventory = f.calls.filter(c => c.kind === 'inventory');
  assert.deepEqual(listings.map(c => c.query.identifiers.split(',').length), [20, 20, 11]);
  assert.deepEqual(inventory.filter(c => c.query.sellerSkus).map(c => c.query.sellerSkus.split(',').length), [50, 1]);
  assert.equal(inventory.find(c => c.query.sellerSku)?.query.sellerSku, 'BLUE,LARGE');
  assert.equal(f.calls.filter(c => c.kind === 'sales').length, 0); assert.equal(result.rows.find(r => r.sku === 'BLUE,LARGE')!.listing.status, 'error');
});

test('invalid response marketplace and repeating page tokens fail safely without exposing foreign data', async t => {
  const f = fixture(t); f.setHandler(({ kind, query }): JsonObject => kind === 'listings'
    ? { items: [listing('NEW-SKU')], pagination: { nextToken: 'loop' } }
    : kind === 'inventory' ? { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'another-market' }, inventorySummaries: [{ sellerSku: 'NEW-SKU', totalQuantity: 998 }] } }
    : daily(query.interval));
  f.service.start('target'); const result = await done(f);
  assert.equal(f.calls.filter(c => c.kind === 'listings').length, 2); assert.equal(result.rows[0].listing.value, null);
  assert.equal(result.rows[0].inventory.value, null); assert.equal(result.rows[0].inventory.status, 'error');
  assert.equal(result.rows[0].sales.status, 'ok');
});

test('busy includes a stopped in-flight request, and duplicate starts do not create concurrent work', async t => {
  const f = fixture(t); let finish!: (value: JsonObject) => void;
  f.setHandler(() => new Promise(resolve => { finish = resolve; })); assert.equal(f.service.busy, false);
  f.service.start('target'); f.service.start('target'); await new Promise<void>(r => setImmediate(r)); assert.equal(f.calls.length, 1);
  f.service.stop('target'); assert.equal(f.service.busy, true); finish({ items: [] }); await new Promise<void>(r => setImmediate(r));
  assert.equal(f.service.busy, false);
});

test('a matching seller with a new credential generation cannot reuse the previous cache', async t => {
  const f = fixture(t); f.service.start('target'); await done(f); assert.ok(f.service.get('target').rows[0].sales.value);
  f.changeTarget({}); f.reopen(); const result = f.service.get('target'); assert.equal(result.rows[0].sales.value, null);
  assert.equal(result.scope.generation, 2);
});

test('local SKU changes during a request prevent that result and later requests from updating the old SKU', async t => {
  const f = fixture(t); let finish!: (value: JsonObject) => void;
  f.setHandler(() => new Promise(resolve => { finish = resolve; })); f.service.start('target'); await new Promise<void>(r => setImmediate(r));
  f.products.get('p')!.variants[0].sku = 'CHANGED'; finish({ items: [listing('NEW-SKU')] }); const result = await done(f);
  assert.equal(result.rows[0].listing.value, null); assert.ok(result.rows[0].trackingIssue); assert.equal(f.calls.length, 1);
});

test('cache shape, size and future timestamps are checked, and raw remote properties never reach the renderer', async t => {
  const f = fixture(t); f.setHandler(({ kind, query }): JsonObject => kind === 'listings'
    ? { items: [{ ...listing('NEW-SKU'), attributes: { unrequestedPrivateField: 'RAW_REMOTE_MARKER' }, arbitraryField: 'RAW_REMOTE_MARKER' }], anotherField: 'RAW_REMOTE_MARKER' }
    : kind === 'sales' ? daily(query.interval) : { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'market' }, inventorySummaries: [] } });
  f.service.start('target'); const result = await done(f); assert.doesNotMatch(JSON.stringify(result), /RAW_REMOTE_MARKER/);
  const cache = join(f.directory, 'product-data-cache', readdirSync(join(f.directory, 'product-data-cache'))[0]); const valid = readFileSync(cache, 'utf8');
  for (const content of [valid.replace('"units30d":7', '"units30d":-1'), valid.replaceAll('2026-10-07T10:15:00.000Z', '2099-10-07T10:15:00.000Z'), ' '.repeat(8 * 1024 * 1024 + 1)]) {
    f.service.close(); writeFileSync(cache, content); f.reopen(); assert.equal(f.service.get('target').rows[0].sales.value, null);
  }
});

test('missing listing issue fields stay unknown rather than reporting a zero-problem listing', async t => {
  const f = fixture(t); f.setHandler(({ kind, query }): JsonObject => kind === 'listings' ? { items: [{ ...listing('NEW-SKU'), issues: [{ code: 'NO_SEVERITY', message: 'Unknown' }] }] }
    : kind === 'sales' ? daily(query.interval) : { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'market' }, inventorySummaries: [] } });
  f.service.start('target'); const result = await done(f); assert.equal(result.rows[0].listing.value?.errorCount, null); assert.equal(result.rows[0].listing.value?.warningCount, null);
});

test('a local SKU change between pages stops pagination with the original SKU filters', async t => {
  const f = fixture(t); f.setHandler(({ kind, query }): JsonObject => {
    if (kind === 'listings') { f.products.get('p')!.variants[0].sku = 'CHANGED'; return { items: [listing('NEW-SKU')], pagination: { nextToken: 'next-page' } }; }
    return kind === 'sales' ? daily(query.interval) : { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'market' }, inventorySummaries: [] } };
  });
  f.service.start('target'); const result = await done(f); assert.equal(f.calls.length, 1); assert.ok(result.rows[0].trackingIssue);
});

test('a successful but empty sales response stays unknown and is cached instead of amplifying repeat refreshes', async t => {
  const f = fixture(t); f.setHandler(({ kind }): JsonObject => kind === 'sales' ? { payload: [] } : kind === 'listings' ? { items: [] }
    : { payload: { granularity: { granularityType: 'Marketplace', granularityId: 'market' }, inventorySummaries: [] } });
  f.service.start('target'); await done(f); f.service.start('target'); const result = await done(f);
  assert.equal(result.rows[0].sales.value?.units30d, null); assert.equal(f.calls.filter(c => c.kind === 'sales').length, 1);
});
