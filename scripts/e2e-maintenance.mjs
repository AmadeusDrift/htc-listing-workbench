import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resizeWindow } from './e2e-window.mjs';
import { publicApi } from './api-surface.mjs';
import { selectSettingsModule } from './e2e-settings.mjs';

await mkdir(resolve('.test-data'), { recursive: true });
await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/maintenance-e2e-'));
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url);
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
  await page.waitForFunction(() => !!window.red && !!document.querySelector('button'));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await selectSettingsModule(page, 'ai');
  await expect(page.getByRole('heading', { name: 'AI 连接、用量与上限', exact: true })).toBeVisible();
  await expect(page.getByLabel('AI 用量服务', { exact: true })).toBeEnabled();
}
async function saved() {
  await page.getByRole('button', { name: '保存 AI 用量上限', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '用量上限已保存' })).toBeVisible();
  await expect(page.getByLabel('AI 用量服务', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '保存 AI 用量上限', exact: true })).toBeDisabled();
}
async function profile(id) {
  await page.getByLabel('AI 连接供应商', { exact: true }).selectOption(id.startsWith('deepseek') ? 'deepseek' : 'aliyun');
  await expect(page.getByLabel('AI 用量服务', { exact: true })).toBeEnabled();
  await page.getByLabel('AI 用量服务', { exact: true }).selectOption(id);
  await expect(page.getByLabel('AI 用量服务', { exact: true })).toBeEnabled();
}
try {
  await launch();
  assert.deepEqual((await page.evaluate(() => Object.keys(window.red))).sort(), [...publicApi].sort());
  assert.ok((await page.evaluate(() => window.red.listAiProviders())).every(p => !p.enabled && !p.configured));
  assert.equal((await page.evaluate(() => window.red.getAiUsageSummary('deepseek'))).attempts, 0);
  await expect(page.getByLabel('每日调用次数预设', { exact: true })).toHaveValue('unlimited');
  await expect(page.getByLabel('每日 Token 预设', { exact: true })).toHaveValue('unlimited');
  pass('settings expose unlimited defaults and usage without enabling any provider');

  await selectSettingsModule(page, 'diagnostics');
  await expect(page.getByRole('heading', { name: '本地诊断', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '检查本地数据', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '本地检查完成' })).toBeVisible();
  const emptyReport = await page.evaluate(() => window.red.getLocalDiagnostics());
  assert.equal(emptyReport.reportVersion, 1);
  assert.equal(emptyReport.counts.products, 0);
  assert.equal(emptyReport.assets.total, 0);
  assert.equal(emptyReport.assets.inspected, 0);
  assert.deepEqual(emptyReport.errors, []);
  assert.equal(emptyReport.truncated, false);
  pass('local diagnostics work from settings on an empty workspace without creating assets or calling providers');
  await selectSettingsModule(page, 'ai');

  await page.getByLabel('每日调用次数预设', { exact: true }).selectOption('custom');
  await page.getByLabel('每日 Token 预设', { exact: true }).selectOption('custom');
  await page.getByLabel('AI 每日调用次数上限', { exact: true }).fill('3');
  await page.getByLabel('AI 每日 Token 上限', { exact: true }).fill('10000');
  await saved();
  assert.deepEqual(await page.evaluate(() => window.red.getAiUsagePolicy('deepseek')), { providerId: 'deepseek', dailyCallLimit: 3, dailyTokenLimit: 10000 });
  await page.getByLabel('AI 每日调用次数上限', { exact: true }).fill('4');
  await page.getByRole('button', { name: '刷新 AI 用量', exact: true }).click();
  await expect(page.getByLabel('AI 每日调用次数上限', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('AI 每日调用次数上限', { exact: true })).toHaveValue('4');
  await page.getByLabel('AI 每日调用次数上限', { exact: true }).fill('1.5');
  await expect(page.getByRole('button', { name: '保存 AI 用量上限', exact: true })).toBeDisabled();
  assert.equal((await page.evaluate(() => window.red.getAiUsagePolicy('deepseek'))).dailyCallLimit, 3);
  pass('saved limits reach the main process; refresh preserves edits and invalid limits cannot be saved');

  for (const [label, original] of [['AI 每日调用次数上限', '3'], ['AI 每日 Token 上限', '10000']]) {
    const input = page.getByLabel(label, { exact: true });
    for (const invalid of ['1e', '-', '2x']) {
      await input.fill(''); await input.pressSequentially(invalid);
      await expect(page.getByRole('button', { name: '保存 AI 用量上限', exact: true })).toBeDisabled();
      await expect(input).toHaveValue(invalid);
      assert.deepEqual(await page.evaluate(() => window.red.getAiUsagePolicy('deepseek')), { providerId: 'deepseek', dailyCallLimit: 3, dailyTokenLimit: 10000 });
    }
    await input.fill(original);
  }
  pass('incomplete or mixed numeric input cannot silently remove a saved quota');

  await profile('aliyun-ocr');
  await expect(page.getByLabel('AI 每日 Token 上限', { exact: true })).toHaveCount(0);
  await page.getByLabel('每日调用次数预设', { exact: true }).selectOption('custom');
  await page.getByLabel('AI 每日调用次数上限', { exact: true }).fill('0');
  await saved();
  assert.deepEqual(await page.evaluate(() => window.red.getAiUsagePolicy('aliyun-ocr')), { providerId: 'aliyun-ocr', dailyCallLimit: 0, dailyTokenLimit: null });
  await profile('deepseek');
  await expect(page.getByLabel('AI 每日调用次数上限', { exact: true })).toHaveValue('3');
  await page.getByLabel('AI 每日调用次数上限', { exact: true }).fill('');
  await page.getByLabel('AI 每日 Token 上限', { exact: true }).fill('');
  await saved();
  assert.deepEqual(await page.evaluate(() => window.red.getAiUsagePolicy('deepseek')), { providerId: 'deepseek', dailyCallLimit: null, dailyTokenLimit: null });
  pass('image providers use call limits, zero blocks new attempts and blank restores unlimited policy');

  for (const [width, height] of [[640, 720], [1366, 900]]) {
    await resizeWindow(app, page, width, height);
    for (const module of ['ai', 'diagnostics']) {
    await selectSettingsModule(page, module);
    const overflow = await page.evaluate(() => {
      const nodes = [document.documentElement, document.querySelector('.settings-panel'), document.querySelector('[aria-label="AI 用量与上限"]'), document.querySelector('[aria-label="本地诊断"]')];
      return nodes.map(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth })).filter(size => size.scrollWidth > size.width + 2);
    });
    assert.deepEqual(overflow, []); layouts.push({ module, width, height, overflow });
    }
  }
  await selectSettingsModule(page, 'ai');
  await page.getByLabel('每日调用次数预设', { exact: true }).selectOption('custom');
  await page.getByLabel('AI 每日调用次数上限', { exact: true }).fill('5');
  await saved();
  await app.close(); app = null;
  await launch();
  await expect(page.getByLabel('AI 每日调用次数上限', { exact: true })).toHaveValue('5');
  assert.equal((await page.evaluate(() => window.red.getAiUsagePolicy('aliyun-ocr'))).dailyCallLimit, 0);
  assert.equal((await page.evaluate(() => window.red.listAiCalls())).length, 0);
  pass('settings fit narrow/wide windows and policies survive a real application restart with no provider calls');

  const sentinel = 'PRIVATE-DIAGNOSTIC-SENTINEL-DO-NOT-EXPORT';
  const privateProduct = await page.evaluate(async marker => {
    const p = await window.red.createProduct();
    const { id, revision, status } = p;
    return window.red.saveProduct({ id, revision, status, title: marker, description: `secret-key=${marker}`, sourceUrl: `https://example.invalid/${marker}?signature=${marker}`,
      variants: p.variants.map(({ sourceSpec, sourcePurchasePrice, ...v }) => ({ ...v, originalSpec: marker })),
      facts: [{ id: crypto.randomUUID(), name: 'private', value: marker, source: 'manual', sourceRef: marker, state: 'human_confirmed' }] });
  }, sentinel);
  await page.evaluate(() => window.red.loadExamples());
  const intact = await page.evaluate(() => window.red.getLocalDiagnostics());
  assert.equal(intact.counts.products, 3);
  assert.equal(intact.counts.assets, 5);
  assert.equal(intact.assets.total, 10);
  assert.equal(intact.assets.inspected, 10);
  assert.ok(intact.assets.bytesRead > 0);
  assert.ok(intact.assets.items.some(item => item.kind === 'ASSET_PREVIEW' && item.status === 'READABLE_UNVERIFIED'));
  assert.equal(intact.truncated, false);
  const connection = new DatabaseSync(join(dataRoot, 'red.sqlite'), { readOnly: true });
  let original;
  try { original = connection.prepare('SELECT id,original_path FROM assets ORDER BY rowid LIMIT 1').get(); }
  finally { connection.close(); }
  const managedFile = resolve(dataRoot, original.original_path);
  assert.ok(managedFile.startsWith(resolve(dataRoot) + sep));
  const originalBytes = await readFile(managedFile);
  await rename(managedFile, managedFile + '.withheld-for-test');
  const damaged = await page.evaluate(() => window.red.getLocalDiagnostics());
  assert.ok(damaged.assets.items.some(item => item.recordId === original.id && item.status === 'MISSING'));
  assert.equal((await page.evaluate(id => window.red.getProduct(id), privateProduct.id)).title, sentinel);
  assert.deepEqual(await readFile(managedFile + '.withheld-for-test'), originalBytes);
  await selectSettingsModule(page, 'diagnostics');
  await page.getByRole('button', { name: '检查本地数据', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '本地检查完成' })).toBeVisible();
  await page.getByLabel('本地诊断', { exact: true }).locator('summary').filter({ hasText: '查看待核对文件' }).click();
  await expect(page.getByLabel('本地诊断')).toContainText('缺失');
  const serialized = JSON.stringify(damaged);
  for (const forbidden of [sentinel, 'example.invalid', dataRoot, managedFile, 'secret-key=', 'signature='].flatMap(value => [value, value.replaceAll('\\', '\\\\')])) assert.equal(serialized.includes(forbidden), false);
  pass('real local image checks distinguish missing files and unhashed previews; reports omit business text, URLs and paths');

  const exportRoot = await mkdtemp(resolve('.test-data/diagnostic-exports-'));
  const diagnosticPath = join(exportRoot, 'report.json');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, diagnosticPath);
  await page.getByRole('button', { name: '导出诊断报告', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '诊断报告已保存' })).toBeVisible();
  const exported = await readFile(diagnosticPath, 'utf8');
  assert.equal(JSON.parse(exported).reportVersion, 1);
  assert.equal(JSON.parse(exported).counts.products, 3);
  for (const forbidden of [sentinel, 'example.invalid', dataRoot, exportRoot, 'secret-key=', 'signature='].flatMap(value => [value, value.replaceAll('\\', '\\\\')])) assert.equal(exported.includes(forbidden), false);
  assert.deepEqual((await readdir(exportRoot)).sort(), ['report.json']);
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  await page.getByRole('button', { name: '导出诊断报告', exact: true }).click();
  await expect(page.getByRole('button', { name: '导出诊断报告', exact: true })).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: '诊断报告已保存' })).toHaveCount(0);
  assert.equal(await readFile(diagnosticPath, 'utf8'), exported);
  for (const blocked of [join(dataRoot, 'report.json'), join(exportRoot, 'report.sqlite')]) {
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, blocked);
    await assert.rejects(page.evaluate(() => window.red.exportLocalDiagnostics()));
  }
  await mkdir(join(exportRoot, 'blocked.json'));
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, join(exportRoot, 'blocked.json'));
  await assert.rejects(page.evaluate(() => window.red.exportLocalDiagnostics()));
  assert.equal(await readFile(diagnosticPath, 'utf8'), exported);
  assert.deepEqual((await readdir(exportRoot)).sort(), ['blocked.json', 'report.json']);
  pass('native diagnostic export is redacted and atomic; cancellation, invalid destinations and a real write obstruction preserve previous files');
  await page.getByRole('heading', { name: '本地诊断', exact: true }).scrollIntoViewIfNeeded();
  const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
    const captured = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (captured.isEmpty()) throw new Error('Empty diagnostic settings screenshot');
    return captured.toPNG().toString('base64');
  });
  await writeFile(resolve('artifacts/maintenance-settings.png'), Buffer.from(screenshot, 'base64'));
  assert.deepEqual(errors, []);
  await writeFile(resolve('artifacts/maintenance-e2e-report.json'), JSON.stringify({ passed: true, checks, errors, layouts, dataRoot, at: new Date().toISOString(), environment: 'isolated actual Electron application; no provider credentials or external calls' }, null, 2));
} catch (error) {
  await writeFile(resolve('artifacts/maintenance-e2e-report.json'), JSON.stringify({ passed: false, checks, errors, layouts, dataRoot, failure: String(error), at: new Date().toISOString() }, null, 2));
  throw error;
} finally { await app?.close(); }
