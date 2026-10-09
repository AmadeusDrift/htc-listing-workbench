import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { publicApi } from './api-surface.mjs';

await mkdir(resolve('.test-data'), { recursive: true }); await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/ai-e2e-')), harness = join(dataRoot, 'harness.cjs');
await build({ entryPoints: ['tests/fixtures/ai-electron.ts'], outfile: harness, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] });
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url), env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = []; let app, page;
async function launch() { app = await electron.launch({ executablePath: require('electron'), args: [harness], cwd: resolve('.'), env, timeout: 35000 }); page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.waitForFunction(() => !!window.red); }
async function choose(path) { await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path); }
const snapshot = () => app.evaluate(() => globalThis.__aiHarness.snapshot());
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
async function readPages(method, filter, firstPage) {
  let current = firstPage ?? await page.evaluate(({ method, filter }) => window.red[method]({ ...filter, pageSize: 1 }), { method, filter });
  const items = [...current.items], cursors = new Set();
  while (current.nextCursor !== null) {
    assert.ok(!cursors.has(current.nextCursor), 'cursor must make progress'); cursors.add(current.nextCursor);
    current = await page.evaluate(({ method, filter, cursor }) => window.red[method]({ ...filter, pageSize: 2, cursor }), { method, filter, cursor: current.nextCursor });
    assert.ok(current.items.length <= 2); items.push(...current.items);
  }
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  return items;
}
try {
  await launch(); assert.deepEqual((await page.evaluate(() => Object.keys(window.red))).sort(), [...publicApi].sort());
  assert.ok((await page.evaluate(() => window.red.listAiProviders())).every(profile => !profile.enabled && !profile.configured));
  const capability = (await page.evaluate(() => window.red.listAiCapabilities())).find(item => item.capability === 'image-generation');
  assert.equal(capability.available, false); assert.equal(capability.providerId, null); pass('narrow AI API, disabled defaults and honest image-generation placeholder');
  for (const id of ['aliyun-ocr', 'aidge-segmentation', 'deepseek', 'deepseek-review']) {
    await choose(join(dataRoot, `${id}.json`)); const profile = await page.evaluate(() => window.red.importAiProviderConfig());
    assert.equal(profile.id, id); assert.equal(profile.configured, true); assert.equal(profile.enabled, false); assert.ok(!JSON.stringify(profile).includes('fixture-'));
    const encrypted = await readFile(join(dataRoot, 'ai-vault', `${id}.bin`)); assert.ok(!encrypted.includes(Buffer.from(id.startsWith('deepseek') ? 'fixture-api-key-never-public' : 'fixture-access-key-secret')));
  }
  const templatePath = join(dataRoot, 'blank-template.json');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, templatePath);
  await page.evaluate(() => window.red.exportAiProviderTemplate('deepseek')); const template = JSON.parse(await readFile(templatePath, 'utf8')); assert.equal(template.apiKey, '');
  pass('native config import, real safeStorage encryption and secret-free template export');
  const examples = await page.evaluate(() => window.red.loadExamples());
  let product = await page.evaluate(id => window.red.getProduct(id), examples.find(item => item.variantCount === 3).id);
  const main = product.assets.find(asset => asset.role === 'main');
  product = await page.evaluate(input => window.red.updateAsset(input), { productId: product.id, revision: product.revision, assetId: main.id, role: 'main', variantIds: product.variants.map(item => item.id) });
  product = await page.evaluate(input => window.red.saveProduct(input), { id: product.id, revision: product.revision, title: product.title, sourceUrl: product.sourceUrl, description: product.description, status: product.status, facts: product.facts,
    variants: product.variants.map(({ id, sku, originalSpec, normalizedSpec }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice: '98737.49', inventory: 71339 })) });
  const imageInput = { productId: product.id, productRevision: product.revision, assetId: main.id };
  await assert.rejects(page.evaluate(input => window.red.recognizeProductImage(input), imageInput)); assert.equal((await snapshot()).requests.length, 0);
  for (const id of ['aliyun-ocr', 'aidge-segmentation', 'deepseek']) await page.evaluate(id => window.red.setAiProviderEnabled({ id, enabled: true }), id);
  const ocr = await page.evaluate(input => window.red.recognizeProductImage(input), imageInput);
  assert.equal(ocr.output.kind, 'ocr'); assert.equal(ocr.output.coordinateSpace, 'unknown'); assert.equal(ocr.output.lines[0].box, null); assert.equal(ocr.reviewState, 'unreviewed');
  assert.deepEqual(await page.evaluate(id => window.red.getProduct(id), product.id), product);
  pass('Commerce OCR preserves source image, confidence and unknown coordinate placement');
  await assert.rejects(page.evaluate(input => window.red.segmentProductImage(input), { ...imageInput, hostedAssetId: '44444444-4444-4444-8444-444444444444' }));
  assert.equal((await page.evaluate(id => window.red.listAiResults(id), product.id)).length, 1);
  await choose(join(dataRoot, 'ftp.json')); await page.evaluate(() => window.red.importFtpProfile()); await page.evaluate(() => window.red.setFtpProfileEnabled({ id: 'alpha', enabled: true }));
  const hosted = await app.evaluate((_electron, assetId) => globalThis.__aiHarness.upload(assetId), main.id);
  const segmented = await page.evaluate(input => window.red.segmentProductImage(input), { ...imageInput, hostedAssetId: hosted.id });
  assert.equal(segmented.output.outputKind, 'transparent-cutout'); assert.equal(segmented.output.materialized, false); assert.equal(segmented.reviewState, 'unreviewed'); assert.equal((await snapshot()).stor, 1);
  pass('Aidge uses a verified FTP image and returns a temporary cutout, not a grayscale mask');
  const versionInput = { productId: product.id, productRevision: product.revision, resultId: segmented.id };
  for (const invalid of ['opaque-image', 'bad-crc-image', 'truncated-image']) {
    await app.evaluate((_electron, mode) => globalThis.__aiHarness.mode(mode), invalid);
    await assert.rejects(page.evaluate(input => window.red.saveImageResult(input), versionInput), undefined, `Reject ${invalid}`);
    assert.equal((await page.evaluate(id => window.red.listImageVersions(id), product.id)).length, 0);
  }
  await app.evaluate(() => globalThis.__aiHarness.mode('normal'));
  const imageVersion = await page.evaluate(input => window.red.saveImageResult(input), versionInput);
  assert.ok(imageVersion.checks.transparentPixels > 0); assert.ok(imageVersion.checks.subjectPixels > 0); assert.equal(imageVersion.reviewState, 'unreviewed');
  assert.deepEqual(await page.evaluate(input => window.red.saveImageResult(input), versionInput), imageVersion); assert.equal((await snapshot()).downloads, 4);
  const versionPreview = await page.evaluate(id => window.red.getImageVersionPreview(id), imageVersion.id); assert.ok(versionPreview.startsWith('data:image/png;base64,'));
  const selectionInput = { productId: product.id, productRevision: product.revision, sourceAssetId: main.id };
  await page.evaluate(input => window.red.selectImageVersion(input), { ...selectionInput, versionId: imageVersion.id });
  await page.evaluate(input => window.red.selectImageVersion(input), { ...selectionInput, versionId: null });
  assert.deepEqual((await page.evaluate(id => window.red.listImageSelections(id), product.id)).map(s => s.versionId), [imageVersion.id, null]);
  assert.deepEqual(await page.evaluate(id => window.red.getProduct(id), product.id), product);
  pass('real transparent PNG decoded into an immutable local version, with idempotent save and selection rollback');
  const contentInput = { productId: product.id, productRevision: product.revision, variantId: product.variants[0].id, ocrResultIds: [ocr.id] };
  const beforeDedup = (await snapshot()).requests.length;
  const [suggestion, sameSuggestion] = await page.evaluate(input => Promise.all([window.red.suggestProductContent(input), window.red.suggestProductContent(input)]), contentInput);
  assert.deepEqual(suggestion, sameSuggestion); assert.equal((await snapshot()).requests.length, beforeDedup + 1);
  assert.equal(suggestion.output.kind, 'text'); assert.equal(suggestion.reviewState, 'unreviewed');
  const request = (await snapshot()).requests.find(item => item.provider === 'deepseek'); assert.equal(request.model, 'deepseek-flash'); assert.ok(!request.prompt.includes('98737.49')); assert.ok(!request.prompt.includes('71339'));
  assert.deepEqual(await page.evaluate(id => window.red.getProduct(id), product.id), product);
  assert.equal((await page.evaluate(id => window.red.listAmazonDrafts(id), product.id)).length, 0);
  assert.ok((await page.evaluate(() => window.red.listAiCalls())).some(call => call.usage.promptTokens === 123 && call.usage.completionTokens === 42));
  pass('DeepSeek stores unreviewed JSON suggestions and usage without purchase price, inventory or source mutation');
  const textUsage = await page.evaluate(() => window.red.getAiUsageSummary('deepseek'));
  assert.equal(textUsage.timeZone, 'UTC'); assert.equal(textUsage.attempts, 1); assert.equal(textUsage.reportedTokens, 165);
  assert.equal(textUsage.usedTokens, 165); assert.equal(textUsage.pendingCalls, 0); assert.equal(textUsage.unknownCalls, 0);
  const boundedPolicy = { providerId: 'deepseek', dailyCallLimit: textUsage.attempts, dailyTokenLimit: null };
  await page.evaluate(policy => window.red.setAiUsagePolicy(policy), boundedPolicy);
  assert.deepEqual(await page.evaluate(() => window.red.getAiUsagePolicy('deepseek')), boundedPolicy);
  const beforeLimit = (await snapshot()).requests.length;
  await assert.rejects(page.evaluate(input => window.red.suggestProductContent(input), contentInput));
  assert.equal((await snapshot()).requests.length, beforeLimit);
  await page.evaluate(() => window.red.setAiUsagePolicy({ providerId: 'deepseek', dailyCallLimit: null, dailyTokenLimit: 1 }));
  await assert.rejects(page.evaluate(input => window.red.suggestProductContent(input), contentInput));
  assert.equal((await snapshot()).requests.length, beforeLimit);
  await assert.rejects(page.evaluate(() => window.red.setAiUsagePolicy({ providerId: 'aliyun-ocr', dailyCallLimit: null, dailyTokenLimit: 1 })));
  await page.evaluate(() => window.red.setAiUsagePolicy({ providerId: 'deepseek', dailyCallLimit: null, dailyTokenLimit: null }));
  pass('preload merges duplicate requests, reports usage and enforces saved call/token quotas before sending');
  const reviewInput = { productId: product.id, productRevision: product.revision, suggestionResultId: suggestion.id };
  await assert.rejects(page.evaluate(input => window.red.reviewProductContent(input), reviewInput));
  await page.evaluate(() => window.red.setAiProviderEnabled({ id: 'deepseek-review', enabled: true }));
  await app.evaluate(() => globalThis.__aiHarness.mode('review-blocked'));
  const blockedReview = await page.evaluate(input => window.red.reviewProductContent(input), reviewInput);
  assert.equal(blockedReview.output.verdict, 'NEEDS_CHANGES');
  await assert.rejects(page.evaluate(input => window.red.adoptReviewedContent(input), { productId: product.id, productRevision: product.revision, reviewResultId: blockedReview.id }));
  assert.equal((await page.evaluate(id => window.red.listContentVersions(id), product.id)).length, 0);
  await app.evaluate(() => globalThis.__aiHarness.mode('normal'));
  const reviewed = await page.evaluate(input => window.red.reviewProductContent(input), reviewInput);
  assert.equal(reviewed.providerId, 'deepseek-review'); assert.equal(reviewed.model, 'deepseek-v4-pro'); assert.equal(reviewed.output.verdict, 'PASS');
  const adoptionInput = { productId: product.id, productRevision: product.revision, reviewResultId: reviewed.id };
  const copy = await page.evaluate(input => window.red.adoptReviewedContent(input), adoptionInput);
  assert.deepEqual(await page.evaluate(input => window.red.adoptReviewedContent(input), adoptionInput), copy);
  assert.equal((await page.evaluate(id => window.red.listContentVersions(id), product.id)).length, 1);
  assert.deepEqual(await page.evaluate(id => window.red.getProduct(id), product.id), product);
  assert.equal((await page.evaluate(id => window.red.listAmazonDrafts(id), product.id)).length, 0); assert.equal((await page.evaluate(() => window.red.listExecutionTasks())).length, 0);
  pass('independent review model blocks unsupported copy and adopts only a current passing report without Amazon or task changes');
  const callsBefore = (await snapshot()).requests.length;
  await assert.rejects(page.evaluate(input => window.red.recognizeProductImage(input), { ...imageInput, url: 'https://unexpected.example/' })); assert.equal((await snapshot()).requests.length, callsBefore);
  await app.evaluate(() => globalThis.__aiHarness.mode('auth-error'));
  const failure = await page.evaluate(async input => { try { await window.red.suggestProductContent(input); return ''; } catch (error) { return error.message; } }, contentInput);
  assert.ok(failure); assert.ok(!failure.includes('SENTINEL_SECRET')); assert.equal((await snapshot()).requests.length, callsBefore + 1);
  const unknownUsage = await page.evaluate(() => window.red.getAiUsageSummary('deepseek'));
  assert.equal(unknownUsage.unknownCalls, 1); assert.ok(unknownUsage.reservedTokens > 0);
  assert.equal(unknownUsage.usedTokens, unknownUsage.reportedTokens + unknownUsage.reservedTokens);
  pass('unapproved parameters rejected and provider errors sanitized without automatic billable retries');
  await app.evaluate(() => globalThis.__aiHarness.mode('hold'));
  await page.evaluate(input => { window.__pendingAi = window.red.suggestProductContent(input).then(() => 'unexpected-success', error => error.message); }, contentInput);
  await expect.poll(async () => (await page.evaluate(() => window.red.listAiCalls())).some(call => call.status === 'RUNNING'), { timeout: 5000 }).toBe(true);
  await page.evaluate(() => window.red.setAiProviderEnabled({ id: 'deepseek', enabled: false }));
  const cancelled = await page.evaluate(() => window.__pendingAi); assert.notEqual(cancelled, 'unexpected-success'); assert.ok(!cancelled.includes('SENTINEL_SECRET'));
  assert.ok((await page.evaluate(() => window.red.listAiCalls())).every(call => call.status !== 'RUNNING'));
  pass('disabling a service aborts in-flight work and prevents late results');
  const filter = { productId: product.id };
  for (const [method, legacy] of [['queryAiResults', 'listAiResults'], ['queryImageVersions', 'listImageVersions'], ['queryImageSelections', 'listImageSelections'], ['queryContentVersions', 'listContentVersions']]) {
    const expected = await page.evaluate(({ legacy, id }) => window.red[legacy](id), { legacy, id: product.id });
    assert.deepEqual(await readPages(method, filter), expected);
    for (const pageSize of [0, 101, 1.5, '1']) await assert.rejects(page.evaluate(({ method, input }) => window.red[method](input), { method, input: { ...filter, pageSize } }));
  }
  const allCalls = await page.evaluate(() => window.red.listAiCalls());
  assert.deepEqual(await readPages('queryAiCalls', {}), allCalls);
  assert.deepEqual(await readPages('queryAiCalls', { ...filter, providerId: 'deepseek', status: 'FAILED' }), allCalls.filter(call => call.productId === product.id && call.providerId === 'deepseek' && call.status === 'FAILED'));
  pass('five paginated history APIs match existing results across real preload IPC and reject invalid sizes');
  const beforeAppend = await page.evaluate(id => window.red.listAiResults(id), product.id);
  const firstPage = await page.evaluate(input => window.red.queryAiResults(input), { ...filter, pageSize: 1 });
  assert.ok(firstPage.nextCursor);
  const otherId = examples.find(item => item.id !== product.id).id;
  await assert.rejects(page.evaluate(input => window.red.queryAiResults(input), { productId: otherId, pageSize: 1, cursor: firstPage.nextCursor }));
  await assert.rejects(page.evaluate(input => window.red.queryImageSelections(input), { ...filter, pageSize: 1, cursor: firstPage.nextCursor }));
  await assert.rejects(page.evaluate(input => window.red.queryAiResults(input), { ...filter, pageSize: 1, cursor: `${firstPage.nextCursor}x` }));
  const appended = await page.evaluate(input => window.red.recognizeProductImage(input), imageInput);
  assert.deepEqual(await readPages('queryAiResults', filter, firstPage), beforeAppend);
  assert.deepEqual(await readPages('queryAiResults', filter), [...beforeAppend, appended]);
  pass('history cursors bind filters/resources and keep a stable boundary when new results arrive');
  const results = await page.evaluate(id => window.red.listAiResults(id), product.id);
  const callCount = (await page.evaluate(() => window.red.listAiCalls())).length;
  const usageBeforeRestart = await page.evaluate(() => window.red.getAiUsageSummary('deepseek'));
  await app.close(); app = null; await launch();
  await assert.rejects(page.evaluate(input => window.red.queryAiResults(input), { ...filter, pageSize: 1, cursor: firstPage.nextCursor }));
  assert.deepEqual(await readPages('queryAiResults', filter), results);
  assert.deepEqual(await page.evaluate(() => window.red.getAiUsageSummary('deepseek')), usageBeforeRestart);
  assert.deepEqual(await page.evaluate(id => window.red.listAiResults(id), product.id), results); assert.equal((await page.evaluate(() => window.red.listAiCalls())).length, callCount); assert.equal((await snapshot()).requests.length, 0);
  assert.deepEqual(await page.evaluate(id => window.red.listImageVersions(id), product.id), [imageVersion]);
  assert.deepEqual(await page.evaluate(id => window.red.listContentVersions(id), product.id), [copy]);
  assert.equal((await page.evaluate(() => window.red.listAiProviders())).find(profile => profile.id === 'deepseek').enabled, false);
  const disconnected = await page.evaluate(() => window.red.disconnectAiProvider('aliyun-ocr')); assert.equal(disconnected.configured, false); assert.equal(disconnected.enabled, false);
  pass('restart preserves evidence without replay and provider disconnect removes authorization');
  await page.evaluate(() => window.red.setAiProviderEnabled({ id: 'deepseek', enabled: true }));
  await app.evaluate(() => globalThis.__aiHarness.mode('hold'));
  await page.evaluate(input => { window.__shutdownAi = window.red.suggestProductContent(input).catch(() => null); }, contentInput);
  await expect.poll(async () => (await page.evaluate(() => window.red.listAiCalls())).some(call => call.status === 'RUNNING'), { timeout: 5000 }).toBe(true);
  await app.close(); app = null; await launch();
  const afterShutdown = await page.evaluate(() => window.red.listAiCalls());
  assert.equal(afterShutdown.length, callCount + 1); assert.ok(afterShutdown.every(call => call.status !== 'RUNNING')); assert.equal((await snapshot()).requests.length, 0);
  assert.deepEqual(await page.evaluate(id => window.red.listAiResults(id), product.id), results);
  pass('desktop shutdown drains an active provider request before closing the database');
  assert.deepEqual(errors, []);
  await writeFile(resolve('artifacts/ai-e2e-report.json'), JSON.stringify({ passed: true, checks, errors, dataRoot, environment: 'isolated Electron + real safeStorage + loopback FTP + simulated official API responses; no live provider calls', at: new Date().toISOString() }, null, 2));
} catch (error) {
  await writeFile(resolve('artifacts/ai-e2e-report.json'), JSON.stringify({ passed: false, checks, errors, dataRoot, failure: String(error), at: new Date().toISOString() }, null, 2)); throw error;
} finally { await app?.close(); }
