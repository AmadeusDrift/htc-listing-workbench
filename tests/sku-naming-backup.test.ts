import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';

const password = 'sku-naming-backup-test-2026';
const input = (sourceGroupKey: string, childKeys = ['red']) => ({ storeScope: 'live:seller-2', storeCode: 'U2', sourceGroupKey, collectedAt: '2026-10-08T00:00:00Z', childKeys });
async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(resolve('.test-data/sku-naming-backup-'));
  const source = join(root, 'source'), destination = join(root, 'restored'), archive = join(root, 'naming.htcbackup');
  const service = new SkuNamingService(source);
  const cleanup: (() => void)[] = [() => service.close()];
  t.after(async () => { for (const close of cleanup.reverse()) close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, source, destination, archive, service, cleanup };
}

test('backup roundtrip restores templates, immutable allocations and the next per-day sequence', async t => {
  const { source, destination, archive, service, cleanup } = await fixture(t);
  const first = service.allocate(input('first'));
  const settings = service.getSettings(); settings.templates[0].prefixes.U2 = 'EDITED';
  const saved = service.saveSettings(settings);
  service.allocate(input('second')); service.allocate(input('third')); service.close();
  await createWorkspaceBackup(source, archive, password);
  await commitWorkspaceRestore(destination, await prepareWorkspaceRestore(destination, archive, password));
  const restored = new SkuNamingService(destination); cleanup.push(() => restored.close());
  assert.deepEqual(restored.getSettings(), saved);
  assert.deepEqual(restored.lookup(first.storeScope, first.sourceGroupKey), first);
  assert.equal(restored.allocate(input('fourth')).baseSku, 'EDITED-261008-4');
  assert.equal(restored.allocate(input('first', ['red', 'blue'])).children[1].sku, 'H2-261008-1-B');
});

test('restoring an older backup retains allocations acquired both before and after restore preparation', async t => {
  const { source, archive, service, cleanup } = await fixture(t);
  service.allocate(input('first')); await createWorkspaceBackup(source, archive, password);
  const second = service.allocate(input('second'));
  const prepared = await prepareWorkspaceRestore(source, archive, password);
  const expanded = service.allocate(input('first', ['red', 'green']));
  const third = service.allocate(input('third')); service.close();
  await commitWorkspaceRestore(source, prepared);
  const restored = new SkuNamingService(source); cleanup.push(() => restored.close());
  assert.deepEqual(restored.lookup(second.storeScope, second.sourceGroupKey), second);
  assert.deepEqual(restored.lookup(third.storeScope, third.sourceGroupKey), third);
  assert.deepEqual(restored.lookup(expanded.storeScope, expanded.sourceGroupKey), expanded);
  assert.equal(restored.allocate(input('fourth')).sequence, 4);
});

test('backup rejects forged allocation records that disagree with the immutable SKU identity ledger', async t => {
  const { source, archive, service } = await fixture(t);
  const group = service.allocate(input('first')); service.close();
  const db = openDatabase(source);
  try { const forged = { ...group, baseSku: 'FORGED-SKU' }; db.prepare('UPDATE sku_naming_groups SET record_json=? WHERE id=?').run(JSON.stringify(forged), group.id); }
  finally { db.close(); }
  await assert.rejects(createWorkspaceBackup(source, archive, password), /SKU/);
});

test('backup rejects regressed sequences and unsafe saved templates', async t => {
  const { root, source, service } = await fixture(t);
  service.allocate(input('first')); service.allocate(input('second')); service.saveSettings(service.getSettings()); service.close();
  const db = openDatabase(source);
  try {
    db.exec('UPDATE sku_naming_sequences SET last_sequence=1');
    await assert.rejects(createWorkspaceBackup(source, join(root, 'regressed.htcbackup'), password), /SKU/);
    db.exec('UPDATE sku_naming_sequences SET last_sequence=2');
    const settings = JSON.parse(String(db.prepare("SELECT value_json FROM amazon_settings WHERE key='sku_naming_v1'").get()!.value_json));
    settings.templates[0].basePattern = '{prefix}-{date}-{sequence}-{eval}';
    db.prepare("UPDATE amazon_settings SET value_json=? WHERE key='sku_naming_v1'").run(JSON.stringify(settings));
    await assert.rejects(createWorkspaceBackup(source, join(root, 'unsafe.htcbackup'), password), /SKU/);
  } finally { db.close(); }
});

test('backup rejects an altered allocation table whose uniqueness guarantees were removed', async t => {
  const { source, archive, service } = await fixture(t);
  service.allocate(input('first')); service.close();
  const db = openDatabase(source);
  try { db.exec('PRAGMA foreign_keys=OFF; ALTER TABLE sku_naming_sequences RENAME TO old_sequences; CREATE TABLE sku_naming_sequences (store_scope TEXT NOT NULL, collection_date TEXT NOT NULL, last_sequence INTEGER NOT NULL); INSERT INTO sku_naming_sequences SELECT * FROM old_sequences; DROP TABLE old_sequences;'); }
  finally { db.close(); }
  await assert.rejects(createWorkspaceBackup(source, archive, password), /SKU/);
});
