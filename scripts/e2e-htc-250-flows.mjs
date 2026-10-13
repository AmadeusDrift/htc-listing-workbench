import { launchGuarded } from './release-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require=createRequire(import.meta.url);
await mkdir('.test-data',{recursive:true}); await mkdir('artifacts/w12',{recursive:true});
const dataRoot=await mkdtemp(resolve('.test-data/w12-'));
const app=await launchGuarded({executable:require('electron'),args:['.'],cwd:resolve('.'),dataRoot,guardPath:resolve('scripts/release-network-guard.cjs')});
const checks=[];
try {
 const page=await app.firstWindow();page.setDefaultTimeout(10000);
 await page.locator('.primary-navigation').getByRole('button',{name:'设置',exact:true}).click({force:true});
 await page.locator('#settings-nav-images').click({force:true});
 const toggle=page.getByRole('switch',{name:'启用外观一致性复核'});
 await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked(); await toggle.click({force:true});
 await expect(page.getByText('已关闭 · 未执行外观复核',{exact:true})).toBeVisible();
 assert.deepEqual(await page.evaluate(()=>window.red.getAppearanceReviewSettings()),{enabled:false});
 assert.equal((await page.evaluate(()=>window.red.getCopyReviewSettings())).enabled,true);
 await page.reload();await page.locator('.primary-navigation').getByRole('button',{name:'设置',exact:true}).click({force:true});await page.locator('#settings-nav-images').click({force:true});
 await expect(page.getByRole('switch',{name:'启用外观一致性复核'})).not.toBeChecked();
 await page.screenshot({path:'artifacts/w12/appearance.png'});checks.push('真实IPC默认开启、关闭持久化、独立于文案复核、重载及未执行文案');
 await writeFile('artifacts/w12/result.json',JSON.stringify({dataRoot,checks},null,2));
 console.log(checks);
} finally {await app.close();}


