import test from 'node:test';

test('DeepSeek thinking preference reaches the paid request and call record and survives restart', async t => {
  const f = await fixture(t);
  f.enable('deepseek');
  const profile = f.service.getProfile('deepseek');
  f.service.saveFunctionSettings({id:'deepseek',model:profile.model,enabled:true,thinking:true});
  const product = f.store.getProduct(f.input.productId);
  await f.service.suggest({productId:product.id,productRevision:product.revision,variantId:product.variants[0].id,ocrResultIds:[]});
  const body = JSON.parse(String(f.requests.at(-1)!.options?.body));
  assert.deepEqual(body.thinking,{type:'enabled'});
  assert.ok(body.max_tokens >= 16384);
  assert.equal(f.service.listCalls().at(-1)!.thinking,true);
  await f.service.close();
  const reopened = new AiService(f.directory,f.store,f.hosting,storage);
  try { assert.equal(reopened.getProfile('deepseek').thinking,true); }
  finally { await reopened.close(); }
});
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { importImageFiles } from '../src/main/assets.ts';
import { openDatabase } from '../src/main/database.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import type { HostingDependencies } from '../src/main/hosting/service.ts';
import { AiService } from '../src/main/ai/service.ts';
import type { AiDependencies } from '../src/main/ai/service.ts';
import { AiError } from '../src/main/ai/errors.ts';
import type { SecretStorage } from '../src/main/amazon/vault.ts';
import type { ProductDetail, SaveProductInput } from '../src/shared/contracts.ts';
import type { AiProviderId } from '../src/shared/ai-contracts.ts';

const key = randomBytes(32);
const storage: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), encrypted = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
  decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
};
const aliyun = { accessKeyId: 'fixture-access-key-id', accessKeySecret: 'fixture-access-key-secret' };
const deepseek = { id: 'deepseek', model: 'deepseek-flash', apiKey: 'fixture-api-key-secret' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const ocr = (text = 'Cotton') => json({ RequestId: 'ocr-fixture', Data: { Width: 256, Height: 256, Content: text, SubImageCount: 1, SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: text, BlockConfidence: 98.6 }] } }] } });
function saveInput(p: ProductDetail): SaveProductInput { return { id: p.id, revision: p.revision, title: p.title, sourceUrl: p.sourceUrl, description: p.description, status: p.status, variants: p.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })), facts: p.facts }; }
const isCode = (code: string) => (e: unknown) => e instanceof AiError && e.code === code;
function gate() { let entered!: () => void, release!: (response: Response) => void; const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<Response>(resolve => { release = resolve; }); return { started, release, fetch: (async () => { entered(); return held; }) as typeof fetch }; }
async function fixture(t: test.TestContext, dependencies: AiDependencies = {}, hostDependencies: HostingDependencies = {}) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/ai-service-')), store = new WorkspaceStore(directory);
  let product = store.createProduct();
  product = store.saveProduct({ ...saveInput(product), title: 'Source cotton cloth', variants: [{ ...saveInput(product).variants[0], originalSpec: 'Blue / M', normalizedSpec: 'Blue, medium', purchasePrice: '12345678.9876', inventory: 87654321 }], facts: [{ id: randomUUID(), name: 'Material', value: 'Cotton', source: 'manual', sourceRef: 'private-source-ref', state: 'human_confirmed' }, { id: randomUUID(), name: 'Unconfirmed', value: 'UNCONFIRMED_SENTINEL', source: 'ai', sourceRef: '', state: 'ai_suggested' }] });
  const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(256, 16); bytes.writeUInt32BE(256, 20);
  const source = join(directory, 'source.png'); await writeFile(source, bytes);
  product = await importImageFiles(store, directory, { productId: product.id, revision: product.revision }, [source], b => b);
  product = store.updateAsset({ productId: product.id, revision: product.revision, assetId: product.assets[0].id, role: 'main', variantIds: [product.variants[0].id] });
  let remote: number | null = null, probes = 0;
  const hosting = new HostingService(directory, store, storage, { transport: { async size() { return remote; }, async upload(_p, _c, _path, data) { remote = data.length; return remote; }, async close() {} }, probe: async () => { probes++; }, ...hostDependencies });
  hosting.importProfile({ id: 'alpha', host: 'fixture.example.test', port: 2121, secure: false, username: 'fixture-user', password: 'fixture-password', remoteRoot: '/', publicBaseUrl: 'https://htc.185858.xyz/AAA/' });
  hosting.setEnabled({ id: 'alpha', enabled: true });
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const service = new AiService(directory, store, hosting, storage, { ...dependencies, fetch: async (url, options) => {
    requests.push({ url: String(url), options });
    if (dependencies.fetch) return dependencies.fetch(url, options);
    if (String(url).includes('ocr-api.')) return ocr();
    if (String(url).includes('aidge.')) return json({ Success: true, Code: 'success', RequestId: 'seg-fixture', Data: { Width: 256, Height: 256, ImageUrl: 'https://output.oss-cn-beijing.aliyuncs.com/cutout.png?Signature=temporary', Score: 5.95, UsageMap: { ProcessedImageCount: 1 } } });
    const body = JSON.parse(String(options?.body)), payload = JSON.parse(body.messages[1].content), fact = payload.confirmedFacts[0];
    return json({ id: 'chat-fixture', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'Cotton cloth', bullets: ['Cotton material'], description: 'Cotton cloth.', attributes: fact ? [{ name: fact.name, value: fact.value, factIds: [fact.id] }] : [] }) } }], usage: { prompt_tokens: 25, completion_tokens: 32 } });
  } });
  t.after(async () => { await service.close(); await hosting.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const enable = (id: AiProviderId) => { service.importProfile(id === 'deepseek' || id === 'deepseek-review' ? { ...deepseek, id } : { id, ...aliyun }); return service.setEnabled({ id, enabled: true }); };
  const input = { productId: product.id, productRevision: product.revision, assetId: product.assets[0].id };
  const upload = () => hosting.upload({ assetId: input.assetId, profileId: 'alpha', generation: hosting.getProfile('alpha').generation, batchId: randomUUID() });
  return { directory, service, store, product, bytes, requests, hosting, input, enable, upload, probes: () => probes };
}

test('providers start disabled; imports encrypt credentials and templates never reveal configured values', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.service.listProfiles().map(p=>p.id).sort(), ['aliyun-ocr','aidge-segmentation','deepseek','deepseek-review','aliyun-image-risk','openrouter','openrouter-review'].sort()); assert.ok(f.service.listProfiles().every(p => !p.enabled && !p.configured));
  assert.equal(f.service.capabilities().find(c => c.capability === 'image-generation')!.available, false);
  assert.throws(() => f.service.setEnabled({ id: 'aliyun-ocr', enabled: true }), isCode('NOT_CONFIGURED'));
  const configured = f.service.importProfile({ id: 'aliyun-ocr', ...aliyun }); assert.equal(configured.enabled, false); assert.equal(configured.configured, true);
  await assert.rejects(f.service.recognize(f.input), isCode('DISABLED'));
  const db = openDatabase(f.directory), publicData = JSON.stringify(f.service.listProfiles()) + JSON.stringify(f.service.template('aliyun-ocr')) + JSON.stringify(db.prepare('SELECT * FROM ai_profiles').all()); db.close();
  for (const secret of Object.values(aliyun)) { assert.equal(publicData.includes(secret), false); assert.equal((await readFile(join(f.directory, 'ai-vault', 'aliyun-ocr.bin'))).includes(Buffer.from(secret)), false); }
  assert.equal(f.requests.length, 0);
});

test('Commerce OCR persists a separate unreviewed result and one successful call with normalized confidence', async t => {
  const f = await fixture(t); f.enable('aliyun-ocr');
  const result = await f.service.recognize(f.input), calls = f.service.listCalls();
  assert.equal(result.reviewState, 'unreviewed'); assert.equal(result.output.kind, 'ocr');
  if (result.output.kind === 'ocr') { assert.equal(result.output.lines[0].confidence, 0.986); assert.equal(result.output.coordinateSpace, 'unknown'); }
  assert.equal(calls.length, 1); assert.equal(calls[0].status, 'SUCCEEDED'); assert.equal(calls[0].usage.processedImages, 1); assert.equal(result.callId, calls[0].id);
  assert.equal(f.store.getProduct(f.product.id).revision, f.product.revision); assert.equal(f.service.listResults(f.product.id).length, 1); assert.equal(f.requests.length, 1);
});

test('disconnect deletes encrypted credentials and rotates generation; restore configured=false cannot reuse a surviving vault', async t => {
  const f = await fixture(t), profile = f.enable('aliyun-ocr');
  const db = openDatabase(f.directory); db.prepare('UPDATE ai_profiles SET record_json=? WHERE id=?').run(JSON.stringify({ ...profile, configured: false, enabled: false }), profile.id); db.close();
  assert.equal(f.service.getProfile(profile.id).configured, false); assert.throws(() => f.service.setEnabled({ id: profile.id, enabled: true }), isCode('NOT_CONFIGURED'));
  const disconnected = f.service.disconnect(profile.id); assert.equal(disconnected.generation, profile.generation + 1); assert.equal(disconnected.configured, false);
  await assert.rejects(readFile(join(f.directory, 'ai-vault', `${profile.id}.bin`)));
});

test('profile import and disconnect roll back the vault if database persistence fails', async t => {
  const f = await fixture(t), before = f.enable('aliyun-ocr'), encrypted = await readFile(join(f.directory, 'ai-vault', 'aliyun-ocr.bin'));
  const db = openDatabase(f.directory); db.exec("CREATE TRIGGER ai_profile_failure BEFORE UPDATE ON ai_profiles BEGIN SELECT RAISE(ABORT,'fixture-access-key-secret'); END;");
  assert.throws(() => f.service.importProfile({ id: 'aliyun-ocr', ...aliyun, accessKeySecret: 'new-fixture-secret' }), e => e instanceof AiError && !e.message.includes(aliyun.accessKeySecret));
  assert.deepEqual(await readFile(join(f.directory, 'ai-vault', 'aliyun-ocr.bin')), encrypted); assert.deepEqual(f.service.getProfile('aliyun-ocr'), before);
  assert.throws(() => f.service.disconnect('aliyun-ocr'), AiError); assert.deepEqual(await readFile(join(f.directory, 'ai-vault', 'aliyun-ocr.bin')), encrypted);
  db.exec('DROP TRIGGER ai_profile_failure'); db.close();
});

test('unavailable encryption refuses imports and invalidates matching vault availability', async t => {
  const f = await fixture(t); f.enable('deepseek');
  const unavailable = new AiService(f.directory, f.store, f.hosting, { ...storage, isEncryptionAvailable: () => false });
  assert.equal(unavailable.getProfile('deepseek').configured, false);
  assert.throws(() => unavailable.importProfile(deepseek), isCode('ENCRYPTION_UNAVAILABLE'));
  assert.throws(() => unavailable.setEnabled({ id: 'deepseek', enabled: true }), isCode('NOT_CONFIGURED'));
  await unavailable.close();
});

test('OCR and Aidge reject out-of-range image dimensions and byte sizes before requests', async t => {
  const f = await fixture(t); f.enable('aliyun-ocr'); f.enable('aidge-segmentation');
  const db = openDatabase(f.directory);
  for (const [width, height, byteSize] of [[15, 256, 33], [8192, 256, 33], [8000, 160, 33], [256, 256, 10 * 1024 * 1024 + 1]]) {
    db.prepare('UPDATE assets SET width=?,height=?,byte_size=? WHERE id=?').run(width, height, byteSize, f.input.assetId);
    await assert.rejects(f.service.recognize(f.input), isCode('IMAGE_INVALID'));
  }
  for (const side of [255, 3001]) {
    db.prepare('UPDATE assets SET width=?,height=256,byte_size=33 WHERE id=?').run(side, f.input.assetId);
    await assert.rejects(f.service.segment({ ...f.input, hostedAssetId: randomUUID() }), isCode('IMAGE_INVALID'));
  }
  db.close(); assert.equal(f.requests.length, 0); assert.equal(f.service.listCalls().length, 0);
});

test('missing, changed, cross-product and revision-stale sources make no billable call', async t => {
  const f = await fixture(t); f.enable('aliyun-ocr');
  await assert.rejects(f.service.recognize({ ...f.input, productRevision: f.input.productRevision - 1 }), isCode('SOURCE_CHANGED'));
  const other = f.store.createProduct(); await assert.rejects(f.service.recognize({ ...f.input, productId: other.id, productRevision: other.revision }), isCode('SOURCE_CHANGED'));
  await writeFile(join(f.directory, 'assets', `${f.input.assetId}.png`), Buffer.alloc(f.bytes.length));
  await assert.rejects(f.service.recognize(f.input), isCode('SOURCE_CHANGED'));
  await rm(join(f.directory, 'assets', `${f.input.assetId}.png`)); await assert.rejects(f.service.recognize(f.input), isCode('SOURCE_CHANGED'));
  assert.equal(f.requests.length, 0); assert.equal(f.service.listCalls().length, 0);
});

test('a managed assets junction outside the workspace is rejected before sending bytes', async t => {
  const f = await fixture(t); f.enable('aliyun-ocr');
  const outside = await mkdtemp(resolve('.test-data/ai-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, `${f.input.assetId}.png`), f.bytes); await rename(join(f.directory, 'assets'), join(f.directory, 'original-assets')); await symlink(outside, join(f.directory, 'assets'), 'junction');
  await assert.rejects(f.service.recognize(f.input), isCode('SOURCE_CHANGED')); assert.equal(f.requests.length, 0);
});

test('mutating source bytes or product revision while provider runs discards the response and records failed usage', async t => {
  for (const mutation of ['file', 'product']) {
    const hold = gate(), f = await fixture(t, { fetch: hold.fetch }); f.enable('aliyun-ocr');
    const pending = f.service.recognize(f.input); await hold.started;
    if (mutation === 'file') await writeFile(join(f.directory, 'assets', `${f.input.assetId}.png`), Buffer.alloc(f.bytes.length));
    else f.store.saveProduct({ ...saveInput(f.product), title: 'Changed title' });
    hold.release(ocr()); await assert.rejects(pending, isCode('SOURCE_CHANGED'));
    assert.equal(f.service.listResults(f.product.id).length, 0); assert.equal(f.service.listCalls()[0].status, 'FAILED'); assert.equal(f.service.listCalls()[0].usage.processedImages, 1);
  }
});

test('disable, reimport and external cancellation abort requests even when injected transport ignores its signal', async t => {
  for (const action of ['disable', 'reimport', 'cancel']) {
    const hold = gate(), f = await fixture(t, { fetch: hold.fetch }); f.enable('aliyun-ocr');
    const controller = new AbortController(), pending = f.service.recognize(f.input, controller.signal); await hold.started;
    if (action === 'disable') f.service.setEnabled({ id: 'aliyun-ocr', enabled: false });
    else if (action === 'reimport') f.service.importProfile({ id: 'aliyun-ocr', ...aliyun });
    else controller.abort();
    await assert.rejects(pending, isCode(action === 'disable' ? 'DISABLED' : action === 'reimport' ? 'CONFIG_CHANGED' : 'CANCELLED'));
    assert.equal(f.service.listResults(f.product.id).length, 0); assert.equal(f.service.listCalls()[0].status, 'FAILED'); assert.equal(f.service.busy, false);
    hold.release(ocr());
  }
});

test('timeout and bounded concurrency never retry a paid POST', async t => {
  const hold = gate(), f = await fixture(t, { fetch: hold.fetch, timeoutMs: 100, maxConcurrency: 1 }); f.enable('aliyun-ocr'); f.enable('deepseek');
  const pending = f.service.recognize(f.input); await hold.started;
  assert.equal(f.service.busy, true); await assert.rejects(f.service.suggest({ productId: f.product.id, productRevision: f.product.revision, variantId: f.product.variants[0].id, ocrResultIds: [] }), isCode('BUSY')); await assert.rejects(pending, isCode('TIMEOUT'));
  assert.equal(f.requests.length, 1); assert.equal(f.service.listCalls().length, 1); assert.equal(f.service.listCalls()[0].errorCode, 'TIMEOUT'); hold.release(ocr());
});

test('close cancels active calls, closes once, and new calls reject', async t => {
  const hold = gate(), f = await fixture(t, { fetch: hold.fetch }); f.enable('aliyun-ocr');
  const pending = f.service.recognize(f.input); await hold.started;
  const cancelled = assert.rejects(pending, isCode('CANCELLED')); await f.service.close(); await f.service.close(); await cancelled;
  await assert.rejects(f.service.recognize(f.input), isCode('SERVICE_CLOSED')); hold.release(ocr());
  const db = openDatabase(f.directory), row = db.prepare('SELECT record_json FROM ai_calls').get()!; db.close(); assert.equal(JSON.parse(String(row.record_json)).errorCode, 'CANCELLED');
});

test('restart converts RUNNING calls to FAILED INTERRUPTED and never replays them', async t => {
  const f = await fixture(t); f.enable('aliyun-ocr'); const result = await f.service.recognize(f.input), call = f.service.listCalls()[0]; await f.service.close();
  const db = openDatabase(f.directory); db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({ ...call, status: 'RUNNING', finishedAt: null, errorCode: null }), call.id); db.close();
  const restarted = new AiService(f.directory, f.store, f.hosting, storage, { fetch: async () => { throw Error('must not call'); } });
  assert.equal(restarted.listCalls()[0].status, 'FAILED'); assert.equal(restarted.listCalls()[0].errorCode, 'INTERRUPTED'); assert.ok(restarted.listCalls()[0].finishedAt);
  assert.equal(restarted.listResults(f.product.id)[0].id, result.id); await restarted.close();
});

test('Aidge requires AVAILABLE matching hosted data and a fresh verification before one provider call', async t => {
  const f = await fixture(t); f.enable('aidge-segmentation');
  await assert.rejects(f.service.segment({ ...f.input, hostedAssetId: randomUUID() }), isCode('HOSTED_IMAGE_REQUIRED'));
  const upload = await f.upload(), probes = f.probes(), result = await f.service.segment({ ...f.input, hostedAssetId: upload.id });
  assert.equal(f.probes(), probes + 1); assert.equal(result.output.kind, 'segmentation');
  if (result.output.kind === 'segmentation') { assert.equal(result.output.materialized, false); assert.equal(result.output.score, 5.95); }
  assert.equal(f.requests.length, 1); assert.equal(f.store.getProduct(f.product.id).assets.length, 1);
  f.hosting.setEnabled({ id: 'alpha', enabled: false }); await assert.rejects(f.service.segment({ ...f.input, hostedAssetId: upload.id }), isCode('HOSTED_IMAGE_REQUIRED'));
  assert.equal(f.requests.length, 1);
});

test('hosting generation changes after Aidge begins cannot promote the temporary artifact', async t => {
  const hold = gate(), f = await fixture(t, { fetch: hold.fetch }); f.enable('aidge-segmentation'); const upload = await f.upload();
  const pending = f.service.segment({ ...f.input, hostedAssetId: upload.id }); await hold.started;
  f.hosting.setEnabled({ id: 'alpha', enabled: false });
  hold.release(json({ Success: true, Code: 'success', Data: { Width: 256, Height: 256, ImageUrl: 'https://output.oss-cn-beijing.aliyuncs.com/a.png', UsageMap: { ProcessedImageCount: 1 } } }));
  await assert.rejects(pending, isCode('HOSTED_IMAGE_REQUIRED')); assert.equal(f.service.listResults(f.product.id).length, 0);
});

test('DeepSeek sends only selected specs, confirmed facts and relevant unverified OCR, without modifying product data', async t => {
  const f = await fixture(t); f.enable('aliyun-ocr'); f.enable('deepseek'); const recognized = await f.service.recognize(f.input);
  const input = { productId: f.product.id, productRevision: f.product.revision, variantId: f.product.variants[0].id, ocrResultIds: [recognized.id] };
  const result = await f.service.suggest(input), sent = String(f.requests[1].options?.body);
  for (const forbidden of ['12345678.9876', '87654321', 'purchasePrice', 'inventory', 'UNCONFIRMED_SENTINEL', 'private-source-ref', f.product.variants[0].sku]) assert.equal(sent.includes(forbidden), false, forbidden);
  assert.ok(sent.includes('Source cotton cloth')); assert.ok(sent.includes('Blue / M')); assert.ok(sent.includes('unverifiedOcr'));
  assert.equal(result.reviewState, 'unreviewed'); assert.deepEqual(result.sourceResultIds, [recognized.id]); assert.equal(f.service.listCalls()[1].usage.promptTokens, 25);
  assert.deepEqual(f.store.getProduct(f.product.id), f.product);
});

test('DeepSeek omits Chinese purchase-price facts while retaining and referencing normal capacity and costume facts', async t => {
  const f = await fixture(t, { fetch: async (_url, options) => {
    const body = JSON.parse(String(options?.body)), payload = JSON.parse(body.messages[1].content), facts = payload.confirmedFacts;
    return json({ id: 'chat-normal-facts', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'Cup costume', bullets: ['Source details'], description: 'Source details.', attributes: facts.filter((fact: { name: string }) => ['Cup capacity', 'Costume type'].includes(fact.name)).map((fact: { id: string; name: string; value: string }) => ({ name: fact.name, value: fact.value, factIds: [fact.id] })) }) } }], usage: { prompt_tokens: 10, completion_tokens: 12 } });
  } });
  const facts = [
    { id: randomUUID(), name: '进货价', value: 'PRIVATE_PURCHASE_PRICE_SENTINEL', source: 'manual' as const, sourceRef: '', state: 'human_confirmed' as const },
    { id: randomUUID(), name: 'Cup capacity', value: '500 ml', source: 'manual' as const, sourceRef: '', state: 'human_confirmed' as const },
    { id: randomUUID(), name: 'Costume type', value: 'Stage costume', source: 'manual' as const, sourceRef: '', state: 'human_confirmed' as const },
  ];
  const product = f.store.saveProduct({ ...saveInput(f.product), facts }); f.enable('deepseek');
  const result = await f.service.suggest({ productId: product.id, productRevision: product.revision, variantId: product.variants[0].id, ocrResultIds: [] });
  const sent = String(f.requests[0].options?.body); assert.equal(sent.includes('进货价'), false); assert.equal(sent.includes('PRIVATE_PURCHASE_PRICE_SENTINEL'), false);
  assert.ok(sent.includes('Cup capacity')); assert.ok(sent.includes('Costume type')); assert.equal(result.output.kind, 'text');
  if (result.output.kind === 'text') assert.deepEqual(result.output.attributes, facts.slice(1).map(fact => ({ name: fact.name, value: fact.value, factIds: [fact.id] })));
});

test('OCR references from stale revisions or unconfirmed SKU image bindings never reach DeepSeek', async t => {
  const f = await fixture(t); f.enable('aliyun-ocr'); f.enable('deepseek'); const recognized = await f.service.recognize(f.input);
  const input = { productId: f.product.id, productRevision: f.product.revision, variantId: f.product.variants[0].id, ocrResultIds: [recognized.id] };
  const db = openDatabase(f.directory); db.prepare('UPDATE variant_assets SET confirmed=0 WHERE asset_id=?').run(f.input.assetId); db.close();
  await assert.rejects(f.service.suggest(input), isCode('SOURCE_CHANGED')); assert.equal(f.requests.length, 1);
  const changed = f.store.saveProduct({ ...saveInput(f.product), title: 'Changed' });
  await assert.rejects(f.service.suggest({ ...input, productRevision: changed.revision }), isCode('SOURCE_CHANGED')); assert.equal(f.requests.length, 1);
});

test('provider secrets echoed in JSON output cannot enter public records', async t => {
  const f = await fixture(t, { fetch: async () => ocr(aliyun.accessKeySecret) }); f.enable('aliyun-ocr');
  await assert.rejects(f.service.recognize(f.input), isCode('OUTPUT_INVALID'));
  assert.equal(JSON.stringify(f.service.listCalls()).includes(aliyun.accessKeySecret), false); assert.equal(f.service.listResults(f.product.id).length, 0);
});

test('result and successful call commit atomically when a database result insert fails', async t => {
  const f = await fixture(t); f.enable('aliyun-ocr');
  const db = openDatabase(f.directory); db.exec("CREATE TRIGGER ai_result_failure BEFORE INSERT ON ai_results BEGIN SELECT RAISE(ABORT,'fixture-access-key-secret'); END;");
  await assert.rejects(f.service.recognize(f.input), e => e instanceof AiError && !e.message.includes(aliyun.accessKeySecret));
  assert.equal(f.service.listResults(f.product.id).length, 0); assert.equal(f.service.listCalls()[0].status, 'FAILED'); db.close();
});
