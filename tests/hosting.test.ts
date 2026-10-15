import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { importImageFiles } from '../src/main/assets.ts';
import { openDatabase } from '../src/main/database.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import type { HostingDependencies } from '../src/main/hosting/service.ts';
import type { SecretStorage } from '../src/main/amazon/vault.ts';
import { HostingError } from '../src/main/hosting/errors.ts';
import { BasicFtpTransport, FtpConnectionPool } from '../src/main/hosting/ftp.ts';
import type { FtpClient } from '../src/main/hosting/ftp.ts';
import { validatePersistedProfile, validatePersistedUpload } from '../src/main/hosting/validation.ts';
import {SpendBudgetError} from '../src/main/ai/spend-records.ts';
import {ControlledRunScopes,pauseControlledRunScopes} from '../src/main/application/controlled-run-scope.ts';

const secretKey = randomBytes(32);
const storage: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secretKey, iv); const body = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
  decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', secretKey, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
};
const profileInput = { id: 'alpha', host: 'ftp.example.test', port: 2121, secure: false, username: 'fixture-user-secret', password: 'fixture-password-secret', remoteRoot: '/', publicBaseUrl: 'https://htc.185858.xyz/AAA/' };
async function fixture(t: test.TestContext, overrides: HostingDependencies = {}) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/hosting-'));
  const store = new WorkspaceStore(directory), calls = { upload: 0, size: 0, probe: 0, sleep: [] as number[] };
  const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(10, 16); bytes.writeUInt32BE(10, 20);
  const source = join(directory, 'source.png'); await writeFile(source, bytes);
  let product = store.createProduct();
  product = await importImageFiles(store, directory, { productId: product.id, revision: product.revision }, [source], b => b);
  product = store.updateAsset({ productId: product.id, revision: product.revision, assetId: product.assets[0].id, role: 'main', variantIds: [product.variants[0].id] });
  let remote: number | null = null;
  const dependencies: HostingDependencies = {
    transport: { async size() { calls.size++; return remote; }, async upload(_profile, _credentials, _path, data) { calls.upload++; remote = data.length; return remote; }, async close() {} },
    probe: async () => { calls.probe++; }, sleep: async ms => { calls.sleep.push(ms); }, random: () => 0,
    ...overrides,
  };
  const service = new HostingService(directory, store, storage, dependencies);
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const configured = service.importProfile(profileInput);
  const profile = service.setEnabled({ id: configured.id, enabled: true });
  const input = { assetId: product.assets[0].id, profileId: profile.id, generation: profile.generation, batchId: randomUUID() };
  return { directory, store, service, dependencies, calls, bytes, product, input };
}

test('actual hosting budget denial is before a new upload identity or attempt and preserves a saved uncertain path',async t=>{
 let denied=true,prepared:any;const f=await fixture(t,{prepareUpload:async(context:any)=>{prepared=context;if(denied)throw new SpendBudgetError('SPEND_BOUND_UNAVAILABLE');return (db:any)=>assert.equal(db.isTransaction,true);}} as any),before=f.service.listUploads();
 await assert.rejects(f.service.upload(f.input),(e:any)=>e.diagnosticReason==='SPEND_BOUND_UNAVAILABLE');assert.deepEqual(f.service.listUploads(),before);assert.deepEqual([f.calls.size,f.calls.upload,f.calls.probe],[0,0,0]);assert.equal(prepared.productId,f.product.id);assert.deepEqual(prepared.variantIds,[f.product.variants[0].id]);assert.deepEqual(prepared.skus,[f.product.variants[0].sku]);assert.equal(prepared.sha256,f.store.getAssetRecord(f.input.assetId)!.sha256);assert.equal(prepared.profile.host,'ftp.example.test');assert.ok(prepared.remotePath.endsWith('.png'));
 denied=false;const first=await f.service.upload(f.input),db=openDatabase(f.directory),uncertain={...first,status:'FAILED',errorCode:'CONNECT_TIMEOUT'};db.prepare('UPDATE hosting_uploads SET record_json=? WHERE id=?').run(JSON.stringify(uncertain),first.id);denied=true;const counts=[f.calls.size,f.calls.upload,f.calls.probe],saved=db.prepare('SELECT * FROM hosting_uploads').all();await assert.rejects(f.service.upload({...f.input,batchId:randomUUID()}),(e:any)=>e.diagnosticReason==='SPEND_BOUND_UNAVAILABLE');assert.deepEqual(db.prepare('SELECT * FROM hosting_uploads').all(),saved);assert.deepEqual([f.calls.size,f.calls.upload,f.calls.probe],counts);assert.equal(prepared.uploadId,first.id);assert.equal(prepared.remotePath,first.remotePath);db.close();
});

test('actual hosting rechecks the original controlled capability in its physical intent transaction after async quote preparation',async t=>{
 let scopes!:ControlledRunScopes,entered!:()=>void,release!:()=>void;const began=new Promise<void>(done=>entered=done),hold=new Promise<void>(done=>release=done);
 const f=await fixture(t,{prepareUpload:async(context:any)=>{scopes.authorizeEffect({kind:'hosting',productId:context.productId});entered();await hold;return (db:any)=>{assert.equal(db.isTransaction,true);new ControlledRunScopes(db).authorizeEffect({kind:'hosting',productId:context.productId});};}} as any),db=openDatabase(f.directory),task={id:randomUUID(),revision:1,status:'RUNNING',mode:'live',targetId:'synthetic',sellerId:'seller',marketplaceId:'US',items:[{key:'first',sku:f.product.variants[0].sku,productId:f.product.id,variantId:f.product.variants[0].id}]};db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));scopes=new ControlledRunScopes(db);const scope=scopes.register({taskId:task.id,expectedTaskRevision:1,targetId:task.targetId,sellerId:task.sellerId,marketplaceId:task.marketplaceId,items:[{itemKey:'first',sku:task.items[0].sku,productId:f.product.id,variantIds:[task.items[0].variantId],recipeKey:null,parentage:'NONE'}]}),grant=scopes.activate(scope.id),pending=grant(()=>f.service.upload(f.input));await began;pauseControlledRunScopes(db);release();await assert.rejects(pending,(e:any)=>e.diagnosticReason==='CONTROLLED_RUN_SCOPE_BLOCKED');assert.equal(f.service.listUploads().length,0);assert.deepEqual([f.calls.size,f.calls.upload,f.calls.probe],[0,0,0]);db.close();
});

test('actual FTP pool rechecks every command, including a capability revoked after directory creation',async t=>{
 const f=await fixture(t),wire:string[]=[],checks:string[]=[];let revoked=false;const client={closed:false,async access(){wire.push('connect');},close(){this.closed=true;},async ensureDir(){wire.push('directory');revoked=true;},async cd(){wire.push('cd');},async uploadFrom(){wire.push('upload');},async size(){wire.push('size');return f.bytes.length;}};
 const pool=new FtpConnectionPool({createClient:()=>client,beforeEffect:(effect:any)=>{checks.push(effect.kind);assert.equal(effect.profile.host,'ftp.example.test');if(revoked)throw new SpendBudgetError('SPEND_BOUND_UNAVAILABLE');}} as any),transport=new BasicFtpTransport(pool);
 try{await assert.rejects(transport.upload(f.service.getProfile('alpha'),{username:'synthetic',password:'synthetic'},'/fixed/asset.png',f.bytes,new AbortController().signal));assert.deepEqual(wire,['connect','directory']);assert.deepEqual(checks,['connect','directory','upload']);}finally{await transport.close();}
});

test('five fixed profiles start disabled without credentials and reject arbitrary config fields', async t => {
  const f = await fixture(t);
  const profiles = f.service.listProfiles();
  assert.deepEqual(profiles.map(p => p.id), ['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
  assert.equal(profiles[1].port, 2121); assert.equal(profiles[1].configured, false); assert.equal(profiles[1].enabled, false);
  assert.deepEqual(profiles.map(p => new URL(p.publicBaseUrl).pathname), ['/AAA/', '/BBB/', '/CCC/', '/DDD/', '/EEE/']);
  assert.throws(() => f.service.importProfile({ ...profileInput, id: 'other' }), /配置/);
  assert.throws(() => f.service.importProfile({ ...profileInput, localPath: 'C:/outside.png' }), /配置/);
  for (const publicBaseUrl of ['http://example.test/', 'https://user:pass@example.test/', 'https://example.test/?secret=1', 'https://example.test/#secret', 'https://127.0.0.1/']) {
    assert.throws(() => f.service.importProfile({ ...profileInput, publicBaseUrl }), /配置/);
  }
});

test('vault encrypts username/password; database and exposed profiles have no credentials', async t => {
  const f = await fixture(t), db = openDatabase(f.directory);
  const publicData = JSON.stringify(f.service.listProfiles()) + JSON.stringify(db.prepare('SELECT * FROM hosting_profiles').all()); db.close();
  for (const secret of [profileInput.username, profileInput.password]) {
    assert.equal(publicData.includes(secret), false);
    assert.equal((await readFile(join(f.directory, 'hosting-vault', 'alpha.bin'))).includes(Buffer.from(secret)), false);
  }
  const unavailable = new HostingService(f.directory, f.store, { ...storage, isEncryptionAvailable: () => false }, f.dependencies);
  assert.equal(unavailable.getProfile('alpha').configured, false);
  assert.throws(() => unavailable.importProfile(profileInput), /加密/);
  await unavailable.close();
});

test('full verified upload is idempotent across restarts and stable across caller batch IDs', async t => {
  const f = await fixture(t);
  const first = await f.service.upload(f.input);
  assert.equal(first.status, 'AVAILABLE'); assert.equal(first.attempts, 1);
  assert.match(first.remotePath, /^\/\d{8}\/[a-f0-9-]{36}\/[a-f0-9-]{36}-[a-f0-9]{16}\.png$/);
  assert.ok(first.publicUrl.startsWith('https://htc.185858.xyz/AAA/'));
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.probe, 1);
  await f.service.close();
  const nextService = new HostingService(f.directory, f.store, storage, f.dependencies);
  const next = await nextService.upload({ ...f.input, batchId: randomUUID() });
  assert.equal(next.id, first.id); assert.equal(next.publicUrl, first.publicUrl); assert.equal(f.calls.upload, 1);
  assert.equal(f.calls.probe, 2); await nextService.close();
});

test('interrupted uploads recover to pending and recheck remote size before overwriting', async t => {
  const f = await fixture(t), first = await f.service.upload(f.input); await f.service.close();
  const db = openDatabase(f.directory); db.prepare('UPDATE hosting_uploads SET record_json=? WHERE id=?').run(JSON.stringify({ ...first, status: 'UPLOADING' }), first.id); db.close();
  const restarted = new HostingService(f.directory, f.store, storage, f.dependencies);
  assert.equal(restarted.listUploads()[0].status, 'PENDING'); assert.equal(f.calls.probe, 1);
  assert.equal((await restarted.upload(f.input)).status, 'AVAILABLE'); assert.equal(f.calls.upload, 1);
  await restarted.close();
});

test('unconfirmed, detail, changed, missing and stale generation assets never reach FTP', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.upload({ ...f.input, generation: f.input.generation + 1 }), (e: unknown) => e instanceof HostingError && e.code === 'PROFILE_CHANGED');
  const p = f.store.updateAsset({ productId: f.product.id, revision: f.product.revision, assetId: f.input.assetId, role: 'detail', variantIds: [f.product.variants[0].id] });
  await assert.rejects(f.service.upload(f.input), (e: unknown) => e instanceof HostingError && e.code === 'ASSET_NOT_CONFIRMED');
  const next = f.store.updateAsset({ productId: p.id, revision: p.revision, assetId: f.input.assetId, role: 'main', variantIds: [] });
  await assert.rejects(f.service.upload(f.input), (e: unknown) => e instanceof HostingError && e.code === 'ASSET_NOT_CONFIRMED');
  f.store.updateAsset({ productId: p.id, revision: next.revision, assetId: f.input.assetId, role: 'main', variantIds: [p.variants[0].id] });
  const path = join(f.directory, 'assets', `${f.input.assetId}.png`); await writeFile(path, Buffer.alloc(f.bytes.length));
  await assert.rejects(f.service.upload(f.input), (e: unknown) => e instanceof HostingError && e.code === 'LOCAL_FILE_CHANGED');
  await rm(path);
  await assert.rejects(f.service.upload(f.input), (e: unknown) => e instanceof HostingError && e.code === 'LOCAL_FILE_MISSING');
  assert.equal(f.calls.upload, 0); assert.equal(f.calls.size, 0);
});

test('retryable failures are bounded and never persist raw FTP messages', async t => {
  const f = await fixture(t, { transport: { async size() { return null; }, async upload() { throw Object.assign(new Error('421 fixture-password-secret C:/secret/file.png'), { code: 421 }); }, async close() {} } });
  const record = await f.service.upload(f.input);
  assert.equal(record.status, 'FAILED'); assert.equal(record.attempts, 3); assert.equal(record.errorCode, 'CONNECTION_LIMIT');
  assert.equal(f.calls.sleep.length, 2); assert.ok(f.calls.sleep[1] > f.calls.sleep[0]);
  assert.equal(JSON.stringify(f.service.listUploads()).includes(profileInput.password), false);
});

test('authentication fails once and mismatch never becomes available', async t => {
  const f = await fixture(t, { transport: { async size() { return null; }, async upload() { throw Object.assign(new Error('530 sensitive detail'), { code: 530 }); }, async close() {} } });
  const record = await f.service.upload(f.input);
  assert.equal(record.status, 'FAILED'); assert.equal(record.attempts, 1); assert.equal(record.errorCode, 'AUTH_FAILED');
  assert.equal(f.calls.sleep.length, 0); assert.equal(f.calls.probe, 0);
});

test('HTTP 200 is insufficient when the returned public image differs', async t => {
  const f = await fixture(t, { probe: async () => { throw new HostingError('PUBLIC_URL_CONTENT_MISMATCH'); } });
  const record = await f.service.upload(f.input);
  assert.equal(record.status, 'FAILED'); assert.equal(record.errorCode, 'PUBLIC_URL_CONTENT_MISMATCH');
});

test('cancellation during transport is persisted and disables final promotion', async t => {
  let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
  const f = await fixture(t, { transport: { async size() { return null; }, async upload(_p, _c, _r, _b, signal) { start(); await new Promise<void>((_r, reject) => signal.addEventListener('abort', () => reject(new HostingError('CANCELLED')), { once: true })); return 33; }, async close() {} } });
  const controller = new AbortController(), pending = f.service.upload(f.input, controller.signal);
  await started; controller.abort(); const record = await pending;
  assert.equal(record.status, 'CANCELLED'); assert.equal(record.errorCode, 'CANCELLED'); assert.equal(f.calls.probe, 0);
});

test('profile re-import increments generation and invalidates existing hosted content', async t => {
  const f = await fixture(t), first = await f.service.upload(f.input);
  const replacement = f.service.importProfile({ ...profileInput, password: 'different-secret' });
  assert.equal(replacement.generation, f.input.generation + 1); assert.equal(replacement.enabled, false);
  await assert.rejects(f.service.verify(first.id), (e: unknown) => e instanceof HostingError && e.code === 'PROFILE_CHANGED');
});

test('persisted record validators reject unknown keys including secret injection', async t => {
  const f = await fixture(t), record = await f.service.upload(f.input);
  assert.deepEqual(validatePersistedProfile(f.service.getProfile('alpha')), f.service.getProfile('alpha'));
  assert.deepEqual(validatePersistedUpload(record), record);
  assert.throws(() => validatePersistedProfile({ ...f.service.getProfile('alpha'), password: 'secret' }));
  assert.throws(() => validatePersistedUpload({ ...record, credentials: { password: 'secret' } }));
  assert.throws(() => validatePersistedUpload({ ...record, remotePath: '/../../escape' }));
  assert.throws(() => validatePersistedUpload({ ...record, publicUrl: 'https://localhost/secret' }));
});

test('a junction escaping the managed workspace never reaches FTP even with matching bytes', async t => {
  const f = await fixture(t), outside = await mkdtemp(resolve('.test-data/hosting-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, `${f.input.assetId}.png`), f.bytes);
  await rename(join(f.directory, 'assets'), join(f.directory, 'assets-original'));
  await symlink(outside, join(f.directory, 'assets'), 'junction');
  await assert.rejects(f.service.upload(f.input), (e: unknown) => e instanceof HostingError && e.code === 'LOCAL_FILE_CHANGED');
  assert.equal(f.calls.upload, 0); assert.equal(f.calls.size, 0);
});

test('bounded SIZE mismatch retries do not perform a public probe', async t => {
  const f = await fixture(t, { transport: { async size() { return 1; }, async upload() { return 2; }, async close() {} } });
  const record = await f.service.upload(f.input);
  assert.equal(record.status, 'FAILED'); assert.equal(record.errorCode, 'SIZE_MISMATCH'); assert.equal(record.attempts, 3); assert.equal(f.calls.probe, 0);
});

test('a transient public 404 retries only verification when the remote SIZE already matches', async t => {
  let probes = 0;
  const f = await fixture(t, { probe: async () => { if (++probes === 1) throw new HostingError('PUBLIC_URL_NOT_FOUND'); } });
  const record = await f.service.upload(f.input);
  assert.equal(record.status, 'AVAILABLE'); assert.equal(record.attempts, 2); assert.equal(f.calls.upload, 1); assert.equal(record.history[0].errorCode, 'PUBLIC_URL_NOT_FOUND');
});

test('the total timeout ends a stalled transport even if it ignores cancellation', async t => {
  const f = await fixture(t, { totalTimeoutMs: 25, transport: { async size() { return null; }, async upload() { return new Promise<number>(() => {}); }, async close() {} } });
  const record = await f.service.upload(f.input);
  assert.equal(record.status, 'FAILED'); assert.equal(record.errorCode, 'CONNECT_TIMEOUT'); assert.equal(record.attempts, 1);
});

test('disabling the profile while a public probe is active cannot promote the image', async t => {
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  const f = await fixture(t, { probe: async () => { enter(); await new Promise<void>(() => {}); } });
  const pending = f.service.upload(f.input); await entered;
  f.service.setEnabled({ id: f.input.profileId, enabled: false });
  const record = await pending;
  assert.equal(record.status, 'FAILED'); assert.equal(record.errorCode, 'PROFILE_DISABLED');
});

test('concurrent repeated uploads use one remote upload and return the same record', async t => {
  const f = await fixture(t);
  const rows = await Promise.all(Array.from({ length: 5 }, () => f.service.upload(f.input)));
  assert.equal(new Set(rows.map(row => row.id)).size, 1); assert.equal(f.calls.upload, 1); assert.equal(f.service.listUploads().length, 1);
});

test('unconfirmed database SKU associations are not treated as human confirmed', async t => {
  const f = await fixture(t), db = openDatabase(f.directory);
  db.prepare('UPDATE variant_assets SET confirmed=0 WHERE asset_id=?').run(f.input.assetId); db.close();
  await assert.rejects(f.service.upload(f.input), (e: unknown) => e instanceof HostingError && e.code === 'ASSET_NOT_CONFIRMED');
  assert.equal(f.calls.upload, 0);
});

function transportWithDirectoryFailure(code: string | number) {
  let directoryAttempts = 0, uploads = 0, connections = 0, remoteSize: number | null = null;
  const pool = new FtpConnectionPool({ createClient: (): FtpClient => {
    connections++; let closed = false;
    return {
      get closed() { return closed; }, async access() {}, close() { closed = true; }, async cd() {},
      async ensureDir() { if (++directoryAttempts === 1 || code === 550) throw Object.assign(new Error('fixture server detail'), { code }); },
      async uploadFrom(source) { uploads++; let bytes = 0; for await (const chunk of source) bytes += Buffer.byteLength(chunk); remoteSize = bytes; },
      async size() { if (remoteSize === null) throw Object.assign(new Error('file missing'), { code: 550 }); return remoteSize; },
    };
  } });
  return { transport: new BasicFtpTransport(pool), counts: () => ({ directoryAttempts, uploads, connections }) };
}

test('a connection reset while ensuring the remote directory retries through the hosting service', async t => {
  const remote = transportWithDirectoryFailure('ECONNRESET'), f = await fixture(t, { transport: remote.transport });
  const record = await f.service.upload(f.input);
  assert.equal(record.status, 'AVAILABLE'); assert.equal(record.attempts, 2);
  assert.equal(record.history[0].errorCode, 'UPLOAD_FAILED'); assert.equal(f.calls.sleep.length, 1);
  assert.deepEqual(remote.counts(), { directoryAttempts: 2, uploads: 1, connections: 2 });
});

test('a permanent FTP 550 directory permission error fails without an automatic retry', async t => {
  const remote = transportWithDirectoryFailure(550), f = await fixture(t, { transport: remote.transport });
  const record = await f.service.upload(f.input);
  assert.equal(record.status, 'FAILED'); assert.equal(record.attempts, 1);
  assert.equal(record.errorCode, 'REMOTE_DIRECTORY_FAILED'); assert.equal(f.calls.sleep.length, 0); assert.equal(f.calls.probe, 0);
  assert.deepEqual(remote.counts(), { directoryAttempts: 1, uploads: 0, connections: 1 });
});

test('W07 reference FTP uses immutable full hash path and never creates listing upload',async t=>{
 const f=await fixture(t),asset=f.store.getAssetRecord(f.input.assetId)!;
 const version={assetId:asset.id,sha256:asset.sha256,sourceKind:'source' as const,sourceVersion:'synthetic-v1',originalPath:asset.originalPath,byteSize:asset.byteSize,mimeType:'image/png' as const};
 const url=await f.service.uploadReferenceVersion('alpha',f.input.generation,version,f.bytes);
 assert.ok(url.includes(`/references/${asset.sha256}.png`));assert.equal(f.service.listUploads().length,0);assert.equal(f.calls.upload,1);
 assert.equal(await f.service.uploadReferenceVersion('alpha',f.input.generation,version,f.bytes),url);assert.equal(f.calls.upload,1);
});
test('W07 existing reference version with wrong remote size is never overwritten',async t=>{
 let writes=0;const f=await fixture(t,{transport:{async size(){return 1;},async upload(){writes++;return 33;},async close(){}}}),asset=f.store.getAssetRecord(f.input.assetId)!;
 await assert.rejects(f.service.uploadReferenceVersion('alpha',f.input.generation,{assetId:asset.id,sha256:asset.sha256,sourceKind:'source',sourceVersion:'synthetic-v1',originalPath:asset.originalPath,byteSize:asset.byteSize,mimeType:'image/png'},f.bytes));assert.equal(writes,0);
});
import {ReferencePinService} from '../src/main/hosting/reference-pins.ts';
import {createReferenceVersionReader} from '../src/main/hosting/reference-version-reader.ts';
test('W07 M09 managed source reader and pin use fake FTP without listing adoption',async t=>{
 const f=await fixture(t),db=openDatabase(f.directory),asset=f.store.getAssetRecord(f.input.assetId)!;db.exec('CREATE TABLE IF NOT EXISTS image_reference_pins(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)');
 try{const pins=new ReferencePinService(db,{readVersion:createReferenceVersionReader(f.directory,f.store,{readCandidate:async()=>{throw Error('no candidate fallback');}}),uploadVersion:(version,bytes,signal)=>f.service.uploadReferenceVersion('alpha',f.input.generation,version,bytes,signal),probe:async()=>{}});
 const before=f.store.getProduct(f.product.id),pin=await pins.prepare({operationId:randomUUID(),assetId:asset.id,sha256:asset.sha256,purpose:'source-reference'});assert.equal(pins.validateReference(pins.reference(pin.id)),true);assert.equal(f.service.listUploads().length,0);assert.deepEqual(f.store.getProduct(f.product.id),before);assert.equal(f.calls.upload,1);
 }finally{db.close();}
});
