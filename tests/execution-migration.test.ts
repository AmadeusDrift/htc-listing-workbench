import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase, SCHEMA_VERSION } from '../src/main/database.ts';

test('v4 persists hosting and execution records while preserving existing products', t => {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'execution-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let db = openDatabase(directory);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
    for (const table of ['hosting_profiles', 'hosting_uploads', 'execution_tasks']) {
      db.prepare(`INSERT INTO ${table}(id,record_json) VALUES(?,?)`).run('example', '{"status":"PAUSED"}');
    }
  } finally { db.close(); }
  db = openDatabase(directory);
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM execution_tasks').get()!.n, 1); }
  finally { db.close(); }
});
