import { createRequire } from 'node:module';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchGuarded } from './release-runtime.mjs';
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/ui-keyboard-scale',{recursive:true});
const dataRoot=await mkdtemp(resolve('.test-data/ui-keyboard-scale-'));
const app=await launchGuarded({executable:createRequire(import.meta.url)('electron'),args:['.','--force-device-scale-factor=1.25'],cwd:resolve('.'),dataRoot,guardPath:resolve('scripts/release-network-guard.cjs')});
const checks=[],errors=[];
try{
 const page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const ratio=await page.evaluate(()=>devicePixelRatio);assert.equal(ratio,1.25);
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1280,800);w.webContents.backgroundThrottling=false;});
 await page.locator('.primary-navigation').getByRole('button',{name:'设置',exact:true}).click();await page.locator('#settings-nav-sku').click();
 const input=page.getByLabel('模板名称',{exact:true});await expect(input).not.toHaveValue('');const original=await input.inputValue();await input.fill('125% keyboard fixture');
 await page.locator('.primary-navigation').getByRole('button',{name:'采集箱',exact:true}).click();const dialog=page.getByRole('dialog',{name:'有未保存的修改'});await expect(dialog).toBeVisible();
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(input).toHaveValue('125% keyboard fixture');
 await page.locator('.primary-navigation').getByRole('button',{name:'采集箱',exact:true}).click();await expect(dialog).toBeVisible();
 const buttons=dialog.getByRole('button');await buttons.last().focus();await page.keyboard.press('Tab');await expect(buttons.first()).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(buttons.last()).toBeFocused();await page.getByRole('button',{name:'继续编辑',exact:true}).click();await input.fill(original);
 checks.push('125% renderer device scale: Escape preserves draft; modal Tab/Shift+Tab traps focus; cancel returns to editor');
 await page.locator('#settings-nav-appearance').click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'放弃修改',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);const theme=page.getByRole('radiogroup',{name:'界面主题'});await theme.getByRole('radio',{name:'跟随系统',exact:true}).click();
 await expect(theme.getByRole('radio',{name:'跟随系统',exact:true})).toHaveAttribute('aria-checked','true');
 await page.emulateMedia({colorScheme:null});
 await app.evaluate(({nativeTheme})=>{nativeTheme.themeSource='dark';});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await app.evaluate(({nativeTheme})=>{nativeTheme.themeSource='light';});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await page.getByRole('radio',{name:'减少动态',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-motion','reduced');
 const density=page.getByRole('radiogroup',{name:'信息密度'});await density.getByRole('radio',{name:'舒适',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.locator('html')).toHaveAttribute('data-density','compact');await expect(density.getByRole('radio',{name:'紧凑',exact:true})).toBeFocused();
 checks.push('system theme follows actual nativeTheme light/dark; keyboard changes density; reduced motion persisted');
 await page.locator('#settings-nav-ai').click();await page.locator('[data-ai-purpose="listing_title"]').scrollIntoViewIfNeeded();
 for(const size of [[1280,800],[1600,1000]]){
  await app.evaluate(({BrowserWindow},size)=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(...size);},size);
  await page.locator('[data-ai-purpose="listing_title"]').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
  const pixels=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));
  await writeFile('artifacts/ui-keyboard-scale/scale125-'+size.join('x')+'.png',Buffer.from(pixels,'base64'));
 }
 const externalAttempts=await app.evaluate(()=>globalThis.__releaseGuard.attempts);assert.deepEqual(externalAttempts,[]);assert.deepEqual(errors,[]);
 await writeFile('artifacts/ui-keyboard-scale/result.json',JSON.stringify({dataRoot,devicePixelRatio:ratio,checks,errors,externalAttempts},null,2));console.log(checks);
}finally{await app.evaluate(({app})=>app.exit(0));await app.close();}
