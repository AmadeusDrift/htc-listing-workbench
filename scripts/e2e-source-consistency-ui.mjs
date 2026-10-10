import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';

// Isolated real component, explicit API fixtures, hidden Electron, denied network.
await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/source-consistency-ui-'));
await writeFile(join(root,'fixture.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';import {SourceConsistencyPanel} from '../../src/renderer/SourceConsistencyPanel';
const product={id:'p',revision:1,variants:[{id:'blue',sku:'BLUE',originalSpec:'Blue round'},{id:'red',sku:'RED',originalSpec:'Red square'}],assets:[{id:'a-blue',previewUrl:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><circle fill="blue" r="50" cx="50" cy="50"/></svg>'},{id:'a-red',previewUrl:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red" width="100" height="100"/></svg>'}]};
const state=window.fixture={calls:[],statuses:{blue:'PENDING',red:'UNKNOWN'}};
const view=input=>({context:{productId:'p',productRevision:1,variantId:input.variantId,fields:[{id:'variant.sourceSpec',name:'spec',value:input.variantId==='blue'?'Blue round':'Red square'},{id:'variant.normalizedSpec',name:'spec',value:input.variantId==='blue'?'Blue round':'Red square'}],referenceAssets:[{assetId:'a-'+input.variantId,source:'local-original'}],issues:[]},fingerprint:'fingerprint-'+input.variantId,status:state.statuses[input.variantId],reasons:[state.statuses[input.variantId]==='NEEDS_INPUT'?'VISIBLE_CONTRADICTION:color':state.statuses[input.variantId]==='UNKNOWN'?'SOURCE_CONSISTENCY_SENT_UNKNOWN':'SOURCE_CONSISTENCY_PENDING'],assessmentId:null,observations:null,humanDecision:null});
window.red={getSourceConsistency:async input=>{state.calls.push({kind:'get',input});return view(input)},prepareSourceConsistency:async input=>{state.calls.push({kind:'prepare',input});state.statuses[input.variantId]='NEEDS_INPUT';const result=view(input);if(state.hold)await new Promise(done=>state.release=done);return result},decideSourceConsistency:async input=>{state.calls.push({kind:'decide',input});state.statuses[input.variantId]=input.decision==='CONFIRMED'?'MANUAL':'NEEDS_INPUT';return view(input)}};
function Fixture(){const[p,setProduct]=React.useState(product);state.setProduct=setProduct;state.product=product;return <SourceConsistencyPanel product={p} busy={false}/>;}createRoot(document.getElementById('root')).render(<Fixture/>);
`);
await build({entryPoints:[join(root,'fixture.tsx')],bundle:true,outfile:join(root,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
await writeFile(join(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><div id="root"></div><script src="fixture.js"></script></body></html>');
await writeFile(join(root,'main.cjs'),`const{app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,done)=>done({cancel:true}));const win=new BrowserWindow({show:false,width:1100,height:1000,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const require=createRequire(import.meta.url);process.env.electron_config_cache=resolve('.cache/electron');const env={...process.env,RED_E2E:'1',RED_DATA_DIR:join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;
let app;const errors=[];
try{
  app=await electron.launch({executablePath:require('electron'),args:[join(root,'main.cjs')],cwd:resolve('.'),env,timeout:35000});const page=await app.firstWindow();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  await expect(page.getByRole('status')).toHaveText('待核对');assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.kind==='prepare').length),0);
  await expect(page.getByAltText('BLUE 当前原图')).toBeVisible();await expect(page.getByRole('button',{name:'确认原图与当前规格匹配'})).toBeDisabled();
  await page.getByRole('button',{name:/观察当前原图/}).click();await expect(page.getByRole('status')).toHaveText('需要补充或更正');await expect(page.getByText('观察到的颜色或外观与原始规格不一致')).toBeVisible();
  await page.getByRole('textbox').fill('核对当前原图与 Blue round 可见特征');await page.getByRole('button',{name:'确认原图与当前规格匹配'}).click();await expect(page.getByRole('status')).toHaveText('已人工确认关联');
  const decision=await page.evaluate(()=>window.fixture.calls.find(c=>c.kind==='decide').input);assert.deepEqual(Object.keys(decision).sort(),['decision','fingerprint','productId','productRevision','reason','variantId']);assert.equal(decision.variantId,'blue');assert.equal(decision.fingerprint,'fingerprint-blue');
  await page.getByRole('combobox').selectOption('red');await expect(page.getByRole('status')).toHaveText('请求结果未知，不自动重发');await expect(page.getByAltText('RED 当前原图')).toBeVisible();await expect(page.getByAltText('BLUE 当前原图')).toHaveCount(0);
  await page.getByRole('textbox').fill('不能清除未知发送');await expect(page.getByRole('button',{name:'确认原图与当前规格匹配'})).toBeDisabled();await expect(page.getByRole('button',{name:/观察当前原图/})).toBeDisabled();await expect(page.getByText(/已有发送结果未知/)).toBeVisible();
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.kind==='prepare').length),1);
  await page.evaluate(()=>{window.fixture.statuses.blue='PENDING';window.fixture.hold=true;});
  await page.getByRole('combobox').selectOption('blue');await expect(page.getByRole('status')).toHaveText('待核对');await page.getByRole('button',{name:/观察当前原图/}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.fixture.release)).toBe('function');
  await page.evaluate(()=>{const f=window.fixture;f.statuses.blue='MATCH';f.setProduct({...f.product,id:'different-product',revision:2,variants:[{id:'blue',sku:'DIFFERENT',originalSpec:'Blue round'}]});});
  await expect(page.getByRole('status')).toHaveText('观察一致');await expect(page.getByAltText('DIFFERENT 当前原图')).toBeVisible();
  await page.evaluate(()=>window.fixture.release());await expect(page.getByRole('status')).toHaveText('观察一致');assert.deepEqual(errors,[]);
  await writeFile(join(root,'result.json'),JSON.stringify({ok:true,checks:9,errors},null,2));console.log(JSON.stringify({ok:true,checks:9,root}));
}finally{await app?.close();}
