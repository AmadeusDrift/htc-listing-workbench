import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { resizeWindow } from './e2e-window.mjs';

await mkdir(resolve('.test-data'), { recursive: true });
await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/miaoshou-e2e-'));
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url);
const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let app, page, completed = false;
const errors = [], checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
async function launch() {
  app = await electron.launch({ executablePath: process.env.RED_E2E_EXECUTABLE || require('electron'), args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: resolve('.'), env, timeout: 35000 });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling = false; });
  await expect(page.getByRole('button', { name: '新建商品', exact: true })).toBeEnabled();
}
const button = name => page.getByRole('button', { name, exact: true });
async function screenshot(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(resolve('artifacts', name), Buffer.from(data, 'base64'));
}
async function nav(name) { await page.locator('nav').getByRole('button', { name, exact: true }).click(); }
const product = id => page.evaluate(id => window.red.getProduct(id), id);
try {
  await launch();
  await nav('设置'); await button('采集连接').click(); await button('启用妙手演示模式').click();
  await expect(page.getByLabel('妙手采集设置')).toContainText('已切换到演示模式');
  // Explicit mapping remains tested through real IPC; normal UI now uses one-click import.
  const imported = await page.evaluate(async () => {
    const listed = await window.red.listMiaoshouProducts({ pageNo: 1, pageSize: 20 }), results = [];
    for (const item of listed.items) {
      const preview = await window.red.previewMiaoshouProduct({ id: item.id });
      const bag = item.id === 'demo-colors', pack = item.id === 'demo-pack';
      const colors = { 'bag-01': ['tone-a', 'fit-a'], 'bag-02': ['tone-b', 'fit-a'], 'bag-03': ['tone-a', 'fit-b'], 'bag-04': ['tone-b', 'fit-b'] };
      const mapping = { priceField: bag ? 'price' : pack ? 'oriPrice' : 'none', currency: bag || pack ? 'CNY' : 'unknown', skus: preview.product.skus.map(sku => ({ sourceKey: sku.key, dimensions: bag ? { color: colors[sku.key][0], size: colors[sku.key][1] } : pack ? { color: 'tone-neutral', size: 'opening-standard', third: sku.key === 'clip-bundle-x' ? 'pack-three' : 'pack-six' } : {} })) };
      const added = await window.red.importMiaoshouProduct({ previewId: preview.previewId, mapping });
      const again = await window.red.importMiaoshouProduct({ previewId: preview.previewId, mapping });
      results.push({ added, again });
    }
    return results;
  });
  assert.ok(imported.every(row => !row.added.duplicate && row.again.duplicate));
  const all = await page.evaluate(() => window.red.listProducts());
  const tray = all.find(p => p.title.includes('桌面收纳托盘')), bag = all.find(p => p.title.includes('旅行收纳袋')), pack = all.find(p => p.title.includes('理线夹'));
  assert.ok(tray && bag && pack);
  assert.equal((await product(tray.id)).variants[0].purchasePrice, '');
  assert.ok((await product(bag.id)).variants.every(v => v.inventory === null && v.purchasePrice && !v.originalSpec.includes('待核对')));
  assert.deepEqual((await product(pack.id)).variants.map(v => v.purchasePrice).sort(), ['1.90', '3.10']);
  pass('真实 IPC 的逐 SKU 映射、价格字段、去重和供应商库存隔离仍然有效');
  const download = () => page.evaluate(async id => { const p = await window.red.getProduct(id), receipt = await window.red.getMiaoshouReceipt(id); return window.red.downloadMiaoshouImages({ productId: id, revision: p.revision, imageIds: receipt.snapshot.images.map(image => image.id) }); }, bag.id);
  const first = await download(); assert.equal(first.downloaded, 3); assert.ok(first.product.assets.some(asset => asset.variantIds.length === 2));
  const repeated = await download(); assert.equal(repeated.existing, 3); assert.equal(repeated.downloaded, 0);
  await page.reload(); await expect(page.getByRole('button', { name: '新建商品', exact: true })).toBeEnabled();
  await nav('采集箱'); await expect(page.locator('.collection-row')).toHaveCount(3);
  await button(`查看采集资料 ${bag.title}`).click(); await expect(page.getByRole('dialog', { name: '商品详情' })).toBeVisible();
  await screenshot('miaoshou-source-images.png');
  await button('加入手动并打开').click(); await expect(page.getByLabel('商品标题', { exact: true })).toHaveValue(bag.title);
  await page.getByLabel('商品标题', { exact: true }).fill('人工整理后的妙手收纳袋'); await nav('采集箱'); await button('保存后继续').click();
  await button('同步妙手采集箱').click();
  await expect.poll(() => page.evaluate(() => window.red.getMiaoshouSyncStatus().then(s => s.status))).toBe('completed');
  assert.equal((await product(bag.id)).title, '人工整理后的妙手收纳袋'); assert.equal((await page.evaluate(() => window.red.listProducts())).length, 3);
  pass('图片入库保留 SKU 对应；再次同步保留人工编辑及已分流商品');
  await nav('设置'); await button('采集连接').click();
  const template = join(dataRoot, 'miaoshou-config-template.json');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, template);
  await button('保存妙手配置模板').click();
  await expect(page.getByLabel('妙手采集设置')).toContainText('配置模板已保存');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(template, 'utf8'))).sort(), ['appKey', 'appSecret']);
  const config = join(dataRoot, 'dummy-config.json');
  await writeFile(config, '{"appSecret":"INVALID_JSON_SECRET');
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, config);
  await button('导入妙手配置').click();
  await expect(page.getByLabel('妙手采集设置').getByRole('alert')).toContainText('不是有效的 UTF-8 JSON');
  await expect(page.getByLabel('妙手采集设置')).not.toContainText('INVALID_JSON_SECRET');
  await writeFile(config, JSON.stringify({ appKey: 'DUMMY_E2E_APP_KEY_012345', appSecret: 'DUMMY_E2E_SECRET_NO_NETWORK' }));
  await button('导入妙手配置').click();
  await expect(page.getByLabel('妙手采集设置')).toContainText('配置已加密保存');
  assert.equal((await page.evaluate(() => window.red.getMiaoshouStatus())).mode, 'live');
  assert.equal((await readFile(join(dataRoot, 'miaoshou-vault/credentials.bin'))).includes('DUMMY_E2E_SECRET_NO_NETWORK'), false);
  await button('启用妙手演示模式').click();
  await expect(page.getByLabel('妙手采集设置')).toContainText('已切换到演示模式');
  pass('配置模板导出、原生文件导入与系统加密保存、演示/真实模式切换，无真实网络请求');
  await app.close(); app = null; await launch();
  assert.equal((await page.evaluate(() => window.red.getMiaoshouStatus())).mode, 'demo');
  assert.equal((await product(bag.id)).assets.length, 3);
  assert.equal((await product(bag.id)).title, '人工整理后的妙手收纳袋');
  await nav('设置'); await button('采集连接').click(); await button('断开妙手配置').click();
  await expect(page.getByLabel('妙手采集设置')).toContainText('妙手配置已断开');
  assert.equal((await page.evaluate(() => window.red.listProducts())).length, 3);
  pass('重启保留模式、商品和图片；断开配置仍保留已采集资料');
  assert.deepEqual(errors, []);
  completed = true;
} catch (error) { errors.push(error.message); throw error; }
finally {
  await app?.close();
  await writeFile(resolve(`artifacts/${process.env.RED_E2E_EXECUTABLE ? 'packaged-' : ''}miaoshou-e2e.json`), JSON.stringify({ passed: completed && errors.length === 0, checks, errors, dataRoot, executable: process.env.RED_E2E_EXECUTABLE || 'development Electron', at: new Date().toISOString() }, null, 2));
}
