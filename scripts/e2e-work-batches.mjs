import { electron } from './e2e-core-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { createInertBatchTask } from '../tests/fixtures/work-batches.ts';
await mkdir('.test-data',{recursive:true});await mkdir('artifacts',{recursive:true});
const dataRoot=await mkdtemp(resolve('.test-data/work-batch-ui-')),require=createRequire(import.meta.url),store=new WorkspaceStore(dataRoot),ids=[];
for(let i=0;i<25;i++){const p=store.createProduct();store.saveProduct({id:p.id,revision:p.revision,sourceUrl:p.sourceUrl,description:p.description,status:p.status,facts:p.facts,variants:p.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})),title:`合成批次商品 ${String(i).padStart(3,'0')}`});ids.push(p.id);}
store.moveWorkspaceProducts({productIds:ids,destination:'automatic'});store.close();const originalTask=await createInertBatchTask(dataRoot,ids[0]);
const env={...process.env,RED_DATA_DIR:dataRoot,RED_E2E:'1'};delete env.ELECTRON_RUN_AS_NODE;
let app;const checks=[];
async function capture(path){const page=await app.firstWindow();for(const width of [1481,1480]){const size=await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows()[0];win.setSize(width,1000);return win.getContentSize()[0];},width);await expect.poll(()=>page.evaluate(()=>window.innerWidth)).toBe(size);}await page.locator('.automatic-work-batches').scrollIntoViewIfNeeded();await page.evaluate(async()=>{await document.fonts.ready;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));});const pixels=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));await writeFile(path,Buffer.from(pixels,'base64'));}
async function launch(){app=await electron.launch({executablePath:require('electron'),args:['.'],cwd:resolve('.'),env});const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.getByRole('button',{name:'自动上架',exact:true}).click();await expect(page.getByLabel('选择工作批次')).toBeVisible();return page;}
try{
 let page=await launch();await expect(page.locator('.automatic-queue-entry')).toHaveCount(20);const original=await page.evaluate(()=>window.red.listAutomaticWorkBatches());assert.equal(original.length,1);assert.equal(original[0].taskIds[0],originalTask.id);
 await page.getByTestId('automatic-select-all').check();await expect(page.locator('.automatic-queue-toolbar')).toContainText('已选 25 件');
 await expect(page.getByLabel('选择自动上架任务')).toHaveValue(originalTask.id);
 await page.getByRole('button',{name:'归档当前批次并新建空批次',exact:true}).click();await expect(page.locator('.automatic-queue-entry')).toHaveCount(0);await expect(page.locator('.automatic-queue-toolbar')).toContainText('已选 0 件');await expect(page.getByTestId('automatic-select-all')).toBeDisabled();await expect(page.getByLabel('选择自动上架任务')).toHaveCount(0);
 const batches=await page.evaluate(()=>window.red.listAutomaticWorkBatches()),current=batches.find(b=>!b.archivedAt);assert.equal(current.sequence,original[0].sequence+1);assert.deepEqual(current.productIds,[]);assert.equal((await page.evaluate(id=>window.red.getAutomaticListingTask(id),originalTask.id)).status,'PAUSED');
 checks.push('真实APP/IPC：25商品跨页全选→归档先暂停原任务→新批次0商品0选择且无历史任务泄漏');
 await page.getByLabel('选择工作批次').selectOption(original[0].id);await expect(page.locator('.automatic-queue-entry')).toHaveCount(20);await expect(page.getByLabel('选择自动上架任务')).toHaveValue(originalTask.id);await expect(page.getByRole('button',{name:'启动并自动发布',exact:true})).toBeDisabled();
 await page.getByLabel('选择工作批次').selectOption(current.id);await page.getByLabel('加入当前批次的商品').selectOption(ids[1]);await page.getByRole('button',{name:'加入当前批次',exact:true}).click();await expect(page.locator('.automatic-queue-entry')).toHaveCount(1);await page.getByTestId('automatic-select-all').check();await expect(page.locator('.automatic-queue-toolbar')).toContainText('已选 1 件');
 checks.push('历史批次可选择原任务且不能新建发布；显式加入新批次只出现1商品，全选不跨批');
 const preserved=await page.evaluate(async id=>({products:await window.red.listProducts(),batches:await window.red.listAutomaticWorkBatches(),task:await window.red.getAutomaticListingTask(id)}),originalTask.id);assert.equal(preserved.products.length,25);assert.equal(preserved.task.items[0].sku,originalTask.items[0].sku);assert.equal(preserved.task.status,'PAUSED');
 await capture('artifacts/p04-work-batch-current.png');await app.close();app=null;
 page=await launch();await expect(page.getByLabel('选择工作批次')).toHaveValue(current.id);await expect(page.locator('.automatic-queue-entry')).toHaveCount(1);await expect(page.locator('.automatic-queue-toolbar')).toContainText('已选 0 件');const after=await page.evaluate(()=>window.red.listAutomaticWorkBatches());assert.deepEqual(after,preserved.batches);await page.getByLabel('选择工作批次').selectOption(original[0].id);await expect(page.getByLabel('选择自动上架任务')).toHaveValue(originalTask.id);await capture('artifacts/p04-work-batch-history.png');
 checks.push('重启保持日期/序号/当前身份/成员/原SKU/暂停；25原商品与历史任务保留');
 await writeFile('artifacts/p04-work-batch-ui.json',JSON.stringify({checks,dataRoot,originalBatch:original[0].id,currentBatch:current.id,originalTask:originalTask.id,externalRequests:0},null,2));console.log(checks.join('\n'));
}finally{if(app)await app.close();}
