import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDeepSeekJson } from '../src/main/ai/adapters.ts';
import { requestTokenReservation } from '../src/main/ai/usage.ts';

test('shared JSON mode always supplies the explicit JSON instruction required by DeepSeek', async () => {
  let requests = 0;
  const result = await requestDeepSeekJson({ operation: 'listing-current-review' }, 'Return exactly {"ok":true}.',
    'deepseek-v4-pro', { apiKey: 'fixture-only-key' }, new AbortController().signal, {
      now: () => new Date(), nonce: () => 'fixture', maxResponseBytes: 10000,
      beforeSend: body => { assert.ok(requestTokenReservation('deepseek-review', body) > 16384); },
      fetch: async (_url, options) => {
        requests++;
        const body = JSON.parse(String(options?.body));
        const hasInstruction = body.messages.some((m: { content: unknown }) => typeof m.content === 'string' && /\bjson\b/i.test(m.content));
        if (!hasInstruction) return new Response(JSON.stringify({ error: { message: 'messages must contain json' } }), { status: 400 });
        return new Response(JSON.stringify({ id: 'fixture-json-mode', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 42, completion_tokens: 5 } }));
      },
    }, 16384);
  assert.deepEqual(result.content, { ok: true });
  assert.equal(requests, 1);
});
