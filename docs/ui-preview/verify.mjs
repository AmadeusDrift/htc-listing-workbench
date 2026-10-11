import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const externalRequests = [];
page.on('pageerror', error => errors.push(error.message));
await page.route(/^https?:/, route => { externalRequests.push(route.request().url()); return route.abort(); });
const output = new URL('../../artifacts/ui-preview-v1/', import.meta.url);
await mkdir(output, { recursive: true });
const { fileURLToPath } = await import('node:url');
try {
  await page.goto(new URL('./index.html', import.meta.url).href);
  assert.equal(await page.locator('.product').count(), 8);
  assert.equal(await page.locator('.details').count(), 0);
  await page.screenshot({ path: fileURLToPath(new URL('desktop.png', output)), fullPage: true });
  await page.getByRole('button', { name: '展开全部', exact: true }).click();
  assert.equal(await page.locator('.details tbody tr').count(), 20);
  await page.getByRole('button', { name: '收起全部', exact: true }).click();
  await page.getByRole('button', { name: '查看待处理', exact: true }).click();
  assert.equal(await page.locator('.product').count(), 3);
  await page.getByRole('tab', { name: '已提交与完成 5' }).click();
  assert.equal(await page.locator('.product').count(), 5);
  await page.getByRole('tab', { name: '全部商品 8' }).click();
  await page.getByRole('searchbox').fill('P003-02');
  assert.equal(await page.locator('.product').count(), 1);
  await page.getByRole('searchbox').fill('不存在的商品');
  assert.equal(await page.locator('.empty').count(), 1);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择当前筛选下可启动的商品', exact: true }).check();
  assert.match(await page.locator('.batch').innerText(), /可启动 5 个 SKU/);
  await page.getByRole('button', { name: '启动自动上架 (5)', exact: true }).click();
  assert.equal(await page.locator('dialog[open]').count(), 1);
  await page.getByRole('button', { name: '模拟启动', exact: true }).click();
  await page.getByRole('button', { name: '核对结果', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '核对平台结果', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '重新提交', exact: true }).count(), 0);
  await page.screenshot({ path: fileURLToPath(new URL('unknown-drawer.png', output)) });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '暂停任务', exact: true }).click();
  await page.getByRole('button', { name: '模拟暂停', exact: true }).click();
  assert.match(await page.locator('.products').innerText(), /已暂停调度/);
  await page.getByRole('button', { name: '执行规则', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '从采集箱添加', exact: true }).click();
  await page.locator('.importcheck').first().check();
  await page.getByRole('button', { name: '添加所选商品', exact: true }).click();
  for (const label of ['采集箱', '手动上架', '上架进度', '商品数据', '采购备货', '发货与标签', '上架类目库', '操作记录', '设置']) {
    await page.locator('.nav').getByRole('button', { name: label, exact: true }).click();
    assert.equal(await page.locator('h1').innerText(), label);
    if (label === '采集箱') {
      await page.getByRole('button', { name: '导入商品', exact: true }).click();
      assert.equal(await page.locator('.drawer textarea').count(), 1);
      await page.keyboard.press('Escape');
    }
    if (label === '手动上架') {
      for (const tab of ['2. 规格与尺寸', '3. 图片', '4. 上架检查', '1. 基本资料']) await page.getByRole('button', { name: tab, exact: true }).click();
    }
    if (label === '发货与标签') {
      await page.getByRole('button', { name: '查看标签', exact: true }).click();
      await page.keyboard.press('Escape');
    }
  }
  await page.getByRole('button', { name: '查看控件规范', exact: true }).click();
  assert.equal(await page.locator('h1').innerText(), '控件规范');
  await page.locator('.nav').getByRole('button', { name: '自动上架', exact: true }).click();
  for (const width of [1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Page overflow at ${width}`);
    await page.screenshot({ path: fileURLToPath(new URL(`width-${width}.png`, output)), fullPage: true });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  console.log('PASS: 8 products, 20 SKU rows, filter counts, search/empty, selection, confirmation, UNKNOWN guard, pause, import, 10 page views, 4 widths; no JS errors or network requests.');
} finally { await browser.close(); }
