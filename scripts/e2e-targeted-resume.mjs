import { electron } from './e2e-core-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
await mkdir(resolve('.test-data'),{recursive:true});
const root=await mkdtemp(resolve('.test-data/p05-ui-'));
await writeFile(join(root,'fixture.tsx'),String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';
import {AutomaticResumePanel} from '../../src/renderer/AutomaticResumePanel';
window.calls=[];window.red={previewAutomaticResume:async input=>{window.calls.push(['preview',input]);return {taskRevision:3,token:'local-proof',lines:['SKU ONE：仅处理图位 1、3；复用通过图片，不上传提交']};},resumeAutomaticSelection:async input=>{window.calls.push(['execute',input]);return null;}};
const task={id:'task',revision:3,status:'PAUSED',items:[{key:'one',sku:'SKU ONE',stage:'IMAGES',draftId:'draft'},{key:'two',sku:'SKU TWO',stage:'IMAGES',draftId:'draft-two'}]};
createRoot(document.getElementById('root')).render(<AutomaticResumePanel task={task} disabled={false} onUpdated={()=>{}}/>);
`);
await build({entryPoints:[join(root,'fixture.tsx')],bundle:true,outfile:join(root,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
await writeFile(join(root,'index.html'),'<meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>');
await writeFile(join(root,'main.cjs'),`const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,done)=>done({cancel:true}));const win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{contextIsolation:false,nodeIntegration:false}});win.loadFile(${JSON.stringify(join(root,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const require=createRequire(import.meta.url),env={...process.env,RED_E2E:'1',RED_DATA_DIR:join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;process.env.electron_config_cache=resolve('.cache/electron');
const app=await electron.launch({executablePath:require('electron'),args:[join(root,'main.cjs')],cwd:resolve('.'),env,timeout:35000});
try{
const page=await app.firstWindow();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.locator('summary').click();await page.getByLabel('SKU ONE · IMAGES',{exact:true}).check();await page.getByLabel('SKU ONE 图位',{exact:true}).fill('1,3');
assert.deepEqual(await page.evaluate(()=>window.calls),[]);
await page.getByRole('button',{name:'预览处理与复用范围',exact:true}).click();await expect(page.getByText('SKU ONE：仅处理图位 1、3；复用通过图片，不上传提交',{exact:true})).toBeVisible();
assert.deepEqual(await page.evaluate(()=>window.calls[0][1].scope),{mode:'targeted',selections:[{key:'one',slots:[1,3]}]});
await page.getByRole('button',{name:'确认范围并继续',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.calls[1][1]),{taskId:'task',taskRevision:3,token:'local-proof',scope:{mode:'targeted',selections:[{key:'one',slots:[1,3]}]}});
await page.getByLabel('处理方式',{exact:true}).selectOption('recheck');await expect(page.getByRole('button',{name:'确认范围并继续',exact:true})).toHaveCount(0);
await page.getByRole('button',{name:'预览处理与复用范围',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)[1].scope),{mode:'recheck',selections:[{key:'one'}]});
assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(()=>globalThis.__releaseGuard.attempts),[]);await writeFile(join(root,'result.json'),JSON.stringify({ok:true,checks:5,network:'denied before load',kind:'real component, fake API'},null,2));console.log(JSON.stringify({ok:true,checks:5,root}));
}finally{await app.close();}
