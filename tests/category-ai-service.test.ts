import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, isCode, json } from './fixtures/ai-control.ts';

for (const phase of ['keywords', 'select', 'judge'] as const) {
  const providerId = phase === 'judge' ? 'deepseek-review' : 'deepseek';
  test(`category ${phase} reaches the provider through the real usage ledger`, async t => {
    const f = await fixture(t, { fetch: async () => json({ id: 'category-fixture',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ kind: 'category-decision', phase,
        keywords: ['cleaning cloth', 'cloth'], productType: phase === 'keywords' ? null : 'CLEANING_CLOTH', reason: 'Cotton cloth.', ambiguous: false }) } }],
      usage: { prompt_tokens: 23, completion_tokens: 17, total_tokens: 40 } }) });
    f.enable(providerId);
    const input = { productId: f.imageInput.productId, productRevision: f.imageInput.productRevision, phase,
      candidates: phase === 'keywords' ? [] : [{ name: 'CLEANING_CLOTH', displayName: 'Cleaning cloth' }] };
    // Quota must still stop the same production request before any network call.
    f.service.setUsagePolicy({ providerId, dailyCallLimit: 0, dailyTokenLimit: null });
    await assert.rejects(f.service.decideCategory(input), isCode('QUOTA_EXCEEDED'));
    assert.equal(f.requests.length, 0);
    f.service.setUsagePolicy({ providerId, dailyCallLimit: null, dailyTokenLimit: null });
    const result = await f.service.decideCategory(input);
    assert.equal(result.output.phase, phase);
    assert.equal(f.requests.length, 1);
    const request = JSON.parse(String(f.requests[0].options?.body));
    assert.equal(request.model, 'deepseek-flash');
    assert.ok(request.messages[1].content.some((part: { type: string }) => part.type === 'image_url'));
    assert.equal(f.service.listCalls()[0].status, 'SUCCEEDED');
    assert.equal(f.service.getUsageSummary(providerId).reportedTokens, 40);
  });

  test(`category ${phase} keeps a durable reservation for an ambiguous network failure`, async t => {
    const f = await fixture(t, { fetch: async () => { throw Error('offline fixture'); } });
    f.enable(providerId);
    await assert.rejects(f.service.decideCategory({ productId: f.imageInput.productId,
      productRevision: f.imageInput.productRevision, phase,
      candidates: phase === 'keywords' ? [] : [{ name: 'CLEANING_CLOTH', displayName: 'Cleaning cloth' }] }), isCode('NETWORK_ERROR'));
    assert.equal(f.requests.length, 1);
    assert.equal(f.service.listCalls()[0].errorCode, 'NETWORK_ERROR');
    const usage = f.service.getUsageSummary(providerId);
    assert.equal(usage.unknownCalls, 1);
    assert.ok(usage.reservedTokens > 4096);
  });
}
