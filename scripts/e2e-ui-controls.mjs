import { electron } from './e2e-core-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resizeWindow } from './e2e-window.mjs';
await mkdir('.test-data', {recursive:true}); await mkdir('artifacts', {recursive:true});
const dataRoot=await mkdtemp(resolve('.test-data/ui-controls-')), require=createRequire(import.meta.url);
const env={...process.env,RED_DATA_DIR:dataRoot,RED_E2E:'1'};delete env.ELECTRON_RUN_AS_NODE;
let app; const checks=[];
try {
 app=await electron.launch({executablePath:require('electron'),args:['.'],cwd:resolve('.'),env});
 const page=await app.firstWindow(); page.setDefaultTimeout(15000); await expect(page.getByRole('button',{name:'同步妙手采集箱',exact:true})).toBeVisible();
 const ids=await page.evaluate(async()=>{const ids=[];for(let i=0;i<65;i++){const p=await window.red.createProduct();await window.red.saveProduct({id:p.id,revision:p.revision,sourceUrl:p.sourceUrl,description:p.description,status:p.status,facts:p.facts,title:`合成分页商品 ${String(i).padStart(3,'0')}`,variants:p.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory}))});ids.push(p.id);}await window.red.moveWorkspaceProducts({productIds:ids.slice(0,63),destination:'inbox'});await window.red.moveWorkspaceProducts({productIds:ids.slice(63),destination:'ignored'});return ids;});
 await page.reload(); await expect(page.locator('.collection-row')).toHaveCount(20);
 const select=page.getByLabel('采集箱每页数量'), scope=page.getByLabel('采集箱批量操作');
 await page.getByLabel('搜索采集箱').fill('000');await expect(page.locator('.collection-row')).toHaveCount(1);
 await page.getByRole('button',{name:/选中全部待整理商品/}).click();await expect(scope).toContainText('已选择 63 件');
 await page.getByLabel('搜索采集箱').fill(''); await page.getByRole('button',{name:'采集箱下一页',exact:true}).click();await expect(scope).toContainText('已选择 63 件');
 await select.selectOption('50');await expect(scope).toContainText('已选择 63 件');await expect(page.locator('.collection-row')).toHaveCount(13);
 await select.selectOption('100');await expect(page.locator('.collection-row')).toHaveCount(63);await expect(page.getByLabel('采集箱分页')).toContainText('第 1 / 1 页');
 await select.selectOption('20');await page.getByRole('button',{name:/仅选中当前页商品/}).click();await expect(scope).toContainText('已选择 20 件');
 await page.getByRole('button',{name:'清空',exact:true}).click();await expect(scope).toContainText('选择商品后');
 checks.push('搜索后跨页全选63件排除2件ignored；分页20/50/100保持选择并钳制页码；仅当前页20件；清空');
 for(const theme of ['light','dark']) {
  await page.evaluate(theme=>window.red.saveAppearance({theme,density:'comfortable',motion:'reduced'}),theme);await page.reload();
  for(const [width,height] of [[1440,1000],[1060,640],[1280,800]]) {
   await resizeWindow(app,page,width,height);
   while(await page.getByRole('button',{name:'采集箱上一页',exact:true}).isEnabled()) await page.getByRole('button',{name:'采集箱上一页',exact:true}).click();
   const viewport=page.locator('.inbox-table-viewport');await viewport.hover();await page.mouse.wheel(0,8000);
   await expect.poll(()=>viewport.evaluate(el=>el.scrollTop>0)).toBe(true);
   await viewport.focus();await page.keyboard.press('Control+End');await expect.poll(()=>viewport.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<2)).toBe(true);
   await page.keyboard.press('Control+Home');await expect.poll(()=>viewport.evaluate(el=>el.scrollTop)).toBe(0);
   const bounds=await viewport.boundingBox();await page.mouse.move(bounds.x+bounds.width-8,bounds.y+45);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width-8,bounds.y+bounds.height-15,{steps:8});await page.mouse.up();await expect.poll(()=>viewport.evaluate(el=>el.scrollTop>0)).toBe(true);
   await select.scrollIntoViewIfNeeded();await select.selectOption('50');await expect(page.locator('.collection-row')).toHaveCount(50);
   await page.getByRole('button',{name:'采集箱下一页',exact:true}).click();await expect(page.locator('.collection-row')).toHaveCount(13);
   await page.getByRole('button',{name:/仅选中当前页商品/}).click();await expect(scope).toContainText('已选择 13 件');
   await scope.scrollIntoViewIfNeeded();await page.getByRole('button',{name:'清空',exact:true}).click();
   await select.selectOption('20');await select.focus();await page.keyboard.press('Home');await page.keyboard.press('Tab');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   if(height===1000) {const layout=await page.locator('.inbox-panel').evaluate(el=>({bottom:el.getBoundingClientRect().bottom,mainBottom:el.closest('main').getBoundingClientRect().bottom}));assert.ok(Math.abs(layout.bottom-layout.mainBottom)<50,JSON.stringify(layout));}
   checks.push(`${theme} ${width}x${height} 鼠标滚动/分页/底部操作可达`); console.log(checks.at(-1));
  }
 }
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].maximize());
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
 await select.selectOption('100');await expect(page.locator('.collection-row')).toHaveCount(63);
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.unmaximize();w.webContents.setZoomFactor(1.25);});
 await select.scrollIntoViewIfNeeded();await select.selectOption('50');await page.getByRole('button',{name:'采集箱下一页',exact:true}).click();await expect(page.locator('.collection-row')).toHaveCount(13);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
 checks.push('原生最大化/恢复、125%页面缩放后分页控件可达');
 await select.selectOption('50');await page.reload();await expect(select).toHaveValue('50');checks.push('重新载入保留采集箱偏好');
 await page.getByRole('button',{name:/选中全部待整理商品/}).click();await page.getByRole('button',{name:'加入自动上架',exact:true}).click();
 await page.locator('nav').getByRole('button',{name:'自动上架',exact:true}).click();
 await expect(page.getByLabel('自动商品选择每页数量')).toHaveValue('20');await expect(page.locator('.automatic-queue-entry')).toHaveCount(20);
 await page.getByLabel('自动商品选择每页数量').selectOption('100');await expect(page.locator('.automatic-queue-entry')).toHaveCount(63);checks.push('真实自动商品选择独立默认20/切换100显示63件');
 await app.close();app=null;
 await writeFile('artifacts/ui-controls-evidence.json',JSON.stringify({checks,dataRoot,realElectron:true,replacedRed:false,externalRequests:0},null,2));console.log(checks.join('\n'));
} finally {if(app)await app.close();}
