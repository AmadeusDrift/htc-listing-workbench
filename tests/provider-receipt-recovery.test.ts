import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync,linkSync,unlinkSync } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { ImageGenerationService } from '../src/main/image-generation/service.ts';
import { mockStorage } from './fixtures/listing-ai.ts';
import { openDatabase } from '../src/main/database.ts';
import { readProviderReceipt } from '../src/main/ai/receipts.ts';
const png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(256,16);png.writeUInt32BE(256,20);
function fixture(t:test.TestContext){
  const root=resolve('.test-data');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'receipt-recovery-')),store=new WorkspaceStore(directory),product=store.createProduct();let calls=0,previewFails=true;
  const service=new ImageGenerationService(directory,store,mockStorage,{decodePreview:bytes=>{if(previewFails)throw Error('preview fixture failure');return bytes;},fetch:async()=>{calls++;return new Response(JSON.stringify({id:'gen_fixture_image',data:[{b64_json:png.toString('base64')}],usage:{cost:.08}}));}});
  service.saveConnection({provider:'openrouter',model:'openai/gpt-image-2.5-sunburst',enabled:true,apiKey:'openrouter-fixture-image-key'});
  t.after(async()=>{await service.close();store.close();assert.equal(dirname(directory),root);rmSync(directory,{recursive:true,force:true});});
  return{directory,store,product,service,calls:()=>calls,fixPreview:()=>{previewFails=false;},input:{productId:product.id,productRevision:product.revision,prompt:'Product photo',referenceAssetIds:[],size:'auto',quality:'high',background:'opaque'}};
}
test('A17 image preview failure recovers the original base64 without another paid request',async t=>{
  const f=fixture(t),id=randomUUID();await assert.rejects(f.service.generateForWorkflow(f.input,{requestId:id}));assert.equal(f.calls(),1);
  f.fixPreview();const recovered=await f.service.reconcileWorkflowGeneration(id);assert.equal(recovered?.id,id);assert.equal(recovered?.provider,'openrouter');assert.equal(f.calls(),1);
  await assert.rejects(f.service.generateForWorkflow(f.input,{requestId:id}));assert.equal(f.calls(),1);
  const db=openDatabase(f.directory);try{assert.equal(db.prepare('SELECT count(*) n FROM ai_provider_receipts').get()!.n,1);}finally{db.close();}
});
test('file receipt survives interruption before its SQLite index is stored',async t=>{
  const f=fixture(t),id=randomUUID();await assert.rejects(f.service.generateForWorkflow(f.input,{requestId:id}));
  const db=openDatabase(f.directory);try{db.exec('DELETE FROM ai_provider_receipts');assert.ok(await readProviderReceipt(db,f.directory,id));}finally{db.close();}
  f.fixPreview();assert.equal((await f.service.reconcileWorkflowGeneration(id))?.id,id);assert.equal(f.calls(),1);
});
test('receipt fallback rejects linked pointers and invalid token metadata before adoption',async t=>{
  const f=fixture(t),id=randomUUID();await assert.rejects(f.service.generateForWorkflow(f.input,{requestId:id}));
  const db=openDatabase(f.directory),pointer=join(f.directory,'ai-receipts',id+'.receipt.json');
  try{
    db.exec('DELETE FROM ai_provider_receipts');const original=readFileSync(pointer,'utf8');
    writeFileSync(pointer,JSON.stringify({...JSON.parse(original),reportedTokens:-1}));
    await assert.rejects(readProviderReceipt(db,f.directory,id),/收据/);
    writeFileSync(pointer,original);const alias=join(f.directory,'receipt-alias.json');linkSync(pointer,alias);
    await assert.rejects(readProviderReceipt(db,f.directory,id),/收据/);unlinkSync(alias);
    assert.ok(await readProviderReceipt(db,f.directory,id));assert.equal(f.calls(),1);
  }finally{db.close();}
});
test('retired candidate provenance and bytes remain readable with no provider request',async t=>{
  const f=fixture(t);f.fixPreview();const id=randomUUID(),path=join(f.directory,'image-generation','candidates',id);mkdirSync(path,{recursive:true});
  const sha256=createHash('sha256').update(png).digest('hex');
  writeFileSync(join(path,'image.png'),png);writeFileSync(join(path,'preview.png'),png);
  writeFileSync(join(path,'candidate.json'),JSON.stringify({id,provider:'openai',model:'gpt-image-2.5-sunburst',mode:'generate',productId:f.product.id,productRevision:f.product.revision,createdAt:new Date().toISOString(),requestId:null,sourceAssets:[],reviewState:'unreviewed',mimeType:'image/png',width:256,height:256,byteSize:png.length,sha256,previewSha256:sha256}));
  const old=await f.service.readCandidate(id);assert.equal(old.candidate.provider,'openai');assert.deepEqual(old.bytes,png);assert.equal(f.calls(),0);
});
