// Test-only construction/dry-run. Never imports production main or starts a task.
import assert from 'node:assert/strict';
import { app, BrowserWindow, net, safeStorage } from 'electron';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore } from '../../../src/main/store.ts';
import { AmazonService } from '../../../src/main/amazon/service.ts';
import { HostingService } from '../../../src/main/hosting/service.ts';
import { createPublicImageProbe } from '../../../src/main/hosting/public-probe.ts';
import { AiService } from '../../../src/main/ai/service.ts';
import { createSystemProxyFetch } from '../../../src/main/ai-network.ts';
import { ImageGenerationService } from '../../../src/main/image-generation/service.ts';
import { normalizeGeneratedImage } from '../../../src/main/image-generation/normalize.ts';
import { decodePreview } from '../../../src/main/ipc.ts';
import { MiaoshouService } from '../../../src/main/miaoshou/service.ts';
import { MiaoshouImageService, createSourceImageDownloader } from '../../../src/main/miaoshou/images.ts';
import { ImageWorkflowService } from '../../../src/main/image-workflow/service.ts';
import { ListingAiService } from '../../../src/main/listing-ai/service.ts';
import { ExecutionService } from '../../../src/main/execution/service.ts';
import { FollowupService } from '../../../src/main/followup/service.ts';
import { CatalogService } from '../../../src/main/catalog/service.ts';
import { ProcurementService } from '../../../src/main/procurement/service.ts';
import { ItemLabelService } from '../../../src/main/item-labels/service.ts';
import { ItemLabelSettings } from '../../../src/main/item-labels/settings.ts';
import { SkuNamingService } from '../../../src/main/sku-naming/service.ts';
import { ListingRuleStore } from '../../../src/main/listing-rules.ts';
import { AutomaticListingService } from '../../../src/main/automatic-listing/service.ts';
import { planSalesListings } from '../../../src/main/sales-plans/planning.ts';
import { resolveSalesFamily, ensureFamilyParent } from '../../../src/main/automatic-listing/families.ts';
import { classifyProduct } from '../../../src/main/catalog/classification.ts';
import { assertConsistencyView } from '../../../src/main/source-image-consistency/proof.ts';

const guard=(globalThis as typeof globalThis & {__s10Guard?:{installedBeforeMain:boolean;blocked:string[];dataRoot:string}}).__s10Guard;
assert.ok(guard?.installedBeforeMain,'S10 guard must precede application imports');
assert.ok(process.env.S10_POLICY_FILE&&process.env.RED_DATA_DIR,'S10 explicit policy/data root required');
const policy=JSON.parse(readFileSync(process.env.S10_POLICY_FILE,'utf8')),root=process.env.RED_DATA_DIR;
assert.equal(root,policy.dataRoot);app.setPath('userData',root);app.setName('S10 isolated construction');app.enableSandbox();
void app.whenReady().then(async()=>{
  const fetcher=createSystemProxyFetch((url,init)=>net.fetch(url,init));
  const store=new WorkspaceStore(root),amazon=new AmazonService(root,id=>store.getProductSnapshot(id),safeStorage,{fetch:fetcher,schemaFetch:fetcher,dataFetch:fetcher});
  const hosting=new HostingService(root,store,safeStorage,{probe:createPublicImageProbe({nativeFetch:fetcher})});
  const generation=new ImageGenerationService(root,store,safeStorage,{fetch:fetcher,decodePreview,normalizeImage:normalizeGeneratedImage,downloadDependencies:{nativeFetch:fetcher}});
  const ai=new AiService(root,store,hosting,safeStorage,{fetch:fetcher,imageGenerationCapability:()=>generation.capability()});
  generation.attachOpenRouterConnection({read:()=>ai.openRouterApiKey(),save:key=>ai.saveConnection({id:'openrouter',apiKey:key}),disconnect:()=>ai.disconnectConnection('openrouter')});
  const source=new MiaoshouService(root,store,safeStorage,{fetch:fetcher});
  const sourceImages=new MiaoshouImageService(root,store,id=>source.getReceipt(id),decodePreview,{download:createSourceImageDownloader({nativeFetch:fetcher})});
  const images=new ImageWorkflowService(root,store,amazon,ai,generation,{sources:{getReceipt:id=>source.getReceipt(id),images:sourceImages}});
  const listing=new ListingAiService(store,amazon,ai,()=>images.getCopyReviewSettings().enabled);
  const followup=new FollowupService(root,amazon),catalog=new CatalogService(root,amazon),procurement=new ProcurementService(root,store,amazon);
  const execution=new ExecutionService(root,store,amazon,hosting,{scheduleFollowup:id=>followup.schedule(id)}),labels=new ItemLabelService(root,amazon,procurement);
  const labelSettings=new ItemLabelSettings(root),naming=new SkuNamingService(root),rules=new ListingRuleStore(root);
  const automatic=new AutomaticListingService(root,{store,amazon,hosting,images,execution,followup,procurement,labels,batch:ai.batchTasks,batchPlan:()=>ai.taskBatchPlan(),rules:()=>rules.get(),labelFormat:()=>labelSettings.get(),
    sourceReceipt:id=>source.getReceipt(id),planSales:(id,targetId)=>planSalesListings(store.getProduct(id),source.getReceipt(id),amazon.getTarget(targetId),rules.get(),naming),
    existingSale:(id,plan,targetId)=>amazon.findSalesDraft(id,plan,targetId),resolveFamily:(input,signal)=>resolveSalesFamily(amazon,input,signal),rebindFamily:(input,signal)=>amazon.rebindUnsubmittedFamily(input,signal),
    ensureParent:(child,profileId,signal)=>ensureFamilyParent({amazon,listing,execution,followup},child,profileId,signal),
    classify:async(input,signal)=>{if(!catalog.get(input.targetId))await catalog.sync(input.targetId);const scope=JSON.stringify(amazon.executionTargetScope(input.targetId));const fresh=()=>{assert.ok(!signal.aborted);assert.equal(JSON.stringify(amazon.executionTargetScope(input.targetId)),scope);};
      return classifyProduct(input,{keywords:value=>ai.decideCategory({...value,phase:'keywords',candidates:[]},fresh,signal),search:(targetId,query)=>catalog.search({targetId,query}),fallback:(targetId,keywords)=>amazon.searchProductTypes({targetId,keywords}),choose:(value,phase)=>ai.decideCategory({...value,phase},fresh,signal)});},
    prepareSourceConsistency:async(input,signal,fresh)=>{for(const variantId of input.variantIds){fresh();assertConsistencyView(await ai.prepareSourceConsistency({productId:input.productId,productRevision:input.productRevision,variantId},signal,fresh));}},
    prepareSourceColors:async(id,signal)=>{const draft=amazon.getDraft(id);return listing.prepareSourceColors({draftId:id,draftRevision:draft.revision},signal);},
    beginFieldRepair:id=>{const draft=amazon.getDraft(id);return listing.beginCompletion({draftId:id,draftRevision:draft.revision}).id;},
    repairFields:async(id,signal,operationId)=>{const draft=amazon.getDraft(id);return listing.complete({draftId:id,draftRevision:draft.revision},signal,operationId);},
    preflight:()=>{throw Error('S10_FOUNDATION_ONLY: task execution waits for merged owners');},
  });
  const services=[store,amazon,hosting,generation,ai,source,sourceImages,images,listing,followup,catalog,procurement,execution,labels,labelSettings,naming,rules,automatic].map(value=>value.constructor.name);
  const nativeFetchProbe=await (await net.fetch(policy.origin+'/foundation')).json();
  const report={identity:{pid:process.pid,executable:process.execPath,dataRoot:root,userData:app.getPath('userData'),node:process.versions.node,electron:process.versions.electron},foundationOnly:true,businessStarted:false,services,
    taskCount:automatic.list().length,aiCallCount:ai.listCalls().length,productCount:store.listProducts().length,nativeFetchProbe,blocked:guard.blocked};
  Object.assign(globalThis,{__s10Dryrun:report});
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('data:text/html,<meta charset="utf-8"><p>S10 construction only; no task authorization.</p>');
  let closed=false,closing:Promise<{drained:true}>|undefined;
  const drain=()=>closing??=(async()=>{
    for(const [name,service] of [['automatic',automatic],['labels',labels],['labelSettings',labelSettings],['followup',followup],['catalog',catalog],['procurement',procurement],['images',images],['generation',generation],['sourceImages',sourceImages],['source',source],['ai',ai],['execution',execution],['hosting',hosting],['naming',naming],['rules',rules],['amazon',amazon],['store',store]] as const){
      appendFileSync(join(root,'s10-lifecycle.jsonl'),JSON.stringify({event:'closing',name})+'\n');await service.close();
    }
    appendFileSync(join(root,'s10-lifecycle.jsonl'),JSON.stringify({event:'drained'})+'\n');closed=true;return {drained:true as const};
  })();
  Object.assign(globalThis,{__s10Drain:drain});
  app.on('quit',(_event,exitCode)=>appendFileSync(join(root,'s10-lifecycle.jsonl'),JSON.stringify({event:'exit',exitCode,pid:process.pid})+'\n'));
  app.on('will-quit',event=>{if(closed)return;event.preventDefault();void drain().then(()=>setImmediate(()=>app.quit())).catch(()=>app.exit(1));});
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
