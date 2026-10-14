import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {expect} from '@playwright/test';
import {launchGuarded} from './release-runtime.mjs';

// Native titlebar input is deliberately external to Playwright. Run this script,
// use the Windows computer-use helper on the unique test window, then create the
// printed finish file. BrowserWindow.setBounds is not a substitute for a drag.
await mkdir('.test-data',{recursive:true});
const root=await mkdtemp(resolve('.test-data/native-titlebar-'));
const finish=join(root,'finish'),errors=[];let app;
try {
 app=await launchGuarded({executable:process.env.HTC_TEST_EXE||createRequire(import.meta.url)('electron'),args:process.env.HTC_TEST_EXE?[]:['.'],dataRoot:root,guardPath:resolve('scripts/release-network-guard.cjs'),cwd:resolve('.')});
 const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
 await expect(page.getByRole('button',{name:'新建商品',exact:true})).toBeEnabled();
 await page.evaluate(async()=>{const ids=[];for(let i=0;i<65;i++){const p=await window.red.createProduct();await window.red.saveProduct({id:p.id,revision:p.revision,sourceUrl:p.sourceUrl,description:p.description,status:p.status,facts:p.facts,title:`隔离拖动测试商品 ${i+1}`,variants:p.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory}))});ids.push(p.id);}await window.red.moveWorkspaceProducts({productIds:ids,destination:'automatic'});});
 await page.reload();await page.locator('.primary-navigation').getByRole('button',{name:'自动上架',exact:true}).click();
 await expect(page.getByRole('heading',{name:'自动上架任务',exact:true})).toBeVisible();
 const initial=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1150,800);w.setPosition(200,100);w.setTitle('HTC 隔离标题栏拖动验证');w.on('page-title-updated',e=>e.preventDefault());w.webContents.setBackgroundThrottling(false);w.showInactive();const state=globalThis.__dragProbe={events:[],lags:[],cpu:process.cpuUsage(),start:performance.now()};let prior=performance.now();state.timer=setInterval(()=>{const now=performance.now();state.lags.push(now-prior);prior=now;},20);w.on('move',()=>state.events.push({at:performance.now(),bounds:w.getBounds()}));return {pid:process.pid,bounds:w.getBounds()};});
 const dragStyle=await page.locator('.desktop-titlebar').evaluate(el=>getComputedStyle(el).getPropertyValue('-webkit-app-region'));
 console.log(JSON.stringify({ready:true,dragStyle,title:'HTC 隔离标题栏拖动验证',root,finish,initial}));
 const deadline=Date.now()+300000;let finished=false;
 while(Date.now()<deadline){try{await access(finish);finished=true;break;}catch{}await delay(500);}
 assert.ok(finished,'Native-input verification was not completed within five minutes');
 const state=await app.evaluate(({BrowserWindow})=>{const s=globalThis.__dragProbe;clearInterval(s.timer);const sorted=[...s.lags].sort((a,b)=>a-b);return {bounds:BrowserWindow.getAllWindows()[0].getBounds(),events:s.events,mainTimerMaxMs:Math.max(...s.lags),mainTimerP95Ms:sorted[Math.floor(sorted.length*.95)],samples:s.lags.length,cpu:process.cpuUsage(s.cpu),elapsedMs:performance.now()-s.start,guard:globalThis.__releaseGuard.attempts};});
 await writeFile(join(root,'observation.json'),JSON.stringify({initial,...state,errors},null,2));
 const dragMoves=state.events.filter(e=>e.bounds.width===initial.bounds.width&&e.bounds.height===initial.bounds.height&&(e.bounds.x!==initial.bounds.x||e.bounds.y!==initial.bounds.y));
 assert.ok(dragMoves.length>=2,'Need at least two observed same-size native window moves; maximize does not count as dragging');
 assert.deepEqual(errors,[]);assert.deepEqual(state.guard,[]);assert.deepEqual(await page.evaluate(()=>window.red.listAiCalls()),[]);
 const report={passed:true,root,initial,...state,errors,scope:'Real main/preload/renderer, 65 synthetic products, network blocked before main; OS titlebar gestures supplied externally. No historical workspace or remote tasks were loaded.'};
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await app?.close();}
