import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCurrentFailures } from '../src/main/diagnostics/current-failures.ts';

test('current errors count distinct products per cause, excluding screened and stale history', () => {
  const row = (productId: string, code = 'FIELDS_UNKNOWN', stage = 'DRAFT') => ({ productId, stage, status: 'FAILED', code, kind: 'UNKNOWN', reason: '原请求结果未知' });
  const result = summarizeCurrentFailures([row('p1'), row('p1'), row('p2'), row('p1', 'PLAN_UNKNOWN', 'IMAGES'),
    { ...row('p3'), status: 'SCREENED' }, { ...row('p4'), status: 'PENDING' }]);
  assert.equal(result.affectedProducts, 2); assert.equal(result.failedSalesItems, 4);
  assert.deepEqual(result.groups.map(g => [g.code, g.productCount, g.salesItemCount]), [['FIELDS_UNKNOWN', 2, 3], ['PLAN_UNKNOWN', 1, 1]]);
});

test('same code preserves different field failures and redacts private data', () => {
  const rows = ['color', 'mounting_type'].map(field => ({ productId: 'p1', status: 'FAILED', stage: 'DRAFT', code: 'FIELD_REQUIRED', kind: 'NEEDS_INPUT', reason: `${field} 缺失 https://private.test/token API_key=secret-123; Authorization: Bearer private-token-123` }));
  const result = summarizeCurrentFailures(rows);
  assert.equal(result.groups.length, 2); assert.equal(result.affectedProducts, 1);
  assert.doesNotMatch(JSON.stringify(result), /private.test|secret-123|private-token-123/);
  assert.equal(summarizeCurrentFailures([{ ...rows[0], code: 'https://secret.test', stage: 'body=secret' }]).groups[0].code, 'UNCLASSIFIED_FAILURE');
});
