import { electron } from './e2e-core-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { publicApi } from './api-surface.mjs';
import { resizeWindow } from './e2e-window.mjs';

const root = resolve('.');
const appVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
await mkdir(resolve('.test-data'), { recursive: true }); await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/e2e-'));
const fixtures = join(dataRoot, 'fixtures'); await mkdir(fixtures);
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url);
const executablePath = process.env.RED_E2E_EXECUTABLE || require('electron');
const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], processLog = [], layouts = [];
let app, page;
function passed(name) { checks.push(name); console.log(`PASS ${name}`); }
function png(rgb) {
  const width = 96, height = 96, raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const n = y * (width * 4 + 1) + 1 + x * 4;
    raw[n] = rgb[0]; raw[n + 1] = rgb[1]; raw[n + 2] = rgb[2]; raw[n + 3] = 255;
  }
  function chunk(name, bytes) {
    const body = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function launch() {
  app = await electron.launch({ executablePath, args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: root, env, timeout: 35000 });
  app.process().stderr.on('data', chunk => { const line = chunk.toString(); processLog.push(line); if (/HTC startup:/.test(line)) console.error(line); });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // Hidden Windows test windows otherwise suspend compositor frames after a relaunch.
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling = false; });
  if (process.env.RED_E2E_DEBUG) console.log('Electron state:', await app.evaluate(({ app, BrowserWindow }) => ({ path: app.getAppPath(), windows: BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL(), loading: w.webContents.isLoading() })) })));
  await page.waitForFunction(() => !!window.red && document.querySelector('button'), null, { timeout: 20000 });
  await expect(page.getByRole('button', { name: '新建商品', exact: true }).first()).toBeEnabled();
}
async function tab(name, waitForSelected = true) {
  const target = page.getByRole('tab', { name, exact: false });
  await target.click(); if (waitForSelected) await expect(target).toHaveAttribute('aria-selected', 'true');
}
async function product(id) { return page.evaluate(id => window.red.getProduct(id), id); }
async function verifyLayout(name) {
  const result = await page.evaluate(() => {
    const selectors = ['.main-content', '.workbench-layout', '.product-editor', '.editor-content', '.variant-table-wrap', '.asset-workspace', '.asset-inspector', '.utility-panel', '.settings-values'];
    const overflow = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.scrollWidth > element.clientWidth + 2).map(() => selector));
    if (document.documentElement.scrollWidth > innerWidth) overflow.push('document');
    const workspace = document.querySelector('.main-content').getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, overflow, workspaceRight: workspace.right, workspaceBottom: workspace.bottom };
  });
  assert.deepEqual(result.overflow, [], `${name}: unexpected horizontal overflow`);
  assert.ok(result.workspaceRight <= result.width + 1 && result.workspaceBottom <= result.height + 1, `${name}: workspace must fit the window`);
  layouts.push({ name, ...result });
}
async function screenshot(name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const transitions = document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.all(transitions.map(animation => animation.finished.catch(() => {})));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(null))));
  });
  const encoded = await app.evaluate(async ({ BrowserWindow }) => {
    const captured = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (captured.isEmpty()) throw new Error('Electron returned an empty screenshot');
    return captured.toPNG().toString('base64');
  });
  await writeFile(resolve('artifacts', name), Buffer.from(encoded, 'base64'));
}
try {
  await launch();
  await expect(page).toHaveTitle(`HTC v${appVersion} · 独立上架工作台`);
  await verifyLayout('空商品库');
  const security = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, keys: Object.keys(window.red) }));
  assert.equal(security.require, 'undefined'); assert.equal(security.process, 'undefined');
  assert.deepEqual(security.keys.sort(), [...publicApi].sort());
  const preferences = await app.evaluate(({ BrowserWindow }) => { const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return { sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation }; });
  assert.deepEqual(preferences, { sandbox: true, nodeIntegration: false, contextIsolation: true });
  passed('真实 Electron 启动与 renderer 隔离');
  await page.getByRole('button', { name: '载入示例商品', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.red.listProducts().then(rows => rows.length))).toBe(2);
  const examples = await page.evaluate(() => window.red.listProducts());
  const bag = examples.find(p => p.title === '棉质抽绳收纳袋'); assert.ok(bag);
  await page.getByTestId(`product-${bag.id}`).click();
  await tab('图片工作区');
  await expect(page.locator('.asset-card')).toHaveCount(3);
  await expect.poll(() => page.locator('.asset-card img').evaluateAll(imgs => imgs.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
  await screenshot('workbench-images.png');
  await tab('SKU 与规格'); await screenshot('workbench-skus.png');
  passed('显式载入示例、真实图片解码与预览协议');

  await page.getByRole('button', { name: '新建商品', exact: true }).first().click();
  await page.getByLabel('商品标题', { exact: true }).fill('联调验收收纳袋');
  await page.getByLabel('来源链接', { exact: true }).fill('https://detail.1688.com/offer/123.html');
  await tab('SKU 与规格', false);
  await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByLabel('商品标题', { exact: true })).toHaveValue('联调验收收纳袋');
  await tab('SKU 与规格', false); await page.getByRole('button', { name: '保存后继续', exact: true }).click();
  await page.getByLabel('SKU 1', { exact: true }).fill('E2E-WHITE');
  await page.getByLabel('原始规格 1', { exact: true }).fill('白色 / 大号');
  await page.getByLabel('整理后规格 1', { exact: true }).fill('White / Large');
  await page.getByLabel('采购价 1', { exact: true }).fill('0.0350');
  await page.getByLabel('库存 1', { exact: true }).fill('0');
  await page.getByRole('button', { name: '添加 SKU', exact: true }).click();
  await page.getByLabel('SKU 2', { exact: true }).fill('E2E-BLUE');
  await page.getByLabel('原始规格 2', { exact: true }).fill('蓝色 / 小号');
  await page.getByLabel('采购价 2', { exact: true }).fill('1.20');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  const target = (await page.evaluate(() => window.red.listProducts())).find(p => p.title === '联调验收收纳袋'); assert.ok(target);
  await expect.poll(async () => (await product(target.id)).variants.length).toBe(2);
  let saved = await product(target.id);
  assert.equal(saved.variants[0].purchasePrice, '0.0350'); assert.equal(saved.variants[0].inventory, 0);
  const stableIds = saved.variants.map(v => v.id);
  passed('界面新建、多 SKU 编辑、精确价格保存与未保存保护');

  const white = join(fixtures, 'white.png'), blue = join(fixtures, 'blue.png');
  await writeFile(white, png([232, 228, 214])); await writeFile(blue, png([111, 151, 181]));
  await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [white, blue]);
  await tab('图片工作区'); await page.getByRole('button', { name: '导入图片', exact: true }).click();
  await expect(page.locator('.asset-card')).toHaveCount(2);
  await page.getByRole('checkbox', { name: '关联 SKU E2E-WHITE', exact: true }).click();
  await expect.poll(async () => (await product(target.id)).assets[0].variantIds.length).toBe(1);
  await expect(page.getByRole('checkbox', { name: '关联 SKU E2E-WHITE', exact: true })).toBeChecked();
  await page.locator('.asset-card').filter({ hasText: 'blue.png' }).click();
  await page.getByRole('checkbox', { name: '关联 SKU E2E-BLUE', exact: true }).click();
  await expect.poll(async () => (await product(target.id)).assets[1].variantIds.length).toBe(1);
  await expect(page.getByRole('checkbox', { name: '关联 SKU E2E-BLUE', exact: true })).toBeChecked();
  await page.getByLabel('图片用途', { exact: true }).selectOption('main');
  await expect.poll(async () => (await product(target.id)).assets[1].role).toBe('main');
  await page.getByRole('checkbox', { name: '关联 SKU E2E-BLUE', exact: true }).click();
  await expect.poll(async () => (await product(target.id)).assets[1].variantIds.length).toBe(0);
  await expect(page.getByRole('checkbox', { name: '关联 SKU E2E-BLUE', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: '关联 SKU E2E-BLUE', exact: true }).click();
  await expect.poll(async () => (await product(target.id)).assets[1].variantIds.length).toBe(1);
  await expect(page.getByRole('checkbox', { name: '关联 SKU E2E-BLUE', exact: true })).toBeChecked();
  saved = await product(target.id);
  assert.equal(saved.assets.filter(a => a.role === 'main').length, 1);
  assert.deepEqual(saved.variants.map(v => v.id), stableIds);
  const importedWhite = await readFile(join(dataRoot, 'assets', `${saved.assets[0].id}.png`));
  assert.deepEqual(importedWhite, await readFile(white));
  passed('本地图片导入、原图字节保留、主图切换与 SKU 关联/解除');

  await tab('上架检查'); await page.getByRole('button', { name: '运行本地检查', exact: true }).click();
  const check = await page.evaluate(id => window.red.checkProduct(id), target.id);
  assert.equal(check.mode, 'local'); assert.equal(check.amazonConnected, false);
  passed('本地检查与 Amazon 未连接状态准确区分');
  const exported = join(fixtures, 'export.red.json');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, exported);
  await page.getByRole('button', { name: '导出资料', exact: true }).click();
  await expect.poll(async () => { try { return JSON.parse(await readFile(exported, 'utf8')).products[0].title; } catch { return null; } }).toBe(saved.title);
  const csv = join(fixtures, 'import.csv'); await writeFile(csv, 'productKey,title,sku,originalSpec,purchasePrice,inventory\r\nA,CSV 导入商品,CSV-TEST,黑色,0.1234,5\r\n');
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, csv);
  await page.getByRole('button', { name: '导入商品', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.red.listProducts().then(rows => rows.some(p => p.title === 'CSV 导入商品')))).toBe(true);
  passed('实际桌面 API 的 JSON 导出与 CSV 导入');
  const countBeforeDuplicate = await page.evaluate(() => window.red.listProducts().then(rows => rows.length));
  await page.getByRole('button', { name: '导入商品', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('SKU 已存在');
  assert.equal(await page.evaluate(() => window.red.listProducts().then(rows => rows.length)), countBeforeDuplicate);
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
  passed('重复 SKU 的具体错误提示与导入回滚');
  saved = await product(target.id);
  await app.close(); app = undefined;
  await launch();
  assert.deepEqual(await product(target.id), saved);
  await page.getByRole('button', { name: '手动上架', exact: true }).click();
  await page.getByTestId(`product-${target.id}`).click(); await tab('图片工作区');
  await expect(page.locator('.asset-card')).toHaveCount(2);
  await expect.poll(() => page.locator('.asset-card img').evaluateAll(imgs => imgs.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
  passed('关闭并重新启动 Electron 后商品与图片关系完整恢复');
  await page.getByTestId(`product-${bag.id}`).click(); await tab('商品资料');
  await screenshot('workbench-product.png');
  for (const [width, height] of [[1920, 1080], [1480, 960], [1280, 800], [1100, 760], [900, 680], [760, 620], [640, 560]]) {
    await resizeWindow(app, page, width, height);
    await page.getByRole('button', { name: '手动上架', exact: true }).click();
    for (const name of ['商品资料', 'SKU 与规格', '图片工作区', '上架检查']) {
      await tab(name);
      await verifyLayout(`${width}×${height} / ${name}`);
      if (name === '上架检查') {
        await page.getByRole('button', { name: /运行本地检查|重新检查/ }).click();
        await expect(page.locator('.check-list')).toBeVisible();
        await verifyLayout(`${width}×${height} / 检查结果`);
      }
      if ((width === 640 || width === 1280) && name === 'SKU 与规格') await screenshot(`workbench-skus-${width}.png`);
      if (width === 900 && name === '图片工作区') await screenshot('workbench-images-compact.png');
    }
    for (const [nav, ready] of [['操作记录', '.audit-table'], ['设置', '.settings-panel']]) {
      await page.getByRole('button', { name: nav, exact: true }).click();
      await expect(page.locator(ready)).toBeVisible();
      await verifyLayout(`${width}×${height} / ${nav}`);
      if (width === 640 || width === 1480) await screenshot(`workbench-${nav === '设置' ? 'settings' : 'audit'}-${width}.png`);
    }
    console.log(`PASS 各页面布局 ${width}×${height}`);
  }
  await page.getByRole('button', { name: '手动上架', exact: true }).click(); await tab('SKU 与规格');
  const lastSpec = page.getByLabel('原始规格 3', { exact: true });
  const originalSpec = await lastSpec.inputValue();
  await lastSpec.scrollIntoViewIfNeeded();
  await lastSpec.fill('调整窗口后仍保留的草稿');
  await expect(lastSpec).toBeInViewport({ ratio: .95 });
  await resizeWindow(app, page, 1480, 960);
  await expect(lastSpec).toHaveValue('调整窗口后仍保留的草稿');
  assert.ok(await lastSpec.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 13);
  await lastSpec.fill(originalSpec);
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  await resizeWindow(app, page, 640, 560);
  await tab('图片工作区');
  const lastLink = page.getByRole('checkbox').last();
  await lastLink.scrollIntoViewIfNeeded();
  await expect(lastLink).toBeInViewport({ ratio: 1 });
  const wasLinked = await lastLink.isChecked();
  await lastLink.click(); await expect(lastLink).toBeChecked({ checked: !wasLinked }); await expect(lastLink).toBeEnabled();
  await lastLink.click(); await expect(lastLink).toBeChecked({ checked: wasLinked }); await expect(lastLink).toBeEnabled();
  await screenshot('workbench-image-links-640.png');
  passed('7 种窗口尺寸的全部页面布局、控件可达与缩放期间草稿保留');
  assert.deepEqual(errors, []); passed('无 renderer 运行错误或资源加载错误');
  await writeFile(resolve('artifacts/e2e-report.json'), JSON.stringify({ passed: true, checks, layouts, errors, dataRoot, executablePath, at: new Date().toISOString() }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await screenshot('e2e-failure.png').catch(() => {});
  await writeFile(resolve('artifacts/e2e-report.json'), JSON.stringify({ passed: false, checks, layouts, errors, processLog, dataRoot, executablePath, pageUrl: page?.url(), failure: String(error), at: new Date().toISOString() }, null, 2));
  console.error(error); process.exitCode = 1;
} finally { if (app) await app.close().catch(() => {}); }
