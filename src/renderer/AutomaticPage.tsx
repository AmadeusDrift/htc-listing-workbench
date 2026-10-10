import { automaticQueueReason } from './automatic-product-groups';
import { presentRejection } from '../shared/rejection-presentation';
import { ArrowRight, ChevronDown, FileCheck2, ImageUp, Layers3, ListChecks, PackageOpen, Search, Settings2, WandSparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProductSummary } from '../shared/contracts';
import type { AmazonTarget } from '../shared/amazon-contracts';
import { PreparationStep, WorkflowRail } from './WorkflowRail';
import { productGaps } from './workspace-model';
import { ProductThumb, WorkspaceEmpty } from './WorkspaceParts';
import { sourceLabel } from './utils';
import { AutomaticPreparationPanel } from './AutomaticPreparationPanel';
import type { SettingsModule } from './settings-navigation';
import type { AutomaticListingQueue, AutomaticQueueRow } from '../shared/automatic-listing-contracts';

interface Props { products: ProductSummary[]; targets: AmazonTarget[]; busy: boolean; onExamples: () => void; onInbox: () => void; onSettings: (module?: SettingsModule) => void; onManual: (id: string, draftId?: string) => void; onShipping?: (batchId: string) => void }
export function AutomaticPage({ products, targets, busy, onExamples, onInbox, onSettings, onManual, onShipping }: Props) {
  const [preparing, setPreparing] = useState(false);
  const [targetId,setTargetId]=useState(''),[queue,setQueue]=useState<AutomaticListingQueue|null>(null),[queueLoading,setQueueLoading]=useState(false),[queueError,setQueueError]=useState(''),[queueReload,setQueueReload]=useState(0);
  const [queueTab,setQueueTab]=useState<'pending'|'filtered'|'repair'|'submitted'>('pending');
  const [reasonSearch,setReasonSearch]=useState('');
  const productsKey=JSON.stringify(products.map(p=>[p.id,p.updatedAt]));
  useEffect(()=>{const update=()=>setQueueReload(value=>value+1);window.addEventListener('automatic-listing-changed',update);return()=>window.removeEventListener('automatic-listing-changed',update);},[]);
  useEffect(()=>{
    let active=true;setQueueError('');setQueueLoading(Boolean(targetId));
    if(targetId)void window.red.getAutomaticListingQueue({productIds:products.map(p=>p.id),targetId}).then(value=>{if(active)setQueue(value);},error=>{if(active)setQueueError(error instanceof Error?error.message:'队列读取失败');}).finally(()=>{if(active)setQueueLoading(false);});
    return()=>{active=false;};
  },[targetId,productsKey,queueReload]);
  const currentQueue=queue?.targetId===targetId?queue:null;
  const queueProducts=currentQueue?.products??[];
  const queueReason=automaticQueueReason;
  const reasonQuery=reasonSearch.trim().toLocaleLowerCase(),matchesReason=(message:string)=>!reasonQuery||message.toLocaleLowerCase().includes(reasonQuery);
  const rowInTab=(row:AutomaticQueueRow,tab:typeof queueTab)=>tab==='filtered'?row.kind==='RULE_FILTERED':tab==='repair'?['SYSTEM_REPAIR','NEEDS_INPUT','UNKNOWN','UNCLASSIFIED'].includes(row.kind):tab==='submitted'?['SUBMITTED','COMPLETED'].includes(row.kind):!['RULE_FILTERED','SUBMITTED','COMPLETED'].includes(row.kind);
  const inTab=(productId:string,tab:typeof queueTab,search=false)=>{const projection=queueProducts.find(p=>p.productId===productId);return Boolean(projection?.inputIssue&&(tab==='pending'||tab==='repair')&&(!search||matchesReason(presentRejection('SOURCE_INPUT_REQUIRED'))))||Boolean(projection?.rows.some(row=>rowInTab(row,tab)&&(!search||matchesReason(queueReason(row)))));};
  const visibleProducts=currentQueue?products.filter(p=>inTab(p.id,queueTab,true)):products;
  const matchingRecipes=queueProducts.flatMap(p=>p.rows).filter(row=>rowInTab(row,queueTab)&&matchesReason(queueReason(row))).length;
  const preparationProducts=currentQueue?products.filter(p=>inTab(p.id,'pending')):products;
  const disabled = busy || preparing;
  const configured = targets.some(target => target.configured && !target.paused);
  const missing = products.filter(product => productGaps(product).length > 0).length;
  return <div className="automatic-workspace">
    <WorkflowRail mode="automatic" />
    <div className="workspace-metrics" aria-label="自动上架准备概况"><div><span>来源商品链接</span><strong>{products.length}<small>件</small></strong></div><div><span>来源规格</span><strong>{products.reduce((sum, product) => sum + product.variantCount, 0)}<small>个</small></strong></div><div><span>待补基础资料</span><strong>{missing}<small>件</small></strong></div><div className="metric-policy"><WandSparkles size={22} /><div><strong>自动文案与图片</strong><span>按 SKU 准备、复核与采用</span></div></div></div>
    <AutomaticPreparationPanel products={preparationProducts} taskProducts={products} targets={targets} targetId={targetId} onTargetChange={setTargetId} queue={currentQueue} queueLoading={queueLoading} queueError={queueError} onRefreshQueue={()=>setQueueReload(value=>value+1)} busy={busy} onManual={onManual} onSettings={onSettings} onRunningChange={setPreparing} onShipping={onShipping} />
    <div className="automatic-layout">
      <section className="automatic-queue"><header className="workspace-section-heading"><div><span className="section-kicker">准备工作区</span><h2>{queueTab==='filtered'?'规则淘汰':queueTab==='repair'?'待修复与核对':queueTab==='submitted'?'已提交与完成':'待上架商品'} <span>{visibleProducts.length}</span></h2></div><button type="button" className="button secondary" onClick={onExamples} disabled={disabled}><PackageOpen size={16} />载入本地示例</button><button type="button" className="button secondary" onClick={onInbox} disabled={disabled}>从采集箱选择<ArrowRight size={15} /></button></header>
        <div className="workflow-actions" role="tablist" aria-label="自动上架结果分类">{([['pending','待上架'],['filtered','规则淘汰'],['repair','待修复与核对'],['submitted','已提交与完成']] as const).map(([key,label])=><button type="button" role="tab" aria-selected={queueTab===key} className="button secondary" key={key} onClick={()=>setQueueTab(key)}>{label} {currentQueue?products.filter(p=>inTab(p.id,key,true)).length:key==='pending'?products.length:0}</button>)}</div>
        <div className="workflow-actions"><label className="automatic-group-search"><Search size={16}/><input type="search" aria-label="搜索原因" placeholder="搜索原因，如 ROI、IP、下载" value={reasonSearch} disabled={!currentQueue} onChange={event=>setReasonSearch(event.target.value)}/></label>{reasonSearch&&<button type="button" className="text-button" onClick={()=>setReasonSearch('')}>清除原因搜索</button>}</div>
        {reasonQuery&&currentQueue&&<><p className="small-copy">原因匹配：{visibleProducts.length} 个来源商品 · {matchingRecipes} 个销售配方</p><p className="small-copy">仅筛选下方原因记录，上方已选商品和可启动数量保持不变。</p></>}
        {!targetId&&<p className="small-copy">选择目标店铺后显示该店铺的销售配方和处理结果。</p>}
        {queueError&&<p className="workflow-notice" role="alert">{queueError}；商品保留，请刷新后再启动。</p>}
        {visibleProducts.length ? <div className="automatic-products">{visibleProducts.map(product => {
          const gaps = productGaps(product);
          const projection=queueProducts.find(p=>p.productId===product.id);
          return <details key={product.id} className="automatic-product" data-testid={`automatic-${product.id}`}><summary><ProductThumb product={product} /><span className="automatic-product-identity"><strong>{product.title || '未命名商品'}</strong><small>{product.origin === 'sample' ? <span className="sample-tag">本地示例</span> : sourceLabel(product.sourceUrl)} · {product.variantCount} 个来源规格 · {product.assetCount} 张图</small>{projection&&<small>可启动销售配方 {projection.eligibleCount} · 规则淘汰 {projection.filteredCount}</small>}</span><span className={`quiet-pill ${gaps.length ? 'attention' : ''}`}>{gaps.length ? '待补资料' : '待准备'}</span><ChevronDown className="disclosure-chevron" size={17} /></summary><div className="automatic-product-body"><div className="inline-explanation"><ListChecks size={18} /><p>{gaps.length ? `还需要补充：${gaps.join('、')}。` : '已有基础商品资料。发布前还需核对类目、报价、图片和资格要求。'}</p></div>{projection?.inputIssue&&(!reasonQuery||matchesReason(presentRejection('SOURCE_INPUT_REQUIRED')))&&<p className="workflow-notice">{presentRejection('SOURCE_INPUT_REQUIRED')}</p>}{projection?.rows.filter(r=>r.message&&(!reasonQuery||rowInTab(r,queueTab)&&matchesReason(queueReason(r)))).map(row=><p className="workflow-notice" key={row.key}>{row.specification}：{queueReason(row)}</p>)}<div className="automatic-product-facts"><span><Layers3 size={16} />{product.variantCount} 个来源规格完整保留</span><span><ImageUp size={16} />{product.assetCount} 张本地图片</span></div><button type="button" className="button secondary" disabled={disabled} onClick={() => onManual(product.id)}>转手动补充资料<ArrowRight size={15} /></button></div></details>;
        })}</div> : reasonQuery?<WorkspaceEmpty title="没有匹配的原因" description="调整原因关键词，或清除搜索查看当前分类的全部记录。"/>:<WorkspaceEmpty title="把准备好的商品放进来" description="在采集箱选择商品并加入自动上架，商品资料和处理去向都会保存。"><button type="button" className="button primary" onClick={onInbox} disabled={disabled}>前往采集箱<ArrowRight size={16} /></button></WorkspaceEmpty>}
      </section>
      <aside className="automation-setup" aria-label="自动上架准备条件"><header><span className="setup-icon"><Settings2 size={20} /></span><div><h2>执行准备</h2><p>先确认目标和全局连接</p></div></header><PreparationStep label="目标店铺" detail={configured ? '已有启用目标，可在上方选择正式店铺或本地演示。' : '在设置中配置店铺授权或启用演示。'} available={configured} /><PreparationStep label="文案、图片与文字复核" detail="在上方检查全局连接后，按 SKU 自动读取事实与参考图。失败项保留原因。" available /><PreparationStep label="自动发布与标签" detail="确认一次执行范围，后台连续提交、回读并准备商品标签。仅异常需要人工处理。" available /><button type="button" className="text-button" onClick={() => onSettings('amazon')} disabled={disabled}>管理店铺连接<ArrowRight size={14} /></button><button type="button" className="text-button" onClick={() => onSettings('hosting')} disabled={disabled}>管理图片托管<ArrowRight size={14} /></button></aside>
    </div>
    <details className="automation-details"><summary><span><FileCheck2 size={17} />自动化步骤说明</span><span>默认收起执行细节<ChevronDown className="disclosure-chevron" size={16} /></span></summary><div className="automation-detail-grid"><section><strong>资料与 SKU</strong><p>来源资料完整保留，按来源顺序与全局规则选取变体。自动读取该 SKU 已确认的事实和参考图，准备文案并独立复核。</p></section><section><strong>自动出图与文字复核</strong><p>DeepSeek 先规划整套七图：无字场景主图、带文字的单卖点图，有可靠来源尺寸时加入一张尺寸图，卖点不足以场景图补齐。所有生成图检查 IP 风险；只对第一张主图做 OCR 和无字检查，其余图片不检查文字。已通过图片保留，主图文字问题最多三次尝试。</p></section><section><strong>提交、回读与标签</strong><p>图片上传和验证通过后自动提交。平台回读满足条件后生成备货单，按销售单位数量取得商品标签。异常原因保留在任务中，可处理后继续。</p></section></div></details>
  </div>;
}
