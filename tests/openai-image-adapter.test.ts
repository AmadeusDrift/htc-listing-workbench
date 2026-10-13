import test from 'node:test';
import assert from 'node:assert/strict';
import { AiError,abortable } from '../src/main/ai/errors.ts';
import { OpenRouterImageAdapter } from '../src/main/ai/adapters/openrouter-images.ts';
import type { OpenRouterImageRequest } from '../src/main/ai/adapters/openrouter-images.ts';
import { OPENROUTER_IMAGE_MODELS } from '../src/main/ai/adapters/openrouter-images.ts';

const MIB = 1024 * 1024;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP0cAAAAASUVORK5CYII=', 'base64');
// A minimal JPEG header is sufficient at this adapter boundary; full image decoding belongs to the service.
const JPEG = Buffer.from('ffd8ffc0000b080001000101011100ffd9', 'hex');
const BASE: OpenRouterImageRequest = {
  apiKey: 'sk-fixture-private-key', model: 'openai/gpt-image-2.5-sunburst',
  prompt: 'Create a product photo. 私有测试提示词', size: '1024x1024', quality: 'high', background: 'auto', references: [],
};
function signal(): AbortSignal { return new AbortController().signal; }
function imageResponse(bytes: Buffer = PNG, headers?: HeadersInit): Response {
  return Response.json({ id: new Headers(headers).get('x-request-id')??undefined, created: 1791417600, data: [{ b64_json: bytes.toString('base64') }], output_format: 'png' }, { headers });
}
function errorCode(code: AiError['code']): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof AiError); assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /sk-fixture|私有测试提示词|upstream-private|https:\/\/evil/);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
}

test('generation sends one OpenRouter JSON POST and returns a PNG with bounded request metadata', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [], abortSignal = signal();
  const adapter = new OpenRouterImageAdapter({ fetch: async (url, init) => {
    calls.push({ url: String(url), init }); return imageResponse(PNG, { 'x-request-id': 'req_123-abc.DEF:4' });
  } });
  const result = await adapter.generate(BASE, abortSignal);
  assert.deepEqual(result, { bytes: PNG, requestId: 'req_123-abc.DEF:4', width: 1, height: 1 });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/images');
  assert.equal(init?.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.signal, abortSignal);
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${BASE.apiKey}`);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(init.body)), {
    model: BASE.model, prompt: BASE.prompt, n: 1, output_format: 'png', size: BASE.size, quality: BASE.quality, background: BASE.background,provider:{only:['openai'],allow_fallbacks:false},
  });
});

test('reference images use the OpenRouter input_references with typed base64 data URLs', async () => {
  const input: OpenRouterImageRequest = { ...BASE, model: 'openai/gpt-image-2.5-flare', background: 'transparent', references: [
    { mimeType: 'image/png', bytes: PNG }, { mimeType: 'image/jpeg', bytes: JPEG },
  ] };
  let attempts = 0;
  const adapter = new OpenRouterImageAdapter({ fetch: async (url, init) => {
    attempts++;
    assert.equal(String(url), 'https://openrouter.ai/api/v1/images');
    assert.equal(init?.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init.body)), {
      model: input.model, prompt: input.prompt, n: 1, output_format: 'png', size: input.size, quality: input.quality, background: 'transparent',provider:{only:['openai'],allow_fallbacks:false},
      input_references: [ { type:'image_url',image_url:{url: `data:image/png;base64,${PNG.toString('base64')}`} }, { type:'image_url',image_url:{url: `data:image/jpeg;base64,${JPEG.toString('base64')}`} } ],
    });
    return imageResponse();
  } });
  assert.deepEqual((await adapter.generate(input, signal())).bytes, PNG); assert.equal(attempts, 1);
});

test('both permitted model aliases and all exposed quality, size and background options pass through', async () => {
  const adapter = new OpenRouterImageAdapter({ fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.n, 1); assert.equal(body.output_format, 'png');
    for (const excluded of ['response_format', 'input_fidelity', 'stream', 'output_compression']) assert.equal(Object.hasOwn(body, excluded), false);
    return imageResponse();
  } });
  for (const model of OPENROUTER_IMAGE_MODELS) for (const quality of ['auto', 'low', 'medium', 'high'] as const) {
    await adapter.generate({ ...BASE, model, quality }, signal());
  }
  for (const size of ['auto', '1024x1024', '1536x1024', '1024x1536'] as const) for (const background of ['auto', 'opaque', 'transparent'] as const) {
    await adapter.generate({ ...BASE, size, background }, signal());
  }
  await adapter.generate({ ...BASE, prompt: 'a'.repeat(32000), references: Array.from({ length: 16 }, () => ({ mimeType: 'image/png', bytes: PNG })) }, signal());
});

test('model access checks only retrieve matching model metadata and never generate an image', async () => {
  let attempts = 0;
  const abortSignal = signal(), adapter = new OpenRouterImageAdapter({ fetch: async (url, init) => {
    attempts++; assert.equal(String(url), `https://openrouter.ai/api/v1/images/models/${BASE.model}/endpoints`);
    assert.equal(init?.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.signal, abortSignal); assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${BASE.apiKey}`);
    return Response.json({ data:{endpoints:[{provider_name:'OpenAI'}]} });
  } });
  assert.equal(await adapter.checkModel(BASE.apiKey, BASE.model, abortSignal), undefined); assert.equal(attempts, 1);
  for (const body of [{ id: 'other', object: 'model' }, { id: BASE.model, object: 'list' }, [], null, {}]) {
    await assert.rejects(new OpenRouterImageAdapter({ fetch: async () => Response.json(body) }).checkModel(BASE.apiKey, BASE.model, signal()), errorCode('OUTPUT_INVALID'));
  }
});

test('unsupported or malformed generation inputs are rejected before any network request', async () => {
  let attempts = 0;
  const adapter = new OpenRouterImageAdapter({ fetch: async () => { attempts++; return imageResponse(); } });
  const invalid: unknown[] = [null, [], {},
    ...['', ' ', 'a'.repeat(32001), 12].map(prompt => ({ ...BASE, prompt })),
    ...['', ' ', 'sk-secret\nheader', 'sk-secret\u007f', 'sk-secret\u0085', 'a'.repeat(4097), null].map(apiKey => ({ ...BASE, apiKey })),
    ...['gpt-image-2.5-sunburst-2026-09-08', 'gpt-image-1', 'https://evil.test', '../models', null].map(model => ({ ...BASE, model })),
    { ...BASE, size: '2048x2048' }, { ...BASE, quality: 'ultra' }, { ...BASE, background: 'red' },
    { ...BASE, references: null }, { ...BASE, references: Array(17).fill({ mimeType: 'image/png', bytes: PNG }) },
  ];
  for (const input of invalid) await assert.rejects(adapter.generate(input as OpenRouterImageRequest, signal()), errorCode('INVALID_INPUT'));
  for (const key of ['', 'bad\r\nsecret']) await assert.rejects(adapter.checkModel(key, BASE.model, signal()), errorCode('INVALID_INPUT'));
  await assert.rejects(adapter.checkModel(BASE.apiKey, 'https://evil.test' as typeof BASE.model, signal()), errorCode('INVALID_INPUT'));
  assert.equal(attempts, 0);
});

test('reference image bytes, mime type, dimensions and aggregate request size are bounded before dispatch', async () => {
  let attempts = 0;
  const adapter = new OpenRouterImageAdapter({ fetch: async () => { attempts++; return imageResponse(); } });
  const oversizedPixels = Buffer.from(PNG); oversizedPixels.writeUInt32BE(50000, 16);
  const invalid: unknown[] = [null, {}, { mimeType: 'image/png', bytes: Buffer.alloc(0) },
    { mimeType: 'image/webp', bytes: PNG }, { mimeType: 'image/jpeg', bytes: PNG }, { mimeType: 'image/png', bytes: JPEG },
    { mimeType: 'image/png', bytes: new Uint8Array(PNG) }, { mimeType: 'image/png', bytes: Buffer.from('<svg></svg>') },
    { mimeType: 'image/png', bytes: oversizedPixels }, { mimeType: 'image/png', bytes: Buffer.alloc(10 * MIB + 1) },
  ];
  for (const reference of invalid) await assert.rejects(adapter.generate({ ...BASE, references: [reference] } as OpenRouterImageRequest, signal()), errorCode('IMAGE_INVALID'));
  const large = Buffer.alloc(10 * MIB); PNG.copy(large);
  await assert.rejects(adapter.generate({ ...BASE, references: Array(3).fill({ mimeType: 'image/png', bytes: large }) }, signal()), errorCode('IMAGE_INVALID'));
  assert.equal(attempts, 0);
});

test('untrusted or reflected request identifiers are discarded rather than shown or persisted', async () => {
  const invalidIds = ['<script>alert(1)</script>', 'https://evil.test/x', 'req id', 'r'.repeat(201), 'PrivatePrompt'];
  for (const requestId of invalidIds) {
    const adapter = new OpenRouterImageAdapter({ fetch: async () => imageResponse(PNG, { 'x-request-id': requestId }) });
    assert.equal((await adapter.generate({ ...BASE, prompt: 'PrivatePrompt' }, signal())).requestId, null);
  }
  assert.equal((await new OpenRouterImageAdapter({ fetch: async () => imageResponse() }).generate(BASE, signal())).requestId, null);
});

test('successful HTTP responses must contain exactly one canonical base64 PNG and never cause a URL fetch', async () => {
  const encoded = PNG.toString('base64'), bomb = Buffer.from(PNG); bomb.writeUInt32BE(50000, 16);
  const invalid: unknown[] = [null, [], {}, { data: [] }, { data: [{ b64_json: encoded }, { b64_json: encoded }] },
    { data: [null] }, { data: [{ url: 'https://evil.test/image.png' }] },
    ...['', 'a', '!!!!', `data:image/png;base64,${encoded}`, encoded + '\n', encoded.slice(0, -1), 'Zh==', 'Zm9=', JPEG.toString('base64'), bomb.toString('base64'), Buffer.from('not a PNG').toString('base64')].map(b64_json => ({ data: [{ b64_json }] })),
    { data: [{ b64_json: 3 }] }, { data: [{ b64_json: encoded, url: 'https://evil.test/image.png' }] },
  ];
  for (const body of invalid) {
    let attempts = 0;
    const adapter = new OpenRouterImageAdapter({ fetch: async () => { attempts++; return Response.json(body); } });
    await assert.rejects(adapter.generate(BASE, signal()), errorCode('OUTPUT_INVALID')); assert.equal(attempts, 1);
  }
  for (const body of ['upstream-private: sk-fixture-private-key', '', Buffer.from([0xff, 0xfe])]) {
    await assert.rejects(new OpenRouterImageAdapter({ fetch: async () => new Response(body) }).generate(BASE, signal()), errorCode('OUTPUT_INVALID'));
  }
});

test('decoded PNG output is limited to 20 MiB independently of the JSON response limit', async () => {
  const bytes = Buffer.alloc(20 * MIB + 1); PNG.copy(bytes);
  await assert.rejects(new OpenRouterImageAdapter({ fetch: async () => imageResponse(bytes) }).generate(BASE, signal()), errorCode('OUTPUT_INVALID'));
});

test('authentication, permission, quota, rate and provider errors expose fixed errors without retrying', async () => {
  const cases: [number, unknown, AiError['code']][] = [
    [401, 'invalid_api_key', 'AUTH_FAILED'], [403, 'permission_denied', 'AUTH_FAILED'],
    [429, 'insufficient_quota', 'RATE_LIMITED'], [429, 'billing_hard_limit_reached', 'RATE_LIMITED'],
    [429, 'rate_limit_exceeded', 'RATE_LIMITED'], [402, undefined, 'QUOTA_EXCEEDED'], [500, 'upstream-private', 'PROVIDER_ERROR'],
    [400, 'content_policy_violation', 'PROVIDER_ERROR'], [302, undefined, 'PROVIDER_ERROR'],
  ];
  for (const [status, code, expected] of cases) {
    let attempts = 0;
    const adapter = new OpenRouterImageAdapter({ fetch: async () => {
      attempts++; return Response.json({ error: { code, message: `${BASE.apiKey} ${BASE.prompt} upstream-private` } }, { status });
    } });
    await assert.rejects(adapter.generate(BASE, signal()), errorCode(expected)); assert.equal(attempts, 1);
  }
  const adapter = new OpenRouterImageAdapter({ fetch: async () => new Response('upstream-private', { status: 401 }) });
  await assert.rejects(adapter.checkModel(BASE.apiKey, BASE.model, signal()), errorCode('SERVICE_PERMISSION_REQUIRED'));
});

test('network failures are sanitized and paid POSTs are never retried', async () => {
  let attempts = 0;
  const adapter = new OpenRouterImageAdapter({ fetch: async () => { attempts++; throw new Error(`${BASE.apiKey} ${BASE.prompt}`); } });
  await assert.rejects(adapter.generate(BASE, signal()), errorCode('NETWORK_ERROR')); assert.equal(attempts, 1);
});

test('response byte limits reject declared oversize, invalid lengths and chunked oversize while cancelling bodies', async () => {
  for (const length of ['1025', '-1', 'not-a-number', '9007199254740992']) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const adapter = new OpenRouterImageAdapter({ maxResponseBytes: 1024, fetch: async () => new Response(stream, { headers: { 'content-length': length } }) });
    await assert.rejects(adapter.generate(BASE, signal()), errorCode('OUTPUT_INVALID')); assert.equal(cancelled, true);
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.alloc(700)); controller.enqueue(Buffer.alloc(700)); }, cancel() { cancelled = true; } });
  await assert.rejects(new OpenRouterImageAdapter({ maxResponseBytes: 1024, fetch: async () => new Response(stream) }).generate(BASE, signal()), errorCode('OUTPUT_INVALID'));
  assert.equal(cancelled, true);
  const hugeDeclaredBody = new Response('small', { headers: { 'content-length': String(32 * MIB + 1) } });
  await assert.rejects(new OpenRouterImageAdapter({ fetch: async () => hugeDeclaredBody }).generate(BASE, signal()), errorCode('OUTPUT_INVALID'));
  for (const maxResponseBytes of [0, -1, Infinity, NaN, 32 * MIB + 1]) assert.throws(() => new OpenRouterImageAdapter({ maxResponseBytes }), errorCode('INVALID_INPUT'));
});

test('pre-aborted signals prevent generation and metadata requests without reflecting the abort reason', async () => {
  let attempts = 0; const controller = new AbortController(); controller.abort(new Error(BASE.apiKey));
  const adapter = new OpenRouterImageAdapter({ fetch: async () => { attempts++; return imageResponse(); } });
  await assert.rejects(adapter.generate(BASE, controller.signal), errorCode('CANCELLED'));
  await assert.rejects(adapter.checkModel(BASE.apiKey, BASE.model, controller.signal), errorCode('CANCELLED'));
  assert.equal(attempts, 0);
});

test('cancelled caller settles promptly while the original late response is captured once',async()=>{
  const controller=new AbortController();let respond!:(r:Response)=>void,posts=0;const receipts:unknown[]=[];
  const adapter=new OpenRouterImageAdapter({fetch:async()=>{posts++;return new Promise<Response>(resolve=>{respond=resolve;});}});
  const pending=adapter.generate(BASE,controller.signal,{onProviderReceipt:async receipt=>{receipts.push(receipt);}});
  const caller=abortable(pending,controller.signal);controller.abort();await assert.rejects(caller,errorCode('CANCELLED'));
  respond(imageResponse());await assert.rejects(pending,errorCode('CANCELLED'));
  assert.equal(posts,1);assert.equal(receipts.length,1);
});
test('credential echo is rejected without exposing a reflected identifier',async()=>{
  const adapter=new OpenRouterImageAdapter({fetch:async()=>imageResponse(PNG,{'x-request-id':BASE.apiKey})});
  await assert.rejects(adapter.generate(BASE,signal()),errorCode('OUTPUT_INVALID'));
});
