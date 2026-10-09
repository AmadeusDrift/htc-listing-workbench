import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore } from '../src/main/store.ts';
import { MiaoshouService } from '../src/main/miaoshou/service.ts';
import type { MiaoshouImageService } from '../src/main/miaoshou/images.ts';
import { installMiaoshouIpc } from '../src/main/miaoshou-ipc.ts';
import { testMiaoshouStorage } from './helpers/miaoshou-fixture.ts';

test('Miaoshou IPC supports file and direct entry, rejects invalid configs and returns no credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'htc-ms-ipc-')), store = new WorkspaceStore(root), service = new MiaoshouService(root, store, testMiaoshouStorage());
  const callbacks = new Map<string, (...args: unknown[]) => unknown>(); let selected = '', template = '';
  installMiaoshouIpc(service, {} as MiaoshouImageService, (name, _count, callback) => callbacks.set(name, callback), {
    selectConfig: async () => ({ canceled: !selected, filePaths: selected ? [selected] : [] }),
    saveTemplate: async content => { template = content; return { cancelled: false }; },
  });
  const call = async (name: string, ...args: unknown[]) => callbacks.get(`red:miaoshou:${name}`)!(...args);
  try {
    assert.equal(callbacks.size, 24); assert.deepEqual(await call('config-import'), { cancelled: true });
    const saved = await call('config-save', { appKey: 'direct-application-key', appSecret: 'direct-secret-content' });
    assert.ok(saved && typeof saved === 'object' && 'configured' in saved);
    assert.equal(saved.configured, true); assert.equal(JSON.stringify(saved).includes('direct-secret-content'), false);
    await assert.rejects(call('config-save', { appKey: 'bad', appSecret: 'bad' }));
    assert.deepEqual(await call('status'), saved);
    await call('config-template'); assert.deepEqual(Object.keys(JSON.parse(template)).sort(), ['appKey', 'appSecret']);
    selected = join(root, 'config.json'); writeFileSync(selected, '{"appSecret":"SECRET_IN_BAD_JSON');
    await assert.rejects(call('config-import'), error => error instanceof Error && /UTF-8 JSON/.test(error.message) && !error.message.includes('SECRET_IN_BAD_JSON'));
    writeFileSync(selected, Buffer.alloc(65537)); await assert.rejects(call('config-import'), /64 KB/);
    writeFileSync(selected, Buffer.from([0xff, 0xfe])); await assert.rejects(call('config-import'), /UTF-8 JSON/);
    writeFileSync(selected, '\ufeff' + JSON.stringify({ appKey: 'example-application-key', appSecret: 'secret-example-content' }));
    const imported = await call('config-import'); assert.equal(JSON.stringify(imported).includes('secret-example-content'), false);
    assert.equal(service.getStatus().mode, 'live');
    await call('mode', 'demo'); const listed = await call('list', { pageNo: 1, pageSize: 20 }); assert.ok(JSON.stringify(listed).includes('demo-single'));
    await assert.rejects(call('sync-start', { pageSize: 501 }));
    await call('sync-start', { pageSize: 500 });
    while (service.getSyncStatus().status === 'running') await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await call('sync-status'), service.getSyncStatus());
    assert.equal(service.getSyncStatus().discovered, 3);
    assert.deepEqual(await call('sync-items', { page: 1, pageSize: 20, filter: 'all' }), service.listSyncItems({ page: 1, pageSize: 20, filter: 'all' }));
    const preview = await call('sync-preview', { id: 'demo-single' }); assert.ok(JSON.stringify(preview).includes('previewId'));
    await call('disconnect'); assert.equal(service.getStatus().configured, false);
  } finally { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
