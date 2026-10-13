import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { assertProductFactModels,readProductFactModel,writeProductFactModel } from '../src/main/products/fact-models.ts';
import { persistImport } from '../src/main/miaoshou/persistence.ts';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { detailFixture,mappingFor } from './helpers/miaoshou-fixture.ts';

test('Schema30 creates only model storage; old adoption bytes and unmarked legacy semantics survive migration',t=>{
  mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/fact-model-migration-'));
  let store=new WorkspaceStore(dir),db=openDatabase(dir);t.after(()=>{db.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const source={...normalizeDetail(detailFixture(),'2026-10-13T00:00:00.000Z','demo',v=>v),attributes:[]};
  const received=persistImport(db,store,source,mappingFor(source),'a'.repeat(64),'demo','2026-10-13T01:00:00.000Z'),legacy=store.createProduct();
  const raw=String(db.prepare('SELECT record_json FROM product_source_adoptions WHERE id=?').get(received.productId)!.record_json);
  db.exec('DROP TABLE product_fact_models; DELETE FROM module_migration_journal WHERE version=30; PRAGMA user_version=29');db.close();store.close();
  store=new WorkspaceStore(dir);db=openDatabase(dir);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,30);assert.equal(db.prepare('SELECT count(*) n FROM product_fact_models').get()!.n,0,'migration must not fabricate old model records');
  assert.equal(String(db.prepare('SELECT record_json FROM product_source_adoptions WHERE id=?').get(received.productId)!.record_json),raw);
  assert.equal(store.getProduct(received.productId).factScopeModelVersion,1);assert.equal(store.getProduct(legacy.id).factScopeModelVersion,undefined);assertProductFactModels(db);
});

test('fact model records enforce ownership, exact versions, duplicate keys and main-product deletion cascade',t=>{
  mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/fact-model-validation-'));
  const store=new WorkspaceStore(dir),db=openDatabase(dir);t.after(()=>{db.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const p=store.createProduct(),other=store.createProduct();writeProductFactModel(db,p.id);const good=String(db.prepare('SELECT record_json FROM product_fact_models WHERE id=?').get(p.id)!.record_json);
  for(const update of [{version:2},{scopeModelVersion:2},{productId:other.id},{extra:true}]){
    db.prepare('UPDATE product_fact_models SET record_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(good),...update}),p.id);
    assert.throws(()=>assertProductFactModels(db),/事实模型/);assert.throws(()=>readProductFactModel(db,p.id),/事实模型/);
  }
  db.prepare('UPDATE product_fact_models SET record_json=? WHERE id=?').run(good.replace('"version":1','"version":1,"version":1'),p.id);assert.throws(()=>assertProductFactModels(db),/重复/);
  db.prepare('UPDATE product_fact_models SET record_json=? WHERE id=?').run(good,p.id);assertProductFactModels(db);
  db.prepare('UPDATE audit_events SET product_id=NULL WHERE product_id=?').run(p.id);
  db.prepare('DELETE FROM products WHERE id=?').run(p.id);assert.equal(db.prepare('SELECT 1 FROM product_fact_models WHERE id=?').get(p.id),undefined);assertProductFactModels(db);
});
