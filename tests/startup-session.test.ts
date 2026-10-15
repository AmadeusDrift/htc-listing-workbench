import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openDatabase } from '../src/main/database.ts';
import { snapshotWorkspaceDatabase } from '../src/main/database-snapshots.ts';
import { consumeStartupReceipt, saveCleanShutdownReceipt } from '../src/main/startup-session.ts';

const codec={encode:(text:string)=>Buffer.from(text).toString('base64'),decode:(text:string)=>Buffer.from(text,'base64').toString()};
async function fixture(){const root=mkdtempSync(resolve('.test-data/startup-session-'));openDatabase(root).close();const snapshot=await snapshotWorkspaceDatabase(root);assert(snapshot);return{root,snapshot};}
test('only a completed clean shutdown permits one matching quick startup',async()=>{
  const f=await fixture();assert.equal((await consumeStartupReceipt(f.root,'build-a',codec)).mode,'full');
  await saveCleanShutdownReceipt(f.root,'build-a',f.snapshot,codec);
  assert.equal((await consumeStartupReceipt(f.root,'build-a',codec)).mode,'quick');
  assert.equal((await consumeStartupReceipt(f.root,'build-a',codec)).mode,'full');
});
test('upgrade, changed database, missing snapshot and unavailable secure credential use full checks',async()=>{
  const f=await fixture();
  await saveCleanShutdownReceipt(f.root,'build-a',f.snapshot,codec);assert.equal((await consumeStartupReceipt(f.root,'build-b',codec)).mode,'full');
  await saveCleanShutdownReceipt(f.root,'build-a',f.snapshot,codec);const db=openDatabase(f.root);db.exec("INSERT INTO amazon_settings VALUES('changed','{}')");db.close();
  assert.equal((await consumeStartupReceipt(f.root,'build-a',codec)).mode,'full');
  await saveCleanShutdownReceipt(f.root,'build-a',f.snapshot,codec);writeFileSync(f.snapshot,'invalid snapshot');assert.equal((await consumeStartupReceipt(f.root,'build-a',codec)).mode,'full');
  assert.equal((await consumeStartupReceipt(f.root,'build-a')).mode,'full');
});
test('invalid credential never changes business records or authorizes quick startup',async()=>{
  const f=await fixture(),before=readFileSync(join(f.root,'red.sqlite'));
  writeFileSync(join(f.root,'startup-clean.enc'),'invalid');assert.equal((await consumeStartupReceipt(f.root,'build-a',codec)).mode,'full');
  assert.deepEqual(readFileSync(join(f.root,'red.sqlite')),before);
});
