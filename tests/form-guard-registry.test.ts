import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormGuardRegistry } from '../src/renderer/form-guard-registry.ts';
test('guards save in order and stop on failure without discarding pending input', async () => {
 const registry = createFormGuardRegistry(); const events: string[] = [];
 registry.register('sku', { dirty: () => true, save: async () => { events.push('sku'); return false; }, discard: () => events.push('discard') });
 registry.register('purpose', { dirty: () => true, save: async () => { events.push('purpose'); return true; }, discard: () => {} });
 assert.equal(registry.dirty(), true); assert.equal(await registry.save(), false); assert.deepEqual(events, ['sku']);
});
test('clean browsing does not guard and unmount unregisters only its own form', async () => {
 const registry = createFormGuardRegistry(); let dirty = false;
 const unregister = registry.register('form', { dirty: () => dirty, save: async () => true, discard: () => { dirty = false; } });
 assert.equal(registry.dirty(), false); dirty = true; assert.equal(registry.dirty(), true); registry.discard(); assert.equal(registry.dirty(), false);
 dirty = true; unregister(); assert.equal(registry.dirty(), false);
});
