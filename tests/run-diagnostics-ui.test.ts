import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { electron } from '../scripts/e2e-core-runtime.mjs';
import { expect } from '@playwright/test';

test('real renderer/preload/diagnostics IPC reads, pages and exports current connection without writes', { timeout: 90000 }, async t => {
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/run-diagnostics-ui-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const destination = join(root, 'export.json'), dataRoot = join(root, 'data');
  await writeFile(join(root, 'fixture.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import {RunDiagnostics} from '../../src/renderer/RunDiagnostics';import '../../src/renderer/styles.css';createRoot(document.getElementById('root')).render(<RunDiagnostics busy={false}/>);`);
  await build({ entryPoints: [join(root,'fixture.tsx')], bundle: true, outfile: join(root,'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' }, logLevel: 'silent' });
  await writeFile(join(root, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
  await build({ entryPoints: [resolve('src/main/preload.ts')], bundle: true, outfile: join(root,'preload.cjs'), platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  await writeFile(join(root,'main.ts'), `
  import {app,BrowserWindow,ipcMain} from 'electron';import {randomUUID} from 'node:crypto';import {WorkspaceStore} from '../../src/main/store.ts';import {openDatabase} from '../../src/main/database.ts';import {installDiagnosticsIpc} from '../../src/main/diagnostics-ipc.ts';import {appendRunEvidence} from '../../src/main/diagnostics/run-evidence.ts';import {saveProviderReceipt} from '../../src/main/ai/receipts.ts';
  app.setPath('userData',${JSON.stringify(join(root,'profile'))});let store;app.whenReady().then(async()=>{
    const directory=${JSON.stringify(dataRoot)};store=new WorkspaceStore(directory);const product=store.createProduct(),db=openDatabase(directory),taskId=randomUUID(),draftId=randomUUID(),at='2026-10-15T01:00:00.000Z';
    const item={key:product.id+':'+product.variants[0].id,productId:product.id,variantId:product.variants[0].id,sku:'HTC-UI-18',draftId,stage:'IMAGES',status:'FAILED',executionTaskIds:[]};
    const task={id:taskId,revision:7,createdAt:at,status:'PAUSED',items:[item]};db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(taskId,JSON.stringify(task));
    const ids=[];for(let i=0;i<121;i++){const callId=randomUUID();ids.push(callId);db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(callId,JSON.stringify({id:callId,productId:product.id,startedAt:at,status:i?'FAILED':'SUCCEEDED',errorCode:i?'TIMEOUT':null,presentationContext:{draftId},headers:{Authorization:'S01_PRIVATE_BAIT'}}));appendRunEvidence(db,product.id,{version:1,at,event:'DISPATCH_ATTEMPTED',stage:'fields',taskId,itemKey:item.key,sku:item.sku,draftId,callId,certainty:'SENT_UNKNOWN'});}
    const receipt=await saveProviderReceipt(db,directory,ids[0],{gateway:'openrouter',endpoint:'/api/v1/chat/completions',model:'fixture',status:200,requestId:'fixture-1',receivedAt:at,costUsd:null,body:{secret:'S01_PRIVATE_BAIT'}},undefined);const resultId=randomUUID();db.prepare('INSERT INTO ai_results VALUES(?,?)').run(resultId,JSON.stringify({id:resultId,callId:ids[0]}));
    const snapshot=()=>JSON.stringify(['automatic_listing_tasks','ai_calls','ai_results','ai_usage_ledger','audit_events'].map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()));
    globalThis.s01UI={taskId,ids,before:snapshot(),unchanged:()=>snapshot()===globalThis.s01UI.before};
    globalThis.s01UI.timings=[];
    const handle=(channel,count,run)=>ipcMain.handle(channel,async(_event,...args)=>{const start=performance.now();try{if(args.length!==count)throw Error('arity');return {ok:true,data:await run(...args)};}catch(error){return {ok:false,error:error.message};}finally{globalThis.s01UI.timings.push({channel,elapsedMs:performance.now()-start});}});
    installDiagnosticsIpc(directory,handle,{context:()=>({appVersion:'2.5.0',runtime:{nodeMajor:24,electronMajor:44},services:{aiBusy:false,imageWritesBusy:false,executionBusy:false}}),selectDestination:async()=>({canceled:false,filePath:${JSON.stringify(destination)}}),runReport:{query:q=>store.getRunDiagnostics(q),export:q=>store.exportRunDiagnostics(q)}});
    handle('red:automatic-listing:list',0,()=>[task]);const win=new BrowserWindow({show:false,width:1050,height:760,webPreferences:{contextIsolation:true,sandbox:true,preload:${JSON.stringify(join(root,'preload.cjs'))},backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'index.html'))});app.on('before-quit',()=>{db.close();store.close();});
  });app.on('window-all-closed',()=>app.quit());`);
  await build({ entryPoints: [join(root,'main.ts')], bundle: true, outfile: join(root,'main.cjs'), platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const require = createRequire(import.meta.url), env = Object.fromEntries(Object.entries(process.env).filter(([k,v]) => v !== undefined && k !== 'ELECTRON_RUN_AS_NODE'));
  app = await electron.launch({ executablePath: require('electron') as string, args: [join(root,'main.cjs')], cwd: resolve('.'), env: { ...env, RED_DATA_DIR: dataRoot }, timeout: 20000 });
  const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await expect(page.getByRole('button',{name:'读取诊断',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'读取任务列表',exact:true}).click();
  const identity = await app.evaluate(() => ({ taskId: (globalThis as any).s01UI.taskId, ids: (globalThis as any).s01UI.ids }));
  await page.getByLabel('诊断任务',{exact:true}).selectOption(identity.taskId); await page.getByLabel('诊断 SKU',{exact:true}).selectOption('HTC-UI-18');
  await page.getByRole('button',{name:'读取诊断',exact:true}).click(); await expect(page.getByText('本页 20 / 全范围 121 条',{exact:true})).toBeVisible();
  await expect(page.getByText('总调用 121 · 已存回执 1 · 有效结果 1 · 已采用 0',{exact:true})).toBeVisible();
  assert.ok((await page.locator('tbody').innerText()).includes('已进入发送，结果未知'));
  await page.getByRole('button',{name:'下一页',exact:true}).click(); await expect(page.locator('tbody code').first()).toHaveText(identity.ids[20]);
  await page.getByLabel('诊断每页数量',{exact:true}).selectOption('100'); await page.getByRole('button',{name:'读取诊断',exact:true}).click(); await expect(page.getByText('本页 100 / 全范围 121 条',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'导出完整范围',exact:true}).click(); await expect(page.getByText('完整范围的脱敏诊断已保存。',{exact:true})).toBeVisible({timeout:30000});
  const exported = JSON.parse(await readFile(destination,'utf8')); assert.equal(exported.calls.length,121); assert.equal(exported.page.complete,true); assert.equal(exported.counts.adoptedResults,0); assert.doesNotMatch(JSON.stringify(exported),/S01_PRIVATE_BAIT|Authorization/);
  assert.equal(await app.evaluate(() => (globalThis as any).s01UI.unchanged()),true); assert.deepEqual(errors,[]);
  t.diagnostic(JSON.stringify(await app.evaluate(() => (globalThis as any).s01UI.timings)));
  await mkdir(resolve('artifacts/stabilization'),{recursive:true}); await page.screenshot({path:resolve('artifacts/stabilization/s01-run-diagnostics-ui.png')});
});
