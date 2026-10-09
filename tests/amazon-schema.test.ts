import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';

const implementation = await import('../src/main/amazon/schema.ts').catch(() => null);
function check(schema: JsonObject, value: JsonObject) {
  assert.ok(implementation?.validateAttributes, 'Amazon schema validator must be implemented');
  return implementation.validateAttributes(schema, value);
}

test('Amazon validator checks enums, required and conditional facts without changing data', () => {
  const schema: JsonObject = { type: 'object', properties: {
    audience: { type: 'string', enum: ['ALL', 'BZR'], enumNames: ['全部', '低价商店'], editable: true },
    material: { type: 'string', minLength: 1, hidden: false, $lifecycle: { replaces: [] } },
  }, required: ['audience'], allOf: [{ if: { properties: { audience: { const: 'BZR' } }, required: ['audience'] }, then: { required: ['material'] } }], additionalProperties: false };
  assert.ok(check(schema, {}).some(issue => issue.code.includes('required')));
  assert.ok(check(schema, { audience: 'INVALID' }).some(issue => issue.code.includes('enum')));
  assert.ok(check(schema, { audience: 'BZR' }).some(issue => issue.attributeNames.includes('material')));
  const value = { audience: 'ALL' }; const before = JSON.stringify(value);
  assert.deepEqual(check(schema, value), []);
  assert.equal(JSON.stringify(value), before);
  assert.ok(check({ type: 'object', properties: { count: { type: 'integer', default: 1 } }, required: ['count'] }, {}).length);
  assert.ok(check({ type: 'object', properties: { count: { type: 'integer' } } }, { count: '1' }).length);
});

test('Amazon selectors change uniqueItems identity and min/maxUniqueItems count selected values', () => {
  const schema: JsonObject = { type: 'object', properties: { offers: { type: 'array', selectors: ['marketplace_id', 'audience'], uniqueItems: true,
    items: { type: 'object' } } } };
  assert.ok(check(schema, { offers: [{ marketplace_id: 'US', audience: 'ALL', price: 1 }, { marketplace_id: 'US', audience: 'ALL', price: 2 }] }).length);
  assert.deepEqual(check(schema, { offers: [{ marketplace_id: 'US', audience: 'ALL' }, { marketplace_id: 'US', audience: 'BZR' }] }), []);
  const counted: JsonObject = { type: 'object', properties: { values: { type: 'array', selectors: ['key'], minUniqueItems: 2, maxUniqueItems: 2 } } };
  assert.ok(check(counted, { values: [{ key: 'a', n: 1 }, { key: 'a', n: 2 }] }).length);
  assert.deepEqual(check(counted, { values: [{ key: 'a' }, { key: 'a', n: 2 }, { key: 'b' }] }), []);
  assert.ok(check(counted, { values: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] }).length);
});

test('Amazon UTF-8 rules count bytes rather than JavaScript characters', () => {
  const schema: JsonObject = { type: 'object', properties: { value: { type: 'string', minUtf8ByteLength: 3, maxUtf8ByteLength: 6 } } };
  assert.deepEqual(check(schema, { value: '中文' }), []);
  assert.ok(check(schema, { value: '中英文' }).length);
  assert.ok(check(schema, { value: 'ab' }).length);
});

test('Unknown assertions, unsupported required vocabulary and unresolved refs fail closed', () => {
  const schemas: JsonObject[] = [
    { type: 'object', futureAmazonAssertion: true },
    { type: 'object', $vocabulary: { 'https://untrusted.example/assertions': true } },
    { type: 'object', properties: { x: { $ref: 'https://untrusted.example/schema' } } },
  ];
  for (const schema of schemas) assert.ok(check(schema, { x: 'value' }).some(issue => issue.severity === 'ERROR' && issue.code === 'SCHEMA_UNSUPPORTED'));
});

test('Selector deep identity ignores property insertion order and preserves ordinary uniqueness', () => {
  const schema: JsonObject = { type: 'object', properties: { values: { type: 'array', uniqueItems: true } } };
  assert.ok(check(schema, { values: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }).length);
  assert.deepEqual(check(schema, { values: [{ a: 1 }, { a: 2 }] }), []);
});
