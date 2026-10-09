import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AmazonTransport } from '../src/main/amazon/transport.ts';
import type { AmazonDependencies } from '../src/main/amazon/transport.ts';
import type { AmazonCallEvent, AmazonTarget } from '../src/shared/amazon-contracts.ts';

const target: AmazonTarget = { id: 'network-test', name: 'Network test', mode: 'live', sellerId: 'TEST_SELLER', marketplaceId: 'ATVPDKIKX0DER', marketplaceName: 'US', region: 'na', locale: 'en_US', paused: false, configured: true, credentialUpdatedAt: null, lastError: null };
const origin = 'https://selling-partner-definitions-prod-iad.s3.amazonaws.com';
const schema = { type: 'object', properties: { item_name: { type: 'string' } } };
const bytes = JSON.stringify(schema);
const descriptor = (resource = `${origin}/schema/DRINK_COASTER.json/test`) => ({ link: { resource, verb: 'GET' }, checksum: createHash('md5').update(bytes).digest('base64') });

function fixture(addresses: string[], options: { native?: boolean; response?: () => Response | Promise<Response>; maxSchemaBytes?: number; timeoutMs?: number } = {}) {
  const downloads: { url: string; init: RequestInit }[] = [];
  const apiCalls: string[] = [];
  const events: AmazonCallEvent[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); apiCalls.push(url);
    if (url === 'https://api.amazon.com/auth/o2/token') return Response.json({ access_token: 'test_access_token', token_type: 'bearer', expires_in: 3600 });
    if (url.startsWith('https://sellingpartnerapi-na.amazon.com/')) return Response.json({ productTypes: [] });
    return new Response(bytes);
  };
  const schemaFetch = async (url: string, init: RequestInit) => {
    downloads.push({ url, init });
    return options.response ? options.response() : new Response(bytes);
  };
  const dependencies: AmazonDependencies = { fetch: fetcher, resolveAddresses: async () => addresses, sleep: async () => {}, random: () => 0,
    timeoutMs: options.timeoutMs ?? 100, maxSchemaBytes: options.maxSchemaBytes, ...(options.native === false ? {} : { schemaFetch }) };
  const transport = new AmazonTransport({ active: () => target, generation: () => 1, credentials: () => ({ name: target.name, sellerId: target.sellerId, marketplaceId: target.marketplaceId, region: target.region, locale: target.locale, clientId: 'test_client', clientSecret: 'test_secret', refreshToken: 'test_refresh' }),
    pause: () => {}, audit: event => events.push(event), redact: value => value, remember: () => {} }, dependencies);
  return { transport, downloads, apiCalls, events };
}

test('official Amazon schema and meta-schema load through the proxy-aware downloader with Fake-IP DNS', async () => {
  for (const address of ['198.18.0.12', '198.19.255.254']) {
    const f = fixture([address]);
    for (const path of ['/schema/DRINK_COASTER.json/test', '/schema/amazon-product-type-definition-meta-schema-v1.json/test']) {
      assert.deepEqual((await f.transport.schemaLink(target, descriptor(origin + path))).schema, schema);
    }
    assert.equal(f.downloads.length, 2);
    assert.equal(f.apiCalls.length, 0);
  }
});

test('schema requests omit credentials and referrer, disable caching and block automatic redirects', async () => {
  const f = fixture(['52.0.0.1']);
  await f.transport.api(target, 'searchDefinitionsProductTypes', '/definitions/2020-09-01/productTypes', { marketplaceIds: target.marketplaceId });
  await f.transport.schemaLink(target, descriptor());
  assert.equal(f.apiCalls.length, 2, 'LWA and SP-API keep their existing transport');
  assert.equal(f.downloads.length, 1, 'only schema downloads use the new transport');
  const init = f.downloads[0].init;
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.cache, 'no-store');
  assert.deepEqual([...new Headers(init.headers)], [['accept', 'application/json']]);
  assert.equal(init.body, undefined);
  assert.ok(init.signal instanceof AbortSignal);
});

test('Fake-IP compatibility requires the proxy-aware downloader and the exact official schema origin and path', async () => {
  const ordinary = fixture(['198.18.0.12'], { native: false });
  await assert.rejects(ordinary.transport.schemaLink(target, descriptor()), /非公开网络/);
  assert.equal(ordinary.apiCalls.length, 0);
  for (const resource of [
    'https://htc-test.s3.amazonaws.com/schema/DRINK_COASTER.json/test',
    'https://selling-partner-definitions-prod-iad.evil.s3.amazonaws.com/schema/test',
    'https://schemas.amazon.com/schema/test',
    `${origin}/other/test`, `${origin}/schema/../other/test`,
    'https://selling-partner-definitions-prod-iad.s3.amazonaws.com.evil.example/schema/test',
    `${origin.replace('https:', 'http:')}/schema/test`,
    `${origin.replace('https://', 'https://user:password@')}/schema/test`,
    `${origin}:444/schema/test`, `${origin}/schema/test#fragment`,
  ]) {
    const f = fixture(['198.18.0.12']);
    await assert.rejects(f.transport.schemaLink(target, descriptor(resource)), /非公开网络|不可信/);
    assert.equal(f.downloads.length + f.apiCalls.length, 0);
  }
});

test('private, loopback, link-local, malformed, empty and mixed DNS results still block all downloads', async () => {
  for (const addresses of [[], ['127.0.0.1'], ['10.0.0.1'], ['192.168.1.1'], ['172.16.0.1'], ['169.254.169.254'], ['::1'], ['fc00::1'], ['fe80::1'], ['::ffff:198.18.0.12'], ['invalid'], ['198.17.255.255', '198.18.0.12', '10.0.0.1'], ['52.0.0.1', '127.0.0.1']]) {
    const f = fixture(addresses);
    await assert.rejects(f.transport.schemaLink(target, descriptor()), /非公开网络/);
    assert.equal(f.downloads.length + f.apiCalls.length, 0);
  }
});

test('public DNS still supports the existing non-Electron downloader', async () => {
  const f = fixture(['52.0.0.1'], { native: false });
  assert.deepEqual((await f.transport.schemaLink(target, descriptor())).schema, schema);
  assert.equal(f.apiCalls.length, 1);
});

test('Fake-IP downloads still reject redirects and checksum corruption', async () => {
  for (const [response, error] of [
    [() => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } }), /重定向/],
    [() => new Response('{"changed":true}'), /checksum/],
  ] as const) {
    const f = fixture(['198.18.0.12'], { response });
    await assert.rejects(f.transport.schemaLink(target, descriptor()), error);
    assert.equal(f.downloads.length, 1);
    assert.equal(f.apiCalls.length, 0);
  }
});

test('failed native TLS or timed-out requests never fall back to the ordinary downloader', async () => {
  for (const response of [async () => { throw new Error('net::ERR_CERT_AUTHORITY_INVALID'); }, () => new Promise<Response>(() => {})]) {
    const f = fixture(['198.18.0.12'], { response, timeoutMs: 10 });
    await assert.rejects(f.transport.schemaLink(target, descriptor()), /下载失败或超时/);
    assert.equal(f.downloads.length, 3);
    assert.equal(f.apiCalls.length, 0);
  }
});

test('Fake-IP schema bodies retain streaming and declared-size limits', async () => {
  for (const response of [() => new Response(bytes, { headers: { 'content-length': '1000000' } }), () => new Response(bytes)]) {
    const f = fixture(['198.18.0.12'], { response, maxSchemaBytes: 16 });
    await assert.rejects(f.transport.schemaLink(target, descriptor()), /大小/);
    assert.equal(f.downloads.length, 1);
  }
});

function unfinishedBody(stall: boolean): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from(bytes.slice(0, 12))); },
    pull(controller) { if (!stall) controller.error(new Error('upstream read failed')); },
  }), { status: 200 });
}

for (const stall of [false, true]) {
  const failure = stall ? 'timeout' : 'stream error';
  test(`schema retries HTTP 200 body ${failure} and checks the complete retry bytes`, async () => {
    let attempt = 0;
    const f = fixture(['198.18.0.12'], { timeoutMs: 10,
      response: () => ++attempt === 1 ? unfinishedBody(stall) : new Response(bytes) });
    assert.deepEqual((await f.transport.schemaLink(target, descriptor())).schema, schema);
    assert.equal(f.downloads.length, 2);
    assert.equal(f.events[0].status, 200);
    assert.equal(f.events[0].retries, 1);
    assert.equal(f.events[0].category, null);
  });

  test(`exhausted HTTP 200 body ${failure} reports unfinished download rather than checksum mismatch`, async () => {
    const f = fixture(['198.18.0.12'], { timeoutMs: 10, response: () => unfinishedBody(stall) });
    await assert.rejects(f.transport.schemaLink(target, descriptor()), /正文下载未完成/);
    assert.equal(f.downloads.length, 3);
    assert.equal(f.events[0].status, 200);
    assert.equal(f.events[0].retries, 2);
    assert.equal(f.events[0].category, 'schema');
    assert.equal(f.apiCalls.length, 0);
  });
}

test('complete but corrupt retry bytes still fail checksum validation without another attempt', async () => {
  let attempt = 0;
  const f = fixture(['198.18.0.12'], {
    response: () => ++attempt === 1 ? unfinishedBody(false) : new Response('{"changed":true}') });
  await assert.rejects(f.transport.schemaLink(target, descriptor()), /checksum 校验失败/);
  assert.equal(f.downloads.length, 2);
  assert.equal(f.events[0].category, 'schema');
});
