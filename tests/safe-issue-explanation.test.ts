import test from 'node:test';
import assert from 'node:assert/strict';
import { safeIssueExplanation } from '../src/shared/safe-issue-explanation.ts';
test('preserves actionable field reasons while hiding links, local paths and credentials', () => {
 const text = safeIssueExplanation('bullet_point 第2项缺少颜色依据；来源 https://secret.invalid/?token=secret ，API_KEY=secret Authorization: Bearer abc123 C:\\Users\\private\\data.json');
 assert.match(text,/第2项缺少颜色依据/); assert.doesNotMatch(text,/secret|abc123|private|https:\/\//); assert.match(text,/已隐藏/);
});
test('normal statements, false and zero remain readable', () => {
 assert.equal(safeIssueExplanation('count=0；contains_liquid=false；请补充材料。'),'count=0；contains_liquid=false；请补充材料。');
 assert.equal(safeIssueExplanation(''), '未保存具体说明。');
});

test('quoted JSON credential labels are redacted without removing useful reason', () => {
 const text = safeIssueExplanation('材料依据不足 {"apiKey":"secret-value", "accessKeySecret":"hidden-value"}');
 assert.match(text,/材料依据不足/); assert.doesNotMatch(text,/secret-value|hidden-value/);
});
