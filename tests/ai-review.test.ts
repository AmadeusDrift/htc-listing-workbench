import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AiService } from '../src/main/ai/service.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { openDatabase } from '../src/main/database.ts';
import { importImageFiles } from '../src/main/assets.ts';
import { validateAiResult } from '../src/main/ai/validation.ts';
import type { AiResult, ContentSuggestionOutput } from '../src/shared/ai-contracts.ts';
import type { ProductDetail, SaveProductInput } from '../src/shared/contracts.ts';
import type { SecretStorage } from '../src/main/amazon/vault.ts';

const generationConfig = { id: 'deepseek', model: 'deepseek-flash', apiKey: 'fixture-generation-secret' };
const reviewConfig = { id: 'deepseek-review', model: 'deepseek-v4-pro', apiKey: 'fixture-review-secret' };
const key = randomBytes(32);
const storage: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
  decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
};
function saveInput(p: ProductDetail): SaveProductInput { return { id: p.id, revision: p.revision, title: p.title, sourceUrl: p.sourceUrl, description: p.description, status: p.status, variants: p.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })), facts: p.facts }; }
const isCode = (code: string) => (e: unknown) => e instanceof AiError && e.code === code;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const chat = (content: unknown, finish = 'stop') => json({ id: 'review-fixture', choices: [{ finish_reason: finish, message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 51, completion_tokens: 31, total_tokens: 82 } });
function copy(fact: { id: string; name: string; value: string }): ContentSuggestionOutput { return { kind: 'text', title: 'Cotton cloth', bullets: ['Cotton material', 'Blue cloth'], description: 'Cotton cloth in blue.', attributes: [{ name: fact.name, value: fact.value, factIds: [fact.id] }] }; }
function report(payload: any) {
  return {
    suggestionId: payload.suggestionId, suggestionSha256: payload.suggestionSha256, policyVersion: 'content-review/v1', verdict: 'PASS',
    checks: ['title', ...payload.candidate.bullets.map((_: unknown, i: number) => `bullets.${i}`), 'description', ...payload.candidate.attributes.map((_: unknown, i: number) => `attributes.${i}`)].map(field => ({ field, verdict: 'SUPPORTED', evidenceIds: [field === 'bullets.1' ? payload.variant.id : payload.confirmedFacts[0].id], reason: 'Supported by the selected confirmed evidence.' })),
    issues: [],
  };
}
async function fixture(t: test.TestContext, images = false) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/ai-review-')), store = new WorkspaceStore(directory);
  let product = store.createProduct();
  product = store.saveProduct({ ...saveInput(product), title: 'UNVERIFIED TITLE INSTRUCTIONS', variants: [{ ...saveInput(product).variants[0], originalSpec: 'Blue', normalizedSpec: 'Blue' }], facts: [{ id: randomUUID(), name: 'Material', value: 'Cotton', source: 'manual', sourceRef: '', state: 'human_confirmed' }, { id: randomUUID(), name: 'Brand', value: 'PROTECTED_SENTINEL', source: 'manual', sourceRef: '', state: 'human_confirmed' }, { id: randomUUID(), name: 'Unconfirmed', value: 'UNCONFIRMED_SENTINEL', source: 'ai', sourceRef: '', state: 'ai_suggested' }] });
  if (images) {
    const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(256, 16); bytes.writeUInt32BE(256, 20);
    const source = join(directory, 'input.png'); await writeFile(source, bytes);
    product = await importImageFiles(store, directory, { productId: product.id, revision: product.revision }, [source], b => b);
    product = store.updateAsset({ productId: product.id, revision: product.revision, assetId: product.assets[0].id, role: 'main', variantIds: [product.variants[0].id] });
  }
  const hosting = new HostingService(directory, store, storage);
  const requests: { url: string; options?: RequestInit; body: any }[] = [];
  let respond: (payload: any) => Promise<Response> | Response = payload => chat(report(payload));
  const service = new AiService(directory, store, hosting, storage, { fetch: async (url, options) => {
    if (String(url).includes('ocr-api.')) return json({ RequestId: 'ocr-fixture', Data: { Width: 256, Height: 256, Content: 'UNTRUSTED OCR', SubImageCount: 1, SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: 'UNTRUSTED OCR', BlockConfidence: 98 }] } }] } });
    const body = JSON.parse(String(options?.body)); requests.push({ url: String(url), options, body });
    const payload = JSON.parse(body.messages[1].content);
    if (new Headers(options?.headers).get('authorization') === `Bearer ${generationConfig.apiKey}`) { const { kind, ...output } = copy(payload.confirmedFacts[0]); return chat(output); }
    return respond(payload);
  } });
  t.after(async () => { await service.close(); await hosting.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const enableReview = () => { service.importProfile(reviewConfig); return service.setEnabled({ id: reviewConfig.id, enabled: true }); };
  const generate = async () => {
    service.importProfile(generationConfig); service.setEnabled({ id: generationConfig.id, enabled: true });
    const ids: string[] = [];
    if (images) { service.importProfile({ id: 'aliyun-ocr', accessKeyId: 'fixture-ocr-key-id', accessKeySecret: 'fixture-ocr-secret' }); service.setEnabled({ id: 'aliyun-ocr', enabled: true }); ids.push((await service.recognize({ productId: product.id, productRevision: product.revision, assetId: product.assets[0].id })).id); }
    return service.suggest({ productId: product.id, productRevision: product.revision, variantId: product.variants[0].id, ocrResultIds: ids });
  };
  const input = (suggestion: AiResult) => ({ productId: product.id, productRevision: product.revision, suggestionResultId: suggestion.id });
  return { directory, store, hosting, service, product, requests, enableReview, generate, input, respond: (value: typeof respond) => { respond = value; } };
}

test('review configuration is separate, disabled by default, encrypted and never populated from generation credentials', async t => {
  const f = await fixture(t), suggestion = await f.generate();
  assert.deepEqual(f.service.template('deepseek-review'), { id: 'deepseek-review', model: 'deepseek-v4-pro', apiKey: '' });
  assert.equal(f.service.getProfile('deepseek-review').configured, false);
  await assert.rejects(f.service.review(f.input(suggestion)), isCode('NOT_CONFIGURED'));
  f.service.importProfile(reviewConfig);
  await assert.rejects(f.service.review(f.input(suggestion)), isCode('DISABLED'));
  const ciphertext = await readFile(join(f.directory, 'ai-vault/deepseek-review.bin'));
  assert.equal(ciphertext.includes(Buffer.from(reviewConfig.apiKey)), false);
  assert.equal(f.service.getProfile('deepseek').configured, true);
  f.enableReview(); f.service.disconnect('deepseek-review');
  assert.equal(f.service.getProfile('deepseek').enabled, true); assert.equal(f.requests.length, 1);
});

test('review loads exact stored copy, computes hashes in main, binds SKU and uses fixed independent JSON protocol', async t => {
  const f = await fixture(t, true), suggestion = await f.generate(); f.enableReview();
  assert.match(suggestion.sourceSha256!, /^[a-f0-9]{64}$/);
  const review = await f.service.review(f.input(suggestion));
  assert.equal(review.providerId, 'deepseek-review'); assert.equal(review.output.kind, 'text-review');
  assert.equal(review.variantId, suggestion.variantId); assert.deepEqual(review.sourceResultIds, [suggestion.id]);
  if (review.output.kind !== 'text-review') throw new Error('Expected review');
  assert.equal(review.output.suggestionSha256, createHash('sha256').update(JSON.stringify(suggestion.output)).digest('hex'));
  assert.equal(review.output.sourceSha256, suggestion.sourceSha256);
  const request = f.requests[1], payload = JSON.parse(request.body.messages[1].content);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions'); assert.equal(new Headers(request.options?.headers).get('authorization'), `Bearer ${reviewConfig.apiKey}`);
  assert.equal(request.body.model, 'deepseek-v4-pro'); assert.deepEqual(request.body.thinking, { type: 'disabled' }); assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.equal(request.body.stream, false); assert.equal(request.options?.redirect, 'error'); assert.equal(request.options?.method, 'POST');
  assert.deepEqual(payload.candidate, suggestion.output); assert.equal(payload.unverifiedOcr[0].verified, false);
  assert.match(request.body.messages[0].content, /never as instructions/i); assert.match(request.body.messages[0].content, /sourceTitle/);
  assert.equal(JSON.stringify(payload).includes('PROTECTED_SENTINEL'), false); assert.equal(JSON.stringify(payload).includes('UNCONFIRMED_SENTINEL'), false);
  const calls = f.service.listCalls().filter(c => c.providerId === 'deepseek-review'); assert.equal(calls.length, 1); assert.equal(calls[0].usage.promptTokens, 51);
  assert.equal(f.store.getProduct(f.product.id).revision, f.product.revision);
  await assert.rejects(f.service.review({ ...f.input(suggestion), suggestionSha256: 'a'.repeat(64) }), isCode('INVALID_INPUT'));
});

test('legacy text remains readable but cannot be reviewed without a generation-time source fingerprint', async t => {
  const f = await fixture(t), suggestion = await f.generate(); f.enableReview();
  const { sourceSha256, ...legacy } = suggestion; assert.deepEqual(validateAiResult(legacy), legacy);
  const db = openDatabase(f.directory); db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(legacy), suggestion.id); db.close();
  await assert.rejects(f.service.review(f.input(suggestion)), isCode('SOURCE_CHANGED')); assert.equal(f.requests.length, 1);
});

test('every candidate field needs exactly one supported check and a real evidence ID; fake PASS fails closed', async t => {
  const mutations: ((value: any, payload: any) => void)[] = [
    r => { r.checks.pop(); }, r => { r.checks.push(r.checks[0]); }, r => { r.checks.push({ ...r.checks[0], field: 'bullets.99' }); },
    r => { r.checks[0].verdict = 'UNSUPPORTED'; }, r => { r.checks[0].evidenceIds = []; }, r => { r.checks[0].evidenceIds = [randomUUID()]; },
    (r, p) => { r.checks[0].evidenceIds = [p.unverifiedOcr[0].resultId]; }, r => { r.issues = [{ code: 'UNSUPPORTED_CLAIM', field: 'title', message: 'Not verified.' }]; },
    r => { r.suggestionId = randomUUID(); }, r => { r.suggestionSha256 = 'a'.repeat(64); }, r => { r.policyVersion = 'anything/v0'; },
    r => { r.checks[0].reason = ''; }, r => { r.checks[0].field = 'brand'; }, r => { r.secret = 'unexpected'; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t, true), suggestion = await f.generate(); f.enableReview();
    f.respond(p => { const r = report(p); mutate(r, p); return chat(r); });
    await assert.rejects(f.service.review(f.input(suggestion)), isCode('OUTPUT_INVALID'));
    assert.equal(f.service.listResults(f.product.id).filter(r => r.providerId === 'deepseek-review').length, 0);
    assert.equal(f.service.listCalls().at(-1)?.status, 'FAILED'); assert.equal(f.requests.length, 2);
  }
});

test('NEEDS_CHANGES and BLOCKED retain field problems without changing facts or drafts', async t => {
  for (const verdict of ['NEEDS_CHANGES', 'BLOCKED']) {
    const f = await fixture(t), suggestion = await f.generate(); f.enableReview(); const before = f.store.getProduct(f.product.id);
    f.respond(p => { const r = report(p); r.verdict = verdict; r.checks[0] = { field: 'title', verdict: 'UNSUPPORTED', evidenceIds: [], reason: 'Unsupported claim in title.' }; return chat({ ...r, issues: [{ code: 'UNSUPPORTED_CLAIM', field: 'title', message: 'Use confirmed facts only.' }] }); });
    const review = await f.service.review(f.input(suggestion)); assert.equal(review.output.kind, 'text-review');
    if (review.output.kind === 'text-review') { assert.equal(review.output.verdict, verdict); assert.equal(review.output.issues[0].code, 'UNSUPPORTED_CLAIM'); }
    assert.deepEqual(f.store.getProduct(f.product.id), before);
    const db = openDatabase(f.directory); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_drafts').get()!.n, 0); db.close();
  }
});

test('review rejects truncated JSON, malformed reports and echoed reviewer secrets with one request and safe usage', async t => {
  const replies = [(p: any) => chat(report(p), 'length'), () => chat('{'), (p: any) => chat({ ...report(p), checks: report(p).checks.map(c => ({ ...c, reason: reviewConfig.apiKey })) }), () => json({ error: { message: reviewConfig.apiKey } }, 500)];
  for (const reply of replies) {
    const f = await fixture(t), suggestion = await f.generate(); f.enableReview(); f.respond(reply);
    await assert.rejects(f.service.review(f.input(suggestion)), e => e instanceof AiError && ['OUTPUT_INVALID', 'PROVIDER_ERROR'].includes(e.code) && !e.message.includes(reviewConfig.apiKey));
    assert.equal(f.requests.length, 2); assert.equal(JSON.stringify(f.service.listCalls()).includes(reviewConfig.apiKey), false); assert.equal(f.service.listResults(f.product.id).length, 1);
  }
});

test('review source facts, candidate copy, OCR hash and confirmed SKU binding are rechecked before a paid call', async t => {
  for (const mutation of ['facts', 'candidate', 'ocr', 'binding', 'revision']) {
    const f = await fixture(t, true), suggestion = await f.generate(); f.enableReview(); const db = openDatabase(f.directory);
    if (mutation === 'facts') db.prepare('UPDATE facts SET value=? WHERE id=?').run('Silk', f.product.facts[0].id);
    if (mutation === 'candidate') db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({ ...suggestion, sourceSha256: undefined }), suggestion.id);
    if (mutation === 'ocr') await writeFile(join(f.directory, 'assets', `${f.product.assets[0].id}.png`), Buffer.alloc(33));
    if (mutation === 'binding') db.prepare('UPDATE variant_assets SET confirmed=0 WHERE asset_id=?').run(f.product.assets[0].id);
    if (mutation === 'revision') f.store.saveProduct({ ...saveInput(f.product), title: 'Changed' });
    db.close(); await assert.rejects(f.service.review(f.input(suggestion)), isCode('SOURCE_CHANGED')); assert.equal(f.requests.length, 1);
  }
});

test('review refuses missing, cross-product and non-text result references before a paid call', async t => {
  const f = await fixture(t, true), suggestion = await f.generate(); f.enableReview();
  const other = f.store.createProduct();
  for (const input of [{ ...f.input(suggestion), suggestionResultId: randomUUID() }, { productId: other.id, productRevision: other.revision, suggestionResultId: suggestion.id }, { ...f.input(suggestion), suggestionResultId: suggestion.sourceResultIds[0] }]) await assert.rejects(f.service.review(input), isCode('SOURCE_CHANGED'));
  assert.equal(f.requests.length, 1);
});

test('source changes, reviewer rotation, disabling and cancellation discard late responses without retries', async t => {
  for (const action of ['candidate', 'facts', 'ocr', 'binding', 'revision', 'rotate', 'disable', 'cancel', 'close']) {
    const f = await fixture(t, true), suggestion = await f.generate(); f.enableReview();
    let release!: (response: Response) => void, entered!: () => void, requestPayload: any;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.respond(p => { requestPayload = p; entered(); return new Promise(resolve => { release = resolve; }); });
    const controller = new AbortController(), pending = f.service.review(f.input(suggestion), controller.signal); await started;
    const db = openDatabase(f.directory);
    if (action === 'candidate') db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({ ...suggestion, output: { ...suggestion.output, title: 'Modified candidate' } }), suggestion.id);
    if (action === 'facts') db.prepare('UPDATE facts SET value=? WHERE id=?').run('Silk', f.product.facts[0].id);
    if (action === 'ocr') await writeFile(join(f.directory, 'assets', `${f.product.assets[0].id}.png`), Buffer.alloc(33));
    if (action === 'binding') db.prepare('UPDATE variant_assets SET confirmed=0 WHERE asset_id=?').run(f.product.assets[0].id);
    if (action === 'revision') f.store.saveProduct({ ...saveInput(f.product), title: 'Changed' });
    db.close();
    if (action === 'rotate') f.service.importProfile({ ...reviewConfig, apiKey: 'replacement-review-key' });
    if (action === 'disable') f.service.setEnabled({ id: 'deepseek-review', enabled: false });
    if (action === 'cancel') controller.abort();
    const closing = action === 'close' ? f.service.close() : undefined;
    release(chat(report(requestPayload)));
    await assert.rejects(pending, isCode(action === 'rotate' ? 'CONFIG_CHANGED' : action === 'disable' ? 'DISABLED' : action === 'cancel' || action === 'close' ? 'CANCELLED' : 'SOURCE_CHANGED')); await closing;
    assert.equal(f.requests.length, 2);
    const verify = openDatabase(f.directory); const rows = verify.prepare('SELECT record_json FROM ai_results').all(); assert.equal(rows.filter(row => JSON.parse(String(row.record_json)).providerId === 'deepseek-review').length, 0); verify.close();
  }
});

test('selected variant UUID is evidence only for nonempty specifications', async t => {
  const f = await fixture(t); const changed = f.store.saveProduct({ ...saveInput(f.product), variants: saveInput(f.product).variants.map(v => ({ ...v, originalSpec: '', normalizedSpec: '' })) });
  f.service.importProfile(generationConfig); f.service.setEnabled({ id: generationConfig.id, enabled: true });
  const suggestion = await f.service.suggest({ productId: changed.id, productRevision: changed.revision, variantId: changed.variants[0].id, ocrResultIds: [] }); f.enableReview();
  await assert.rejects(f.service.review({ productId: changed.id, productRevision: changed.revision, suggestionResultId: suggestion.id }), isCode('OUTPUT_INVALID'));
});

test('a review report cannot promote source title, protected or missing facts into evidence', async t => {
  for (const factIndex of [1, 2]) {
    const f = await fixture(t), suggestion = await f.generate(); f.enableReview();
    f.respond(p => { const r = report(p); r.checks[0].evidenceIds = [f.product.facts[factIndex].id]; return chat(r); });
    await assert.rejects(f.service.review(f.input(suggestion)), isCode('OUTPUT_INVALID'));
    assert.equal(f.requests.length, 2); assert.equal(f.service.listResults(f.product.id).length, 1);
  }
});

test('persisted review records enforce provider, source-result and output discriminants and never masquerade as approved facts', async t => {
  const f = await fixture(t), suggestion = await f.generate(); f.enableReview(); const review = await f.service.review(f.input(suggestion));
  assert.deepEqual(validateAiResult(review), review);
  for (const bad of [{ ...review, providerId: 'deepseek' }, { ...review, variantId: null }, { ...review, assetId: randomUUID() }, { ...review, sourceResultIds: [] }, { ...review, sourceResultIds: [randomUUID()] }, { ...review, sourceResultIds: [suggestion.id, randomUUID()] }, { ...review, sourceSha256: 'a'.repeat(64) }, { ...review, reviewState: 'approved' }, { ...review, output: suggestion.output }]) assert.throws(() => validateAiResult(bad));
});

test('restart marks an interrupted review call failed without replaying a paid request', async t => {
  const f = await fixture(t), suggestion = await f.generate(); f.enableReview(); await f.service.close();
  const at = new Date().toISOString(), id = randomUUID(), db = openDatabase(f.directory);
  db.prepare('INSERT INTO ai_calls(id,record_json) VALUES(?,?)').run(id, JSON.stringify({ id, providerId: 'deepseek-review', productId: f.product.id, productRevision: f.product.revision, status: 'RUNNING', errorCode: null, requestId: null, model: 'deepseek-v4-pro', generation: 1, startedAt: at, finishedAt: null, usage: { promptTokens: 0, completionTokens: 0, processedImages: 0 } })); db.close();
  let calls = 0; const restarted = new AiService(f.directory, f.store, f.hosting, storage, { fetch: async () => { calls++; throw new Error('Network must not run during recovery'); } });
  const recovered = restarted.listCalls().find(row => row.id === id)!; assert.equal(recovered.status, 'FAILED'); assert.equal(recovered.errorCode, 'INTERRUPTED'); assert.equal(calls, 0); assert.deepEqual(restarted.listResults(f.product.id), [suggestion]);
  await restarted.close();
});
