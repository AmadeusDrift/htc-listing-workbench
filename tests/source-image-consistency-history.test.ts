import { consistencyFixture } from './helpers/source-consistency.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { addSourceOriginalFixture } from './helpers/source-consistency-proof.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { saveInput } from './fixtures/listing-ai.ts';
import { resolveConsistencyContext, consistencyScopeKey, consistencyDecisionKey, validateConsistencyContext } from '../src/main/source-image-consistency/scope.ts';
import { assertConsistencyHistory, reserveConsistencyAttempt, retainConsistencyAttempts } from '../src/main/source-image-consistency/history.ts';
import { collectionSnapshot } from './helpers/collection-fixture.ts';
import { MiaoshouImageService } from '../src/main/miaoshou/images.ts';
import { prepareImageWorkflowSources } from '../src/main/image-workflow/sources.ts';
import { createWorkspaceBackup,prepareWorkspaceRestore } from '../src/main/backup.ts';

test('local originals have distinct identity; title reuse and binding epoch are separate from send scope',t=>{
  const f=consistencyFixture(t),a=f.context();assert.deepEqual(a.identity,{kind:'local-original'});assert.equal(a.referenceAssets[0].anchorId,null);
  let p=f.store.getProduct(f.p.id);p=f.store.saveProduct({...saveInput(p),title:'Cosmetic title'});
  const b=f.context();assert.equal(consistencyScopeKey(a),consistencyScopeKey(b));assert.equal(consistencyDecisionKey(a),consistencyDecisionKey(b));
  p=f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets[0].id,role:'main',variantIds:[]});
  p=f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets[0].id,role:'main',variantIds:[p.variants[0].id]});
  const c=f.context();assert.equal(consistencyScopeKey(a),consistencyScopeKey(c));assert.notEqual(consistencyDecisionKey(a),consistencyDecisionKey(c));
  assert.deepEqual(validateConsistencyContext(c),c);assert.throws(()=>validateConsistencyContext({...c,claims:[]}));
});
test('resolver rechecks managed bytes and exact current spec without changing old context',t=>{
  const f=consistencyFixture(t),a=f.context();let p=f.store.getProduct(f.p.id);
  f.store.saveProduct({...saveInput(p),variants:saveInput(p).variants.map(v=>({...v,normalizedSpec:'Red square'}))});
  assert.notEqual(consistencyScopeKey(f.context()),consistencyScopeKey(a));assert.ok(f.context().issues.includes('RAW_NORMALIZED_CONFLICT'));
  writeFileSync(resolve(f.directory,f.store.getAssetRecord(f.p.assets[0].id)!.originalPath),Buffer.alloc(33));assert.throws(f.context);
});
test('schema20 strict unique attempts survive independent connections and older snapshot without invented assessment',t=>{
  const f=consistencyFixture(t),context=f.context(),call={id:randomUUID(),startedAt:new Date().toISOString()};
  f.db.exec('BEGIN IMMEDIATE');reserveConsistencyAttempt(f.db,context,call);f.db.exec('COMMIT');
  const other=openDatabase(f.directory);try{assert.throws(()=>reserveConsistencyAttempt(other,context,{...call,id:randomUUID()}));assert.equal(assertConsistencyHistory(other,f.directory).length,0);}finally{other.close();}
  const backupDir=resolve(f.directory,'old');const old=openDatabase(backupDir);
  try{old.exec('BEGIN IMMEDIATE');retainConsistencyAttempts(f.db,old);old.exec('COMMIT');assert.equal(old.prepare('SELECT count(*) n FROM source_consistency_attempts').get()!.n,1);assert.equal(old.prepare('SELECT count(*) n FROM source_consistency_assessments').get()!.n,0);assert.deepEqual(assertConsistencyHistory(old),[]);}finally{old.close();}
  const row=f.db.prepare('SELECT record_json FROM source_consistency_attempts').get()!;f.db.prepare('UPDATE source_consistency_attempts SET record_json=?').run(String(row.record_json).replace('{','{"unknown":true,'));assert.throws(()=>assertConsistencyHistory(f.db));
});
test('native scope is exact receipt/provider SKU/anchor, and cannot use orphan or sibling',async t=>{
  const f=consistencyFixture(t),snapshot=collectionSnapshot();snapshot.skus=snapshot.skus.slice(0,1).map(s=>({...s,originalSpec:'Blue round',attributes:[{name:'Color',value:'Blue'}]}));snapshot.skuImages=[{providerSkuId:snapshot.skus[0].providerSkuId,imageId:snapshot.images[0].id,basis:'provider-sku-id',specName:null,specValue:null}];
  let p=f.store.getProduct(f.store.receiveCollectionSnapshot(randomUUID(),snapshot).productId);
  const input=()=>({productId:p.id,productRevision:f.store.getProduct(p.id).revision,variantId:p.variants[0].id});assert.throws(()=>resolveConsistencyContext(f.db,f.store,f.directory,input()));
  const images=new MiaoshouImageService(f.directory,f.store,()=>null,b=>b,{download:async()=>{const b=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(256,16);b.writeUInt32BE(256,20);return b;}});
  try{await prepareImageWorkflowSources(f.store,f.db,{getReceipt:()=>null,images},{productId:p.id,productRevision:f.store.getProduct(p.id).revision,variantIds:[p.variants[0].id]},new AbortController().signal);
    const c=resolveConsistencyContext(f.db,f.store,f.directory,input());assert.equal(c.identity.kind,'native1688');assert.ok(c.referenceAssets[0].anchorId);assert.ok(c.fields.some(x=>x.id==='receipt.attributes.0'&&x.value==='Blue'));
    f.db.prepare('DELETE FROM source_image_provenance WHERE id=?').run(c.referenceAssets[0].anchorId);
    const legacy=resolveConsistencyContext(f.db,f.store,f.directory,input());assert.equal(legacy.identity.kind,'native1688');assert.equal(legacy.referenceAssets[0].source,'local-original');assert.equal(legacy.referenceAssets[0].anchorId,null);
  }finally{await images.close();}
});
test('backup includes strict decision history and validates original byte hashes after unbinding',async t=>{
  const f=consistencyFixture(t),context=f.context(),id=randomUUID();
  const decision={version:'source-image-consistency/v1',id,context,fingerprint:consistencyDecisionKey(context),assessmentId:null,decision:'CONFIRMED',reason:'Checked synthetic original against this selected spec',createdAt:new Date().toISOString()};
  f.db.prepare('INSERT INTO source_consistency_decisions VALUES(?,?)').run(id,JSON.stringify(decision));
  const p=f.store.getProduct(f.p.id);f.store.updateAsset({productId:p.id,revision:p.revision,assetId:p.assets[0].id,role:'gallery',variantIds:[]});
  assert.equal(assertConsistencyHistory(f.db,f.directory).length,1);
  const path=resolve(f.directory,'good.htcbackup');await createWorkspaceBackup(f.directory,path,'synthetic-long-passphrase');
  const restored=await prepareWorkspaceRestore(f.directory,path,'synthetic-long-passphrase');assert.ok(restored.stagingDirectory);
  writeFileSync(resolve(f.directory,f.store.getAssetRecord(p.assets[0].id)!.originalPath),Buffer.alloc(33));
  assert.throws(()=>new WorkspaceStore(f.directory));await assert.rejects(createWorkspaceBackup(f.directory,resolve(f.directory,'bad.htcbackup'),'synthetic-long-passphrase'));
});

test('schema20 rejects altered primary key semantics and rolls back the corruption probe',t=>{
  const f=consistencyFixture(t);
  for(const ddl of ['id TEXT COLLATE NOCASE PRIMARY KEY NOT NULL,record_json TEXT NOT NULL','id TEXT PRIMARY KEY DESC NOT NULL,record_json TEXT NOT NULL','id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL) WITHOUT ROWID --']){
    f.db.exec('BEGIN');try{
      f.db.exec('DROP TABLE source_consistency_attempts');f.db.exec(`CREATE TABLE source_consistency_attempts (${ddl})`);
      assert.throws(()=>assertConsistencyHistory(f.db),ddl);
    }finally{f.db.exec('ROLLBACK');}
    assert.deepEqual(assertConsistencyHistory(f.db),[]);
  }
});

test('historical local original requires canonical identity even without filesystem validation',async t=>{
  const f=consistencyFixture(t);const {confirmSourceConsistencyFixture}=await import('./helpers/source-consistency-proof.ts');await confirmSourceConsistencyFixture(f.directory,f.store,f.p.id);
  f.db.exec('BEGIN');try{f.db.prepare('UPDATE assets SET original_path=? WHERE id=?').run('assets/another.png',f.p.assets[0].id);assert.throws(()=>assertConsistencyHistory(f.db));}finally{f.db.exec('ROLLBACK');}
  assert.equal(assertConsistencyHistory(f.db).length,1);
});


test('native anchored originals take precedence before local count and byte budgets',async t=>{
  for(const mode of ['count','bytes','shared'] as const)await t.test(mode,async t=>{
    const f=consistencyFixture(t),snapshot=collectionSnapshot();
    snapshot.skus[0]={...snapshot.skus[0],originalSpec:'Blue round',attributes:[{name:'Color',value:'Blue'}]};
    snapshot.skuImages=[{providerSkuId:snapshot.skus[0].providerSkuId,imageId:snapshot.images[0].id,basis:'provider-sku-id',specName:null,specValue:null}];
    if(mode==='shared'){
      snapshot.skus.push({...snapshot.skus[0],providerSkuId:'sku-2'});
      snapshot.skuImages.push({...snapshot.skuImages[0],providerSkuId:'sku-2'});
    }
    let p=f.store.getProduct(f.store.receiveCollectionSnapshot(randomUUID(),snapshot).productId);
    const variantId=p.variants[0].id;
    for(let i=0;i<(mode==='bytes'?2:10);i++){
      const existing=new Set(p.assets.map(a=>a.id));
      p=addSourceOriginalFixture(f.directory,f.store,p.id,[variantId],i===0?'main':'gallery',i+1);
      if(mode==='bytes'){
        const a=f.store.getAssetRecord(p.assets.find(a=>!existing.has(a.id))!.id)!;
        const bytes=Buffer.alloc(10*1024*1024);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(a.width,16);bytes.writeUInt32BE(a.height,20);bytes[32]=i+1;
        writeFileSync(resolve(f.directory,a.originalPath),bytes);f.db.prepare('UPDATE assets SET byte_size=?,sha256=? WHERE id=?').run(bytes.length,createHash('sha256').update(bytes).digest('hex'),a.id);
      }
    }
    const images=new MiaoshouImageService(f.directory,f.store,()=>null,b=>b,{download:async()=>{const b=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(256,16);b.writeUInt32BE(256,20);return b;}});
    try{
      // Explicit delivery even though the existing local bindings already satisfy identity readiness.
      const delivered=await images.download({productId:p.id,revision:f.store.getProduct(p.id).revision,imageIds:[snapshot.images[0].id]});assert.deepEqual(delivered.failures,[]);
      const input=()=>({productId:p.id,productRevision:f.store.getProduct(p.id).revision,variantId});
      const context=resolveConsistencyContext(f.db,f.store,f.directory,input());
      assert.equal(context.referenceAssets.length,1);assert.equal(context.referenceAssets[0].source,'receipt-image');
      const anchored=f.store.getAssetRecord(context.referenceAssets[0].assetId)!;
      if(mode==='shared')assert.equal(f.store.getProduct(p.id).assets.find(a=>a.id===anchored.id)!.variantIds.length,2,'shared native reference wins over single-SKU locals');
      f.db.exec('BEGIN');try{
        f.db.prepare('UPDATE variant_assets SET confirmed=0 WHERE asset_id=? AND variant_id=?').run(anchored.id,variantId);
        assert.ok(resolveConsistencyContext(f.db,f.store,f.directory,input()).referenceAssets.every(a=>a.source==='local-original'),'unconfirmed native original cannot be selected');
        f.db.prepare('DELETE FROM variant_assets WHERE asset_id=? AND variant_id=?').run(anchored.id,variantId);
        assert.ok(resolveConsistencyContext(f.db,f.store,f.directory,input()).referenceAssets.every(a=>a.source==='local-original'),'unbound or sibling-only native original cannot be selected');
      }finally{f.db.exec('ROLLBACK');}
      f.db.exec('BEGIN');try{const row=f.db.prepare('SELECT record_json FROM source_image_provenance WHERE id=?').get(context.referenceAssets[0].anchorId)!;const value=JSON.parse(String(row.record_json));value.receiptFingerprint='0'.repeat(64);f.db.prepare('UPDATE source_image_provenance SET record_json=? WHERE id=?').run(JSON.stringify(value),value.id);assert.throws(()=>resolveConsistencyContext(f.db,f.store,f.directory,input()));}finally{f.db.exec('ROLLBACK');}
      writeFileSync(resolve(f.directory,anchored.originalPath),Buffer.alloc(33));assert.throws(()=>resolveConsistencyContext(f.db,f.store,f.directory,input()),'corrupt native bytes must not fall back to valid locals');
    }finally{await images.close();}
  });
});
