import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AmazonPersistence } from '../src/main/amazon/persistence.ts';

function fixture(t:test.TestContext) {
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec('CREATE TABLE product_owner(id TEXT PRIMARY KEY); CREATE TABLE source_owner(id TEXT PRIMARY KEY);');
  const port=Object.create(AmazonPersistence.prototype) as AmazonPersistence; port.db=db;
  return {db,port,count:()=>db.prepare('SELECT count(*) n FROM product_owner').get()!.n};
}
test('A05 a second owner failure rolls back both writes on the shared connection',t=>{
  const {db,port,count}=fixture(t);
  assert.throws(()=>port.transaction(()=>{db.prepare('INSERT INTO product_owner VALUES(?)').run('one');db.prepare('INSERT INTO source_owner VALUES(?)').run('one');throw Error('second owner failure');}),/second owner/);
  assert.equal(count(),0); assert.equal(db.prepare('SELECT count(*) n FROM source_owner').get()!.n,0);
});
test('nested owner joins the same transaction and cannot commit the outer operation early',t=>{
  const {db,port,count}=fixture(t);
  port.transaction(()=>{port.transaction(()=>db.prepare('INSERT INTO product_owner VALUES(?)').run('one'));assert.equal(db.isTransaction,true);db.prepare('INSERT INTO source_owner VALUES(?)').run('one');});
  assert.equal(count(),1); assert.equal(db.isTransaction,false);
});
test('async owner callbacks are rejected before their body executes',t=>{
  const {port,count,db}=fixture(t); let executed=false;
  assert.throws(()=>port.transaction(async()=>{executed=true;db.prepare('INSERT INTO product_owner VALUES(?)').run('one');}),/同步|async|Promise/);
  assert.equal(executed,false); assert.equal(count(),0); assert.equal(db.isTransaction,false);
});
test('a thenable result rolls back before returning and a caught nested failure does not leak writes',t=>{
  const {port,count,db}=fixture(t);
  assert.throws(()=>port.transaction(()=>{db.prepare('INSERT INTO product_owner VALUES(?)').run('one');return Promise.resolve();}),/同步|async|Promise/);
  assert.equal(count(),0);
  port.transaction(()=>{
    assert.throws(()=>port.transaction(()=>{db.prepare('INSERT INTO product_owner VALUES(?)').run('bad');throw Error('nested');}),/nested/);
    db.prepare('INSERT INTO product_owner VALUES(?)').run('good');
  });
  assert.deepEqual(db.prepare('SELECT id FROM product_owner').all().map(r=>r.id),['good']);
});
