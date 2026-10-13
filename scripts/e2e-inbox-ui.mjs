import { electron } from './e2e-core-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resizeWindow } from './e2e-window.mjs';

await mkdir(resolve('.test-data'), { recursive: true }); await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/inbox-ui-'));
const expectedVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url), env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app, page, passed = false;
const errors = [], checks = [];
const check = text => { checks.push(text); console.log(`PASS ${text}`); };
const button = name => page.getByRole('button', { name, exact: true });
async function nav(name) { await page.locator('nav').getByRole('button', { name, exact: true }).click(); }
async function launch() {
  app = await electron.launch({ executablePath: process.env.RED_E2E_EXECUTABLE || require('electron'), args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: resolve('.'), env, timeout: 35000 });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling = false; });
  await expect(button('同步妙手采集箱')).toBeVisible({ timeout: 6000 });
  assert.equal((await page.evaluate(() => window.red.getSettings())).appVersion, expectedVersion);
}
async function screenshot(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(resolve('artifacts', name), Buffer.from(data, 'base64'));
}
try {
  await launch();
  assert.deepEqual(await page.evaluate(() => window.red.getMiaoshouPreferences()), { autoSyncOnInbox: true });
  await nav('设置');
  // Settings uses a module navigator; choose Miaoshou if its section is not initially visible.
  if (!(await page.getByLabel('妙手采集设置').isVisible())) await button('采集连接').click();
  await button('启用妙手演示模式').click();
  await expect(page.getByLabel('进入采集箱时自动检查并导入')).toBeChecked();
  await page.getByLabel('进入采集箱时自动检查并导入').uncheck();
  await expect.poll(() => page.evaluate(() => window.red.getMiaoshouPreferences().then(p => p.autoSyncOnInbox))).toBe(false);
  await nav('采集箱'); await expect(page.locator('.collection-row')).toHaveCount(0);
  await button('同步妙手采集箱').click();
  await expect(page.locator('.collection-row')).toHaveCount(3, { timeout: 15000 });
  check('默认开启自动同步；明确关闭后手动一次同步导入全部演示商品');
  const original = await page.evaluate(() => window.red.listProducts());
  await button('同步妙手采集箱').click();
  await expect.poll(() => page.evaluate(() => window.red.getMiaoshouSyncStatus().then(state => state.status))).toBe('completed');
  assert.deepEqual((await page.evaluate(() => window.red.listProducts())).map(p => p.id).sort(), original.map(p => p.id).sort());
  check('再次同步不重复创建商品');
  const tray = original.find(p => p.title.includes('桌面收纳托盘'));
  assert.ok(tray);
  const row = page.getByTestId(`inbox-${tray.id}`);
  await expect(row.locator('img')).toBeVisible({ timeout: 15000 });
  assert.equal(await row.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true);
  for (const label of ['价格', '尺寸', '重量']) await expect(page.getByRole('columnheader', { name: label, exact: true })).toBeVisible();
  await expect(row).toContainText('6.50');
  await expect(page.locator('.inbox-workspace')).not.toContainText('币种与口径待确认');
  await resizeWindow(app, page, 1440, 950); await screenshot('inbox-ui-wide.png');
  await page.getByLabel(`选择 ${tray.title}`, { exact: true }).check();
  const before = await page.locator('.main-content').evaluate(el => ({ height: el.scrollHeight, scroll: el.scrollTop }));
  await button(`查看采集资料 ${tray.title}`).click();
  await expect(page.getByRole('dialog', { name: '商品详情', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '商品详情' }).locator('img').first()).toBeVisible();
  const after = await page.locator('.main-content').evaluate(el => ({ height: el.scrollHeight, scroll: el.scrollTop }));
  assert.deepEqual(after, before);
  await screenshot('inbox-ui-detail.png'); await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '商品详情' })).toHaveCount(0);
  await expect(page.getByLabel(`选择 ${tray.title}`, { exact: true })).toBeChecked();
  await expect(button(`查看采集资料 ${tray.title}`)).toBeFocused();
  check('缩略图、价格尺寸重量列、覆盖式详情、关闭后选择与页面位置保留');
  await nav('设置');
  if (!(await page.getByLabel('妙手采集设置').isVisible())) await button('采集连接').click();
  await page.getByLabel('进入采集箱时自动检查并导入').check();
  await expect.poll(() => page.evaluate(() => window.red.getMiaoshouPreferences().then(p => p.autoSyncOnInbox))).toBe(true);
  await screenshot('inbox-ui-settings.png');
  const previous = await page.evaluate(() => window.red.getMiaoshouSyncStatus().then(s => s.updatedAt));
  await nav('采集箱');
  await expect.poll(() => page.evaluate(() => window.red.getMiaoshouSyncStatus().then(s => s.updatedAt))).not.toBe(previous);
  await expect.poll(() => page.evaluate(() => window.red.getMiaoshouSyncStatus().then(s => s.status))).toBe('completed');
  check('设置开关开启后进入采集箱自动检查');
  await app.close(); app = null; await launch();
  assert.equal((await page.evaluate(() => window.red.getMiaoshouPreferences())).autoSyncOnInbox, true);
  await expect(page.locator('.collection-row')).toHaveCount(3);
  await resizeWindow(app, page, 1060, 760);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await screenshot('inbox-ui-compact.png');
  check('重启保留开关及商品，紧凑窗口不产生整页横向溢出');
  await expect.poll(() => page.evaluate(() => window.red.getMiaoshouSyncStatus().then(s => s.status))).toBe('completed');
  await nav('设置'); await button('采集连接').click();
  await page.getByLabel('进入采集箱时自动检查并导入').uncheck();
  await expect.poll(() => page.evaluate(() => window.red.getMiaoshouPreferences().then(p => p.autoSyncOnInbox))).toBe(false);
  const stopped = await page.evaluate(() => window.red.getMiaoshouSyncStatus());
  await nav('采集箱'); await expect(page.locator('.inbox-sync-bar')).toContainText('自动检查已关闭');
  assert.deepEqual(await page.evaluate(() => window.red.getMiaoshouSyncStatus()), stopped);
  check('关闭开关后再次进入采集箱不启动检查');

  // Change only the isolated test workspace cache, as if a newer source snapshot arrived.
  const originalDetail = await page.evaluate(id => window.red.getProduct(id), tray.id);
  const originalReceipt = await page.evaluate(id => window.red.getMiaoshouReceipt(id), tray.id);
  const db = new DatabaseSync(resolve(dataRoot, 'red.sqlite'));
  try {
    const cached = db.prepare("SELECT id,record_json FROM miaoshou_sync_items WHERE json_extract(record_json,'$.remoteId')=?").get(originalReceipt.snapshot.remoteId);
    const item = JSON.parse(cached.record_json);
    item.snapshot.title = '来源更新后的托盘'; item.snapshot.detailText = '只读来源更新验收';
    item.snapshot.images[0].url = 'https://example.com/e2e-latest-image.png';
    item.snapshot.images[0].id = `ms_${createHash('sha256').update(item.snapshot.images[0].url).digest('hex').slice(0, 32)}`;
    db.prepare('UPDATE miaoshou_sync_items SET record_json=? WHERE id=?').run(JSON.stringify(item), cached.id);
  } finally { db.close(); }
  await nav('手动上架'); await nav('采集箱');
  await expect(page.getByTestId(`inbox-${tray.id}`)).toContainText('来源有更新');
  await button(`查看采集资料 ${tray.title}`).click(); await button('查看来源新版本').click();
  const detail = page.getByRole('dialog', { name: '商品详情' });
  await expect(detail.getByRole('heading', { name: '来源更新后的托盘', exact: true })).toBeVisible();
  await expect(detail).toContainText('只读来源更新验收');
  await expect.poll(() => detail.locator('.inbox-gallery-hero img').evaluateAll(images => images.length === 1 && images[0].complete && images[0].naturalWidth > 0)).toBe(true);
  await expect(button('加入手动并打开')).toHaveCount(0);
  await screenshot('inbox-ui-source-update.png');
  await button('返回入箱资料').click(); await expect(detail.getByRole('heading', { name: tray.title, exact: true })).toBeVisible();
  assert.deepEqual(await page.evaluate(id => window.red.getProduct(id), tray.id), originalDetail);
  assert.deepEqual(await page.evaluate(id => window.red.getMiaoshouReceipt(id), tray.id), originalReceipt);
  await page.keyboard.press('Escape');
  check('来源新版本可查看标题、参数和图片；切回及关闭均不覆盖入箱资料');

  await page.evaluate(async () => {
    const ids = [];
    for (let index = 0; index < 36; index++) {
      const p = await window.red.createProduct();
      await window.red.saveProduct({ id: p.id, revision: p.revision, title: `布局验收商品 ${String(index).padStart(2, '0')}`, sourceUrl: '', description: '', status: p.status, facts: p.facts,
        variants: p.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })) });
      ids.push(p.id);
    }
    await window.red.moveWorkspaceProducts({ productIds: ids, destination: 'inbox' });
  });
  // A fresh renderer loads the changed data without bypassing the page's state logic.
  await page.reload(); await expect(button('同步妙手采集箱')).toBeVisible();
  await page.getByLabel('搜索采集箱').fill('布局验收');
  await button('采集箱下一页').click();
  await expect(page.getByLabel('采集箱分页')).toContainText('第 2 / 2 页');
  const last = page.locator('.collection-row').last(), opener = last.locator('.inbox-title-button');
  await last.getByRole('checkbox').check(); await opener.scrollIntoViewIfNeeded();
  const scrollBefore = await page.locator('.inbox-table-viewport').evaluate(el => el.scrollTop);
  assert.ok(scrollBefore > 0);
  await opener.click(); await expect(detail).toBeVisible(); await page.keyboard.press('Escape');
  await expect(opener).toBeFocused(); await expect(last.getByRole('checkbox')).toBeChecked();
  await expect(page.getByLabel('搜索采集箱')).toHaveValue('布局验收');
  await expect(page.getByLabel('采集箱分页')).toContainText('第 2 / 2 页');
  assert.equal(await page.locator('.inbox-table-viewport').evaluate(el => el.scrollTop), scrollBefore);
  check('第二页打开详情再关闭后，搜索、分页、勾选、焦点及非零滚动位置全部保留');
  assert.deepEqual(errors, []); passed = true;
} catch (error) { errors.push(error.message); throw error; }
finally {
  await app?.close();
  await writeFile(resolve(`artifacts/${process.env.RED_E2E_EXECUTABLE ? 'packaged-' : ''}inbox-ui-e2e.json`), JSON.stringify({ passed, checks, errors, dataRoot, at: new Date().toISOString() }, null, 2));
}
