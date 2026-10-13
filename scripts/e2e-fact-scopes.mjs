import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
const require=createRequire(import.meta.url),root=resolve('.');
await mkdir(resolve('.test-data'),{recursive:true});await mkdir(resolve('artifacts'),{recursive:true});
const dir=await mkdtemp(resolve('.test-data/e2e-fact-scopes-')),env={...process.env,RED_DATA_DIR:dir,RED_E2E:'1'};delete env.ELECTRON_RUN_AS_NODE;
let app;const errors=[];
try{
  app=await electron.launch({executablePath:require('electron'),args:['.'],cwd:root,env,timeout:35000});const page=await app.firstWindow();
  page.on('pageerror',e=>errors.push(e.message));
  await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling=false;});
  await page.getByRole('button',{name:'新建商品',exact:true}).first().click();
  await page.getByLabel('商品标题',{exact:true}).fill('范围隔离合成商品');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.getByRole('tab',{name:'SKU 与规格',exact:false}).click();
  await page.getByRole('button',{name:'添加 SKU',exact:true}).click();
  await page.getByLabel('SKU 2',{exact:true}).fill('SCOPE-SECOND');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.locator('#tab-info').click();
  for(const [index,value,scope] of [[1,'Cotton','variant'],[2,'Wash gently','common'],[3,'Unverified scent','unknown']]){
    await page.getByRole('button',{name:'添加事实',exact:true}).click();
    await page.getByLabel(`事实名称 ${index}`,{exact:true}).fill(index===1?'材质':index===2?'护理说明':'香味');
    await page.getByLabel(`事实内容 ${index}`,{exact:true}).fill(value);
    await page.getByLabel(`事实范围 ${index}`,{exact:true}).selectOption(scope);
  }
  const p=await page.evaluate(async()=>{const p=(await window.red.listProducts()).find(p=>p.title==='范围隔离合成商品');return window.red.getProduct(p.id);});
  await page.getByLabel('事实适用 SKU 1',{exact:true}).selectOption(p.variants[1].id);
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect.poll(async()=>page.evaluate(id=>window.red.getProduct(id).then(p=>p.facts.length),p.id)).toBe(3);
  const saved=await page.evaluate(id=>window.red.getProduct(id),p.id);
  assert.equal(saved.facts[0].variantId,p.variants[1].id);assert.equal(saved.facts[1].scope,'common');assert.equal(saved.facts[2].scope,'unknown');
  await page.reload();
  await page.waitForFunction(()=>!!window.red);
  await page.getByRole('button',{name:'手动上架',exact:true}).click();
  await page.getByTestId(`product-${p.id}`).click();
  await page.locator('#tab-info').click();await expect(page.getByLabel('事实范围 1',{exact:true})).toHaveValue('variant');
  await expect(page.getByLabel('事实适用 SKU 1',{exact:true})).toHaveValue(p.variants[1].id);
  await page.getByLabel('事实范围 1',{exact:true}).scrollIntoViewIfNeeded();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
  await page.getByLabel('事实范围 1',{exact:true}).scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const screenshot=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(resolve('artifacts/e2e-fact-scopes.png'),Buffer.from(screenshot,'base64'));
  assert.deepEqual(errors,[]);
  await writeFile(resolve('artifacts/e2e-fact-scopes.json'),JSON.stringify({passed:true,dataDirectory:dir,facts:saved.facts},null,2));console.log('PASS real Electron scope selection, SKU binding, save and reload');
}finally{await app?.close();}
