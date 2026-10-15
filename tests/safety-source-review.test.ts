import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { MiaoshouImageService } from '../src/main/miaoshou/images.ts';
import type { MiaoshouReceipt } from '../src/shared/miaoshou-contracts.ts';
import { persistSourceImageFixture } from './helpers/source-image-receipt.ts';

async function heldSource(t:test.TestContext){
 await mkdir(resolve('.test-data'),{recursive:true});
 const directory=await mkdtemp(resolve('.test-data/source-await-review-')),store=new WorkspaceStore(directory),product=store.createProduct();
 const png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(10,16);png.writeUInt32BE(10,20);
 const makeReceipt=(suffix:string)=>persistSourceImageFixture(directory,{productId:product.id,mode:'live',snapshot:{images:[{id:'source-image',role:'main',url:`https://images.example.com/${suffix}.png`}]},skuMappings:[]} as unknown as MiaoshouReceipt);
 let receipt=makeReceipt('original'),release!:()=>void,entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 const service=new MiaoshouImageService(directory,store,()=>receipt,async bytes=>{entered();await held;return bytes;},{download:async()=>png});
 t.after(async()=>{release();await service.close();store.close();await rm(directory,{recursive:true,force:true});});
 return{directory,store,product,service,started,release,replaceReceipt(){receipt=makeReceipt('changed');},imageIds:receipt.snapshot.images.map(image=>image.id)};
}

for(const change of ['product','receipt','abort'] as const)test(`source async decode cannot commit after ${change} changes`,{timeout:3000},async t=>{
 const f=await heldSource(t),controller=new AbortController(),pending=f.service.download({productId:f.product.id,revision:f.product.revision,imageIds:f.imageIds},controller.signal);
 pending.catch(()=>{});await f.started;
 if(change==='abort')controller.abort();
 else if(change==='receipt')f.replaceReceipt();
 else f.store.saveProduct({id:f.product.id,revision:f.product.revision,title:'Changed during worker decode',sourceUrl:'',description:'',status:'draft',facts:[],variants:f.product.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory}))});
 f.release();
 const result=await Promise.allSettled([pending]);
 if(change==='receipt'){assert.equal(result[0].status,'fulfilled');if(result[0].status==='fulfilled'){assert.equal(result[0].value.downloaded,0);assert.match(result[0].value.failures[0].message,/来源记录已变化/);}}
 else assert.equal(result[0].status,'rejected');
 assert.equal(f.store.getProduct(f.product.id).assets.length,0);
 const db=openDatabase(f.directory);try{assert.equal(db.prepare('SELECT count(*) n FROM source_image_provenance').get()!.n,0);}finally{db.close();}
 assert.equal((await readdir(f.directory)).some(name=>name.startsWith('.miaoshou-images-')),false);
});

test('source preview close during async decode cannot return or cache late preview',{timeout:3000},async t=>{
 const f=await heldSource(t),pending=f.service.preview({productId:f.product.id,imageId:f.imageIds[0]});
 pending.catch(()=>{});await f.started;
 const closing=f.service.close();f.release();await assert.rejects(pending);await closing;
 assert.equal((f.service as unknown as {previewCache:Map<string,string>}).previewCache.size,0);
 assert.deepEqual(f.store.getProduct(f.product.id),f.product);
});
