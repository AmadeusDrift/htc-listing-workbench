import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { WorkspaceStore } from '../src/main/store.ts';
import { importImageFiles } from '../src/main/assets.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { AiService } from '../src/main/ai/service.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { chat, mockStorage, saveInput } from './fixtures/listing-ai.ts';

function sourcePng(): Buffer {
  const crc=(data:Buffer)=>{let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(32,0);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(32*97,190);for(let y=0;y<32;y++)pixels[y*97]=0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

async function fixture(t:test.TestContext) {
  const boundary=resolve('.test-data');mkdirSync(boundary,{recursive:true});
  const root=mkdtempSync(join(boundary,'source-color-restore-')),directory=join(root,'workspace'),backup=join(root,'before.htcbackup'),passphrase='isolated source color restore';
  const store=new WorkspaceStore(directory);let product=store.createProduct();
  product=store.saveProduct({...saveInput(product),variants:saveInput(product).variants.map(v=>({...v,originalSpec:'602Q',normalizedSpec:''}))});
  const path=join(root,'source.png');writeFileSync(path,sourcePng());
  product=await importImageFiles(store,directory,{productId:product.id,revision:product.revision},[path],bytes=>bytes);
  product=store.updateAsset({productId:product.id,revision:product.revision,assetId:product.assets[0].id,role:'main',variantIds:[product.variants[0].id]});
  store.close();
  let requests=0,fail=false;
  const open=()=>{
    const store=new WorkspaceStore(directory),amazon=new AmazonService(directory,id=>store.getProduct(id),mockStorage),hosting=new HostingService(directory,store,mockStorage);
    const ai=new AiService(directory,store,hosting,mockStorage,{fetch:async(_url,options)=>{
      requests++;if(fail)throw new Error('offline fixture response lost');
      const body=JSON.parse(String(options?.body)),content=body.messages[1].content,payload=JSON.parse(content[0].text);
      return chat({kind:'source-color',verdict:'DETERMINED',colors:['Silver'],reason:'Visible product body.',referenceAssetIds:payload.referenceImages.map((r:any)=>r.assetId)});
    }});
    ai.saveConnection({id:'deepseek',apiKey:'fixture-only-color-restore'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});
    return {store,amazon,hosting,ai,listing:new ListingAiService(store,amazon,ai,()=>false)};
  };
  let session:ReturnType<typeof open>|undefined=open();
  const close=async()=>{if(session){await session.ai.close();await session.hosting.close();session.amazon.close();session.store.close();session=undefined;}};
  const target=session!.amazon.enableDemo(),getSchema=session!.amazon.getSchema.bind(session!.amazon);
  session!.amazon.getSchema=async input=>{const schema=await getSchema(input);schema.schema.required=[...new Set([...(schema.schema.required as string[]??[]),'color'])];return schema;};
  const draft=await session!.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  const reference={draftId:draft.id,draftRevision:draft.revision};
  t.after(async()=>{await close();const local=relative(boundary,root);assert.ok(local&&!local.startsWith('..')&&!local.includes('/')&&!local.includes('\\'));rmSync(root,{recursive:true,force:true});});
  return {root,directory,backup,product,draft,reference,session:()=>session!,requests:()=>requests,fail:()=>{fail=true;},close,
    save:()=>createWorkspaceBackup(directory,backup,passphrase),
    prepare:()=>prepareWorkspaceRestore(directory,backup,passphrase),
    restore:async(prepared?:Awaited<ReturnType<typeof prepareWorkspaceRestore>>)=>{await close();await commitWorkspaceRestore(directory,prepared??await prepareWorkspaceRestore(directory,backup,passphrase));session=open();},
    exportAgain:()=>createWorkspaceBackup(directory,join(root,'after.htcbackup'),passphrase)};
}

test('restoring an older backup keeps an unknown color request blocked in a new listing service',async t=>{
  const f=await fixture(t);await f.save();f.fail();
  await assert.rejects(f.session().listing.prepareSourceColors(f.reference));
  const call=f.session().ai.listCalls()[0];assert.equal(f.requests(),1);assert.equal(call.status,'FAILED');assert.equal(call.errorCode,'NETWORK_ERROR');
  for(let i=0;i<2;i++){
    await f.restore();
    await assert.rejects(f.session().listing.prepareSourceColors(f.reference),/未自动重发/);
    assert.equal(f.requests(),1);assert.deepEqual(f.session().ai.getCall(call.id),call);
    assert.equal(f.session().ai.listCalls().length,1);assert.equal(f.session().ai.listResults(f.product.id).length,0);
    assert.equal(f.session().ai.getUsageSummary('deepseek').unknownCalls,1);
  }
  await f.exportAgain();
});

test('a color success after the restored snapshot survives only as a failed request intent',async t=>{
  const f=await fixture(t);await f.save();await f.session().listing.prepareSourceColors(f.reference);
  const original=f.session().ai.listCalls()[0];assert.equal(original.status,'SUCCEEDED');
  await f.restore();
  const call=f.session().ai.getCall(original.id)!;assert.equal(call.status,'FAILED');assert.equal(call.errorCode,'INTERRUPTED');
  assert.deepEqual(call.sourceColorContext,original.sourceColorContext);assert.deepEqual(call.usage,original.usage);assert.equal(call.requestId,original.requestId);
  assert.equal(f.session().ai.listResults(f.product.id).length,0);
  assert.ok(!f.session().listing.currentContext(f.draft,f.product,0).evidence.some(e=>e.source==='source_image'));
  await assert.rejects(f.session().listing.prepareSourceColors(f.reference),/未自动重发/);assert.equal(f.requests(),1);
  await f.exportAgain();
});

test('a successful color observation already in the restored snapshot stays reusable',async t=>{
  const f=await fixture(t);await f.session().listing.prepareSourceColors(f.reference);
  const original=f.session().ai.listCalls()[0],results=f.session().ai.listResults(f.product.id);await f.save();await f.restore();
  assert.deepEqual(f.session().ai.getCall(original.id),original);assert.deepEqual(f.session().ai.listResults(f.product.id),results);
  const prepared=await f.session().listing.prepareSourceColors(f.reference);assert.equal(prepared.aiCalls,0);assert.ok(prepared.evidenceSha256);assert.equal(f.requests(),1);
});

test('restore commit also retains a color request sent after restore preparation',async t=>{
  const f=await fixture(t);await f.save();const prepared=await f.prepare();f.fail();
  await assert.rejects(f.session().listing.prepareSourceColors(f.reference));const call=f.session().ai.listCalls()[0];
  await f.restore(prepared);
  await assert.rejects(f.session().listing.prepareSourceColors(f.reference),/未自动重发/);
  assert.deepEqual(f.session().ai.getCall(call.id),call);assert.equal(f.requests(),1);
});

test('a conflicting color request identity rejects restore without replacing the current workspace',async t=>{
  const f=await fixture(t);f.fail();await assert.rejects(f.session().listing.prepareSourceColors(f.reference));await f.save();
  const original=f.session().ai.listCalls()[0];await f.close();
  const changed={...original,sourceColorContext:{...original.sourceColorContext!,sourceSpec:'602E'}},db=openDatabase(f.directory);
  try{db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(changed),changed.id);}finally{db.close();}
  await assert.rejects(f.restore());
  const current=openDatabase(f.directory);try{assert.deepEqual(JSON.parse(String(current.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(changed.id)!.record_json)),changed);}finally{current.close();}
});
