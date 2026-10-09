import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resizeWindow } from './e2e-window.mjs';
import { publicApi } from './api-surface.mjs';
import { selectSettingsModule } from './e2e-settings.mjs';

await mkdir(resolve('.test-data'), { recursive: true });
await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/ui-feedback-'));
const require = createRequire(import.meta.url);
process.env.electron_config_cache = resolve('.cache/electron');
const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], layouts = [];
let app, page;
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
async function launch() {
  app = await electron.launch({ executablePath: process.env.RED_E2E_EXECUTABLE || require('electron'), args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: resolve('.'), env, timeout: 35000 });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling = false; });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await selectSettingsModule(page, 'ai');
  await expect(page.getByLabel('AI 用量服务', { exact: true })).toBeEnabled();
}
async function screenshot(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(resolve(`artifacts/${name}.png`), Buffer.from(data, 'base64'));
}
async function saveLimits() {
  await page.getByRole('button', { name: '保存 AI 用量上限', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存 AI 用量上限', exact: true })).toBeDisabled();
  await expect(page.getByLabel('AI 用量服务', { exact: true })).toBeEnabled();
}
async function provider(id) {
  await page.getByLabel('AI 连接供应商', { exact: true }).selectOption(id.startsWith('deepseek') ? 'deepseek' : 'aliyun');
  await expect(page.getByLabel('AI 用量服务', { exact: true })).toBeEnabled();
  await page.getByLabel('AI 用量服务', { exact: true }).selectOption(id);
  await expect(page.getByLabel('AI 用量服务', { exact: true })).toBeEnabled();
}
try {
  await launch();
  // Stub only the operating-system clipboard boundary; never touch the user's clipboard.
  await app.evaluate(({ clipboard }) => {
    globalThis.feedbackClipboard = '';
    clipboard.writeText = async text => { await new Promise(resolve => setTimeout(resolve, 20)); globalThis.feedbackClipboard = text; };
    clipboard.readText = async () => globalThis.feedbackClipboard;
  });
  const generate = page.getByRole('button', { name: '随机生成口令', exact: true });
  await selectSettingsModule(page, 'data');
  await generate.click({ timeout: 5000 });
  const first = await page.getByLabel('备份口令', { exact: true }).inputValue();
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
  await expect(page.getByLabel('确认备份口令', { exact: true })).toHaveValue(first);
  await expect(page.getByRole('button', { name: '创建加密备份', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '复制口令', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '口令已复制' })).toBeVisible();
  assert.equal(await app.evaluate(() => globalThis.feedbackClipboard), first);
  await generate.click();
  const second = await page.getByLabel('备份口令', { exact: true }).inputValue();
  assert.notEqual(first, second);
  await expect(page.getByRole('status').filter({ hasText: '口令已复制' })).toHaveCount(0);
  await page.getByLabel('备份口令', { exact: true }).fill('manually-entered-backup-test');
  await page.getByRole('button', { name: '复制口令', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '口令已复制' })).toBeVisible();
  assert.equal(await app.evaluate(() => globalThis.feedbackClipboard), 'manually-entered-backup-test');
  await app.evaluate(({ clipboard }) => { clipboard.writeText = async () => { throw new Error('private-clipboard-failure'); }; });
  await page.getByRole('button', { name: '复制口令', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '复制失败' })).toBeVisible();
  assert.equal((await page.locator('body').innerText()).includes('private-clipboard-failure'), false);
  await assert.rejects(page.evaluate(() => window.red.copyBackupPassphrase({ passphrase: 'short' })));
  await assert.rejects(page.evaluate(() => window.red.copyBackupPassphrase({ passphrase: 'valid-backup-password', extra: true })));
  await page.getByLabel('备份口令', { exact: true }).fill('');
  await page.getByLabel('确认备份口令', { exact: true }).fill('');
  pass('secure random backup passwords confirm together; copy matches current input and reports native failures without leaking details');
  await selectSettingsModule(page, 'ai');

  const calls = page.getByLabel('每日调用次数预设', { exact: true });
  const tokens = page.getByLabel('每日 Token 预设', { exact: true });
  await expect(calls).toHaveValue('unlimited'); await expect(tokens).toHaveValue('unlimited');
  await calls.selectOption('500'); await tokens.selectOption('500000'); await saveLimits();
  assert.deepEqual(await page.evaluate(() => window.red.getAiUsagePolicy('deepseek')), { providerId: 'deepseek', dailyCallLimit: 500, dailyTokenLimit: 500000 });
  await calls.selectOption('custom'); await page.getByLabel('AI 每日调用次数上限', { exact: true }).fill('123');
  await tokens.selectOption('custom'); await page.getByLabel('AI 每日 Token 上限', { exact: true }).fill('765432');
  await page.getByRole('button', { name: '刷新 AI 用量', exact: true }).click();
  await expect(page.getByLabel('AI 每日调用次数上限', { exact: true })).toHaveValue('123');
  await saveLimits();
  await provider('deepseek-review'); await expect(calls).toHaveValue('unlimited');
  await calls.selectOption('custom'); await page.getByLabel('AI 每日调用次数上限', { exact: true }).fill('0'); await saveLimits();
  await provider('aliyun-ocr'); await expect(tokens).toHaveCount(0); await calls.selectOption('100'); await saveLimits();
  await provider('deepseek'); await expect(calls).toHaveValue('custom');
  await expect(page.getByLabel('AI 每日 Token 上限', { exact: true })).toHaveValue('765432');
  await page.getByLabel('AI 每日调用次数上限', { exact: true }).fill('100');
  await expect(calls).toHaveValue('custom');
  await page.getByLabel('AI 每日调用次数上限', { exact: true }).fill('123');
  pass('quotas default to unlimited, presets and custom values persist per provider, custom typing stays stable and zero remains supported');

  for (const width of [1920, 1366, 900, 640]) {
    await resizeWindow(app, page, width, width === 1920 ? 1320 : 1000);
    await page.locator('.ai-settings').evaluate(element => element.scrollIntoView({ block: 'start' }));
    const layout = await page.evaluate(() => {
      const connection = document.querySelector('.ai-connection-column').getBoundingClientRect();
      const usage = document.querySelector('.ai-usage-column').getBoundingClientRect();
      const diagnostics = document.querySelector('[aria-label="本地诊断"]').getBoundingClientRect();
      const ai = document.querySelector('.ai-settings').getBoundingClientRect();
      const overflow = ['html', '.settings-panel', '.ai-settings', '.ai-connection-column', '.ai-usage-column'].filter(selector => { const node = document.querySelector(selector); return node.scrollWidth > node.clientWidth + 2; });
      return { connection: connection.toJSON(), usage: usage.toJSON(), diagnostics: diagnostics.toJSON(), ai: ai.toJSON(), overflow };
    });
    assert.deepEqual(layout.overflow, []);
    if (layout.ai.width >= 840) {
      assert.ok(Math.abs(layout.connection.top - layout.usage.top) <= 2);
      assert.ok(Math.abs(layout.connection.width - layout.usage.width) <= 2);
    } else assert.ok(layout.usage.top >= layout.connection.bottom);
    await expect(page.getByLabel('本地诊断', { exact: true })).toBeHidden();
    await selectSettingsModule(page, 'diagnostics');
    await expect(page.getByRole('heading', { name: '本地诊断', exact: true })).toBeVisible();
    assert.equal(await page.getByLabel('本地诊断', { exact: true }).evaluate(node => node.scrollWidth > node.clientWidth + 2), false);
    await selectSettingsModule(page, 'ai');
    await expect(page.locator('.settings-panel .version-badge')).toBeVisible();
    layouts.push({ width, ...layout });
    if (width === 1920 || width === 640) await screenshot(`ui-feedback-ai-${width}`);
    if (width === 640) { await page.locator('.ai-usage-column').evaluate(element => element.scrollIntoView({ block: 'start' })); await screenshot('ui-feedback-usage-640'); }
  }
  pass('AI connection and quota columns are balanced on desktop and stacked on narrow windows; diagnostics is reachable in its own settings module');
  await app.close(); app = null; await launch();
  await expect(page.getByLabel('每日调用次数预设', { exact: true })).toHaveValue('custom');
  await expect(page.getByLabel('AI 每日调用次数上限', { exact: true })).toHaveValue('123');
  assert.equal((await page.evaluate(() => window.red.getAiUsagePolicy('deepseek-review'))).dailyCallLimit, 0);
  assert.equal((await page.evaluate(() => window.red.listAiCalls())).length, 0);
  assert.deepEqual((await page.evaluate(() => Object.keys(window.red))).sort(), [...publicApi].sort());
  pass('saved custom limits survive app restart and all verification stays local without AI calls');
  assert.deepEqual(errors, []);
} catch (error) {
  await writeFile(resolve('artifacts/ui-feedback-e2e-report.json'), JSON.stringify({ passed: false, checks, errors, layouts, dataRoot, failure: String(error) }, null, 2));
  throw error;
} finally { if (app) await app.close(); }
await writeFile(resolve('artifacts/ui-feedback-e2e-report.json'), JSON.stringify({ passed: true, checks, errors, layouts, dataRoot, at: new Date().toISOString() }, null, 2));
