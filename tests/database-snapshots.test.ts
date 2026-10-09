import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import { snapshotWorkspaceDatabase } from '../src/main/database-snapshots.ts';

test('snapshot includes committed WAL changes and retains product placements after reopening', async () => {
 const root=mkdtempSync(resolve('.test-data/database-snapshot-')),store=new WorkspaceStore(root);
 try {
  const p=store.createProduct();store.moveWorkspaceProducts({productIds:[p.id],destination:'automatic'});
  const path=await snapshotWorkspaceDatabase(root);assert(path);
  const saved=new DatabaseSync(path,{readOnly:true});
  try {assert.equal(saved.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(saved.prepare('SELECT lane FROM product_workspaces WHERE product_id=?').get(p.id)?.lane,'automatic');assert.equal(saved.prepare('SELECT count(*) AS n FROM products').get()!.n,1);}finally{saved.close();}
 }finally{store.close();}
});

test('corruption stops snapshot creation without overwriting the database or last good snapshot',async()=>{
 const root=mkdtempSync(resolve('.test-data/database-corrupt-')),store=new WorkspaceStore(root);store.createProduct();store.close();
 const good=await snapshotWorkspaceDatabase(root);assert(good);const before=readFileSync(good);
 const broken=Buffer.from('broken sqlite database');writeFileSync(join(root,'red.sqlite'),broken);
 await assert.rejects(snapshotWorkspaceDatabase(root),/数据库完整性检查未通过/);
 assert.deepEqual(readFileSync(join(root,'red.sqlite')),broken);assert.deepEqual(readFileSync(good),before);
 assert.equal(readdirSync(join(root,'database-snapshots')).filter(n=>n.endsWith('.sqlite')).length,1);
});

test('a new workspace is not populated by the snapshot guard',async()=>{
 const root=mkdtempSync(resolve('.test-data/database-empty-'));assert.equal(await snapshotWorkspaceDatabase(root),null);assert.deepEqual(readdirSync(root),[]);
});

test('a truncated existing database is not accepted as a new empty workspace',async()=>{
 const root=mkdtempSync(resolve('.test-data/database-truncated-')),store=new WorkspaceStore(root);store.createProduct();store.close();
 const good=await snapshotWorkspaceDatabase(root);assert(good);const before=readFileSync(good);
 writeFileSync(join(root,'red.sqlite'),Buffer.alloc(0));
 await assert.rejects(snapshotWorkspaceDatabase(root),/数据库完整性检查未通过/);
 assert.equal(readFileSync(join(root,'red.sqlite')).length,0);assert.deepEqual(readFileSync(good),before);
 assert.equal(readdirSync(join(root,'database-snapshots')).filter(n=>n.endsWith('.sqlite')).length,1);
});

test('snapshot rotation retains ten standalone databases without temporary WAL/SHM files',async()=>{
 const root=mkdtempSync(resolve('.test-data/database-rotation-')),store=new WorkspaceStore(root);store.createProduct();store.close();
 for(let i=0;i<11;i++)await snapshotWorkspaceDatabase(root);
 const files=readdirSync(join(root,'database-snapshots'));assert.equal(files.length,10);assert(files.every(n=>n.endsWith('.sqlite')));
});
