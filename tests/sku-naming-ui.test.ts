import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';

test('SKU settings supports copied templates, live preview, default selection and store bindings', { timeout: 45000 }, async t => {
  assert.ok(existsSync(resolve('src/renderer/SkuNamingSettings.tsx')), 'SKU settings editor must exist');
  await mkdir(resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(resolve('.test-data/sku-naming-ui-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  t.after(async () => {
    if (app) {
      // A failed assertion may leave the real unsaved-change guard active.
      await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
      await app.close().catch(() => {});
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await writeFile(join(root, 'fixture.tsx'), `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { SkuNamingSettings } from '../../src/renderer/SkuNamingSettings';
    import { defaultSkuNamingSettings } from '../../src/shared/sku-naming';
    import '../../src/renderer/styles.css';
    const fixture = window.fixture = { saves: 0, value: defaultSkuNamingSettings(), stale: false };
    const api = { getSkuNamingSettings: async () => structuredClone(fixture.value),
      saveSkuNamingSettings: async value => { if(fixture.stale) throw Error('SKU 命名规则已被更改，请刷新后再保存'); fixture.saves++; fixture.value = {...structuredClone(value), revision: fixture.value.revision + 1}; return structuredClone(fixture.value); },
      previewSkuNaming: async () => { throw Error('live preview must remain local'); } };
    const targets = [{id:'target-2',name:'测试店铺 U2',sellerId:'seller-2',mode:'live'}];
    createRoot(document.getElementById('root')).render(<SkuNamingSettings api={api} busy={false} run={async (_label, task) => task()} targets={targets}/>);
  `);
  await build({ entryPoints: [join(root, 'fixture.tsx')], bundle: true, outfile: join(root, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, logLevel: 'silent' });
  await writeFile(join(root, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  await writeFile(join(root, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron'); app.setPath('userData',${JSON.stringify(join(root, 'profile'))}); app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true})); const win=new BrowserWindow({width:1250,height:1000,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const require = createRequire(import.meta.url), env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  env.electron_config_cache = resolve('.cache/electron');
  app = await electron.launch({ executablePath: require('electron') as string, args: [join(root, 'main.cjs')], cwd: resolve('.'), env, timeout: 20000 });
  const page = await app.firstWindow(), errors: string[] = [];
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByLabel('父体或独立 SKU 预览')).toHaveText('H2-261008-1');
  await expect(page.getByLabel('流水号补零位数')).toHaveValue('1');
  await page.getByRole('button', { name: '复制当前模板', exact: true }).click();
  await page.getByLabel('模板名称', { exact: true }).fill('自定义模板');
  await page.getByLabel('U2 前缀', { exact: true }).fill('COPY');
  await expect(page.getByLabel('父体或独立 SKU 预览')).toHaveText('COPY-261008-1');
  await page.getByLabel('流水号补零位数').fill('5');
  await expect(page.getByLabel('父体或独立 SKU 预览')).toHaveText('COPY-261008-00001');
  await page.getByLabel('日期格式').selectOption('yyyymmdd');
  await expect(page.getByLabel('父体或独立 SKU 预览')).toHaveText('COPY-20261008-00001');
  await page.getByLabel('父体与独立款模板').fill('{prefix}/{date}/{sequence}');
  await expect(page.getByRole('alert')).toContainText('SKU');
  await expect(page.getByRole('button', { name: '保存 SKU 命名规则', exact: true })).toBeDisabled();
  await page.getByLabel('父体与独立款模板').fill('{prefix}-{date}-{sequence}');
  await page.getByRole('button', { name: '设为默认模板', exact: true }).click();
  await page.getByLabel('测试店铺 U2 使用店铺编号').selectOption('U2');
  await page.getByLabel('测试店铺 U2 使用 SKU 模板').selectOption({ label: '自定义模板' });
  await page.getByRole('button', { name: '保存 SKU 命名规则', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  const saved = await page.evaluate(() => (window as unknown as { fixture: { saves: number; value: { templates: unknown[]; defaultTemplateId: string; bindings: { templateId: string; targetId: string }[] } } }).fixture);
  assert.equal(saved.saves, 1); assert.equal(saved.value.templates.length, 2);
  assert.equal(saved.value.bindings[0].targetId, 'target-2');
  assert.equal(saved.value.bindings[0].templateId, saved.value.defaultTemplateId);
  await page.evaluate(() => { (window as unknown as { fixture: { stale: boolean } }).fixture.stale = true; });
  await page.getByLabel('模板名称', { exact: true }).fill('未保存修改');
  await page.getByRole('button', { name: '保存 SKU 命名规则', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('刷新');
  await page.getByRole('button', { name: '放弃修改并重新读取', exact: true }).click();
  await expect(page.getByLabel('模板名称', { exact: true })).toHaveValue('自定义模板');
  await page.getByRole('button', { name: '新建模板', exact: true }).click();
  await expect(page.getByLabel('模板名称', { exact: true })).toHaveValue('新模板');
  await page.getByLabel('新增店铺编号', { exact: true }).fill('U9');
  await page.getByLabel('新增 SKU 前缀', { exact: true }).fill('H9');
  await page.getByRole('button', { name: '添加前缀', exact: true }).click();
  assert.deepEqual(errors, []);
  await page.getByLabel('预览店铺').selectOption('U9');
  await expect(page.getByLabel('父体或独立 SKU 预览')).toHaveText('H9-261008-1');
  await page.getByLabel('U9 默认使用模板').selectOption({ label: '新模板' });
  const desktopShot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(resolve('.test-data/sku-naming-settings-desktop.png'), Buffer.from(desktopShot, 'base64'));
  await page.setViewportSize({ width: 520, height: 950 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'settings must fit the narrow window');
  const narrowShot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(resolve('.test-data/sku-naming-settings-narrow.png'), Buffer.from(narrowShot, 'base64'));
  assert.deepEqual(errors, []);
});
