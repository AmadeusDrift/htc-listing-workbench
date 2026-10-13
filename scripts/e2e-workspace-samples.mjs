import { electron } from './e2e-core-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { resizeWindow } from './e2e-window.mjs';

await mkdir(resolve('.test-data'), { recursive: true });
await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/workspace-samples-'));
const require = createRequire(import.meta.url), executablePath = process.env.RED_E2E_EXECUTABLE || require('electron');
process.env.electron_config_cache = resolve('.cache/electron');
const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], layouts = [];
let app, page;
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
async function launch() {
  app = await electron.launch({ executablePath, args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: resolve('.'), env, timeout: 35000 });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await app.evaluate(({ BrowserWindow, session }) => {
    BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling = false;
    globalThis.sampleRemoteRequests = [];
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      globalThis.sampleRemoteRequests.push(details.url); callback({ cancel: true });
    });
  });
  await page.getByLabel('采集箱更多操作').click();
  await expect(page.getByRole('button', { name: '载入本地示例', exact: true })).toBeEnabled();
}
async function nav(name) {
  const button = page.locator('nav').getByRole('button', { name, exact: true });
  await button.click(); await expect(button).toHaveAttribute('aria-current', 'page');
}
async function loadVisibleExamples() {
  const button = page.getByRole('button', { name: '载入本地示例', exact: true, includeHidden: true });
  if (!(await button.isVisible())) await page.getByLabel('采集箱更多操作').click();
  await button.click(); await expect(button).toBeEnabled();
}
async function snapshot() {
  return page.evaluate(async () => {
    const products = await window.red.listProducts(), placements = await window.red.listWorkspacePlacements();
    return { products: await Promise.all(products.sort((a, b) => a.id.localeCompare(b.id)).map(product => window.red.getProduct(product.id))),
      placements: placements.sort((a, b) => a.productId.localeCompare(b.productId)) };
  });
}
async function screenshot(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(resolve(`artifacts/${name}.png`), Buffer.from(bytes, 'base64'));
}
async function validateVisibleSamples(selector) {
  await expect(page.locator(selector)).toHaveCount(2);
  for (const row of await page.locator(selector).all()) await expect(row).toContainText('本地示例');
  await expect.poll(() => page.locator(`${selector} .workspace-thumb img, ${selector} .inbox-source-image img`).evaluateAll(images => images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
}
async function layout(name) {
  const result = await page.evaluate(() => {
    const selectors = ['.main-content', '.inbox-workspace', '.inbox-panel', '.automatic-workspace', '.automatic-queue', '.workspace-section-heading', '.collection-row', '.automatic-product'];
    const overflow = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.clientWidth && element.scrollWidth > element.clientWidth + 2).map(() => selector));
    if (document.documentElement.scrollWidth > innerWidth + 1) overflow.push('document');
    return { width: innerWidth, overflow };
  });
  assert.deepEqual(result.overflow, [], name); layouts.push({ name, ...result });
}

try {
  await launch();
  await expect(page.locator('.collection-row')).toHaveCount(0);
  // Fail after two real images have been written, so retry also checks file cleanup.
  await app.evaluate(({ nativeImage }) => {
    globalThis.sampleBitmapEncoder = nativeImage.createFromBitmap;
    let generated = 0;
    nativeImage.createFromBitmap = (...args) => {
      if (++generated === 3) throw new Error('sample image preparation failure');
      return globalThis.sampleBitmapEncoder.apply(nativeImage, args);
    };
  });
  await loadVisibleExamples();
  await expect(page.locator('.error-banner')).toBeVisible();
  assert.equal((await snapshot()).products.length, 0);
  assert.deepEqual(await readdir(join(dataRoot, 'assets')), []);
  await app.evaluate(({ nativeImage }) => { nativeImage.createFromBitmap = globalThis.sampleBitmapEncoder; delete globalThis.sampleBitmapEncoder; });
  await loadVisibleExamples();
  await validateVisibleSamples('.collection-row');
  const inbox = await snapshot(), inboxIds = inbox.products.map(product => product.id);
  assert.ok(inbox.placements.every(item => item.lane === 'inbox'));
  await expect(page.locator('[data-workspace="inbox"]')).toBeVisible();
  await loadVisibleExamples(); assert.deepEqual(await snapshot(), inbox);
  await page.getByLabel('搜索采集箱').fill('没有匹配的内容');
  await expect(page.locator('.collection-row')).toHaveCount(0);
  await loadVisibleExamples();
  await expect(page.getByLabel('搜索采集箱')).toHaveValue('');
  await validateVisibleSamples('.collection-row');
  await screenshot('workspace-samples-inbox');
  pass('inbox button loads two local samples; failed image preparation rolls back and retries cleanly; repeats preserve data');

  await nav('自动上架');
  await expect(page.locator('.automatic-product')).toHaveCount(0);
  // Click the actual page action and race additional requests in the same renderer turn.
  await page.getByRole('button', { name: '载入本地示例', exact: true }).evaluate(button => {
    button.click();
    return Promise.all(Array.from({ length: 8 }, () => window.red.loadWorkspaceExamples('automatic')));
  });
  await validateVisibleSamples('.automatic-product');
  await expect(page.getByRole('button', { name: '载入本地示例', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '启动并自动发布', exact: true })).toBeDisabled();
  await expect(page.getByLabel('全局自动化连接', { exact: true })).toContainText('连接尚未就绪');
  const automatic = await snapshot(), automaticIds = automatic.products.filter(product => !inboxIds.includes(product.id)).map(product => product.id);
  assert.equal(automaticIds.length, 2);
  assert.deepEqual(automatic.products.filter(product => inboxIds.includes(product.id)), inbox.products);
  assert.deepEqual(automatic.placements.filter(item => inboxIds.includes(item.productId)), inbox.placements);
  await loadVisibleExamples(); assert.deepEqual(await snapshot(), automatic);
  await screenshot('workspace-samples-automatic');
  pass('automatic button and concurrent calls create only its own two samples, keep inbox data and do not enable publishing');

  await page.getByRole('button', { name: '载入示例商品', exact: true }).click();
  await expect(page.locator('nav').getByRole('button', { name: '手动上架', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.product-item')).toHaveCount(2);
  const all = await snapshot(), manualIds = all.products.filter(product => !inboxIds.includes(product.id) && !automaticIds.includes(product.id)).map(product => product.id);
  assert.equal(all.products.length, 6); assert.equal(manualIds.length, 2);
  assert.deepEqual(all.products.filter(product => !manualIds.includes(product.id)), automatic.products);
  for (const product of all.products) {
    assert.equal(product.origin, 'sample'); assert.ok(product.variants.length >= 2);
    assert.equal(product.assets.length, product.variants.length);
    assert.equal(product.assets.filter(asset => asset.role === 'main').length, 1);
    assert.deepEqual(product.assets.map(asset => asset.variantIds), product.variants.map(variant => [variant.id]));
    for (const asset of product.assets) {
      assert.match(asset.previewUrl, /^red-asset:\/\/image\//);
      assert.equal(await page.evaluate(url => new Promise(resolve => {
        const image = new Image(); image.onload = () => resolve(image.naturalWidth > 0); image.onerror = () => resolve(false); image.src = url;
      }), asset.previewUrl), true);
    }
  }
  await page.getByRole('button', { name: '载入示例商品', exact: true }).click();
  await expect(page.getByRole('button', { name: '载入示例商品', exact: true })).toBeEnabled();
  assert.deepEqual(await snapshot(), all);
  assert.equal((await readdir(join(dataRoot, 'assets'))).length, 30);
  pass('manual sidebar remains independent; all six products have multiple stable SKUs and 15 working local images');

  for (const value of [null, 'manual', 'ignored', 'Inbox', 'inbox ', {}, [], { lane: 'inbox' }, { lane: 'automatic', extra: true }]) {
    await assert.rejects(page.evaluate(value => window.red.loadWorkspaceExamples(value), value), /工作区无效/);
  }
  await assert.rejects(page.evaluate(() => window.red.loadWorkspaceExamples()), /工作区无效/);
  // Exercise the real main-process boundary, which counts IPC arguments before dispatch.
  const arity = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const sender = BrowserWindow.getAllWindows()[0].webContents, event = { sender, senderFrame: sender.mainFrame };
    const workspace = ipcMain._invokeHandlers.get('red:examples:load-workspace'), manual = ipcMain._invokeHandlers.get('red:examples:load');
    return Promise.all([workspace(event), workspace(event, 'inbox', {}), manual(event, 'inbox')]);
  });
  for (const result of arity) { assert.equal(result.ok, false); assert.match(result.error, /参数数量/); }
  assert.deepEqual(await snapshot(), all);
  pass('new API rejects invalid lane values and both example IPC handlers enforce exact argument counts');

  for (const width of [1480, 900, 640]) {
    await resizeWindow(app, page, width, 960);
    for (const name of ['采集箱', '自动上架']) {
      await nav(name);
      const button = page.getByRole('button', { name: '载入本地示例', exact: true });
      if (!(await button.isVisible())) await page.getByLabel('采集箱更多操作').click();
      await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport({ ratio: .95 });
      await layout(`${name} ${width}`);
      if (width === 640) await screenshot(`workspace-samples-${name === '采集箱' ? 'inbox' : 'automatic'}-640`);
    }
  }
  pass('both sample actions stay visible and reachable at desktop and narrow widths');

  await page.evaluate(async ids => {
    for (const [index, id] of ids.entries()) {
      const product = await window.red.getProduct(id);
      const saved = await window.red.saveProduct({ id, revision: product.revision, title: `用户改名商品 ${index}`, sourceUrl: 'https://example.com/local-user-edit',
        description: `用户修改 ${index}`, status: product.status, facts: product.facts,
        variants: product.variants.map(({ id, originalSpec, purchasePrice, inventory }, variantIndex) => ({ id, sku: `USER-${index}-${variantIndex}`, originalSpec, normalizedSpec: '用户整理规格', purchasePrice, inventory })) });
      await window.red.updateAsset({ productId: id, revision: saved.revision, assetId: saved.assets[0].id, role: 'detail', variantIds: [saved.variants.at(-1).id] });
    }
  }, [...inboxIds, ...automaticIds, ...manualIds]);
  await page.evaluate(async ({ inboxIds, automaticIds, manualIds }) => {
    for (const [productId, destination] of [[inboxIds[0], 'manual'], [inboxIds[1], 'ignored'], [automaticIds[0], 'inbox'], [automaticIds[1], 'manual'], [manualIds[0], 'automatic'], [manualIds[1], 'ignored']]) {
      await window.red.moveWorkspaceProducts({ productIds: [productId], destination });
    }
  }, { inboxIds, automaticIds, manualIds });
  const edited = await snapshot(), files = (await readdir(join(dataRoot, 'assets'))).sort();
  await page.evaluate(() => Promise.all(Array.from({ length: 5 }, () => [window.red.loadExamples(), window.red.loadWorkspaceExamples('inbox'), window.red.loadWorkspaceExamples('automatic')]).flat()));
  assert.deepEqual(await snapshot(), edited); assert.deepEqual((await readdir(join(dataRoot, 'assets'))).sort(), files);
  assert.deepEqual(await app.evaluate(() => globalThis.sampleRemoteRequests), []);
  assert.equal((await page.evaluate(() => window.red.listAiCalls())).length, 0);
  assert.equal((await page.evaluate(() => window.red.listAmazonCalls())).length, 0);
  assert.equal((await page.evaluate(() => window.red.listExecutionTasks())).length, 0);
  await app.close(); app = undefined;
  await launch();
  assert.deepEqual(await snapshot(), edited);
  await page.evaluate(() => Promise.all([window.red.loadExamples(), window.red.loadWorkspaceExamples('inbox'), window.red.loadWorkspaceExamples('automatic')]));
  assert.deepEqual(await snapshot(), edited); assert.deepEqual((await readdir(join(dataRoot, 'assets'))).sort(), files);
  await loadVisibleExamples(); assert.deepEqual(await snapshot(), edited);
  await expect(page.locator('.collection-row')).toHaveCount(1);
  await nav('自动上架'); await loadVisibleExamples(); assert.deepEqual(await snapshot(), edited);
  await expect(page.locator('.automatic-product')).toHaveCount(1);
  assert.deepEqual(await app.evaluate(() => globalThis.sampleRemoteRequests), []);
  pass('edited titles, SKU codes, image links and moved placements survive concurrent reloads and restart without network or paid calls');

  assert.deepEqual(errors, []); pass('no renderer runtime or image-loading errors');
  await writeFile(resolve('artifacts/workspace-samples-e2e-report.json'), JSON.stringify({ passed: true, checks, layouts, errors, dataRoot, executablePath, at: new Date().toISOString() }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await screenshot('workspace-samples-e2e-failure').catch(() => {});
  await writeFile(resolve('artifacts/workspace-samples-e2e-report.json'), JSON.stringify({ passed: false, checks, layouts, errors, dataRoot, executablePath, failure: String(error), at: new Date().toISOString() }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {}); await app.close().catch(() => {}); }
}
