import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { MiaoshouImageService } from '../src/main/miaoshou/images.ts';
import { prepareImageWorkflowSources } from '../src/main/image-workflow/sources.ts';
import { collectionSnapshot } from './helpers/collection-fixture.ts';
import { validateSourceImageProvenance, assertSourceImageHistory } from '../src/main/source-image-provenance.ts';
import { createWorkspaceBackup } from '../src/main/backup.ts';
import { AiService } from '../src/main/ai/service.ts';
import { persistSourceImageFixture } from './helpers/source-image-receipt.ts';
import { AUTOMATIC_SOURCE_ISSUES } from '../src/shared/image-workflow-contracts.ts';
import type { CollectionSnapshot } from '../src/shared/collection-contracts.ts';

function png() { const b=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(256,16);b.writeUInt32BE(256,20);return b; }
async function fixture(t:test.TestContext,options:{decode?:()=>void;snapshot?:(s:CollectionSnapshot)=>void;download?:(url:string)=>Promise<Buffer>}={}) {
  mkdirSync(resolve('.test-data'),{recursive:true});const directory=mkdtempSync(resolve('.test-data/native-images-'));
  const store=new WorkspaceStore(directory), db=openDatabase(directory), snapshot=collectionSnapshot();
  snapshot.skus=Array.from({length:20},(_,i)=>({...snapshot.skus[0],providerSkuId:`sku-${i}`,originalSpec:`size ${i}`}));
  snapshot.images=Array.from({length:20},(_,i)=>({id:`image-${i}`,url:`https://cbu01.alicdn.com/synthetic-${i}.png`,role:'gallery' as const}));
  snapshot.skuImages=snapshot.skus.map((s,i)=>({providerSkuId:s.providerSkuId,imageId:`image-${i}`,basis:'provider-sku-id' as const,specName:null,specValue:null}));
  options.snapshot?.(snapshot);
  const product=store.getProduct(store.receiveCollectionSnapshot(randomUUID(),snapshot).productId),downloads:string[]=[];
  const images=new MiaoshouImageService(directory,store,()=>null,b=>{options.decode?.();return b;},{download:async url=>{downloads.push(url);return options.download?options.download(url):png();}});
  t.after(async()=>{await images.close();db.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const run=(ids=product.variants.slice(0,2).map(v=>v.id),signal=new AbortController().signal)=>prepareImageWorkflowSources(store,db,{getReceipt:()=>null,images},{productId:product.id,productRevision:store.getProduct(product.id).revision,variantIds:ids},signal);
  return {store,db,product,downloads,run,directory,images};
}
test('native exact selected mappings download without sibling images and retain same-byte aliases',async t=>{
  const f=await fixture(t), result=await f.run();assert.deepEqual(result.missing,[]);
  assert.deepEqual(f.downloads,['https://cbu01.alicdn.com/synthetic-0.png','https://cbu01.alicdn.com/synthetic-1.png']);
  assert.deepEqual(new Set(result.product.assets[0].variantIds),new Set(f.product.variants.slice(0,2).map(v=>v.id)));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_image_provenance').get()!.n,2);
});
test('cancel during decoding does not import or anchor source bytes',async t=>{
  const controller=new AbortController(),f=await fixture(t,{decode:()=>controller.abort()});
  await assert.rejects(f.run(undefined,controller.signal));
  assert.equal(f.store.getProduct(f.product.id).assets.length,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_image_provenance').get()!.n,0);
});
test('anchor insertion failure leaves imported bytes unbound and unanchored',async t=>{
  const f=await fixture(t);f.db.exec("CREATE TRIGGER reject_anchor BEFORE INSERT ON source_image_provenance BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  const result=await f.run([f.product.variants[0].id]);assert.equal(result.missing[0].code,'SOURCE_DOWNLOAD_FAILED');
  assert.equal(result.product.assets.length,1);assert.deepEqual(result.product.assets[0].variantIds,[]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_image_provenance').get()!.n,0);
});
test('source identity history survives manual unbinding and SKU deletion with strict original bytes on restart and backup',async t=>{
  const f=await fixture(t),result=await f.run();let p=f.store.updateAsset({productId:f.product.id,revision:result.product.revision,assetId:result.product.assets[0].id,role:'gallery',variantIds:[]});
  const {origin,createdAt,updatedAt,assets,...input}=p;f.store.saveProduct({...input,variants:p.variants.slice(2).map(({sourceSpec,sourcePurchasePrice,...v})=>v)});
  assert.equal(assertSourceImageHistory(f.db,f.directory).length,2);
  const reopened=openDatabase(f.directory);reopened.close();
  await createWorkspaceBackup(f.directory,resolve(f.directory,'good.htcbackup'),'synthetic-long-passphrase');
  writeFileSync(resolve(f.directory,`assets/${result.product.assets[0].id}.png`),Buffer.alloc(33));
  assert.throws(()=>new WorkspaceStore(f.directory));
  await assert.rejects(createWorkspaceBackup(f.directory,resolve(f.directory,'bad.htcbackup'),'synthetic-long-passphrase'));
});
test('source identity parser rejects extras, duplicate mappings, wrong hash and duplicate JSON keys',async t=>{
  const f=await fixture(t);await f.run([f.product.variants[0].id]);
  const row=f.db.prepare('SELECT id,record_json FROM source_image_provenance').get()!,anchor=JSON.parse(String(row.record_json));
  for(const value of [{...anchor,visualPass:true},{...anchor,mappings:[...anchor.mappings,...anchor.mappings]},{...anchor,sha256:'bad'}])assert.throws(()=>validateSourceImageProvenance(value));
  f.db.prepare('UPDATE source_image_provenance SET record_json=?').run(String(row.record_json).replace('{','{"id":"'+randomUUID()+'",'));
  assert.throws(()=>assertSourceImageHistory(f.db));
});
test('native 20 to 1 cannot borrow an orphan when downloader is absent',async t=>{
  const f=await fixture(t),p=f.product;
  const {origin,createdAt,updatedAt,assets,...input}=p;
  const edited=f.store.saveProduct({...input,variants:[p.variants[19]].map(({sourceSpec,sourcePurchasePrice,...v})=>v)});
  f.store.addAssets({productId:p.id,revision:edited.revision},[{id:randomUUID(),fileName:'orphan.png',mimeType:'image/png',width:256,height:256,byteSize:33,originalPath:'unused',previewPath:'unused',sha256:'a'.repeat(64)}]);
  const result=await prepareImageWorkflowSources(f.store,f.db,undefined,{productId:p.id,productRevision:f.store.getProduct(p.id).revision,variantIds:[p.variants[19].id]},new AbortController().signal);
  assert.equal(result.missing.length,1);
  const ai=Object.assign(Object.create(AiService.prototype),{closed:false,store:f.store,db:f.db});
  assert.throws(()=>ai.sourceColorContext({productId:p.id,productRevision:result.product.revision,variantId:p.variants[19].id}));
  const bound=f.store.updateAsset({productId:p.id,revision:result.product.revision,assetId:result.product.assets[0].id,role:'main',variantIds:[p.variants[19].id]});
  assert.equal(ai.sourceColorContext({productId:p.id,productRevision:bound.revision,variantId:p.variants[19].id}).referenceAssets.length,1);
});
test('dual source identity gives structured repair diagnosis without downloading or binding',async t=>{
  const f=await fixture(t);
  persistSourceImageFixture(f.directory,{productId:f.product.id,snapshot:{images:[]},skuMappings:[]} as never);
  const result=await prepareImageWorkflowSources(f.store,f.db,undefined,{productId:f.product.id,productRevision:f.product.revision,variantIds:[f.product.variants[0].id]},new AbortController().signal);
  assert.equal(result.missing[0].code,'SOURCE_IDENTITY_CONFLICT');assert.equal(AUTOMATIC_SOURCE_ISSUES[result.missing[0].code],'SYSTEM_REPAIR');assert.equal(f.downloads.length,0);
});
test('unconfirmed or user-cleared native bindings never return through a repeated download',async t=>{
  const f=await fixture(t),r=await f.run();
  f.db.prepare('UPDATE variant_assets SET confirmed=0 WHERE variant_id=?').run(f.product.variants[0].id);
  let result=await f.run();assert.equal(result.missing.length,1);
  const p=f.store.updateAsset({productId:f.product.id,revision:result.product.revision,assetId:r.product.assets[0].id,role:'main',variantIds:[]});
  result=await f.run();assert.equal(result.missing.length,2);assert.equal(result.product.revision,p.revision);assert.deepEqual(result.product.assets[0].variantIds,[]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_image_provenance').get()!.n,2);
});
test('native provider ID mappings precede spec mappings and failed URL aliases are not retried',async t=>{
  const f=await fixture(t,{snapshot:s=>{
    s.skus[0].attributes=[{name:'Color',value:'Blue'}];
    s.images[0].url='https://cbu01.alicdn.com/spec.png';s.images[1].url='https://cbu01.alicdn.com/exact.png';s.images[2].url=s.images[1].url;s.images[2].role='detail';
    s.skuImages=s.skuImages.filter(m=>m.providerSkuId!=='sku-0');
    s.skuImages.push({providerSkuId:'sku-0',imageId:'image-0',basis:'spec-value',specName:'Color',specValue:'Blue'},...['image-1','image-2'].map(imageId=>({providerSkuId:'sku-0',imageId,basis:'provider-sku-id' as const,specName:null,specValue:null})));
  },download:async url=>{if(url.endsWith('exact.png'))throw new Error('synthetic unavailable');return png();}});
  const result=await f.run([f.product.variants[0].id]);assert.deepEqual(result.missing,[]);
  assert.deepEqual(f.downloads,['https://cbu01.alicdn.com/exact.png','https://cbu01.alicdn.com/spec.png']);
});
test('two selected native SKU aliases of one failed URL both require system repair with one download',async t=>{
  const f=await fixture(t,{snapshot:s=>{s.images[1].url=s.images[0].url;s.images[1].role='detail';},download:async()=>{throw new Error('synthetic unavailable');}});
  const result=await f.run();
  assert.equal(f.downloads.length,1);
  assert.deepEqual(result.missing.map(issue=>issue.variantId),f.product.variants.slice(0,2).map(v=>v.id));
  assert.deepEqual(result.missing.map(issue=>issue.code),['SOURCE_DOWNLOAD_FAILED','SOURCE_DOWNLOAD_FAILED']);
  assert.deepEqual(result.missing.map(issue=>AUTOMATIC_SOURCE_ISSUES[issue.code!]),['SYSTEM_REPAIR','SYSTEM_REPAIR']);
  assert.equal(result.missing[0].message,result.missing[1].message);
});
test('new non-main detail source retains its imported role',async t=>{
  const f=await fixture(t,{snapshot:s=>{s.images[1].role='detail';},download:async url=>{const bytes=png();if(url.includes('synthetic-1.'))bytes[32]=1;return bytes;}});
  const result=await f.run();assert.equal(result.product.assets[1].role,'detail');
});
test('historical mapped variant may be deleted but cannot be reassigned to another product',async t=>{
  const f=await fixture(t);await f.run();const other=f.store.createProduct();
  f.db.prepare('UPDATE variants SET product_id=? WHERE id=?').run(other.id,f.product.variants[0].id);
  assert.throws(()=>assertSourceImageHistory(f.db));
});
test('one exact native image may bind two selected sizes without downloading another color',async t=>{
  const f=await fixture(t,{snapshot:s=>{s.skuImages[1].imageId=s.skuImages[0].imageId;}}),result=await f.run();
  assert.deepEqual(result.missing,[]);assert.equal(f.downloads.length,1);assert.deepEqual(new Set(result.product.assets[0].variantIds),new Set(f.product.variants.slice(0,2).map(v=>v.id)));
});
test('closing the shared image service cancels native preparation before import',async t=>{
  let start!:()=>void,release!:()=>void;const started=new Promise<void>(r=>start=r),held=new Promise<void>(r=>release=r);
  const f=await fixture(t,{download:async()=>{start();await held;return png();}}),pending=f.run();await started;
  const closed=f.images.close();release();await assert.rejects(pending);await closed;
  assert.equal(f.store.getProduct(f.product.id).assets.length,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_image_provenance').get()!.n,0);
});
test('startup refuses an extra provenance column and a linked asset directory',async t=>{
  const f=await fixture(t);await f.run();const original=resolve(f.directory,'assets'),moved=resolve(f.directory,'assets-original');
  renameSync(original,moved);symlinkSync(moved,original,'junction');
  try{assert.throws(()=>new WorkspaceStore(f.directory));}finally{unlinkSync(original);renameSync(moved,original);}
  f.db.exec('ALTER TABLE source_image_provenance ADD COLUMN visual_pass TEXT');assert.throws(()=>new WorkspaceStore(f.directory));
});
