import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { ExecutionService } from '../src/main/execution/service.ts';
import type { AmazonDraft } from '../src/shared/amazon-contracts.ts';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const secretStorage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Real live-mode service and transport, with synthetic credentials and all HTTP/DNS injected. */
async function fixture(t: test.TestContext, options: { scheduleFollowup?: (draftId: string) => unknown; unknownWrite?: boolean } = {}) {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'execution-live-concurrency-')), store = new WorkspaceStore(directory);
  let now = Date.now(), lastPut = -Infinity, generation = 1, listingReads = 0;
  const sleeps: { at: number; resolve: () => void }[] = [];
  const puts: { at: number; sku: string; preview: boolean; status: number }[] = [];
  let held: Promise<void> | null = null, release = () => {};
  const schema = { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object', properties: {
    item_name: { type: 'string' }, main_product_image_locator: { type: 'array', items: { type: 'object', properties: { media_location: { type: 'string' } } } },
  }, required: ['item_name'], additionalProperties: true };
  const meta = { $id: 'https://schemas.amazon.com/selling-partners/definitions/product-types/meta-schema/v1', $schema: schema.$schema, type: ['object', 'boolean'] };
  const link = (name: string, data: unknown) => ({ link: { verb: 'GET', resource: `https://fixture.s3.amazonaws.com/${name}.json` }, checksum: createHash('md5').update(JSON.stringify(data)).digest('base64') });
  const amazon = new AmazonService(directory, id => store.getProduct(id), secretStorage, {
    now: () => now, random: () => 0, resolveAddresses: async () => ['52.0.0.1'],
    sleep: ms => new Promise(resolve => sleeps.push({ at: now + ms, resolve })),
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.amazon.com') return json({ access_token: 'fixture_access_token', token_type: 'bearer', expires_in: 3600 });
      if (url.hostname === 'fixture.s3.amazonaws.com') return json(url.pathname === '/meta.json' ? meta : schema);
      if (url.pathname.includes('/productTypes/')) return json({ marketplaceIds: ['ATVPDKIKX0DER'], productType: 'STORAGE_BAG', locale: 'en_US', requirements: 'LISTING',
        requirementsEnforced: 'ENFORCED', productTypeVersion: { version: 'v1' }, propertyGroups: {}, schema: link('schema', schema), metaSchema: link('meta', meta) });
      if (!url.pathname.includes('/listings/')) throw Error('Unexpected fixture endpoint');
      const sku = decodeURIComponent(url.pathname.split('/').at(-1)!);
      if (init.method === 'PUT') {
        const preview = url.searchParams.has('mode'), status = now - lastPut < 1000 ? 429 : 200;
        puts.push({ at: now, sku, preview, status }); if (status === 200) lastPut = now;
        if (preview && held) { const barrier = held; held = null; await barrier; }
        return json(status === 429 ? { errors: [{ code: 'TooManyRequests' }] } : { sku, status: preview ? 'VALID' : options.unknownWrite ? 'UNRECOGNIZED' : 'ACCEPTED', submissionId: 'fixture', issues: [] },
          status, { 'x-amzn-ratelimit-limit': '1', ...(status === 429 ? { 'retry-after': '1' } : {}) });
      }
      listingReads++; return json({ sku, summaries: [{ marketplaceId: 'ATVPDKIKX0DER', status: ['BUYABLE'] }], issues: [] });
    },
  });
  const target = await amazon.importCredentials({ name: 'Offline concurrency fixture', sellerId: 'FIXTURE_SELLER', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en_US',
    clientId: 'fixture_client', clientSecret: 'fixture_secret', refreshToken: 'fixture_refresh' });
  const drafts: AmazonDraft[] = [], uploads = new Map<string, { id: string; assetId: string; profileId: string; generation: number; sha256: string; publicUrl: string; status: string }>();
  for (let i = 0; i < 3; i++) {
    let product = store.createProduct(); const assetId = randomUUID(), variantId = product.variants[0].id;
    product = store.addAssets({ productId: product.id, revision: product.revision }, [{ id: assetId, fileName: 'fixture.png', mimeType: 'image/png', width: 1000, height: 1000,
      byteSize: 10, originalPath: `assets/${assetId}.png`, previewPath: `assets/${assetId}.preview.png`, sha256: 'a'.repeat(64) }]);
    product = store.updateAsset({ productId: product.id, revision: product.revision, assetId, role: 'main', variantIds: [variantId] });
    const draft = await amazon.createDraft({ targetId: target.id, productId: product.id, variantId, productType: 'STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' });
    drafts.push(amazon.saveDraft({ id: draft.id, revision: draft.revision, attributes: { item_name: `Fixture ${i}` } }));
    uploads.set(assetId, { id: randomUUID(), assetId, profileId: 'alpha', generation: 1, sha256: 'a'.repeat(64), publicUrl: `https://images.example.com/${assetId}.png`, status: 'AVAILABLE' });
  }
  const execution = new ExecutionService(directory, store, amazon, {
    getProfile: () => ({ id: 'alpha', host: 'ftp.example.com', port: 2121, secure: false, remoteRoot: '/', publicBaseUrl: 'https://images.example.com/', enabled: true, configured: true, generation }),
    upload: async input => structuredClone(uploads.get(input.assetId)!),
    verify: async id => structuredClone([...uploads.values()].find(upload => upload.id === id)!),
  }, { scheduleFollowup: options.scheduleFollowup });
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      await turn(); if (!execution.busy) return;
      if (sleeps.length) {
        now = Math.max(now, Math.min(...sleeps.map(sleep => sleep.at)));
        const due = sleeps.filter(sleep => sleep.at <= now);
        for (const sleep of due) { sleeps.splice(sleeps.indexOf(sleep), 1); sleep.resolve(); }
      }
    }
    throw Error('Offline execution did not settle');
  };
  t.after(async () => { release(); await drain(); await execution.close(); amazon.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { execution, amazon, target, drafts, puts, drain, get listingReads() { return listingReads; },
    holdPreview() { held = new Promise<void>(resolve => { release = resolve; }); }, release() { release(); }, rotateProfile() { generation++; },
    start() { const task = execution.create({ draftIds: drafts.map(draft => draft.id), profileId: 'alpha', concurrency: 3 }); execution.startAuthorized(execution.prepareStart(task.id)); return task; },
  };
}

test('three live SKU workflows respect the known shared preview/submit rate without pausing the target', async t => {
  const f = await fixture(t);
  await f.amazon.previewDraft({ id: f.drafts[0].id, revision: f.drafts[0].revision }); // Learn 1 request/second before the batch starts.
  const task = f.start(); await f.drain();
  assert.equal(f.execution.get(task.id).status, 'COMPLETED'); assert.equal(f.amazon.getTarget(f.target.id).paused, false);
  assert.equal(f.puts.filter(put => !put.preview).length, 3); assert.ok(f.puts.every(put => put.status === 200));
  for (let i = 1; i < f.puts.length; i++) assert.ok(f.puts[i].at - f.puts[i - 1].at >= 1000, 'preview and submit must share the rate window');
});

for (const action of ['pause', 'cancel', 'close'] as const) test(`${action} prevents queued live steps from sending after the in-flight preview settles`, async t => {
  const f = await fixture(t); f.holdPreview(); const task = f.start(); await turn();
  assert.equal(f.puts.length, 1, 'only one live step may hold the remote lane');
  let closing: Promise<void> | undefined;
  if (action === 'close') closing = f.execution.close(); else f.execution[action](task.id);
  f.release(); await f.drain(); await closing;
  assert.equal(f.puts.length, 1); assert.equal(f.puts.filter(put => !put.preview).length, 0);
});

test('a draft changed while waiting for the live lane is rejected and does not block the other SKU', async t => {
  const f = await fixture(t); f.holdPreview(); const task = f.start(); await turn(); assert.equal(f.puts.length, 1);
  const changed = f.amazon.getDraft(f.drafts[1].id); f.amazon.saveDraft({ id: changed.id, revision: changed.revision, attributes: { ...changed.attributes, item_name: 'Edited while queued' } });
  f.release(); await f.drain(); const done = f.execution.get(task.id);
  assert.equal(done.status, 'NEEDS_ATTENTION'); assert.equal(done.items[1].status, 'FAILED');
  assert.match(done.items[1].steps[3].error!, /草稿.*变化/);
  assert.ok(!f.puts.some(put => put.sku === changed.sku)); assert.equal(done.items[0].status, 'DONE'); assert.equal(done.items[2].status, 'DONE');
});

test('FTP configuration changes while waiting for the live lane stop queued preview and submit steps', async t => {
  const f = await fixture(t); f.holdPreview(); const task = f.start(); await turn(); assert.equal(f.puts.length, 1);
  f.rotateProfile(); f.release(); await f.drain(); const done = f.execution.get(task.id);
  assert.equal(done.status, 'NEEDS_ATTENTION'); assert.equal(f.puts.length, 1); assert.ok(done.items.every(item => item.status === 'FAILED'));
});

test('accepted live submissions finish their queue steps by scheduling delayed reads', async t => {
  const scheduled: string[] = [];
  const f = await fixture(t, { scheduleFollowup: id => { scheduled.push(id); return { status: 'WAITING', nextDueAt: new Date(Date.now() + 30 * 60_000).toISOString() }; } });
  const task = f.start(); await f.drain(); const done = f.execution.get(task.id);
  assert.equal(done.status, 'COMPLETED'); assert.equal(f.puts.filter(put => !put.preview).length, 3);
  assert.deepEqual([...scheduled].sort(), f.drafts.map(draft => draft.id).sort()); assert.equal(f.listingReads, 0);
  assert.ok(done.items.every(item => item.listingState === 'SUBMITTED' && item.steps.at(-1)?.status === 'DONE'));
});

test('unknown live writes remain attention and are never replayed when delayed reads are enabled', async t => {
  const scheduled: string[] = [], f = await fixture(t, { unknownWrite: true, scheduleFollowup: id => { scheduled.push(id); } });
  const task = f.start(); await f.drain(); assert.equal(f.execution.get(task.id).status, 'NEEDS_ATTENTION'); assert.equal(f.listingReads, 0);
  f.execution.startAuthorized(f.execution.prepareStart(task.id)); await f.drain();
  assert.equal(f.puts.filter(put => !put.preview).length, 3); assert.equal(f.listingReads, 0);
  assert.equal(f.execution.get(task.id).status, 'NEEDS_ATTENTION'); assert.ok(scheduled.length >= 3);
});
