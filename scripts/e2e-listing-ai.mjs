import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicApi } from './api-surface.mjs';
import { resizeWindow } from './e2e-window.mjs';
await mkdir(resolve('.test-data'),{recursive:true});await mkdir(resolve('artifacts'),{recursive:true});
const dataRoot=await mkdtemp(resolve('.test-data/listing-ai-e2e-')),require=createRequire(import.meta.url),env={...process.env,RED_DATA_DIR:dataRoot,RED_E2E:'1'};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const checks=[],errors=[],layouts=[];
async function launch(){app=await electron.launch({executablePath:require('electron'),args:[resolve('tests/fixtures/listing-ai-electron.cjs')],cwd:resolve('.'),env,timeout:35000});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>!!window.red&&document.querySelector('button'));}
const pass=name=>{checks.push(name);console.log(`PASS ${name}`);};
try{
 await launch();assert.deepEqual((await page.evaluate(()=>Object.keys(window.red))).sort(),[...publicApi].sort());
 await page.getByRole('button',{name:'载入示例商品',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.red.listProducts().then(rows=>rows.length))).toBe(2);
 let p=await page.evaluate(async()=>{const rows=await window.red.listProducts();return window.red.getProduct(rows.find(r=>r.title==='方形硅胶杯垫').id);});
 p=await page.evaluate(p=>window.red.saveProduct({id:p.id,revision:p.revision,title:p.title,sourceUrl:p.sourceUrl,description:p.description,status:p.status,facts:p.facts,variants:p.variants.map(({id,sku,originalSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec:'Blue',purchasePrice,inventory}))}),p);
 await page.evaluate(async p=>{for(const variant of p.variants){const input={productId:p.id,productRevision:p.revision,variantId:variant.id},view=await window.red.getSourceConsistency(input);await window.red.decideSourceConsistency({...input,fingerprint:view.fingerprint,decision:'CONFIRMED',reason:'Synthetic listing UI fixture: original image correspondence checked for this test.'});}},p);
 await page.evaluate(async()=>{await window.red.saveAiConnection({id:'deepseek',apiKey:'listing-ui-test-key'});await window.red.saveAiFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});await window.red.saveAiFunctionSettings({id:'deepseek-review',model:'deepseek-v4-pro',enabled:true});});
 await page.reload();await page.getByRole('button',{name:/手动上架/}).first().click();await page.getByTestId(`product-${p.id}`).click();await page.getByRole('tab',{name:'上架检查'}).click();await page.getByRole('button',{name:'启用本地演示',exact:true}).click();await page.getByRole('button',{name:'获取字段并建草稿',exact:true}).click();
 await page.getByRole('button',{name:'生成英文字段建议',exact:true}).click();await expect(page.getByRole('button',{name:'复核字段建议（可选）',exact:true})).toBeEnabled();
 let drafts=await page.evaluate(id=>window.red.listAmazonDrafts(id),p.id);assert.equal(drafts[0].revision,1);pass('generation displays current/candidate/evidence without mutating draft');
 await page.getByRole('button',{name:'复核字段建议（可选）',exact:true}).click();await expect(page.getByLabel('采纳材质',{exact:true})).toBeEnabled();await page.getByLabel('采纳材质',{exact:true}).check();await page.getByRole('button',{name:'采纳所选字段并检查',exact:true}).click();
 await expect.poll(()=>page.evaluate(id=>window.red.listAmazonDrafts(id).then(rows=>rows[0].revision),p.id)).toBe(2);drafts=await page.evaluate(id=>window.red.listAmazonDrafts(id),p.id);assert.equal(drafts[0].fieldAdoptions.length,1);assert.equal(drafts[0].state,'BLOCKED');pass('selective adoption persists provenance, increments revision and retains missing-field blockers');
 for(const [width,height]of [[1440,1000],[1080,850]]){await resizeWindow(app,page,width,height);const overflow=await page.evaluate(()=>[...document.querySelectorAll('.listing-ai-panel,.listing-ai-diff,.listing-ai-candidate')].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>e.className));assert.deepEqual(overflow,[]);layouts.push({width,height,overflow});}
 await page.locator('.listing-ai-panel').evaluate(el=>el.scrollIntoView({block:'start'}));
 await page.evaluate(async()=>{await document.fonts.ready;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));});
 const screenshot=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));await writeFile(resolve('artifacts/listing-ai-ui.png'),Buffer.from(screenshot,'base64'));pass('balanced field diffs fit desktop and narrow window');
 await app.close();await launch();await page.getByRole('button',{name:/手动上架/}).first().click();await page.getByTestId(`product-${p.id}`).click();await page.getByRole('tab',{name:'上架检查'}).click();await expect(page.getByText('字段采纳记录 · 1 次',{exact:true})).toBeVisible();pass('restart retains suggestions and adoption history');
 const callsBeforeCancel=await app.evaluate(()=>{globalThis.__listingAiTest.mode='hold';return globalThis.__listingAiTest.calls;});
 await page.getByRole('button',{name:'生成英文字段建议',exact:true}).click();
 await expect.poll(()=>app.evaluate(()=>globalThis.__listingAiTest.calls)).toBe(callsBeforeCancel+1);
 const cancelButton=page.getByRole('region',{name:'AI 上架字段辅助'}).getByRole('button',{name:'取消处理',exact:true});
 await expect(cancelButton).toBeVisible();await cancelButton.click();
 await expect(page.getByRole('button',{name:'生成英文字段建议',exact:true})).toBeEnabled();assert.equal(await app.evaluate(()=>globalThis.__listingAiTest.calls),callsBeforeCancel+1);
 pass('cancel interrupts a pending billed request without retry');
 assert.deepEqual(errors,[]);
}finally{await writeFile(resolve('artifacts/listing-ai-e2e-report.json'),JSON.stringify({dataRoot,checks,layouts,errors},null,2));await app?.close();}
