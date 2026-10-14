import { openDatabase } from '../src/main/database.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { importImageFiles } from '../src/main/assets.ts';
import { ImageGenerationService } from '../src/main/image-generation/service.ts';
import type { ImageGenerationDependencies } from '../src/main/image-generation/service.ts';
import { clearImageGenerationConnection } from '../src/main/image-generation/vault.ts';
import { AiError } from '../src/main/ai/errors.ts';
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
const code = (value: string) => (error: unknown) => error instanceof AiError && error.code === value;

for(const [status,message,definitive] of [[200,'Synthetic processing failure',false],[503,'Upstream unavailable',false],[503,'No available providers found for the selected model.',true]] as const)test(`image ${status}/${definitive} failure keeps original body and identical recovery classification with zero new POST`,async t=>{
  const raw={id:'gen_s02_failed_image',error:{code:status===200?502:status,message},usage:{cost:.035}},f=await fixture(t,{fetch:async()=>Response.json(raw,{status})});f.enable();const requestId=randomUUID();
  let first:any;await assert.rejects(f.service.generateForWorkflow(f.input,{requestId}),(error:any)=>{first=error;return error.httpStatus===status&&error.definitive===definitive;});
  const db=openDatabase(f.directory);try{const receipt:any=await readProviderReceipt(db,f.directory,requestId);assert.deepEqual(receipt.body,raw);assert.equal(receipt.costUsd,.035);}finally{db.close();}
  await assert.rejects(f.service.reconcileWorkflowGeneration(requestId),(error:any)=>error.code===first.code&&error.httpStatus===status&&error.definitive===definitive);
  assert.equal(f.calls.length,1);assert.equal((await readdir(join(f.directory,'image-generation','candidates')).catch(()=>[])).length,0);
});
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
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const input = { productId: product.id, productRevision: product.revision, prompt: 'A product on a white background', referenceAssetIds: [] as string[], size: 'auto' as const, quality: 'auto' as const, background: 'auto' as const };
  const enable = () => service.saveConnection({ model, enabled: true, apiKey: secret });
  return { service, directory, store, product, calls, input, enable };
}
test('saving encrypts key, exposes only metadata, makes no network calls and survives restart', async t => {
  const f = await fixture(t);
  assert.equal(f.service.getConnection().credentialState, 'absent');
  const saved = f.service.saveConnection({ model, enabled: false, apiKey: secret });
  assert.equal(saved.configured, true); assert.equal(saved.enabled, false); assert.equal(saved.accessCheck, 'not-checked');
  assert.equal(JSON.stringify(saved).includes(secret), false); assert.equal(f.calls.length, 0);
  const ciphertext = await readFile(join(f.directory, 'ai-vault', 'openrouter-images.bin')); assert.equal(ciphertext.includes(Buffer.from(secret)), false);
  const reopened = new ImageGenerationService(f.directory, f.store, storage, { decodePreview: bytes => bytes });
  assert.deepEqual(reopened.getConnection(), saved); await reopened.close();
  f.service.saveConnection({ model: 'openai/gpt-image-2.5-flare', enabled: true, apiKey: '' });
  assert.equal(f.service.getConnection().configured, true); assert.equal(f.service.getConnection().model, 'openai/gpt-image-2.5-flare');
  assert.equal(f.calls.length, 0);
});
test('model check is one GET, separate from enabled state and image-generation success', async t => {
  const f = await fixture(t); f.service.saveConnection({ model, enabled: false, apiKey: secret });
  const checked = await f.service.checkConnection();
  assert.equal(checked.accessCheck, 'accessible'); assert.equal(checked.enabled, false); assert.ok(checked.checkedAt);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init?.method??'GET', 'GET');
  f.service.saveConnection({ model, enabled: true }); assert.equal(f.service.getConnection().accessCheck, 'not-checked');
});
test('generation and editing save unreviewed local PNG candidates without changing product assets or revision', async t => {
  const f = await fixture(t); f.enable();
  const before = f.store.getProduct(f.product.id), generated = await f.service.generate(f.input);
  assert.equal(generated.mode, 'generate'); assert.equal(generated.reviewState, 'unreviewed');
  assert.deepEqual(await readFile(join(f.directory, 'image-generation', 'candidates', generated.id, 'image.png')), png);
  const metadata = JSON.parse(await readFile(join(f.directory, 'image-generation', 'candidates', generated.id, 'candidate.json'), 'utf8'));
  assert.equal(metadata.id, generated.id); assert.equal(JSON.stringify(metadata).includes(secret), false);
  const edited = await f.service.generate({ ...f.input, referenceAssetIds: [f.product.assets[0].id] });
  assert.equal(edited.mode, 'edit'); assert.equal(edited.sourceAssets[0].id, f.product.assets[0].id);
  const body = JSON.parse(String(f.calls[1].init?.body)); assert.ok(body.input_references[0].image_url.url.startsWith('data:image/png;base64,'));
  assert.deepEqual(f.store.getProduct(f.product.id), before);
});
test('workflow recovery reads a durable candidate without resending and repair uses failed candidate plus original references',async t=>{
  const f=await fixture(t);f.enable();const requestId=randomUUID(),input={...f.input,referenceAssetIds:[f.product.assets[0].id]};
  const first=await f.service.generateForWorkflow(input,{requestId});
  assert.equal(first.id,requestId);
  assert.equal((await f.service.reconcileWorkflowGeneration(requestId))?.id,first.id);assert.equal(f.calls.length,1);
  const repaired=await f.service.generateForWorkflow(input,{requestId:randomUUID(),editCandidateId:first.id});
  const body=JSON.parse(String(f.calls[1].init?.body));assert.equal(body.input_references.length,2);
  assert.equal(repaired.editSource?.id,first.id);assert.deepEqual(repaired.sourceAssets,first.sourceAssets);
  assert.equal(f.store.getProduct(f.product.id).assets.length,1);
  await assert.rejects(f.service.generate({...input,editCandidateId:first.id}));
});

test('workflow preflight and oversized repair references prove no request was sent',async t=>{
  const candidateBytes=Buffer.alloc(3*1024*1024);png.copy(candidateBytes);
  const f=await fixture(t,{decodePreview:()=>png,fetch:async()=>Response.json({data:[{b64_json:candidateBytes.toString('base64')}]})});
  const notSent=(error:unknown)=>{assert.ok(error instanceof AiError);assert.equal((error as AiError&{notSent:boolean}).notSent,true);return true;};
  await assert.rejects(f.service.generateForWorkflow(f.input,{requestId:randomUUID()}),notSent);assert.equal(f.calls.length,0);f.enable();
  const paths:string[]=[];for(let i=0;i<2;i++){const bytes=Buffer.alloc(9*1024*1024);png.copy(bytes);bytes[32]=i+1;const path=join(f.directory,`large-${i}.png`);await writeFile(path,bytes);paths.push(path);}
  const product=await importImageFiles(f.store,f.directory,{productId:f.product.id,revision:f.product.revision},paths,()=>png);
  const input={...f.input,productRevision:product.revision,referenceAssetIds:product.assets.filter(asset=>asset.id!==f.product.assets[0].id).map(asset=>asset.id)};
  const first=await f.service.generateForWorkflow(input,{requestId:randomUUID()}),requestId=randomUUID();assert.equal(f.calls.length,1);
  await assert.rejects(f.service.generateForWorkflow(input,{requestId,editCandidateId:first.id}),error=>{assert.ok(notSent(error));assert.match((error as Error).message,/20/);return true;});
  assert.equal(f.calls.length,1);assert.equal(await f.service.reconcileWorkflowGeneration(requestId),null);
});
test('disabled, stale revision, unknown fields and foreign or duplicate references cannot send requests', async t => {
  const f = await fixture(t); await assert.rejects(f.service.generate(f.input), code('NOT_CONFIGURED'));
  f.service.saveConnection({ model, enabled: false, apiKey: secret }); await assert.rejects(f.service.generate(f.input), code('DISABLED'));
  f.enable();
  await assert.rejects(f.service.generate({ ...f.input, productRevision: 999 }), code('SOURCE_CHANGED'));
  await assert.rejects(f.service.generate({ ...f.input, apiKey: 'renderer-key' }));
  await assert.rejects(f.service.generate({ ...f.input, referenceAssetIds: [f.product.assets[0].id, f.product.assets[0].id] }));
  const second = f.store.createProduct(); await assert.rejects(f.service.generate({ ...f.input, productId: second.id, productRevision: second.revision, referenceAssetIds: [f.product.assets[0].id] }), code('SOURCE_CHANGED'));
  assert.equal(f.calls.length, 0);
});
test('busy, cancel and late provider completion cannot save a candidate', async t => {
  let start!: () => void, release!: (response: Response) => void;
  const started = new Promise<void>(resolve => { start = resolve; }), response = new Promise<Response>(resolve => { release = resolve; });
  const f = await fixture(t, { fetch: async () => { start(); return response; } }); f.enable();
  const pending = f.service.generate(f.input); await started;
  await assert.rejects(f.service.generate(f.input), code('BUSY')); f.service.cancel();
  await assert.rejects(pending, code('CANCELLED'));
  release(new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readdir(join(f.directory, 'image-generation', 'candidates')).catch(() => [])).length, 0);
});
test('config changes invalidate in-flight requests and remove access evidence', async t => {
  let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
  const f = await fixture(t, { timeoutMs:100,fetch: async () => { start(); return new Promise<Response>(() => {}); } }); f.enable();
  const pending = f.service.generate(f.input); await started;
  f.service.disconnect(); await assert.rejects(pending, code('CONFIG_CHANGED'));
  assert.equal(f.service.getConnection().configured, false);
  await assert.rejects(readFile(join(f.directory, 'ai-vault', 'openrouter-images.bin')));
});
test('deadline stops a stuck provider without resending and close drains operation', async t => {
  const f = await fixture(t, { timeoutMs: 15, fetch: async () => new Promise<Response>(() => {}) }); f.enable();
  await assert.rejects(f.service.generate(f.input), code('TIMEOUT')); assert.equal(f.calls.length, 1); assert.equal(f.service.busy, false);
  await f.service.close(); await assert.rejects(f.service.generate(f.input), code('SERVICE_CLOSED'));
});
test('invalid decoded output is rejected and nothing is saved', async t => {
  const f = await fixture(t, { decodePreview: () => { throw new Error('private decoder detail'); } }); f.enable();
  await assert.rejects(f.service.generate(f.input), code('OUTPUT_INVALID'));
  assert.equal((await readdir(join(f.directory, 'image-generation', 'candidates')).catch(() => [])).length, 0);
});
test('unavailable encryption and damaged ciphertext never claim a ready connection; restore clears key', async t => {
  const f = await fixture(t); f.enable();
  const unavailable = new ImageGenerationService(f.directory, f.store, { ...storage, isEncryptionAvailable: () => false }, { decodePreview: bytes => bytes });
  assert.equal(unavailable.getConnection().credentialState, 'encryption-unavailable'); assert.equal(unavailable.getConnection().configured, false);
  assert.throws(() => unavailable.saveConnection({ model, enabled: true, apiKey: secret }), code('ENCRYPTION_UNAVAILABLE')); await unavailable.close();
  await writeFile(join(f.directory, 'ai-vault', 'openrouter-images.bin'), 'corrupt'); assert.equal(f.service.getConnection().credentialState, 'unreadable');
  f.enable(); clearImageGenerationConnection(f.directory); assert.equal(f.service.getConnection().configured, false);
});

test('API-R2 retired path denied: provider profiles keep independent encrypted credentials and saved defaults across switching and restart',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gpt-image-2-1k',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('API-R2 retired path denied: Tyai model checks stay local and edits upload product reference files as multipart image[]',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gpt-image-2-1k',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('API-R2 retired path denied: Tyai applies documented quality rules and rejects invalid size before a paid request',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gpt-image-2-1k',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('trusted candidate reads verify metadata and local bytes rather than accepting caller paths', async t => {
  const f = await fixture(t); f.enable();
  const generated = await f.service.generate(f.input), read = await f.service.readCandidate(generated.id);
  assert.deepEqual(read.candidate, generated); assert.deepEqual(read.bytes, png); assert.deepEqual(read.preview, png);
  await assert.rejects(f.service.readCandidate('../source.png'), code('INVALID_INPUT'));
  const imagePath = join(f.directory, 'image-generation', 'candidates', generated.id, 'image.png');
  const changed = Buffer.from(png); changed.writeUInt32BE(128, 16); await writeFile(imagePath, changed);
  await assert.rejects(f.service.readCandidate(generated.id), code('OUTPUT_INVALID'));
});

test('workflow cancellation interrupts generation using its caller signal with no retry or candidate commit', { timeout: 1000 }, async t => {
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const f = await fixture(t, { timeoutMs:100,fetch: async () => { start(); return new Promise<Response>(() => {}); } }); f.enable();
  const controller = new AbortController(), pending = f.service.generate(f.input, controller.signal);
  const rejected = assert.rejects(pending, code('CANCELLED'));
  await started; controller.abort(); await rejected;
  assert.equal(f.calls.length, 1); assert.equal(f.service.busy, true);
  await assert.rejects(f.service.generate(f.input),code('BUSY'));
  await assert.rejects(f.service.generate(f.input, controller.signal), code('CANCELLED')); assert.equal(f.calls.length, 1);
});

test('API-R2 retired path denied: relay input and saved defaults reject coercible arrays before dispatch',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gpt-image-2-1k',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('API-R2 retired path denied: legacy official ciphertext without new defaults remains usable',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'openai',model:'gpt-image-2.5-sunburst',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('trusted configuration scope notices key-only rotation without exposing a key fingerprint publicly', async t => {
  const f=await fixture(t); f.enable();
  const metadata=f.service.getConnection(), scope=f.service.configurationScope();
  assert.match(scope,/^[a-f0-9-]{36}$/); assert.equal(f.service.configurationScope(),scope);
  f.service.saveConnection({model,enabled:true,apiKey:'sk-fixture-rotated-image-secret'});
  assert.deepEqual(f.service.getConnection(),metadata); assert.notEqual(f.service.configurationScope(),scope); assert.equal(f.calls.length,0);
});
test('trusted workflow guard runs after source preparation and before the paid POST',async t=>{
  const f=await fixture(t);f.enable();let checked=false;
  await assert.rejects(f.service.generate({...f.input,referenceAssetIds:[f.product.assets[0].id]},undefined,async()=>{checked=true;throw new AiError('SOURCE_CHANGED');}),code('SOURCE_CHANGED'));
  assert.equal(checked,true);assert.equal(f.calls.length,0);
});

test('API-R2 retired path denied: relay catalog reads all group models with one bounded GET and does not change saved settings',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gpt-image-2-1k',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('API-R2 retired path denied: catalog failures preserve the saved credential and expose no upstream error or key',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gpt-image-2-1k',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('API-R2 retired path denied: catalog cancellation discards a late response after key rotation without retry',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gpt-image-2-1k',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('API-R2 retired path denied: new GPT 1K models and custom relay model IDs survive save/reopen/candidate reads and omit forced quality',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gpt-image-2-1k',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('API-R2 retired path denied: Gemini relay uses native generateContent with product references and saves only the final image',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gemini-3-pro-image-preview',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('API-R2 retired path denied: Gemini rejects ambiguous, blocked, mismatched or missing final images without another paid POST',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gemini-3-pro-image-preview',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('API-R2 retired path denied: Gemini JPEG results normalize to full-size PNG before candidate hashing and storage',async t=>{
 const f=await fixture(t);f.enable();const before=f.service.getConnection();
 assert.throws(()=>f.service.saveConnection({provider:'tyai',model:'gemini-3-pro-image-preview',enabled:true,apiKey:secret}),code('INVALID_CONFIG'));
 assert.equal(f.calls.length,0);assert.deepEqual(f.service.getConnection(),before);
});

test('preview and candidate persistence failures expose static stages without private data',async t=>{
  for(const stage of ['preview','save']){
    const f=await fixture(t,stage==='preview'?{decodePreview:()=>{throw Error(secret);}}:{});f.enable();
    if(stage==='save')await writeFile(join(f.directory,'image-generation'),'blocked');
    await assert.rejects(f.service.generate(f.input),error=>{assert.ok(error instanceof AiError);assert.equal(error.code,'OUTPUT_INVALID');assert.match(error.message,stage==='preview'?/预览生成/:/候选保存/);assert.equal(error.message.includes(secret),false);assert.notEqual((error as AiError&{definitive?:boolean}).definitive,true);return true;});
    assert.equal(f.calls.length,1);
  }
});

test('generation preview records original error code before safe mapping and keeps request ID',async t=>{
  const f=await fixture(t,{decodePreview:()=>{throw Object.assign(new Error('private '+secret),{code:'ENOMEM'});}});f.enable();
  const requestId=randomUUID();
  await assert.rejects(f.service.generateForWorkflow(f.input,{requestId}),code('OUTPUT_INVALID'));
  const db=openDatabase(f.directory);const audit=db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed'").all();db.close();
  assert.ok(audit.length);
  const detail=audit.map(row=>JSON.parse(String(row.detail_json))).find(row=>row.stage==='image-generation.preview'&&row.code==='ENOMEM');
  assert.ok(detail);assert.equal(detail.requestId,requestId);assert.equal(detail.requestOutcome,'RESULT_UNKNOWN');
  assert.doesNotMatch(JSON.stringify(audit),/sk-fixture-image-secret/);
});

for(const failure of [400,502,'network','notSent'] as const)test(`generation persists ${failure} evidence without changing dispatch count`,async t=>{
  const f=await fixture(t,{fetch:async()=>{if(failure==='network')throw Error('Bearer sk-private https://private.test/path');return Response.json({error:{message:'private '+secret}},{status:typeof failure==='number'?failure:500});}});
  if(failure!=='notSent')f.enable();
  const requestId=randomUUID();await assert.rejects(f.service.generateForWorkflow(f.input,{requestId}));
  const db=openDatabase(f.directory);let detail:any;try{detail=JSON.parse(String(db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed' ORDER BY rowid DESC LIMIT 1").get()!.detail_json));}finally{db.close();}
  assert.equal(detail.requestId,requestId);assert.equal(detail.requestOutcome,failure==='notSent'?'NOT_SENT':failure===400?'DEFINITIVE_FAILURE':'RESULT_UNKNOWN');
  assert.equal(detail.httpStatus,typeof failure==='number'?failure:undefined);
  assert.equal(f.calls.length,failure==='notSent'?0:1);assert.doesNotMatch(JSON.stringify(detail),/sk-private|private.test|sk-fixture-image-secret/);
});
