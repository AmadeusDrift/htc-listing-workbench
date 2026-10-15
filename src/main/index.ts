import {ControlledAcceptanceSession,CONTROLLED_ACCEPTANCE_FLAG} from './application/controlled-acceptance.ts';
import {verifyControlledCandidate} from './application/controlled-candidate.ts';
import {preflightControlledAcceptance} from './application/controlled-startup.ts';
import {ControlledRunError,type ControlledEffect} from './application/controlled-run-scope.ts';
import {createSystemProxyFetch, createAiNetworkDiagnostics} from './ai-network.ts';
import {createBatchReferencePort} from './hosting/batch-references.ts';
import { assertConsistencyView } from './source-image-consistency/proof.ts';
import { UserFacingError } from '../shared/errors.ts';
import { app, BrowserWindow, dialog, nativeTheme, net, protocol, safeStorage, session } from 'electron';
import { mkdirSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { WorkspaceStore } from './store.ts';
import { snapshotWorkspaceDatabase } from './database-snapshots.ts';
import { installIpc, decodePreview } from './ipc.ts';
import { MiaoshouService } from './miaoshou/service.ts';
import { MiaoshouImageService, createSourceImageDownloader } from './miaoshou/images.ts';
import { miaoshouDemoImage } from './miaoshou/demo-image.ts';
import { assetIdFromUrl, managedAssetPath, publicError } from './security.ts';
import { AmazonService } from './amazon/service.ts';
import { FollowupService } from './followup/service.ts';
import { CatalogService } from './catalog/service.ts';
import { ProcurementService } from './procurement/service.ts';
import { ProductDataService } from './product-data/service.ts';
import { commitWorkspaceRestore, recoverInterruptedRestore } from './backup.ts';
import { cleanupManagedBackups } from './backup-retention.ts';
import { HostingService } from './hosting/service.ts';
import { createPublicImageProbe } from './hosting/public-probe.ts';
import { ExecutionService } from './execution/service.ts';
import { AiService } from './ai/service.ts';
import { ImageVersionService } from './image-versions/service.ts';
import { decodeArtifact } from './image-versions/decoder.ts';
import { ReviewedContentService } from './content/service.ts';
import { CollectionHistory } from './collection/history.ts';
import { AppearanceStore, appearanceTitleBarOverlay } from './appearance.ts';
import { ImageGenerationService } from './image-generation/service.ts';
import { normalizeGeneratedImage } from './image-generation/normalize.ts';
import { ImageWorkflowService } from './image-workflow/service.ts';
import { AutomaticListingService } from './automatic-listing/service.ts';
import { ItemLabelService } from './item-labels/service.ts';
import { ItemLabelSettings } from './item-labels/settings.ts';
import { classifyProduct } from './catalog/classification.ts';
import {categoryExpansionPort} from './catalog/category-expansion.ts';
import { SkuNamingService } from './sku-naming/service.ts';
import { planSalesListings } from './sales-plans/planning.ts';
import { ensureFamilyParent, resolveSalesFamily } from './automatic-listing/families.ts';
import { ShipmentDocumentService } from './procurement/shipment-documents.ts';
import { ListingRuleStore, readListingRules } from './listing-rules.ts';
import { ListingAiService } from './listing-ai/service.ts';
import { imageWorkflowDraftStamp } from "./image-workflow/approval-reuse.ts";

app.setName('HTC Workbench');
app.enableSandbox();
// Branding must not change the existing workspace or its single-instance lock.
const dataRoot = process.env.RED_DATA_DIR ? resolve(process.env.RED_DATA_DIR) : join(app.getPath('appData'), 'RED Workbench');
mkdirSync(dataRoot, { recursive: true });
app.setPath('userData', dataRoot);
app.setPath('sessionData', join(dataRoot, 'browser'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'red', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'red-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const productionCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' red-asset: data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const controlledAcceptanceMode=process.argv.includes(CONTROLLED_ACCEPTANCE_FLAG);
let controlledAcceptance:ControlledAcceptanceSession|undefined;
const guardExternal=(effect:ControlledEffect,transactionDb?:import('node:sqlite').DatabaseSync)=>{if(controlledAcceptanceMode){if(!controlledAcceptance)throw new ControlledRunError();controlledAcceptance.assertExternal(effect,transactionDb);}};
let store: WorkspaceStore | undefined;
let amazon: AmazonService | undefined;
let followup: FollowupService | undefined;
let catalog: CatalogService | undefined;
let procurement: ProcurementService | undefined;
let productData: ProductDataService | undefined;
let hosting: HostingService | undefined;
let execution: ExecutionService | undefined;
let ai: AiService | undefined;
let images: ImageVersionService | undefined;
let imageGeneration: ImageGenerationService | undefined;
let batchReferences:ReturnType<typeof createBatchReferencePort>|undefined;
let imageWorkflow: ImageWorkflowService | undefined;
let automatic: AutomaticListingService | undefined;
let labels: ItemLabelService | undefined;
let labelSettings: ItemLabelSettings | undefined;
let skuNaming: SkuNamingService | undefined;
let automaticRules: ListingRuleStore | undefined;
let shipmentDocuments: ShipmentDocumentService | undefined;
let content: ReviewedContentService | undefined;
let collection: CollectionHistory | undefined;
let miaoshou: MiaoshouService | undefined;
let miaoshouImages: MiaoshouImageService | undefined;
let window: BrowserWindow | undefined;

async function start() {
  if(controlledAcceptanceMode)preflightControlledAcceptance(dataRoot);
  const verifiedCandidate=controlledAcceptanceMode?await verifyControlledCandidate(app.getAppPath(),process.execPath):null;
  const recovered = await recoverInterruptedRestore(dataRoot);
  await snapshotWorkspaceDatabase(dataRoot);
  store = new WorkspaceStore(dataRoot);
  const db = store;
  if(verifiedCandidate)controlledAcceptance=new ControlledAcceptanceSession(dataRoot,verifiedCandidate,id=>db.getProductSnapshot(id));
  if (recovered) db.recordWorkspaceEvent('workspace.restore.recovered', recovered === 'rolled-back' ? '启动时已回滚中断的备份恢复，保留原始工作区' : '启动时已完成中断的备份恢复清理');
  amazon = new AmazonService(dataRoot, id => db.getProductSnapshot(id), safeStorage, {
    ...(controlledAcceptanceMode?{preserveHistoricalRecords:true,beforeEffect:(effect:import('./amazon/service.ts').AmazonEffectIdentity,transactionDb?:import('node:sqlite').DatabaseSync)=>{const {kind,operation:_operation,phase:_phase,draftId:_draftId,...scope}=effect;guardExternal({...scope,kind:kind==='target'?'platform-write':kind},transactionDb);}}:{}),
    schemaFetch: (url, init) => {guardExternal({kind:'schema'});return net.fetch(url, { ...init, bypassCustomProtocolHandlers: true });},
    dataFetch: (url, init) => {guardExternal({kind:String(url).includes('/auth/o2/token')?'lwa':init?.method&&['PUT','POST','PATCH','DELETE'].includes(init.method.toUpperCase())?'platform-write':'platform-read'});return net.fetch(url, { ...init, bypassCustomProtocolHandlers: true });},
  });
  hosting = new HostingService(dataRoot, db, safeStorage, { ...(controlledAcceptanceMode?{prepareUpload:async (identity:import('./hosting/service.ts').HostingEffectIdentity)=>{guardExternal({kind:'hosting',...(identity.productId?{productId:identity.productId,variantIds:identity.variantIds}:{})});return controlledAcceptance!.assertBillingPlanAvailable();},beforeEffect:(identity:import('./hosting/service.ts').HostingEffectIdentity,_kind:unknown,transactionDb?:import('node:sqlite').DatabaseSync)=>{guardExternal({kind:'hosting',...(identity.productId?{productId:identity.productId,variantIds:identity.variantIds}:{})},transactionDb);controlledAcceptance!.assertBillingPlanAvailable();}}:{}), probe: createPublicImageProbe({ nativeFetch: (url, init) => {guardExternal({kind:'hosting'});return net.fetch(url, { ...init, bypassCustomProtocolHandlers: true });} }) });
  const aiFetch = createSystemProxyFetch((url, init) => {guardExternal({kind:'ai'});if(controlledAcceptanceMode)controlledAcceptance!.assertBillingPlanAvailable();return net.fetch(url, init);});
  const networkDiagnostics = createAiNetworkDiagnostics({fetch:aiFetch,resolveProxy:url=>session.defaultSession.resolveProxy(url)});
  imageGeneration = new ImageGenerationService(dataRoot, db, safeStorage, {
    normalizeImage: normalizeGeneratedImage,
    fetch: aiFetch, decodePreview,
    downloadDependencies: { nativeFetch: (url, init) => {guardExternal({kind:'hosting'});return net.fetch(url, { ...init, bypassCustomProtocolHandlers: true });} },
  });
  const generationService = imageGeneration;
  batchReferences=createBatchReferencePort({directory:dataRoot,store:db,generation:generationService,hosting,task:id=>{if(!automatic)throw new Error('Task service unavailable');return automatic.get(id);},probe:createPublicImageProbe({nativeFetch:(url,init)=>{guardExternal({kind:'hosting'});return net.fetch(url,{...init,bypassCustomProtocolHandlers:true});}})});
  ai = new AiService(dataRoot, db, hosting, safeStorage, { fetch:aiFetch, imageGenerationCapability: () => generationService.capability(),batchReferences });
  const routingAi=ai;
  generationService.attachOpenRouterConnection({read:()=>routingAi.openRouterApiKey(),save:apiKey=>routingAi.saveConnection({id:'openrouter',apiKey}),disconnect:()=>routingAi.disconnectConnection('openrouter')});
  images = new ImageVersionService(dataRoot, db, ai, { decode: decodeArtifact });
  content = new ReviewedContentService(dataRoot, db, ai);
  followup = new FollowupService(dataRoot, amazon,{canManageDraft:id=>!controlledAcceptanceMode||controlledAcceptance?.canManageDraft(id)===true});
  catalog = new CatalogService(dataRoot, amazon);
  procurement = new ProcurementService(dataRoot, db, amazon);
  productData = new ProductDataService(dataRoot, db, amazon);
  const listingFollowup = followup;
  execution = new ExecutionService(dataRoot, db, amazon, hosting, { scheduleFollowup: id => listingFollowup.schedule(id) });
  // Recover accepted submissions whose process ended between the write checkpoint and queue registration.
  for (const product of db.listProducts()) for (const draft of amazon.listDrafts(product.id)) {
    if ((!controlledAcceptanceMode||controlledAcceptance?.canManageDraft(draft.id)) && draft.mode === 'live' && (draft.submittedAt || ['UNKNOWN','SUBMITTING'].includes(draft.state))) {
      try { listingFollowup.schedule(draft.id); } catch { db.recordWorkspaceEvent('listing.followup.schedule_failed', '有一条已提交记录尚未登记跟进，请核对上架结果'); }
    }
  }
  collection = new CollectionHistory(db);
  miaoshou = new MiaoshouService(dataRoot, db, safeStorage);
  const miaoshouService = miaoshou;
  miaoshouImages = new MiaoshouImageService(dataRoot, db, id => miaoshouService.getReceipt(id), decodePreview, {
    demoImage: miaoshouDemoImage, getSourceUpdate: id => miaoshouService.getSourceUpdate(id),
    download: createSourceImageDownloader({ nativeFetch: (url, init) => {guardExternal({kind:'source'});return net.fetch(url, { ...init, bypassCustomProtocolHandlers: true });} }),
  });
  imageWorkflow = new ImageWorkflowService(dataRoot, db, amazon, ai, imageGeneration, { sources: { getReceipt: id => miaoshouService.getReceipt(id), images: miaoshouImages } });
  labels = new ItemLabelService(dataRoot, amazon, procurement,{canManageDraft:id=>!controlledAcceptanceMode||controlledAcceptance?.canManageDraft(id)===true});
  labelSettings = new ItemLabelSettings(dataRoot);
  skuNaming = new SkuNamingService(dataRoot);
  automaticRules = new ListingRuleStore(dataRoot);
  shipmentDocuments = new ShipmentDocumentService(dataRoot, procurement);
  const workflowService = imageWorkflow, listingService = new ListingAiService(db, amazon, ai,()=>workflowService.getCopyReviewSettings().enabled), amazonService = amazon, aiService = ai, formatSettings = labelSettings, catalogService = catalog, namingService=skuNaming, executionService=execution, ruleStore=automaticRules;
  automatic = new AutomaticListingService(dataRoot, {
    store: db, amazon, hosting, images: imageWorkflow, execution, followup, procurement, labels,
    canManageTask:id=>!controlledAcceptanceMode||controlledAcceptance?.canManageTask(id)===true,
    ...(controlledAcceptanceMode?{admitTask:(task:import('../shared/automatic-listing-contracts.ts').AutomaticListingTask)=>{if(!controlledAcceptance)throw new ControlledRunError();controlledAcceptance.admitTask(task);}}:{}),
    batch:aiService.batchTasks,batchPlan:()=>aiService.taskBatchPlan(),
    rules: () => ruleStore.get(),
    labelFormat: () => formatSettings.get(),
    sourceReceipt: productId => miaoshouService.getReceipt(productId),
    planSalesForAdaptation: (source,targetId,transactionDb) => {const naming=new SkuNamingService(dataRoot,transactionDb);return planSalesListings(source,miaoshouService.getReceipt(source.id),amazonService.getTarget(targetId),readListingRules(transactionDb),naming,{existingPlans:()=>[...amazonService.readSalesPlans(source.id,targetId),...(automatic?.readSalesPlans(source.id,targetId)??[])]});},
    planSales: (productId,targetId) => {return planSalesListings(db.getProductSnapshot(productId),miaoshouService.getReceipt(productId),amazonService.getTarget(targetId),ruleStore.get(),namingService,{existingPlans:()=>[...amazonService.readSalesPlans(productId,targetId),...(automatic?.readSalesPlans(productId,targetId)??[])]});},
    existingSale:(productId,plan,targetId)=>amazonService.findSalesDraft(productId,plan,targetId),
    resolveFamily: (input,signal) => resolveSalesFamily(amazonService,input,signal),
    rebindFamily: (input,signal) => amazonService.rebindUnsubmittedFamily(input,signal),
    ensureParent: (child,profileId,signal) => ensureFamilyParent({amazon:amazonService,listing:listingService,execution:executionService,followup:listingFollowup},child,profileId,signal),
    classify: async (input, signal) => {
      if (!catalogService.get(input.targetId)) await catalogService.sync(input.targetId);
      const scope = JSON.stringify(amazonService.executionTargetScope(input.targetId));
      const fresh = () => { if (signal.aborted || JSON.stringify(amazonService.executionTargetScope(input.targetId)) !== scope) throw new UserFacingError('分类期间目标已变化或任务已暂停'); };
      return classifyProduct(input, {
        keywords: value => aiService.decideCategory({...value,phase:'keywords',candidates:[]},fresh,signal),
        search: (targetId,query) => catalogService.search({targetId,query}),
        localCandidates: targetId => catalogService.get(targetId)?.productTypes??[],
        fallback: (targetId,keywords) => amazonService.searchProductTypes({targetId,keywords}),
        choose: (value,phase) => aiService.decideCategory({...value,phase},fresh,signal),
        expansion: categoryExpansionPort(input,aiService,amazonService,fresh),
      });
    },
    preflight: () => {
      for(const purpose of ['source_understanding','category_analysis','category_decision','listing_completion','image_plan','image_text_review'] as const){
        const profile=aiService.purposeProfile(purpose,['source_understanding','category_analysis','category_decision','image_plan'].includes(purpose),purpose==='image_text_review');
        if(!profile.configured||!profile.enabled)throw new UserFacingError(`用途 ${purpose} 的 ${profile.routing?.gateway} 连接尚未配置或启用，请在逐用途设置中核对`);
      }
      for (const id of ['aliyun-ocr',...(workflowService.getRiskSettings().enabled?['aliyun-image-risk']:[])]) {
        const profile = aiService.getProfile(id); if (!profile.configured || !profile.enabled) throw new UserFacingError('请先在设置中配置并启用内容生成、内容复核、OCR 和侵权检测');
      }
      const generation = generationService.getConnection(); if (!generation.configured || !generation.enabled) throw new UserFacingError('请先在设置中配置并启用生图服务');
    },
    prepareSourceConsistency: async (input,signal,fresh) => {
      for(const variantId of input.variantIds){fresh();const view=await aiService.prepareSourceConsistency({productId:input.productId,productRevision:input.productRevision,variantId},signal,fresh);fresh();assertConsistencyView(view);}
    },
    prepareSourceColors: async (id, signal) => {
      const current=amazonService.getDraft(id);
      return listingService.prepareSourceColors({draftId:id,draftRevision:current.revision},signal);
    },
    beginLegacyThemeRepair: (id,row,workflow) => listingService.beginLegacyThemeRepair(id,row,workflow)?.id,
    beginFieldRepair: id => {const current=amazonService.getDraft(id);return listingService.beginCompletion({draftId:id,draftRevision:current.revision}).id;},
    repairFields: async (id, signal, operationId) => {
      const current = amazonService.getDraft(id);
      return await listingService.complete({ draftId: id, draftRevision: current.revision }, signal, operationId);
    },
    recheckUnitImage:async(input,signal,authorize)=>{const result=await workflowService.recheckUnitAdoption(input,signal,authorize);if(result.workflow.status!=='COMPLETED')throw new UserFacingError(result.workflow.error||'计量复核的部分图片尚未通过；原标记保留');return result.draft;},
    recheckImage: async (input, signal) => {
      if (signal.aborted) throw new UserFacingError('自动任务已暂停');
      const draft = amazonService.getDraft(input.draftId), prior = workflowService.getProgress(input.draftId);
      workflowService.assertSourceConsistency(draft.id);
      if (prior?.status === 'COMPLETED' && workflowService.isRiskPolicyCompatible(prior) && workflowService.isCopyReviewPolicyCompatible(prior) && prior.draftSha256 === imageWorkflowDraftStamp(draft) && prior.recheckedFromRunId === input.sourceWorkflowId) return draft;
      const cancel = () => workflowService.cancel(input.draftId); signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await workflowService.recheck(input);
        if (result.workflow.status !== 'COMPLETED') throw new UserFacingError(result.workflow.error || '修复后的文案与现有图片复核未通过');
        return result.draft;
      } finally { signal.removeEventListener('abort', cancel); }
    },
  });
  await cleanupManagedBackups(dataRoot, amazon.getDataPolicy().retentionDays).catch(() => db.recordWorkspaceEvent('workspace.backup.cleanup_failed', '自动备份清理未完成，请在设置中重试到期清理'));
  const buildRoot = resolve(__dirname, '../dist');
  // Only files present in the renderer build are addressable by the app protocol.
  const routes = new Map<string, string>();
  function addDirectory(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) addDirectory(path);
      else if (entry.isFile()) routes.set('/' + relative(buildRoot, path).replaceAll('\\', '/'), path);
    }
  }
  const development = process.env.RED_DEV_SERVER_URL;
  if (development && development !== 'http://127.0.0.1:5173/') throw new UserFacingError('开发页面地址无效');
  if (!development) addDirectory(buildRoot);
  protocol.handle('red', async request => {
    const url = new URL(request.url), path = routes.get(url.pathname);
    if (request.method !== 'GET' || url.host !== 'app' || url.username || url.password || !path) return new Response('Not found', { status: 404 });
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    try { return new Response(new Uint8Array(await readFile(path)), { headers: { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Content-Security-Policy': productionCsp, 'X-Content-Type-Options': 'nosniff' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  protocol.handle('red-asset', async request => {
    try {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      const asset = db.getAssetRecord(assetIdFromUrl(request.url));
      if (!asset) return new Response(null, { status: 404 });
      const bytes = await readFile(managedAssetPath(dataRoot, asset.previewPath));
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' } });
    } catch { return new Response(null, { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const expectedUrl = development || 'red://app/index.html';
  const appearanceStore = new AppearanceStore(dataRoot);
  let appearance = await appearanceStore.getAppearance();
  nativeTheme.themeSource = appearance.theme;
  const nativeOverlay = process.platform === 'win32' || process.platform === 'linux';
  const initialOverlay = appearanceTitleBarOverlay(appearance.theme, nativeTheme.shouldUseDarkColors);
  window = new BrowserWindow({ width: 1480, height: 960, minWidth: 640, minHeight: 560, title: `HTC v${app.getVersion()} · 独立上架工作台`,
    backgroundColor: initialOverlay.color, show: false, autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: nativeOverlay ? initialOverlay : false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } });
  const mainWindow = window;
  const updateWindowAppearance = () => {
    if (mainWindow.isDestroyed()) return;
    const overlay = appearanceTitleBarOverlay(appearance.theme, nativeTheme.shouldUseDarkColors);
    mainWindow.setBackgroundColor(overlay.color);
    if (nativeOverlay) mainWindow.setTitleBarOverlay(overlay);
  };
  nativeTheme.on('updated', updateWindowAppearance);
  mainWindow.once('closed', () => nativeTheme.removeListener('updated', updateWindowAppearance));
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== expectedUrl) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('will-prevent-unload', () => {
    // The renderer owns every explicit-save form; keep close prevented until its guard resolves.
    mainWindow.webContents.send('red:unsaved-close-requested');
  });
  installIpc(mainWindow, db, dataRoot, expectedUrl, amazon, hosting, execution, ai, images, content, async prepared => {
    await automatic?.close(); automatic = undefined;
    skuNaming?.close(); skuNaming = undefined; automaticRules?.close(); automaticRules = undefined;
    await labels?.close(); labels = undefined; labelSettings?.close(); labelSettings = undefined; shipmentDocuments?.close(); shipmentDocuments = undefined;
    await imageWorkflow?.close(); imageWorkflow = undefined;
    productData?.close(); productData = undefined;
    await followup?.close(); followup = undefined; await catalog?.close(); catalog = undefined; procurement?.close(); procurement = undefined;
    await miaoshouImages?.close(); miaoshouImages = undefined;
    await miaoshou?.close(); miaoshou = undefined;
    await collection?.close(); collection = undefined;
    await images?.close(); images = undefined; content?.close(); content = undefined;
    await ai?.close(); ai = undefined; await batchReferences?.close(); batchReferences=undefined; await imageGeneration?.close(); imageGeneration = undefined;
    await execution?.close(); execution = undefined; await hosting?.close(); hosting = undefined;
    controlledAcceptance?.close();controlledAcceptance=undefined;
    amazon?.close(); amazon = undefined; store?.close(); store = undefined;
    try {
      await commitWorkspaceRestore(dataRoot, prepared);
      const auditStore = new WorkspaceStore(dataRoot);
      try { auditStore.recordWorkspaceEvent('workspace.restore.completed', '工作区备份恢复完成', { backupCreatedAt: prepared.createdAt, productCount: prepared.productCount, assetCount: prepared.assetCount }); }
      finally { auditStore.close(); }
    }
    catch (error) {
      try {
        await recoverInterruptedRestore(dataRoot);
        const auditStore = new WorkspaceStore(dataRoot);
        try { auditStore.recordWorkspaceEvent('workspace.restore.failed', '工作区备份恢复未完成，已执行恢复检查'); }
        finally { auditStore.close(); }
      } catch { /* Keep the journal intact for startup recovery; never create a fresh library over it. */ }
      await dialog.showMessageBox(mainWindow, { type: 'error', title: '恢复未完成', message: publicError(error), detail: '工作台即将重新启动并检查恢复日志。', buttons: ['重新启动'], noLink: true });
      throw error;
    } finally {
      setTimeout(() => { if (process.env.RED_E2E !== '1') app.relaunch(); app.exit(0); }, 300);
    }
  }, collection, miaoshou, miaoshouImages, { followup, catalog, procurement, productData, labels, labelSettings }, {
    getAppearance: () => appearanceStore.getAppearance(),
    saveAppearance: async input => {
      const saved = await appearanceStore.saveAppearance(input);
      appearance = saved;
      nativeTheme.themeSource = saved.theme;
      updateWindowAppearance();
      return saved;
    },
  }, imageGeneration, imageWorkflow, automatic, { labels, labelSettings, shipmentDocuments, procurement }, skuNaming, networkDiagnostics);
  mainWindow.once('ready-to-show', () => { if (process.env.RED_E2E !== '1') mainWindow.show(); });
  await mainWindow.loadURL(expectedUrl);
  listingFollowup.start();
  if(!controlledAcceptanceMode)labels.resume(); automatic.start();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(start).catch(error => {
    console.error('HTC startup:', error instanceof Error ? error.message : 'failed');
    if (process.env.RED_E2E !== '1') dialog.showErrorBox('HTC 启动失败', publicError(error));
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  let draining = false, drained = false;
  app.on('will-quit', event => {
    if (drained) return; event.preventDefault(); if (draining) return; draining = true;
    followup?.pause();
    productData?.close(); productData = undefined;
    void (async () => {
      await automatic?.close(); automatic = undefined;
      skuNaming?.close(); skuNaming = undefined; automaticRules?.close(); automaticRules = undefined;
      await labels?.close(); labels = undefined; labelSettings?.close(); labelSettings = undefined; shipmentDocuments?.close(); shipmentDocuments = undefined;
      try { await imageWorkflow?.close(); imageWorkflow = undefined; await miaoshouImages?.close(); miaoshouImages = undefined; await miaoshou?.close(); miaoshou = undefined; await collection?.close(); collection = undefined; await images?.close(); images = undefined; content?.close(); content = undefined; await ai?.close(); ai = undefined; await batchReferences?.close(); batchReferences=undefined; await imageGeneration?.close(); imageGeneration = undefined; await execution?.close(); execution = undefined; await hosting?.close(); hosting = undefined; }
      finally {
        await followup?.close(); followup = undefined; await catalog?.close(); catalog = undefined; procurement?.close(); procurement = undefined; controlledAcceptance?.close();controlledAcceptance=undefined; amazon?.close(); amazon = undefined; store?.close(); store = undefined;
        try { await snapshotWorkspaceDatabase(dataRoot); } catch { console.error('HTC: 关闭时数据库安全快照未完成，已有快照和工作区保持原位。'); }
        drained = true; setImmediate(() => app.quit());
      }
    })().catch(() => { app.exit(1); });
  });
}
