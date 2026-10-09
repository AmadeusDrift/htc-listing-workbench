import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openDatabase } from '../src/main/database.ts';

test('automatic tasks and label jobs survive database reopen without changing existing records', t => {
  mkdirSync(resolve('.test-data'), { recursive: true });
  const directory = mkdtempSync(join(resolve('.test-data'), 'automatic-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let db = openDatabase(directory);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    assert.ok(tables.includes('automatic_listing_tasks'), 'durable preparation task storage must exist');
    assert.ok(tables.includes('item_labels'), 'label file/version storage must exist');
    assert.ok(tables.includes('shipment_documents'), 'manual shipment document storage must exist');
    db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run('task', '{"status":"PAUSED"}');
    db.prepare('INSERT INTO item_labels VALUES(?,?)').run('label', '{"status":"READY"}');
  } finally { db.close(); }
  db = openDatabase(directory);
  try {
    assert.equal(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get('task')!.record_json, '{"status":"PAUSED"}');
    assert.equal(db.prepare('SELECT count(*) AS n FROM item_labels').get()!.n, 1);
  } finally { db.close(); }
});
