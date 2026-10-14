import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { AiService } from '../src/main/ai/service.ts';
import { AiVault } from '../src/main/ai/vault.ts';
import { postOpenRouter } from '../src/main/ai/adapters/openrouter-http.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { storage } from './fixtures/ai-control.ts';

// Synthetic strings only; never use userData, environment credentials or real fetch.
const first = 'SYNTHETIC_OPENROUTER_FIRST', second = 'SYNTHETIC_OPENROUTER_SECOND', deepseek = 'SYNTHETIC_DEEPSEEK_SEPARATE';
function fixture(t: TestContext) {
  const root = resolve('.test-data'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, 'openrouter-key-pipeline-'));
  const store = new WorkspaceStore(directory), hosting = new HostingService(directory, store, storage);
  const noNetwork: typeof fetch = async () => { throw new Error('Real transport forbidden in credential regression'); };
  const open = () => new AiService(directory, store, hosting, storage, { fetch: noNetwork });
  let service = open();
  t.after(async () => {
    await service.close(); await hosting.close(); store.close();
    const child = relative(root, resolve(directory));
    assert.ok(child.startsWith('openrouter-key-pipeline-') && !child.includes('..'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { get service() { return service; }, vault: new AiVault(directory, storage), restart: async () => { await service.close(); service = open(); } };
}

test('synthetic shared OpenRouter save survives restart and remains separate from DeepSeek', async t => {
  const f = fixture(t);
  f.service.saveConnection({ id: 'deepseek', apiKey: deepseek });
  f.service.saveConnection({ id: 'openrouter', apiKey: first });
  await f.restart();
  for (const id of ['openrouter', 'openrouter-review', 'deepseek', 'deepseek-review'] as const) {
    const profile = f.service.getProfile(id), saved = f.vault.read(id, profile.generation);
    assert.ok('apiKey' in saved && saved.apiKey === (id.startsWith('openrouter') ? first : deepseek), 'provider-specific synthetic credential must survive restart');
  }
  assert.ok(!JSON.stringify(f.service.listConnections()).includes(first), 'public metadata must not contain synthetic credentials');
});

test('synthetic OpenRouter rotation updates the next Bearer and source-understanding routing without a stale cache', async t => {
  const f = fixture(t); let calls = 0;
  f.service.saveConnection({ id: 'deepseek', apiKey: deepseek });
  f.service.saveConnection({ id: 'openrouter', apiKey: first });
  f.service.saveFunctionSettings({ id: 'openrouter', model: 'openai/gpt-6-luna', enabled: true });
  const purpose = f.service.getPurposeProfiles().find(p => p.purposeId === 'source_understanding')!;
  f.service.savePurposeProfile({ purposeId: purpose.purposeId, expectedRevision: purpose.revision, patch: { gateway: 'openrouter', model: 'openai/gpt-6-luna', effort: 'none' } });
  const previousGeneration = f.service.getProfile('openrouter').generation;
  for (const expected of [first, second]) {
    if (expected === second) f.service.saveConnection({ id: 'openrouter', apiKey: second });
    const profile = f.service.purposeProfile('source_understanding', true);
    assert.equal(profile.id, 'openrouter');
    const credentials = f.vault.read(profile.id, profile.generation);
    assert.ok('apiKey' in credentials);
    await postOpenRouter('/api/v1/chat/completions', { model: profile.model }, credentials, new AbortController().signal, {
      fetch: async (url, init) => {
        calls++; assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
        assert.ok(new Headers(init?.headers).get('authorization') === 'Bearer ' + expected, 'Bearer must match the selected synthetic credential');
        return new Response('{}');
      }, now: () => new Date(), nonce: () => '', maxResponseBytes: 1024,
    });
  }
  assert.equal(calls, 2);
  assert.equal(f.vault.inspect('openrouter', previousGeneration).state, 'metadata-mismatch');
  assert.ok(f.service.openRouterApiKey() === second, 'main-process shared port must see rotation');
  await f.restart(); assert.ok(f.service.openRouterApiKey() === second, 'rotation must persist across restart');
  const other = f.vault.read('deepseek', f.service.getProfile('deepseek').generation);
  assert.ok('apiKey' in other && other.apiKey === deepseek, 'rotation must not replace another provider credential');
});

test('empty saves and cross-provider reuse cannot replace a saved synthetic OpenRouter credential', t => {
  const f = fixture(t); f.service.saveConnection({ id: 'openrouter', apiKey: first });
  f.service.saveConnection({ id: 'deepseek', apiKey: deepseek });
  const before = f.service.getProfile('openrouter');
  for (const apiKey of ['', '   ']) assert.throws(() => f.service.saveConnection({ id: 'openrouter', apiKey }));
  assert.throws(() => f.service.reuseConnection({ id: 'openrouter', sourceId: 'deepseek' }));
  assert.deepEqual(f.service.getProfile('openrouter'), before);
  assert.ok(f.service.openRouterApiKey() === first, 'rejected operations must retain the prior synthetic key');
});
