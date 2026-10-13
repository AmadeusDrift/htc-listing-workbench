import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { openDatabase } from '../src/main/database.ts';

test('all physical tables have a declared owner; shared settings require a key',async t=>{
  const path='../src/main/storage/owners.ts';
  assert.ok(existsSync(new URL(path,import.meta.url)),'owner registry must exist');
  const {dataOwner}=await import(path);
  const root=resolve('.test-data'); mkdirSync(root,{recursive:true}); const directory=mkdtempSync(join(root,'owners-'));
  const db=openDatabase(directory);t.after(()=>{db.close();assert.equal(dirname(resolve(directory)),root);rmSync(directory,{recursive:true,force:true});});
  for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    if(row.name==='amazon_settings')continue;
    assert.ok(dataOwner(String(row.name)),String(row.name));
  }
  assert.equal(dataOwner('amazon_settings','accepted_sku_v1:sku'),'publish');
  assert.equal(dataOwner('amazon_settings','listing_copy_review_v1'),'listing');
  assert.throws(()=>dataOwner('amazon_settings'),/键|key/);
  assert.throws(()=>dataOwner('unknown_table'),/未登记|unknown/);
});
