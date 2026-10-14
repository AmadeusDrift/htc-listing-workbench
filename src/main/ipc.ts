import type {AiNetworkReport} from '../shared/ai-network-contracts.ts';
import { AI_PURPOSE_LABELS } from '../shared/ai-purpose-contracts.ts';
import { UserFacingError } from '../shared/errors.ts';
import { app, dialog, ipcMain, nativeImage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { WorkspaceStore } from './store.ts';
import { identifier, parseMutation, record } from '../shared/validation.ts';
import { authorizeSender, publicError, publicRejection, managedAssetPath } from './security.ts';
import { importImageFiles } from './assets.ts';
import { exportProductData, parseImport } from './import-export.ts';
import { loadExamples, loadWorkspaceExamples } from './examples.ts';
import { checkReadiness } from './readiness.ts';
import { writeFileAtomically } from './files.ts';
import type { AmazonService } from './amazon/service.ts';
import { installAmazonIpc } from './amazon-ipc.ts';
import { installOperationsIpc } from './operations-ipc.ts';
import type { OperationsServices } from './operations-ipc.ts';
import { installBackupIpc } from './backup-ipc.ts';
import type { PreparedRestore } from './backup.ts';
import { cleanupManagedBackups } from './backup-retention.ts';
import type { HostingService } from './hosting/service.ts';
import type { ExecutionService } from './execution/service.ts';
import { installExecutionIpc } from './execution-ipc.ts';
import type { AiService } from './ai/service.ts';
import { installAiIpc } from './ai-ipc.ts';
import { installArtifactIpc } from './artifact-ipc.ts';
import type { ImageVersionService } from './image-versions/service.ts';
import type { ReviewedContentService } from './content/service.ts';
import { installDiagnosticsIpc } from './diagnostics-ipc.ts';
import { readRunReportBuildContext } from './diagnostics/service.ts';
import { installMiaoshouIpc } from './miaoshou-ipc.ts';
import type { MiaoshouService } from './miaoshou/service.ts';
import type { MiaoshouImageService } from './miaoshou/images.ts';
import { installCollectionIpc } from './collection-ipc.ts';
import type { CollectionHistoryPort } from './collection/history.ts';
import { ListingAiService } from './listing-ai/service.ts';
import { ListingRuleStore } from './listing-rules.ts';
import { AppearanceStore } from './appearance.ts';
import { installImageGenerationIpc } from './image-generation-ipc.ts';
import type { ImageGenerationService } from './image-generation/service.ts';
import type { ImageWorkflowService } from './image-workflow/service.ts';
import { readWorkflowCandidatePreview } from './image-workflow/preview.ts';
import type { AutomaticListingService } from './automatic-listing/service.ts';
import { installAutomaticListingIpc } from './automatic-listing-ipc.ts';
import { installItemLabelIpc } from './item-labels-ipc.ts';
import type { LabelServices } from './item-labels-ipc.ts';
import type { SkuNamingService } from './sku-naming/service.ts';
import { installSkuNamingIpc } from './sku-naming-ipc.ts';

export function decodePreview(bytes: Buffer): Buffer {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new UserFacingError('图片无法解码，请检查文件是否损坏');
  const { width, height } = image.getSize();
  const scale = Math.min(1, 640 / Math.max(width, height));
  return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' }).toPNG();
}
export function installIpc(window: BrowserWindow, store: WorkspaceStore, dataRoot: string, expectedUrl: string, amazon: AmazonService, hosting: HostingService, execution: ExecutionService, ai: AiService, images: ImageVersionService, content: ReviewedContentService, performRestore: (prepared: PreparedRestore) => Promise<void>, collection?: CollectionHistoryPort, miaoshou?: MiaoshouService, miaoshouImages?: MiaoshouImageService, operations?: OperationsServices, appearance: Pick<AppearanceStore, 'getAppearance' | 'saveAppearance'> = new AppearanceStore(dataRoot), imageGeneration?: ImageGenerationService, imageWorkflow?: ImageWorkflowService, automatic?: AutomaticListingService, labelServices?: LabelServices, skuNaming?: SkuNamingService, networkDiagnostics?:()=>Promise<AiNetworkReport>): void {
  let active = 0, restoring = false, shuttingDownForRestore = false;
  function handle(channel: string, argumentCount: number, callback: (...args: unknown[]) => unknown) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      let entered = false;
      try {
        authorizeSender({ senderId: event.sender.id, windowId: window.webContents.id,
          isMainFrame: event.senderFrame === window.webContents.mainFrame, url: event.senderFrame?.url ?? '' }, expectedUrl);
        if (args.length !== argumentCount) throw new UserFacingError('调用参数数量不正确');
        if (restoring) throw new UserFacingError('正在恢复工作区，请等待完成后再操作');
        active += 1; entered = true;
        return { ok: true, data: await callback(...args) };
      } catch (error) { return { ok: false, error: publicError(error), ...(publicRejection(error)?{rejection:publicRejection(error)}:{}) }; }
      finally { if (entered) active -= 1; }
    });
  }
  handle('red:ai:network-diagnostics',0,()=>{if(!networkDiagnostics)throw new UserFacingError('当前环境未启用网络诊断');return networkDiagnostics();});
  handle('red:appearance:get', 0, () => appearance.getAppearance());
  if (skuNaming) installSkuNamingIpc(skuNaming, handle, { audit:(action,summary)=>store.recordWorkspaceEvent(action,summary) });
  handle('red:appearance:save', 1, input => appearance.saveAppearance(input));
  const rules = <T,>(task: (rules: ListingRuleStore) => T): T => { const rules = new ListingRuleStore(dataRoot); try { return task(rules); } finally { rules.close(); } };
  handle('red:listing-rules:get', 0, () => rules(store => store.get()));
  handle('red:listing-rules:save', 1, input => rules(store => store.save(input)));
  handle('red:products:list', 0, () => store.listProducts());
  handle('red:workspaces:list', 0, () => store.listWorkspacePlacements());
  handle('red:workspaces:move', 1, input => store.moveWorkspaceProducts(input));
  handle('red:products:get', 1, id => store.getProduct(identifier(id)));
  handle('red:products:create', 0, () => store.createProduct());
  handle('red:products:save', 1, input => store.saveProduct(input));
  handle('red:assets:update', 1, input => store.updateAsset(input));
  handle('red:assets:import', 1, async raw => {
    record(raw, '图片导入参数', ['productId', 'revision']);
    const input = parseMutation(raw); store.assertRevision(input);
    const result = await dialog.showOpenDialog(window, { title: '导入商品图片', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片（每张最多 20 MB）', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (result.canceled) return store.getProduct(input.productId);
    return importImageFiles(store, dataRoot, input, result.filePaths, decodePreview);
  });
  handle('red:products:import', 0, async () => {
    const result = await dialog.showOpenDialog(window, { title: '导入商品资料', properties: ['openFile'], filters: [{ name: 'HTC 商品资料', extensions: ['json', 'csv'] }] });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true, count: 0, productIds: [] };
    const path = result.filePaths[0], size = (await stat(path)).size;
    if (size > 5 * 1024 * 1024) throw new UserFacingError('导入文件不能超过 5 MB');
    const products = parseImport(await readFile(path, 'utf8'), extname(path).slice(1).toLowerCase());
    const productIds = store.importProducts(products);
    return { cancelled: false, count: productIds.length, productIds };
  });
  handle('red:products:export', 1, async rawId => {
    const product = store.getProduct(identifier(rawId));
    const title = product.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 60);
    const result = await dialog.showSaveDialog(window, { title: '导出商品资料（不包含图片文件）', defaultPath: `${title}.htc.json`, filters: [{ name: 'HTC 商品资料', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { cancelled: true };
    await writeFileAtomically(result.filePath, JSON.stringify(exportProductData(product), null, 2) + '\n');
    return { cancelled: false, path: result.filePath };
  });
  handle('red:examples:load', 0, () => loadExamples(store, dataRoot, decodePreview));
  handle('red:examples:load-workspace', 1, lane => {
    if (lane !== 'inbox' && lane !== 'automatic') throw new UserFacingError('本地示例工作区无效');
    return loadWorkspaceExamples(store, dataRoot, decodePreview, lane);
  });
  handle('red:products:check', 1, id => {const product=store.getProduct(identifier(id)),readiness=checkReadiness(product);let passed=true,detail='当前 SKU 原图与规格已核对';try{store.assertSourceConsistency(product.id,product.variants.map(v=>v.id));}catch(error){passed=false;detail=publicError(error);}readiness.checks.push({key:'source-consistency',label:'原图与规格一致性',passed,detail});return readiness;});
  handle('red:audit:list', 1, id => store.listAudit(id === undefined ? undefined : identifier(id)));
  handle('red:settings:get', 0, () => {
    const targets = amazon.listTargets(), live = targets.find(target => target.mode === 'live' && target.configured);
    return { appVersion: app.getVersion(), dataDirectory: dataRoot, databasePath: join(dataRoot, 'red.sqlite'),
      assetDirectory: join(dataRoot, 'assets'), ...store.getStats(), amazonStatus: live ? (live.paused ? 'paused' : 'configured') : targets.some(target => target.mode === 'demo' && !target.paused) ? 'demo' : 'not_configured' };
  });
  handle('red:settings:open-directory', 0, async () => {
    const result = await shell.openPath(dataRoot); if (result) throw new UserFacingError('无法打开数据目录，请从设置中复制路径后手动打开');
  });
  installAmazonIpc(window, amazon, handle, async () => cleanupManagedBackups(dataRoot, amazon.getDataPolicy().retentionDays), operations ? id => {
    try { operations.followup.schedule(id); }
    catch { store.recordWorkspaceEvent('listing.followup.schedule_failed', '提交结果已保存，延迟跟进登记未完成；重新打开工作台后会再次检查'); }
  } : undefined);
  if (operations) installOperationsIpc(dataRoot, operations, handle, {
    selectDestination: (name, extension) => dialog.showSaveDialog(window, { title: '导出备货单', defaultPath: name, filters: [{ name: extension === 'csv' ? 'CSV 表格' : '可打印备货单', extensions: [extension] }] }),
    preview: async id => {
      const asset = store.getAssetRecord(id); if (!asset) return null;
      const image = nativeImage.createFromBuffer(await readFile(managedAssetPath(dataRoot, asset.previewPath)));
      if (image.isEmpty()) throw new UserFacingError('商品图片无法解码，请重新下载');
      const { width, height } = image.getSize(), scale = Math.min(1, 80 / Math.max(width, height));
      return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' }).toPNG();
    },
    openSource: url => shell.openExternal(url),
    audit: (action, summary) => store.recordWorkspaceEvent(action, summary),
  });
  installExecutionIpc(window, hosting, execution, store, handle);
  if (automatic) installAutomaticListingIpc(automatic, handle, {
    confirm: async task => {
      if(task.resumeScope){const answer=await dialog.showMessageBox(window,{type:'question',title:'确认所选范围',message:`处理所选 ${task.items.length} 个 SKU？`,detail:task.error??'保留原成果、原请求及预算',buttons:['取消','确认处理所选范围'],defaultId:0,cancelId:0,noLink:true});return answer.response===1;}
      const detail = `执行模式：${task.executionMode==='deferred_batch'?'延迟批量（Batch）':'即时上架'}\n${task.batchPlan?.coverage.map(row=>`${AI_PURPOSE_LABELS[row.purposeId as keyof typeof AI_PURPOSE_LABELS]??({image_generation:'图片生成',aliyun_ocr:'阿里 OCR',aliyun_image_risk:'阿里图片风险检测'} as Record<string,string>)[row.purposeId]??row.purposeId}：${row.mode==='deferred_batch'?'Batch':'普通执行'} · ${row.reason}`).join('\n')??''}\n仅可 Batch 步骤使用批量计价；不承诺整任务 24 小时完成。\n\n${task.targetName} · ${task.sellerId} · ${task.marketplaceId}\n商品类型：${task.productType} · 图床：${task.profileId}\n备货：每个 SKU ${task.items[0].stockSets} 个销售单位\n\n${task.items.slice(0,50).map(row => row.sku).join('\n')}${task.items.length > 50 ? '\n……其余 SKU 见任务清单' : ''}\n\n将自动完成资料、图片、侵权与 OCR 复核、上传、校验${task.mode === 'live' ? '及正式发布' : '及本地演示'}。通过后继续回读并建立备货批次；商品标签在需要时单独准备；异常商品会停止并显示原因。`;
      const answer = await dialog.showMessageBox(window, { type: 'question', title: '启动完整自动上架流程', message: `启动 ${task.items.length} 个 SKU 的自动流程？`, detail,
        buttons: ['取消', task.mode === 'live' ? '启动并自动发布' : '启动本地演示'], defaultId: 0, cancelId: 0, noLink: true });
      return answer.response === 1;
    }, audit: (action, summary) => store.recordWorkspaceEvent(action, summary),
  });
  if (labelServices) installItemLabelIpc(dataRoot, labelServices, handle, {
    selectFolder: () => dialog.showOpenDialog(window, { title: '导出本批商品标签和数量清单', properties: ['openDirectory','createDirectory'] }),
    selectPdf: () => dialog.showOpenDialog(window, { title: '归档已有货件的箱唛', properties: ['openFile'], filters: [{ name: '箱唛 PDF', extensions: ['pdf'] }] }),
    openPath: path => shell.openPath(path), audit: (action, summary) => store.recordWorkspaceEvent(action, summary),
  });
  installAiIpc(window, ai, store, handle);
  if (imageGeneration) {
    installImageGenerationIpc(imageGeneration, handle);
    window.once('closed', () => imageGeneration.cancel());
  }
  const listingAi = new ListingAiService(store, amazon, ai,()=>imageWorkflow?.getCopyReviewSettings().enabled??true);
  if (imageWorkflow) {
    handle('red:image-risk:settings',0,()=>imageWorkflow.getRiskSettings());
    handle('red:image-risk:save',1,input=>imageWorkflow.saveRiskSettings(input));
    handle('red:appearance-review:settings',0,()=>imageWorkflow.getAppearanceReviewSettings());
    handle('red:appearance-review:save',1,input=>imageWorkflow.saveAppearanceReviewSettings(input));
    handle('red:copy-review:settings',0,()=>imageWorkflow.getCopyReviewSettings());
    handle('red:copy-review:save',1,input=>imageWorkflow.saveCopyReviewSettings(input));
    handle('red:automatic-product:retry-allowance',1,async input=>{const run=await imageWorkflow.addRetryAllowance(input);return imageWorkflow.getProgressPresentation(run.draftId)!;});
    handle('red:automatic-product:unknown-retry',1,async input=>{const run=await imageWorkflow.approveUnknownRetry(input);return imageWorkflow.getProgressPresentation(run.draftId)!;});
    handle('red:automatic-product:sources', 1, input => imageWorkflow.prepareSources(input));
    handle('red:automatic-product:sources-cancel', 1, id => imageWorkflow.cancelSources(id));
    handle('red:automatic-product:complete', 1, input => imageWorkflow.complete(input));
    handle('red:automatic-product:progress', 1, id => imageWorkflow.getProgressPresentation(id));
    if (imageGeneration) handle('red:automatic-product:candidate-preview', 1, input => readWorkflowCandidatePreview(input, id => imageWorkflow.getProgress(id), id => imageGeneration.readCandidate(id)));
    handle('red:automatic-product:cancel', 1, id => imageWorkflow.cancel(id));
    window.once('closed', () => imageWorkflow.cancelAll());
  }
  const listingRequests = new Map<string, AbortController>();
  async function listingRequest(raw: unknown, operation: 'suggest' | 'review' | 'complete') {
    const draftId = identifier((raw as { draftId?: unknown })?.draftId);
    if (listingRequests.has(draftId)) throw new UserFacingError('此草稿的 AI 请求正在处理，请等待或取消');
    const controller = new AbortController(); listingRequests.set(draftId, controller);
    try { return await listingAi[operation](raw, controller.signal); } finally { listingRequests.delete(draftId); }
  }
  window.once('closed', () => { for (const controller of listingRequests.values()) controller.abort(); });
  handle('red:listing-ai:complete', 1, raw => listingRequest(raw, 'complete'));
  handle('red:listing-ai:suggest', 1, raw => listingRequest(raw, 'suggest'));
  handle('red:listing-ai:review', 1, raw => listingRequest(raw, 'review'));
  handle('red:listing-ai:adopt', 1, raw => listingAi.adopt(raw));
  handle('red:listing-ai:cancel', 1, raw => { const id = identifier(raw); listingRequests.get(id)?.abort(); return { cancelled: true }; });
  installArtifactIpc(images, content, handle);
  installCollectionIpc(dataRoot, handle, collection, path => shell.openPath(path));
  if (miaoshou && miaoshouImages) installMiaoshouIpc(miaoshou, miaoshouImages, handle, {
    selectConfig: () => dialog.showOpenDialog(window, { title: '导入妙手配置', properties: ['openFile'], filters: [{ name: '妙手配置 JSON', extensions: ['json'] }] }),
    saveTemplate: async content => {
      const result = await dialog.showSaveDialog(window, { title: '保存妙手配置模板', defaultPath: 'miaoshou.template.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return { cancelled: true };
      await writeFileAtomically(result.filePath, content); return { cancelled: false };
    },
  });
  const runReportContext = readRunReportBuildContext(app.getVersion(), app.getAppPath());
  installDiagnosticsIpc(dataRoot, handle, {
    runReport: { query: input => store.getRunDiagnostics(input, runReportContext), export: input => store.exportRunDiagnostics(input, runReportContext) },
    context: () => ({ appVersion: app.getVersion(), runtime: { nodeMajor: Number(process.versions.node.split('.')[0]), electronMajor: Number(process.versions.electron.split('.')[0]) },
      services: { aiBusy: ai.busy, imageWritesBusy: images.busy, executionBusy: execution.busy } }),
    selectDestination: () => dialog.showSaveDialog(window, { title: '导出本地诊断报告', defaultPath: 'HTC-本地诊断.json', filters: [{ name: 'JSON', extensions: ['json'] }] }),
  });
  installBackupIpc(window, dataRoot, handle, {
    beginRestore: () => {
      if (active > 1) throw new UserFacingError('还有操作正在执行，请完成后再恢复备份');
      if (execution.busy) throw new UserFacingError('后台任务仍在执行；请先暂停并等待当前步骤结束，再恢复备份');
      if (automatic?.busy || labelServices?.labels.hasActiveWork()) throw new UserFacingError('自动上架或标签任务仍在执行，请先暂停并等待完成后再恢复备份');
      if (ai.busy) throw new UserFacingError('AI 请求仍在执行；请等待完成或禁用对应服务后再恢复备份');
      if (imageGeneration?.busy) throw new UserFacingError('生图请求仍在执行，请等待完成或取消后再恢复备份');
      if (imageWorkflow?.busy) throw new UserFacingError('自动商品流程仍在执行，请先停止后再恢复备份');
      if (images.busy) throw new UserFacingError('图片成果仍在保存，请等待完成后再恢复备份');
      if (miaoshou?.busy || miaoshouImages?.busy) throw new UserFacingError('妙手读取或图片下载仍在执行，请等待完成后再恢复备份');
      if (operations?.catalog.busy || operations?.followup.busy) throw new UserFacingError('类目同步或上架回读仍在执行，请等待完成后再恢复备份');
      if (operations?.productData?.busy) throw new UserFacingError('商品数据同步仍在执行，请先停止并等待当前请求结束，再恢复备份');
      const resumeCollection = collection?.pauseForRestore();
      operations?.followup.pause();
      automatic?.suspendScheduling(); labelServices?.labels.suspendScheduling();
      restoring = true;
      return () => { restoring = false; resumeCollection?.(); if (!shuttingDownForRestore) { operations?.followup.resume(); automatic?.start(); labelServices?.labels.resume(); } };
    },
    performRestore: async prepared => { shuttingDownForRestore = true; await performRestore(prepared); },
    beginBackup: () => {
      if (active > 1 || execution.busy || automatic?.busy || labelServices?.labels.hasActiveWork() || ai.busy || imageGeneration?.busy || imageWorkflow?.busy || images.busy || miaoshou?.busy || miaoshouImages?.busy || operations?.catalog.busy || operations?.followup.busy || operations?.productData?.busy) throw new UserFacingError('还有操作正在执行；请先暂停并等待当前步骤结束，再进行备份或清理');
      const releases: (() => void)[] = [];
      try {
        const collectionLease = collection?.pauseForRestore(); if (collectionLease) releases.push(collectionLease);
        if (automatic) releases.push(automatic.holdForMaintenance());
        if (operations?.followup) releases.push(operations.followup.holdForMaintenance());
        if (labelServices) releases.push(labelServices.labels.holdForMaintenance());
      } catch (error) { for (const release of releases.reverse()) release(); throw error; }
      restoring = true; let released = false;
      // IPC is locked during the lease. Release restores only the prior timer switches,
      // never task states or grants, and cannot start a previously paused task.
      return () => { if (released) return; released = true; restoring = false; for (const release of releases.reverse()) release(); };
    },
    audit: (action, summary, detail) => store.recordWorkspaceEvent(action, summary, detail),
  });
}
