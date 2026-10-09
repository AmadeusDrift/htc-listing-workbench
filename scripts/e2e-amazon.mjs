import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { publicApi } from './api-surface.mjs';
import { resizeWindow } from './e2e-window.mjs';
import { selectSettingsModule } from './e2e-settings.mjs';

const root = resolve('.');
await mkdir(resolve('.test-data'), { recursive: true }); await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/amazon-e2e-'));
const fixtures = join(dataRoot, 'fixtures'); await mkdir(fixtures);
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url), executablePath = process.env.RED_E2E_EXECUTABLE || require('electron');
const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], processLog = [], layouts = [];
let app, page;
function passed(name) { checks.push(name); console.log(`PASS ${name}`); }
async function launch() {
  app = await electron.launch({ executablePath, args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: root, env, timeout: 35000 });
  app.process().stderr.on('data', chunk => processLog.push(chunk.toString()));
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling = false; });
  await page.waitForFunction(() => !!window.red && document.querySelector('button'));
  await expect(page.getByRole('button', { name: '新建商品', exact: true }).first()).toBeEnabled();
}
async function button(name) { await page.getByRole('button', { name, exact: true }).click(); }
async function tab(name) { const target = page.getByRole('tab', { name }); await target.click(); await expect(target).toHaveAttribute('aria-selected', 'true'); }
async function chooseOpen(path) { await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path); }
async function chooseSave(path) { await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, path); }
async function confirm(response) { await app.evaluate(({ dialog }, value) => { dialog.showMessageBox = async (_window, options) => { globalThis.__lastConfirmation = options; return { response: value, checkboxChecked: false }; }; }, response); }
async function draft(productId) { return page.evaluate(id => window.red.listAmazonDrafts(id).then(rows => rows[0]), productId); }
async function screenshot(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(resolve('artifacts', name), Buffer.from(bytes, 'base64'));
}
async function layout(name) {
  const result = await page.evaluate(() => {
    const selectors = ['.main-content', '.product-editor', '.editor-content', '.amazon-workflow', '.listing-setup', '.schema-fields', '.schema-object-grid', '.utility-panel', '.amazon-settings', '.backup-settings', '.amazon-connections'];
    const overflow = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(el => el.scrollWidth > el.clientWidth + 2).map(() => selector));
    if (document.documentElement.scrollWidth > innerWidth) overflow.push('document');
    const spacing = [...document.querySelectorAll('.listing-publish, .listing-setup, .credential-form')].flatMap(card => {
      const bounds = card.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return [];
      return [...card.querySelectorAll('.button')].filter(button => button.checkVisibility()).map(button => {
        const rect = button.getBoundingClientRect();
        return { card: card.className, button: button.textContent, left: rect.left - bounds.left, right: bounds.right - rect.right, bottom: bounds.bottom - rect.bottom };
      }).filter(gap => gap.left < 12 || gap.right < 12 || gap.bottom < 12);
    });
    return { width: innerWidth, height: innerHeight, overflow, spacing };
  });
  assert.deepEqual(result.overflow, [], `${name}: unexpected horizontal overflow`);
  assert.deepEqual(result.spacing, [], `${name}: buttons touch their container edges`); layouts.push({ name, ...result });
}
try {
  await launch();
  assert.deepEqual((await page.evaluate(() => Object.keys(window.red))).sort(), [...publicApi].sort());
  await button('载入示例商品');
  await expect.poll(() => page.evaluate(() => window.red.listProducts().then(rows => rows.length))).toBe(2);
  const product = (await page.evaluate(() => window.red.listProducts())).find(row => row.title === '棉质抽绳收纳袋'); assert.ok(product);
  await page.getByTestId(`product-${product.id}`).click(); await tab('上架检查');
  await button('启用本地演示'); await expect(page.getByRole('button', { name: '获取字段并建草稿', exact: true })).toBeEnabled();
  await button('获取字段并建草稿'); await expect(page.getByTestId('amazon-draft')).toBeVisible();
  const initial = await draft(product.id);
  assert.equal(initial.mode, 'demo'); assert.equal(initial.attributes.purchasable_offer, undefined);
  await button('本地 Schema 校验'); await expect.poll(async () => (await draft(product.id)).state).toBe('BLOCKED');
  await expect(page.getByRole('button', { name: '演示提交', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '回读 Listing 状态', exact: true })).toBeDisabled();
  assert.ok((await draft(product.id)).localIssues.some(issue => issue.attributeNames.includes('brand')));
  passed('动态 Schema 建草稿、缺失字段阻止提交、采购价不会自动填入销售价');

  await button('属性 JSON');
  const market = initial.marketplaceId;
  const attributes = { ...initial.attributes, item_name: [{ value: 'E2E storage bag', marketplace_id: market }], brand: [{ value: 'E2E explicitly confirmed brand', marketplace_id: market }], color: [{ value: 'White', marketplace_id: market }], purchasable_offer: [{ marketplace_id: market, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 4.99 }] }] }] };
  const json = page.getByLabel('Amazon attributes JSON', { exact: true }); await json.fill(JSON.stringify(attributes, null, 2));
  await page.getByRole('tab', { name: '商品资料' }).click();
  await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible(); await button('继续编辑');
  await expect(json).toHaveValue(JSON.stringify(attributes, null, 2));
  await button('保存上架草稿'); await expect.poll(async () => (await draft(product.id)).attributes.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax).toBe(4.99);
  await button('字段表单');
  await expect(page.getByLabel('Amazon 字段 brand[0].value', { exact: true })).toHaveValue(attributes.brand[0].value);
  await page.getByLabel('Amazon 字段 purchasable_offer[0].audience', { exact: true }).selectOption(JSON.stringify('BZR'));
  await button('保存上架草稿'); await expect.poll(async () => (await draft(product.id)).attributes.purchasable_offer[0].audience).toBe('BZR');
  await page.getByLabel('Amazon 字段 purchasable_offer[0].audience', { exact: true }).selectOption(JSON.stringify('ALL'));
  await button('本地 Schema 校验'); await expect.poll(async () => (await draft(product.id)).state).toBe('LOCAL_VALIDATED');
  passed('JSON 与递归表单同步、保留枚举代码、上架草稿离开保护');

  const titleField = page.getByLabel('Amazon 字段 item_name[0].value', { exact: true }); await titleField.fill('resize-preserved draft');
  for (const [width, height] of [[1920, 1080], [1480, 960], [1280, 800], [1100, 760], [900, 680], [760, 620], [640, 560]]) {
    await resizeWindow(app, page, width, height);
    await expect(titleField).toHaveValue('resize-preserved draft'); await layout(`上架字段 ${width}`);
    if (width === 640 || width === 1480) {
      await page.locator('.amazon-workflow').scrollIntoViewIfNeeded(); await screenshot(`amazon-fields-${width}.png`);
      await page.locator('.listing-publish').scrollIntoViewIfNeeded(); await screenshot(`ui-feedback-publish-${width}.png`);
    }
  }
  await titleField.fill('E2E storage bag'); await expect(page.getByRole('button', { name: '保存上架草稿', exact: true })).toBeDisabled();

  await button('演示验证预览'); await expect.poll(async () => (await draft(product.id)).state).toBe('AMAZON_VALIDATED');
  await confirm(0); await button('演示提交'); await expect(page.getByText('已取消提交，草稿保持不变。', { exact: true })).toBeVisible();
  assert.equal((await draft(product.id)).state, 'AMAZON_VALIDATED');
  const native = await app.evaluate(() => globalThis.__lastConfirmation); assert.ok(native.detail.includes(initial.sellerId) && native.detail.includes(market)); assert.equal(native.defaultId, 0);
  await confirm(1); await button('演示提交'); await expect.poll(async () => (await draft(product.id)).state).toBe('SUBMITTED');
  assert.deepEqual((await draft(product.id)).statuses, []);
  await button('回读 Listing 状态'); await expect.poll(async () => (await draft(product.id)).state).toBe('BUYABLE');
  assert.deepEqual((await draft(product.id)).statuses.sort(), ['BUYABLE', 'DISCOVERABLE']);
  assert.ok((await page.evaluate(() => window.red.listAmazonCalls())).every(call => call.mode === 'demo'));
  passed('明确演示模式、原生取消/确认、接受与可售状态分离、回读可售与可见');

  await expect(titleField).toBeDisabled();
  await expect(page.getByRole('button', { name: '本地 Schema 校验', exact: true })).toBeDisabled();
  await button('设置'); await selectSettingsModule(page, 'data'); await expect(page.getByLabel('备份口令', { exact: true })).toBeVisible();
  await page.locator('.credential-advanced').evaluateAll(details => details.forEach(detail => { detail.open = true; }));
  for (const [width, height] of [[1920, 1080], [1480, 960], [1280, 800], [1100, 760], [900, 680], [760, 620], [640, 560]]) {
    await resizeWindow(app, page, width, height);
    for (const module of ['amazon', 'data']) {
      await selectSettingsModule(page, module); await layout(`${module} 设置 ${width}`);
      if (width === 640 || width === 1480) { await page.getByRole('heading', { name: '工作区设置', exact: true }).scrollIntoViewIfNeeded(); await screenshot(`${module}-settings-${width}.png`); }
    }
  }
  await resizeWindow(app, page, 1480, 960);
  await selectSettingsModule(page, 'amazon');
  passed('新增工作区七种窗口尺寸自适应，缩放保留上架草稿');

  const credentials = { name: '隔离测试店铺', sellerId: 'E2ESELLER', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en_US', clientId: 'TEST_ONLY_CLIENT_ID_9d2fa', clientSecret: 'TEST_ONLY_SECRET_7cdb9', refreshToken: 'TEST_ONLY_REFRESH_6a179' };
  const configFile = join(fixtures, 'dummy-credentials.json'); await writeFile(configFile, JSON.stringify(credentials)); await chooseOpen(configFile); await button('导入授权配置');
  await expect.poll(() => page.evaluate(() => window.red.listAmazonTargets().then(rows => rows.some(t => t.name === '隔离测试店铺')))).toBe(true);
  const targets = await page.evaluate(() => window.red.listAmazonTargets()), live = targets.find(t => t.mode === 'live'); assert.ok(live);
  const vault = await readFile(join(dataRoot, 'amazon-vault', `${live.id}.bin`));
  for (const value of [credentials.clientId, credentials.clientSecret, credentials.refreshToken]) {
    assert.equal(vault.includes(Buffer.from(value)), false); assert.equal(JSON.stringify(targets).includes(value), false); assert.equal((await page.locator('body').innerText()).includes(value), false);
    for (const file of await readdir(dataRoot)) if (/^red\.sqlite(?:-wal|-shm)?$/.test(file)) assert.equal((await readFile(join(dataRoot, file))).includes(Buffer.from(value)), false);
  }
  assert.equal((await page.evaluate(() => window.red.getSettings())).amazonStatus, 'configured');
  passed('真实 Windows safeStorage 加密、无密钥 getter、授权信息不进入页面和 SQLite');

  const backupFile = join(fixtures, 'workspace.htcbackup'); await chooseSave(backupFile);
  await selectSettingsModule(page, 'data');
  await page.getByLabel('备份口令', { exact: true }).fill('E2E backup passphrase 2026'); await page.getByLabel('确认备份口令', { exact: true }).fill('E2E backup passphrase 2026');
  await button('创建加密备份'); await expect(page.getByText(/已备份 2 件商品/)).toBeVisible();
  const backupBytes = await readFile(backupFile); assert.ok(backupBytes.subarray(0, 12).toString().startsWith('HTC-BACKUP-1')); assert.equal(backupBytes.includes(Buffer.from(product.title)), false);
  await chooseOpen(backupFile); await page.getByLabel('备份口令', { exact: true }).fill('incorrect passphrase 2026'); await button('从备份恢复');
  await expect(page.getByRole('alert')).toContainText('口令不正确'); await button('关闭错误提示');
  await page.getByLabel('备份口令', { exact: true }).fill('E2E backup passphrase 2026'); await confirm(0); await button('从备份恢复');
  await expect(page.getByRole('button', { name: '从备份恢复', exact: true })).toBeEnabled(); assert.equal((await page.evaluate(() => window.red.listProducts())).length, 2);
  passed('桌面加密备份、错误口令和取消恢复保持原工作区');

  await page.evaluate(() => window.red.createProduct()); assert.equal((await page.evaluate(() => window.red.listProducts())).length, 3);
  await confirm(1); const closed = app.waitForEvent('close', { timeout: 30000 }); await button('从备份恢复'); await closed; app = undefined;
  await launch(); assert.equal((await page.evaluate(() => window.red.listProducts())).length, 2);
  const restoredTargets = await page.evaluate(() => window.red.listAmazonTargets()); const restoredLive = restoredTargets.find(t => t.mode === 'live');
  assert.equal(restoredLive.configured, false); assert.equal(restoredLive.paused, true);
  const restored = await draft(product.id); assert.equal(restored.state, 'BUYABLE'); assert.equal(restored.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 4.99);
  assert.ok((await page.evaluate(() => window.red.listAudit())).some(event => event.action === 'workspace.restore.completed'));
  await button('手动上架');
  await page.getByTestId(`product-${product.id}`).click(); await tab('图片工作区');
  await expect.poll(() => page.locator('.asset-card img').evaluateAll(imgs => imgs.length === 3 && imgs.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
  await tab('上架检查'); await expect(page.getByTestId('amazon-draft')).toContainText('演示 · 可售');
  await expect(page.locator('.listing-image-grid img')).toHaveCount(3);
  passed('确认恢复后真实退出重启、完整商品/图片/草稿保留、旧授权不会自动重连');
  assert.deepEqual(errors, []); passed('无 renderer 运行或资源加载错误');
  await writeFile(resolve('artifacts/amazon-e2e-report.json'), JSON.stringify({ passed: true, checks, layouts, errors, dataRoot, executablePath, at: new Date().toISOString() }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await screenshot('amazon-e2e-failure.png').catch(() => {});
  await writeFile(resolve('artifacts/amazon-e2e-report.json'), JSON.stringify({ passed: false, checks, layouts, errors, processLog, dataRoot, executablePath, failure: String(error), at: new Date().toISOString() }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  if (app) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
    await app.close().catch(() => {});
  }
}
