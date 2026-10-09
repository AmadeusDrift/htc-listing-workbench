import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeWithAliyun, segmentWithAidge } from '../src/main/ai/adapters.ts';
import { AiError } from '../src/main/ai/errors.ts';

const credentials = { accessKeyId: 'fixture-access-id', accessKeySecret: 'fixture-secret' };
const base = { now: () => new Date('2026-10-07T10:00:00Z'), nonce: () => 'fixture-request', maxResponseBytes: 4096 };
test('Aidge NoPermission explains service permission without blaming saved credentials or exposing server details', async () => {
  for (const status of [403, 200]) {
    let attempts = 0;
    const context = { ...base, fetch: async () => { attempts++; return new Response(JSON.stringify({ Success: false, Code: 'NoPermission', Message: 'fixture-secret', RequestId: 'permission-repro' }), { status }); } };
    await assert.rejects(segmentWithAidge('https://images.example.test/source.png', { width: 800, height: 800 }, credentials, new AbortController().signal, context), (e: unknown) => {
      assert.ok(e instanceof AiError); assert.equal(e.code, 'SERVICE_PERMISSION_REQUIRED'); assert.match(e.message, /权限/); assert.doesNotMatch(e.message, /鉴权失败|fixture-secret/); return true;
    });
    assert.equal(attempts, 1);
  }
});
test('OCR unsupportedImageFormat identifies the input image for HTTP and business error responses', async () => {
  for (const status of [415, 200]) {
    await assert.rejects(recognizeWithAliyun(Buffer.from('invalid-image-fixture'), { width: 256, height: 256 }, credentials, new AbortController().signal, {
      ...base, fetch: async () => new Response(JSON.stringify({ Code: 'unsupportedImageFormat', Message: 'fixture-secret' }), { status }),
    }), (e: unknown) => e instanceof AiError && e.code === 'IMAGE_INVALID' && !e.message.includes('fixture-secret'));
  }
});
test('signature failures and generic authorization responses retain their distinct authentication error', async () => {
  for (const Code of ['SignatureDoesNotMatch', 'InvalidAccessKeyId.NotFound', undefined]) {
    await assert.rejects(segmentWithAidge('https://images.example.test/source.png', { width: 800, height: 800 }, credentials, new AbortController().signal, {
      ...base, fetch: async () => new Response(JSON.stringify({ Code }), { status: 403 }),
    }), (e: unknown) => e instanceof AiError && e.code === 'AUTH_FAILED');
  }
});
