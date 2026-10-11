import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchGuarded } from './release-runtime.mjs';

const require = createRequire(import.meta.url), output = resolve('artifacts/flat-runtime');
await mkdir(output, { recursive: true }); await mkdir(resolve('.test-data'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/flat-runtime-'));
let app;
const errors = [], checks = [];
try {
  app = await launchGuarded({ executable: require('electron'), args: ['.'], dataRoot, guardPath: resolve('scripts/release-network-guard.cjs'), cwd: resolve('.') });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling = false; });
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('button', { name: '新建商品', exact: true })).toBeEnabled();
  await page.evaluate(async () => { await window.red.loadExamples(); await window.red.loadWorkspaceExamples('inbox'); await window.red.loadWorkspaceExamples('automatic'); await window.red.enableAmazonDemo(); });
  await page.reload();
  const nav = async name => { await page.locator('.primary-navigation').getByRole('button', { name, exact: true }).click({ force: true }); await expect(page.locator('.page-heading h1')).toHaveText(name); };
  const capture = async name => {
    await page.evaluate(() => document.fonts.ready);
    // Hidden windows can lag behind DOM/IPC readiness by a compositor frame.
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const pixels = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await writeFile(join(output, name + '.png'), Buffer.from(pixels, 'base64'));
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async theme => { const appearance = await window.red.getAppearance(); await window.red.saveAppearance({ ...appearance, theme, motion: 'reduced' }); }, theme);
    await page.reload();
    for (const width of [1480, 1024]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 1000), width);
      for (const name of ['采集箱', '手动上架', '自动上架', '上架进度', '商品数据', '采购备货', '发货与标签', '上架类目库', '操作记录', '设置']) {
        await nav(name);
        if (name === '自动上架') {
          const select = page.getByLabel('目标店铺与站点', { exact: true });
          const option = await select.locator('option').nth(1).getAttribute('value');
          await select.selectOption(option);
          await expect(page.locator('.automatic-queue-entry')).toHaveCount(2);
          await expect(select).toHaveValue(option);
          await expect(page.locator('.automatic-connections')).toHaveAttribute('aria-busy', 'false');
          await expect(page.locator('.automatic-queue-entry').first()).not.toContainText('可启动待核对');
        }
        const overflow = await page.evaluate(() => [...document.querySelectorAll('.main-content,.automatic-workspace,.automatic-preparation,.automatic-unified-queue,.settings-layout,.product-editor')].filter(el => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2).map(el => el.className));
        assert.deepEqual(overflow, [], `${name} ${theme} ${width}: overflow`);
        const controls = await page.locator('.button').evaluateAll(elements => elements.filter(el => el.getClientRects().length).map(el => { const s = getComputedStyle(el); return { text: el.textContent, radius: s.borderRadius, image: s.backgroundImage }; }));
        assert.ok(controls.every(value => value.radius === '4px' && value.image === 'none'), JSON.stringify(controls));
        if (['自动上架', '手动上架', '设置'].includes(name)) await capture(`${theme}-${width}-${name}`);
        checks.push(`${theme} ${width} ${name}`);
      }
    }
  }
  assert.deepEqual(errors, []);
  const safety = await app.evaluate(({ BrowserWindow }) => ({ visible: BrowserWindow.getAllWindows().some(window => window.isVisible()), blockedAttempts: globalThis.__releaseGuard.attempts, installedBeforeMain: globalThis.__releaseGuard.installedBeforeMain }));
  assert.equal(safety.visible, false); assert.equal(safety.installedBeforeMain, true); assert.deepEqual(safety.blockedAttempts, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ dataRoot, checks, errors, safety }, null, 2));
  console.log(`PASS ${checks.length} real app layout checks; pre-main network guard; isolated synthetic database; output ${output}`);
} finally { await app?.close(); }
