import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, isCode, json } from './fixtures/ai-control.ts';

for (const phase of ['keywords', 'select', 'judge'] as const) {
  const providerId = phase === 'keywords' ? 'deepseek' : phase === 'select' ? 'openrouter' : 'openrouter-review';
  test(`category ${phase} reaches the provider through the real usage ledger`, async t => {
    const f = await fixture(t, { fetch: async () => json(phase==='select'?{id:'category-fixture',answers:{category:{type:'choice',choice:'CLEANING_CLOTH'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:23,output_tokens:17}}:{ id: 'category-fixture',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ kind: 'category-decision', phase,
        keywords: ['cleaning cloth', 'cloth'], productType: phase === 'keywords' ? null : 'CLEANING_CLOTH', reason: 'Cotton cloth.', ambiguous: false }) } }],
      usage: { prompt_tokens: 23, completion_tokens: 17, total_tokens: 40 } }) });
    if(providerId==='deepseek')f.enable(providerId);else{f.service.saveConnection({id:'openrouter',apiKey:'category-openrouter-fixture'});f.service.setEnabled({id:providerId,enabled:true});}
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
    assert.equal(request.model, phase==='keywords'?'deepseek-flash':phase==='select'?'openai/gpt-6-luna-decisions':'openai/gpt-6-luna');
    assert.ok((phase==='select'?request.state:request.messages[1].content).some((part: { type: string }) => part.type === 'image_url'));
    if(phase==='select')assert.ok(f.requests[0].url.endsWith('/api/alpha/decisions'));
    assert.equal(f.service.listCalls()[0].status, 'SUCCEEDED');
    assert.equal(f.service.getUsageSummary(providerId).reportedTokens, 40);
  });

  test(`category ${phase} keeps a durable reservation for an ambiguous network failure`, async t => {
    const f = await fixture(t, { fetch: async () => { throw Error('offline fixture'); } });
    if(providerId==='deepseek')f.enable(providerId);else{f.service.saveConnection({id:'openrouter',apiKey:'category-openrouter-fixture'});f.service.setEnabled({id:providerId,enabled:true});}
    await assert.rejects(f.service.decideCategory({ productId: f.imageInput.productId,
      productRevision: f.imageInput.productRevision, phase,
      candidates: phase === 'keywords' ? [] : [{ name: 'CLEANING_CLOTH', displayName: 'Cleaning cloth' }] }), isCode('NETWORK_ERROR'));
    assert.equal(f.requests.length, 1);
    assert.equal(f.service.listCalls()[0].errorCode, 'NETWORK_ERROR');
    const usage = f.service.getUsageSummary(providerId);
    assert.equal(usage.unknownCalls, 1);
    if(phase==='select'){assert.equal(usage.unboundedCalls,1);assert.equal(usage.usedTokens,null);}else assert.ok(usage.reservedTokens > 4096);
  });
}
