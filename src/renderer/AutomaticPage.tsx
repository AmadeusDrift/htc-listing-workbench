import { FileCheck2, ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProductSummary } from '../shared/contracts';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { AutomaticListingQueue } from '../shared/automatic-listing-contracts';
import { productGaps } from './workspace-model';
import { AutomaticPreparationPanel } from './AutomaticPreparationPanel';
import type { SettingsModule } from './settings-navigation';

interface Props { products: ProductSummary[]; targets: AmazonTarget[]; busy: boolean; onExamples: () => void; onInbox: () => void; onSettings: (module?: SettingsModule) => void; onManual: (id: string, draftId?: string) => void; onShipping?: (batchId: string) => void }
export function AutomaticPage({ products, targets, busy, onExamples, onInbox, onSettings, onManual, onShipping }: Props) {
  const [targetId, setTargetId] = useState(''), [queue, setQueue] = useState<AutomaticListingQueue | null>(null);
  const [queueLoading, setQueueLoading] = useState(false), [queueError, setQueueError] = useState(''), [queueReload, setQueueReload] = useState(0);
  const productsKey = JSON.stringify(products.map(product => [product.id, product.updatedAt]));
  useEffect(() => { const update = () => setQueueReload(value => value + 1); window.addEventListener('automatic-listing-changed', update); return () => window.removeEventListener('automatic-listing-changed', update); }, []);
  useEffect(() => {
    let active = true; setQueueError(''); setQueueLoading(Boolean(targetId));
    if (targetId) void window.red.getAutomaticListingQueue({ productIds: products.map(product => product.id), targetId }).then(value => { if (active) setQueue(value); }, error => { if (active) setQueueError(error instanceof Error ? error.message : '队列读取失败'); }).finally(() => { if (active) setQueueLoading(false); });
    return () => { active = false; };
  }, [targetId, productsKey, queueReload]);
  const currentQueue = queue?.targetId === targetId ? queue : null;
  return <div className="automatic-workspace">
    <div className="workspace-metrics automatic-overview" aria-label="自动上架准备概况"><div><span>来源商品</span><strong>{products.length}<small>件</small></strong></div><div><span>来源规格</span><strong>{products.reduce((sum, product) => sum + product.variantCount, 0)}<small>个</small></strong></div><div><span>待补基础资料</span><strong>{products.filter(product => productGaps(product).length > 0).length}<small>件</small></strong></div></div>
    <AutomaticPreparationPanel products={products} taskProducts={products} targets={targets} targetId={targetId} onTargetChange={setTargetId} queue={currentQueue} queueLoading={queueLoading} queueError={queueError} onRefreshQueue={() => setQueueReload(value => value + 1)} busy={busy} onManual={onManual} onSettings={onSettings} onExamples={onExamples} onInbox={onInbox} onShipping={onShipping}/>
    <details className="automation-details"><summary><span><FileCheck2 size={17}/>自动化步骤与检查范围</span><ChevronDown className="disclosure-chevron" size={16}/></summary><div className="automation-detail-grid"><section><strong>资料与 SKU</strong><p>来源规格完整保留。按商品规则生成销售配方，文案与图片按 SKU 独立准备；单个规格异常不影响其他健康规格。</p></section><section><strong>图片与复核</strong><p>每个 SKU 规划七张图。有可靠来源尺寸时加入尺寸图。开启风险检测时全部图片检查侵权；仅第一张主图检查无字，主图文字问题最多三次尝试。已通过图片保留。</p></section><section><strong>提交与回读</strong><p>按授权提交后等待平台回读，再准备备货与标签。结果未知时先核对，不自动重发；平台接受提交不等于已可售。</p></section></div></details>
  </div>;
}
