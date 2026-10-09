import { chromium, _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { buildExtension } from './build-extension.mjs';
import { collectionFixture } from './collection-fixtures.mjs';
import { COLLECTION_EXTENSION_ID } from '../src/shared/collection-identity.ts';
import { resizeWindow } from './e2e-window.mjs';
import { selectSettingsModule } from './e2e-settings.mjs';

await mkdir(resolve('.test-data'), { recursive: true }); await mkdir(resolve('artifacts'), { recursive: true });
const root = await mkdtemp(resolve('.test-data/collection-e2e-'));
const dataRoot = join(root, 'workspace');
const hostName = `com.htc.workbench.collection.test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const extension = await buildExtension({ destination: join(root, 'extension'), testHost: hostName });
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url);
const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1', RED_COLLECTION_TEST_HOST: hostName };
delete env.ELECTRON_RUN_AS_NODE;
const server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(collectionFixture(new URL(request.url, 'http://local').pathname.slice(1))); });
const checks = [], errors = [], layouts = [], blockedRequests = [];
const artifactPrefix = process.env.RED_E2E_EXECUTABLE ? 'packaged-' : '';
let app, page, browser, fixture, popup, installed = false, passed = false;
const connectionDirectory = join(dataRoot, 'collection-connection');
const runFile = promisify(execFile);
function pass(message) { checks.push(message); console.log(`PASS ${message}`); }
async function script(name) {
  assert.match(hostName, /^com\.htc\.workbench\.collection\.test_[a-f0-9]{12}$/);
  const path = resolve(connectionDirectory, name);
  assert.ok(path.startsWith(resolve(root) + sep));
  return runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path], { windowsHide: true, timeout: 20000, maxBuffer: 262144 });
}
async function launch() {
  app = await electron.launch({ executablePath: process.env.RED_E2E_EXECUTABLE || require('electron'), args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: resolve('.'), env, timeout: 35000 });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling = false; });
  await page.waitForFunction(() => !!window.red && document.querySelector('button'));
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeEnabled();
}
async function read(name) {
  await fixture.goto(`http://127.0.0.1:${server.address().port}/${name}`); await fixture.bringToFront();
  await popup.getByRole('button', { name: '读取当前商品', exact: true }).evaluate(button => button.click());
  await expect(popup.getByRole('button', { name: '读取当前商品', exact: true })).toBeEnabled();
  await expect(popup.getByRole('alert')).toBeHidden();
  return popup.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }));
}
async function send() {
  await popup.locator('#send').click();
  await expect(popup.locator('#send')).toBeEnabled();
  await expect(popup.getByRole('alert')).toBeHidden();
  await expect(popup.locator('#receipt')).toBeVisible();
  return (await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }))).receipt;
}
try {
  await launch();
  const initial = await page.evaluate(() => window.red.getCollectionStatus());
  assert.equal(initial.state, 'unprepared'); assert.equal(initial.connectionPrepared, false);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await selectSettingsModule(page, 'collection');
  await page.getByRole('button', { name: '准备采集连接', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '连接文件已准备' })).toBeVisible();
  const prepared = await page.evaluate(() => window.red.getCollectionStatus());
  assert.equal(prepared.state, 'ready'); assert.equal(prepared.nativeHostName, hostName);
  assert.equal(prepared.extensionId, COLLECTION_EXTENSION_ID); assert.equal(prepared.connectionPrepared, true);
  const nativeManifest = JSON.parse(await readFile(join(connectionDirectory, 'native-host.json'), 'utf8'));
  assert.equal(nativeManifest.name, hostName);
  assert.deepEqual(nativeManifest.allowed_origins, [`chrome-extension://${COLLECTION_EXTENSION_ID}/`]);
  assert.ok(resolve(nativeManifest.path).startsWith(resolve(connectionDirectory) + sep));
  pass('actual desktop settings prepare an isolated native host with fixed extension identity');

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launchPersistentContext(join(root, 'browser'), { executablePath: resolve('.cache/playwright/chromium-1243/chrome-win64/chrome.exe'), headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await browser.route('**/*', route => { const url = new URL(route.request().url()); if (url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:' && url.hostname === COLLECTION_EXTENSION_ID) return route.continue(); blockedRequests.push(url.origin); return route.abort(); });
  fixture = await browser.newPage(); popup = await browser.newPage(); popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`chrome-extension://${COLLECTION_EXTENSION_ID}/popup.html`);
  await popup.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(popup.getByRole('alert')).toContainText('未连接工作台');
  // Uninstall is ownership checked, so clean up even if installation fails after a partial write.
  installed = true; await script('install.ps1');
  await popup.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(popup.locator('#connection')).toHaveText('工作台已连接');
  pass('real Chrome native messaging connects through the generated executable and named pipe after installation');

  await page.getByRole('button', { name: '采集箱', exact: true }).click();
  const preview = await read('multi'); assert.equal(preview.pending.snapshot.skus.length, 2);
  const first = await send(); assert.equal(first.duplicate, false); assert.equal(first.variantCount, 2);
  await expect(page.getByRole('button', { name: '查看采集资料 本地样例 · 多规格收纳盒' })).toBeVisible();
  const detail = await page.evaluate(id => window.red.getProduct(id), first.productId);
  const source = await page.evaluate(id => window.red.getCollectionReceipt(id), first.productId);
  assert.equal(detail.assets.length, 0); assert.equal(detail.variants.length, 2);
  assert.ok(detail.variants.every(v => v.inventory === null));
  const precise = source.skuMappings.find(m => m.providerSkuId === 'sku-blue');
  assert.equal(source.snapshot.skus.find(s => s.providerSkuId === 'sku-blue').purchasePrice, '0.123456789012');
  assert.equal(detail.variants.find(v => v.id === precise.localVariantId).purchasePrice, '');
  assert.equal(source.snapshot.skuImages.length, 2);
  assert.equal(source.snapshot.images.length, 3);
  assert.ok((await page.evaluate(() => window.red.listWorkspacePlacements())).some(p => p.productId === first.productId && p.lane === 'inbox'));
  await page.getByRole('button', { name: '查看采集资料 本地样例 · 多规格收纳盒' }).click();
  await expect(page.getByLabel('采集来源快照')).toContainText('3 条图片链接');
  await page.getByLabel('采集来源快照').locator('summary').click();
  await expect(page.getByLabel('采集来源快照')).toContainText('0.123456789012');
  await page.getByRole('button', { name: '关闭商品详情', exact: true }).click();
  pass('multi-SKU source, exact prices and image mappings reach the actual inbox; remote URLs do not become local assets');

  const again = await send(); assert.equal(again.productId, first.productId);
  await read('multi'); const duplicate = await send(); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.productId, first.productId);
  assert.equal((await page.evaluate(() => window.red.listProducts())).length, 1);
  await page.evaluate(async id => { const p = await window.red.getProduct(id); const { id: productId, revision, status, description, sourceUrl, facts } = p; const variants = p.variants.map(({ sourceSpec, sourcePurchasePrice, ...variant }) => variant); return window.red.saveProduct({ id: productId, revision, status, title: '人工保留的标题', description, sourceUrl, facts, variants }); }, first.productId);
  await read('changed'); const changed = await send(); assert.notEqual(changed.productId, first.productId);
  assert.equal((await page.evaluate(id => window.red.getProduct(id), first.productId)).title, '人工保留的标题');
  assert.equal((await page.evaluate(() => window.red.listProducts())).length, 2);
  pass('same capture and new capture of identical content are idempotent; changed source creates a new product and preserves manual edits');

  await page.getByRole('button', { name: '新建商品', exact: true }).click();
  const titleInput = page.getByRole('textbox', { name: '商品标题', exact: true });
  await titleInput.fill('尚未保存的人工编辑');
  await read('single'); const single = await send(); assert.equal(single.variantCount, 1);
  await expect(titleInput).toHaveValue('尚未保存的人工编辑');
  assert.equal(await page.getByRole('dialog').count(), 0);
  pass('incoming collection refreshes the inbox count without replacing an unsaved editor or switching its workspace');
  // Clear the deliberately unsaved field through the existing save action before restart.
  await page.getByRole('button', { name: '保存修改', exact: true }).click();

  const beforeBad = (await page.evaluate(() => window.red.listProducts())).length;
  for (const request of [{ version: 9, type: 'status', requestId: randomUUID() }, { version: 1, type: 'capture', requestId: randomUUID(), captureId: randomUUID(), snapshot: { source: 'wrong' } }]) {
    const response = await popup.evaluate(({ hostName, request }) => new Promise(resolve => chrome.runtime.sendNativeMessage(hostName, request, response => resolve({ response, error: chrome.runtime.lastError?.message }))), { hostName, request });
    assert.equal(response.error, undefined); assert.equal(response.response.ok, false); assert.equal(response.response.type, 'error');
  }
  assert.equal((await page.evaluate(() => window.red.listProducts())).length, beforeBad);
  await read('partial'); const partial = await send(); assert.equal(partial.variantCount, 0); assert.ok(partial.warnings.includes('MISSING_SKUS'));
  pass('malformed native messages create no product; partial source is explicitly preserved as an incomplete draft');

  await app.close(); app = null;
  await popup.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(popup.getByRole('alert')).toBeVisible();
  await launch();
  assert.equal((await page.evaluate(() => window.red.getCollectionStatus())).state, 'ready');
  await popup.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(popup.locator('#connection')).toHaveText('工作台已连接');
  const resumed = await send(); assert.equal(resumed.productId, partial.productId);
  assert.equal((await page.evaluate(id => window.red.getCollectionReceipt(id), first.productId)).id, source.id);
  pass('application restart rotates its local connection, retains receipts and safely accepts a repeated send');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await selectSettingsModule(page, 'collection');
  for (const [width, height] of [[640, 720], [1366, 900]]) {
    await resizeWindow(app, page, width, height);
    const overflow = await page.evaluate(() => [document.documentElement, document.querySelector('[aria-label="采集插件连接"]')].filter(node => node.scrollWidth > node.clientWidth + 2).length);
    assert.equal(overflow, 0); layouts.push({ width, height, overflow });
  }
  const popupLayout = await popup.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 2, text: getComputedStyle(document.body).fontSize }));
  assert.equal(popupLayout.overflow, false); assert.equal(popupLayout.text, '16px');
  await popup.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await popup.locator('#read').evaluate(button => getComputedStyle(button).transitionDuration), '0s');
  await read('multi');
  await popup.locator('main').evaluate(main => { main.scrollTop = 0; });
  await popup.locator('body').screenshot({ path: resolve(`artifacts/${artifactPrefix}collection-extension.png`) });
  await page.getByLabel('采集插件连接', { exact: true }).scrollIntoViewIfNeeded();
  const capture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(resolve(`artifacts/${artifactPrefix}collection-settings.png`), Buffer.from(capture, 'base64'));
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  assert.equal((await page.evaluate(() => window.red.listAiCalls())).length, 0);
  pass('connection controls fit small and large windows; extension respects reduced motion and no external service is contacted');
  passed = true;
} catch (error) {
  errors.push(error.message); throw error;
} finally {
  const closed = await Promise.allSettled([browser?.close(), app?.close()]);
  for (const result of closed) if (result.status === 'rejected') { errors.push('TEST_PROCESS_CLEANUP_FAILED'); passed = false; }
  if (installed) { try {
    await script('uninstall.ps1');
    const verifyPath = join(root, 'verify-registration-cleanup.ps1');
    await writeFile(verifyPath, `$ErrorActionPreference='Stop'\nforeach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {\n $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)\n try { foreach ($prefix in @('Software\\Google\\Chrome\\NativeMessagingHosts\\','Software\\Microsoft\\Edge\\NativeMessagingHosts\\')) { $key=$base.OpenSubKey($prefix+'${hostName}'); if ($null -ne $key) { $key.Dispose(); throw 'Test registration remains'; } } } finally { $base.Dispose(); }\n}\n`);
    await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', verifyPath], { windowsHide: true, timeout: 10000 });
  } catch (error) { errors.push('TEST_REGISTRATION_CLEANUP_FAILED'); passed = false; console.error(error); } }
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(`artifacts/${artifactPrefix}collection-e2e-report.json`), JSON.stringify({ passed, checks, errors, layouts, executable: process.env.RED_E2E_EXECUTABLE || 'development Electron', isolatedNativeHost: hostName, dataRoot, syntheticOnly: true, externalServices: false, at: new Date().toISOString(), connectionFiles: await readdir(connectionDirectory).catch(() => []) }, null, 2));
  if (!passed && checks.length > 0 && !errors.length) console.error('Collection end-to-end did not complete; see preceding assertion.');
  if (errors.length) process.exitCode = 1;
}
