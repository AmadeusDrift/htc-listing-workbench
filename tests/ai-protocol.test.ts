import test from 'node:test';
import assert from 'node:assert/strict';
import { signAcs3 } from '../src/main/ai/acs3.ts';
import { recognizeWithAliyun, segmentWithAidge, suggestWithDeepSeek } from '../src/main/ai/adapters.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { randomUUID } from 'node:crypto';

const credentials = { accessKeyId: 'YourAccessKeyId', accessKeySecret: 'YourAccessKeySecret' };
const context = { fetch: globalThis.fetch, now: () => new Date('2023-10-26T10:22:32.000Z'), nonce: () => '3156853299f313e23d1673dc12e1703d', maxResponseBytes: 1024 * 1024 };
const signal = new AbortController().signal;
const ocrResponse = { RequestId: 'fixture-request', Data: { Content: 'Cotton', Width: 256, Height: 256, SubImageCount: 1, SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: 'Cotton', BlockConfidence: 98 }] } }] } };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

test('ACS3 signing matches the official fixed RunInstances signature vector', () => {
  const signed = signAcs3({ host: 'ecs.cn-shanghai.aliyuncs.com', action: 'RunInstances', version: '2014-05-26', query: { RegionId: 'cn-shanghai', ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd' }, body: Buffer.alloc(0), ...credentials, now: context.now(), nonce: context.nonce() });
  assert.equal(signed.headers.authorization, 'ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0');
});

test('STS token is included in signed headers, while RFC3986 query encoding preserves signed values', () => {
  const signed = signAcs3({ host: 'aidge.cn-beijing.aliyuncs.com', action: 'ImageMatting', version: '2026-04-28', query: { ImageUrl: 'https://images.example.test/a !()*\'.png?x=1&y=2' }, body: Buffer.alloc(0), ...credentials, securityToken: 'fixture-sts-token', now: context.now(), nonce: context.nonce() });
  assert.equal(signed.headers['x-acs-security-token'], 'fixture-sts-token'); assert.ok(signed.headers.authorization.includes('x-acs-security-token;'));
  assert.ok(signed.url.includes('%20%21%28%29%2A%27')); assert.equal(new URL(signed.url).searchParams.get('ImageUrl'), 'https://images.example.test/a !()*\'.png?x=1&y=2');
});

test('Commerce OCR signs the exact binary body and reads current Data blocks without inventing boxes', async () => {
  const bytes = Buffer.from('fixture-image');
  const result = await recognizeWithAliyun(bytes, { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async (raw, options) => {
    const url = new URL(String(raw)), headers = new Headers(options?.headers);
    assert.equal(url.origin, 'https://ocr-api.cn-hangzhou.aliyuncs.com'); assert.equal(url.search, '?Type=Commerce');
    assert.equal(options?.method, 'POST'); assert.equal(options?.redirect, 'error'); assert.equal(options?.signal, signal);
    assert.deepEqual(Buffer.from(options?.body as Uint8Array), bytes);
    assert.equal(headers.get('content-type'), 'application/octet-stream'); assert.equal(headers.get('x-acs-action'), 'RecognizeAllText'); assert.equal(headers.get('x-acs-version'), '2021-07-07');
    return json(ocrResponse);
  } });
  assert.equal(result.output.kind, 'ocr'); assert.equal(result.output.coordinateSpace, 'unknown'); assert.equal(result.output.lines[0].box, null); assert.equal(result.output.lines[0].confidence, 0.98);
  assert.equal(result.usage.processedImages, 1);
});

test('OCR rejects malformed counts, confidence, dimensions, text overflow and stringified old Data', async () => {
  const invalid = [{ ...ocrResponse, Data: JSON.stringify(ocrResponse.Data) }, { ...ocrResponse, Data: { ...ocrResponse.Data, SubImageCount: 2 } }, { ...ocrResponse, Data: { ...ocrResponse.Data, Width: 257 } }, { ...ocrResponse, Data: { ...ocrResponse.Data, Content: 'a'.repeat(100001) } }, { ...ocrResponse, Data: { ...ocrResponse.Data, SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: 'x', BlockConfidence: 101 }] } }] } }];
  for (const response of invalid) await assert.rejects(recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async () => json(response) }), (e: unknown) => e instanceof AiError && e.code === 'OUTPUT_INVALID');
});

test('empty OCR summaries agree with block content and fractional confidence is normalized', async () => {
  const block = (text: string) => ({ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: text, BlockConfidence: 98.6 }] } });
  for (const data of [{ ...ocrResponse.Data, Content: '' }, { ...ocrResponse.Data, SubImages: [block('')] }]) await assert.rejects(recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async () => json({ Data: data }) }), (e: unknown) => e instanceof AiError && e.code === 'OUTPUT_INVALID');
  const result = await recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async () => json({ Data: { ...ocrResponse.Data, SubImages: [block('Cotton')] } }) });
  assert.equal(result.output.lines[0].confidence, 0.986);
});

test('Commerce OCR requires numeric confidence on every extracted block', async () => {
  for (const confidence of [undefined, null, '98']) {
    const data = { ...ocrResponse.Data, SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: 'Cotton', ...(confidence === undefined ? {} : { BlockConfidence: confidence }) }] } }] };
    await assert.rejects(recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async () => json({ Data: data }) }), (e: unknown) => e instanceof AiError && e.code === 'OUTPUT_INVALID');
  }
});

test('Commerce OCR rejects a Han summary without any Han block while allowing different summary grouping', async () => {
  const response = (blockText: string) => json({ Data: { ...ocrResponse.Data, Content: '棉 Cotton cloth', SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: blockText, BlockConfidence: 98.6 }] } }] } });
  await assert.rejects(recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async () => response('Cotton cloth') }), (e: unknown) => e instanceof AiError && e.code === 'OUTPUT_INVALID');
  const result = await recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async () => response('Cotton 棉花') });
  assert.equal(result.output.text, '棉 Cotton cloth'); assert.equal(result.output.lines[0].text, 'Cotton 棉花');
});

test('Aliyun recognizes documented business error codes and capitalized Aidge Success', async () => {
  for (const [Code, expected] of [['FreeQuotaExhausted', 'QUOTA_EXCEEDED'], ['Throttling.User', 'RATE_LIMITED']]) await assert.rejects(recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async () => new Response(JSON.stringify({ Code }), { status: 400 }) }), (e: unknown) => e instanceof AiError && e.code === expected);
  const result = await segmentWithAidge('https://htc.185858.xyz/AAA/image.png', { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async () => json({ Success: true, Code: 'Success', Data: { Width: 256, Height: 256, ImageUrl: 'https://output.oss-cn-beijing.aliyuncs.com/a.png', UsageMap: { ProcessedImageCount: 1 } } }) });
  assert.equal(result.output.kind, 'segmentation');
});

test('Aidge query preserves source size and returns a temporary cutout with nested usage', async () => {
  const result = await segmentWithAidge('https://htc.185858.xyz/AAA/image.png', { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async (raw, options) => {
    const url = new URL(String(raw)), headers = new Headers(options?.headers);
    assert.equal(url.origin, 'https://aidge.cn-beijing.aliyuncs.com'); assert.equal(url.searchParams.get('ImageUrl'), 'https://htc.185858.xyz/AAA/image.png'); assert.equal(url.searchParams.get('BackGroundType'), 'TRANSPARENT'); assert.equal(url.searchParams.has('TargetWidth'), false);
    assert.equal(headers.get('x-acs-action'), 'ImageMatting'); assert.equal(headers.get('x-acs-version'), '2026-04-28');
    assert.equal(Buffer.from(options?.body as Uint8Array).length, 0);
    return json({ Success: true, Code: 'success', RequestId: 'fixture-request', Data: { ImageUrl: 'http://output.oss-cn-beijing.aliyuncs.com/a.png?Signature=temporary', Width: 256, Height: 256, Score: 5.95, UsageMap: { ProcessedImageCount: 1 } } });
  } });
  assert.equal(result.output.outputKind, 'transparent-cutout'); assert.equal(result.output.materialized, false); assert.equal(result.output.imageUrl.startsWith('https:'), true); assert.equal(result.usage.processedImages, 1);
});

test('DeepSeek JSON request uses allowed model and strictly checks finish reason and source-backed attributes', async () => {
  const fact = { id: randomUUID(), name: 'Material', value: 'Cotton' };
  const payload = { productId: randomUUID(), sourceTitle: 'Cloth', variant: { id: randomUUID(), originalSpec: 'Blue', normalizedSpec: 'Blue' }, confirmedFacts: [fact], unverifiedOcr: [] };
  const output = { title: 'Cotton cloth', bullets: ['Cotton material'], description: 'A cotton cloth.', attributes: [{ name: fact.name, value: fact.value, factIds: [fact.id] }] };
  const response = { id: 'chat-fixture', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
  const result = await suggestWithDeepSeek(payload, 'deepseek-flash', { apiKey: 'fixture-deepseek-key' }, signal, { ...context, fetch: async (raw, options) => {
    assert.equal(String(raw), 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(options?.body)); assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.temperature, 0); assert.equal(body.stream, false); assert.equal(body.max_tokens, 4096); assert.deepEqual(body.response_format, { type: 'json_object' });
    return json(response);
  } });
  assert.equal(result.output.kind, 'text'); assert.equal(result.usage.completionTokens, 20);
  for (const invalid of [{ ...response, choices: [{ ...response.choices[0], finish_reason: 'length' }] }, { ...response, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...output, attributes: [{ name: 'Material', value: 'Silk', factIds: [fact.id] }] }) } }] }]) await assert.rejects(suggestWithDeepSeek(payload, 'deepseek-flash', { apiKey: 'fixture-deepseek-key' }, signal, { ...context, fetch: async () => json(invalid) }), (e: unknown) => e instanceof AiError && e.code === 'OUTPUT_INVALID');
});

test('provider HTTP errors and network failures never echo secrets and never retry', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async () => { calls++; return new Response('YourAccessKeySecret https://secret.test/?token=abc', { status }); } }), (e: unknown) => e instanceof AiError && !e.message.includes('YourAccessKeySecret'));
    assert.equal(calls, 1);
  }
  await assert.rejects(recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, signal, { ...context, fetch: async () => { throw new Error('YourAccessKeySecret'); } }), (e: unknown) => e instanceof AiError && e.code === 'NETWORK_ERROR' && !e.message.includes('YourAccessKeySecret'));
});

test('HTTP and business failures preserve safe request IDs and available usage without server messages', async () => {
  const records: unknown[] = [];
  const payload = { productId: randomUUID(), sourceTitle: 'Cloth', variant: { id: randomUUID(), originalSpec: 'Blue', normalizedSpec: 'Blue' }, confirmedFacts: [], unverifiedOcr: [] };
  await assert.rejects(suggestWithDeepSeek(payload, 'deepseek-flash', { apiKey: 'fixture-api-key-secret' }, signal, { ...context, onMetadata: value => records.push(value), fetch: async () => new Response(JSON.stringify({ id: 'failed-chat', error: { message: 'fixture-api-key-secret' }, usage: { prompt_tokens: 7, completion_tokens: 2 } }), { status: 500 }) }), (e: unknown) => e instanceof AiError && e.code === 'PROVIDER_ERROR');
  assert.deepEqual(records[0], { requestId: 'failed-chat', usage: { promptTokens: 7, completionTokens: 2, processedImages: 0 }, usageKnown: true });
  await assert.rejects(segmentWithAidge('https://images.example.test/a.png', { width: 256, height: 256 }, credentials, signal, { ...context, onMetadata: value => records.push(value), fetch: async () => json({ Success: false, Code: 'FreeQuotaExhausted', RequestId: 'failed-seg', Data: { UsageMap: { ProcessedImageCount: 1 } } }) }), (e: unknown) => e instanceof AiError && e.code === 'QUOTA_EXCEEDED');
  assert.deepEqual(records[1], { requestId: 'failed-seg', usage: { promptTokens: 0, completionTokens: 0, processedImages: 1 }, usageKnown: true });
});

test('streamed responses have a byte ceiling and cancellation ends a stalled body', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; } }));
  await assert.rejects(recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, signal, { ...context, maxResponseBytes: 1024, fetch: async () => response }), (e: unknown) => e instanceof AiError && e.code === 'OUTPUT_INVALID');
  assert.equal(cancelled, true);
  const controller = new AbortController();
  const pending = recognizeWithAliyun(Buffer.from('x'), { width: 256, height: 256 }, credentials, controller.signal, { ...context, fetch: async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })) });
  controller.abort(new AiError('TIMEOUT'));
  await assert.rejects(pending, (e: unknown) => e instanceof AiError && e.code === 'TIMEOUT');
});
