// Real service normal worker; controller owns every external HTTP/FTP response.
import assert from 'node:assert/strict';
import {app,BrowserWindow,net,safeStorage} from 'electron';
import {readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createNormalServices} from './pipeline-normal-services.ts';
import {createSystemProxyFetch} from '../../../src/main/ai-network.ts';
import {AiSpendBudget} from '../../../src/main/ai/spend-budget.ts';
import {openDatabase} from '../../../src/main/database.ts';
const guard=(globalThis as typeof globalThis&{__s10Guard?:{installedBeforeMain:boolean;blocked:string[];nativeProtocolSent:number;nodeProtocolSent:number}}).__s10Guard;
assert.ok(guard?.installedBeforeMain);assert.ok(process.env.RED_DATA_DIR&&process.env.S10_POLICY_FILE);
const activeGuard=guard;
const policy=JSON.parse(readFileSync(process.env.S10_POLICY_FILE,'utf8')),root=process.env.RED_DATA_DIR,config=JSON.parse(readFileSync(join(root,'normal-config.json'),'utf8'));assert.equal(root,policy.dataRoot);
app.setPath('userData',root);app.setName('S10 real normal synthetic worker');app.enableSandbox();
void app.whenReady().then(async()=>{
  const fetcher=createSystemProxyFetch((url,init)=>net.fetch(url,init)),s=createNormalServices(root,safeStorage,fetcher,()=>new Date(config.clock));
  const report={normalOnly:true,businessStarted:false,identity:{pid:process.pid,executable:process.execPath,dataRoot:root,userData:app.getPath('userData'),electron:process.versions.electron},blocked:guard.blocked};
  let configured=false,productId:string|undefined;
  async function configure(){if(configured)return;const {keys}=config;
    s.ai.saveConnection({id:'openrouter',apiKey:keys.openrouter});s.ai.setEnabled({id:'openrouter',enabled:true});s.ai.setEnabled({id:'openrouter-review',enabled:true});
    s.ai.saveConnection({id:'deepseek',apiKey:keys.deepseek});s.ai.setEnabled({id:'deepseek',enabled:true});s.ai.setEnabled({id:'deepseek-review',enabled:true});
    for(const id of ['aliyun-ocr','aliyun-image-risk']){s.ai.saveConnection({id,accessKeyId:keys.accessKeyId,accessKeySecret:keys.accessKeySecret});s.ai.setEnabled({id,enabled:true});}
    s.generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',apiKey:keys.openrouter,enabled:true,size:'1024x1024',quality:'auto'});
    s.images.saveRiskSettings({enabled:true});s.images.saveCopyReviewSettings({enabled:true});s.images.saveAppearanceReviewSettings({enabled:true});
    await s.amazon.importCredentials(config.amazon);s.source.importConfig({appKey:keys.appKey,appSecret:keys.appSecret});
    s.hosting.importProfile({id:'alpha',host:config.ftp.host,port:config.ftp.port,secure:false,username:config.ftp.user,password:config.ftp.password,remoteRoot:'/s10',publicBaseUrl:'https://htc.185858.xyz/AAA/'});s.hosting.setEnabled({id:'alpha',enabled:true});
    const rules=s.rules.get();rules.product.dimensionFallback=false;rules.product.weightFallback=false;rules.product.variantLimit=1;rules.product.stockSets=5;rules.pricing.bundleEnabled=false;s.rules.save(rules);
    const db=openDatabase(root);try{new AiSpendBudget(db).setImagePolicy(1_000_000);}finally{db.close();}configured=true;
  }
  async function stage(name:string){assert.ok(['source','queue','start','snapshot'].includes(name),'S10_UNKNOWN_NORMAL_STAGE');await configure();
    if(name==='source'&&!productId){const list=await s.source.listProducts({pageNo:1,pageSize:20});assert.equal(list.items.length,1);const preview=await s.source.previewProduct({id:config.remoteId});assert.equal(preview.product.skus.length,1);
      const imported=s.source.importProduct({previewId:preview.previewId,mapping:{priceField:'price',currency:'CNY',skus:preview.product.skus.map(sku=>({sourceKey:sku.key,dimensions:{color:'blue'}}))}});productId=imported.productId;
      const product=s.store.getProductSnapshot(productId);s.store.saveProduct({id:product.id,revision:product.revision,title:product.title,sourceUrl:product.sourceUrl,description:product.description,status:product.status,variants:product.variants.map(({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})=>({id,sku,originalSpec,normalizedSpec,purchasePrice,inventory})),facts:product.facts.map(fact=>({...fact,state:'human_confirmed'}))});
    }
    const product=productId?s.store.getProductSnapshot(productId):null;
    return {stage:name,normalExecutable:false,finalIntegrationPassed:false,productId,productCount:s.store.listProducts().length,sourceReceiptMode:productId?s.source.getReceipt(productId)?.mode:null,factCount:product?.facts.length??0,aiCalls:s.ai.listCalls().length,nativeProtocolSent:activeGuard.nativeProtocolSent,nodeProtocolSent:activeGuard.nodeProtocolSent};
  }
  let closing:Promise<{drained:true}>|undefined;const drain=()=>closing??=(async()=>{await s.close();appendFileSync(join(root,'s10-lifecycle.jsonl'),JSON.stringify({event:'drained'})+'\n');return {drained:true};})();
  Object.assign(globalThis,{__s10Dryrun:report,__s10NormalStage:stage,__s10Drain:drain});
  app.on('quit',(_event,exitCode)=>appendFileSync(join(root,'s10-lifecycle.jsonl'),JSON.stringify({event:'exit',exitCode,pid:process.pid})+'\n'));
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('data:text/html,<p>S10 construction only; real normal services.</p>');
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
