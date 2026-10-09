import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { resizeWindow } from './e2e-window.mjs';

const root = resolve('.');
await mkdir(resolve('.test-data'), { recursive: true });
await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/workspaces-e2e-'));
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url), executablePath = process.env.RED_E2E_EXECUTABLE || require('electron');
const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], layouts = [], errors = [];
let app, page;
function passed(name) { checks.push(name); console.log(`PASS ${name}`); }
async function launch() {
  app = await electron.launch({ executablePath, args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: root, env, timeout: 35000 });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling = false; });
  await expect(page.getByRole('button', { name: '新建商品', exact: true })).toBeEnabled();
}
async function button(name) { await page.getByRole('button', { name, exact: true }).click(); }
async function nav(name) {
  const target = page.locator('nav').getByRole('button', { name, exact: true });
  await target.click(); await expect(target).toHaveAttribute('aria-current', 'page');
}
async function lane(id) { return page.evaluate(async id => (await window.red.listWorkspacePlacements()).find(row => row.productId === id)?.lane, id); }
async function screenshot(name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  const encoded = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(resolve('artifacts', name), Buffer.from(encoded, 'base64'));
}
async function layout(name) {
  const result = await page.evaluate(() => {
    const selectors = ['.main-content', '.inbox-workspace', '.inbox-panel', '.inbox-dialog', '.inbox-detail-grid', '.automatic-workspace', '.automatic-queue', '.automation-setup', '.results-workspace', '.result-row', '.collection-row', '.workflow-rail'];
    const overflow = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(el => el.clientWidth && el.scrollWidth > el.clientWidth + 2).map(() => selector));
    if (document.documentElement.scrollWidth > innerWidth + 1) overflow.push('document');
    return { width: innerWidth, height: innerHeight, overflow };
  });
  assert.deepEqual(result.overflow, [], name); layouts.push({ name, ...result });
}
try {
  await launch();
  const csv = join(dataRoot, 'collection.csv');
  await writeFile(csv, 'productKey,title,sku,originalSpec,purchasePrice,inventory\r\nA,折叠布艺收纳箱,BOX-GREY,灰色 / 大号,3.4500,20\r\nB,厨房抽屉分隔板,DIVIDER-WHITE,白色 / 4件套,2.3800,40\r\nC,桌面线材收纳夹,CABLE-NAVY,深蓝色 / 6件套,1.0200,60\r\n');
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, csv);
  await button('导入商品');
  await expect(page.locator('.collection-row')).toHaveCount(3);
  const imported = await page.evaluate(() => window.red.listProducts());
  const box = imported.find(p => p.title === '折叠布艺收纳箱'), divider = imported.find(p => p.title === '厨房抽屉分隔板'), cable = imported.find(p => p.title === '桌面线材收纳夹');
  for (const p of imported) assert.equal(await lane(p.id), 'inbox');
  await button(`查看采集资料 ${box.title}`);
  await expect(page.getByRole('dialog', { name: '商品详情' })).toContainText('3.4500');
  await page.getByRole('button', { name: '关闭商品详情', exact: true }).click();
  await page.getByLabel('选择 折叠布艺收纳箱', { exact: true }).check();
  await page.getByLabel('选择 厨房抽屉分隔板', { exact: true }).check();
  await button('加入自动上架');
  await expect.poll(() => lane(box.id)).toBe('automatic');
  await expect.poll(() => lane(divider.id)).toBe('automatic');
  await nav('自动上架');
  await expect(page.locator('.automatic-product')).toHaveCount(2);
  await expect(page.getByTestId(`automatic-${box.id}`)).not.toHaveAttribute('open');
  await expect(page.getByRole('button', { name: '启动并自动发布', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: '全局自动化连接', exact: true })).toContainText('请先完成全局连接配置');
  await expect(page.getByRole('region', { name: '启动自动上架', exact: true })).toContainText('每件商品使用资料和来源图独立判断类目');
  await page.getByTestId(`automatic-${box.id}`).locator('summary').click();
  await expect(page.getByTestId(`automatic-${box.id}`)).toContainText('图片');
  await page.getByTestId(`automatic-${box.id}`).getByRole('button', { name: '转手动补充资料' }).click();
  await expect(page.getByLabel('商品标题', { exact: true })).toHaveValue(box.title);
  assert.equal(await lane(box.id), 'manual');
  passed('真实 CSV 导入采集箱、来源预览、批量分流和自动区能力说明');

  await page.getByLabel('商品标题', { exact: true }).fill('折叠布艺收纳箱 · 已整理');
  await navAttempt('自动上架');
  await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible();
  await button('继续编辑');
  await expect(page.getByLabel('商品标题', { exact: true })).toHaveValue('折叠布艺收纳箱 · 已整理');
  await navAttempt('采集箱'); await button('保存后继续');
  await expect(page.locator('nav').getByRole('button', { name: '采集箱', exact: true })).toHaveAttribute('aria-current', 'page');
  assert.equal((await page.evaluate(id => window.red.getProduct(id), box.id)).title, '折叠布艺收纳箱 · 已整理');
  await page.getByLabel(`选择 ${cable.title}`, { exact: true }).check(); await button('忽略');
  await expect.poll(() => lane(cable.id)).toBe('ignored');
  await page.getByRole('button', { name: /^已忽略/ }).click();
  await page.getByLabel(`选择 ${cable.title}`, { exact: true }).check(); await button('恢复到采集箱');
  await expect.poll(() => lane(cable.id)).toBe('inbox');
  await page.getByRole('button', { name: /^待整理/ }).click();
  await page.getByLabel('搜索采集箱').fill('不存在的名称');
  await expect(page.getByText('没有匹配的商品', { exact: true })).toBeVisible(); await button('清空搜索');
  passed('跨工作区未保存保护、忽略恢复和搜索空状态');

  await button('载入示例商品');
  await expect(page.locator('nav').getByRole('button', { name: '手动上架', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '新建商品', exact: true })).toBeEnabled();
  const all = await page.evaluate(() => window.red.listProducts());
  const bag = all.find(p => p.title === '棉质抽绳收纳袋'); assert.ok(bag);
  const original = await page.evaluate(id => window.red.getProduct(id), bag.id);
  const drafts = await page.evaluate(async id => {
    const product = await window.red.getProduct(id), target = await window.red.enableAmazonDemo();
    const result = [];
    for (const variant of product.variants.slice(0, 2)) result.push(await window.red.createAmazonDraft({ productId: id, variantId: variant.id, targetId: target.id, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' }));
    return result;
  }, bag.id);
  await nav('上架进度');
  await expect(page.locator('.result-row')).toHaveCount(2);
  await expect(page.locator('.workspace-metrics > div').nth(0)).toContainText('0');
  await expect(page.locator('.workspace-metrics > div').nth(1)).toContainText('0');
  await button('正式店铺'); await expect(page.locator('.result-row')).toHaveCount(0);
  await button('本地演示'); await expect(page.locator('.result-row')).toHaveCount(2);
  await page.getByTestId(`result-${drafts[0].id}`).getByRole('button', { name: '手动处理' }).click();
  await expect(page.getByLabel('已保存的上架草稿')).toHaveValue(drafts[0].id);
  await page.locator('.workflow-wide').getByRole('button', { name: /图片上传/ }).click();
  await expect(page.locator('[data-workflow-step="hosting"]')).toBeFocused();
  await page.locator('.workflow-wide').getByRole('button', { name: /校验预览/ }).click();
  await expect(page.locator('[data-workflow-step="validation"]')).toBeFocused();
  await page.getByRole('tab', { name: '商品资料', exact: true }).click();
  await button('移回采集箱');
  await expect.poll(() => lane(bag.id)).toBe('inbox');
  const moved = await page.evaluate(id => window.red.getProduct(id), bag.id);
  assert.deepEqual(moved, original);
  assert.deepEqual((await page.evaluate(id => window.red.listAmazonDrafts(id), bag.id)).map(d => d.id).sort(), drafts.map(d => d.id).sort());
  passed('真实草稿结果、演示分离、准确打开对应 SKU 草稿、流程定位与资料身份保留');

  const otherSample = all.find(p => p.origin === 'sample' && p.id !== bag.id);
  await page.evaluate(id => window.red.moveWorkspaceProducts({ productIds: [id], destination: 'automatic' }), otherSample.id);
  await nav('采集箱'); await button('载入示例商品');
  await expect(page.getByText('示例商品已存在，已保留当前分流位置', { exact: true })).toBeVisible();
  await expect(page.locator('nav').getByRole('button', { name: '采集箱', exact: true })).toHaveAttribute('aria-current', 'page');
  assert.equal(await lane(bag.id), 'inbox'); assert.equal(await lane(otherSample.id), 'automatic');
  passed('重复载入示例尊重已有分流，不在手动区打开其他工作区的商品');

  const beforeRestart = await page.evaluate(() => window.red.listWorkspacePlacements());
  await app.close(); app = undefined; await launch();
  assert.deepEqual(await page.evaluate(() => window.red.listWorkspacePlacements()), beforeRestart);
  assert.deepEqual(await page.evaluate(id => window.red.getProduct(id), bag.id), original);
  passed('重启后分流、来源和图片关系完整恢复');

  for (const [width, height] of [[1920, 1080], [1480, 960], [1280, 800], [1100, 760], [900, 680], [760, 620], [640, 560]]) {
    await resizeWindow(app, page, width, height);
    await nav('采集箱');
    await button(`查看采集资料 ${bag.title}`);
    await expect(page.locator('.inbox-gallery-hero img').first()).toBeVisible();
    await layout(`采集箱预览 ${width}`);
    await page.getByRole('button', { name: '关闭商品详情', exact: true }).click();
    await page.getByLabel(`选择 ${cable.title}`, { exact: true }).check();
    const action = page.getByRole('button', { name: '加入自动上架', exact: true });
    await action.scrollIntoViewIfNeeded(); await expect(action).toBeInViewport({ ratio: .95 });
    await layout(`采集箱批量操作 ${width}`);
    await page.locator('.main-content').evaluate(el => { el.scrollTop = 0; });
    if (width === 1480 || width === 640) await screenshot(`htc-inbox-${width}.png`);
    await nav('自动上架'); await layout(`自动上架 ${width}`);
    await page.getByTestId(`automatic-${divider.id}`).locator('summary').click();
    await layout(`自动商品展开 ${width}`);
    await page.getByRole('button', { name: '转手动补充资料', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: '转手动补充资料', exact: true })).toBeInViewport({ ratio: .95 });
    await page.locator('.main-content').evaluate(el => { el.scrollTop = 0; });
    if (width === 1480 || width === 640) await screenshot(`htc-automatic-${width}.png`);
    await nav('上架进度'); await layout(`上架结果 ${width}`);
    if (width === 1480 || width === 640) await screenshot(`htc-results-${width}.png`);
    console.log(`PASS 新增工作区布局 ${width}×${height}`);
  }
  await nav('自动上架');
  const disclosure = page.getByTestId(`automatic-${divider.id}`);
  await disclosure.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('open');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.inputMode), 'keyboard');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motion = await disclosure.locator('summary').evaluate(el => ({ transition: getComputedStyle(el).transitionDuration, animation: getComputedStyle(el).animationName }));
  assert.ok(motion.transition.split(',').every(value => parseFloat(value) === 0)); assert.equal(motion.animation, 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await resizeWindow(app, page, 1480, 960); await nav('手动上架');
  await page.getByTestId(`product-${box.id}`).click();
  await screenshot('htc-manual-1480.png');
  passed('七种窗口布局、窄屏操作可达、键盘展开与减少动效');
  assert.deepEqual(errors, []); passed('无 renderer 运行或资源加载错误');
  await writeFile(resolve('artifacts/workspaces-e2e-report.json'), JSON.stringify({ passed: true, checks, layouts, errors, dataRoot, executablePath, at: new Date().toISOString() }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await screenshot('workspaces-e2e-failure.png').catch(() => {});
  await writeFile(resolve('artifacts/workspaces-e2e-report.json'), JSON.stringify({ passed: false, checks, layouts, errors, dataRoot, executablePath, failure: String(error), at: new Date().toISOString() }, null, 2));
  console.error(error); process.exitCode = 1;
} finally { if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {}); await app.close().catch(() => {}); } }

async function navAttempt(name) { await page.locator('nav').getByRole('button', { name, exact: true }).click(); }
