import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { AiService } from '../src/main/ai/service.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { importImageFiles } from '../src/main/assets.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import type { AiResult } from '../src/shared/ai-contracts.ts';
import type { ProductDetail, SaveProductInput } from '../src/shared/contracts.ts';

const storage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() };
function input(p: ProductDetail): SaveProductInput { return { id: p.id, revision: p.revision, title: p.title, sourceUrl: p.sourceUrl, description: p.description, status: p.status, variants: p.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })), facts: p.facts }; }
async function implementation() { assert.equal(existsSync(resolve('src/main/content/service.ts')), true, 'ReviewedContentService must exist'); return import('../src/main/content/service.ts'); }
const isCode = (code: string) => (e: unknown) => e instanceof AiError && e.code === code;
async function fixture(t: test.TestContext, images = false) {
  const { ReviewedContentService } = await implementation();
  await mkdir(resolve('.test-data'), { recursive: true }); const directory = await mkdtemp(resolve('.test-data/content-')), store = new WorkspaceStore(directory);
  let product = store.createProduct(); product = store.saveProduct({ ...input(product), title: 'Cloth source', variants: [{ ...input(product).variants[0], originalSpec: 'Blue', normalizedSpec: 'Blue' }], facts: [{ id: randomUUID(), name: 'Material', value: 'Cotton', source: 'manual', sourceRef: '', state: 'human_confirmed' }] });
  if (images) {
    const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(256, 16); bytes.writeUInt32BE(256, 20);
    const source = join(directory, 'source.png'); await writeFile(source, bytes);
    product = await importImageFiles(store, directory, { productId: product.id, revision: product.revision }, [source], b => b);
    product = store.updateAsset({ productId: product.id, revision: product.revision, assetId: product.assets[0].id, role: 'main', variantIds: [product.variants[0].id] });
  }
  const hosting = new HostingService(directory, store, storage); let requests = 0, verdict = 'PASS';
  const ai = new AiService(directory, store, hosting, storage, { fetch: async (url, options) => {
    requests++;
    if (String(url).includes('ocr-api.')) return new Response(JSON.stringify({ RequestId: 'ocr-fixture', Data: { Width: 256, Height: 256, Content: 'Cotton', SubImageCount: 1, SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: 'Cotton', BlockConfidence: 99 }] } }] } }));
    const payload = JSON.parse(JSON.parse(String(options?.body)).messages[1].content), fact = payload.confirmedFacts[0];
    const content = payload.candidate ? { suggestionId: payload.suggestionId, suggestionSha256: payload.suggestionSha256, policyVersion: payload.policyVersion, verdict, checks: ['title', 'bullets.0', 'description', 'attributes.0'].map(field => ({ field, verdict: verdict === 'PASS' ? 'SUPPORTED' : 'UNSUPPORTED', evidenceIds: verdict === 'PASS' ? [fact.id] : [], reason: verdict === 'PASS' ? 'Confirmed material.' : 'Missing support.' })), issues: verdict === 'PASS' ? [] : [{ code: 'UNSUPPORTED_CLAIM', field: 'title', message: 'Revise the claim.' }] } : { title: 'Cotton cloth', bullets: ['Cotton material'], description: 'A cotton cloth.', attributes: [{ name: fact.name, value: fact.value, factIds: [fact.id] }] };
    return new Response(JSON.stringify({ id: 'chat-fixture', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 21, completion_tokens: 11 } }));
  } });
  for (const id of ['deepseek', 'deepseek-review']) { ai.importProfile({ id, model: id === 'deepseek' ? 'deepseek-flash' : 'deepseek-v4-pro', apiKey: `fixture-${id}-credential` }); ai.setEnabled({ id, enabled: true }); }
  const ocrIds: string[] = [];
  if (images) { ai.importProfile({ id: 'aliyun-ocr', accessKeyId: 'fixture-key-id', accessKeySecret: 'fixture-key-secret' }); ai.setEnabled({ id: 'aliyun-ocr', enabled: true }); ocrIds.push((await ai.recognize({ productId: product.id, productRevision: product.revision, assetId: product.assets[0].id })).id); }
  const suggestion = await ai.suggest({ productId: product.id, productRevision: product.revision, variantId: product.variants[0].id, ocrResultIds: ocrIds });
  const review = () => ai.review({ productId: product.id, productRevision: product.revision, suggestionResultId: suggestion.id });
  const content = new ReviewedContentService(directory, store, ai);
  t.after(async () => { content.close(); await ai.close(); await hosting.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const adoptInput = (r: AiResult) => ({ productId: product.id, productRevision: product.revision, reviewResultId: r.id });
  return { directory, store, ai, content, product, suggestion, review, adoptInput, requests: () => requests, verdict: (v: string) => { verdict = v; } };
}

test('adoption copies only the exact current PASS-reviewed candidate into an immutable model-approved local version', async t => {
  const f = await fixture(t), before = f.store.getProduct(f.product.id), review = await f.review(), requests = f.requests();
  f.ai.setEnabled({ id: 'deepseek-review', enabled: false }); f.ai.setEnabled({ id: 'deepseek', enabled: false });
  const version = await f.content.adopt(f.adoptInput(review));
  assert.equal(version.status, 'model-approved'); assert.equal(version.productId, f.product.id); assert.equal(version.sourceRevision, f.product.revision); assert.equal(version.variantId, f.suggestion.variantId);
  assert.equal(version.generationResultId, f.suggestion.id); assert.equal(version.reviewResultId, review.id); assert.equal(version.generationModel, f.suggestion.model); assert.equal(version.reviewModel, review.model); assert.equal(version.policyVersion, 'content-review/v1');
  assert.equal(version.sourceSha256, f.suggestion.sourceSha256); assert.deepEqual(version.output, f.suggestion.output); assert.match(version.suggestionSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.content.list(f.product.id), [version]); assert.deepEqual(f.content.list(f.store.createProduct().id), []); assert.deepEqual(f.store.getProduct(f.product.id), before); assert.equal(f.requests(), requests);
  const db = openDatabase(f.directory); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_drafts').get()!.n, 0); db.close();
});

test('repeated and concurrent adoption is idempotent for a report and distinct reports preserve previous versions', async t => {
  const f = await fixture(t), review = await f.review();
  const [first, repeated] = await Promise.all([f.content.adopt(f.adoptInput(review)), f.content.adopt(f.adoptInput(review))]);
  assert.deepEqual(repeated, first); assert.equal(f.content.list(f.product.id).length, 1);
  first.output.title = 'Renderer-side mutation'; assert.equal(f.content.list(f.product.id)[0].output.title, f.suggestion.output.kind === 'text' ? f.suggestion.output.title : '');
  const another = await f.content.adopt(f.adoptInput(await f.review())); assert.notEqual(another.id, repeated.id); assert.equal(f.content.list(f.product.id).length, 2);
});

test('unreviewed, NEEDS_CHANGES, BLOCKED and caller-supplied copy cannot be adopted', async t => {
  const f = await fixture(t);
  await assert.rejects(f.content.adopt(f.adoptInput(f.suggestion)), isCode('OUTPUT_INVALID'));
  for (const verdict of ['NEEDS_CHANGES', 'BLOCKED']) { f.verdict(verdict); const review = await f.review(); await assert.rejects(f.content.adopt(f.adoptInput(review)), isCode('OUTPUT_INVALID')); }
  f.verdict('PASS'); const review = await f.review();
  await assert.rejects(f.content.adopt({ ...f.adoptInput(review), output: f.suggestion.output }), isCode('INVALID_INPUT'));
  await assert.rejects(f.content.adopt({ ...f.adoptInput(review), reviewResultId: randomUUID() }), isCode('OUTPUT_INVALID'));
  assert.equal(f.content.list(f.product.id).length, 0);
});

test('stale product, facts, candidate, review, OCR bytes and unconfirmed binding all block adoption including repeated adoption', async t => {
  for (const mutation of ['revision', 'facts', 'candidate', 'report-hash', 'report-evidence', 'report-model', 'ocr', 'binding']) {
    const f = await fixture(t, true), review = await f.review(); await f.content.adopt(f.adoptInput(review));
    const db = openDatabase(f.directory);
    if (mutation === 'revision') f.store.saveProduct({ ...input(f.product), title: 'Changed source' });
    if (mutation === 'facts') db.prepare('UPDATE facts SET value=? WHERE id=?').run('Silk', f.product.facts[0].id);
    if (mutation === 'candidate') db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({ ...f.suggestion, output: { ...f.suggestion.output, title: 'Changed candidate' } }), f.suggestion.id);
    if (mutation === 'report-hash') db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({ ...review, output: { ...review.output, suggestionSha256: 'a'.repeat(64) } }), review.id);
    if (mutation === 'report-evidence' && review.output.kind === 'text-review') db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({ ...review, output: { ...review.output, checks: review.output.checks.map(c => ({ ...c, evidenceIds: [randomUUID()] })) } }), review.id);
    if (mutation === 'report-model') db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({ ...review, model: 'deepseek-flash' }), review.id);
    if (mutation === 'ocr') await writeFile(join(f.directory, 'assets', `${f.product.assets[0].id}.png`), Buffer.alloc(33));
    if (mutation === 'binding') db.prepare('UPDATE variant_assets SET confirmed=0 WHERE asset_id=?').run(f.product.assets[0].id);
    db.close(); await assert.rejects(f.content.adopt(f.adoptInput(review)), e => e instanceof AiError && ['SOURCE_CHANGED', 'OUTPUT_INVALID'].includes(e.code)); assert.equal(f.content.list(f.product.id).length, 1);
  }
});

test('cross-product, wrong revision and wrong SKU reports cannot be adopted', async t => {
  const f = await fixture(t), review = await f.review(), other = f.store.createProduct();
  await assert.rejects(f.content.adopt({ productId: other.id, productRevision: other.revision, reviewResultId: review.id }));
  await assert.rejects(f.content.adopt({ ...f.adoptInput(review), productRevision: f.product.revision + 1 }));
  const db = openDatabase(f.directory); db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({ ...review, variantId: other.variants[0].id }), review.id); db.close();
  await assert.rejects(f.content.adopt(f.adoptInput(review)), isCode('SOURCE_CHANGED')); assert.equal(f.content.list(f.product.id).length, 0);
});

test('content version validator enforces exact copy fingerprint, model lineage, policy and public fields for backup', async t => {
  const f = await fixture(t), version = await f.content.adopt(f.adoptInput(await f.review()));
  const { validateContentVersion } = await import('../src/main/content/validation.ts');
  assert.deepEqual(validateContentVersion(version), version);
  for (const bad of [{ ...version, status: 'human-confirmed' }, { ...version, sourceRevision: 0 }, { ...version, apiKey: 'secret' }, { ...version, generationModel: 'deepseek-chat' }, { ...version, policyVersion: 'future/v2' }, { ...version, suggestionSha256: '0'.repeat(64) }, { ...version, sourceSha256: '' }, { ...version, output: { ...version.output, title: 'Injected replacement' } }, { ...version, reviewResultId: 'not-an-id' }]) assert.throws(() => validateContentVersion(bad));
});

test('adoption insert failure rolls back without exposing database error details', async t => {
  const f = await fixture(t), review = await f.review(), db = openDatabase(f.directory);
  db.exec("CREATE TRIGGER content_failure BEFORE INSERT ON content_versions BEGIN SELECT RAISE(ABORT,'sensitive-fixture-detail'); END;");
  await assert.rejects(f.content.adopt(f.adoptInput(review)), e => e instanceof AiError && !e.message.includes('sensitive-fixture-detail')); assert.equal(f.content.list(f.product.id).length, 0);
  db.exec('DROP TRIGGER content_failure'); db.close(); assert.equal((await f.content.adopt(f.adoptInput(review))).status, 'model-approved');
});

test('closed content service rejects operations and persisted versions survive reopening without network work', async t => {
  const f = await fixture(t), review = await f.review(), version = await f.content.adopt(f.adoptInput(review)), count = f.requests(); f.content.close();
  assert.throws(() => f.content.list(f.product.id), isCode('SERVICE_CLOSED'));
  await assert.rejects(f.content.adopt(f.adoptInput(review)), isCode('SERVICE_CLOSED'));
  const { ReviewedContentService } = await implementation(); const reopened = new ReviewedContentService(f.directory, f.store, f.ai);
  assert.deepEqual(reopened.list(f.product.id), [version]); assert.deepEqual(await reopened.adopt(f.adoptInput(review)), version); assert.equal(f.requests(), count); reopened.close();
});

test('backup restores reviewed copy and its evidence chain while dropping both model credentials', async t => {
  const f = await fixture(t, true), review = await f.review(), version = await f.content.adopt(f.adoptInput(review));
  const target = join(f.directory, 'restored'), file = join(f.directory, 'content.htcbackup');
  await createWorkspaceBackup(f.directory, file, 'content backup fixture passphrase');
  await commitWorkspaceRestore(target, await prepareWorkspaceRestore(target, file, 'content backup fixture passphrase'));
  const restoredStore = new WorkspaceStore(target), hosting = new HostingService(target, restoredStore, storage);
  const ai = new AiService(target, restoredStore, hosting, storage, { fetch: async () => { throw Error('Restore must stay offline'); } });
  const { ReviewedContentService } = await implementation(), content = new ReviewedContentService(target, restoredStore, ai);
  try {
    assert.deepEqual(content.list(f.product.id), [version]);
    assert.deepEqual(await content.adopt(f.adoptInput(review)), version);
    assert.deepEqual(restoredStore.getProduct(f.product.id), f.product);
    assert.equal(existsSync(join(target, 'ai-vault')), false);
    for (const id of ['deepseek', 'deepseek-review']) {
      const profile = ai.listProfiles().find(p => p.id === id)!;
      assert.equal(profile.enabled, false); assert.equal(profile.configured, false);
    }
  } finally { content.close(); await ai.close(); await hosting.close(); restoredStore.close(); }
});

test('backup rejects an approved copy with orphaned, nonpassing or mismatched historical model records', async t => {
  for (const mutation of ['missing-generation', 'missing-review', 'missing-call', 'non-pass', 'generation-hash', 'review-source', 'variant', 'call-model', 'coverage']) {
    const f = await fixture(t), review = await f.review(); await f.content.adopt(f.adoptInput(review));
    const db = openDatabase(f.directory);
    try {
      const update = (result: AiResult) => db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(result), result.id);
      if (mutation === 'missing-generation') db.prepare('DELETE FROM ai_results WHERE id=?').run(f.suggestion.id);
      if (mutation === 'missing-review') db.prepare('DELETE FROM ai_results WHERE id=?').run(review.id);
      if (mutation === 'missing-call') db.prepare('DELETE FROM ai_calls WHERE id=?').run(review.callId);
      if (mutation === 'generation-hash' && f.suggestion.output.kind === 'text') update({ ...f.suggestion, output: { ...f.suggestion.output, title: 'Different generated title' } });
      if (mutation === 'variant') update({ ...review, variantId: randomUUID() });
      if (mutation === 'call-model') db.prepare("UPDATE ai_calls SET record_json=json_set(record_json,'$.model','deepseek-flash') WHERE id=?").run(review.callId);
      if (review.output.kind === 'text-review') {
        if (mutation === 'non-pass') update({ ...review, output: { ...review.output, verdict: 'NEEDS_CHANGES', issues: [{ code: 'UNSUPPORTED_CLAIM', field: 'title', message: 'Needs revision.' }] } });
        if (mutation === 'review-source') update({ ...review, output: { ...review.output, sourceSha256: 'f'.repeat(64) } });
        if (mutation === 'coverage') update({ ...review, output: { ...review.output, checks: review.output.checks.slice(0, -1) } });
      }
    } finally { db.close(); }
    const file = join(f.directory, 'invalid-content.htcbackup');
    await assert.rejects(createWorkspaceBackup(f.directory, file, 'content backup fixture passphrase'), error => error instanceof Error, mutation);
    assert.equal(existsSync(file), false);
  }
});

test('historical approved versions remain backupable after the product and SKU have changed', async t => {
  const f = await fixture(t), version = await f.content.adopt(f.adoptInput(await f.review()));
  const changed = f.store.saveProduct({ ...input(f.product), title: 'Revised source', variants: [{ id: randomUUID(), sku: 'REPLACEMENT', originalSpec: 'Green', normalizedSpec: 'Green', purchasePrice: '', inventory: null }] });
  const file = join(f.directory, 'historical-content.htcbackup'), target = join(f.directory, 'history-restored');
  await createWorkspaceBackup(f.directory, file, 'historical copy fixture passphrase');
  await commitWorkspaceRestore(target, await prepareWorkspaceRestore(target, file, 'historical copy fixture passphrase'));
  const db = openDatabase(target);
  try { assert.deepEqual(JSON.parse(String(db.prepare('SELECT record_json FROM content_versions').get()!.record_json)), version); }
  finally { db.close(); }
  const restored = new WorkspaceStore(target);
  try { assert.deepEqual(restored.getProduct(changed.id), changed); assert.notEqual(changed.variants[0].id, version.variantId); }
  finally { restored.close(); }
});
