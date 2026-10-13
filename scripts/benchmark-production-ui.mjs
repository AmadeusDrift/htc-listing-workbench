import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { expect } from '@playwright/test';
import { openDatabase, SCHEMA_VERSION } from '../src/main/database.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import { sourceStamp, validateAutomaticListingTask } from '../src/main/automatic-listing/records.ts';
import { launchGuarded } from './release-runtime.mjs';

// Synthetic persisted data only. Production main/preload/App and service are unmodified.
// No start/resume/grant/configuration API is used. Runtime guard precedes main entry.
mkdirSync(resolve('.test-data'), { recursive: true });
const dataRoot = mkdtempSync(resolve('.test-data/production-ui-scale-'));
const output = resolve('artifacts/production-ui-scale'); mkdirSync(output, { recursive: true });
const runLabel = process.env.HTC_PERF_RUN_LABEL || 'preflight-concurrent-work';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=', 'base64');
const sha = createHash('sha256').update(png).digest('hex'), now = new Date().toISOString();
const productIds = [], taskIds = [], seedStart = performance.now();
mkdirSync(join(dataRoot, 'assets'));
let db = openDatabase(dataRoot);
db.exec('BEGIN');
for (let i = 0; i < 2000; i++) {
  const id = randomUUID(), variant = randomUUID(), asset = randomUUID(); productIds.push(id);
  db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?)').run(id, `Synthetic 商品 ${String(i).padStart(4, '0')}`, '', 'Local scale fixture', 'draft', 'manual', 1, now, now);
  db.prepare('INSERT INTO variants VALUES(?,?,?,?,?,?,?,?,?,?)').run(variant, id, `SYNTH-${i}`, 'blue', 'blue', '1', 10, 'blue', '1', 0);
  db.prepare('INSERT INTO product_workspaces(product_id,lane,updated_at) VALUES(?,?,?)').run(id, 'inbox', now);
  const path = `assets/${asset}.png`; writeFileSync(join(dataRoot, path), png);
  db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(asset, id, `${i}.png`, 'main', 'image/png', 1, 1, png.length, path, path, sha, now);
  db.prepare('INSERT INTO variant_assets VALUES(?,?,1,?)').run(asset, variant, now);
}
db.exec('COMMIT'); db.close();
const store = new WorkspaceStore(dataRoot);
const products = productIds.map(id => store.getProduct(id)); store.close();
const targetStore = new AmazonPersistence(dataRoot);
targetStore.putTarget({ id: 'synthetic-offline', name: 'Synthetic offline target', sellerId: 'synthetic', marketplaceId: 'ATVPDKIKX0DER', marketplaceName: 'US', mode: 'demo', region: 'na', locale: 'en_US', paused: true, configured: false, credentialUpdatedAt: null, lastError: null });
targetStore.close();
db = openDatabase(dataRoot); db.exec('BEGIN');
for (let i = 0; i < 5000; i++) {
  const p = products[i % products.length], v = p.variants[0], id = randomUUID(); taskIds.push(id);
  const task = validateAutomaticListingTask({ id, revision: 1, status: 'PAUSED', targetId: 'synthetic-offline', targetName: 'Synthetic offline target', sellerId: 'synthetic', marketplaceId: 'ATVPDKIKX0DER', mode: 'demo', targetStamp: 'a'.repeat(64), profileId: 'alpha', profileStamp: 'b'.repeat(64), rulesStamp: 'c'.repeat(64), ruleRevision: 1, productType: 'SYNTHETIC', locale: 'en_US', labelFormat: { labelType: 'STANDARD_FORMAT', pageType: 'A4_21', localeCode: 'en_US' }, createdAt: now, updatedAt: now, error: null, items: [{ key: `${p.id}:${v.id}`, productId: p.id, productRevision: p.revision, sourceStamp: sourceStamp(p), productTitle: p.title, variantId: v.id, sku: v.sku, stockSets: 5, sourcesPrepared: false, status: 'PENDING', stage: 'SOURCES', draftId: null, executionTaskIds: [], imageStarted: false, imageAttempts: 0, repairAttempts: 0, repair: null, batchId: null, error: null }] });
  db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(id, JSON.stringify(task));
}
db.exec('COMMIT'); db.close();
const report = { recordedAt: now, schemaVersion: SCHEMA_VERSION, dataset: { products: 2000, tasks: 5000, itemsPerTask: 1, assets: 2000, bytesPerImage: png.length, imageDimensions: '1x1 synthetic PNG; independent owner/path, shared bytes', allTasks: 'PAUSED', credentials: 0, grants: 0, fixtureCreationMs: performance.now() - seedStart }, environment: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0].model, logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version }, measurements: [], errors: [], limitations: ['Wall clock includes CPU, IPC, scheduling and local filesystem IO; no storage hardware attribution.', 'Synthetic small PNG covers pagination/decode/owner isolation, not real megapixel decode load.', 'Single run observations, not p95/SLA. 200ms refers to ordinary visible feedback target from acceptance line 114.', 'Paused synthetic demo target with no credentials; local adaptation may report unavailable configuration. No remote statistics or migrations exercised.'] };
let app, page;
async function capture(name) {
  const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  writeFileSync(join(output, name + '.png'), Buffer.from(bytes, 'base64'));
}
async function measure(name, action, complete) {
  const cpuBefore = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, pid: p.pid, cpuSeconds: p.cpu.cumulativeCPUUsage })));
  const start = performance.now(); await page.evaluate(() => { window.__measureStart = performance.now(); });
  await action(); await complete();
  const wallMs = performance.now() - start;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const renderer = await page.evaluate(() => ({ durationToPaintOpportunityMs: performance.now() - window.__measureStart, longTasks: window.__longTasks.filter(x => x.start >= window.__measureStart), inputEvents: window.__inputEvents.filter(x => x.start >= window.__measureStart) }));
  const cpuAfter = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, pid: p.pid, cpuSeconds: p.cpu.cumulativeCPUUsage })));
  report.measurements.push({ name, completionWallMs: wallMs, ...renderer, processCpu: cpuAfter.map(p => ({ ...p, deltaSeconds: p.cpuSeconds - (cpuBefore.find(b => b.pid === p.pid)?.cpuSeconds ?? p.cpuSeconds) })) }); console.log(name, wallMs.toFixed(1));
}
try {
  const started = performance.now();
  app = await launchGuarded({ executable: createRequire(import.meta.url)('electron'), dataRoot, guardPath: resolve('scripts/release-network-guard.cjs'), cwd: resolve('.'), args: ['--force-device-scale-factor=1.25', '.'] });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', e => report.errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setBackgroundThrottling(false); w.setSize(1440, 1000); w.showInactive(); });
  await page.evaluate(() => {
    window.__longTasks = []; window.__inputEvents = [];
    new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
    for (const type of ['input', 'change', 'click']) document.addEventListener(type, e => {
      const start = performance.now(), target = e.target.closest?.('button,input,select'), label = target?.getAttribute('aria-label') || target?.textContent?.slice(0, 60);
      const entry = { type, label, start, dispatchDelayMs: start - e.timeStamp, domFeedbackMs: null, feedback: null };
      window.__inputEvents.push(entry);
      const previousPage = document.querySelector('[aria-label="采集箱分页"] [aria-live]')?.textContent;
      const inputValue = target?.value;
      const check = () => {
        let feedback;
        if (target?.matches('input') && target.value === inputValue) feedback = `input value: ${target.value}`;
        else if (target?.matches('select') && document.querySelector('.automatic-task-panel [role="status"]')?.textContent?.includes('正在读取')) feedback = '正在读取已保存任务';
        else if (target?.getAttribute('aria-current') === 'page') feedback = `active navigation: ${label}`;
        else if (target?.getAttribute('aria-pressed') === 'true') feedback = `active filter: ${label}`;
        else if (label === '刷新任务' && target?.disabled && target.textContent.includes('正在读取任务')) feedback = 'refresh disabled with visible reading feedback';
        else if (label === '采集箱下一页') { const next = document.querySelector('[aria-label="采集箱分页"] [aria-live]')?.textContent; if (next !== previousPage) feedback = next; }
        if (!feedback) return;
        entry.domFeedbackMs = performance.now() - start; entry.feedback = feedback; observer.disconnect();
      };
      const observer = new MutationObserver(check); observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
      queueMicrotask(check); setTimeout(() => observer.disconnect(), 3000);
      requestAnimationFrame(() => requestAnimationFrame(() => { entry.eventToPaintOpportunityMs = performance.now() - start; }));
    }, true);
  });
  await expect(page.getByRole('textbox', { name: '搜索采集箱' })).toBeVisible();
  await expect(page.locator('.inbox-product-table tbody tr')).toHaveCount(20);
  await expect(page.getByRole('navigation', { name: '采集箱分页' })).toContainText('共 2000 件');
  report.startup = { guardedLaunchTo2000ProductsUiMs: performance.now() - started, renderer: await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now(), dpr: devicePixelRatio, width: innerWidth, height: innerHeight, longTasks: window.__longTasks })) };
  report.environment.electron = await app.evaluate(() => process.versions);
  report.environment.runLabel = runLabel;
  report.environment.window = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { visible: w.isVisible(), focused: w.isFocused(), backgroundThrottling: w.webContents.getBackgroundThrottling(), nativeSize: w.getSize(), contentSize: w.getContentSize() }; });
  report.environment.rendererVisibility = await page.evaluate(() => document.visibilityState);
  report.apiCounts = await page.evaluate(async () => ({ products: (await window.red.listProducts()).length, tasks: (await window.red.listAutomaticListingTasks()).length }));
  assert.deepEqual(report.apiCounts, { products: 2000, tasks: 5000 });
  await capture('01-inbox-2000');
  const search = page.getByRole('textbox', { name: '搜索采集箱' });
  await measure('search 1999 / 2000 products', () => search.fill('1999'), () => expect(page.locator('.inbox-product-table tbody tr')).toHaveCount(1));
  await measure('clear search / restore page of 20', () => search.fill(''), () => expect(page.locator('.inbox-product-table tbody tr')).toHaveCount(20));
  await measure('filter ignored products', () => page.getByRole('button', { name: /^已忽略/ }).click(), () => expect(page.locator('.inbox-product-table tbody tr')).toHaveCount(0));
  await measure('restore inbox filter', () => page.getByRole('button', { name: /^待整理/ }).click(), () => expect(page.locator('.inbox-product-table tbody tr')).toHaveCount(20));
  await measure('image pagination page 2 and local PNG decode', () => page.getByRole('button', { name: '采集箱下一页', exact: true }).click(), async () => { await expect(page.getByRole('navigation', { name: '采集箱分页' })).toContainText('第 2 / 100 页'); await expect.poll(() => page.locator('.inbox-product-table img').evaluateAll(imgs => imgs.length === 20 && imgs.every(i => i.complete && i.naturalWidth === 1))).toBe(true); });
  await capture('02-images-page-2');
  await measure('navigate automatic and load 5000 task options', () => page.getByRole('button', { name: '自动上架', exact: true }).click(), () => expect(page.locator('select[aria-label="选择自动上架任务"] option')).toHaveCount(5000));
  const profiler = process.env.HTC_PERF_PROFILE ? await page.context().newCDPSession(page) : null;
  if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
  await measure('switch paused task and render local counts', () => page.getByRole('combobox', { name: '选择自动上架任务' }).selectOption(taskIds[2500]), () => expect(page.getByTestId(`automatic-task-${taskIds[2500]}`)).toBeVisible());
  report.taskOptionSemantics = await page.locator('select[aria-label="选择自动上架任务"]').evaluate((select, expectedId) => ({ count: select.options.length, selected: select.value, selectedText: select.selectedOptions[0].textContent, expectedId }), taskIds[2500]);
  assert.equal(report.taskOptionSemantics.count, 5000); assert.equal(report.taskOptionSemantics.selected, taskIds[2500]);
  const originalDateText = await page.evaluate(now => new Date(now).toLocaleString('zh-CN', { hour12: false }), now);
  assert.ok(report.taskOptionSemantics.selectedText.endsWith(originalDateText), 'Preserve locale, date/time fields and timezone');
  if (profiler) { const { profile } = await profiler.send('Profiler.stop'); writeFileSync(join(output, 'switch-task.cpuprofile'), JSON.stringify(profile)); await profiler.detach(); report.profileInstrumented = true; }
  await measure('task search while polling 5000 saved records', () => page.getByRole('searchbox', { name: '搜索任务商品或 SKU' }).fill('SYNTH'), () => expect(page.getByRole('searchbox', { name: '搜索任务商品或 SKU' })).toHaveValue('SYNTH'));
  await measure('refresh 5000 tasks and immediately type', async () => { await page.getByRole('button', { name: '刷新任务', exact: true }).click(); await page.getByRole('searchbox', { name: '搜索任务商品或 SKU' }).fill('SYNTH-500'); }, () => expect(page.getByRole('searchbox', { name: '搜索任务商品或 SKU' })).toHaveValue('SYNTH-500'));
  await capture('03-task-5000');
  await measure('refresh 5000 tasks and immediately navigate inbox', async () => { await page.getByRole('button', { name: '刷新任务', exact: true }).click(); await page.getByRole('button', { name: '采集箱', exact: true }).click(); }, () => expect(search).toBeVisible());
  const refreshEvents = report.measurements.flatMap(m => m.inputEvents).filter(e => e.type === 'click' && e.label === '刷新任务');
  assert.equal(refreshEvents.length, 2); assert.ok(refreshEvents.every(e => e.feedback === 'refresh disabled with visible reading feedback'), 'Refresh must expose reading feedback without blocking other navigation/input');
  report.safety = await app.evaluate(() => ({ installedBeforeMain: globalThis.__releaseGuard.installedBeforeMain, blockedAttempts: globalThis.__releaseGuard.attempts }));
  report.taskStates = await page.evaluate(async () => { const rows = await window.red.listAutomaticListingTasks(); return { count: rows.length, paused: rows.filter(r => r.status === 'PAUSED').length, imageAttempts: rows.reduce((n, r) => n + r.items.reduce((m, i) => m + i.imageAttempts, 0), 0) }; });
  assert.equal(report.taskStates.paused, 5000); assert.equal(report.taskStates.imageAttempts, 0); assert.deepEqual(report.safety.blockedAttempts, []); assert.deepEqual(report.errors, []);
  await app.close(); app = null;
  const persisted = openDatabase(dataRoot);
  try {
    report.persistedSafety = {
      paused: Number(persisted.prepare("SELECT count(*) n FROM automatic_listing_tasks WHERE json_extract(record_json,'$.status')='PAUSED'").get().n),
      activityRows: Object.fromEntries(['ai_calls', 'amazon_calls', 'hosting_uploads', 'execution_tasks'].map(table => [table, Number(persisted.prepare(`SELECT count(*) n FROM ${table}`).get().n)])),
      foreignKeyViolations: persisted.prepare('PRAGMA foreign_key_check').all(),
      ownedAssets: Number(persisted.prepare('SELECT count(*) n FROM assets a JOIN products p ON p.id=a.product_id JOIN variant_assets va ON va.asset_id=a.id JOIN variants v ON v.id=va.variant_id AND v.product_id=p.id').get().n),
    };
    assert.equal(report.persistedSafety.paused, 5000); assert.equal(report.persistedSafety.ownedAssets, 2000);
    assert.deepEqual(report.persistedSafety.foreignKeyViolations, []); assert.ok(Object.values(report.persistedSafety.activityRows).every(n => n === 0));
  } finally { persisted.close(); }
  report.completed = true;
} catch (error) { report.failure = String(error.stack || error); throw error; }
finally { await app?.close(); writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log('Report:', join(output, 'report.json')); }



