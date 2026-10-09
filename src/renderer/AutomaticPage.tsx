import { ArrowRight, ChevronDown, FileCheck2, ImageUp, Layers3, ListChecks, PackageOpen, Settings2, WandSparkles } from 'lucide-react';
import { useState } from 'react';
import type { ProductSummary } from '../shared/contracts';
import type { AmazonTarget } from '../shared/amazon-contracts';
import { PreparationStep, WorkflowRail } from './WorkflowRail';
import { productGaps } from './workspace-model';
import { ProductThumb, WorkspaceEmpty } from './WorkspaceParts';
import { sourceLabel } from './utils';
import { AutomaticPreparationPanel } from './AutomaticPreparationPanel';
import type { SettingsModule } from './settings-navigation';

interface Props { products: ProductSummary[]; targets: AmazonTarget[]; busy: boolean; onExamples: () => void; onInbox: () => void; onSettings: (module?: SettingsModule) => void; onManual: (id: string, draftId?: string) => void; onShipping?: (batchId: string) => void }
export function AutomaticPage({ products, targets, busy, onExamples, onInbox, onSettings, onManual, onShipping }: Props) {
  const [preparing, setPreparing] = useState(false);
  const disabled = busy || preparing;
  const configured = targets.some(target => target.configured && !target.paused);
  const missing = products.filter(product => productGaps(product).length > 0).length;
  return <div className="automatic-workspace">
    <WorkflowRail mode="automatic" />
    <div className="workspace-metrics" aria-label="自动上架准备概况"><div><span>来源商品链接</span><strong>{products.length}<small>件</small></strong></div><div><span>来源规格</span><strong>{products.reduce((sum, product) => sum + product.variantCount, 0)}<small>个</small></strong></div><div><span>待补基础资料</span><strong>{missing}<small>件</small></strong></div><div className="metric-policy"><WandSparkles size={22} /><div><strong>自动文案与图片</strong><span>按 SKU 准备、复核与采用</span></div></div></div>
    <AutomaticPreparationPanel products={products} targets={targets} busy={busy} onManual={onManual} onSettings={onSettings} onRunningChange={setPreparing} onShipping={onShipping} />
    <div className="automatic-layout">
      <section className="automatic-queue"><header className="workspace-section-heading"><div><span className="section-kicker">准备工作区</span><h2>待上架商品 <span>{products.length}</span></h2></div><button type="button" className="button secondary" onClick={onExamples} disabled={disabled}><PackageOpen size={16} />载入本地示例</button><button type="button" className="button secondary" onClick={onInbox} disabled={disabled}>从采集箱选择<ArrowRight size={15} /></button></header>
        {products.length ? <div className="automatic-products">{products.map(product => {
          const gaps = productGaps(product);
          return <details key={product.id} className="automatic-product" data-testid={`automatic-${product.id}`}><summary><ProductThumb product={product} /><span className="automatic-product-identity"><strong>{product.title || '未命名商品'}</strong><small>{product.origin === 'sample' ? <span className="sample-tag">本地示例</span> : sourceLabel(product.sourceUrl)} · {product.variantCount} 个来源规格 · {product.assetCount} 张图</small></span><span className={`quiet-pill ${gaps.length ? 'attention' : ''}`}>{gaps.length ? '待补资料' : '待准备'}</span><ChevronDown className="disclosure-chevron" size={17} /></summary><div className="automatic-product-body"><div className="inline-explanation"><ListChecks size={18} /><p>{gaps.length ? `还需要补充：${gaps.join('、')}。` : '已有基础商品资料。发布前还需核对类目、报价、图片和资格要求。'}</p></div><div className="automatic-product-facts"><span><Layers3 size={16} />{product.variantCount} 个来源规格完整保留</span><span><ImageUp size={16} />{product.assetCount} 张本地图片</span></div><button type="button" className="button secondary" disabled={disabled} onClick={() => onManual(product.id)}>转手动补充资料<ArrowRight size={15} /></button></div></details>;
        })}</div> : <WorkspaceEmpty title="把准备好的商品放进来" description="在采集箱选择商品并加入自动上架，商品资料和处理去向都会保存。"><button type="button" className="button primary" onClick={onInbox} disabled={disabled}>前往采集箱<ArrowRight size={16} /></button></WorkspaceEmpty>}
      </section>
      <aside className="automation-setup" aria-label="自动上架准备条件"><header><span className="setup-icon"><Settings2 size={20} /></span><div><h2>执行准备</h2><p>先确认目标和全局连接</p></div></header><PreparationStep label="目标店铺" detail={configured ? '已有启用目标，可在上方选择正式店铺或本地演示。' : '在设置中配置店铺授权或启用演示。'} available={configured} /><PreparationStep label="文案、图片与文字复核" detail="在上方检查全局连接后，按 SKU 自动读取事实与参考图。失败项保留原因。" available /><PreparationStep label="自动发布与标签" detail="确认一次执行范围，后台连续提交、回读并准备商品标签。仅异常需要人工处理。" available /><button type="button" className="text-button" onClick={() => onSettings('amazon')} disabled={disabled}>管理店铺连接<ArrowRight size={14} /></button><button type="button" className="text-button" onClick={() => onSettings('hosting')} disabled={disabled}>管理图片托管<ArrowRight size={14} /></button></aside>
    </div>
    <details className="automation-details"><summary><span><FileCheck2 size={17} />自动化步骤说明</span><span>默认收起执行细节<ChevronDown className="disclosure-chevron" size={16} /></span></summary><div className="automation-detail-grid"><section><strong>资料与 SKU</strong><p>来源资料完整保留，按来源顺序与全局规则选取变体。自动读取该 SKU 已确认的事实和参考图，准备文案并独立复核。</p></section><section><strong>自动出图与文字复核</strong><p>DeepSeek 先规划整套七图：无字场景主图、带文字的单卖点图，有可靠来源尺寸时加入一张尺寸图，卖点不足以场景图补齐。所有生成图检查 IP 风险；只对第一张主图做 OCR 和无字检查，其余图片不检查文字。已通过图片保留，主图文字问题最多三次尝试。</p></section><section><strong>提交、回读与标签</strong><p>图片上传和验证通过后自动提交。平台回读满足条件后生成备货单，按销售单位数量取得商品标签。异常原因保留在任务中，可处理后继续。</p></section></div></details>
  </div>;
}
