import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchGuarded } from './release-runtime.mjs';
const require=createRequire(import.meta.url),output=resolve('artifacts/navigation-context');
await mkdir(output,{recursive:true});await mkdir(resolve('.test-data'),{recursive:true});
const dataRoot=await mkdtemp(resolve('.test-data/navigation-context-'));let app;const checks=[],errors=[];checks.push=(...items)=>{console.log(...items);return Array.prototype.push.apply(checks,items);};
try {
 app=await launchGuarded({executable:require('electron'),args:['.'],dataRoot,guardPath:resolve('scripts/release-network-guard.cjs'),cwd:resolve('.')});
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling=false;});
 const page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await expect(page.getByRole('button',{name:'新建商品',exact:true})).toBeEnabled();
 const ids=await page.evaluate(async()=>{await window.red.loadExamples();await window.red.enableAmazonDemo();const targets=await window.red.listAmazonTargets();const product=await window.red.getProduct((await window.red.listProducts())[0].id);const draft=await window.red.createAmazonDraft({productId:product.id,variantId:product.variants[0].id,targetId:targets[0].id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});await window.red.moveWorkspaceProducts({productIds:[product.id],destination:'automatic'});return{product:product.id,draft:draft.id};});
 await page.reload();
 const nav=async(name)=>page.locator('.primary-navigation').getByRole('button',{name,exact:true}).click();
 await nav('上架进度');await page.getByTestId('result-'+ids.draft).getByRole('button',{name:'手动处理'}).click();
 await expect(page.locator('.page-heading h1')).toHaveText('手动上架');
 assert.equal(await page.evaluate(async id=>(await window.red.listWorkspacePlacements()).find(p=>p.productId===id).lane,ids.product),'automatic');checks.push('open exact result draft without moving automatic placement');
 await nav('设置');await page.locator('#settings-nav-sku').click();const name=page.getByLabel('模板名称',{exact:true});const original=await name.inputValue();await name.fill('合成未保存名称');
 await page.locator('#settings-nav-appearance').click();await expect(page.getByRole('dialog',{name:'有未保存的修改'})).toBeVisible();await page.getByRole('button',{name:'继续编辑',exact:true}).click();await expect(name).toHaveValue('合成未保存名称');checks.push('SKU F08 module navigation cancel preserves input');
 await page.locator('#settings-nav-appearance').click();await page.getByRole('button',{name:'放弃修改',exact:true}).click();await page.locator('#settings-nav-sku').click();await expect(name).toHaveValue(original);checks.push('discard restores persisted SKU form');
 await name.fill('合成已保存名称');await page.locator('#settings-nav-appearance').click();await page.getByRole('button',{name:'保存后继续',exact:true}).click();await expect(page.locator('#settings-nav-appearance')).toHaveAttribute('aria-current','page');await page.locator('#settings-nav-sku').click();await expect(name).toHaveValue('合成已保存名称');checks.push('save succeeds before module navigation');
 await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('red:sku-naming:save');ipcMain.handle('red:sku-naming:save',()=>{throw new Error('合成保存失败');});});
 await name.fill('失败仍保留输入');await nav('采集箱');await page.getByRole('button',{name:'保存后继续',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog')).toContainText('合成保存失败');await page.getByRole('button',{name:'继续编辑',exact:true}).click();await expect(name).toHaveValue('失败仍保留输入');checks.push('failed save prevents page navigation and preserves input');
 for(const theme of ['light','dark']) {if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:theme==='dark'?'切换到夜间模式':'切换到日间模式',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await name.focus();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));const pixels=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));await writeFile(join(output,theme+'-sku-guard.png'),Buffer.from(pixels,'base64'));}
 await nav('采集箱');await page.getByRole('button',{name:'放弃修改',exact:true}).click();
 await nav('上架进度');await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('red:amazon:drafts');ipcMain.handle('red:amazon:drafts',()=>({ok:true,data:[]}));});
 await page.getByTestId('result-'+ids.draft).getByRole('button',{name:'手动处理'}).click();await expect(page.getByRole('alert')).toContainText('目标草稿已不存在');await expect(page.locator('.page-heading h1')).toHaveText('上架进度');checks.push('missing exact draft remains on source, no fallback');
 assert.deepEqual(errors,[]);const safety=await app.evaluate(()=>globalThis.__releaseGuard.attempts);assert.deepEqual(safety,[]);
 await writeFile(join(output,'result.json'),JSON.stringify({dataRoot,checks,errors,safety},null,2));console.log('PASS '+checks.length+' navigation/guard checks '+output);
} catch(error) { console.error(error); throw error; } finally {if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close();}}



