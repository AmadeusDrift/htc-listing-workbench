import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Real renderer, disposable hidden Electron window, local fixtures only.
await mkdir(resolve('.test-data'), { recursive: true });
const root = await mkdtemp(resolve('.test-data/image-slot-previews-'));
const renderer = String.raw`
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageSlotProgress } from '../../src/renderer/ImageSlotProgress';
import '../../src/renderer/styles.css';
import '../../src/renderer/glass-theme.css';
const image = color => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><rect width="320" height="320" fill="#f5f2eb"/><ellipse cx="160" cy="236" rx="100" ry="20" fill="#ded8cd"/><rect x="62" y="70" width="196" height="156" rx="40" fill="'+color+'"/><rect x="77" y="84" width="166" height="124" rx="29" fill="none" stroke="white" stroke-opacity=".55" stroke-width="6"/></svg>');
const attempt = (index,state='GENERATED') => ({ number:1,requestId:'request-'+index,state,candidateId:'candidate-'+index,planResultId:null,ipReviewResultId:null,ocrResultId:null,reviewResultId:null,error:null });
const run = {id:'run-blue',draftId:'draft-blue',productId:'product',productRevision:1,variantId:'blue',sku:'TRAY-BLUE',status:'RUNNING',stage:'generating',attempt:6,maxAttempts:3,slots:Array.from({length:7},(_,i)=>({index:i+1,purpose:i?'detail':'main',status:i<3?'PASSED':i===5?'FAILED':i===6?'PENDING':'RUNNING',approvedAssetId:i<3?'asset-'+i:null,approvedSha256:i<3?'sha':null,attempts:i===6?[]:[attempt(i+1,i<3?'PASSED':i===5?'RETRYABLE_FAILURE':'GENERATED')],error:i===5?'图片审核待处理':null})),riskInterceptionEnabled:false,copyReviewEnabled:false};
const state=window.fixture={calls:[],run,missing:false};
window.red={
 getAutomaticProductProgress:async draftId=>{state.calls.push({name:'progress',draftId});return structuredClone({...state.run,draftId,sku:draftId==='draft-red'?'TRAY-RED':'TRAY-BLUE'})},
 getAutomaticImageCandidatePreview:async input=>{state.calls.push({name:'preview',input});if(state.missing)throw Error('candidate unavailable');return {candidateId:input.candidateId,previewUrl:image(input.draftId==='draft-red'?'#ba645a':'#799caf'),width:1024,height:1024}},
 approveUnknownImageRetry:async()=>{throw Error('preview must never retry generation')},
};
function Fixture(){const [revision,setRevision]=useState(0),[draftId,setDraftId]=useState('draft-blue');return <main style={{padding:24,height:'100vh',overflow:'auto'}}><h1>自动上架 · 商品图片</h1><p>折叠商品组中的图片只在展开后读取</p><button onClick={()=>setRevision(value=>value+1)}>刷新测试进度</button><button onClick={()=>setDraftId('draft-red')}>切换红色 SKU</button><ImageSlotProgress draftId={draftId} revision={String(revision)} active={false} defaultExpanded={false} color={draftId==='draft-blue'?'蓝色':'红色'} sku={draftId==='draft-blue'?'TRAY-BLUE':'TRAY-RED'}/></main>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await writeFile(join(root,'fixture.tsx'),renderer);
await build({entryPoints:[join(root,'fixture.tsx')],bundle:true,outfile:join(root,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl'},logLevel:'silent'});
await writeFile(join(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><div id="root"></div><script src="fixture.js"></script></body></html>');
const assetSvg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><rect width="320" height="320" fill="#f0f3f5"/><ellipse cx="160" cy="236" rx="100" ry="20" fill="#d9e0e4"/><rect x="62" y="70" width="196" height="156" rx="40" fill="#7199b0"/><rect x="77" y="84" width="166" height="124" rx="29" fill="none" stroke="white" stroke-opacity=".6" stroke-width="6"/></svg>';
await writeFile(join(root,'main.cjs'),`const {app,BrowserWindow,protocol,session}=require('electron');protocol.registerSchemesAsPrivileged([{scheme:'red-asset',privileges:{standard:true,secure:true}}]);app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true}));protocol.handle('red-asset',()=>new Response(${JSON.stringify(assetSvg)},{headers:{'Content-Type':'image/svg+xml'}}));const win=new BrowserWindow({width:1440,height:1040,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const require=createRequire(import.meta.url),env={...process.env,RED_E2E:'1',RED_DATA_DIR:join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;
let app;const checks=[],errors=[];
const pass=value=>{checks.push(value);console.log('PASS '+value)};
async function screenshot(name){
 const page=await app.firstWindow();
 // A never-shown Windows window needs a fresh compositor surface after changes.
 const [width,height]=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getSize());
 for(const w of [width+1,width]){
  const contentWidth=await app.evaluate(({BrowserWindow},size)=>{const window=BrowserWindow.getAllWindows()[0];window.setSize(...size);return window.getContentSize()[0]},[w,height]);
  await expect.poll(()=>page.evaluate(()=>window.innerWidth)).toBe(contentWidth);
 }
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(Array.from(document.images,image=>image.decode().catch(()=>{})));await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))});
 const capture=await app.evaluate(async({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];if(window.isVisible())throw Error('Fixture window must stay hidden');return (await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64')});
 await writeFile(join(root,name+'.png'),Buffer.from(capture,'base64'));
}
try{
 app=await electron.launch({executablePath:require('electron'),args:[join(root,'main.cjs')],cwd:resolve('.'),env,timeout:35000});
 const page=await app.firstWindow();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
 await expect(page.locator('.image-slot-progress summary')).toContainText('图片通过 3 / 7');
 assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.name==='preview').length),0);
 await page.locator('.image-slot-progress summary').click();
 await expect(page.locator('.image-slot-grid > li')).toHaveCount(7);
 await expect(page.locator('.image-slot-thumbnail img')).toHaveCount(6);
 await expect(page.locator('.image-slot-adoption[data-adopted="true"]')).toHaveCount(3);
 await expect(page.locator('.image-slot-adoption[data-adopted="false"]')).toHaveCount(3);
 await expect(page.getByText('当前 SKU 主图',{exact:true})).toBeVisible();
 await expect(page.locator('.image-slot-context')).toContainText('蓝色 · TRAY-BLUE');
 assert.equal(await page.locator('.image-slot-thumbnail img').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0)),true);
 pass('seven slots show six real images, pending placeholder, explicit adopted/candidate states and current SKU main image; collapsed details make no candidate reads');
 await page.getByRole('button',{name:'查看大图：TRAY-BLUE · 主图 · 已采用',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'自动图片预览'})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog',{name:'自动图片预览'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'查看大图：TRAY-BLUE · 主图 · 已采用',exact:true})).toBeFocused();
 await page.getByRole('button',{name:'查看大图：TRAY-BLUE · 详情 3 · 生成候选 · 未采用',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'自动图片预览'})).toContainText('生成候选 · 未采用');
 await screenshot('candidate-enlarged');
 await page.getByRole('button',{name:'关闭图片预览',exact:true}).click();
 pass('both adopted and candidate images enlarge; Escape and close restore the preview trigger focus');
 const reads=await page.evaluate(()=>window.fixture.calls.filter(c=>c.name==='preview').length);
 await page.getByRole('button',{name:'刷新测试进度',exact:true}).click();
 await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.name==='preview').length),reads);
 pass('status refresh retains already loaded candidate previews without rereading all images');
 await screenshot('seven-slots');
 await page.evaluate(()=>{window.fixture.missing=true;window.fixture.run.slots[6].status='FAILED';window.fixture.run.slots[6].attempts=[{number:1,state:'RETRYABLE_FAILURE',candidateId:'missing-candidate'}]});
 await page.getByRole('button',{name:'刷新测试进度',exact:true}).click();
 await expect(page.getByText('本地候选预览暂不可读',{exact:true})).toBeVisible();
 await expect(page.locator('.image-slot-adoption[data-adopted="true"]')).toHaveCount(3);
 await page.evaluate(()=>window.fixture.missing=false);
 await page.getByRole('button',{name:'重新读取预览',exact:true}).click();
 await expect(page.locator('.image-slot-thumbnail img')).toHaveCount(7);
 pass('missing candidate cache leaves adopted images intact and offers a local preview read retry');
 await page.getByRole('button',{name:'切换红色 SKU',exact:true}).click();
 await expect(page.locator('.image-slot-context')).toContainText('红色 · TRAY-RED');
 await expect(page.getByRole('button',{name:/查看大图：TRAY-BLUE/})).toHaveCount(0);
 await page.evaluate(()=>{window.fixture.run.status='COMPLETED';for(const slot of window.fixture.run.slots){slot.status='PASSED';slot.approvedAssetId='approved-'+slot.index;slot.error=null}});
 await page.getByRole('button',{name:'刷新测试进度',exact:true}).click();
 await expect(page.locator('.image-slot-adoption[data-adopted="true"]')).toHaveCount(7);
 await expect(page.locator('.image-slot-thumbnail img')).toHaveCount(7);
 await expect(page.locator('.image-slot-progress summary')).toContainText('图片通过 7 / 7');
 await screenshot('seven-adopted');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(640,1040));
 await expect(page.locator('.image-slot-grid')).toBeVisible();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark'});
 await screenshot('seven-adopted-narrow');
 await page.locator('.image-slot-grid > li').last().scrollIntoViewIfNeeded();
 await expect(page.locator('.image-slot-grid > li').last()).toBeInViewport();
 await screenshot('seven-adopted-narrow-bottom');
 pass('all seven adopted images remain visible and the grid fits a 640 px window without horizontal overflow');
 assert.equal(await page.evaluate(()=>window.fixture.calls.every(c=>['progress','preview'].includes(c.name))),true);
 assert.deepEqual(errors,[]);
 pass('changing SKU replaces preview context and all interactions remain read-only without paid generation or adoption');
 await writeFile(join(root,'result.json'),JSON.stringify({checks,errors},null,2));
 console.log(JSON.stringify({ok:true,checks:checks.length,root}));
}finally{await app?.close()}
