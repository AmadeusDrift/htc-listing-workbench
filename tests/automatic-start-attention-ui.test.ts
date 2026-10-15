import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { electron } from '../scripts/e2e-core-runtime.mjs';
import { expect } from '@playwright/test';

for(const held of [false,true])test(`new task started from page 2 retains attention and command identity; held old response=${held}`,{timeout:45000},async t=>{
 await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s09-start-attention-'));let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
 t.after(async()=>{await app?.close();await rm(root,{recursive:true,force:true,maxRetries:5});});
 await writeFile(join(root,'fixture.tsx'),`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {AutomaticTaskPanel} from '../../src/renderer/AutomaticTaskPanel';
 const make=id=>({id,revision:1,status:'PAUSED',targetName:id,mode:'demo',productType:'BOX',ruleRevision:1,items:[],createdAt:'2026-10-14T08:00:00Z',updatedAt:'2026-10-14T08:00:00Z',error:null});
 const f=window.fixture={tasks:Array.from({length:25},(_,i)=>make('old-'+i)),requests:[],commands:[],holdPage2:false,releases:[]};
 const summary=t=>({...t,items:undefined,sourceProductIds:[],sourceProductCount:0,salesSkuCount:0,counts:{completed:0,submittedAwaitingReadback:0,labels:0,running:0,waiting:0,pending:0,ruleFiltered:0,notSelected:0,profitFiltered:0,packagingFiltered:0,invalidOutput:0,needsInput:0,systemRepair:0,unknown:0,unclassified:0}});
 const command=(name,id)=>{f.commands.push({name,id});const task=f.tasks.find(t=>t.id===id);task.status=name==='pause'?'PAUSED':'CANCELLED';task.revision++;return structuredClone(task)};
 window.red={queryAutomaticTaskSummaries:async input=>{f.requests.push(input);const result={rows:f.tasks.slice((input.page-1)*20,input.page*20).map(summary),total:f.tasks.length,page:input.page,pageSize:20,active:f.tasks.some(t=>t.status==='RUNNING'),lifecycleSignature:JSON.stringify(f.tasks.map(t=>[t.id,t.status]))};if(f.holdPage2&&input.page===2)return new Promise(done=>f.releases.push(()=>done(result)));return result},queryAutomaticTaskGroups:async input=>({kind:'page',task:summary(f.tasks.find(t=>t.id===input.taskId)),groups:[],total:0,page:1,pageSize:20}),getAutomaticBatchSummary:async()=>null,pauseAutomaticListingTask:async id=>command('pause',id),cancelAutomaticListingTask:async id=>command('cancel',id)};
 function Host(){const [started,setStarted]=useState(null);window.startNew=()=>{const task={...make('new-started'),status:'RUNNING'};f.tasks.unshift(task);setStarted(task)};return <AutomaticTaskPanel products={[]} startedTask={started} busy={false} onManual={()=>{}}/>};createRoot(document.getElementById('root')).render(<Host/>);
 `);
 await build({entryPoints:[join(root,'fixture.tsx')],bundle:true,outfile:join(root,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
 await writeFile(join(root,'index.html'),'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>');
 await writeFile(join(root,'main.cjs'),`const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,done)=>done({cancel:true}));new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(root,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
 const require=createRequire(import.meta.url),env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined)),RED_DATA_DIR:join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:require('electron') as string,args:[join(root,'main.cjs')],cwd:resolve('.'),env,timeout:20000});const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await expect(page.getByTestId('automatic-task-old-0')).toBeVisible();await page.getByRole('button',{name:'下一页任务',exact:true}).click();await expect(page.getByTestId('automatic-task-old-20')).toBeVisible();
 if(held){await page.evaluate(()=>{(window as any).fixture.holdPage2=true;});await page.getByRole('button',{name:'刷新任务',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).fixture.releases.length)).toBe(1);}
 await page.evaluate(()=>(window as any).startNew());
 if(held){await expect(page.getByTestId('automatic-task-new-started')).toBeVisible();await page.getByRole('button',{name:'暂停任务',exact:true}).click();await page.evaluate(()=>{const f=(window as any).fixture;f.holdPage2=false;f.releases.splice(0).forEach((release:()=>void)=>release());});}
 await expect(page.getByTestId('automatic-task-new-started')).toBeVisible();await expect(page.getByRole('combobox',{name:'选择自动上架任务',exact:true})).toHaveValue('new-started');
 await expect.poll(()=>page.evaluate(()=>(window as any).fixture.requests.at(-1).page)).toBe(1);
 if(!held)await page.getByRole('button',{name:'暂停任务',exact:true}).click();await page.getByRole('button',{name:'取消任务',exact:true}).click();
 const actual=await page.evaluate(()=>({commands:(window as any).fixture.commands,oldTasks:(window as any).fixture.tasks.filter((t:any)=>t.id.startsWith('old-')).map((t:any)=>[t.id,t.revision,t.status])}));
 assert.deepEqual(actual.commands,[{name:'pause',id:'new-started'},{name:'cancel',id:'new-started'}]);assert.deepEqual(actual.oldTasks,Array.from({length:25},(_,i)=>['old-'+i,1,'PAUSED']));assert.deepEqual(errors,[]);
});
