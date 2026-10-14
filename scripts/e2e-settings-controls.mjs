import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {expect} from '@playwright/test';
import {launchGuarded} from './release-runtime.mjs';
await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data/settings-controls-'));
const checks=[],timings=[],errors=[];let app;
try{
 app=await launchGuarded({executable:process.env.HTC_TEST_EXE||createRequire(import.meta.url)('electron'),args:process.env.HTC_TEST_EXE?[]:['.'],dataRoot:root,guardPath:resolve('scripts/release-network-guard.cjs'),cwd:resolve('.')});
 const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setSize(1440,1000);w.showInactive();globalThis.__controlLag=[];let prior=performance.now();globalThis.__controlTimer=setInterval(()=>{const now=performance.now();globalThis.__controlLag.push(now-prior);prior=now;},20);});
 await expect(page.getByRole('button',{name:'新建商品',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('#settings-nav-ai').click();
 const vendor=page.getByLabel('AI 连接供应商',{exact:true});await expect(vendor).toBeEnabled();
 // Actual native select opening and keyboard dismissal, not selectOption alone.
 for(let i=0;i<4;i++){const start=performance.now();await vendor.click();await page.keyboard.press('Escape');await page.getByRole('form',{name:'AI 连接配置'}).getByLabel('API Key',{exact:true}).click();timings.push({operation:'native select open/dismiss then focus',ms:performance.now()-start});}
 const key=page.getByRole('form',{name:'AI 连接配置'}).getByLabel('API Key',{exact:true});
 await key.fill('synthetic-never-saved-key');await expect(key).toHaveValue('synthetic-never-saved-key');await key.fill('');
 checks.push('Native dropdown opening/dismissal and unsaved synthetic key input stay interactive');
 for(let i=0;i<3;i++){const start=performance.now();await page.locator('.primary-navigation').getByRole('button',{name:'自动上架',exact:true}).click();await expect(page.getByRole('heading',{name:'自动上架任务',exact:true})).toBeVisible();await page.locator('.primary-navigation').getByRole('button',{name:'设置',exact:true}).click();await page.locator('#settings-nav-ai').click();await expect(vendor).toBeEnabled();timings.push({operation:'automatic/settings roundtrip',ms:performance.now()-start});}
 checks.push('Repeated settings/automatic navigation completes with real main/preload/renderer');
 const state=await app.evaluate(()=>{clearInterval(globalThis.__controlTimer);return {guard:globalThis.__releaseGuard,mainTimerMaxMs:Math.max(...globalThis.__controlLag),mainTimerSamples:globalThis.__controlLag.length};});
 const calls=await page.evaluate(()=>window.red.listAiCalls());assert.deepEqual(calls,[]);assert.deepEqual(state.guard.attempts,[]);assert.deepEqual(errors,[]);
 assert.ok(timings.every(t=>t.ms<5000),'Simple interaction must not stall for seconds');
 checks.push('Zero AI calls or outbound attempts; no saved key or real workspace use');
 const report={passed:true,root,checks,timings,errors,mainTimerMaxMs:state.mainTimerMaxMs,mainTimerSamples:state.mainTimerSamples,networkAttempts:state.guard.attempts,scope:'Visible inactive isolated window; synthetic empty workspace. Historical database query equivalence/latency is tested separately, not represented by this run.'};
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await app?.close();}
