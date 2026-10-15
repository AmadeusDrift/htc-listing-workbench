import test from 'node:test';
import assert from 'node:assert/strict';
import { startVisiblePolling } from '../src/renderer/visible-polling.ts';

test('hidden observation resumes immediately and stopping an in-flight read cannot revive its timer', async () => {
  let visible = false, notify = () => {}, reads = 0, release: (() => void) | undefined;
  const stop = startVisiblePolling(async () => { reads++; await new Promise<void>(done => { release = done; }); return 10; }, {
    visible: () => visible, subscribe: listener => { notify = listener; return () => { notify = () => {}; }; }
  });
  assert.equal(reads, 0);
  visible = true; notify(); assert.equal(reads, 1);
  visible = false; notify(); release!(); await new Promise(done => setTimeout(done, 25)); assert.equal(reads, 1);
  visible = true; notify(); assert.equal(reads, 2);
  stop(); release!(); await new Promise(done => setTimeout(done, 25)); assert.equal(reads, 2);
});
