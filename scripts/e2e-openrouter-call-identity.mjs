import {electron} from './e2e-core-runtime.mjs';
import {expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/call-identity-ui-'));
await writeFile(join(root,'fixture.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';import {AiUsageReport} from '../../src/renderer/AiUsageReport';
window.reads=0;window.red={getAiUsageReport:async()=>{window.reads++;return{from:'2026-10-14',to:'2026-10-14',calls:2,reportedCostUsd:0,unknownCostCalls:2,rows:[],detailsTotal:2,details:[{id:'new',startedAt:'2026-10-14T10:00:00Z',receivedAt:'2026-10-14T10:00:01Z',gateway:'openrouter',model:'selected-model',actualModel:'actual-version',actualProvider:'Azure',status:'SUCCEEDED',httpStatus:200},{id:'legacy',startedAt:'2026-10-14T09:00:00Z',receivedAt:null,gateway:'openrouter',model:'selected-model',actualModel:null,actualProvider:null,status:'FAILED',httpStatus:403}]}}};
createRoot(document.getElementById('root')).render(<AiUsageReport/>);`);
await build({entryPoints:[join(root,'fixture.tsx')],bundle:true,outfile:join(root,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
await writeFile(join(root,'index.html'),'<meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>');
await writeFile(join(root,'main.cjs'),`const{app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,done)=>done({cancel:true}));const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false}});w.loadFile(${JSON.stringify(join(root,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env,RED_E2E:'1',RED_DATA_DIR:join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;let app;try{app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[join(root,'main.cjs')],env,timeout:35000});const page=await app.firstWindow();await page.clock.install();const summary=page.getByText('逐次调用模型与提供商',{exact:false});await expect(summary).toBeVisible();assert.equal(await page.evaluate(()=>window.reads),1);await summary.click();const details=page.locator('details');await expect(details).toContainText('actual-version');await expect(details).toContainText('Azure');await expect(details).toContainText('失败 · HTTP 403');await expect(details.locator('tbody tr').nth(1)).toContainText('未返回');await page.clock.fastForward(120000);assert.equal(await page.evaluate(()=>window.reads),1);await page.getByRole('button',{name:'读取明细',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.reads)).toBe(2);console.log('PASS actual/selected identity, missing legacy, HTTP403, manual refresh only');}finally{await app?.close();}
