import type { AutomaticWorkBatch } from '../shared/automatic-work-batches';
import { usePageState } from './navigation-context';
import type { ProblemContext } from './navigation-context';
import { FileCheck2, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProductSummary } from '../shared/contracts';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { AutomaticListingQueue } from '../shared/automatic-listing-contracts';
import { productGaps } from './workspace-model';
import { AutomaticPreparationPanel } from './AutomaticPreparationPanel';
import type { SettingsModule } from './settings-navigation';

interface Props { allProducts?:ProductSummary[]; products: ProductSummary[]; targets: AmazonTarget[]; busy: boolean; onExamples: () => void; onInbox: () => void; onSettings: (module?: SettingsModule) => void; onManual: (id: string, draftId?: string, context?: ProblemContext) => void; onShipping?: (batchId: string) => void }
export function AutomaticPage({ products: laneProducts, allProducts, targets, busy, onExamples, onInbox, onSettings, onManual, onShipping }: Props) {
  const [batches,setBatches]=useState<AutomaticWorkBatch[]>([]),[batchId,setBatchId]=usePageState('automatic:work-batch','');
  const [batchError,setBatchError]=useState(''),[batchBusy,setBatchBusy]=useState(false),[addId,setAddId]=useState('');
  const current=batches.find(batch=>!batch.archivedAt),selectedBatch=batches.find(batch=>batch.id===batchId)??current;
  const products=(allProducts??laneProducts).filter(product=>selectedBatch?.productIds.includes(product.id));
  const [targetId, setTargetId] = usePageState('automatic:target', ''), [queue, setQueue] = useState<AutomaticListingQueue | null>(null);
  const [queueLoading, setQueueLoading] = useState(false), [queueError, setQueueError] = useState(''), [queueReload, setQueueReload] = useState(0);
  const queueFlight=useRef<Promise<AutomaticListingQueue>|null>(null);
  const batchKey=JSON.stringify(laneProducts.map(p=>p.id));
  useEffect(()=>{let active=true;void window.red.listAutomaticWorkBatches().then(values=>{if(active){setBatches(values);setBatchError('');}},error=>{if(active)setBatchError(String(error));});return()=>{active=false;};},[queueReload,batchKey]);
  async function archive(){if(!current||batchBusy)return;setBatchBusy(true);setBatchError('');try{const next=await window.red.archiveAutomaticWorkBatch(current.id);setBatchId(next.id);setQueue(null);setBatches(await window.red.listAutomaticWorkBatches());setQueueReload(v=>v+1);}catch(error){setBatchError(String(error));}finally{setBatchBusy(false);}}
  async function addProducts(ids:string[]){if(!current||!ids.length||batchBusy)return;setBatchBusy(true);setBatchError('');try{await window.red.addAutomaticWorkBatchProducts({batchId:current.id,productIds:ids});setBatches(await window.red.listAutomaticWorkBatches());setBatchId(current.id);setAddId('');setQueueReload(v=>v+1);}catch(error){setBatchError(String(error));}finally{setBatchBusy(false);}}
  const productsKey = JSON.stringify(products.map(product => [product.id, product.updatedAt]));
  useEffect(() => { const update = () => setQueueReload(value => value + 1); window.addEventListener('automatic-listing-changed', update); return () => window.removeEventListener('automatic-listing-changed', update); }, []);
  useEffect(() => {
    let active = true; setQueue(null);setQueueError(''); setQueueLoading(Boolean(targetId)&&products.length>0);
    if(targetId&&products.length)void(async()=>{
      if(queueFlight.current)await queueFlight.current.catch(()=>{});
      if(!active)return;
      const flight=window.red.getAutomaticListingQueue({productIds:products.map(product=>product.id),targetId});queueFlight.current=flight;
      try{const value=await flight;if(active)setQueue(value);}catch(error){if(active)setQueueError(error instanceof Error?error.message:'队列读取失败');}
      finally{if(queueFlight.current===flight)queueFlight.current=null;if(active)setQueueLoading(false);}
    })();
    return () => { active = false; };
  }, [targetId, productsKey, queueReload, selectedBatch?.id]);
  const currentQueue = queue?.targetId === targetId ? queue : null;
  return <div className="automatic-workspace">
    <section className="amazon-workflow automatic-work-batches" aria-label="工作批次">
      <div className="workflow-actions automatic-work-batch-controls"><label className="field"><span>工作批次</span><select aria-label="选择工作批次" value={selectedBatch?.id??''} disabled={batchBusy} onChange={e=>{setBatchId(e.target.value);setQueue(null);}}>{batches.map(batch=><option key={batch.id} value={batch.id}>{batch.name}{batch.archivedAt?' · 已归档':' · 当前'}</option>)}</select></label>
      <button type="button" className="button secondary" disabled={busy||batchBusy||!current||selectedBatch?.id!==current.id} onClick={()=>void archive()}>{batchBusy?'正在处理…':'归档当前批次并新建空批次'}</button></div>
      <p className="small-copy">归档会先暂停本地后续调度，等待本地处理停止；远端在途请求保留。商品、原任务、图片、费用和 SKU 不变，历史任务可继续。</p>
      <p className="small-copy">左侧数量含历史商品；本批次商品数量见下方。</p>
      {selectedBatch?.archivedAt?<button type="button" className="button secondary" disabled={batchBusy||!products.length} onClick={()=>void addProducts(products.map(product=>product.id))}>将本批商品加入当前批次</button>:<div className="workflow-actions automatic-work-batch-controls"><select aria-label="加入当前批次的商品" value={addId} disabled={batchBusy} onChange={e=>setAddId(e.target.value)}><option value="">选择已有商品加入当前批次</option>{(allProducts??laneProducts).filter(p=>!selectedBatch?.productIds.includes(p.id)).map(p=><option key={p.id} value={p.id}>{p.title||'未命名商品'}</option>)}</select><button type="button" className="button secondary" disabled={batchBusy||!addId} onClick={()=>void addProducts([addId])}>加入当前批次</button></div>}
      {!!selectedBatch&&selectedBatch.productIds.length>products.length&&<p className="small-copy" role="status">本批有 {selectedBatch.productIds.length-products.length} 件来源资料当前不可用；原批次引用和任务历史仍保留，可用商品可加入当前批次。</p>}
      {batchError&&<p role="alert">{batchError}</p>}
    </section>
    <div className="workspace-metrics automatic-overview" aria-label="自动上架准备概况"><div><span>来源商品</span><strong>{products.length}<small>件</small></strong></div><div><span>来源规格</span><strong>{products.reduce((sum, product) => sum + product.variantCount, 0)}<small>个</small></strong></div><div><span>待补基础资料</span><strong>{products.filter(product => productGaps(product).length > 0).length}<small>件</small></strong></div></div>
    <AutomaticPreparationPanel key={selectedBatch?.id??"loading"} workBatchId={selectedBatch?.id} taskIds={selectedBatch?.taskIds??[]} archived={!!selectedBatch?.archivedAt} products={products} taskProducts={products} targets={targets} targetId={targetId} onTargetChange={setTargetId} queue={currentQueue} queueLoading={queueLoading} queueError={queueError} onRefreshQueue={() => setQueueReload(value => value + 1)} busy={busy||batchBusy||!selectedBatch} onManual={onManual} onSettings={onSettings} onExamples={onExamples} onInbox={onInbox} onShipping={onShipping}/>
    <details className="automation-details"><summary><span><FileCheck2 size={17}/>自动化步骤与检查范围</span><ChevronDown className="disclosure-chevron" size={16}/></summary><div className="automation-detail-grid"><section><strong>资料与 SKU</strong><p>来源规格完整保留。按商品规则生成销售配方，文案与图片按 SKU 独立准备；单个规格异常不影响其他健康规格。</p></section><section><strong>图片与复核</strong><p>每个 SKU 规划七张图。有可靠来源尺寸时加入尺寸图。开启风险检测时全部图片检查侵权；仅第一张主图检查无字，主图文字问题初始最多三次尝试；符合条件的失败图位可追加3次，历史和已通过图片保留。</p></section><section><strong>提交与回读</strong><p>按授权提交后等待平台回读并建立备货批次；标签在需要备货或打印时单独准备。结果未知时先核对，不自动重发；平台接受提交不等于已可售。</p></section></div></details>
  </div>;
}
