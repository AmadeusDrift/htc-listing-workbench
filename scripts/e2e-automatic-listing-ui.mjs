import { electron } from './e2e-core-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Exercise the real renderer components in a hidden, disposable Electron window.
// Every API is a local fixture and every remote request is denied. This never
// launches the normal application or reaches paid services, Amazon or a printer.
await mkdir(resolve('.test-data'), { recursive: true });
const root = await mkdtemp(resolve('.test-data/automatic-listing-ui-'));
const renderer = String.raw`
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutomaticPage } from '../../src/renderer/AutomaticPage';
import { ShippingPanel } from '../../src/renderer/ShippingPanel';
import { HostingSettings } from '../../src/renderer/HostingSettings';
import '../../src/renderer/styles.css';
import '../../src/renderer/workspace.css';
import '../../src/renderer/settings-modules.css';
import '../../src/renderer/glass-theme.css';
import '../../src/renderer/operations.css';
import '../../src/renderer/feedback.css';
import '../../src/renderer/flat-theme.css';
const copy = value => structuredClone(value);
const target = { id:'target-1', name:'美国店铺', configured:true, paused:false, marketplaceId:'ATVPDKIKX0DER', marketplaceName:'美国', locale:'en_US', mode:'live', sellerId:'seller' };
const product = { id:'product-1', title:'来源商品', updatedAt:'2026-10-08T00:00:00Z', revision:1, variantCount:3, assetCount:3, origin:'import', sourceUrl:'https://detail.1688.com/offer/123.html', variants:[{id:'v-z',sku:'SKU-Z'},{id:'v-a',sku:'SKU-A'},{id:'v-b',sku:'SKU-B'}], assets:[] };
const profiles = [{ id:'alpha', name:'Alpha', host:'images.example.test', publicBaseUrl:'https://images.example.test/', port:21, secure:true, remoteRoot:'/images', configured:true, enabled:true, generation:1 }];
const line = { id:'line-1',draftId:'draft-1',productId:'product-1',variantId:'v-z',title:'来源商品',spec:'3 件套',sku:'SKU-Z', targetId:target.id,targetName:target.name,asin:'ASIN1',fnsku:'FNSKU1',stockQuantity:5,purchaseQuantity:15,purchaseUnit:'件',labelStatus:'READY' };
const initialBatch = { id:'batch-1', name:'自动备货单', code:'B001', revision:1, mode:'live', lines:[line], shipment:{confirmationId:'FBA001',status:'LINKED_UNVERIFIED',linkedAt:'2026-10-08T00:00:00Z'} };
const label = { id:'label-1',batchId:'batch-1',lineId:'line-1',draftId:'draft-1',productId:'product-1',variantId:'v-z',sku:'SKU-Z',status:'READY',current:true,quantity:5,version:2,mode:'live',message:'标签文件已保存',format:{labelType:'STANDARD_FORMAT',pageType:'A4_21',localeCode:'en_US'},files:[{index:1,relativePath:'labels/a.pdf',byteSize:2345,sha256:'fixture'},{index:3,relativePath:'labels/b.pdf',byteSize:2345,sha256:'fixture'}] };
const state = window.fixture = { calls:[], tasks:[], products:[product], labels:[label,{...label,id:'label-old',version:1,current:false,status:'STALE',quantity:3,files:[{index:0,relativePath:'old.pdf'}]}], profiles, format:label.format, consent:true, documents:[], polls:0 };
const record = (name,input) => { state.calls.push({name,input:copy(input)}); };
window.red = {
 getActualQuoteDetails:async id=>({draftId:id,sku:'FIXTURE',draftRevision:1,sourceRevision:1,ruleRevision:7,bundleQuantity:null,exempt:true,qualified:false,issue:null,offers:[]}),
 getAutomaticBatchPlan:async()=>({version:1,credentialScope:'component-only',purposes:[],coverage:[]}),
 getAutomaticBatchSummary:async()=>({mode:'immediate',plan:null,batches:[],details:[]}),
 getAutomaticListingQueue:async input=>{state.queueReads=(state.queueReads??0)+1;return ({targetId:input.targetId,scope:{mode:'live',sellerId:input.targetId==='target-1'?'seller':'other-seller',marketplaceId:'ATVPDKIKX0DER'},ruleRevision:7,products:state.products.filter(p=>input.productIds.includes(p.id)).map(p=>{
  const scoped=input.targetId==='target-1',inputIssue=scoped&&state.queueMode==='input'?'销售配方待补资料：包装件数冲突':undefined;
  const rows=inputIssue?[]:p.variants.slice(0,scoped&&['mixed','reasons'].includes(state.queueMode)?3:2).map((v,index)=>{
   const kind=state.queueMode==='status'?['COMPLETED','SUBMITTED'][index]:scoped&&state.queueMode==='unknown'?'UNKNOWN':scoped&&(state.queueMode==='all'||['partial','mixed'].includes(state.queueMode)&&index===0||state.queueMode==='reasons'&&index<2)?'RULE_FILTERED':scoped&&['mixed','reasons'].includes(state.queueMode)&&index===2?'SYSTEM_REPAIR':'PENDING';
   return {key:p.id+':'+v.id,productId:p.id,recipeKey:v.id,specification:v.sku,sku:v.sku,kind,...(state.queueMode==='guidance'?{noticeCode:index===0?'SOURCE_CHANGED':'UNKNOWN_RECONCILED',continuationRequired:index===1}:{}),reasonCode:state.queueMode==='reasons'?['ROI_MAX_PRICE','IP_PLAN_BLOCKED','SOURCE_DOWNLOAD_FAILED'][index]:kind==='RULE_FILTERED'?'ROI_MAX_PRICE':kind==='SYSTEM_REPAIR'?'SYSTEM_FAILURE':undefined,eligible:kind==='PENDING',message:['status','guidance'].includes(state.queueMode)?'https://secret.invalid':state.queueMode==='reasons'?['已确认 ROI 规则未通过','来源图片触发 IP 风险规则','来源图片下载失败，保留原任务待修复'][index]:kind==='RULE_FILTERED'?'已确认 ROI 规则未通过':kind==='SYSTEM_REPAIR'?'图片服务响应异常，保留原任务待修复':'',reconsideration:null,taskId:null};
  });return {productId:p.id,title:p.title,inputIssue,rows,eligibleCount:rows.filter(r=>r.eligible).length,pendingCount:rows.filter(r=>r.kind!=='RULE_FILTERED').length,filteredCount:rows.filter(r=>r.kind==='RULE_FILTERED').length};})});},
 getListingRules:async()=>({revision:7,product:{variantLimit:2,stockSets:5}}),
 listAiCapabilities:async()=>['text','text-review','image-generation','ocr','image-risk'].map(capability=>({capability,available:true})),
 getImageRiskSettings:async()=>({enabled:true}), getCopyReviewSettings:async()=>({enabled:true}),
 getProduct:async id=>{record('readProduct',id);const value=state.products.find(item=>item.id===id);if(!value)throw Error('来源商品不存在');return copy(value)}, listFtpProfiles:async()=>copy(state.profiles),
 importFtpProfile:async()=>{record('importHosting',null);state.profiles[0].enabled=false;return copy(state.profiles[0])},
 exportFtpProfileTemplate:async id=>{record('templateHosting',id);return {cancelled:false}},
 setFtpProfileEnabled:async input=>{record('enableHosting',input);state.profiles[0].enabled=input.enabled;return copy(state.profiles[0])},
 searchAmazonProductTypes:async input=>{record('search',input);return [{name:'STORAGE_BAG',displayName:'Storage bags'}]},
 previewAutomaticListingAdaptation:async id=>({taskId:id,token:'mock-preview',sources:copy(state.products),blockers:[],changes:[],canApply:false}),
 listAutomaticListingTasks:async()=>{state.polls++;return copy(state.tasks)}, getAutomaticListingTask:async id=>copy(state.tasks.find(task=>task.id===id)),
 startAutomaticListing:async input=>{record('start',input);if(!state.consent)return null;const task={id:'task-1',revision:1,status:'RUNNING',targetId:target.id,targetName:target.name,mode:'live',productType:input.productType??'AUTO',profileId:input.profileId,ruleRevision:7,createdAt:'2026-10-08T00:00:00Z',updatedAt:'2026-10-08T00:00:00Z',error:null,items:product.variants.slice(0,2).map((variant,index)=>({key:variant.id,productId:product.id,productTitle:product.title,variantId:variant.id,sku:variant.sku,stockSets:5,status:index?'RUNNING':'WAITING',stage:index?'LABELS':'READBACK',draftId:'draft-'+index,executionTaskIds:['execute-'+index],imageAttempts:1,repairAttempts:0,batchId:index?'batch-1':null,error:null}))};state.tasks=[task];return copy(task)},
 pauseAutomaticListingTask:async id=>{record('pause',id);state.tasks[0].status='PAUSED';return copy(state.tasks[0])},
 resumeAutomaticListingTask:async id=>{record('resume',id);state.tasks[0].status='RUNNING';return copy(state.tasks[0])},
 cancelAutomaticListingTask:async id=>{record('cancel',id);state.tasks[0].status='CANCELLED';return copy(state.tasks[0])},
 listItemLabels:async()=>copy(state.labels), getItemLabel:async id=>copy(state.labels.find(value=>value.id===id)),
 getItemLabelFormat:async()=>copy(state.format),saveItemLabelFormat:async input=>{record('format',input);state.format=copy(input);return copy(input)},
 prepareItemLabels:async id=>{record('prepareLabels',id);return copy(state.labels)},
 retryItemLabel:async id=>{record('retry',id);const value=state.labels.find(item=>item.id===id);value.status='QUEUED';return copy(value)},
 openItemLabel:async input=>{record('openLabel',input);if(state.labelOpenError)throw Error('标签文件不存在，请重新获取')},exportItemLabels:async input=>{record('export',input);return {cancelled:false}},
 exportProcurementBatch:async()=>({cancelled:true}),
 listProcurementShipmentDocuments:async()=>copy(state.documents),
 importProcurementShipmentDocument:async batchId=>{record('importShipment',batchId);const value={id:'doc-1',batchId,shipmentId:'FBA001',fileName:'箱唛.pdf',relativePath:'shipment/a.pdf',byteSize:1000,createdAt:'2026-10-08T00:00:00Z',status:'LINKED_UNVERIFIED'};state.documents.push(value);return copy(value)},
 openProcurementShipmentDocument:async id=>record('openShipment',id),
};
function Fixture(){const [screen,setScreen]=useState('auto'),[batch,setBatch]=useState(initialBatch),[dirty,setDirty]=useState(false);return <main style={{padding:24}}><nav><button onClick={()=>setScreen('auto')}>查看自动任务</button><button onClick={()=>setScreen('away')}>离开测试页面</button><button onClick={()=>setScreen('labels')}>查看标签</button><button onClick={()=>setScreen('hosting')}>配置图片托管</button></nav>{screen==='auto'?<AutomaticPage products={[product]} targets={[target,{...target,id:"target-2",name:"第二店铺",sellerId:"seller-2"}]} busy={false} onExamples={()=>{}} onInbox={()=>{}} onSettings={value=>record('settings',value)} onManual={(productId,draftId)=>record('manual',{productId,draftId})}/>:screen==='labels'?<div className="operations-page"><ShippingPanel batch={batch} busy={false} dirty={dirty} run={async(_label,task)=>task()} onChange={value=>{setBatch(value);setDirty(true)}} onSave={async()=>{setDirty(false);return true}}/></div>:screen==='hosting'?<HostingSettings busy={false}/>:<p>其他工作区</p>}</main>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await writeFile(join(root, 'fixture.tsx'), renderer);
await build({ entryPoints:[join(root,'fixture.tsx')], bundle:true, outfile:join(root,'fixture.js'), platform:'browser', format:'iife', jsx:'automatic', loader:{'.woff2':'dataurl','.woff':'dataurl'}, logLevel:'silent' });
await writeFile(join(root,'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><div id="root"></div><script src="fixture.js"></script></body></html>');
await writeFile(join(root,'main.cjs'), `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true}));const win=new BrowserWindow({width:1360,height:1100,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const require = createRequire(import.meta.url);
process.env.electron_config_cache = resolve('.cache/electron');
const env={...process.env,RED_E2E:'1',RED_DATA_DIR:join(root,'data')};delete env.ELECTRON_RUN_AS_NODE;
let app;
const checks=[],errors=[];
function pass(value){checks.push(value);console.log('PASS '+value)}
async function capture(fileName, selector, height=1100) {
 const page=await app.firstWindow();
 for(const width of [1361,1360]) {
   const contentWidth=await app.evaluate(({BrowserWindow},size)=>{const window=BrowserWindow.getAllWindows()[0];window.setSize(...size);return window.getContentSize()[0]},[width,height]);
   await expect.poll(()=>page.evaluate(()=>window.innerWidth)).toBe(contentWidth);
 }
 await page.locator(selector).evaluate(element=>element.scrollIntoView({block:'start'}));
 await page.evaluate(async()=>{await document.fonts.ready;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))});
 const pixels=await app.evaluate(async({BrowserWindow})=>{
   const window=BrowserWindow.getAllWindows()[0];
   return (await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');
 });
 await writeFile(join(root,fileName),Buffer.from(pixels,'base64'));
}
try {
 app=await electron.launch({executablePath:require('electron'),args:[join(root,'main.cjs')],cwd:resolve('.'),env,timeout:35000});
 const page=await app.firstWindow();await page.clock.install();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
 await page.getByTestId('automatic-select-product-1').check();
 await page.getByRole('combobox',{name:/目标店铺与站点/}).selectOption('target-1');
 await expect(page.getByText(/本次可启动 2 个销售 SKU/)).toBeVisible();


 await page.evaluate(()=>window.fixture.queueMode='status');await page.getByRole('button',{name:'刷新资料与连接',exact:true}).click();await page.getByRole('tab',{name:/已提交与完成/}).click();await page.getByTestId('automatic-product-1').locator('summary').click();
 await expect(page.getByTestId('automatic-product-1')).toContainText('流程已完成');await expect(page.getByTestId('automatic-product-1')).toContainText('已提交，等待平台回读');await expect(page.getByTestId('automatic-product-1')).not.toContainText('无法归因');
 await page.evaluate(()=>window.fixture.queueMode='guidance');await page.getByRole('button',{name:'刷新资料与连接',exact:true}).click();await page.getByRole('tab',{name:/待上架/}).click();
 if(!await page.getByTestId('automatic-product-1').getAttribute('open'))await page.getByTestId('automatic-product-1').locator('summary').click();
 await expect(page.getByTestId('automatic-product-1')).toContainText('来源资料已变化，重新评估');await expect(page.getByTestId('automatic-product-1')).toContainText('原未知结果已核对');await expect(page.getByTestId('automatic-product-1')).toContainText('请继续或取消原任务');await expect(page.getByTestId('automatic-product-1')).not.toContainText('secret.invalid');
 pass('queue completion, readback, stale-rule reassessment and original-task guidance preserve typed producer messages');
 await page.getByTestId('automatic-product-1').locator('summary').click();
 const start=page.getByRole('button',{name:'启动并自动发布',exact:true});
 await page.evaluate(()=>window.fixture.queueMode='input');await page.getByRole('button',{name:'刷新资料与连接',exact:true}).click();
 await expect(page.getByTestId('automatic-select-product-1')).toBeDisabled();await expect(start).toBeDisabled();await page.getByRole('tab',{name:'待修复与核对 1',exact:true}).click();await page.getByTestId('automatic-product-1').locator('summary').click();
 await expect(page.getByTestId('automatic-product-1').getByText('来源资料尚不完整。请进入商品资料核对。',{exact:true})).toHaveCount(1);
 await page.evaluate(()=>window.fixture.queueMode='mixed');await page.getByRole('button',{name:'刷新资料与连接',exact:true}).click();
 await expect(page.getByText(/本次可启动 1 个销售 SKU/)).toBeVisible();await expect(page.getByTestId('automatic-product-1')).toContainText('系统处理未完成，尚无更细的可信归因');
 await mkdir(resolve('artifacts'),{recursive:true});await capture('automatic-outcome-queue.png','body');
 await page.evaluate(()=>window.fixture.queueMode='reasons');await page.getByRole('button',{name:'刷新资料与连接',exact:true}).click();
 const reasonSearch=page.getByRole('searchbox',{name:'搜索商品、SKU或原因',exact:true});await reasonSearch.fill('ROI');await page.getByRole('tab',{name:'规则淘汰 1',exact:true}).click();
 await expect(page.getByText('匹配：1 个来源商品 · 1 个销售配方',{exact:true})).toBeVisible();await expect(page.getByTestId('automatic-product-1')).toContainText('已确认 ROI');await expect(page.getByTestId('automatic-product-1')).not.toContainText('IP 风险');
 await reasonSearch.fill('IP');await expect(page.getByTestId('automatic-product-1')).toContainText('IP 风险');await expect(page.getByTestId('automatic-product-1')).not.toContainText('已确认 ROI');
 await reasonSearch.fill('下载');await page.getByRole('tab',{name:'待修复与核对 1',exact:true}).click();await expect(page.getByTestId('automatic-product-1')).toContainText('来源图片下载未完成');await expect(page.getByTestId('automatic-product-1')).not.toContainText('IP 风险');
 await page.getByRole('button',{name:'清除搜索',exact:true}).click();await expect(reasonSearch).toHaveValue('');await expect(page.getByTestId('automatic-product-1')).toContainText('已确认 ROI');await expect(page.getByTestId('automatic-product-1')).toContainText('IP 风险');
 await page.getByRole('tab',{name:'待上架 1',exact:true}).click();
 await page.evaluate(()=>window.fixture.queueMode='partial');await page.getByRole('button',{name:'刷新资料与连接',exact:true}).click();
 await expect(page.getByText(/本次可启动 1 个销售 SKU/)).toBeVisible();await expect(page.getByTestId('automatic-select-product-1')).toBeEnabled();
 await page.getByRole('tab',{name:'规则淘汰 1',exact:true}).click();await page.getByTestId('automatic-product-1').locator('summary').click();await expect(page.getByTestId('automatic-product-1')).toContainText('已确认 ROI 规则未通过');
 await page.evaluate(()=>window.fixture.queueMode='all');await page.getByRole('button',{name:'刷新资料与连接',exact:true}).click();await page.getByRole('tab',{name:'待上架 0',exact:true}).click();
 await expect(page.getByTestId('automatic-product-1')).toHaveCount(0);await expect(page.getByTestId('automatic-select-product-1')).toHaveCount(0);await expect(start).toBeDisabled();
 await page.getByRole('combobox',{name:/目标店铺与站点/}).selectOption('target-2');await expect(page.getByTestId('automatic-select-product-1')).toBeEnabled();await expect(page.getByText(/本次可启动 2 个销售 SKU/)).toBeVisible();
 await page.evaluate(()=>window.fixture.queueMode=null);await page.getByRole('combobox',{name:/目标店铺与站点/}).selectOption('target-1');await expect(start).toBeEnabled();
 pass('selected target drives recipe counts, partial filters retain healthy recipes, all filtered products leave pending and remain in the reason tab');
 await expect(start).toBeEnabled();
 await expect(page.getByText(/每个来源链接按配置、资料和代表性选择，最多 2 个销售 SKU，不含说明性选项/)).toBeVisible();
 await page.evaluate(()=>window.fixture.consent=false);await start.click();
 await expect(start).toBeEnabled();assert.equal(await page.evaluate(()=>window.fixture.tasks.length),0);
 await page.evaluate(()=>window.fixture.consent=true);await start.click();
 await expect(page.getByTestId('automatic-task-task-1')).toBeVisible();
 const submitted=await page.evaluate(()=>window.fixture.calls.filter(call=>call.name==='start').at(-1).input);
 assert.deepEqual(submitted,{productIds:['product-1'],targetId:'target-1',profileId:'alpha',executionMode:'immediate'});
 await expect(page.getByTestId('automatic-product-group-product-1')).toBeVisible();
 await expect(page.getByTestId('automatic-product-group-product-1')).toContainText('来源规格 3');
 await expect(page.getByTestId('automatic-product-group-product-1')).toContainText('本次销售 SKU 2');
 await expect(page.getByTestId('automatic-result-v-z')).toHaveCount(0);
 await page.getByTestId('automatic-product-group-product-1').getByRole('button',{name:/展开来源商品/}).click();
 await expect(page.getByTestId('automatic-result-v-z')).toContainText('已提交，等待读回');
 await expect(page.getByTestId('automatic-result-v-a')).toContainText('核对平台建档结果');
 await expect(page.getByTestId('automatic-result-v-a')).toContainText('平台建档结果待核对');
 await expect(page.getByTestId('automatic-result-v-z')).toContainText('等待 Amazon 回读');
 pass('single start passes the selected source-order scope; cancelled native confirmation creates no task; submission and label stages remain distinct');
 await page.getByRole('button',{name:'离开测试页面',exact:true}).click();
 const polls=await page.evaluate(()=>window.fixture.polls);await page.clock.fastForward(30_001);
 assert.equal(await page.evaluate(()=>window.fixture.polls),polls);
 assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call.name==='cancel').length),0);
 await page.getByRole('button',{name:'查看自动任务',exact:true}).click();
 await expect(page.getByTestId('automatic-task-task-1')).toBeVisible();
 await page.getByRole('button',{name:'暂停任务',exact:true}).click();
 await expect(page.getByTestId('automatic-task-task-1')).toContainText('已暂停');
 await page.getByRole('button',{name:'继续任务',exact:true}).click();
 await expect(page.getByTestId('automatic-task-task-1')).toContainText('运行中');
 await page.getByRole('button',{name:'取消任务',exact:true}).click();
 await expect(page.getByTestId('automatic-task-task-1')).toContainText('已取消');
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.filter(call=>['pause','resume','cancel'].includes(call.name)).map(call=>call.name)),['pause','resume','cancel']);
 pass('navigation stops only polling; saved tasks return and explicit pause, resume and cancel use the task API');
 await page.evaluate(()=>{
  const task=window.fixture.tasks[0];task.revision++;task.status='NEEDS_ATTENTION';
  Object.assign(task.items[0],{status:'FAILED',stage:'LABELS',error:null,outcome:{kind:'SYSTEM_REPAIR',message:'历史标签失败测试原因'}});
  Object.assign(task.items[1],{status:'DONE',stage:'COMPLETE',error:null});
 });
 await page.clock.fastForward(30_001);
 await expect(page.getByTestId('automatic-task-task-1')).toContainText('需要处理');
 await page.getByTestId('automatic-product-group-product-1').getByRole('button',{name:/展开来源商品/}).click();await expect(page.getByTestId('automatic-result-v-z')).toContainText('历史记录未保存可信的结构化细因');
 await page.evaluate(()=>{const task=window.fixture.tasks[0];task.revision++;task.status='COMPLETED';Object.assign(task.items[0],{status:'DONE',stage:'COMPLETE',error:null});});
 await page.clock.fastForward(30_001);
 await expect(page.getByTestId('automatic-result-v-z')).toHaveAttribute('data-state','DONE');await expect(page.getByTestId('automatic-result-v-z')).not.toContainText('历史记录未保存可信的结构化细因');
 assert.equal(await page.evaluate(()=>window.fixture.tasks[0].items[0].outcome.message),'历史标签失败测试原因');
 pass('completed sales rows retain failure audit without displaying an old fault as the current result');
 await page.evaluate(()=>{const task=window.fixture.tasks[0];task.revision++;task.status='NEEDS_ATTENTION';Object.assign(task.items[0],{status:'FAILED',stage:'READBACK',error:'原提交已满 24 小时，仍未确认处理完成；可继续查询，禁止重复提交',outcome:{kind:'SYSTEM_REPAIR',code:'READBACK_FAILED'}});});
 await page.clock.fastForward(30_001);
 await expect(page.getByTestId('automatic-result-v-z')).toContainText('24 小时');
 await expect(page.getByTestId('automatic-result-v-z')).toContainText('禁止重复提交');
 await page.evaluate(()=>{const fixture=window.fixture,background=structuredClone(fixture.tasks[0]);background.id='task-background';background.revision=1;background.status='RUNNING';background.items=background.items.map(row=>({...row,status:'PENDING',stage:'DRAFT',outcome:undefined}));fixture.tasks.push(background);fixture.queueMode=null;});
 await page.clock.fastForward(30_001);
 await expect(page.getByRole('combobox',{name:'选择自动上架任务',exact:true}).locator('option')).toHaveCount(2);
 await page.getByRole('combobox',{name:'选择自动上架任务',exact:true}).selectOption('task-1');await page.getByRole('combobox',{name:/目标店铺与站点/}).selectOption('target-1');await expect(page.getByRole('tab',{name:'待上架 1',exact:true})).toBeVisible();
 await page.clock.fastForward(30_001);
 await page.evaluate(()=>{const fixture=window.fixture,task=fixture.tasks.find(task=>task.id==='task-background');task.revision++;task.status='COMPLETED';task.items.forEach(row=>{row.status='SCREENED';row.outcome={kind:'RULE_FILTERED',code:'ROI_MAX_PRICE',message:'已确认 ROI 规则未通过'};});fixture.queueMode='all';});
 await page.clock.fastForward(30_001);
 await expect(page.getByRole('tab',{name:'待上架 0',exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:'规则淘汰 1',exact:true})).toBeVisible();await expect(page.getByTestId('automatic-task-task-1')).toBeVisible();
 await page.evaluate(()=>{const fixture=window.fixture,task=fixture.tasks.find(task=>task.id==='task-background');task.revision++;task.status='NEEDS_ATTENTION';task.items.forEach(row=>{row.status='FAILED';row.outcome={kind:'UNKNOWN',message:'结果待核对'};});fixture.queueMode='unknown';});
 await page.clock.fastForward(30_001);
 await expect(page.getByRole('tab',{name:'待修复与核对 1',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'启动并自动发布',exact:true})).toBeDisabled();
 const queueReads=await page.evaluate(()=>window.fixture.queueReads);await page.clock.fastForward(30_001);assert.equal(await page.evaluate(()=>window.fixture.queueReads),queueReads,'unchanged task-list polls must not recheck queue evidence');
 await page.evaluate(()=>{window.fixture.tasks=window.fixture.tasks.filter(task=>task.id==='task-1');window.fixture.queueMode=null;});
 pass('background task revisions refresh the queue while a completed task is selected; unchanged polls do not reread evidence');
 await page.getByRole('button',{name:'离开测试页面',exact:true}).click();
 await page.evaluate(()=>{
   const fixture=window.fixture, template=fixture.products[0];
   const products=[1,54,56,1,7,12,7,1,7,39,5,2].map((count,index)=>({...template,id:'bulk-'+index,title:'来源商品 '+(index+1),variantCount:count,sourceUrl:'https://detail.1688.com/offer/'+(1000+index)+'.html',variants:Array.from({length:count},(_,variant)=>({id:'bulk-'+index+'-v-'+variant,sku:'SOURCE-'+index+'-'+variant,originalSpec:'颜色 '+variant,normalizedSpec:'',sourceSpec:'',purchasePrice:'',inventory:null}))}));
   const seed={...fixture.tasks[0].items[0],outcome:undefined};
   const items=products.flatMap((product,productIndex)=>product.variants.slice(0,20).map((variant,index)=>({...seed,key:variant.id,productId:product.id,productTitle:product.title,variantId:variant.id,sku:'SALE-'+productIndex+'-'+index,status:productIndex===1&&index===0?'FAILED':'PENDING',stage:'DRAFT',draftId:'draft-'+variant.id,error:productIndex===1&&index===0?'需要补充来源事实':null,salesPlan:productIndex===1?{sourceGroupKey:'family-source-'+productIndex,parentSku:index<4?'PARENT-COLOR-A':null,parentage:index<4?'CHILD':'NONE',familyResolved:true,relationReason:index<4?'颜色变体':'独立销售',recipe:{specification:'颜色 '+index,color:'颜色 '+index,totalPieces:1,components:[{variantId:variant.id}]}}:undefined})));
   Object.assign(items.find(item=>item.sku==='SALE-2-0'),{status:'FAILED',stage:'DRAFT',error:'定价未通过：售价上限内无法满足目标 ROI'});
   Object.assign(items.find(item=>item.sku==='SALE-3-0'),{status:'FAILED',stage:'SOURCES',error:'来源图片映射为空'});
   Object.assign(items.find(item=>item.sku==='SALE-4-0'),{status:'WAITING',stage:'READBACK',error:null});
   Object.assign(items.find(item=>item.sku==='SALE-5-0'),{status:'RUNNING',stage:'DRAFT',error:null});
   Object.assign(items.find(item=>item.sku==='SALE-6-0'),{status:'WAITING',stage:'IMAGES',error:null});
   fixture.products=[template,...products];fixture.tasks=[{...fixture.tasks[0],id:'task-bulk',status:'NEEDS_ATTENTION',items}];
 });
 await page.getByRole('button',{name:'查看自动任务',exact:true}).click();
 const bulk=page.getByTestId('automatic-task-task-bulk');
 await expect(bulk.locator('[data-testid^="automatic-product-group-"]')).toHaveCount(12);
 await expect(bulk.getByLabel('当前任务范围')).toHaveText('来源商品链接12来源规格192本次销售 SKU103');
 await expect(bulk.getByLabel('任务待确认分类')).toContainText('规则淘汰 0');await expect(bulk.getByLabel('任务待确认分类')).toContainText('历史未分类 3');
 await expect(bulk.getByRole('status')).toContainText('已提交待回读 1 · 流程完成 0 / 103');
 await expect(bulk.getByRole('status')).toContainText('处理中 1');
 await expect(bulk.getByRole('status')).toContainText('等待服务 1');
 const displayedCounts=await bulk.locator('.automatic-task-counts .outcome-count').allTextContents();
 assert.equal(displayedCounts.reduce((sum,text)=>sum+Number(text.match(/ (\d+)/)[1]),0),103,'all visible summary buckets must total current sales SKUs exactly once');
 await expect(bulk.locator('[data-testid^="automatic-result-"]')).toHaveCount(0);
 await capture('grouped-products-collapsed.png','[aria-label="当前任务范围"]',1900);
 const bulkGroup=page.getByTestId('automatic-product-group-bulk-1');
 await bulkGroup.getByRole('button',{name:/展开来源商品/}).click();
 await expect(bulkGroup.locator('[data-testid^="automatic-result-"]')).toHaveCount(20);
 await expect(bulkGroup.getByRole('region',{name:'父 SKU PARENT-COLOR-A'})).toContainText('4 个销售 SKU');
 await bulkGroup.locator('.automatic-source-variants summary').click();
 await expect(bulkGroup.locator('[data-testid^="automatic-source-variant-"]')).toHaveCount(54);
 await expect(bulkGroup.locator('[data-testid^="automatic-source-variant-"][data-selected="false"]')).toHaveCount(34);
 await expect(page.getByTestId('automatic-source-variant-bulk-1-v-53')).toContainText('未纳入本次任务');
 await bulkGroup.getByRole('button',{name:'查看并处理异常',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.filter(call=>call.name==='manual').at(-1).input),{productId:'bulk-1',draftId:'draft-bulk-1-v-0'});
 await capture('grouped-product-expanded.png','[data-testid="automatic-product-group-bulk-1"]');
 const productReads=await page.evaluate(()=>window.fixture.calls.filter(call=>call.name==='readProduct').length);
 await page.clock.fastForward(30_001);
 assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call.name==='readProduct').length),productReads,'task polling must not reread every source product');
 await bulk.getByLabel('搜索任务商品或 SKU').fill('SOURCE-1-53');
 await expect(bulk.locator('[data-testid^="automatic-product-group-"]')).toHaveCount(1);
 await expect(page.getByTestId('automatic-source-variant-bulk-1-v-53')).toBeVisible();
 await bulkGroup.locator('.automatic-source-variants summary').click();
 await page.clock.fastForward(30_001);
 assert.equal(await bulkGroup.locator('.automatic-source-variants').evaluate(details=>details.open),false,'source detail folding must survive task polling while search remains active');
 await bulkGroup.getByRole('button',{name:/收起来源商品/}).click();
 await page.clock.fastForward(30_001);
 await expect(bulkGroup.getByRole('button',{name:/展开来源商品/})).toHaveAttribute('aria-expanded','false');
 await bulk.getByLabel('搜索任务商品或 SKU').fill('sale-9-19');
 await expect(bulk.locator('[data-testid^="automatic-product-group-"]')).toHaveCount(1);
 await expect(page.getByTestId('automatic-result-bulk-9-v-19')).toBeVisible();
 await bulk.getByRole('button',{name:'收起全部商品',exact:true}).click();
 await expect(bulk.locator('[data-testid^="automatic-product-group-"]')).toHaveCount(12);
 await expect(bulk.locator('[data-testid^="automatic-result-"]')).toHaveCount(0);
 pass('12 source cards preserve source/sales counts, actual parent families and excluded variants; search and manual folding survive polling, pricing/source/workflow outcomes and submission/completion remain distinct');
 await page.getByRole('button',{name:'查看标签',exact:true}).click();
 await expect(page.getByTestId('item-label-line-1')).toContainText('5 张');
 await expect(page.getByTestId('item-label-line-1')).not.toContainText('15 张');
 await page.getByRole('button',{name:'准备本批次标签',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call.name==='prepareLabels').length),1);
 assert.equal(await page.evaluate(()=>window.fixture.calls.find(call=>call.name==='prepareLabels').input),'batch-1');
 await page.getByRole('button',{name:'打开标签文件 2',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.find(call=>call.name==='openLabel').input),{id:'label-1',fileIndex:3});
 await page.getByRole('button',{name:'导出本批次标签',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.fixture.calls.find(call=>call.name==='export').input),'batch-1');
 pass('label count uses sales units and file opening preserves the actual backend file index');
 await page.getByText('历史标签版本（1）',{exact:true}).click();
 await expect(page.getByText('以下版本已失效，不用于当前备货贴标。',{exact:true})).toBeVisible();
 assert.equal(await page.getByRole('button',{name:'打开标签文件',exact:false}).count(),2);
 await page.getByText('设置标签纸规格',{exact:true}).click();
 await page.getByLabel('标签排版',{exact:true}).selectOption('A4_24_64x33');
 await page.getByRole('button',{name:'保存标签格式',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.fixture.format),{labelType:'STANDARD_FORMAT',pageType:'A4_24_64x33',localeCode:'en_US'});
 await page.getByLabel('标签纸类型',{exact:true}).selectOption('THERMAL_PRINTING');
 await page.getByLabel('热敏标签宽度（mm）',{exact:true}).fill('20');
 await expect(page.getByRole('button',{name:'保存标签格式',exact:true})).toBeDisabled();
 await page.getByLabel('热敏标签宽度（mm）',{exact:true}).fill('60');
 await page.getByLabel('热敏标签高度（mm）',{exact:true}).fill('40');
 await page.getByRole('button',{name:'保存标签格式',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.fixture.format),{labelType:'THERMAL_PRINTING',width:60,height:40,localeCode:'en_US'});
 pass('A4 and thermal paper settings persist through the format API and reject invalid dimensions');
 await page.evaluate(()=>window.fixture.labelOpenError=true);
 await page.getByRole('button',{name:'打开标签文件 1',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'标签文件不存在，请重新获取'})).toBeVisible();
 await page.clock.fastForward(30_001);
 await expect(page.getByRole('alert').filter({hasText:'标签文件不存在，请重新获取'})).toBeVisible();
 await page.evaluate(()=>window.fixture.labelOpenError=false);
 pass('file-opening errors remain visible while background status polling continues');
 await page.evaluate(()=>{window.fixture.labels[0].status='FAILED';window.fixture.labels[0].message='平台暂时不可用'});
 await page.getByRole('button',{name:'刷新标签',exact:true}).click();
 await expect(page.getByTestId('item-label-line-1')).toContainText('平台暂时不可用');
 await expect(page.getByRole('button',{name:'打开标签文件 1',exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:'导出本批次标签',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'重试此 SKU 标签',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.fixture.calls.find(call=>call.name==='retry').input),'label-1');
 pass('failed labels show server messages and require retry before printing or batch export');
 await page.getByRole('button',{name:'导入货件 / 箱唛文件',exact:true}).click();
 await expect(page.getByText('箱唛.pdf',{exact:true})).toBeVisible();
 await expect(page.getByText('人工关联，未平台核验',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'打开箱唛.pdf',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.fixture.calls.find(call=>call.name==='openShipment').input),'doc-1');
 await page.getByLabel('Amazon 货件号',{exact:true}).fill('FBA002');
 await expect(page.getByRole('button',{name:'导入货件 / 箱唛文件',exact:true})).toBeDisabled();
 await expect(page.getByText('历史货件附件，与当前货件号不一致',{exact:true})).toBeVisible();
 pass('manual shipment attachments remain bound to their shipment number and are clearly distinguished from platform-verified records');
 await page.getByRole('button',{name:'配置图片托管',exact:true}).click();
 await page.getByRole('button',{name:'下载 Alpha 模板',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.fixture.calls.find(call=>call.name==='templateHosting').input),'alpha');
 await page.getByRole('button',{name:'导入托管配置',exact:true}).click();
 await page.getByRole('button',{name:'启用 Alpha',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.find(call=>call.name==='enableHosting').input),{id:'alpha',enabled:true});
 await page.getByRole('button',{name:'停用 Alpha',exact:true}).click();
 await page.getByRole('button',{name:'查看自动任务',exact:true}).click();
 await page.getByTestId('automatic-select-product-1').check();
 await page.getByLabel('目标店铺与站点',{exact:true}).selectOption('target-1');


 await expect(page.getByRole('button',{name:'启动并自动发布',exact:true})).toBeDisabled();
 await expect(page.getByLabel('图片托管服务器',{exact:true})).toHaveValue('');
 pass('hosting supports native config import, safe template export and enable toggles; disabled profiles cannot start automatic publishing');
 assert.deepEqual(errors,[]);
 await writeFile(join(root,'result.json'),JSON.stringify({checks,errors},null,2));
 console.log(JSON.stringify({ok:true,checks:checks.length,root}));
} finally {await app?.close();}
