import { openDatabase } from '../src/main/database.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { importImageFiles } from '../src/main/assets.ts';
import { ImageGenerationService } from '../src/main/image-generation/service.ts';
import type { ImageGenerationDependencies } from '../src/main/image-generation/service.ts';
import type { SecretStorage } from '../src/main/amazon/vault.ts';
import { DEFAULT_OPENROUTER_IMAGE_MODEL as model } from '../src/shared/image-generation-contracts.ts';
import { readProviderReceipt } from '../src/main/ai/receipts.ts';

const key = randomBytes(32), secret = 'sk-fixture-image-secret';
const storage: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
  decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
};
const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(256, 16); png.writeUInt32BE(256, 20);

async function fixture(t: test.TestContext, deps: Partial<ImageGenerationDependencies> = {}) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/image-generation-')), store = new WorkspaceStore(directory);
  const initial = store.createProduct(), path = join(directory, 'source.png'); await writeFile(path, png);
  const product = await importImageFiles(store, directory, { productId: initial.id, revision: initial.revision }, [path], bytes => bytes);
  const calls: { url: string; init?: RequestInit }[] = [];
  const service = new ImageGenerationService(directory, store, storage, { decodePreview: bytes => bytes, ...deps, fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    if (deps.fetch) return deps.fetch(url, init);
    return new Response(JSON.stringify(String(url).includes('/models/') ? { endpoints: [] } : { data: [{ b64_json: png.toString('base64') }] }), { headers: { 'x-request-id': 'req-fixture' } });
  } });
  let storeClosed=false;const closeStore=()=>{if(!storeClosed){store.close();storeClosed=true;}};
  t.after(async () => { await service.close(); closeStore(); await rm(directory, { recursive: true, force: true }); });
  const input = { productId: product.id, productRevision: product.revision, prompt: 'A product on a white background', referenceAssetIds: [] as string[], size: 'auto' as const, quality: 'auto' as const, background: 'auto' as const };
  const enable = () => service.saveConnection({ model, enabled: true, apiKey: secret });
  return { service, directory, store, product, calls, input, enable,closeStore };
}

test('review close drains two late receipts and never dispatches queued requests',{timeout:5000},async t=>{
 const releases:((value:Response)=>void)[]=[];
 const f=await fixture(t,{timeoutMs:2000,fetch:async()=>new Promise<Response>(resolve=>releases.push(resolve))});f.enable();
 const products=[f.product,f.store.createProduct(),f.store.createProduct(),f.store.createProduct()];
 const ids=products.map(()=>randomUUID());
 const requests=products.map((product,i)=>f.service.generateForWorkflow({...f.input,productId:product.id,productRevision:product.revision},{requestId:ids[i]}));
 requests.forEach(p=>p.catch(()=>{}));
 for(let n=0;n<200&&releases.length<2;n++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal(releases.length,2);
 const closing=f.service.close();
 await Promise.all(requests.map(p=>assert.rejects(p)));
 assert.equal(f.calls.length,2);
 releases[1](Response.json({id:'review-late-second',data:[{b64_json:png.toString('base64')}],usage:{cost:.03}}));
 releases[0](Response.json({id:'review-late-first',data:[{b64_json:png.toString('base64')}],usage:{cost:.02}}));
 await closing;
 const db=openDatabase(f.directory);
 try{
  const intents=db.prepare('SELECT id FROM ai_image_requests ORDER BY id').all().map(row=>row.id).sort();
  assert.deepEqual(intents,ids.slice(0,2).sort());
  const receipts=await Promise.all(ids.slice(0,2).map(id=>readProviderReceipt(db,f.directory,id)));
  assert.deepEqual(receipts.map((r:any)=>r.body.id),['review-late-first','review-late-second']);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_spend_reservations').get()!.n,2);
 }finally{db.close();}
 const restarted=new ImageGenerationService(f.directory,f.store,storage,{decodePreview:bytes=>bytes,fetch:async()=>{throw Error('no repeat send allowed');}});
 try{
  for(let i=0;i<2;i++){const restored=await restarted.generateForWorkflow({...f.input,productId:products[i].id,productRevision:products[i].revision},{requestId:ids[i]});assert.equal(restored.id,ids[i]);assert.equal(restored.productId,products[i].id);}
 }finally{await restarted.close();}
});
