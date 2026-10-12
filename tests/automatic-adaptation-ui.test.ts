import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';
import {expect} from '@playwright/test';

test('old-task UI automatically checks readonly and explicit apply never continues; failed save stays visible',{timeout:45000},async t=>{
 await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/task-adaptation-ui-'));let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
 t.after(async()=>{await app?.close();await rm(root,{recursive:true,force:true,maxRetries:5});});
 await writeFile(join(root,'fixture.tsx'),`
 import React from 'react';import {createRoot} from 'react-dom/client';import {AutomaticTaskPanel} from '../../src/renderer/AutomaticTaskPanel';import '../../src/renderer/styles.css';
 const row={key:'row',productId:'product',productRevision:1,productTitle:'Source',variantId:'variant',sku:'KEEP-SKU',status:'FAILED',stage:'IMAGES',draftId:'draft',error:'Old retained error',imageAttempts:3,repairAttempts:2};
 const task={id:'task',revision:1,status:'NEEDS_ATTENTION',targetName:'Isolated fixture',mode:'demo',productType:'BOX',ruleRevision:1,items:[row],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),error:'Old retained error'};
 const f=window.fixture={checks:0,applies:0,resumes:0,fail:true,task};window.red={listAutomaticListingTasks:async()=>[f.task],getAutomaticListingTask:async()=>f.task,getProduct:async()=>{throw Error('mutating source read');},previewAutomaticListingAdaptation:async()=>{f.checks++;return {taskId:'task',taskRevision:f.task.revision,token:'token',canApply:true,blockers:[],sources:[],changes:f.task.revision===1?[{key:'row',productId:'product',sku:'KEEP-SKU',kind:'RULES',message:'Current pricing rules changed',fields:['purchasable_offer'],steps:['定价']}]:[]};},applyAutomaticListingAdaptation:async input=>{if(input.token!=='token')throw Error('wrong token');f.applies++;if(f.fail)throw Error('Injected save failure');f.task={...f.task,revision:2,status:'PAUSED'};return f.task;},resumeAutomaticListingTask:async()=>{f.resumes++;return f.task;}};
 createRoot(document.getElementById('root')).render(<AutomaticTaskPanel products={[]} startedTask={null} busy={false} onManual={()=>{}}/>);
 `);
 await build({entryPoints:[join(root,'fixture.tsx')],bundle:true,outfile:join(root,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl'},logLevel:'silent'});
 await writeFile(join(root,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
 await writeFile(join(root,'main.cjs'),`const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,done)=>done({cancel:true}));const win=new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
 const require=createRequire(import.meta.url),env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined&&entry[0]!=='ELECTRON_RUN_AS_NODE'));
 app=await electron.launch({executablePath:require('electron') as string,args:[join(root,'main.cjs')],env,timeout:20000});const page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const button=page.getByRole('button',{name:'适配当前规则',exact:true});await expect(button).toBeEnabled();await expect(page.getByLabel('旧任务适配检查')).toContainText('Current pricing rules changed');await button.click();await expect(page.getByRole('alert').filter({hasText:'Injected save failure'})).toBeVisible();
 assert.equal(await page.evaluate(()=>(window as any).fixture.resumes),0);await page.evaluate(()=>(window as any).fixture.fail=false);await button.click();await expect(page.getByRole('button',{name:'继续任务',exact:true})).toBeVisible();await expect(button).toBeDisabled();
 assert.equal(await page.evaluate(()=>(window as any).fixture.applies),2);assert.equal(await page.evaluate(()=>(window as any).fixture.resumes),0);assert.deepEqual(errors,[]);
});
