// Offline APP integration: production renderer/preload/IPC/AutomaticListingService/AiService/BatchService.
// Only provider HTTP, image downstream and readiness boundaries are fixtures. No external I/O.
import { app,BrowserWindow,ipcMain,dialog } from 'electron';
import { resolve } from 'node:path';
import { fixture } from './listing-ai.ts';
import { AutomaticListingService } from '../../src/main/automatic-listing/service.ts';
import { installAutomaticListingIpc } from '../../src/main/automatic-listing-ipc.ts';
import { defaultListingRules } from '../../src/shared/listing-rules.ts';
const cleanup:(()=>unknown)[]=[];
app.setPath('userData',resolve(process.env.RED_DATA_DIR!));
globalThis.fetch=async()=>{throw Error('External network forbidden');};
void app.whenReady().then(async()=>{
 const f=await fixture({after:(fn:any)=>cleanup.push(fn)} as any),context=(f.ai as any).context,ordinary=context.fetch;
 f.ai.saveConnection({id:'openrouter',apiKey:'isolated-electron-batch-key'});f.ai.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});f.ai.saveFunctionSettings({id:'openrouter-review',model:'openai/gpt-6-luna',enabled:true});
 for(const p of f.ai.getPurposeProfiles())if(!p.purposeId.endsWith('_decision'))f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 let ready=false,posts=0,gets=0,downstream=0;const bodies=new Map<string,any>(),confirmations:any[]=[];
 context.fetch=async(url:unknown,init:RequestInit)=>{
  if(init.method==='POST'){if(String(url)!=='https://openrouter.ai/api/v1/batches')throw Error('Unexpected ordinary resend');const body=JSON.parse(String(init.body)),id='batch_app_'+(++posts);bodies.set(id,body);return Response.json({id,model:body.model,endpoint:'/v1/chat/completions',status:'in_progress'});}
  gets++;const id=String(url).split('/').at(-1)!,body=bodies.get(id),results=[];
  if(ready)for(const request of body.requests){const response=await ordinary('offline',{method:'POST',body:JSON.stringify({...request.body,model:body.model})});results.push({custom_id:request.custom_id,response:{status_code:200,body:await response.json()}});}
  return Response.json({id,model:body.model,endpoint:'/v1/chat/completions',status:ready?'completed':'in_progress',results});
 };
 const rules=defaultListingRules(),profile={id:'alpha',name:'Isolated hosting boundary',generation:1,enabled:true,configured:true,host:'fixture.test',port:21,secure:true,remoteRoot:'/',publicBaseUrl:'https://fixture.test/'};
 let progress:any=null;
 const automatic=new AutomaticListingService(f.directory,{store:f.store,amazon:f.amazon,hosting:{getProfile:()=>profile} as any,execution:{list:()=>[]} as any,followup:{} as any,procurement:{} as any,labels:{} as any,
  batch:f.ai.batchTasks,batchPlan:()=>f.ai.taskBatchPlan(),rules:()=>rules,
  classify:async()=>({productType:f.draft.schema.productType,reason:'Offline classification boundary',keywords:['coaster'],candidateTypes:[f.draft.schema.productType],decisionIds:[crypto.randomUUID(),crypto.randomUUID()],judged:false,classifiedAt:new Date().toISOString()}) as any,prepareSourceConsistency:async()=>{},
  images:{prepareSources:async()=>({product:f.store.getProduct(f.product.id),missing:[]}),getProgress:()=>progress,cancel:()=>({cancelled:true}),cancelSources:()=>({cancelled:true}),
   complete:async(input:any)=>{progress={status:'WAITING_BATCH',slots:[{index:1,status:'PENDING',attempts:[]}],maxAttempts:3};const result=await f.listing.suggest(input);downstream++;throw Error('Isolated downstream reached after adopted Batch result '+result.id);}} as any});
 const handle=(name:string,_count:number,handler:any)=>ipcMain.handle(name,async(_event,...args)=>{try{return {ok:true,data:await handler(...args)};}catch(error){return {ok:false,error:String(error)};}});
 installAutomaticListingIpc(automatic,handle,{confirm:async task=>{confirmations.push({mode:task.executionMode,skus:task.items.map(row=>row.sku)});const response=await dialog.showMessageBox({message:'Confirm isolated Batch task',buttons:['Cancel','Start']});return response.response===1;},audit:()=>{}});
 const handlers:Record<string,()=>unknown>={
  'red:products:list':()=>f.store.listProducts(),'red:amazon:targets':()=>f.amazon.listTargets(),'red:listing-rules:get':()=>rules,
  'red:hosting:profiles':()=>[profile],'red:image-risk:settings':()=>({enabled:false}),'red:copy-review:settings':()=>({enabled:true}),
  'red:ai:capabilities':()=>['text','text-review','image-generation','ocr','image-risk'].map(capability=>({capability,available:true})),
 };
 for(const [name,fn] of Object.entries(handlers))handle(name,0,fn);handle('red:products:get',1,(id:string)=>f.store.getProduct(id));
 Object.assign(globalThis,{__batchHarness:{close:async()=>{await automatic.close();for(const fn of cleanup.splice(0).reverse())await fn();},setBatchAvailable:(enabled:boolean)=>{f.ai.setEnabled({id:'openrouter',enabled});f.ai.setEnabled({id:'openrouter-review',enabled});},snapshot:()=>({posts,gets,downstream,confirmations,results:f.ai.listResults(f.product.id),tasks:automatic.list()}),release:async()=>{ready=true;await automatic.refreshWaiting();await automatic.waitForIdle();},drain:()=>automatic.waitForIdle()}});
 const window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{preload:resolve(process.env.RED_E2E_PRELOAD!),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 await window.loadFile(resolve(process.env.RED_E2E_HTML!));
 let closed=false;app.on('will-quit',event=>{if(closed)return;event.preventDefault();void(async()=>{await automatic.close();for(const fn of cleanup.reverse())await fn();closed=true;app.quit();})();});
});
