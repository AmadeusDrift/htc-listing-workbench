import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateAiProfile, validateAiCall, validateAiResult, parseProfileImport, parseRecognizeInput, parseSuggestInput, ossImageUrl } from '../src/main/ai/validation.ts';
import { AiError } from '../src/main/ai/errors.ts';

const at = '2026-09-30T00:00:00.000Z';
const profile = { id: 'aliyun-ocr', capability: 'ocr', model: 'RecognizeAllText/Commerce', enabled: false, configured: false, generation: 0 };
const call = { id: randomUUID(), providerId: profile.id, productId: randomUUID(), productRevision: 1, status: 'RUNNING', errorCode: null, requestId: null, model: profile.model, generation: 1, startedAt: at, finishedAt: null, usage: { promptTokens: 0, completionTokens: 0, processedImages: 0 } };
const result = { id: randomUUID(), callId: call.id, providerId: profile.id, productId: call.productId, productRevision: 1, variantId: null, assetId: randomUUID(), assetSha256: 'a'.repeat(64), sourceResultIds: [], model: profile.model, createdAt: at, reviewState: 'unreviewed', output: { kind: 'ocr', text: 'Cotton', lines: [{ text: 'Cotton', confidence: 0.98, box: null }], width: 256, height: 256, coordinateSpace: 'unknown' } };

test('AI records accept only exact public keys and consistent provider/model/output unions', () => {
  assert.deepEqual(validateAiProfile(profile), profile);
  assert.deepEqual(validateAiCall(call), call);
  assert.deepEqual(validateAiResult(result), result);
  for (const value of [{ ...profile, apiKey: 'secret' }, { ...profile, model: 'General' }, { ...profile, capability: 'text' }, { ...profile, enabled: true }]) assert.throws(() => validateAiProfile(value));
  for (const value of [{ ...call, credentials: {} }, { ...call, status: 'FAILED' }, { ...call, status: 'SUCCEEDED', finishedAt: at, errorCode: 'TIMEOUT' }, { ...call, usage: { ...call.usage, token: 'secret' } }]) assert.throws(() => validateAiCall(value));
  for (const value of [{ ...result, providerId: 'deepseek' }, { ...result, variantId: randomUUID() }, { ...result, reviewState: 'approved' }, { ...result, sourceResultIds: [randomUUID()] }, { ...result, output: { ...result.output, coordinateSpace: 'original' } }, { ...result, output: { ...result.output, lines: [{ text: 'x', confidence: 101, box: null }] } }]) assert.throws(() => validateAiResult(value));
  assert.throws(() => validateAiResult({ ...result, output: { ...result.output, text: '' } }));
  assert.throws(() => validateAiResult({ ...result, output: { ...result.output, width: 8000, height: 16 } }));
});

test('call status must be a primitive string enum so restart recovery cannot skip malformed RUNNING records', () => {
  for (const status of [['RUNNING'], { toString: () => 'RUNNING' }, new String('RUNNING'), null, undefined, 0, true]) assert.throws(() => validateAiCall({ ...call, status }));
  assert.equal(validateAiCall(call).status, 'RUNNING');
  assert.equal(validateAiCall({ ...call, status: 'SUCCEEDED', finishedAt: at }).status, 'SUCCEEDED');
  assert.equal(validateAiCall({ ...call, status: 'FAILED', errorCode: 'INTERRUPTED', finishedAt: at }).status, 'FAILED');
});

test('strict config import rejects endpoints, embedded secrets, and unsupported DeepSeek models', () => {
  const config = { id: 'aliyun-ocr', accessKeyId: 'fixture-key-id', accessKeySecret: 'fixture-secret' };
  assert.equal(parseProfileImport(config).id, config.id);
  assert.equal(parseProfileImport({ id: 'deepseek', model: 'deepseek-flash', apiKey: 'fixture-api-key' }).model, 'deepseek-flash');
  assert.deepEqual(parseProfileImport({ ...config, securityToken: '' }), parseProfileImport(config));
  for (const value of [{ ...config, endpoint: 'https://evil.test' }, { ...config, accessKeySecret: 'bad\nsecret' }, { id: 'deepseek', model: 'deepseek-chat', apiKey: 'fixture-api-key' }, { id: 'deepseek', model: 'deepseek-flash', apiKey: 'deepseek-flash' }]) assert.throws(() => parseProfileImport(value), AiError);
});

test('review provider is a distinct text-review profile with its own allowed DeepSeek models', () => {
  const review = { id: 'deepseek-review', capability: 'text-review', model: 'deepseek-v4-pro', enabled: false, configured: false, generation: 0 };
  assert.deepEqual(validateAiProfile(review), review);
  assert.equal(parseProfileImport({ id: 'deepseek-review', model: 'deepseek-v4-pro', apiKey: 'fixture-review-key' }).id, 'deepseek-review');
  assert.equal(parseProfileImport({ id: 'deepseek-review', model: 'deepseek-flash', apiKey: 'fixture-review-key' }).model, 'deepseek-flash');
  assert.throws(() => validateAiProfile({ ...review, capability: 'text' }));
  assert.throws(() => parseProfileImport({ id: 'deepseek-review', model: 'deepseek-chat', apiKey: 'fixture-review-key' }));
});

test('persisted OCR with Han summary must retain at least one Han block without requiring text equality', () => {
  assert.throws(() => validateAiResult({ ...result, output: { ...result.output, text: '棉 Cotton cloth' } }));
  const valid = { ...result, output: { ...result.output, text: '棉 Cotton cloth', lines: [{ text: 'Cotton 棉花', confidence: 0.986, box: null }] } };
  assert.deepEqual(validateAiResult(valid), valid);
});

test('request IDs and selected OCR references are bounded UUIDs without caller paths or URLs', () => {
  const input = { productId: call.productId, productRevision: 1, assetId: result.assetId };
  assert.deepEqual(parseRecognizeInput(input), input);
  assert.throws(() => parseRecognizeInput({ ...input, path: 'C:/secret.png' }));
  assert.throws(() => parseRecognizeInput({ ...input, assetId: '../../escape' }));
  const text = { productId: call.productId, productRevision: 1, variantId: randomUUID(), ocrResultIds: [result.id] };
  assert.deepEqual(parseSuggestInput(text), text);
  assert.throws(() => parseSuggestInput({ ...text, ocrResultIds: [result.id, result.id] }));
  assert.throws(() => parseSuggestInput({ ...text, ocrResultIds: Array.from({ length: 11 }, () => randomUUID()) }));
  assert.throws(() => parseSuggestInput({ ...text, ocrResultIds: new Array(1) }));
  assert.throws(() => validateAiResult({ ...result, output: { ...result.output, lines: new Array(1) } }));
});

test('only Alibaba OSS result URLs are accepted, with legacy HTTP upgraded to HTTPS', () => {
  assert.equal(ossImageUrl('http://output.oss-cn-shanghai.aliyuncs.com/out.png?Expires=123&Signature=abc'), 'https://output.oss-cn-shanghai.aliyuncs.com/out.png?Expires=123&Signature=abc');
  for (const url of ['https://evil.test/out.png', 'https://oss-cn-shanghai.aliyuncs.com.evil.test/out.png', 'https://user:pass@output.oss-cn-shanghai.aliyuncs.com/a', 'https://output.oss-cn-shanghai.aliyuncs.com:444/a', 'https://output.oss-cn-shanghai-internal.aliyuncs.com/a', 'file:///C:/secret.png', 'https://output.oss-cn-shanghai.aliyuncs.com/a#secret']) assert.throws(() => ossImageUrl(url));
});

test('text result attributes cannot suggest identity, price, stock, brand, or compliance fields', () => {
  const base = { ...result, providerId: 'deepseek', model: 'deepseek-flash', variantId: randomUUID(), assetId: null, assetSha256: null, output: { kind: 'text', title: 'Cotton cloth', bullets: ['Soft cloth'], description: 'Cotton cloth.', attributes: [{ name: 'Material', value: 'Cotton', factIds: [randomUUID()] }] } };
  assert.deepEqual(validateAiResult(base), base);
  for (const name of ['brand', 'external_product_id', 'GTIN', 'recommendedPrice', 'purchase_price', 'inventory', 'compliance_certification', '商品编码', '品牌', '认证']) assert.throws(() => validateAiResult({ ...base, output: { ...base.output, attributes: [{ name, value: 'bad', factIds: [randomUUID()] }] } }));
  assert.throws(() => validateAiResult({ ...base, output: { ...base.output, attributes: [{ name: 'Material', value: 'Cotton', factIds: [] }] } }));
});

test('protected Chinese aliases and English field tokens remain forbidden in suggestions', () => {
  const output = { kind: 'text', title: 'Product', bullets: ['Confirmed information'], description: 'Product description.', attributes: [] };
  const base = { ...result, providerId: 'deepseek', model: 'deepseek-flash', variantId: randomUUID(), assetId: null, assetSha256: null, output };
  const named = (name: string) => ({ ...base, output: { ...output, attributes: [{ name, value: 'Confirmed value', factIds: [randomUUID()] }] } });
  for (const name of ['采购价', '进货价', '购入成本', '成本价', '售价', '销售价', '零售价', '批发价', '制造商', '生产商', '厂商', '厂牌', '生产厂家', '销售授权', 'purchasePrice', 'unitCost', 'cost_price', 'manufacturerPartNumber', 'externally_assigned_product_identifier', 'GTIN14', 'upcCode', 'apiKey', 'fulfillment_availability', 'purchasable_offer']) assert.throws(() => validateAiResult(named(name)), name);
});

test('normal English words containing protected short identifiers remain valid attribute names', () => {
  for (const name of ['Cup capacity', 'cupCapacity', 'cup_capacity', 'Costume type', 'costumeType', 'costume_type', 'European size', 'Cleaning method', 'Capacity', '服装类型', '杯容量']) {
    const value = { ...result, providerId: 'deepseek', model: 'deepseek-flash', variantId: randomUUID(), assetId: null, assetSha256: null, output: { kind: 'text', title: 'Product', bullets: ['Confirmed information'], description: 'Product description.', attributes: [{ name, value: 'Confirmed value', factIds: [randomUUID()] }] } };
    assert.equal(validateAiResult(value).output.kind, 'text', name);
  }
});
