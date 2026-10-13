import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { persistImport, getReceipt } from '../src/main/miaoshou/persistence.ts';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { detailFixture, mappingFor } from './helpers/miaoshou-fixture.ts';
import { saveInput, mockStorage } from './fixtures/listing-ai.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore } from '../src/main/backup.ts';
import { previewSourceAdoption,adoptSource } from '../src/main/products/public.ts';
import { assertSourceAdoptionHistory } from '../src/main/products/source-adoption.ts';
import { ImageGenerationService } from '../src/main/image-generation/service.ts';
import { DEFAULT_OPENROUTER_IMAGE_MODEL } from '../src/shared/image-generation-contracts.ts';

function fixture(t:test.TestContext){
  t.mock.method(globalThis,'fetch',()=>{throw Error('No external requests');});
  const root=resolve('.test-data');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'source-adoption-'));
  const store=new WorkspaceStore(directory),db=openDatabase(directory);
  t.after(()=>{db.close();store.close();assert.equal(dirname(directory),root);rmSync(directory,{recursive:true,force:true});});
  const source=normalizeDetail(detailFixture(),'2026-10-13T00:00:00.000Z','demo',v=>v);
  const receive=(snapshot=source,scope='a'.repeat(64))=>persistImport(db,store,snapshot,mappingFor(snapshot),scope,'demo','2026-10-13T01:00:00.000Z');
  return{source,store,db,receive,directory};
}
test('A07 same account supplier identity has one master and preserves stable local SKUs across collection IDs',t=>{
  const f=fixture(t),first=f.receive(),product=f.store.getProduct(first.productId);
  const second=f.receive({...f.source,remoteId:'other-collection',title:'Updated source title'});
  assert.equal(second.productId,first.productId);assert.equal(f.store.listProducts().length,1);
  const updated=f.store.getProduct(first.productId);
  assert.equal(updated.title,'Updated source title');assert.deepEqual(updated.variants.map(v=>[v.id,v.sku]),product.variants.map(v=>[v.id,v.sku]));
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_snapshots').get()!.n,2);
  assert.equal(f.receive(f.source,'b'.repeat(64)).productId===first.productId,false);
});
test('A08 edited master retains incoming version without overwriting human facts or original receipt',t=>{
  const f=fixture(t),first=f.receive(),product=f.store.getProduct(first.productId);
  const old=String(f.db.prepare('SELECT record_json FROM miaoshou_receipts').get()!.record_json);
  f.store.saveProduct({...saveInput(product),title:'Human title'});
  assert.equal(f.receive({...f.source,title:'Supplier update'}).productId,first.productId);
  assert.equal(f.store.getProduct(first.productId).title,'Human title');
  assert.equal(getReceipt(f.db,first.productId)!.snapshot.title,f.source.title);
  assert.equal(String(f.db.prepare('SELECT record_json FROM miaoshou_receipts').get()!.record_json),old);
  const state=JSON.parse(String(f.db.prepare('SELECT record_json FROM product_source_adoptions WHERE id=?').get(first.productId)!.record_json));
  assert.notEqual(state.latestSnapshotId,state.adoptedSnapshotId);
});
test('A08/A09 creating one draft freezes the whole source product, including its other variants',async t=>{
  let amazon:AmazonService;t.after(()=>amazon?.close());const f=fixture(t),first=f.receive(),product=f.store.getProduct(first.productId);
  amazon=new AmazonService(f.directory,id=>f.store.getProduct(id),mockStorage);const target=amazon.enableDemo();
  await amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  const before=JSON.stringify(f.store.getProduct(product.id));f.receive({...f.source,title:'Too late',skus:f.source.skus.map(s=>({...s,price:'888'}))});
  assert.equal(JSON.stringify(f.store.getProduct(product.id)),before);
  const state=JSON.parse(String(f.db.prepare('SELECT record_json FROM product_source_adoptions WHERE id=?').get(product.id)!.record_json));
  assert.equal(state.frozen,true);assert.notEqual(state.latestSnapshotId,state.adoptedSnapshotId);
  const preview=previewSourceAdoption(f.db,product.id)!;
  assert.throws(()=>adoptSource(f.db,{productId:product.id,expectedRevision:preview.expectedRevision,snapshotId:preview.snapshotId,confirmReplaceManual:true}),/冻结/);
});
test('A07 no reliable supplier identity never merges by title alone',t=>{
  const f=fixture(t),a=f.receive({...f.source,sources:[]}),b=f.receive({...f.source,sources:[],remoteId:'second-record'});
  assert.notEqual(a.productId,b.productId);
});

test('supplier A to B to A reuses immutable evidence but adopts the latest received content',t=>{
  const f=fixture(t),first=f.receive();f.receive({...f.source,title:'Version B'});
  assert.equal(f.store.getProduct(first.productId).title,'Version B');
  f.receive(f.source);assert.equal(f.store.getProduct(first.productId).title,f.source.title);
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_snapshots').get()!.n,2);
});

test('standalone image generation with no source assets freezes the product before a paid request',async t=>{
  let generation:ImageGenerationService;t.after(async()=>generation?.close());const f=fixture(t),first=f.receive(),product=f.store.getProduct(first.productId);
  const png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(256,16);png.writeUInt32BE(256,20);
  generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{
    f.receive({...f.source,title:'Supplier changed while generating'});
    return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
  }});
  generation.saveConnection({provider:'openrouter',model:DEFAULT_OPENROUTER_IMAGE_MODEL,enabled:true,apiKey:'sk-isolated-fixture-key'});
  const candidate=await generation.generate({productId:product.id,productRevision:product.revision,prompt:'Product photo',referenceAssetIds:[],size:'auto',quality:'auto',background:'auto'});
  assert.equal(candidate.productRevision,product.revision);assert.equal(f.store.getProduct(product.id).title,product.title);
  assert.equal(previewSourceAdoption(f.db,product.id)!.frozen,true);
});

test('A05 import receipt failure rolls back source version, master, variants and adoption together',t=>{
  const f=fixture(t);f.db.exec("CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON miaoshou_receipts BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  assert.throws(()=>f.receive());
  for(const table of ['products','variants','facts','source_snapshots','product_source_adoptions','product_fact_scopes'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,table);
});

test('A08 explicit source adoption checks current revisions and retains the replaced human values in audit',t=>{
  const f=fixture(t),first=f.receive(),product=f.store.getProduct(first.productId);
  const manual=f.store.saveProduct({...saveInput(product),title:'Human title'});f.receive({...f.source,title:'Incoming title'});
  const preview=previewSourceAdoption(f.db,product.id)!;
  assert.equal(preview.requiresManualConfirmation,true);assert.equal(preview.frozen,false);
  const input={productId:product.id,expectedRevision:preview.expectedRevision,snapshotId:preview.snapshotId,confirmReplaceManual:false};
  assert.throws(()=>adoptSource(f.db,input),/人工修改/);
  assert.throws(()=>adoptSource(f.db,{...input,expectedRevision:manual.revision-1,confirmReplaceManual:true}),/版本已变化/);
  adoptSource(f.db,{...input,confirmReplaceManual:true});
  assert.equal(f.store.getProduct(product.id).title,'Incoming title');
  assert.equal(previewSourceAdoption(f.db,product.id)!.pending,false);
  assert.ok(JSON.stringify(f.db.prepare("SELECT * FROM audit_events WHERE action='product.source-adopted'").all()).includes('Human title'));
});

test('A09 read-only receipt access does not rewrite old JSON; backups retain pending and adopted versions',async t=>{
  const f=fixture(t),first=f.receive(),product=f.store.getProduct(first.productId);
  f.store.saveProduct({...saveInput(product),title:'Human'});f.receive({...f.source,title:'Pending supplier version'});
  const before=f.db.prepare('SELECT id,record_json FROM source_snapshots ORDER BY id').all();
  getReceipt(f.db,product.id);getReceipt(f.db,product.id);
  assert.deepEqual(f.db.prepare('SELECT id,record_json FROM source_snapshots ORDER BY id').all(),before);
  const file=join(f.directory,'source.htcbackup'),target=join(f.directory,'restored');
  await createWorkspaceBackup(f.directory,file,'source-test-passphrase');
  const prepared=await prepareWorkspaceRestore(target,file,'source-test-passphrase');await commitWorkspaceRestore(target,prepared);
  const restored=openDatabase(target);try{
    assert.deepEqual(restored.prepare('SELECT id,record_json FROM source_snapshots ORDER BY id').all(),before);
    assert.equal(getReceipt(restored,product.id)!.snapshot.title,f.source.title);
  }finally{restored.close();}
});

test('source history rejects a lookalike table that removed primary key protection',t=>{
  const f=fixture(t);f.receive();
  f.db.exec('ALTER TABLE source_snapshots RENAME TO fixture_original; CREATE TABLE source_snapshots(id TEXT NOT NULL,record_json TEXT NOT NULL); INSERT INTO source_snapshots SELECT * FROM fixture_original;');
  assert.throws(()=>assertSourceAdoptionHistory(f.db),/结构|索引/);
});
