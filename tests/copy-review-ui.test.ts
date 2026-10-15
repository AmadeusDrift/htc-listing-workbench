import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';

test('copy review setting saves independently, refreshes automatic status and preserves failed-save state', { timeout: 45000 }, async t => {
  await mkdir(resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(resolve('.test-data/copy-review-ui-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  t.after(async () => {
    if (app) await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await writeFile(join(root, 'fixture.tsx'), `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ImageGenerationSettings } from '../../src/renderer/ImageGenerationSettings';
    import { AutomaticPreparationPanel } from '../../src/renderer/AutomaticPreparationPanel';
    import { defaultListingRules } from '../../src/shared/listing-rules';
    import '../../src/renderer/styles.css';
    const fixture = window.fixture = { copy: true, risk: true, copySaves: 0, riskSaves: 0, changes: 0, fail: false, hold: false, release: null };
    window.addEventListener('copy-review-settings-changed', () => fixture.changes++);
    window.red = {
      queryAutomaticTaskSummaries:async()=>({rows:[],total:0,page:1,pageSize:20,active:false,lifecycleSignature:'empty'}),
      getImageGenerationSpendStatus:async()=>{const empty={reportedUsdMicros:0,heldUsdMicros:0,unboundedCalls:0,anomaly:false,limitUsdMicros:null,policyUpdatedAt:null,remainingUsdMicros:null,pendingCalls:0,unknownCalls:0};return{currency:'USD',unit:'microUSD',daily:empty,controlledLifetime:{...empty,limitUsdMicros:5000000,remainingUsdMicros:5000000},controlledRunStatus:'not-registered',quoteStatus:'not-checked'};},
      getAppearanceReviewSettings:async()=>({enabled:true}), saveAppearanceReviewSettings:async value=>value,
      getAutomaticBatchPlan:async()=>({version:1,credentialScope:'a'.repeat(64),purposes:[],coverage:[]}),
      getCopyReviewSettings: async () => ({enabled: fixture.copy}),
      saveCopyReviewSettings: async value => { fixture.copySaves++; if(fixture.fail) throw Error('测试：保存失败'); if(fixture.hold) await new Promise(resolve => fixture.release = resolve); fixture.copy = value.enabled; return {enabled: fixture.copy}; },
      getImageRiskSettings: async () => ({enabled: fixture.risk}),
      saveImageRiskSettings: async value => { fixture.riskSaves++; fixture.risk = value.enabled; return {enabled: fixture.risk}; },
      getImageGenerationConnection: async () => ({provider:'openrouter',activeProvider:'openrouter',model:'openai/gpt-image-2.5-sunburst',enabled:false,size:'auto',quality:'auto',configured:false,credentialState:'absent',accessCheck:'not-checked'}),
      getImageGenerationModels: async () => ({models:[]}),
      listAiCapabilities: async () => ['text','image-generation','ocr','image-risk'].map(capability=>({capability,available:true})),
      getListingRules: async () => defaultListingRules(), listFtpProfiles: async () => [], listAutomaticListingTasks: async () => []
    };
    createRoot(document.getElementById('root')).render(<><ImageGenerationSettings visible={true} busy={false} onAiSettings={()=>{}}/><AutomaticPreparationPanel products={[]} taskProducts={[]} targets={[]} targetId="" onTargetChange={()=>{}} queue={null} queueLoading={false} queueError="" onRefreshQueue={()=>{}} busy={false} onManual={()=>{}} onSettings={()=>{}} onExamples={()=>{}} onInbox={()=>{}}/></>);
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
  const copySwitch = page.getByRole('switch', { name: '启用文案复核', exact: true });
  const riskSwitch = page.getByRole('switch', { name: '启用图片风险拦截', exact: true });
  const automatic = page.getByRole('group', { name: '全局自动化连接', exact: true });
  await expect(automatic).toHaveAttribute('open');
  await expect(copySwitch).toBeChecked();
  await expect(riskSwitch).toBeChecked();
  await expect(automatic).toContainText('文案复核：已开启');
  await copySwitch.click();
  await expect(copySwitch).not.toBeChecked();
  await expect(automatic).toContainText('文案复核：已关闭');
  await expect(automatic).toContainText('待配置或启用：复核用途');
  await expect(automatic).toContainText('首图无字检查');
  await expect(riskSwitch).toBeChecked();
  assert.deepEqual(await page.evaluate(() => {
    const value = (window as unknown as { fixture: { copySaves: number; riskSaves: number; changes: number } }).fixture;
    return { copySaves: value.copySaves, riskSaves: value.riskSaves, changes: value.changes };
  }), { copySaves: 1, riskSaves: 0, changes: 1 });
  await page.evaluate(() => { (window as unknown as { fixture: { fail: boolean } }).fixture.fail = true; });
  await copySwitch.click();
  await expect(page.getByRole('alert')).toHaveText('测试：保存失败');
  await expect(copySwitch).not.toBeChecked();
  await expect(automatic).toContainText('文案复核：已关闭');
  await page.evaluate(() => { const fixture = (window as unknown as { fixture: { fail: boolean; hold: boolean } }).fixture; fixture.fail = false; fixture.hold = true; });
  await copySwitch.click();
  await expect(copySwitch).toBeDisabled();
  await expect(copySwitch).not.toBeChecked();
  await page.evaluate(() => { (window as unknown as { fixture: { release: () => void } }).fixture.release(); });
  await expect(copySwitch).toBeEnabled();
  await expect(copySwitch).toBeChecked();
  await expect(automatic).toContainText('文案复核：已开启');
  await expect(riskSwitch).toBeChecked();
  assert.equal(await page.evaluate(() => (window as unknown as { fixture: { changes: number } }).fixture.changes), 2);
  assert.deepEqual(errors, []);
});
