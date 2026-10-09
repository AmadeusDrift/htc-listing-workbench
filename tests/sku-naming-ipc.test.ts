import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';

test('SKU IPC exposes validated settings and non-allocating preview only', async t => {
  const module = await import('../src/main/sku-naming-ipc.ts').catch(() => null);
  assert.ok(module, 'SKU settings IPC must exist');
  mkdirSync(resolve('.test-data'), { recursive: true });
  const directory = mkdtempSync(join(resolve('.test-data'), 'sku-naming-ipc-')), service = new SkuNamingService(directory);
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  const handlers = new Map<string, { count: number; run: (...args: unknown[]) => unknown }>();
  const audits: string[] = [];
  module.installSkuNamingIpc(service, (channel, count, run) => { handlers.set(channel, { count, run }); }, { audit: action => audits.push(action) });
  assert.deepEqual([...handlers].map(([key, value]) => [key, value.count]), [['red:sku-naming:settings', 0], ['red:sku-naming:save', 1], ['red:sku-naming:preview', 1]]);
  const initial = handlers.get('red:sku-naming:settings')!.run();
  assert.deepEqual(initial, service.getSettings());
  handlers.get('red:sku-naming:preview')!.run({ storeCode: 'U2', collectedAt: '2026-10-08T12:00:00+08:00', sequence: 101, childCount: 2 });
  assert.deepEqual(audits, []);
  handlers.get('red:sku-naming:save')!.run(initial);
  assert.deepEqual(audits, ['sku-naming.settings-saved']);
  assert.throws(() => handlers.get('red:sku-naming:save')!.run(initial), /更改|刷新/);
  assert.throws(() => handlers.get('red:sku-naming:preview')!.run({ storeCode: 'U2', collectedAt: '2026-10-08T00:00:00Z', sequence: 1, childCount: 0, execute: 'malicious' }), /SKU/);
  assert.equal(service.allocate({ storeScope: 'live:seller', storeCode: 'U2', sourceGroupKey: 'first', collectedAt: '2026-10-08T00:00:00Z', childKeys: [] }).sequence, 1);
});
