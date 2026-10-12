import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';

test('W11 actual preload IPC UI saves thresholds and retains them after process restart', {timeout:60000}, async t=>{
 await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/risk-ui-'));
 let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
 t.after(async()=>{await app?.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:5});});
 await writeFile(join(root,'ui.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {ImageRiskSettings} from '../../src/renderer/ImageRiskSettings';createRoot(document.getElementById('root')).render(<ImageRiskSettings visible={true} busy={false}/>);`);
 await writeFile(join(root,'index.html'),'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="ui.js"></script>');
 await writeFile(join(root,'main.ts'),`
 import {app,BrowserWindow,session} from 'electron';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
 import {installIpc} from '../../src/main/ipc';import {WorkspaceStore} from '../../src/main/store';import {ImageWorkflowService} from '../../src/main/image-workflow/service';
 const directory=${JSON.stringify(root)};app.setPath('userData',join(directory,'profile'));let store,service;
 app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,done)=>done({cancel:true}));
 store=new WorkspaceStore(join(directory,'data'));service=new ImageWorkflowService(join(directory,'data'),store,{} as any,{} as any,{} as any);
 const win=new BrowserWindow({width:900,height:700,show:false,webPreferences:{preload:join(directory,'preload.cjs'),contextIsolation:true,sandbox:false}}),url=pathToFileURL(join(directory,'index.html')).href;
 installIpc(win,store,join(directory,'data'),url,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,async()=>{},undefined,undefined,undefined,undefined,undefined,undefined,service);win.loadURL(url);
 });app.on('window-all-closed',async()=>{await service?.close();store?.close();app.quit();});`);
 await Promise.all([
 build({entryPoints:[join(root,'ui.tsx')],bundle:true,outfile:join(root,'ui.js'),platform:'browser',jsx:'automatic',logLevel:'silent'}),
 build({entryPoints:[join(root,'main.ts')],bundle:true,outfile:join(root,'main.cjs'),platform:'node',format:'cjs',packages:'external',logLevel:'silent'}),
 build({entryPoints:['src/main/preload.ts'],bundle:true,outfile:join(root,'preload.cjs'),platform:'node',format:'cjs',external:['electron'],logLevel:'silent'})]);
 const require=createRequire(import.meta.url),env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>key!=='ELECTRON_RUN_AS_NODE'&&value!==undefined)) as Record<string,string>;
 const launch=async()=>{app=await electron.launch({executablePath:require('electron') as string,args:[join(root,'main.cjs')],env,timeout:20000});const page=await app.firstWindow();page.setDefaultTimeout(5000);return page;};
 let page=await launch();const score=()=>page.getByRole('spinbutton',{name:'风险分数阈值'}),level=()=>page.getByRole('combobox',{name:'风险等级阈值'});
 await expect(score()).toHaveValue('90');await expect(level()).toHaveValue('high');
 await score().fill('82.5');await score().blur();await expect(score()).toBeEnabled();
 await level().selectOption('medium');await expect(level()).toHaveValue('medium');
 const read=()=>page.evaluate(()=>window.red.getImageRiskSettings());
 assert.deepEqual(await read(),{enabled:true,scoreThreshold:82.5,levelThreshold:'medium'});
 await page.getByRole('switch',{name:'启用图片风险拦截'}).click();await expect(page.getByRole('switch')).not.toBeChecked();
 await app!.close();app=undefined;page=await launch();await expect(score()).toHaveValue('82.5');await expect(level()).toHaveValue('medium');await expect(page.getByRole('switch')).not.toBeChecked();
 await assert.rejects(()=>page.evaluate(()=>window.red.saveImageRiskSettings({enabled:true,scoreThreshold:101,levelThreshold:'high'})));
 assert.deepEqual(await read(),{enabled:false,scoreThreshold:82.5,levelThreshold:'medium'});
});
