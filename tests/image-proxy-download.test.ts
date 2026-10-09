import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createSourceImageDownloader } from '../src/main/miaoshou/images.ts';
import { createRelayImageDownloader } from '../src/main/image-generation/download.ts';

type Address = { address: string; family: number };
type NativeFetch = (url: string, init: RequestInit) => Promise<Response>;
const png = Buffer.from('downloaded image bytes');
const fake = (address = '198.18.0.91'): Address => ({ address, family: 4 });
const variants = [
  { name: 'source', host: 'cbu01.alicdn.com', other: 'tyaiapi.com', create: createSourceImageDownloader },
  { name: 'relay', host: 'tyaiapi.com', other: 'cbu01.alicdn.com', create: createRelayImageDownloader },
];

for (const variant of variants) {
  const url = `https://${variant.host}/images/photo.png`;
  function fixture(options: { addresses?: Address[]; native?: boolean; fetch?: NativeFetch; maxBytes?: number; timeoutMs?: number } = {}) {
    let requests = 0;
    const calls: { url: string; init: RequestInit }[] = [];
    const download = variant.create({
      lookup: async () => options.addresses ?? [fake()],
      request: (() => { requests++; throw new Error('Unexpected ordinary transport'); }) as never,
      ...(options.native === false ? {} : { nativeFetch: async (value: string, init: RequestInit) => {
        calls.push({ url: value, init });
        return options.fetch ? options.fetch(value, init) : new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
      } }),
      maxBytes: options.maxBytes, timeoutMs: options.timeoutMs ?? 1000,
    });
    return { download, calls, ordinaryRequests: () => requests };
  }

  test(`${variant.name}: exact trusted origin with only Fake-IP DNS uses one credential-free native GET`, async () => {
    for (const addresses of [[fake()], [fake('198.18.0.0'), fake('198.19.255.255')]]) {
      const f = fixture({ addresses });
      assert.deepEqual(await f.download(url, new AbortController().signal), png);
      assert.equal(f.calls.length, 1); assert.equal(f.ordinaryRequests(), 0);
      const call = f.calls[0];
      assert.equal(call.url, url); assert.equal(call.init.method, 'GET');
      assert.equal(call.init.redirect, 'manual'); assert.equal(call.init.credentials, 'omit');
      assert.equal(call.init.referrerPolicy, 'no-referrer'); assert.equal(call.init.cache, 'no-store');
      assert.equal(call.init.body, undefined); assert.ok(call.init.signal instanceof AbortSignal);
      assert.deepEqual([...new Headers(call.init.headers)], [['accept', variant.name === 'source' ? 'image/png,image/jpeg' : 'image/png'], ['accept-encoding', 'identity']]);
    }
  });

  test(`${variant.name}: Fake-IP compatibility never extends to arbitrary domains, sibling domains or unsafe URLs`, async () => {
    for (const target of [
      'https://images.example.com/image.png', `https://${variant.other}/image.png`,
      `https://cdn.${variant.host}/image.png`, `https://${variant.host}.evil.example/image.png`,
      `https://${variant.host}./image.png`, `https://${variant.host}:444/image.png`,
      `http://${variant.host}/image.png`, `https://user:secret@${variant.host}/image.png`,
      `https://${variant.host}/image.png#fragment`, 'https://198.18.0.91/image.png',
    ]) {
      const f = fixture();
      await assert.rejects(f.download(target, new AbortController().signal), error => error instanceof Error && !error.message.includes('secret'));
      assert.equal(f.calls.length + f.ordinaryRequests(), 0, target);
    }
    const noNative = fixture({ native: false });
    await assert.rejects(noNative.download(url, new AbortController().signal));
    assert.equal(noNative.ordinaryRequests(), 0);
  });

  test(`${variant.name}: private, metadata, malformed, empty and mixed DNS answers block every transport`, async () => {
    for (const addresses of [
      [], [{ address: '127.0.0.1', family: 4 }], [{ address: '10.0.0.1', family: 4 }],
      [{ address: '192.168.1.1', family: 4 }], [{ address: '172.16.0.1', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }], [{ address: '100.64.0.1', family: 4 }],
      [{ address: '::1', family: 6 }], [{ address: 'fc00::1', family: 6 }], [{ address: 'fe80::1', family: 6 }],
      [{ address: '::ffff:198.18.0.91', family: 6 }], [{ address: 'invalid', family: 4 }],
      [{ address: '198.18.0.91', family: 6 }], [fake(), { address: '8.8.8.8', family: 4 }],
      [fake(), { address: '10.0.0.1', family: 4 }], [fake(), { address: '2606:4700:4700::1111', family: 6 }],
      [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    ]) {
      const f = fixture({ addresses }); await assert.rejects(f.download(url, new AbortController().signal));
      assert.equal(f.calls.length + f.ordinaryRequests(), 0, JSON.stringify(addresses));
    }
  });

  test(`${variant.name}: public DNS stays pinned with TLS validation and does not use the native exception`, async () => {
    for (const address of ['8.8.8.8', '198.17.255.255', '198.20.0.0']) {
      let native = 0, requests = 0;
      const download = variant.create({ lookup: async () => [{ address, family: 4 }], nativeFetch: async () => { native++; throw new Error(); },
        request: ((_url: URL, options: { rejectUnauthorized: boolean; agent: boolean; lookup: (host: string, opts: unknown, callback: (...args: unknown[]) => void) => void }, callback: (response: Readable) => void) => {
          requests++; assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
          options.lookup(variant.host, {}, (_error, actual, family) => { assert.equal(actual, address); assert.equal(family, 4); });
          return Object.assign(new EventEmitter(), { end() { queueMicrotask(() => callback(Object.assign(Readable.from([png]), { statusCode: 200, headers: { 'content-type': 'image/png' } }))); }, destroy() {} });
        }) as never });
      assert.deepEqual(await download(url, new AbortController().signal), png);
      assert.equal(requests, 1); assert.equal(native, 0);
    }
  });

  test(`${variant.name}: native redirects, changed final URLs, encoding, type and size violations cancel the body`, async () => {
    const cases: { status?: number; headers?: Record<string, string>; redirected?: boolean; finalUrl?: string; body?: Uint8Array[] }[] = [
      { status: 302, headers: { location: 'https://169.254.169.254/' } },
      { redirected: true }, { finalUrl: 'https://evil.example/image.png' }, { finalUrl: `${url}?changed=1` },
      { headers: { 'content-type': 'text/html' } }, { headers: { 'content-encoding': 'gzip' } },
      { headers: { 'content-length': '100' } }, { headers: { 'content-length': '0' } },
      { headers: { 'content-length': 'bogus' } }, { body: [Buffer.alloc(6), Buffer.alloc(6)] },
    ];
    for (const spec of cases) {
      let cancelled = 0;
      const f = fixture({ maxBytes: 10, fetch: async () => {
        const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const bytes of spec.body ?? [Buffer.from('png')]) controller.enqueue(bytes); }, cancel() { cancelled++; } }),
          { status: spec.status ?? 200, headers: { 'content-type': 'image/png', ...spec.headers } });
        if (spec.redirected) Object.defineProperty(response, 'redirected', { value: true });
        if (spec.finalUrl) Object.defineProperty(response, 'url', { value: spec.finalUrl });
        return response;
      } });
      await assert.rejects(f.download(url, new AbortController().signal));
      assert.equal(cancelled, 1, JSON.stringify(spec));
      assert.equal(f.calls.length, 1); assert.equal(f.ordinaryRequests(), 0);
    }
  });

  test(`${variant.name}: native truncated or empty responses cannot be accepted`, async () => {
    for (const response of [new Response(null, { headers: { 'content-type': 'image/png' } }), new Response('png', { headers: { 'content-type': 'image/png', 'content-length': '5' } })]) {
      const f = fixture({ fetch: async () => response });
      await assert.rejects(f.download(url, new AbortController().signal)); assert.equal(f.calls.length, 1);
    }
  });

  test(`${variant.name}: native TLS failures are sanitized and never retried through another transport`, async () => {
    const f = fixture({ fetch: async () => { throw new Error('net::ERR_CERT_AUTHORITY_INVALID secret=private'); } });
    await assert.rejects(f.download(url, new AbortController().signal), error => error instanceof Error && !/secret|private|CERT|https:/.test(error.message));
    assert.equal(f.calls.length, 1); assert.equal(f.ordinaryRequests(), 0);
  });

  test(`${variant.name}: cancellation before DNS or while DNS is pending never opens either transport`, async () => {
    for (const preAborted of [true, false]) {
      let native = 0, ordinary = 0, lookups = 0;
      const controller = new AbortController(); if (preAborted) controller.abort();
      const download = variant.create({ lookup: () => { lookups++; return new Promise<Address[]>(() => {}); },
        nativeFetch: async () => { native++; return new Response(png); }, request: (() => { ordinary++; throw new Error(); }) as never });
      const pending = download(url, controller.signal), rejected = assert.rejects(pending);
      if (!preAborted) controller.abort();
      await rejected;
      assert.equal(native + ordinary, 0); assert.equal(lookups, preAborted ? 0 : 1);
    }
  });

  test(`${variant.name}: body read failures stay sanitized and cannot trigger a retry`, async () => {
    const f = fixture({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('upstream secret https://private.example')); } }), { headers: { 'content-type': 'image/png' } }) });
    await assert.rejects(f.download(url, new AbortController().signal), error => error instanceof Error && !/secret|private|https:/.test(error.message));
    assert.equal(f.calls.length, 1); assert.equal(f.ordinaryRequests(), 0);
  });

  test(`${variant.name}: native header and body waits respect cancellation and timeout`, async () => {
    for (const waitForBody of [false, true]) for (const timeout of [false, true]) {
      let cancelled = 0, entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const f = fixture({ timeoutMs: timeout ? 20 : 1000, fetch: async () => {
        entered();
        return waitForBody ? new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'image/png' } }) : new Promise<Response>(() => {});
      } });
      const controller = new AbortController(), pending = f.download(url, controller.signal);
      const rejected = assert.rejects(pending);
      await Promise.race([started, pending]); await new Promise(resolve => setImmediate(resolve));
      if (!timeout) controller.abort();
      await rejected;
      assert.equal(f.calls.length, 1); assert.ok(f.calls[0].init.signal?.aborted);
      assert.equal(f.ordinaryRequests(), 0); if (waitForBody) assert.equal(cancelled, 1);
    }
  });

  test(`${variant.name}: late native responses are closed after caller cancellation`, async () => {
    let deliver!: (response: Response) => void, entered!: () => void, cancelled = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture({ fetch: () => { entered(); return new Promise(resolve => { deliver = resolve; }); } });
    const controller = new AbortController(), pending = f.download(url, controller.signal), rejected = assert.rejects(pending);
    await Promise.race([started, pending]); controller.abort(); await rejected;
    deliver(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'image/png' } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, 1); assert.equal(f.ordinaryRequests(), 0);
  });

  test(`${variant.name}: cancellation during response handoff still closes the native stream`, async () => {
    let cancelled = 0;
    const controller = new AbortController();
    const download = variant.create({ lookup: async () => [fake()], nativeFetch: async () => {
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'image/png' } });
    } });
    await assert.rejects(download(url, controller.signal));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, 1);
  });
}

test('source native JPEG is accepted and failed streams consume the remaining batch budget', async () => {
  const budget = { remainingBytes: 10 }; let requests = 0;
  const download = createSourceImageDownloader({ lookup: async () => [fake()], nativeFetch: async () => {
    requests++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(6)); controller.enqueue(Buffer.alloc(6)); controller.close(); } }), { headers: { 'content-type': 'image/jpeg' } });
  } });
  await assert.rejects(download('https://cbu01.alicdn.com/image.jpg', new AbortController().signal, budget), /大小限制/);
  assert.equal(budget.remainingBytes, 0);
  await assert.rejects(download('https://cbu01.alicdn.com/next.jpg', new AbortController().signal, budget), /上限/);
  assert.equal(requests, 1);
  const jpeg = createSourceImageDownloader({ lookup: async () => [fake()], nativeFetch: async () => new Response('jpeg', { headers: { 'content-type': 'image/jpeg' } }) });
  assert.equal((await jpeg('https://cbu01.alicdn.com/image.jpg', new AbortController().signal)).toString(), 'jpeg');
});

test('relay native JPEG preserves the explicit unsupported format error', async () => {
  const download = createRelayImageDownloader({ lookup: async () => [fake()], nativeFetch: async () => new Response('jpeg', { headers: { 'content-type': 'image/jpeg' } }) });
  await assert.rejects(download('https://tyaiapi.com/image.jpg', new AbortController().signal), /JPEG.*PNG/);
});
