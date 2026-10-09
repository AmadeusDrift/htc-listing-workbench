import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';

test('workspace restore removes both image provider keys and selection without importing credentials or candidate cache', async t => {
  mkdirSync(resolve('.test-data'), { recursive: true }); const root = mkdtempSync(resolve('.test-data/image-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), target = join(root, 'target'), file = join(root, 'images.htcbackup');
  for (const directory of [source, target]) {
    const store = new WorkspaceStore(directory); store.createProduct(); store.close();
    mkdirSync(join(directory, 'ai-vault'));
    for (const name of ['openai-images.bin', 'tyai-images.bin', 'image-provider.json']) writeFileSync(join(directory, 'ai-vault', name), 'private configuration fixture');
  }
  mkdirSync(join(source, 'image-generation', 'candidates'), { recursive: true });
  writeFileSync(join(source, 'image-generation', 'candidates', 'cache-sentinel.txt'), 'unreviewed candidate');
  await createWorkspaceBackup(source, file, 'isolated image backup passphrase');
  const prepared = await prepareWorkspaceRestore(target, file, 'isolated image backup passphrase'); await commitWorkspaceRestore(target, prepared);
  assert.equal(existsSync(join(target, 'ai-vault', 'openai-images.bin')), false);
  assert.equal(existsSync(join(target, 'ai-vault', 'tyai-images.bin')), false);
  assert.equal(existsSync(join(target, 'ai-vault', 'image-provider.json')), false);
  assert.equal(existsSync(join(target, 'image-generation')), false);
  assert.equal(existsSync(join(source, 'ai-vault', 'openai-images.bin')), true);
  assert.equal(existsSync(join(source, 'ai-vault', 'tyai-images.bin')), true);
});
