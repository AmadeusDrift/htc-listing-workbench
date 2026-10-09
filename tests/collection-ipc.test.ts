import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IpcHandler } from '../src/main/amazon-ipc.ts';

test('collection IPC registers only narrow status, preparation, fixed-folder and receipt capabilities', async () => {
  const subject = await import('../src/main/collection-ipc.ts').catch(() => null); assert.ok(subject, 'collection IPC is required');
  const handlers = new Map<string, { count: number; run: (...args: unknown[]) => unknown }>();
  const handle: IpcHandler = (channel, count, run) => { handlers.set(channel, { count, run }); };
  subject.installCollectionIpc('unused-without-service', handle, undefined, async () => { throw new Error('must not open'); });
  assert.deepEqual([...handlers].map(([channel, value]) => [channel, value.count]), [
    ['red:collection:status', 0], ['red:collection:prepare', 0], ['red:collection:open-directory', 0], ['red:collection:receipt', 1],
  ]);
  const status = handlers.get('red:collection:status')!.run() as { state: string }; assert.equal(status.state, 'unavailable');
  assert.equal(handlers.get('red:collection:receipt')!.run(randomUUID()), null);
  assert.throws(() => handlers.get('red:collection:receipt')!.run('../../path'));
  await assert.rejects(Promise.resolve().then(() => handlers.get('red:collection:prepare')!.run()), /APP_UNAVAILABLE/);
  await assert.rejects(Promise.resolve().then(() => handlers.get('red:collection:open-directory')!.run()), /APP_UNAVAILABLE/);
});
