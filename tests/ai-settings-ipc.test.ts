import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fixture, storage } from './fixtures/ai-control.ts';
import { AiService } from '../src/main/ai/service.ts';

async function handler(f: Awaited<ReturnType<typeof fixture>>) {
  const compiled = await build({ entryPoints: ['src/main/ai-ipc.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'electron-dialog-stub', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const dialog = {};' }));
    } }] });
  const { installAiIpc } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  installAiIpc({}, f.service, f.store, (name: string, _arity: number, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn));
  return handlers.get('red:ai:function-settings')!;
}

test('actual settings IPC saves independent thinking flags and retains keys across restart and model changes', async t => {
  const f = await fixture(t); f.service.saveConnection({ id: 'deepseek', apiKey: 'synthetic-shared-key' });
  const save = await handler(f);
  for (const id of ['deepseek', 'deepseek-review'] as const) {
    const value = save({ id, model: f.service.getProfile(id).model, enabled: true, thinking: id === 'deepseek' }) as { profiles: { id: string; thinking?: boolean }[] };
    assert.equal(value.profiles.find(p => p.id === id)!.thinking, id === 'deepseek');
  }
  save({ id: 'deepseek', model: 'deepseek-v4-pro', enabled: true });
  assert.equal(f.service.getProfile('deepseek').thinking, true);
  await f.service.close();
  const restarted = new AiService(f.directory, f.store, f.hosting, storage);
  try {
    assert.equal(restarted.getProfile('deepseek').thinking, true);
    assert.equal(restarted.getProfile('deepseek-review').thinking, false);
    assert.ok(restarted.listProfiles().filter(p => p.id.startsWith('deepseek')).every(p => p.configured));
  } finally { await restarted.close(); }
  assert.equal(f.requests.length, 0);
});

test('invalid IPC settings do not mutate saved profiles', async t => {
  const f = await fixture(t); f.enable('deepseek'); const save = await handler(f), before = f.service.listProfiles();
  for (const extra of [{ thinking: 'true' }, { enabled: 'yes' }, { unexpected: true }]) {
    assert.throws(() => save({ id: 'deepseek', model: 'deepseek-flash', enabled: true, ...extra }));
    assert.deepEqual(f.service.listProfiles(), before);
  }
});
