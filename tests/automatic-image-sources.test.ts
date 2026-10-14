import { resolveConsistencyContext } from '../src/main/source-image-consistency/scope.ts';
import { reduceSourceConsistency } from '../src/main/source-image-consistency/comparison.ts';
import { persistSourceImageFixture, sourceImageId } from './helpers/source-image-receipt.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { MiaoshouImageService } from '../src/main/miaoshou/images.ts';
import { prepareImageWorkflowSources } from '../src/main/image-workflow/sources.ts';
import type { MiaoshouReceipt } from '../src/shared/miaoshou-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';

const editable=(p:ProductDetail)=>({id:p.id,revision:p.revision,title:p.title,sourceUrl:p.sourceUrl,description:p.description,status:p.status,facts:p.facts,
  variants:p.variants.map(({sourceSpec:_spec,sourcePurchasePrice:_price,...v})=>v)});

const png = (color: number) => {
  const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a','hex').copy(bytes); bytes.writeUInt32BE(13,8); bytes.write('IHDR',12);
  bytes.writeUInt32BE(256,16); bytes.writeUInt32BE(256,20); bytes[32]=color; return bytes;
};
async function fixture(t: test.TestContext, options: { fallback?: boolean; unmapped?: boolean; hold?: boolean; mutate?: boolean; aliases?: boolean; assetEdit?: boolean; sixthMapped?: boolean } = {}) {
  await mkdir(resolve('.test-data'), {recursive:true}); const directory=await mkdtemp(resolve('.test-data/automatic-sources-'));
  const store=new WorkspaceStore(directory), db=openDatabase(directory); let product=store.createProduct();
  const input=editable(product);
  product=store.saveProduct({...input,title:'Automatic source product',variants:options.sixthMapped?input.variants:options.aliases?Array.from({length:21},(_,i)=>({...input.variants[0],id:randomUUID(),sku:`SKU-${i}`})):[...input.variants,{...input.variants[0],id:randomUUID(),sku:'SECOND-SKU'}]});
  const receipt={productId:product.id,mode:'live',snapshot:{skus:product.variants.map(v=>({key:v.sku})),images:[
    {id:'red',url:'https://images.example.com/red.png',role:'main'},
    {id:'blue',url:'https://images.example.com/blue.png',role:'gallery'},
    {id:'fallback',url:'https://images.example.com/fallback.png',role:'gallery'},
  ]},skuMappings:[
    {sourceKey:'red',localVariantId:product.variants[0].id,imageIds:options.unmapped?[]:options.fallback?['red','fallback']:['red']},
    {sourceKey:'blue',localVariantId:product.variants[1]?.id,imageIds:['blue']},
  ]} as MiaoshouReceipt;
  if(options.aliases){
    receipt.snapshot.images=product.variants.map((_,i)=>({id:`alias-${i}`,url:`https://images.example.com/alias-${i}.png`,role:'gallery'}));
    receipt.skuMappings=product.variants.map((v,i)=>({sourceKey:`source-${i}`,localVariantId:v.id,imageIds:[`alias-${i}`]}));
  }
  if(options.sixthMapped){
    receipt.snapshot.images=Array.from({length:6},(_,i)=>({id:`photo-${i}`,url:`https://images.example.com/photo-${i}.png`,role:i===0?'main':'gallery'}));
    receipt.skuMappings=[{sourceKey:'white',localVariantId:product.variants[0].id,imageIds:['photo-5']}];
  }
  persistSourceImageFixture(directory,receipt);
  const downloads:string[]=[]; let began!:()=>void, release!:()=>void;
  const started=new Promise<void>(r=>began=r), held=new Promise<void>(r=>release=r);
  const images=new MiaoshouImageService(directory,store,()=>receipt,bytes=>bytes,{download:async(url,signal)=>{
    downloads.push(url); began();
    if(options.hold) await Promise.race([held,new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))]);
    if(options.mutate)store.saveProduct({...editable(store.getProduct(product.id)),title:'Changed during download'});
    if(options.assetEdit&&url.endsWith('/red.png')){
      const current=store.getProduct(product.id);
      store.updateAsset({productId:current.id,revision:current.revision,assetId:current.assets[0].id,role:'main',variantIds:[current.variants[0].id]});
    }
    if(options.fallback&&url.endsWith('/red.png'))throw new Error('Source image unavailable');
    return png(url.endsWith('/blue.png')?2:url.endsWith('/photo-5.png')?5:1);
  }});
  const source={getReceipt:()=>receipt,images};
  t.after(async()=>{release(); await images.close();db.close();store.close();await rm(directory,{recursive:true,force:true});});
  return {directory,product,store,receipt,db,downloads,images,started,release,run:(variantIds=product.variants.map(v=>v.id),signal=new AbortController().signal)=>prepareImageWorkflowSources(store,db,source,{productId:product.id,productRevision:store.getProduct(product.id).revision,variantIds},signal)};
}

test('new source URLs are downloaded and SKU-bound before drafts, then reused without another download',async t=>{
  const f=await fixture(t), result=await f.run();
  assert.deepEqual(result.missing,[]); assert.equal(result.product.assets.length,2);assert.ok(result.product.revision>f.product.revision);
  assert.equal(result.product.title,f.product.title);assert.deepEqual(result.product.variants,f.product.variants);
  for(const variant of f.product.variants)assert.equal(result.product.assets.filter(a=>a.variantIds.includes(variant.id)).length,1);
  assert.equal(f.downloads.length,2); const reused=await f.run();assert.equal(reused.product.revision,result.product.revision);assert.equal(f.downloads.length,2);
});
test('unmapped SKU is blocked without borrowing another color, while the mapped SKU can continue',async t=>{
  const f=await fixture(t,{unmapped:true}),result=await f.run();
  assert.deepEqual(result.missing.map(x=>x.variantId),[f.product.variants[0].id]);assert.equal(f.downloads.length,1);assert.ok(f.downloads[0].endsWith('/blue.png'));
  assert.match(result.missing[0].message,/商品有来源图片.*SKU.*映射为空/);
  assert.equal(result.missing[0].code,'SOURCE_BINDING_UNCONFIRMED');
  await assert.rejects(f.run([randomUUID()]));assert.equal(f.downloads.length,1);
});

test('an unmapped SKU recovers only after its source photo is explicitly bound by the user',async t=>{
  const f=await fixture(t,{unmapped:true});await f.run([f.product.variants[0].id]);assert.equal(f.downloads.length,0);
  let product=f.store.getProduct(f.product.id);
  const downloaded=await f.images.download({productId:product.id,revision:product.revision,imageIds:[sourceImageId('https://images.example.com/red.png')]});product=downloaded.product;
  const unbound=await f.run([f.product.variants[0].id]);assert.equal(unbound.missing.length,1);
  f.store.updateAsset({productId:product.id,revision:product.revision,assetId:product.assets[0].id,role:'main',variantIds:[f.product.variants[0].id]});
  const recovered=await f.run([f.product.variants[0].id]);assert.deepEqual(recovered.missing,[]);assert.equal(f.downloads.length,1);
  assert.deepEqual(f.receipt.skuMappings[0].imageIds,[],'local confirmation does not invent supplier SKU image mappings');
});

test('source diagnostics distinguish absent links, invalid IDs, download failure and unconfirmed binding',async t=>{
  const absent=await fixture(t);absent.receipt.snapshot.images=[];
  const noLinks=await absent.run([absent.product.variants[0].id]);assert.match(noLinks.missing[0].message,/没有.*来源图片链接/);assert.equal(absent.downloads.length,0);
  assert.equal(noLinks.missing[0].code,'SOURCE_LINKS_MISSING');
  const lost=await fixture(t);lost.receipt.skuMappings.shift();const lostMapping=await lost.run([lost.product.variants[0].id]);assert.equal(lostMapping.missing[0].code,'SOURCE_MAPPING_MISSING');
  const invalid=await fixture(t);invalid.receipt.skuMappings[0].imageIds=['missing-id'];
  const invalidIds=await invalid.run([invalid.product.variants[0].id]);assert.match(invalidIds.missing[0].message,/映射.*ID.*无效/);assert.equal(invalid.downloads.length,0);
  assert.equal(invalidIds.missing[0].code,'SOURCE_MAPPING_INVALID');
  const failed=await fixture(t,{fallback:true});failed.receipt.skuMappings[0].imageIds=[sourceImageId('https://images.example.com/red.png')];
  const failedDownload=await failed.run([failed.product.variants[0].id]);assert.match(failedDownload.missing[0].message,/来源图片下载失败/);assert.equal(failed.downloads.length,1);
  assert.equal(failedDownload.missing[0].code,'SOURCE_DOWNLOAD_FAILED');
  const unconfirmed=await fixture(t);await unconfirmed.run([unconfirmed.product.variants[0].id]);
  unconfirmed.db.prepare('UPDATE variant_assets SET confirmed=0 WHERE variant_id=?').run(unconfirmed.product.variants[0].id);
  const unbound=await unconfirmed.run([unconfirmed.product.variants[0].id]);assert.match(unbound.missing[0].message,/绑定.*未确认/);
  assert.equal(unbound.missing[0].code,'SOURCE_BINDING_UNCONFIRMED');
  assert.equal(unbound.product.assets.length,1);
  assert.equal(unconfirmed.db.prepare('SELECT confirmed FROM variant_assets WHERE variant_id=?').get(unconfirmed.product.variants[0].id)!.confirmed,0,'an existing unconfirmed binding is not silently confirmed');
});
test('a failed first source image falls back once to another mapped image without retrying the failed URL',async t=>{
  const f=await fixture(t,{fallback:true}),result=await f.run([f.product.variants[0].id]);
  assert.deepEqual(result.missing,[]);assert.deepEqual(f.downloads.map(url=>new URL(url).pathname),['/red.png','/fallback.png']);
});
test('source changes and cancellation stop preparation before draft or paid work can begin',async t=>{
  const f=await fixture(t,{mutate:true});await assert.rejects(f.run(),/变化|修改|更新/);assert.equal(f.store.getProduct(f.product.id).assets.length,0);
  const g=await fixture(t,{hold:true}),controller=new AbortController(),pending=g.run(undefined,controller.signal);await g.started;controller.abort();await assert.rejects(pending);
  assert.equal(g.downloads.length,1);assert.equal(g.store.getProduct(g.product.id).assets.length,0);g.release();
  const resumed=await g.run();assert.deepEqual(resumed.missing,[]);
});
test('an external image-binding edit during download cannot be absorbed as successful source preparation',async t=>{
  const f=await fixture(t,{assetEdit:true});await f.run([f.product.variants[1].id]);
  await assert.rejects(f.run([f.product.variants[0].id]),/变化|修改|更新/);
  assert.equal(f.store.getProduct(f.product.id).assets.length,1);
});
test('deleting the red SKU never turns its unbound source image into a reference for the retained blue SKU',async t=>{
  const f=await fixture(t);await f.run([f.product.variants[0].id]);
  const current=editable(f.store.getProduct(f.product.id));f.store.saveProduct({...current,variants:[current.variants[1]]});
  const result=await f.run([f.product.variants[1].id]);
  assert.deepEqual(result.missing,[]);assert.deepEqual(f.downloads.map(url=>new URL(url).pathname),['/red.png','/blue.png']);
  assert.equal(result.product.assets.filter(a=>a.variantIds.includes(f.product.variants[1].id)).length,1);
});
test('identical source images retain all SKU mappings across automatic download batches',async t=>{
  const f=await fixture(t,{aliases:true}),result=await f.run();
  assert.deepEqual(result.missing,[]);assert.equal(f.downloads.length,21);assert.equal(result.product.assets.length,1);
  assert.deepEqual(new Set(result.product.assets[0].variantIds),new Set(f.product.variants.map(v=>v.id)));
  const edited=f.store.updateAsset({productId:f.product.id,revision:result.product.revision,assetId:result.product.assets[0].id,role:'gallery',variantIds:[]});
  const retry=await f.run();assert.equal(retry.product.revision,edited.revision);assert.equal(retry.missing.length,21,'a later run preserves the user-cleared associations');
});

test('named SKU without thumbnail uses unowned product reference and persists specification scope without inventing supplier mapping',async t=>{
 const f=await fixture(t,{unmapped:true});
 let p=f.store.getProduct(f.product.id);
 p=f.store.saveProduct({...editable(p),variants:p.variants.map(({sourceSpec:_s,sourcePurchasePrice:_p,...v},i)=>({...v,originalSpec:i===0?'白色':v.originalSpec}))});
 const result=await f.run([p.variants[0].id]);
 assert.deepEqual(result.missing,[]);
 assert.deepEqual(f.receipt.skuMappings[0].imageIds,[]);
 assert.ok(result.product.assets.some(a=>a.variantIds.includes(p.variants[0].id)));
 assert.ok(f.downloads.every(url=>!url.endsWith('/blue.png')));
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='source-image.product-reference'").get()?.n,1);
 await f.run([p.variants[0].id]); assert.equal(f.downloads.length,1);
 const context=resolveConsistencyContext(f.db,f.store,f.directory,{productId:p.id,productRevision:result.product.revision,variantId:p.variants[0].id});
 assert.equal(context.referenceAssets[0].scope,'product');
 const conclusion=reduceSourceConsistency(context,{kind:'source-image-consistency',version:'source-image-consistency/v2',assets:[{assetId:context.referenceAssets[0].assetId,quality:'clear',lighting:'neutral',visibility:'complete',presentation:'single-product',colors:['Blue'],appearance:[],claims:context.claims.map(c=>({claimId:c.id,value:'Blue',visibility:'visible'}))}]});
 assert.ok(!conclusion.reasons.some(r=>r.startsWith('VISIBLE_CONTRADICTION')));
});

for(const prior of [false,true])test(`single SKU explicit sixth image wins over generic gallery, including saved generic original (${prior})`,async t=>{
 const f=await fixture(t,{sixthMapped:true});
 let oldAsset:string|undefined;
 if(prior){const p=f.store.getProduct(f.product.id);await f.images.download({productId:p.id,revision:p.revision,imageIds:[sourceImageId('https://images.example.com/photo-0.png')]});oldAsset=f.store.getProduct(p.id).assets[0].id;}
 const result=await f.run();assert.deepEqual(result.missing,[]);
 assert.deepEqual(f.downloads.map(u=>new URL(u).pathname),prior?['/photo-0.png','/photo-5.png']:['/photo-5.png']);
 if(oldAsset)assert.deepEqual(result.product.assets.find(a=>a.id===oldAsset)!.variantIds,[],'generic historical asset is not silently confirmed');
 const context=resolveConsistencyContext(f.db,f.store,f.directory,{productId:result.product.id,productRevision:result.product.revision,variantId:result.product.variants[0].id});
 assert.equal(context.referenceAssets.length,1);assert.equal(context.referenceAssets[0].imageId,sourceImageId('https://images.example.com/photo-5.png'));
 await f.run();assert.equal(f.downloads.length,prior?2:1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get()!.n,0);
});

test('single SKU missing mapped image must not borrow the available generic main image',async t=>{
 const f=await fixture(t,{sixthMapped:true});
 f.receipt.skuMappings[0].imageIds=['missing-image'];
 const result=await f.run();assert.equal(result.missing.length,1);assert.equal(f.downloads.length,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ai_calls').get()!.n,0);
});
