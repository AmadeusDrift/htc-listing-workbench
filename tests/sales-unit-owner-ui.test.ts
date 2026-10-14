import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {_electron as electron} from 'playwright';
import {expect} from '@playwright/test';
import {taskKit} from './fixtures/mixed-kit.ts';
import {installAutomaticListingIpc} from '../src/main/automatic-listing-ipc.ts';

test('unit UI uses original task owner, keeps failed inputs and commits locally without resume or provider calls',{timeout:45000},async t=>{
 const f=await taskKit(t),root=await mkdtemp(resolve('.test-data/unit-ui-')),handlers=new Map<string,{count:number;run:(...args:unknown[])=>unknown}>();
 const counters={adopts:0,resumes:0,confirmations:0,wrongOwner:false};let deferPreview=false,releasePreview:(()=>void)|undefined;let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
 const register=(channel:string,count:number,run:(...args:unknown[])=>unknown)=>handlers.set(channel,{count,run});
 installAutomaticListingIpc(f.owner,register,{confirm:async()=>{counters.confirmations++;return false;},audit:()=>{}});
 register('red:amazon:actual-quote',1,id=>f.amazon.getActualQuoteDetails(String(id)));
 const server=createServer(async(req,res)=>{try{
  let text='';for await(const chunk of req)text+=chunk;if(text.length>65536)throw Error('Oversized fixture request');
  const {channel,args}=JSON.parse(text),handler=handlers.get(channel);if(!handler||args.length!==handler.count)throw Error('Unexpected fixture IPC');
  if(channel==='red:automatic-listing:unit-adopt')counters.adopts++;if(channel==='red:automatic-listing:resume')counters.resumes++;
  if(counters.wrongOwner&&channel==='red:automatic-listing:unit-preview')args[0].taskId='00000000-0000-4000-a000-000000000000';
  const value=await handler.run(...args);if(deferPreview&&channel==='red:automatic-listing:unit-preview')await new Promise<void>(done=>{releasePreview=done;});res.end(JSON.stringify({value}));
 }catch(error){res.end(JSON.stringify({error:error instanceof Error?error.message:'Fixture command failed'}));}});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as any).port;
 try{
  await writeFile(join(root,'fixture.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{AutomaticTaskPanel}from'../../src/renderer/AutomaticTaskPanel';import{SalesUnitAdoptionPanel}from'../../src/renderer/SalesUnitAdoptionPanel';import'../../src/renderer/styles.css';const root=createRoot(document.getElementById('root'));root.render(<AutomaticTaskPanel products={[]} startedTask={null} busy={false} onManual={()=>{}}/>);window.addEventListener('unit-owner-fixture',e=>root.render(<SalesUnitAdoptionPanel {...e.detail} scope={{...e.detail.scope,onUpdated:()=>{}}}/>));`);
  await build({entryPoints:[join(root,'fixture.tsx')],bundle:true,outfile:join(root,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl'},logLevel:'silent'});
  await build({entryPoints:['src/main/preload.ts'],bundle:true,outfile:join(root,'preload.cjs'),platform:'node',format:'cjs',external:['electron'],logLevel:'silent'});
  await writeFile(join(root,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
  await writeFile(join(root,'main.cjs'),`const{app,BrowserWindow,ipcMain,session}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'profile'))});const channels=${JSON.stringify([...handlers.keys()])};for(const channel of channels)ipcMain.handle(channel,async(_, ...args)=>{const response=await fetch('http://127.0.0.1:${port}',{method:'POST',body:JSON.stringify({channel,args})});const value=await response.json();globalThis.delivered=(globalThis.delivered??0)+1;if(value.error)return{ok:false,error:value.error};return{ok:true,data:value.value};});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,done)=>done({cancel:true}));const win=new BrowserWindow({show:false,width:900,height:1000,webPreferences:{preload:${JSON.stringify(join(root,'preload.cjs'))},contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const require=createRequire(import.meta.url),env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined&&entry[0]!=='ELECTRON_RUN_AS_NODE'));
  const dataRoot=join(root,'data');await mkdir(dataRoot,{recursive:true});
  app=await electron.launch({executablePath:require('electron') as string,args:['-r',resolve('tests/fixtures/stabilization/network-guard.cjs'),join(root,'main.cjs')],cwd:resolve('.'),env:{...env,RED_DATA_DIR:dataRoot},timeout:20000});const page=await app.firstWindow(),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('button',{name:new RegExp('展开来源商品')}).click();await page.getByRole('button',{name:new RegExp(f.plan.sku)}).first().click();await page.locator('summary').filter({hasText:'实际报价明细'}).click();
  const count=page.getByLabel('明确确认的平台销售件数'),basis=page.getByLabel('计量确认依据'),confirm=page.getByLabel('我确认采用当前计量对照，并保留原 SKU');
  await expect(count).toHaveValue('');await expect(basis).toHaveValue('');await expect(confirm).not.toBeChecked();assert.equal(counters.adopts,0);assert.equal(f.requests.length,0);
  await count.fill('1');await basis.fill('合成每整套一个销售商品，50为滤网附件');
  counters.wrongOwner=true;await page.getByRole('button',{name:'检查计量对照',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'不存在'})).toBeVisible();assert.equal(counters.adopts,0);assert.equal(counters.resumes,0);counters.wrongOwner=false;
  await page.getByRole('button',{name:'检查计量对照',exact:true}).click();await expect(page.getByText('旧采购展开', {exact:true})).toBeVisible();
  // Actual component props switch without a key/remount; late original-owner preview must be discarded.
  const originalPreview=f.amazon.getActualQuoteDetails(f.ref.id).unitPreview!;
  const originalProps={draftId:f.ref.id,draftRevision:f.ref.revision,initial:originalPreview,scope:{taskId:f.task.id,taskRevision:f.task.revision,itemKey:f.task.items[0].key}};
  await page.evaluate(props=>window.dispatchEvent(new CustomEvent('unit-owner-fixture',{detail:props})),originalProps);
  await count.fill('1');await basis.fill('owner A only');deferPreview=true;
  await page.getByRole('button',{name:'检查计量对照',exact:true}).click();await expect.poll(()=>!!releasePreview).toBe(true);
  const otherProps={...originalProps,draftId:'00000000-0000-4000-a000-000000000002',initial:{...originalPreview,token:'b'.repeat(64),purchaseBefore:'OWNER B PURCHASE'},scope:{...originalProps.scope,taskId:'00000000-0000-4000-a000-000000000003',itemKey:'owner-B-row'}};
  await page.evaluate(props=>window.dispatchEvent(new CustomEvent('unit-owner-fixture',{detail:props})),otherProps);
  await expect(count).toHaveValue('');await expect(basis).toHaveValue('');await expect(confirm).not.toBeChecked();
  const deliveredBefore=await app.evaluate(()=>(globalThis as any).delivered??0);deferPreview=false;releasePreview!();await expect.poll(()=>app!.evaluate(()=>(globalThis as any).delivered??0)).toBeGreaterThan(deliveredBefore);
  await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  await expect(page.getByText('OWNER B PURCHASE',{exact:false})).toBeVisible();await expect(confirm).toBeDisabled();
  await count.fill('3');await basis.fill('owner B explicit fact');await page.evaluate(props=>window.dispatchEvent(new CustomEvent('unit-owner-fixture',{detail:props})),{...otherProps,scope:{...otherProps.scope,taskRevision:2}});
  await expect(count).toHaveValue('3');await expect(basis).toHaveValue('owner B explicit fact');await expect(confirm).not.toBeChecked();await expect(confirm).toBeDisabled();
  assert.equal(counters.adopts,0);assert.equal(counters.resumes,0);assert.equal(f.requests.length,0);
  await page.evaluate(props=>window.dispatchEvent(new CustomEvent('unit-owner-fixture',{detail:props})),originalProps);
  await count.fill('1');await basis.fill('合成每整套一个销售商品，50为滤网附件');
  await page.getByRole('button',{name:'检查计量对照',exact:true}).click();await expect(confirm).toBeEnabled();
  const adopt=page.getByRole('button',{name:'明确采用计量',exact:true});await expect(adopt).toBeDisabled();await confirm.check();await expect(adopt).toBeEnabled();
  const before=JSON.stringify(f.owner.get(f.task.id)),draftBefore=JSON.stringify(f.amazon.getDraft(f.ref.id));
  (f.owner as any).db.exec("CREATE TEMP TRIGGER fail_unit_ui BEFORE UPDATE ON automatic_listing_tasks BEGIN SELECT RAISE(ABORT,'fixture checkpoint failed'); END");
  await adopt.click();await expect(page.getByRole('alert').filter({hasText:'fixture checkpoint failed'})).toBeVisible();await expect(count).toHaveValue('1');await expect(basis).toHaveValue('合成每整套一个销售商品，50为滤网附件');
  assert.equal(JSON.stringify(f.owner.get(f.task.id)),before);assert.equal(JSON.stringify(f.amazon.getDraft(f.ref.id)),draftBefore);(f.owner as any).db.exec('DROP TRIGGER fail_unit_ui');
  await adopt.click();await expect.poll(()=>f.owner.get(f.task.id).revision).toBe(f.task.revision+1);assert.equal(f.owner.get(f.task.id).status,'PAUSED');assert.equal(f.owner.get(f.task.id).items[0].key,f.task.items[0].key);assert.equal(f.amazon.getDraft(f.ref.id).salesPlan?.recipe.quantityVersion,2);
  assert.equal(counters.adopts,2);assert.equal(counters.resumes,0);assert.equal(counters.confirmations,0);assert.equal(f.requests.length,0);assert.deepEqual(errors,[]);
  assert.deepEqual((await app.evaluate(()=>(globalThis as any).__stabilizationNetwork)).blocked,[]);assert.deepEqual((globalThis as any).__stabilizationNetwork.blocked,[]);
 }finally{await app?.close().catch(()=>{});server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await f.owner.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
});



