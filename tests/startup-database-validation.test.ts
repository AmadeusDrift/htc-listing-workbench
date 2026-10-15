import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { beginDatabaseStartupValidation, validateStartupHistory } from '../src/main/startup-database-validation.ts';
import { openDatabase } from '../src/main/database.ts';

function fixture(t: import('node:test').TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'htc-startup-proof-'));
  const db=openDatabase(directory);t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  return { directory, db, path:join(directory,'red.sqlite') };
}
test('startup proof reuses only the same check at the same committed version; outside scope always checks',t=>{
  const f=fixture(t);let count=0;const check=()=>{count++;};
  const finish=beginDatabaseStartupValidation();
  try {
    validateStartupHistory(f.directory,'one',check);validateStartupHistory(f.directory,'one',check);assert.equal(count,1);
    validateStartupHistory(f.directory,'two',check);assert.equal(count,2);
    f.db.exec("INSERT INTO amazon_settings VALUES('proof','{}')");
    validateStartupHistory(f.directory,'one',check);assert.equal(count,3);
    f.db.exec('PRAGMA user_version=37');validateStartupHistory(f.directory,'one',check);assert.equal(count,4);
    f.db.exec('CREATE TABLE proof_schema(id TEXT)');validateStartupHistory(f.directory,'one',check);assert.equal(count,5);
  } finally { finish(); }
  validateStartupHistory(f.directory,'one',check);validateStartupHistory(f.directory,'one',check);assert.equal(count,7);
});
test('failed checks are never cached and commits during a check invalidate the proof',t=>{
  const f=fixture(t);const finish=beginDatabaseStartupValidation();let count=0;
  try {
    for(let i=0;i<2;i++)assert.throws(()=>validateStartupHistory(f.directory,'failure',()=>{count++;throw Error('invalid history');}),/invalid history/);
    assert.equal(count,2);
    validateStartupHistory(f.directory,'write',()=>{count++;f.db.exec("INSERT INTO amazon_settings VALUES('during','{}')");});
    validateStartupHistory(f.directory,'write',()=>{count++;});assert.equal(count,4);
  } finally { finish(); }
});
test('replacing database files cannot inherit the old file proof; observer closes at scope end',t=>{
  const directory=mkdtempSync(join(tmpdir(),'htc-startup-replace-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'red.sqlite');const db=new DatabaseSync(path);db.exec('CREATE TABLE proof(id TEXT)');db.close();
  const finish=beginDatabaseStartupValidation();let count=0;
  try {
    validateStartupHistory(directory,'one',()=>{count++;});
    if(process.platform==='win32') { assert.throws(()=>renameSync(path,join(directory,'old.sqlite')),/EBUSY|EPERM/);finish(); }
    renameSync(path,join(directory,'old.sqlite'));
    const replacement=new DatabaseSync(path);replacement.exec('CREATE TABLE proof(id TEXT)');replacement.close();
    const next=process.platform==='win32'?beginDatabaseStartupValidation():()=>{};
    try { validateStartupHistory(directory,'one',()=>{count++;});assert.equal(count,2); } finally { next(); }
  } finally { finish(); }
  renameSync(path,join(directory,'closed.sqlite'));
});
test('ordinary and startup open both reject corrupted history after another connection commits',t=>{
  const f=fixture(t);const finish=beginDatabaseStartupValidation();
  try {
    openDatabase(f.directory).close();openDatabase(f.directory).close();
    f.db.exec('DROP TABLE product_source_adoptions');
    assert.throws(()=>openDatabase(f.directory));assert.throws(()=>openDatabase(f.directory));
  } finally { finish(); }
  assert.throws(()=>openDatabase(f.directory));
});

