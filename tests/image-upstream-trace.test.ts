import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { selectedImageIds, validateProduct } from '../src/main/miaoshou/validation.ts';
import { detailFixture, mappingFor } from './helpers/miaoshou-fixture.ts';

test('SKU-level thumbnails survive normalization and own their exact mapping without sibling images',()=>{
 const raw=detailFixture(); Object.assign(raw.data.editCommonCollectBoxDetail.skuMap.arbitraryA,{imgUrl:'https://images.example.com/a.jpg'});
 const p=normalizeDetail(raw,'2026-10-12T00:00:00.000Z');
 assert.deepEqual(p.skus.find(s=>s.key==='arbitraryA')?.imageUrls,['https://images.example.com/a.jpg']);
 assert.deepEqual(selectedImageIds(p,mappingFor(p,true),'arbitraryA'),[p.images.find(i=>i.url.endsWith('/a.jpg'))!.id]);
 assert.deepEqual(validateProduct(p,'live'),p);
});

test('historical workflow restores original binding across frozen versions, preserves history and excludes foreign owners',()=>{
 const directory=mkdtempSync(join(tmpdir(),'upstream-trace-')); const store=new WorkspaceStore(directory),db=openDatabase(directory);
 try {
 const p=store.createProduct(), other=store.createProduct(),asset=randomUUID(),foreign=randomUUID(),at='2026-10-11T00:00:00.000Z';
 for(const [id,owner] of [[asset,p.id],[foreign,other.id]]) db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,owner,'original.png','gallery','image/png',256,256,33,`assets/${id}.png`,`assets/${id}.png`,'a'.repeat(64),at);
 const run={id:randomUUID(),draftId:randomUUID(),productId:p.id,productRevision:1,variantId:p.variants[0].id,sku:p.variants[0].sku,status:'INTERRUPTED',stage:'planning',attempt:0,maxAttempts:2,contextSha256:null,draftSha256:null,referenceAssets:[{id:asset,sha256:'a'.repeat(64)},{id:foreign,sha256:'a'.repeat(64)}],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:at,updatedAt:at,error:null};
 const generated=randomUUID();
 db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(generated,p.id,'generated.png','gallery','image/png',256,256,33,`assets/${generated}.png`,`assets/${generated}.png`,'b'.repeat(64),at);
 run.referenceAssets.push({id:generated,sha256:'b'.repeat(64)});
 const completed={...run,id:randomUUID(),referenceAssets:[run.referenceAssets[0]],status:'COMPLETED',stage:'complete',attempt:1,contextSha256:'c'.repeat(64),draftSha256:'d'.repeat(64),planResultIds:[randomUUID()],candidateIds:[randomUUID()],ocrResultIds:[randomUUID()],reviewResultIds:[randomUUID()],approvedAssetId:generated,approvedSha256:'b'.repeat(64)};
 db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(completed.id,JSON.stringify(completed));
 const history=JSON.stringify(run); db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(run.id,history);
 assert.deepEqual(store.getProduct(p.id).assets[0].variantIds,[p.variants[0].id]);
 assert.equal(db.prepare('SELECT count(*) AS n FROM variant_assets WHERE asset_id=?').get(generated)?.n,0,'generated outputs are never restored as originals');
 assert.equal(db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=?').get(asset)?.confirmed,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM variant_assets WHERE asset_id=?').get(foreign)?.n,0);
 assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(run.id)?.record_json,history);
 const current=store.getProduct(p.id);store.updateAsset({productId:p.id,revision:current.revision,assetId:asset,role:'gallery',variantIds:[]});
 assert.deepEqual(store.getProduct(p.id).assets[0].variantIds,[],'explicit later unbinding remains authoritative');
 store.getProduct(p.id); assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='source-image.upstream-restored'").get()?.n,1);
 }finally{db.close();store.close();rmSync(directory,{recursive:true,force:true});}
});



import { bindProductReference, isProductReference, restoreWorkflowSourceBindings } from '../src/main/image-upstream-trace.ts';

function attributionFixture(){
 const directory=mkdtempSync(join(tmpdir(),'attribution-atomic-')),store=new WorkspaceStore(directory),db=openDatabase(directory),product=store.createProduct(),assetId=randomUUID(),at='2026-10-11T00:00:00.000Z';
 db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(assetId,product.id,'original.png','gallery','image/png',256,256,33,`assets/${assetId}.png`,`assets/${assetId}.png`,'a'.repeat(64),at);
 const input={productId:product.id,variantId:product.variants[0].id,assetId,imageId:'source-image',sourceSku:'white',spec:'白色'};
 const run={id:randomUUID(),draftId:randomUUID(),productId:product.id,productRevision:1,variantId:input.variantId,sku:product.variants[0].sku,status:'INTERRUPTED',stage:'planning',attempt:0,maxAttempts:2,contextSha256:null,draftSha256:null,referenceAssets:[{id:assetId,sha256:'a'.repeat(64)}],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:at,updatedAt:at,error:null};
 return {directory,store,db,input,run,dispose(){db.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('product reference audit failure rolls back within outer transaction and retry survives restart',()=>{
 const f=attributionFixture();try{
 f.db.exec("CREATE TRIGGER fail_scope BEFORE INSERT ON audit_events WHEN NEW.action='source-image.product-reference' BEGIN SELECT RAISE(ABORT,'injected scope failure'); END;");
 f.db.exec('BEGIN');
 assert.throws(()=>bindProductReference(f.db,f.input),/injected scope failure/);
 assert.equal(f.db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=?').get(f.input.assetId),undefined);
 assert.equal(isProductReference(f.db,f.input.productId,f.input.variantId,f.input.assetId),false);
 f.db.exec('COMMIT');f.db.exec('DROP TRIGGER fail_scope');
 bindProductReference(f.db,f.input);bindProductReference(f.db,f.input);
 const restarted=openDatabase(f.directory);try{
 assert.equal(restarted.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=?').get(f.input.assetId)?.confirmed,1);
 assert.equal(isProductReference(restarted,f.input.productId,f.input.variantId,f.input.assetId),true);
 assert.equal(restarted.prepare("SELECT count(*) AS n FROM audit_events WHERE action='source-image.product-reference'").get()?.n,1);
 }finally{restarted.close();}
 }finally{f.dispose();}
});

test('product reference repairs old partial binding scope idempotently but preserves explicit later unbinding',()=>{
 const f=attributionFixture();try{
 f.db.prepare('INSERT INTO variant_assets VALUES(?,?,1,?)').run(f.input.assetId,f.input.variantId,f.run.createdAt);
 bindProductReference(f.db,f.input);assert.equal(isProductReference(f.db,f.input.productId,f.input.variantId,f.input.assetId),true);
 bindProductReference(f.db,f.input);assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='source-image.product-reference'").get()?.n,1);
 const p=f.store.getProduct(f.input.productId);f.store.updateAsset({productId:p.id,revision:p.revision,assetId:f.input.assetId,role:'gallery',variantIds:[]});
 bindProductReference(f.db,f.input);assert.equal(f.db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=?').get(f.input.assetId),undefined);
 }finally{f.dispose();}
});

test('old unconfirmed workflow binding restores atomically and survives retry and restart',()=>{
 const f=attributionFixture();try{
 f.db.prepare('INSERT INTO variant_assets VALUES(?,?,0,?)').run(f.input.assetId,f.input.variantId,f.run.createdAt);
 f.db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(f.run.id,JSON.stringify(f.run));
 f.db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON audit_events WHEN NEW.action='source-image.upstream-restored' BEGIN SELECT RAISE(ABORT,'injected restore failure'); END;");
 assert.throws(()=>restoreWorkflowSourceBindings(f.db,f.input.productId),/injected restore failure/);
 assert.equal(f.db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=?').get(f.input.assetId)?.confirmed,0);
 f.db.exec('DROP TRIGGER fail_restore');restoreWorkflowSourceBindings(f.db,f.input.productId);
 const restarted=openDatabase(f.directory);try{restoreWorkflowSourceBindings(restarted,f.input.productId);
 assert.equal(restarted.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=?').get(f.input.assetId)?.confirmed,1);
 assert.equal(restarted.prepare("SELECT count(*) AS n FROM audit_events WHERE action='source-image.upstream-restored'").get()?.n,1);
 }finally{restarted.close();}
 }finally{f.dispose();}
});

test('nested successful attribution rolls back with outer transaction and explicit unconfirmed correction wins',()=>{
 const f=attributionFixture();try{
 f.db.exec('BEGIN');bindProductReference(f.db,f.input);f.db.exec('ROLLBACK');
 assert.equal(f.db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=?').get(f.input.assetId),undefined);
 assert.equal(isProductReference(f.db,f.input.productId,f.input.variantId,f.input.assetId),false);
 f.db.prepare('INSERT INTO variant_assets VALUES(?,?,0,?)').run(f.input.assetId,f.input.variantId,f.run.createdAt);
 f.db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(f.run.id,JSON.stringify(f.run));
 f.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),f.input.productId,'asset.updated','explicit correction',JSON.stringify({after:{assetId:f.input.assetId,variantIds:[f.input.variantId],confirmed:0}}),'2026-10-12T00:00:00.000Z');
 restoreWorkflowSourceBindings(f.db,f.input.productId);bindProductReference(f.db,f.input);
 assert.equal(f.db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=?').get(f.input.assetId)?.confirmed,0);
 assert.equal(isProductReference(f.db,f.input.productId,f.input.variantId,f.input.assetId),false);
 }finally{f.dispose();}
});

test('new running workflow references never mutate source associations mid-flight',()=>{
 const f=attributionFixture();try{
 f.db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(f.run.id,JSON.stringify({...f.run,status:'RUNNING'}));
 restoreWorkflowSourceBindings(f.db,f.input.productId);
 assert.equal(f.db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=?').get(f.input.assetId),undefined);
 }finally{f.dispose();}
});
