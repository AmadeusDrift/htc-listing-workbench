import { launchGuarded } from './release-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
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
 await page.locator('#settings-nav-data').click({force:true});
 await expect(page.getByText('当前没有自动清理。只有确认预览后才删除未被引用的候选素材。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'预览素材清理',exact:true}).click({force:true});
 await expect(page.getByText('候选 0 个文件',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'确认执行此清理预览',exact:true})).toBeDisabled();
 const orphan=resolve(dataRoot,'assets/11111111-1111-4111-8111-111111111111.png');
 await mkdir(resolve(dataRoot,'assets'),{recursive:true}); await writeFile(orphan,'offline orphan fixture');
 await page.getByRole('button',{name:'预览素材清理',exact:true}).click({force:true});
 await expect(page.getByText('候选 1 个文件',{exact:false})).toBeVisible();await access(orphan);
 await page.getByRole('button',{name:'确认执行此清理预览',exact:true}).click({force:true});
 await expect(page.getByText('已删除 1 个文件',{exact:false})).toBeVisible();await assert.rejects(access(orphan));
 checks.push('真实预览不删除，确认执行后仅合成孤立素材删除');
 await page.getByLabel('备份口令',{exact:true}).fill('fixture-password');
 await page.locator('.primary-navigation').getByRole('button',{name:'采集箱',exact:true}).click({force:true});
 await expect(page.getByRole('button',{name:'继续编辑',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'继续编辑',exact:true}).click({force:true});
 await expect(page.getByLabel('备份口令',{exact:true})).toHaveValue('fixture-password');
 await page.getByLabel('备份口令',{exact:true}).fill('');
 checks.push('引用清理真实空预览、无自动清理说明、空计划禁止执行、备份口令导航保护');
 await writeFile('artifacts/w12/result.json',JSON.stringify({dataRoot,checks},null,2));
 console.log(checks);
} finally {await app.close();}



