import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { TyaiImageAdapter } from '../src/main/image-generation/tyai-adapter.ts';
import type { TyaiImageRequest } from '../src/main/image-generation/tyai-adapter.ts';
import { AiError } from '../src/main/ai/errors.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP0cAAAAASUVORK5CYII=', 'base64');
const BASE: TyaiImageRequest = { apiKey: 'relay-private-fixture', model: 'gpt-image-2.5-flare-4k-max', prompt: 'private fixture product', size: '1024x1024', quality: 'max', background: 'auto', references: [] };
const url = 'https://cdn.example.test/output.png?Signature=temporary';
const code = (expected: string) => (error: unknown) => error instanceof AiError && error.code === expected && !error.message.includes(BASE.apiKey) && !error.message.includes(url);
function fixture(options: { url?: string; body?: Buffer; status?: number; headers?: Record<string, string>; addresses?: { address: string; family: number }[]; maxBytes?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []; let requests = 0, lookedUp = 0, pinned = '';
  const adapter = new TyaiImageAdapter({
    fetch: async (requestUrl, init) => { calls.push({ url: String(requestUrl), init }); return Response.json({ data: [{ url: options.url ?? url }] }); },
    downloadDependencies: {
      lookup: async () => { lookedUp++; return options.addresses ?? [{ address: '8.8.8.8', family: 4 }]; }, maxBytes: options.maxBytes,
      request: ((downloadUrl: URL, init: { lookup: (host: string, options: unknown, cb: (error: null, address: string) => void) => void; headers: Record<string, string>; rejectUnauthorized: boolean; method: string; agent: unknown }, callback: (response: Readable) => void) => {
        requests++; assert.equal(String(downloadUrl), options.url ?? url); assert.equal(init.method, 'GET'); assert.equal(init.agent, false); assert.equal(init.rejectUnauthorized, true);
        assert.equal(Object.keys(init.headers).some(key => /authorization|cookie/i.test(key)), false);
        init.lookup(downloadUrl.hostname, {}, (_error, address) => { pinned = address; });
        const response = Object.assign(Readable.from([options.body ?? PNG]), { statusCode: options.status ?? 200, headers: { 'content-type': 'image/png', ...options.headers } });
        return Object.assign(new EventEmitter(), { end() { queueMicrotask(() => callback(response)); }, destroy() {} });
      }) as never,
    },
  });
  return { adapter, calls, counts: () => ({ requests, lookedUp, pinned }) };
}

test('Tyai URL output downloads once without relay credentials and pins the public DNS result', async () => {
  const f = fixture(), result = await f.adapter.generate(BASE, new AbortController().signal);
  assert.deepEqual(result.bytes, PNG); assert.equal(result.width, 1); assert.equal(result.height, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://tyaiapi.com/v1/images/generations');
  assert.equal(new Headers(f.calls[0].init?.headers).get('authorization'), `Bearer ${BASE.apiKey}`);
  assert.deepEqual(f.counts(), { requests: 1, lookedUp: 1, pinned: '8.8.8.8' });
});

test('Tyai output never opens a socket for unsafe URLs or any private DNS answer', async () => {
  for (const unsafe of ['http://cdn.example.test/a.png', 'https://user:secret@cdn.example.test/a.png', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://cdn.example.test:444/a.png', 'https://cdn.example.test/a.png#secret']) {
    const f = fixture({ url: unsafe }); await assert.rejects(f.adapter.generate(BASE, new AbortController().signal), code('OUTPUT_INVALID'));
    assert.equal(f.counts().requests, 0); assert.equal(f.calls.length, 1);
  }
  for (const addresses of [[{ address: '10.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 6 }], []]) {
    const f = fixture({ addresses }); await assert.rejects(f.adapter.generate(BASE, new AbortController().signal), code('OUTPUT_INVALID')); assert.equal(f.counts().requests, 0);
  }
});

test('Tyai CDN output rejects redirects, invalid payloads, compression and oversized or incomplete bodies without retry', async () => {
  const cases: Parameters<typeof fixture>[0][] = [{ status: 302 }, { status: 401 }, { body: Buffer.from('not a PNG') }, { headers: { 'content-type': 'image/jpeg' } }, { headers: { 'content-encoding': 'gzip' } },
    { headers: { 'content-length': '9007199254740992' } }, { headers: { 'content-length': '1' } }, { maxBytes: 32 }];
  for (const options of cases) {
    const f = fixture(options); await assert.rejects(f.adapter.generate(BASE, new AbortController().signal), code('OUTPUT_INVALID'));
    assert.equal(f.counts().requests, 1); assert.equal(f.calls.length, 1);
  }
});

test('Tyai cancellation interrupts a hanging CDN DNS lookup without retrying generation', { timeout: 1000 }, async () => {
  const controller = new AbortController(); let start!: () => void, requests = 0;
  const started = new Promise<void>(resolve => { start = resolve; });
  const adapter = new TyaiImageAdapter({ fetch: async () => { requests++; return Response.json({ data: [{ url }] }); }, downloadDependencies: {
    lookup: async () => { start(); return new Promise(() => {}); }, request: (() => { throw new Error('No socket should open'); }) as never,
  } });
  const pending = adapter.generate(BASE, controller.signal), rejected = assert.rejects(pending, code('CANCELLED'));
  await started; controller.abort(); await rejected; assert.equal(requests, 1);
});

test('Tyai never retries a paid POST after authentication errors or ambiguous network failure', async () => {
  for (const kind of ['auth', 'network'] as const) {
    let attempts = 0;
    const adapter = new TyaiImageAdapter({ fetch: async () => { attempts++; if (kind === 'network') throw new Error(BASE.apiKey); return Response.json({ error: { message: BASE.apiKey } }, { status: 401 }); } });
    await assert.rejects(adapter.generate(BASE, new AbortController().signal), code(kind === 'auth' ? 'AUTH_FAILED' : 'NETWORK_ERROR')); assert.equal(attempts, 1);
  }
});

test('Tyai explains that JPEG output is unsupported for both URL and base64 responses', async () => {
  const jpeg = Buffer.from('ffd8ffc0000b080001000101011100ffd9', 'hex');
  const base64 = new TyaiImageAdapter({ fetch: async () => Response.json({ data: [{ b64_json: jpeg.toString('base64') }] }) });
  const remote = fixture({ body: jpeg, headers: { 'content-type': 'image/jpeg' } }).adapter;
  for (const adapter of [base64, remote]) await assert.rejects(adapter.generate(BASE, new AbortController().signal), error => {
    assert.ok(error instanceof AiError); assert.equal(error.code, 'OUTPUT_INVALID'); assert.match(error.message, /JPEG.*PNG/); return true;
  });
});
