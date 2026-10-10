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
import { CollectionBridge, collectionHostName } from './collection/service.ts';
import { AppearanceStore, appearanceTitleBarOverlay } from './appearance.ts';
import { ImageGenerationService } from './image-generation/service.ts';
import { normalizeGeneratedImage } from './image-generation/normalize.ts';
import { ImageWorkflowService } from './image-workflow/service.ts';
import { AutomaticListingService } from './automatic-listing/service.ts';
import { ItemLabelService } from './item-labels/service.ts';
import { ItemLabelSettings } from './item-labels/settings.ts';
import { classifyProduct } from './catalog/classification.ts';
import { SkuNamingService } from './sku-naming/service.ts';
import { planSalesListings } from './sales-plans/planning.ts';
import { ensureFamilyParent, resolveSalesFamily } from './automatic-listing/families.ts';
import { ShipmentDocumentService } from './procurement/shipment-documents.ts';
import { ListingRuleStore } from './listing-rules.ts';
import { ListingAiService } from './listing-ai/service.ts';
import { imageWorkflowDraftStamp } from './image-workflow/records.ts';

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
let imageWorkflow: ImageWorkflowService | undefined;
let automatic: AutomaticListingService | undefined;
let labels: ItemLabelService | undefined;
let labelSettings: ItemLabelSettings | undefined;
let skuNaming: SkuNamingService | undefined;
let shipmentDocuments: ShipmentDocumentService | undefined;
let content: ReviewedContentService | undefined;
let collection: CollectionBridge | undefined;
let miaoshou: MiaoshouService | undefined;
let miaoshouImages: MiaoshouImageService | undefined;
let window: BrowserWindow | undefined;

async function start() {
  const recovered = await recoverInterruptedRestore(dataRoot);
  await snapshotWorkspaceDatabase(dataRoot);
  store = new WorkspaceStore(dataRoot);
  const db = store;
  if (recovered) db.recordWorkspaceEvent('workspace.restore.recovered', recovered === 'rolled-back' ? '启动时已回滚中断的备份恢复，保留原始工作区' : '启动时已完成中断的备份恢复清理');
  amazon = new AmazonService(dataRoot, id => db.getProduct(id), safeStorage, {
    schemaFetch: (url, init) => net.fetch(url, { ...init, bypassCustomProtocolHandlers: true }),
    dataFetch: (url, init) => net.fetch(url, { ...init, bypassCustomProtocolHandlers: true }),
  });
  hosting = new HostingService(dataRoot, db, safeStorage, { probe: createPublicImageProbe({ nativeFetch: (url, init) => net.fetch(url, { ...init, bypassCustomProtocolHandlers: true }) }) });
  imageGeneration = new ImageGenerationService(dataRoot, db, safeStorage, {
    normalizeImage: normalizeGeneratedImage,
    fetch: (url, init) => net.fetch(url instanceof URL ? url.href : url, { ...init, bypassCustomProtocolHandlers: true }), decodePreview,
    downloadDependencies: { nativeFetch: (url, init) => net.fetch(url, { ...init, bypassCustomProtocolHandlers: true }) },
  });
  const generationService = imageGeneration;
  ai = new AiService(dataRoot, db, hosting, safeStorage, { imageGenerationCapability: () => generationService.capability() });
  images = new ImageVersionService(dataRoot, db, ai, { decode: decodeArtifact });
  content = new ReviewedContentService(dataRoot, db, ai);
  followup = new FollowupService(dataRoot, amazon);
  catalog = new CatalogService(dataRoot, amazon);
  procurement = new ProcurementService(dataRoot, db, amazon);
  productData = new ProductDataService(dataRoot, db, amazon);
  const listingFollowup = followup;
  execution = new ExecutionService(dataRoot, db, amazon, hosting, { scheduleFollowup: id => listingFollowup.schedule(id) });
  // Recover accepted submissions whose process ended between the write checkpoint and queue registration.
  for (const product of db.listProducts()) for (const draft of amazon.listDrafts(product.id)) {
    if (draft.mode === 'live' && (draft.submittedAt || ['UNKNOWN','SUBMITTING'].includes(draft.state))) {
      try { listingFollowup.schedule(draft.id); } catch { db.recordWorkspaceEvent('listing.followup.schedule_failed', '有一条已提交记录尚未登记跟进，请核对上架结果'); }
    }
  }
  collection = new CollectionBridge(dataRoot, db, { nativeHostExecutable: resolve(__dirname, '../dist-native/HTC.CollectionHost.exe'), nativeHostName: collectionHostName(),
    onReceived: event => { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('red:collection:received', event); } });
  miaoshou = new MiaoshouService(dataRoot, db, safeStorage);
  const miaoshouService = miaoshou;
  miaoshouImages = new MiaoshouImageService(dataRoot, db, id => miaoshouService.getReceipt(id), decodePreview, {
    demoImage: miaoshouDemoImage, getSourceUpdate: id => miaoshouService.getSourceUpdate(id),
    download: createSourceImageDownloader({ nativeFetch: (url, init) => net.fetch(url, { ...init, bypassCustomProtocolHandlers: true }) }),
  });
  imageWorkflow = new ImageWorkflowService(dataRoot, db, amazon, ai, imageGeneration, { sources: { getReceipt: id => miaoshouService.getReceipt(id), images: miaoshouImages } });
  labels = new ItemLabelService(dataRoot, amazon, procurement);
  labelSettings = new ItemLabelSettings(dataRoot);
  skuNaming = new SkuNamingService(dataRoot);
  shipmentDocuments = new ShipmentDocumentService(dataRoot, procurement);
  const workflowService = imageWorkflow, listingService = new ListingAiService(db, amazon, ai,()=>workflowService.getCopyReviewSettings().enabled), amazonService = amazon, aiService = ai, formatSettings = labelSettings, catalogService = catalog, namingService=skuNaming, executionService=execution;
  automatic = new AutomaticListingService(dataRoot, {
    store: db, amazon, hosting, images: imageWorkflow, execution, followup, procurement, labels,
    rules: () => { const rules = new ListingRuleStore(dataRoot); try { return rules.get(); } finally { rules.close(); } },
    labelFormat: () => formatSettings.get(),
    sourceReceipt: productId => miaoshouService.getReceipt(productId),
    planSales: (productId,targetId) => {const rules=new ListingRuleStore(dataRoot);try{return planSalesListings(db.getProduct(productId),miaoshouService.getReceipt(productId),amazonService.getTarget(targetId),rules.get(),namingService);}finally{rules.close();}},
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
        fallback: (targetId,keywords) => amazonService.searchProductTypes({targetId,keywords}),
        choose: (value,phase) => aiService.decideCategory({...value,phase},fresh,signal),
      });
    },
    preflight: () => {
      for (const id of ['deepseek','deepseek-review','aliyun-ocr',...(workflowService.getRiskSettings().enabled?['aliyun-image-risk']:[])]) {
        const profile = aiService.getProfile(id); if (!profile.configured || !profile.enabled) throw new UserFacingError('请先在设置中配置并启用内容生成、内容复核、OCR 和侵权检测');
      }
      const generation = generationService.getConnection(); if (!generation.configured || !generation.enabled) throw new UserFacingError('请先在设置中配置并启用生图服务');
    },
    prepareSourceColors: async (id, signal) => {
      const current=amazonService.getDraft(id);
      return listingService.prepareSourceColors({draftId:id,draftRevision:current.revision},signal);
    },
    beginFieldRepair: id => {const current=amazonService.getDraft(id);return listingService.beginCompletion({draftId:id,draftRevision:current.revision}).id;},
    repairFields: async (id, signal, operationId) => {
      const current = amazonService.getDraft(id);
      return await listingService.complete({ draftId: id, draftRevision: current.revision }, signal, operationId);
    },
    recheckImage: async (input, signal) => {
      if (signal.aborted) throw new UserFacingError('自动任务已暂停');
      const draft = amazonService.getDraft(input.draftId), prior = workflowService.getProgress(input.draftId);
      if (prior?.status === 'COMPLETED' && workflowService.isRiskPolicyCompatible(prior) && workflowService.isCopyReviewPolicyCompatible(prior) && prior.draftSha256 === imageWorkflowDraftStamp(draft) && prior.recheckedFromRunId === input.sourceWorkflowId) return draft;
      const cancel = () => workflowService.cancel(input.draftId); signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await workflowService.recheck(input);
        if (result.workflow.status !== 'COMPLETED') throw new UserFacingError(result.workflow.error || '修复后的文案与现有图片复核未通过');
        return result.draft;
      } finally { signal.removeEventListener('abort', cancel); }
    },
  });
  await collection.start();
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
  mainWindow.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(mainWindow, { type: 'question', title: '还有未保存的修改', message: '关闭工作台会放弃当前未保存的修改。',
      buttons: ['继续编辑', '放弃修改并关闭'], defaultId: 0, cancelId: 0, noLink: true });
    if (choice === 1) event.preventDefault();
  });
  installIpc(mainWindow, db, dataRoot, expectedUrl, amazon, hosting, execution, ai, images, content, async prepared => {
    await automatic?.close(); automatic = undefined;
    skuNaming?.close(); skuNaming = undefined;
    await labels?.close(); labels = undefined; labelSettings?.close(); labelSettings = undefined; shipmentDocuments?.close(); shipmentDocuments = undefined;
    await imageWorkflow?.close(); imageWorkflow = undefined;
    productData?.close(); productData = undefined;
    await followup?.close(); followup = undefined; await catalog?.close(); catalog = undefined; procurement?.close(); procurement = undefined;
    await miaoshouImages?.close(); miaoshouImages = undefined;
    await miaoshou?.close(); miaoshou = undefined;
    await collection?.close(); collection = undefined;
    await images?.close(); images = undefined; content?.close(); content = undefined;
    await ai?.close(); ai = undefined; await imageGeneration?.close(); imageGeneration = undefined;
    await execution?.close(); execution = undefined; await hosting?.close(); hosting = undefined;
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
  }, imageGeneration, imageWorkflow, automatic, { labels, labelSettings, shipmentDocuments, procurement }, skuNaming);
  mainWindow.once('ready-to-show', () => { if (process.env.RED_E2E !== '1') mainWindow.show(); });
  await mainWindow.loadURL(expectedUrl);
  listingFollowup.start();
  labels.resume(); automatic.start();
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
      skuNaming?.close(); skuNaming = undefined;
      await labels?.close(); labels = undefined; labelSettings?.close(); labelSettings = undefined; shipmentDocuments?.close(); shipmentDocuments = undefined;
      try { await imageWorkflow?.close(); imageWorkflow = undefined; await miaoshouImages?.close(); miaoshouImages = undefined; await miaoshou?.close(); miaoshou = undefined; await collection?.close(); collection = undefined; await images?.close(); images = undefined; content?.close(); content = undefined; await ai?.close(); ai = undefined; await imageGeneration?.close(); imageGeneration = undefined; await execution?.close(); execution = undefined; await hosting?.close(); hosting = undefined; }
      finally {
        await followup?.close(); followup = undefined; await catalog?.close(); catalog = undefined; procurement?.close(); procurement = undefined; amazon?.close(); amazon = undefined; store?.close(); store = undefined;
        try { await snapshotWorkspaceDatabase(dataRoot); } catch { console.error('HTC: 关闭时数据库安全快照未完成，已有快照和工作区保持原位。'); }
        drained = true; setImmediate(() => app.quit());
      }
    })().catch(() => { app.exit(1); });
  });
}
