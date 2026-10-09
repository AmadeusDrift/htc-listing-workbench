import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resizeWindow } from './e2e-window.mjs';

await mkdir(resolve('.test-data'), { recursive: true });
await mkdir(resolve('artifacts'), { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/connections-e2e-'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url);
const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const secret = 'fixture-connection-secret-no-network', client = 'fixture-connection-client';
const checks = [], errors = []; let app, page, completed = false;
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const button = name => page.getByRole('button', { name, exact: true });
async function settingsModule(id) {
  await expect(page.locator('.settings-panel')).toBeVisible();
  const nav = page.locator(`#settings-nav-${id}`);
  await expect(nav).toBeAttached();
  if (await nav.isVisible()) await nav.click();
  else await page.locator('.settings-module-select select').selectOption(id);
}
async function launch() {
  app = await electron.launch({ executablePath: process.env.RED_E2E_EXECUTABLE || require('electron'), args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: resolve('.'), env, timeout: 35000 });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling = false; });
  await expect(button('设置')).toBeEnabled(); await button('设置').click();
  await settingsModule('ai');
}
async function snapshot(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
  const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(resolve('artifacts', name), Buffer.from(data, 'base64'));
}
async function vendor(id) {
  await page.getByLabel('AI 连接供应商', { exact: true }).selectOption(id);
  await expect(page.getByLabel('AI 连接供应商', { exact: true })).toBeEnabled();
}
try {
  await launch();
  await expect(page.getByLabel('AI 连接供应商', { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByLabel('AI 连接供应商', { exact: true }).locator('option')).toHaveText(['DeepSeek', '阿里云']);
  const ai = page.getByRole('form', { name: 'AI 连接配置' });
  await expect(ai.getByLabel('API Key', { exact: true })).toHaveCount(1);
  // Existing users may already have different per-role credentials. Never unify silently.
  await page.evaluate(async () => {
    await window.red.saveAiProviderConfig({ id: 'deepseek', model: 'deepseek-flash', apiKey: 'legacy-generation-key-fixture' });
    await window.red.saveAiProviderConfig({ id: 'deepseek-review', model: 'deepseek-v4-pro', apiKey: 'legacy-review-key-fixture' });
    await window.red.setAiProviderEnabled({ id: 'deepseek', enabled: true });
    await window.red.setAiUsagePolicy({ providerId: 'deepseek', dailyCallLimit: 100, dailyTokenLimit: 100000 });
    await window.red.setAiUsagePolicy({ providerId: 'deepseek-review', dailyCallLimit: 500, dailyTokenLimit: 500000 });
  });
  const legacy = await page.evaluate(() => window.red.listAiProviders());
  await button('操作记录').click(); await button('设置').click();
  await settingsModule('ai');
  await expect(ai).toContainText('旧配置分别保存');
  assert.deepEqual(await page.evaluate(() => window.red.listAiProviders()), legacy);
  await ai.getByLabel('复用已有密钥来源', { exact: true }).selectOption('deepseek-review');
  await button('复用已有密钥').click(); await expect(ai).toContainText('已共用凭据');
  await expect(ai.getByLabel('API Key', { exact: true })).toHaveValue('');
  assert.deepEqual((await page.evaluate(() => window.red.listAiProviders())).map(({ generation, ...profile }) => profile), legacy.map(({ generation, ...profile }) => profile));
  await expect(page.getByLabel('每日调用次数预设', { exact: true })).toHaveValue('100');
  await page.getByLabel('AI 用量服务', { exact: true }).selectOption('deepseek-review');
  await expect(page.getByLabel('每日调用次数预设', { exact: true })).toHaveValue('500');
  pass('供应商只有两项；旧独立密钥不自动覆盖，明确选定后复用，无需重填，预算与功能设置保留');

  await ai.getByLabel('文案生成模型', { exact: true }).selectOption('deepseek-v4-pro');
  await expect(ai.getByLabel('文案生成模型', { exact: true })).toBeEnabled();
  await ai.getByLabel('文案复核模型', { exact: true }).selectOption('deepseek-flash');
  await expect(ai.getByLabel('文案复核模型', { exact: true })).toBeEnabled();
  await button('启用文案复核').click(); await expect(button('暂停文案复核')).toBeEnabled();
  await button('暂停文案生成').click(); await expect(button('启用文案生成')).toBeEnabled();
  await expect(button('暂停文案复核')).toBeEnabled();
  const roles = (await page.evaluate(() => window.red.listAiProviders())).filter(profile => profile.id.startsWith('deepseek'));
  assert.deepEqual(roles.map(({ id, model, enabled }) => ({ id, model, enabled })), [
    { id: 'deepseek', model: 'deepseek-v4-pro', enabled: false }, { id: 'deepseek-review', model: 'deepseek-flash', enabled: true },
  ]);
  await ai.getByLabel('API Key', { exact: true }).fill(secret);
  await page.getByLabel('AI 用量服务', { exact: true }).selectOption('deepseek');
  await expect(ai.getByLabel('API Key', { exact: true })).toHaveValue(secret);
  await button('保存共享密钥').click(); await expect(ai.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(button('启用文案生成')).toBeEnabled(); await expect(button('暂停文案复核')).toBeEnabled();
  assert.equal((await page.evaluate(() => window.red.listAiConnections())).find(connection => connection.id === 'deepseek').state, 'shared');
  await ai.scrollIntoViewIfNeeded(); await snapshot('connections-ai.png');
  pass('DeepSeek 一次填写共享密钥；生成与复核独立选模型和启停，切换用量功能不清空输入');

  await vendor('aliyun');
  await expect(ai.getByLabel('AccessKey ID', { exact: true })).toHaveCount(1);
  await ai.getByLabel('AccessKey ID', { exact: true }).fill(client);
  await ai.getByLabel('AccessKey Secret', { exact: true }).fill(secret);
  await ai.getByLabel('Security Token（可选）', { exact: true }).fill('fixture-optional-security-token');
  await button('保存共享密钥').click(); await expect(ai).toContainText('已共用凭据');
  await expect(button('启用OCR 文字识别')).toBeEnabled(); await expect(button('启用图片分割')).toBeEnabled(); await expect(button('启用图片侵权风险检测')).toBeEnabled();
  await button('启用OCR 文字识别').click(); await expect(button('暂停OCR 文字识别')).toBeEnabled();
  await expect(button('启用图片分割')).toBeEnabled();
  await button('启用图片分割').click(); await expect(button('暂停图片分割')).toBeEnabled();
  await button('启用图片侵权风险检测').click(); await expect(button('暂停图片侵权风险检测')).toBeEnabled();
  await expect(ai).toContainText('图片审核增强版');
  assert.ok((await ai.locator('input[type=password]').evaluateAll(nodes => nodes.map(node => node.value))).every(value => !value));
  await button('清除共享密钥').click(); await expect(ai).toContainText('尚未配置');
  const cleared = await page.evaluate(() => window.red.listAiConnections());
  assert.ok(cleared.find(connection => connection.id === 'aliyun').profiles.every(profile => !profile.enabled && !profile.configured));
  assert.equal(cleared.find(connection => connection.id === 'deepseek').state, 'shared');
  await ai.getByLabel('AccessKey ID', { exact: true }).fill(client);
  await ai.getByLabel('AccessKey Secret', { exact: true }).fill(secret);
  await button('保存共享密钥').click(); await expect(ai).toContainText('已共用凭据');
  await ai.scrollIntoViewIfNeeded(); await snapshot('connections-aliyun.png');
  pass('阿里云一次填写共享 AccessKey，OCR、分割与侵权检测独立启停，清除连接影响三项功能且不影响 DeepSeek');

  const templateFile = join(dataRoot, 'shared-connection-template.json');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, templateFile);
  await ai.getByText('也可以导入配置文件', { exact: true }).click();
  await button('保存 AI 连接模板').click();
  await expect(ai).toContainText('空白连接模板已保存');
  assert.deepEqual(JSON.parse(await readFile(templateFile, 'utf8')), { id: 'aliyun', accessKeyId: '', accessKeySecret: '', securityToken: '' });
  const importFile = join(dataRoot, 'legacy-review-config.json');
  await writeFile(importFile, JSON.stringify({ id: 'deepseek-review', model: 'deepseek-v4-pro', apiKey: secret }));
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, importFile);
  await button('导入 AI 连接配置').click();
  await expect(page.getByLabel('AI 连接供应商', { exact: true })).toHaveValue('deepseek');
  await expect(ai).toContainText('已共用凭据');
  await expect(ai.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(ai.getByLabel('文案复核模型', { exact: true })).toHaveValue('deepseek-v4-pro');
  await expect(button('启用文案生成')).toBeEnabled(); await expect(button('暂停文案复核')).toBeEnabled();
  pass('供应商模板不含密钥，旧单功能配置可经原生文件选择导入共享连接，自动切换供应商且保留启停');

  const miaoshou = page.getByRole('form', { name: '妙手连接配置' });
  await settingsModule('collection');
  await miaoshou.getByLabel('AppKey', { exact: true }).fill(client);
  await miaoshou.getByLabel('AppSecret', { exact: true }).fill(secret);
  await button('保存妙手连接').click();
  await expect(page.getByLabel('妙手采集设置')).toContainText('配置已加密保存');
  await expect(miaoshou.getByLabel('AppSecret', { exact: true })).toHaveValue('');
  const ms = await page.evaluate(() => window.red.getMiaoshouStatus());
  assert.equal(ms.configured, true); assert.equal(ms.mode, 'live'); assert.ok(!JSON.stringify(ms).includes(secret));
  await miaoshou.scrollIntoViewIfNeeded(); await snapshot('connections-miaoshou.png');
  pass('妙手直接填写 AppKey / AppSecret，保存后仅返回脱敏状态');

  const amazon = page.getByRole('form', { name: 'Amazon 连接配置' });
  await settingsModule('amazon');
  await amazon.getByLabel('店铺名称', { exact: true }).fill('表单连接测试店铺');
  await amazon.getByLabel('Seller ID', { exact: true }).fill('FORM_TEST_SELLER');
  await amazon.getByLabel('LWA Client ID', { exact: true }).fill(client);
  await amazon.getByLabel('LWA Client Secret', { exact: true }).fill(secret);
  await amazon.getByLabel('Refresh Token', { exact: true }).fill('fixture-amazon-refresh-token');
  await button('保存 Amazon 连接').click();
  await expect(page.locator('.amazon-connection').filter({ hasText: '表单连接测试店铺' })).toBeVisible();
  assert.ok((await amazon.locator('input[type=password]').evaluateAll(nodes => nodes.map(node => node.value))).every(value => !value));
  const targets = await page.evaluate(() => window.red.listAmazonTargets());
  assert.equal(targets.length, 1); assert.equal(targets[0].configured, true); assert.equal(targets[0].mode, 'live');
  assert.equal(JSON.stringify(targets).includes(secret), false);
  await amazon.scrollIntoViewIfNeeded(); await snapshot('connections-amazon.png');
  pass('Amazon 直接填写应用与店铺授权，保存后清空敏感字段');

  const profiles = await page.evaluate(() => window.red.listAiProviders());
  await assert.rejects(page.evaluate(() => window.red.saveAiProviderConfig({ id: 'deepseek', model: 'deepseek-flash', apiKey: 'bad' })));
  await assert.rejects(page.evaluate(() => window.red.saveAiConnection({ id: 'aliyun', apiKey: 'wrong-credential-family' })));
  await assert.rejects(page.evaluate(() => window.red.reuseAiConnection({ id: 'aliyun', sourceId: 'deepseek' })));
  await assert.rejects(page.evaluate(() => window.red.saveMiaoshouConfig({ appKey: 'invalid', appSecret: 'invalid' })));
  await assert.rejects(page.evaluate(() => window.red.saveAmazonCredentials({ name: 'missing-required-fields' })));
  assert.deepEqual(await page.evaluate(() => window.red.listAiProviders()), profiles);
  assert.deepEqual(await page.evaluate(() => window.red.getMiaoshouStatus()), ms);
  assert.deepEqual(await page.evaluate(() => window.red.listAmazonTargets()), targets);
  assert.deepEqual(await page.evaluate(() => window.red.listAiCalls()), []);
  assert.deepEqual(await page.evaluate(() => window.red.listAmazonCalls()), []);
  for (const directory of ['ai-vault', 'miaoshou-vault', 'amazon-vault']) {
    for (const file of await readdir(join(dataRoot, directory))) assert.equal((await readFile(join(dataRoot, directory, file))).includes(secret), false);
  }
  assert.equal((await readFile(join(dataRoot, 'red.sqlite'))).includes(secret), false);
  assert.equal(JSON.stringify(await page.evaluate(() => window.red.listAudit())).includes(secret), false);
  assert.equal(await page.locator('body').innerText().then(value => value.includes(secret)), false);
  pass('无效配置不覆盖已有连接，使用系统加密，保存不触发 AI 或 Amazon 调用');

  await app.close(); app = null; await launch();
  assert.deepEqual(await page.evaluate(() => window.red.listAiProviders()), profiles);
  assert.deepEqual(await page.evaluate(() => window.red.getMiaoshouStatus()), ms);
  assert.deepEqual(await page.evaluate(() => window.red.listAmazonTargets()), targets);
  await expect(page.getByLabel('当前应用版本')).toHaveText(`v${pkg.version}`);
  pass('重启保留三类连接，首页版本与实际包元数据一致');
  await resizeWindow(app, page, 640, 850);
  await expect(page.getByLabel('当前应用版本')).toBeVisible();
  for (const name of ['AI 连接配置', '妙手连接配置', 'Amazon 连接配置']) {
    await settingsModule(name==='AI 连接配置'?'ai':name==='妙手连接配置'?'collection':'amazon');
    const form = page.getByRole('form', { name }); await form.scrollIntoViewIfNeeded();
    assert.ok(await form.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  }
  await settingsModule('ai');
  await vendor('aliyun');
  const narrowAi = page.getByRole('form', { name: 'AI 连接配置' });
  await narrowAi.scrollIntoViewIfNeeded();
  assert.ok(await narrowAi.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await snapshot('connections-narrow.png');
  assert.deepEqual(errors, []); completed = true;
  pass('窄窗口下三类配置表单无横向溢出');
} catch (error) { errors.push(error.message); throw error; }
finally {
  await app?.close();
  await writeFile(resolve(`artifacts/${process.env.RED_E2E_EXECUTABLE ? 'packaged-' : ''}connections-e2e.json`), JSON.stringify({ passed: completed, checks, errors, dataRoot, at: new Date().toISOString() }, null, 2));
}
