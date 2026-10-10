import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { publicApi } from './api-surface.mjs';

await mkdir(resolve('.test-data'), { recursive: true }); await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/execution-e2e-')), harness = join(dataRoot, 'harness.cjs');
await build({ entryPoints: ['tests/fixtures/execution-electron.ts'], outfile: harness, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] });
const preload=join(dataRoot,'preload.cjs');await build({entryPoints:['src/main/preload.ts'],outfile:preload,bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron']});
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url), env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1', RED_E2E_PRELOAD:preload }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = []; let app, page;
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [harness], cwd: resolve('.'), env, timeout: 35000 });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.waitForFunction(() => !!window.red);
}
async function chooseFile(path) { await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path); }
async function confirm(response) { await app.evaluate(({ dialog }, value) => { dialog.showMessageBox = async (_window, options) => { globalThis.__lastConfirmation = options; return { response: value }; }; }, response); }
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
try {
  await launch(); assert.deepEqual((await page.evaluate(() => Object.keys(window.red))).sort(), [...publicApi].sort());
  const profiles = await page.evaluate(() => window.red.listFtpProfiles()); assert.equal(profiles.length, 5); assert.ok(profiles.every(p => !p.enabled && !p.configured));
  await chooseFile(join(dataRoot, 'ftp-test-config.json')); const profile = await page.evaluate(() => window.red.importFtpProfile());
  assert.equal(profile.configured, true); assert.equal(profile.enabled, false); assert.ok(!JSON.stringify(profile).includes('fixture-password'));
  await page.evaluate(() => window.red.setFtpProfileEnabled({ id: 'alpha', enabled: true })); pass('narrow API and native FTP import with encrypted credentials');
  const examples = await page.evaluate(() => window.red.loadExamples());
  const selected = examples.find(p => p.variantCount === 3); assert.ok(selected);
  let product = await page.evaluate(id => window.red.getProduct(id), selected.id);
  for (const asset of product.assets) product = await page.evaluate(input => window.red.updateAsset(input), { productId: product.id, revision: product.revision,
    assetId: asset.id, role: asset.role, variantIds: asset.role === 'main' ? product.variants.map(v => v.id) : [] });
  await page.evaluate(async product=>{for(const variant of product.variants){const input={productId:product.id,productRevision:product.revision,variantId:variant.id},view=await window.red.getSourceConsistency(input);await window.red.decideSourceConsistency({...input,fingerprint:view.fingerprint,decision:'CONFIRMED',reason:'Isolated fixture confirms this exact example image and selected specification; no physical fact authority'});}},product);
  const target = await page.evaluate(() => window.red.enableAmazonDemo());
  assert.equal(await page.evaluate(() => typeof window.red.prepareAmazonDrafts), 'function', 'Batch preparation must be exposed through the desktop API');
  const preparationInput = { targetId: target.id, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US',
    items: product.variants.map((variant, index) => ({ productId: product.id, productRevision: product.revision, variantId: variant.id, attributes: {
      brand: [{ value: 'Verified Fixture Brand', marketplace_id: target.marketplaceId }], color: [{ value: ['Blue', 'Gray', 'White'][index], marketplace_id: target.marketplaceId }],
      purchasable_offer: [{ marketplace_id: target.marketplaceId, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 12.5 + index }] }] }],
    } })) };
  const prepared = await page.evaluate(input => window.red.prepareAmazonDrafts(input), preparationInput);
  assert.equal(prepared.items.length, 3); assert.ok(prepared.items.every(item => item.disposition === 'CREATED' && item.draft && item.issues.length === 0));
  const drafts = prepared.items.map(item => item.draft);
  for (const [index, draft] of drafts.entries()) {
    assert.equal(draft.variantId, product.variants[index].id);
    assert.equal(draft.attributes.color[0].value, ['Blue', 'Gray', 'White'][index]);
    assert.equal(draft.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 12.5 + index);
  }
  const repeated = await page.evaluate(input => window.red.prepareAmazonDrafts(input), preparationInput);
  assert.ok(repeated.items.every(item => item.disposition === 'REUSED'));
  assert.deepEqual(repeated.items.map(item => item.draft.id), drafts.map(draft => draft.id));
  assert.deepEqual(await page.evaluate(id => window.red.getProduct(id), product.id), product);
  assert.equal((await app.evaluate(() => globalThis.__executionHarness.snapshot())).stor, 0);
  assert.equal((await page.evaluate(() => window.red.listAmazonCalls())).filter(call => call.operation === 'putListingsItem').length, 0);
  const badPreparation = await page.evaluate(async input => { try { await window.red.prepareAmazonDrafts(input); return null; } catch (error) { return error.message; } }, { ...preparationInput, confirmed: true });
  assert.ok(badPreparation); pass('batch preparation preserves per-SKU attributes, reuses drafts and cannot confirm publication');
  for (const concurrency of [2, '3', null]) await assert.rejects(page.evaluate(input => window.red.createExecutionTask(input), { draftIds: drafts.map(d => d.id), profileId: 'alpha', concurrency }));
  const task = await page.evaluate(input => window.red.createExecutionTask(input), { draftIds: drafts.map(d => d.id), profileId: 'alpha', concurrency: 3 });
  assert.equal(task.concurrency, 3);
  await confirm(0); assert.equal(await page.evaluate(id => window.red.startExecutionTask(id), task.id), null);
  assert.equal((await app.evaluate(() => globalThis.__executionHarness.snapshot())).stor, 0); pass('cancelled native task confirmation has no upload or submission');
  await app.evaluate(() => globalThis.__executionHarness.holdUploads());
  await confirm(1); await page.evaluate(id => window.red.startExecutionTask(id), task.id);
  assert.match(await app.evaluate(() => globalThis.__lastConfirmation.detail), /并发：3 个 SKU/);
  await expect.poll(() => app.evaluate(() => globalThis.__executionHarness.snapshot().activeUploads), { timeout: 5000 }).toBe(3);
  const inFlight = await page.evaluate(id => window.red.getExecutionTask(id), task.id);
  assert.equal(inFlight.items.filter(item => item.status === 'RUNNING').length, 3);
  assert.ok(inFlight.items.every(item => item.steps[0].status === 'RUNNING' && item.steps.slice(1).every(step => step.status === 'PENDING')));
  assert.equal((await page.evaluate(() => window.red.listAmazonCalls())).filter(call => call.operation === 'putListingsItem').length, 0);
  await app.evaluate(() => globalThis.__executionHarness.releaseUploads());
  pass('three SKU workers overlap at the upload barrier, with strict concurrency input and confirmed scope');
  const confirmation = await app.evaluate(() => globalThis.__lastConfirmation); for (const draft of drafts) assert.ok(confirmation.detail.includes(draft.sku));
  await expect.poll(async () => (await page.evaluate(id => window.red.getExecutionTask(id), task.id)).status, { timeout: 30000 }).toBe('COMPLETED');
  const complete = await page.evaluate(id => window.red.getExecutionTask(id), task.id);
  assert.equal(complete.status, 'COMPLETED', JSON.stringify(complete)); assert.equal(complete.items.length, 3);
  const stats = await app.evaluate(() => globalThis.__executionHarness.snapshot()); assert.equal(stats.stor, 1); assert.equal(stats.files, 1);
  // Every SKU verifies twice; overlapping verification of the same image shares a physical probe.
  assert.equal(stats.verifyEntries, 6); assert.ok(stats.probes >= 3);
  assert.equal(stats.peakUploads, 3); assert.equal(stats.activeUploads, 0); assert.equal(stats.uploadEntries, 3);
  const uploads = await page.evaluate(() => window.red.listHostedAssets()); assert.equal(uploads.length, 1); assert.equal(uploads[0].status, 'AVAILABLE');
  const calls = await page.evaluate(() => window.red.listAmazonCalls()); assert.equal(calls.filter(c => c.operation === 'putListingsItem').length, 3);
  const finishedDrafts = await page.evaluate(id => window.red.listAmazonDrafts(id), product.id);
  assert.ok(finishedDrafts.every(d => d.state === 'BUYABLE'));
  for (const [index, source] of drafts.entries()) {
    const finished = finishedDrafts.find(d => d.id === source.id);
    assert.equal(finished.variantId, product.variants[index].id);
    assert.deepEqual(finished.attributes.color, source.attributes.color);
    assert.deepEqual(finished.attributes.purchasable_offer, source.attributes.purchasable_offer);
  }
  assert.deepEqual(await page.evaluate(id => window.red.getProduct(id), product.id), product);
  pass('three SKU task: real local FTP upload once, verified image reuse, demo validation/submission/readback');
  const invalid = await page.evaluate(async input => { try { await window.red.createExecutionTask(input); return null; } catch (error) { return error.message; } }, { draftIds: drafts.map(d => d.id), profileId: 'alpha', confirmed: true });
  assert.ok(invalid); pass('renderer cannot pass a confirmation override');
  await app.close(); app = null; await launch();
  const restarted = await page.evaluate(id => window.red.getExecutionTask(id), task.id);
  assert.equal(restarted.status, 'COMPLETED'); assert.equal(restarted.concurrency, 3);
  assert.equal((await page.evaluate(() => window.red.listAmazonCalls())).filter(c => c.operation === 'putListingsItem').length, 3);
  assert.equal((await app.evaluate(() => globalThis.__executionHarness.snapshot())).stor, 0); pass('desktop restart preserves task results and does not replay uploads or submissions');
  assert.deepEqual(errors, []);
  await writeFile(resolve('artifacts/execution-e2e-report.json'), JSON.stringify({ passed: true, checks, errors, dataRoot, concurrency: task.concurrency, metrics: stats, environment: 'isolated Electron + loopback FTP + content-checking HTTPS test double + Amazon demo', at: new Date().toISOString() }, null, 2));
} catch (error) {
  await writeFile(resolve('artifacts/execution-e2e-report.json'), JSON.stringify({ passed: false, checks, errors, dataRoot, failure: String(error), at: new Date().toISOString() }, null, 2)); throw error;
} finally { await app?.close(); }
