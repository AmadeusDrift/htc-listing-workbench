import { captureScroll, restoreScroll, type ScrollPosition } from './navigation-scroll';
import { NavigationMemoryContext } from './navigation-context';
import type { ProblemContext } from './navigation-context';
import { AlertCircle, Box, CheckCircle2, ChevronRight, FileInput, FolderOpen, Inbox, LoaderCircle, Monitor, Plus, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, AssetRole, AuditEvent, ListingReadiness, ProductDetail, ProductSummary } from '../shared/contracts';
import { FormGuardContext, GuardedNavigationContext } from './FormGuard';
import { createFormGuardRegistry } from './form-guard-registry';
import { ProductEditor } from './ProductEditor';
import { ProductList } from './ProductList';
import { AuditView, SettingsView } from './SupportingViews';
import { errorText, isChanged, toSaveInput } from './utils';
import type { EditorTab, MainView } from './utils';
import type { AmazonDraft, AmazonTarget } from '../shared/amazon-contracts';
import type { DraftGuard } from './amazon-ui';
import type { WorkspaceLane, WorkspacePlacement } from '../shared/workspace-contracts';
import { InboxPage } from './InboxPage';
import { AutomaticPage } from './AutomaticPage';
import { ResultsPage } from './ResultsPage';
import { OperationsPage } from './OperationsPage';
import { ProductDataPage } from './ProductDataPage';
import { WorkflowRail } from './WorkflowRail';
import type { WorkflowStep } from './WorkflowRail';
import { WorkspaceNavigation, viewDescriptions, viewLabels } from './WorkspaceNavigation';
import { productsInLane } from './workspace-model';
import { DesktopTitleBar } from './AppearanceSettings';
import { useAppearance } from './useAppearance';
import type { SettingsModule } from './settings-navigation';

type PendingAction = () => void | Promise<unknown>;

export default function App() {
  const api = window.red;
  const formGuards = useRef(createFormGuardRegistry()).current;
  const navigationMemory = useRef(new Map<string, unknown>()).current;
  const [returnTo, setReturnTo] = useState<{ view: MainView; scroll: ScrollPosition[]; context?: ProblemContext } | null>(null);
  const mainContent = useRef<HTMLElement>(null);
  const pendingScroll = useRef<ScrollPosition[] | null>(null);
  const appearance = useAppearance();
  const [settingsRequest, setSettingsRequest] = useState<{ module: SettingsModule; token: number }>({ module: 'amazon', token: 0 });
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [savedProduct, setSavedProduct] = useState<ProductDetail | null>(null);
  const [view, setView] = useState<MainView>('inbox');
  useEffect(() => {
    if (!pendingScroll.current || !mainContent.current) return;
    const positions = pendingScroll.current; pendingScroll.current = null;
    return restoreScroll(mainContent.current, positions);
  }, [view]);
  const [placements, setPlacements] = useState<WorkspacePlacement[]>([]);
  const [resultDrafts, setResultDrafts] = useState<AmazonDraft[]>([]);
  const [shippingBatchId, setShippingBatchId] = useState<string>();
  const [procurementContext, setProcurementContext] = useState<{ targetId: string; sku?: string }>();
  const [tab, setTab] = useState<EditorTab>('info');
  const [initialDraftId, setInitialDraftId] = useState<string>();
  const [workflowRequest, setWorkflowRequest] = useState<{ step: WorkflowStep; token: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(api ? '正在读取商品资料…' : null);
  const [initialized, setInitialized] = useState(!api);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showGuard, setShowGuard] = useState(false);
  const [guardSaving, setGuardSaving] = useState(false);
  const guardSavingRef = useRef(false);
  const [readiness, setReadiness] = useState<ListingReadiness | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [amazonTargets, setAmazonTargets] = useState<AmazonTarget[]>([]);
  const [amazonDirty, setAmazonDirty] = useState(false);
  const amazonGuard = useRef<DraftGuard | null>(null);
  const registerAmazonGuard = useCallback((guard: DraftGuard | null) => { amazonGuard.current = guard; }, []);
  const currentRef = useRef<ProductDetail | null>(null);
  const savedRef = useRef<ProductDetail | null>(null);
  const lockedRef = useRef(Boolean(api));
  const pendingRef = useRef<PendingAction | null>(null);
  const dirty = isChanged(product, savedProduct) || amazonDirty;

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.getSettings().then(value => {
      if (active) { setAppVersion(value.appVersion); document.title = `HTC v${value.appVersion} · 独立上架工作台`; }
    }).catch(() => { if (active) setAppVersion(''); });
    return () => { active = false; };
  }, [api]);

  async function refreshAmazonTargets() {
    try { setAmazonTargets(await api.listAmazonTargets()); }
    catch (cause) { setError(errorText(cause)); }
  }

  const commitProduct = useCallback((detail: ProductDetail) => {
    currentRef.current = detail;
    savedRef.current = detail;
    setProduct(detail);
    setSavedProduct(detail);
    setReadiness(null);
    // Retain the confirmed result even if the follow-up list refresh fails.
    const summary: ProductSummary = {
      id: detail.id, title: detail.title, sourceUrl: detail.sourceUrl,
      status: detail.status, origin: detail.origin,
      variantCount: detail.variants.length, assetCount: detail.assets.length,
      coverUrl: (detail.assets.find((asset) => asset.role === 'main') ?? detail.assets[0])?.previewUrl ?? null,
      updatedAt: detail.updatedAt,
    };
    setProducts((current) => current.some((item) => item.id === detail.id)
      ? current.map((item) => item.id === detail.id ? summary : item)
      : [summary, ...current]);
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [list, targets, locations] = await Promise.all([api.listProducts(), api.listAmazonTargets(), api.listWorkspacePlacements()]);
        if (cancelled) return;
        setProducts(list);
        setAmazonTargets(targets);
        setPlacements(locations);
        const first = productsInLane(list, locations, 'manual')[0];
        if (first) {
          const detail = await api.getProduct(first.id);
          if (!cancelled) commitProduct(detail);
        }
      } catch (cause) { if (!cancelled) setError(errorText(cause)); }
      finally { if (!cancelled) { lockedRef.current = false; setBusy(null); setInitialized(true); } }
    };
    void load();
    return () => { cancelled = true; };
  }, [api, commitProduct]);

  useEffect(() => {
    const keyboard = () => { document.documentElement.dataset.inputMode = 'keyboard'; };
    const pointer = () => { document.documentElement.dataset.inputMode = 'pointer'; };
    window.addEventListener('keydown', keyboard, true); window.addEventListener('pointerdown', pointer, true);
    return () => { window.removeEventListener('keydown', keyboard, true); window.removeEventListener('pointerdown', pointer, true); };
  }, []);

  useEffect(() => {
    if (!api) return;
    let active = true;
    let sequence = 0;
    const unsubscribe = api.onCollectionReceived(event => {
      const request = ++sequence;
      void Promise.all([api.listProducts(), api.listWorkspacePlacements()]).then(([list, locations]) => {
        if (!active || request !== sequence) return;
        setProducts(list); setPlacements(locations);
        setToast(event.duplicate ? '商品已在采集箱，未重复创建' : '新商品已收到采集箱');
        // Incoming collection must never replace an editor's unsaved product or change its view.
      }).catch(() => { if (active) setError('已收到采集商品，列表刷新失败；重新打开工作台可查看。'); });
    });
    return () => { active = false; unsubscribe(); };
  }, [api]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (isChanged(currentRef.current, savedRef.current) || amazonGuard.current?.dirty() || formGuards.dirty()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);

  const requestClose = useRef<() => void>(() => {});
  requestClose.current = () => guarded(() => { requestAnimationFrame(() => window.close()); });
  useEffect(() => api?.onUnsavedCloseRequested?.(() => requestClose.current()), [api]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function perform<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
    if (lockedRef.current || !api) return undefined;
    lockedRef.current = true;
    setBusy(label);
    setError(null);
    try { return await task(); }
    catch (cause) { setError(errorText(cause)); return undefined; }
    finally { lockedRef.current = false; setBusy(null); }
  }

  async function refreshProducts() {
    try { const [list, locations] = await Promise.all([api.listProducts(), api.listWorkspacePlacements()]); setProducts(list); setPlacements(locations); return list; }
    catch (cause) { setError(`资料操作已完成，但商品列表刷新失败：${errorText(cause)}`); return null; }
  }

  async function saveDraft(): Promise<boolean> {
    const current = currentRef.current;
    if (current && isChanged(current, savedRef.current)) {
      const result = await perform('正在保存修改…', async () => {
        const updated = await api.saveProduct(toSaveInput(current));
        commitProduct(updated);
        await refreshProducts();
        setToast('商品修改已保存');
        return true;
      });
      if (result !== true) return false;
    }
    if (amazonGuard.current?.dirty() && !await amazonGuard.current.save()) return false;
    return formGuards.save();
  }

  function guarded(action: PendingAction) {
    if (lockedRef.current || guardSavingRef.current) return;
    if (isChanged(currentRef.current, savedRef.current) || amazonGuard.current?.dirty() || formGuards.dirty()) {
      pendingRef.current = action;
      setError(null);
      setShowGuard(true);
    } else { void action(); }
  }

  function cancelGuard() { if (!lockedRef.current && !guardSavingRef.current) { pendingRef.current = null; setShowGuard(false); } }

  async function continueAfterSave() {
    if (lockedRef.current || guardSavingRef.current) return;
    guardSavingRef.current = true; setGuardSaving(true);
    let saved = false;
    try { saved = await saveDraft(); }
    catch (cause) { setError(errorText(cause)); }
    finally { guardSavingRef.current = false; setGuardSaving(false); }
    if (!saved) { setError(value => value || '部分表单未能保存，请继续编辑并核对对应提示。'); return; }
    const action = pendingRef.current;
    pendingRef.current = null;
    setShowGuard(false);
    if (action) await action();
  }

  function continueAfterDiscard() {
    if (lockedRef.current || guardSavingRef.current) return;
    amazonGuard.current?.discard();
    formGuards.discard();
    if (savedRef.current) commitProduct(savedRef.current);
    const action = pendingRef.current;
    pendingRef.current = null;
    setShowGuard(false);
    if (action) void action();
  }

  function changeProduct(update: (current: ProductDetail) => ProductDetail) {
    if (lockedRef.current || !currentRef.current) return;
    const next = update(currentRef.current);
    currentRef.current = next;
    setProduct(next);
    setReadiness(null);
  }

  function selectProduct(id: string) {
    if (id === currentRef.current?.id) return;
    guarded(() => perform('正在读取商品…', async () => {
      const detail = await api.getProduct(id);
      commitProduct(detail);
      setTab('info'); setInitialDraftId(undefined); setWorkflowRequest(null);
      setView('manual');
    }));
  }

  function createProduct() {
    guarded(() => perform('正在新建商品…', async () => {
      const detail = await api.createProduct();
      commitProduct(detail);
      setView('manual');
      setTab('info'); setInitialDraftId(undefined); setWorkflowRequest(null);
      await refreshProducts();
      setToast('商品已创建，可以开始填写资料');
    }));
  }

  function importProducts() {
    guarded(() => perform('正在导入商品…', async () => {
      const result = await api.importProducts();
      if (result.cancelled) return;
      await refreshProducts();
      setView('inbox');
      setToast(result.count > 0 ? `已导入 ${result.count} 件商品到采集箱` : '没有新增商品');
    }));
  }

  function loadExamples() {
    guarded(() => perform('正在载入示例商品…', async () => {
      const result = await api.loadExamples();
      const list = await refreshProducts();
      const locations = await api.listWorkspacePlacements();
      const sample = productsInLane(list ?? result, locations, 'manual').find(item => item.origin === 'sample');
      if (sample) { commitProduct(await api.getProduct(sample.id)); setTab('info'); setInitialDraftId(undefined); setWorkflowRequest(null); setView('manual'); }
      setToast(sample ? '示例商品已载入，已标记为「示例」' : '示例商品已存在，已保留当前分流位置');
    }));
  }

  function loadWorkspaceExamples(lane: 'inbox' | 'automatic') {
    guarded(() => perform('正在载入本地示例…', async () => {
      const existing = new Set(products.map(item => item.id));
      const list = await api.loadWorkspaceExamples(lane), locations = await api.listWorkspacePlacements();
      setProducts(list); setPlacements(locations); setView(lane);
      const added = list.filter(item => !existing.has(item.id) && item.origin === 'sample').length;
      setToast(added ? `已向${lane === 'inbox' ? '采集箱' : '自动上架准备区'}载入 ${added} 件本地示例` : '本地示例已存在，已保留修改和分流位置');
    }));
  }

  function importImages() {
    guarded(() => perform('正在导入图片…', async () => {
      const current = currentRef.current;
      if (!current) return;
      const updated = await api.importImages({ productId: current.id, revision: current.revision });
      const imported = updated.assets.length - current.assets.length;
      commitProduct(updated);
      await refreshProducts();
      if (imported > 0) setToast(`已导入 ${imported} 张图片`);
    }));
  }

  function updateAsset(assetId: string, role: AssetRole, variantIds: string[]) {
    guarded(() => perform('正在保存图片设置…', async () => {
      const current = currentRef.current;
      if (!current) return;
      const updated = await api.updateAsset({ productId: current.id, revision: current.revision, assetId, role, variantIds });
      commitProduct(updated);
      await refreshProducts();
      setToast('图片设置已保存');
    }));
  }

  function exportProduct() {
    guarded(() => perform('正在导出商品资料…', async () => {
      if (!currentRef.current) return;
      const result = await api.exportProduct(currentRef.current.id);
      if (!result.cancelled) setToast('商品资料已导出');
    }));
  }

  function checkProduct() {
    guarded(() => perform('正在检查本地资料…', async () => {
      if (!currentRef.current) return;
      setReadiness(await api.checkProduct(currentRef.current.id));
    }));
  }

  function navigate(nextView: MainView) {
    if (nextView === view) return;
    guarded(() => {
      if (nextView === 'inbox' || nextView === 'automatic') { setReturnTo(null); setView(nextView); return; }
      return perform('正在打开工作区…', async () => {
        if (nextView === 'audit') setAudit(await api.listAudit());
        else if (nextView === 'settings') setSettings(await api.getSettings());
        else if (nextView === 'results') await refreshResults();
        else if (nextView === 'product-data') await refreshProductData();
        else if (nextView === 'shipping') setShippingBatchId(undefined);
        else if (nextView === 'manual') {
          const manual = productsInLane(products, placements, 'manual');
          if (!manual.some(item => item.id === currentRef.current?.id)) {
            if (manual[0]) commitProduct(await api.getProduct(manual[0].id));
            else { currentRef.current = null; savedRef.current = null; setProduct(null); setSavedProduct(null); }
          }
        }
        setReturnTo(null); setView(nextView);
      });
    });
  }

  function openSettings(module: SettingsModule = 'amazon') {
    guarded(() => perform('正在打开设置…', async () => {
      setSettings(await api.getSettings());
      setSettingsRequest({ module, token: Date.now() });
      setView('settings');
    }));
  }

  async function refreshResults() {
    const all: AmazonDraft[] = [];
    // Bounded local reads keep a large workspace responsive and preserve errors.
    for (let index = 0; index < products.length; index += 20) {
      const batch = await Promise.all(products.slice(index, index + 20).map(item => api.listAmazonDrafts(item.id)));
      all.push(...batch.flat());
    }
    setResultDrafts(all);
  }

  async function refreshProductData() {
    setAmazonTargets(await api.listAmazonTargets());
  }

  function openShipping(batchId: string) {
    guarded(() => { setShippingBatchId(batchId); setView('shipping'); });
  }

  function openProduct(id: string, initialTab: EditorTab = 'info', draftId?: string, context?: ProblemContext) {
    guarded(() => perform('正在打开商品…', async () => {
      const detail = await api.getProduct(id);
      const requestedDraft = draftId ? (await api.listAmazonDrafts(id)).find(row => row.id === draftId) : undefined;
      if (draftId && !requestedDraft) {
        setError('目标草稿已不存在，请返回来源页面刷新；未打开其他草稿。'); return;
      }
      if (requestedDraft && context?.variantId && requestedDraft.variantId !== context.variantId) { setError('目标草稿与 SKU 不一致；未打开其他草稿。'); return; }
      if (context?.variantId && !detail.variants.some(item => item.id === context.variantId)) { setError('目标 SKU 已不存在，请返回来源页面刷新。'); return; }
      setReturnTo({ view, scroll: mainContent.current ? captureScroll(mainContent.current) : [], context });
      commitProduct(detail); setTab(initialTab); setInitialDraftId(draftId); setWorkflowRequest(null); setView('manual');
    }));
  }

  function returnToSource() {
    if (!returnTo) return;
    const destination = returnTo;
    guarded(() => { pendingScroll.current = destination.scroll; setView(destination.view); setReturnTo(null);
    });
  }

  function moveProducts(ids: string[], lane: WorkspaceLane, open = false, initialTab: EditorTab = 'info', draftId?: string) {
    guarded(() => perform('正在更新商品去向…', async () => {
      await api.moveWorkspaceProducts({ productIds: ids, destination: lane });
      const list = await refreshProducts();
      if (open && ids[0]) { commitProduct(await api.getProduct(ids[0])); setTab(initialTab); setInitialDraftId(draftId); setWorkflowRequest(null); setView('manual'); }
      else if (view === 'manual' && currentRef.current && ids.includes(currentRef.current.id) && lane !== 'manual') {
        const locations = await api.listWorkspacePlacements();
        const first = productsInLane(list ?? products, locations, 'manual')[0];
        if (first) commitProduct(await api.getProduct(first.id));
        else { currentRef.current = null; savedRef.current = null; setProduct(null); setSavedProduct(null); }
      }
      const label = { inbox: '采集箱', manual: '手动上架', automatic: '自动上架准备区', ignored: '已忽略' }[lane];
      setToast(`已将 ${ids.length} 件商品移至${label}`);
    }));
  }

  const manualProducts = productsInLane(products, placements, 'manual');
  const automaticProducts = productsInLane(products, placements, 'automatic');
  const inboxProducts = productsInLane(products, placements, 'inbox');

  if (!api) return <div className="desktop-notice"><span className="brand-logo">H<span /></span><Monitor size={34} strokeWidth={1.4} /><h1>请从 HTC 桌面应用打开</h1><p>此工作台需要桌面环境来读取本机商品资料。<br />请启动 HTC 桌面应用后继续。</p></div>;

  return <NavigationMemoryContext.Provider value={navigationMemory}><FormGuardContext.Provider value={formGuards}><GuardedNavigationContext.Provider value={guarded}><div className="desktop-shell"><DesktopTitleBar version={appVersion} appearance={appearance} /><div className="app-shell htc-workspaces">
    <WorkspaceNavigation view={view} busy={Boolean(busy)} counts={{ inbox: inboxProducts.length, manual: manualProducts.length, automatic: automaticProducts.length }} targets={amazonTargets} onNavigate={navigate} onExamples={loadExamples} onConnectionSettings={() => openSettings('amazon')} />
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>工作空间</span><ChevronRight size={13} /><strong>{viewLabels[view]}</strong></div><span className="topbar-local"><span className="topbar-location"><FolderOpen size={14} />本地工作区<span className="topbar-divider" />HTC</span><strong className="app-version" aria-label="当前应用版本">{appVersion ? `v${appVersion}` : '版本读取中'}</strong></span></header>
      <main ref={mainContent} className="main-content" data-workspace={view}>
        <div className="page-heading"><div><span className="page-eyebrow">LISTING WORKSPACE</span><h1>{viewLabels[view]}</h1><p>{viewDescriptions[view]}</p></div>
          <div className="page-actions">{view === 'manual' && returnTo && <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={returnToSource}>返回{viewLabels[returnTo.view]}{returnTo.context?.taskId ? ' · 原任务' : ''}</button>}
            {view === 'manual' && product && <button type="button" className="button secondary" onClick={() => moveProducts([product.id], 'inbox')} disabled={Boolean(busy)}><Inbox size={16} />移回采集箱</button>}
            {(view === 'manual' || view === 'inbox') && <><button type="button" className="button secondary" onClick={importProducts} disabled={Boolean(busy)}><FileInput size={16} />导入商品</button><button type="button" className="button primary" onClick={createProduct} disabled={Boolean(busy)}><Plus size={17} />新建商品</button></>}
          </div>
        </div>
        {error && <div className="error-banner" role="alert"><AlertCircle size={18} /><div><strong>操作未完成</strong><p>{error}</p></div><button type="button" className="icon-button" aria-label="关闭错误提示" onClick={() => setError(null)}><X size={16} /></button></div>}
        {appearance.error && view !== 'settings' && <div className="error-banner" role="alert"><AlertCircle size={18} /><span>外观设置未保存：{appearance.error}</span><button type="button" className="button secondary" onClick={() => openSettings('appearance')}>查看外观设置</button></div>}
        {!initialized ? <div className="loading-state"><LoaderCircle className="spin" size={25} /><p>正在读取本地商品资料…</p></div>
          : view === 'inbox' ? <InboxPage products={products} placements={placements} busy={Boolean(busy)} onImport={importProducts} onExamples={() => loadWorkspaceExamples('inbox')} onMove={moveProducts} onChanged={refreshProducts} onOpenSettings={() => openSettings('collection')} />
          : view === 'automatic' ? <AutomaticPage allProducts={products} onShipping={openShipping} products={automaticProducts} targets={amazonTargets} busy={Boolean(busy)} onExamples={() => loadWorkspaceExamples('automatic')} onInbox={() => navigate('inbox')} onSettings={openSettings} onManual={(id, draftId, context) => openProduct(id, draftId ? 'checks' : context?.variantId ? 'variants' : 'info', draftId, context)} />
          : view === 'results' ? <ResultsPage products={products} drafts={resultDrafts} busy={Boolean(busy)} run={perform} onRefresh={() => { void perform('正在刷新上架记录…', refreshResults); }} onOpen={(id, draftId) => openProduct(id, 'checks', draftId)} />
          : view === 'product-data' ? <ProductDataPage targets={amazonTargets} busy={Boolean(busy)} onOpen={id => openProduct(id)} onProcurement={context => { setProcurementContext(context); navigate('procurement'); }} onSettings={() => openSettings('amazon')} />
          : view === 'procurement' || view === 'shipping' || view === 'catalog' ? <OperationsPage key={view} section={view} initialProcurementContext={view === 'procurement' ? procurementContext : undefined} initialBatchId={view === 'shipping' ? shippingBatchId : undefined} targets={amazonTargets} busy={Boolean(busy)} run={perform} guarded={guarded} registerGuard={registerAmazonGuard} onDirtyChange={setAmazonDirty} onShipping={openShipping} onProcurement={() => navigate('procurement')} />

          : view === 'manual' ? <div className="manual-workspace"><WorkflowRail mode="manual" tab={tab} step={workflowRequest?.step} busy={Boolean(busy)} onSelect={(next, step) => { if (product) guarded(() => { setTab(next); setWorkflowRequest({ step, token: Date.now() }); }); }} />
            {product || manualProducts.length > 0 ? <div className="workbench-layout"><ProductList products={manualProducts} selectedId={product?.id} busy={Boolean(busy)} onSelect={selectProduct} />
              {product ? <ProductEditor problemContext={returnTo?.context} onReturnToSource={returnTo ? returnToSource : undefined} focusVariantId={returnTo?.context?.variantId} product={product} tab={tab} initialDraftId={initialDraftId} workflowRequest={workflowRequest} dirty={dirty} busy={Boolean(busy)} readiness={readiness} onImageSettings={() => openSettings('images')} onTabChange={nextTab => { if (nextTab !== tab) guarded(() => { setTab(nextTab); setWorkflowRequest(null); }); }} onChange={changeProduct} onSave={() => { void saveDraft(); }} onExport={exportProduct} onImportImages={importImages} onUpdateAsset={updateAsset} onCheck={checkProduct} amazonTargets={amazonTargets} run={perform} guarded={guarded} registerGuard={registerAmazonGuard} onAmazonDirtyChange={setAmazonDirty} onTargetsChanged={refreshAmazonTargets} />
                : <div className="select-product-empty"><Box size={35} strokeWidth={1.2} /><h2>选择一件商品</h2><p>从左侧列表打开商品资料。</p></div>}
            </div> : <EmptyWorkspace onCreate={createProduct} onImport={importProducts} busy={Boolean(busy)} />}
          </div>
          : view === 'audit' ? <AuditView events={audit} products={products} busy={Boolean(busy)} onRefresh={() => { void perform('正在刷新记录…', async () => setAudit(await api.listAudit())); }} />
          : settings ? <SettingsView settings={settings} targets={amazonTargets} run={perform} onTargetsChanged={refreshAmazonTargets} appearance={appearance} request={settingsRequest} guarded={guarded} busy={Boolean(busy)} onOpenFolder={() => { void perform('正在打开数据文件夹…', () => api.openDataFolder()); }} /> : null}
      </main>
      <div className={`activity-bar ${busy ? 'working' : ''}`} role="status">{busy ? <><LoaderCircle size={13} className="spin" /><span>{busy}</span></> : <><span className="live-dot" /><span>资料自动保留在本机</span></>}<span className="activity-right">HTC / {viewLabels[view]}</span></div>
    </div>
    {toast && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span><button type="button" className="icon-button small" aria-label="关闭成功提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
    {showGuard && <UnsavedDialog busy={Boolean(busy) || guardSaving} error={error} onCancel={cancelGuard} onSave={() => { void continueAfterSave(); }} onDiscard={continueAfterDiscard} />}
  </div></div></GuardedNavigationContext.Provider></FormGuardContext.Provider></NavigationMemoryContext.Provider>;
}

function EmptyWorkspace({ onCreate, onImport, busy }: { onCreate: () => void; onImport: () => void; busy: boolean }) {
  return <section className="empty-workspace"><div className="empty-workspace-art" aria-hidden="true"><div className="paper-sheet back"><span /><span /><span /></div><div className="paper-sheet front"><div className="paper-image"><Box size={36} strokeWidth={1.2} /></div><div className="paper-lines"><span /><span /></div><div className="paper-sku">SKU</div><div className="paper-check"><CheckCircle2 size={22} /></div></div></div><span className="empty-eyebrow">你的商品资料，从这里开始</span><h2>把商品资料整理在一起</h2><p>新建一件商品，或导入已有的 JSON / CSV 资料。<br />独立维护每个 SKU 的规格、采购价、库存和图片。</p><div className="empty-actions"><button type="button" className="button primary" disabled={busy} onClick={onCreate}><Plus size={17} />创建第一件商品</button><button type="button" className="button secondary" disabled={busy} onClick={onImport}><FileInput size={16} />导入 JSON / CSV</button></div><div className="empty-workspace-note"><ShieldCheck size={14} />原始来源保留在本机，编辑内容随时可查</div></section>;
}

function UnsavedDialog({ busy, error, onCancel, onSave, onDiscard }: { busy: boolean; error: string | null; onCancel: () => void; onSave: () => void; onDiscard: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div ref={dialogRef} className="unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-title" aria-describedby="unsaved-description" onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); }
    if (event.key === 'Tab') {
      const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if (!buttons?.length) { event.preventDefault(); return; }
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}><div className="dialog-icon"><AlertCircle size={24} /></div><h2 id="unsaved-title">有未保存的修改</h2><p id="unsaved-description">保存当前表单的修改后再继续，或返回编辑。选择放弃修改会恢复到上次保存的内容。</p>{error && <p className="dialog-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button danger-quiet" disabled={busy} onClick={onDiscard}>放弃修改</button><div><button ref={cancelRef} type="button" className="button secondary" disabled={busy} onClick={onCancel}>继续编辑</button><button type="button" className="button primary" disabled={busy} onClick={onSave}>{busy ? <LoaderCircle className="spin" size={15} /> : null}保存后继续</button></div></div></div></div>;
}
