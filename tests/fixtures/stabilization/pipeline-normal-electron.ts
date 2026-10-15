// Real service normal worker; controller owns every external HTTP/FTP response.
import assert from 'node:assert/strict';
import {app,BrowserWindow,net,safeStorage} from 'electron';
import {readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createNormalServices} from './pipeline-normal-services.ts';
import {createSystemProxyFetch} from '../../../src/main/ai-network.ts';
import {AiSpendBudget} from '../../../src/main/ai/spend-budget.ts';
import {openDatabase} from '../../../src/main/database.ts';
const guard=(globalThis as typeof globalThis&{__s10Guard?:{installedBeforeMain:boolean;blocked:string[];nativeProtocolSent:number;nodeProtocolSent:number;withRoutePermit:<T>(permit:unknown,work:()=>T)=>T}}).__s10Guard;
assert.ok(guard?.installedBeforeMain);assert.ok(process.env.RED_DATA_DIR&&process.env.S10_POLICY_FILE);
const activeGuard=guard;
const policy=JSON.parse(readFileSync(process.env.S10_POLICY_FILE,'utf8')),root=process.env.RED_DATA_DIR,config=JSON.parse(readFileSync(join(root,'normal-config.json'),'utf8'));assert.equal(root,policy.dataRoot);
app.setPath('userData',root);app.setName('S10 real normal synthetic worker');app.enableSandbox();
void app.whenReady().then(async()=>{
  const fetcher=createSystemProxyFetch(async(url,init={})=>{
    const frozen={...init,headers:Object.fromEntries(new Headers(init.headers)),...(init.body!==undefined?{body:typeof init.body==='string'?init.body:new Uint8Array(Buffer.from(init.body as Uint8Array))}:{})},method=String(frozen.method??'GET').toUpperCase(),headers=new Headers(frozen.headers);
    if(config.staticRequests.some((row:{url:string;method:string;action?:string})=>row.url===String(url)&&row.method===method&&(!row.action||row.action===headers.get('x-acs-action'))))return net.fetch(url,frozen);
    const registration=await net.fetch(config.registerUrl,{method:'POST',headers:{authorization:'Bearer s10-normal-controller','content-type':'application/json'},body:JSON.stringify({url:String(url),method,headers:Object.fromEntries(headers),body:Buffer.from((frozen.body??'') as Uint8Array).toString('base64')}),redirect:'error'});
    if(registration.status!==200)throw Error('S10_CONTROLLER_REGISTRATION_FAILED: '+await registration.text());const permit=await registration.json();return activeGuard.withRoutePermit(permit,()=>net.fetch(url,frozen));
  }),s=createNormalServices(root,safeStorage,fetcher,()=>new Date(config.clock));
  const report={normalOnly:true,businessStarted:false,identity:{pid:process.pid,executable:process.execPath,dataRoot:root,userData:app.getPath('userData'),electron:process.versions.electron},blocked:guard.blocked};
  let configured=false,productId:string|undefined,targetId:string|undefined,taskId:string|undefined;
  async function configure(){if(configured)return;const {keys}=config;
    s.ai.saveConnection({id:'openrouter',apiKey:keys.openrouter});s.ai.setEnabled({id:'openrouter',enabled:true});s.ai.setEnabled({id:'openrouter-review',enabled:true});
    s.ai.saveConnection({id:'deepseek',apiKey:keys.deepseek});s.ai.setEnabled({id:'deepseek',enabled:true});s.ai.setEnabled({id:'deepseek-review',enabled:true});
    s.ai.saveConnection({id:'aliyun',accessKeyId:keys.accessKeyId,accessKeySecret:keys.accessKeySecret});for(const id of ['aliyun-ocr','aliyun-image-risk'])s.ai.setEnabled({id,enabled:true});
    s.generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',apiKey:keys.openrouter,enabled:true,size:'1024x1024',quality:'auto'});
    s.images.saveRiskSettings({enabled:true});s.images.saveCopyReviewSettings({enabled:true});s.images.saveAppearanceReviewSettings({enabled:true});
    targetId=(await s.amazon.importCredentials(config.amazon)).id;s.source.importConfig({appKey:keys.appKey,appSecret:keys.appSecret});
    s.hosting.importProfile({id:'alpha',host:config.ftp.host,port:config.ftp.port,secure:false,username:config.ftp.user,password:config.ftp.password,remoteRoot:'/s10',publicBaseUrl:'https://htc.185858.xyz/AAA/'});s.hosting.setEnabled({id:'alpha',enabled:true});
    const rules=s.rules.get();rules.product.dimensionFallback=false;rules.product.weightFallback=false;rules.product.variantLimit=1;rules.product.stockSets=5;rules.pricing.bundleEnabled=false;rules.product.targetShops[targetId]='U2';s.rules.save(rules);
    const db=openDatabase(root);try{new AiSpendBudget(db).setImagePolicy(1_000_000);}finally{db.close();}configured=true;
  }
  async function stage(name:string){assert.ok(['source','queue','start','snapshot'].includes(name),'S10_UNKNOWN_NORMAL_STAGE');await configure();
    if(name==='source'&&!productId){const list=await s.source.listProducts({pageNo:1,pageSize:20});assert.equal(list.items.length,1);const preview=await s.source.previewProduct({id:config.remoteId});assert.equal(preview.product.skus.length,1);
      const imported=s.source.importProduct({previewId:preview.previewId,mapping:{priceField:'price',currency:'CNY',skus:preview.product.skus.map(sku=>({sourceKey:sku.key,dimensions:{color:'blue'}}))}});productId=imported.productId;
      const originalReceipt=s.source.getReceipt(productId),product=s.store.getProductSnapshot(productId);s.store.saveProduct({id:product.id,revision:product.revision,title:product.title,sourceUrl:product.sourceUrl,description:product.description,status:product.status,variants:product.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})),facts:product.facts.map(fact=>({...fact,state:'human_confirmed',scope:'variant',variantId:product.variants[0].id}))});assert.deepEqual(s.source.getReceipt(productId)?.snapshot,originalReceipt?.snapshot,'S10_SOURCE_RECEIPT_MUST_REMAIN_ORIGINAL');
    }
    let normal;
    if(name==='start'){assert.ok(productId&&targetId);assert.equal(taskId,undefined,'S10_NORMAL_ALREADY_STARTED');const task=await s.automatic.create({productIds:[productId],targetId,profileId:'alpha'});taskId=task.id;await s.automatic.confirmStart(taskId,async()=>true);await s.automatic.waitForIdle();const current=s.automatic.get(taskId),drafts=s.amazon.listDrafts(productId);normal={task:current,drafts,workflow:drafts[0]?s.images.getProgress(drafts[0].id):null,observation:drafts[0]?s.amazon.getListingObservation(drafts[0].id):null,procurement:s.procurement.candidates(),blocked:[...activeGuard.blocked]};}
    const product=productId?s.store.getProductSnapshot(productId):null;let queue;
    if(name==='queue'){assert.ok(productId&&targetId,'S10_SOURCE_REQUIRED');queue=await s.automatic.queue({productIds:[productId],targetId});}
    return {stage:name,normalExecutable:!!normal?.task.items.every(row=>row.status==='DONE'),finalIntegrationPassed:false,...normal,productId,productCount:s.store.listProducts().length,sourceReceiptMode:productId?s.source.getReceipt(productId)?.mode:null,sourceReceiptFingerprint:productId?s.source.getReceipt(productId)?.fingerprint:null,productOrigin:product?.origin,variantSkus:product?.variants.map(v=>v.sku),factCount:product?.facts.length??0,confirmedFacts:product?.facts.filter(f=>f.state==='human_confirmed').map(({name,value})=>({name,value})),aiCalls:s.ai.listCalls().length,taskCount:s.automatic.list().length,draftCount:productId?s.amazon.listDrafts(productId).length:0,nativeProtocolSent:activeGuard.nativeProtocolSent,nodeProtocolSent:activeGuard.nodeProtocolSent,...(queue?{queue}:{})};
  }
  let closing:Promise<{drained:true}>|undefined;const drain=()=>closing??=(async()=>{await s.close();appendFileSync(join(root,'s10-lifecycle.jsonl'),JSON.stringify({event:'drained'})+'\n');return {drained:true};})();
  Object.assign(globalThis,{__s10Dryrun:report,__s10NormalStage:stage,__s10Drain:drain});
  app.on('quit',(_event,exitCode)=>appendFileSync(join(root,'s10-lifecycle.jsonl'),JSON.stringify({event:'exit',exitCode,pid:process.pid})+'\n'));
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('data:text/html,<p>S10 construction only; real normal services.</p>');
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
