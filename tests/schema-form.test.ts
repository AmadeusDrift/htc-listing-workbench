import test from 'node:test';
import assert from 'node:assert/strict';
import { displaySchema, setJsonPath, parseAttributes } from '../src/renderer/schema-form.ts';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';

test('动态字段解析本地引用和条件字段，保留原始枚举代码', () => {
  const root: JsonObject = { $defs: { offer: { type: 'object', properties: { audience: { type: 'string', enum: ['ALL', 'BZR'], enumNames: ['全部', '低价商城'] } } } },
    type: 'object', properties: { offer: { $ref: '#/$defs/offer' } },
    allOf: [{ if: { properties: { parentage: { const: 'CHILD' } } }, then: { properties: { parent_sku: { type: 'string' } }, required: ['parent_sku'] } }] };
  const top = displaySchema(root, root);
  assert.ok((top.properties as JsonObject).parent_sku);
  assert.equal(top.required, undefined);
  const offer = displaySchema((root.properties as JsonObject).offer as JsonObject, root);
  assert.deepEqual(((offer.properties as JsonObject).audience as JsonObject).enum, ['ALL', 'BZR']);
});

test('修改深层数组字段只影响指定路径，不重排其他 SKU 属性', () => {
  const original: JsonObject = { offers: [{ price: 2, audience: 'BZR' }, { price: 3, audience: 'ALL' }], color: 'Blue' };
  const next = setJsonPath(original, ['offers', 1, 'price'], 0);
  assert.equal(((next.offers as JsonObject[])[1]).price, 0);
  assert.equal(((original.offers as JsonObject[])[1]).price, 3);
  const removed = setJsonPath(next, ['color'], undefined);
  assert.equal('color' in removed, false);
  assert.equal((removed.offers as JsonObject[])[0].audience, 'BZR');
});

test('JSON 编辑拒绝非对象和原型污染键，空对象可以保持真实缺失字段', () => {
  assert.deepEqual(parseAttributes('{}'), {});
  assert.throws(() => parseAttributes('[]'), /对象/);
  assert.throws(() => parseAttributes('{"__proto__":{"polluted":true}}'), /字段/);
  assert.throws(() => setJsonPath({}, ['__proto__', 'polluted'], true), /字段/);
  assert.throws(() => parseAttributes('{"price":1e999}'), /数值/);
});

test('条件分支的约束不会覆盖字段类型或隐藏其他分支合法枚举', () => {
  const schema: JsonObject = { type: 'object', properties: { price: { type: 'number', title: 'Price' }, unit: { type: 'string', enum: ['cm', 'in'] } },
    allOf: [{ if: { properties: { kind: { const: 'special' } } }, then: { properties: { price: { minimum: 1 }, unit: { enum: ['cm'] } } } }] };
  const fields = displaySchema(schema, schema).properties as JsonObject;
  assert.equal((fields.price as JsonObject).type, 'number');
  assert.equal((fields.price as JsonObject).title, 'Price');
  assert.deepEqual((fields.unit as JsonObject).enum, ['cm', 'in']);
});

test('条件 const 不缩窄自由字段，新增分支字段保留两种常量', () => {
  const schema: JsonObject = { type: 'object', properties: { unit: { type: 'string' } }, if: { properties: { kind: { const: 'special' } } },
    then: { properties: { unit: { const: 'cm' }, choice: { const: 'A' } } }, else: { properties: { unit: { const: 'in' }, choice: { const: 'B' } } } };
  const fields = displaySchema(schema, schema).properties as JsonObject;
  assert.equal((fields.unit as JsonObject).const, undefined);
  assert.deepEqual((fields.choice as JsonObject).enum, ['A', 'B']);
});
