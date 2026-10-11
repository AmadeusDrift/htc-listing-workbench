import { launchGuarded } from './release-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { publicApi } from './api-surface.mjs';

// This starts a separate, permanently hidden Electron workspace. No production
// credentials, user workspace, visible windows or live services are used.
const root = resolve('.'), artifacts = resolve('artifacts/ui-090');
await mkdir(resolve('.test-data'), { recursive: true });
await mkdir(artifacts, { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/appearance-e2e-'));
const build = {
  version: JSON.parse(await readFile('package.json', 'utf8')).version,
  mainSha256: createHash('sha256').update(await readFile('dist-electron/main.cjs')).digest('hex'),
  preloadSha256: createHash('sha256').update(await readFile('dist-electron/preload.cjs')).digest('hex'),
  rendererAssets: [...(await readFile('dist/index.html', 'utf8')).matchAll(/(?:src|href)="([^\"]+)"/g)].map(match => match[1]),
};
const require = createRequire(import.meta.url), executablePath = process.env.RED_E2E_EXECUTABLE || require('electron');
process.env.electron_config_cache = resolve('.cache/electron');
const defaults = { theme: 'light', density: 'comfortable', motion: 'full' };
const views = ['采集箱', '手动上架', '自动上架', '上架进度', '商品数据', '采购备货', '发货与标签', '上架类目库', '操作记录', '设置'];
const modules = ['amazon', 'collection', 'ai', 'images', 'product', 'pricing', 'appearance', 'data', 'diagnostics'];
const checks = [], layouts = [], screenshots = [], errors = [], processLog = [], remoteRequests = [];
const startedAt = new Date().toISOString();
let app, page, succeeded = false, failure = null;
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const button = name => page.getByRole('button', { name, exact: true });

async function launch() {
  app = await launchGuarded({ executable: executablePath, args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: root, dataRoot, guardPath: resolve('scripts/release-network-guard.cjs') });
  app.process().stderr.on('data', chunk => processLog.push(chunk.toString()));
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await app.evaluate(({ BrowserWindow, session }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.backgroundThrottling = false;
    globalThis.appearanceRemoteRequests = [];
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      globalThis.appearanceRemoteRequests.push(details.url); callback({ cancel: true });
    });
  });
  await expect(page.locator('.titlebar-theme')).toBeEnabled();
  await expect(button('新建商品')).toBeEnabled();
  await assertHidden();
}
async function assertHidden() {
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible())), false, 'The isolated test app must stay hidden');
}
async function close() {
  if (!app) return;
  remoteRequests.push(...await app.evaluate(() => globalThis.appearanceRemoteRequests ?? []).catch(() => []));
  await assertHidden();
  await app.close(); app = null; page = null;
}
async function nav(name) {
  const target = page.locator('.primary-navigation').getByRole('button', { name, exact: true });
  await expect(target).toBeVisible(); await expect(target).toBeEnabled();
  // Hidden native windows can throttle Playwright's animation stability frames.
  // Assert visibility/enabled state explicitly, then dispatch the real click.
  await target.click({ force: true }); await expect(target).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.page-heading h1')).toHaveText(name);
  await settle();
}
async function module(id) {
  const target = page.locator(`#settings-nav-${id}`);
  if (await target.isVisible()) { await expect(target).toBeEnabled(); await target.click({ force: true }); }
  else await page.locator('.settings-module-select select').selectOption(id);
  await expect(target).toHaveAttribute('aria-current', 'page');
  await settle();
}
async function settle() {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // A permanently hidden window may suspend animation frames after idle.
    // Layout reads still flush styles; do not let frame scheduling stall the test.
    await Promise.race([
      new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))),
      new Promise(done => setTimeout(done, 150)),
    ]);
  });
}
async function resizeWindow(app, page, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
  await expect.poll(async () => {
    const size = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { outer: window.getSize(), content: window.getContentSize() };
    });
    const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
    return size.outer[0] === width && size.outer[1] === height && size.content.every((value, index) => value === viewport[index]);
  }, { timeout: 10000 }).toBe(true);
  await settle();
}
async function screenshot(name) {
  await settle(); await assertHidden();
  const base64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  const path = join(artifacts, `${name}.png`);
  await writeFile(path, Buffer.from(base64, 'base64')); screenshots.push(path);
  await assertHidden(); console.log(`SCREENSHOT ${path}`);
}
async function layout(name) {
  const result = await page.evaluate(() => {
    // Tables and JSON editors intentionally have their own scroll containers;
    // page and card shells must never force horizontal workspace scrolling.
    const selectors = ['.desktop-titlebar', '.app-shell', '.main-content', '.page-heading', '.manual-workspace', '.product-editor', '.editor-content', '.inbox-workspace', '.inbox-panel', '.inbox-inspector', '.automatic-workspace', '.automatic-queue', '.automation-setup', '.results-workspace', '.result-row', '.operations-workspace', '.settings-panel', '.settings-layout', '.settings-module-content', '.appearance-row', '.image-generation-settings', '.ai-connection-column', '.ai-usage-column'];
    const overflow = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2).map(element => ({ selector, width: element.clientWidth, scroll: element.scrollWidth })));
    if (document.documentElement.scrollWidth > innerWidth + 2) overflow.push({ selector: 'document', width: innerWidth, scroll: document.documentElement.scrollWidth });
    return { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme, overflow };
  });
  layouts.push({ name, ...result });
  if (result.overflow.length) {
    console.log(`OVERFLOW ${name} ${JSON.stringify(result.overflow)}`);
    await screenshot(`overflow-${layouts.length}`);
  }
}
async function appearanceRadio(group, name) {
  const radio = page.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { name, exact: true });
  await radio.click(); await expect(radio).toHaveAttribute('aria-checked', 'true');
  await expect(radio).toBeEnabled();
}
async function theme(value) {
  if (await page.locator('html').getAttribute('data-theme') !== value) await button(value === 'dark' ? '切换到夜间模式' : '切换到日间模式').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', value);
  await expect.poll(() => page.evaluate(() => window.red.getAppearance().then(value => value.theme))).toBe(value);
  await expect(page.locator('.titlebar-theme')).toBeEnabled();
}

try {
  await launch();
  assert.deepEqual((await page.evaluate(() => Object.keys(window.red))).sort(), [...publicApi].sort());
  assert.deepEqual(await page.evaluate(() => window.red.getAppearance()), defaults);
  for (const invalid of [null, {}, { ...defaults, theme: 'sepia' }, { ...defaults, density: 'huge' }, { ...defaults, motion: false }, { ...defaults, extra: true }]) {
    await assert.rejects(page.evaluate(value => window.red.saveAppearance(value), invalid));
    assert.deepEqual(await page.evaluate(() => window.red.getAppearance()), defaults);
  }
  const direct = { theme: 'dark', density: 'compact', motion: 'reduced' };
  assert.deepEqual(await page.evaluate(value => window.red.saveAppearance(value), direct), direct);
  assert.deepEqual(await page.evaluate(() => window.red.getAppearance()), direct);
  await page.evaluate(value => window.red.saveAppearance(value), defaults);
  const sample = await page.evaluate(async () => {
    await window.red.loadWorkspaceExamples('inbox');
    await window.red.loadWorkspaceExamples('automatic');
    await window.red.loadExamples();
    const target = await window.red.enableAmazonDemo();
    const products = await window.red.listProducts(), placements = await window.red.listWorkspacePlacements();
    return { target, products, placements };
  });
  assert.equal(sample.products.length, 6);
  await page.reload(); await expect(page.locator('.collection-row')).toHaveCount(2);
  await resizeWindow(app, page, 1480, 960);
  await screenshot('day-inbox-1480');
  pass('real preload/IPC appearance reads, exact validation, saves and local sample seeding');

  await theme('dark'); await nav('手动上架');
  await expect(page.locator('.product-editor')).toBeVisible();
  await screenshot('night-manual-1480');
  await nav('设置'); await module('appearance');
  await screenshot('night-appearance-1480');
  await appearanceRadio('界面主题', '日间');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await screenshot('day-appearance-1480');
  pass('initial day/night screenshots captured with the native window hidden');

  await appearanceRadio('界面主题', '跟随系统');
  await page.emulateMedia({ colorScheme: 'dark' }); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' }); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await appearanceRadio('界面主题', '日间');
  await page.emulateMedia({ colorScheme: null, reducedMotion: 'no-preference' });
  const density = page.getByRole('radiogroup', { name: '信息密度', exact: true });
  await density.getByRole('radio', { name: '舒适', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(density.getByRole('radio', { name: '紧凑', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(density.getByRole('radio', { name: '紧凑', exact: true })).toBeEnabled();
  await expect(density.getByRole('radio', { name: '紧凑', exact: true })).toBeFocused();
  await appearanceRadio('信息密度', '舒适');
  pass('settings theme controls, system color scheme and keyboard-accessible density save through IPC');

  // Pointer events are sent to the hidden test renderer, never to the user's app.
  assert.equal(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches), true);
  await page.getByRole('heading', { name: '界面主题', exact: true }).click();
  const glow = page.locator('.titlebar-theme'), box = await glow.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .25);
  await expect(glow).not.toHaveAttribute('data-glass-lit');
  const flat = await glow.evaluate(element => { const style = getComputedStyle(element); return { radius: style.borderRadius, background: style.backgroundImage, shadow: style.boxShadow }; });
  assert.deepEqual(flat, { radius: '4px', background: 'none', shadow: 'none' });
  await page.keyboard.press('Tab'); await expect(glow).not.toHaveAttribute('data-glass-lit');
  await appearanceRadio('动态效果', '减少动态');
  await page.mouse.move(box.x + box.width * .3, box.y + box.height * .3);
  await expect(glow).not.toHaveAttribute('data-glass-lit');
  const reduced = await glow.evaluate(element => ({ transition: getComputedStyle(element).transitionDuration, light: getComputedStyle(element, '::after').display }));
  assert.ok(reduced.transition.split(',').every(value => parseFloat(value) === 0)); assert.equal(reduced.light, 'none');
  await appearanceRadio('动态效果', '标准');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .7);
  await expect(glow).not.toHaveAttribute('data-glass-lit');
  assert.equal(await glow.evaluate(element => getComputedStyle(element, '::after').display), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  pass('flat controls have no pointer lighting; keyboard, preference and OS reduced motion remain supported');

  // Force a genuine AppearanceStore filesystem failure only inside this test's
  // fresh mkdtemp directory; rmdir removes only this exact empty fixture folder.
  const appearanceFile = join(dataRoot, 'appearance.json'), priorFile = join(dataRoot, 'appearance.retry-backup.json');
  const beforeFailure = JSON.parse(await readFile(appearanceFile, 'utf8'));
  await rename(appearanceFile, priorFile); await mkdir(appearanceFile);
  try {
    await page.getByRole('radiogroup', { name: '界面主题', exact: true }).getByRole('radio', { name: '夜间', exact: true }).click();
    await expect(page.locator('.appearance-save-state')).toContainText('外观设置未保存');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally {
    await rmdir(appearanceFile); await rename(priorFile, appearanceFile);
  }
  assert.deepEqual(JSON.parse(await readFile(appearanceFile, 'utf8')), beforeFailure);
  await button('重试保存').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => window.red.getAppearance().then(value => value.theme))).toBe('dark');
  await expect(page.locator('.appearance-save-state')).toContainText('外观设置已保存到本机');
  assert.equal(JSON.parse(await readFile(appearanceFile, 'utf8')).theme, 'dark');
  pass('failed appearance write keeps the displayed preference and retry saves the originally attempted theme');

  await nav('自动上架'); await button('管理商品与定价规则').click();
  await expect(page.locator('#settings-nav-product')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: '商品填报规则', exact: true })).toBeVisible();
  await nav('手动上架'); await page.getByRole('tab', { name: /^图片工作区/ }).click();
  await button('图片接口').click(); await expect(page.locator('#settings-nav-images')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('form', { name: 'OpenAI 生图连接配置' })).toContainText('未配置');
  await button('刷新状态').click(); await expect(button('刷新状态')).toBeEnabled();
  const generation = (await page.evaluate(() => window.red.listAiCapabilities())).find(item => item.capability === 'image-generation');
  assert.deepEqual({ available: generation.available, providerId: generation.providerId }, { available: false, providerId: 'openai-images' });
  await button('管理 OCR 与分割连接').click(); await expect(page.locator('#settings-nav-ai')).toHaveAttribute('aria-current', 'page');
  await page.locator('.connection-shortcut').click(); await expect(page.locator('#settings-nav-amazon')).toHaveAttribute('aria-current', 'page');
  await module('appearance'); await nav('商品数据'); await button('去连接店铺').click();
  await expect(page.locator('#settings-nav-amazon')).toHaveAttribute('aria-current', 'page');
  pass('automatic rules and image-entry deep links reach real settings; OpenAI image generation stays unavailable before configuration');

  // Seed valid demo drafts through the same reviewed API used by the editor.
  // Automatic UI must reuse them and run the actual demo validation service.
  const automaticIds = sample.placements.filter(row => row.lane === 'automatic').map(row => row.productId);
  const source = sample.products.find(row => automaticIds.includes(row.id) && row.title === '棉质抽绳收纳袋');
  assert.ok(source);
  const seeded = await page.evaluate(async ({ productId, targetId }) => {
    const product = await window.red.getProduct(productId), drafts = [];
    for (const variant of product.variants) {
      let draft = await window.red.createAmazonDraft({ productId, variantId: variant.id, targetId, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US', listingProgram: 'standard' });
      const market = draft.marketplaceId;
      draft = await window.red.saveAmazonDraft({ id: draft.id, revision: draft.revision, attributes: { ...draft.attributes,
        item_name: [{ value: 'Appearance test storage bag', marketplace_id: market }], brand: [{ value: 'Local Demo Brand', marketplace_id: market }], color: [{ value: 'White', marketplace_id: market }],
        purchasable_offer: [{ marketplace_id: market, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 4.99 }] }] }],
      } }); drafts.push(draft);
    }
    return drafts;
  }, { productId: source.id, targetId: sample.target.id });
  await nav('自动上架');
  const automatic = page.locator('[aria-label="启动自动上架"]');
  await automatic.getByTestId(`automatic-select-${source.id}`).check();
  await automatic.getByRole('combobox', { name: /目标店铺与站点/ }).selectOption(sample.target.id);
  await expect(automatic.getByRole('button', { name: '启动并自动发布', exact: true })).toBeDisabled();
  // This fixture has no confirmed source-image evidence or provider credentials.
  // The current service must reject field completion before spending or publishing.
  for (const draft of seeded) await assert.rejects(page.evaluate(input => window.red.completeAmazonFields(input), { draftId: draft.id, draftRevision: draft.revision }), /当前来源图片与规格尚未确认一致/);
  const validated = await page.evaluate(id => window.red.listAmazonDrafts(id), source.id);
  assert.equal(validated.length, seeded.length); assert.ok(validated.every(draft => draft.state === seeded.find(original => original.id === draft.id).state && draft.submittedAt === null));
  assert.equal((await page.evaluate(() => window.red.listAiCalls())).length, 0);
  assert.equal((await page.evaluate(() => window.red.listAutomaticListingTasks())).length, 0);
  pass('automatic start remains gated; missing source-image confirmation blocks field completion, preserves drafts and makes no AI calls');

  await nav('设置'); await module('appearance');
  await appearanceRadio('界面主题', '夜间'); await appearanceRadio('信息密度', '紧凑'); await appearanceRadio('动态效果', '减少动态');
  const persisted = await page.evaluate(() => window.red.getAppearance());
  assert.deepEqual(persisted, { theme: 'dark', density: 'compact', motion: 'reduced' });
  await close(); await launch();
  assert.deepEqual(await page.evaluate(() => window.red.getAppearance()), persisted);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  assert.equal((await page.evaluate(() => window.red.listProducts())).length, 6);
  assert.equal((await page.evaluate(() => window.red.listAmazonTargets())).length, 1);
  await nav('设置'); await module('appearance'); await appearanceRadio('信息密度', '舒适'); await appearanceRadio('动态效果', '标准');
  pass('theme, density and motion persist across a real hidden Electron restart with products and demo target intact');

  for (const mode of ['light', 'dark']) {
    await theme(mode);
    for (const [width, height] of [[1480, 960], [1080, 850], [760, 680]]) {
      await resizeWindow(app, page, width, height);
      for (const name of views) { await nav(name); await layout(`${mode}/${width}/${name}`); }
      for (const id of modules) { await module(id); await layout(`${mode}/${width}/settings-${id}`); }
      await module('appearance');
      if (width !== 1480) await screenshot(`${mode}-appearance-${width}`);
      await nav('自动上架'); if (width === 760) await screenshot(`${mode}-automatic-${width}`);
      console.log(`LAYOUT ${mode} ${width}: 10 workspaces and 9 settings modules checked`);
    }
  }
  pass('all 10 workspaces and 9 settings modules visited in both themes at 1480, 1080 and 760 widths');
  const invalidLayouts = layouts.filter(item => item.overflow.length);
  assert.deepEqual(invalidLayouts, [], 'Unexpected horizontal overflow; see report and overflow screenshots');
  assert.ok((await page.evaluate(() => window.red.listAmazonCalls())).every(call => call.mode === 'demo'));
  assert.equal((await page.evaluate(() => window.red.listAiCalls())).length, 0);
  assert.equal((await page.evaluate(() => window.red.listExecutionTasks())).length, 0);
  await close(); assert.deepEqual(remoteRequests, []); assert.deepEqual(errors, []);
  pass('zero external requests, paid AI calls, publishing tasks, renderer errors or visible test windows');
  succeeded = true;
} catch (error) {
  failure = error.stack || String(error); console.error(failure);
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
} finally {
  await close().catch(error => { errors.push(`cleanup: ${error.message}`); });
  const report = { passed: succeeded, startedAt, finishedAt: new Date().toISOString(), dataRoot, build, checks, layouts, screenshots, errors, remoteRequests, failure, processLog, environment: 'separate hidden Electron; real preload, IPC and local services; Amazon demo only; no window.red mocks' };
  const stamp = startedAt.replace(/[:.]/g, '-');
  await writeFile(join(artifacts, `report-${stamp}.json`), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`REPORT ${join(artifacts, 'report.json')}`);
  if (!succeeded) process.exitCode = 1;
}
