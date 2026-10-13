import { useFormGuard } from './FormGuard';
import { useEffect, useRef, useState } from 'react';
import { Calculator, SlidersHorizontal } from 'lucide-react';
import { parseListingRules } from '../shared/listing-rules';
import type { ListingRules, PricingRules, ProductRules } from '../shared/listing-rules';
import type { AmazonTarget } from '../shared/amazon-contracts';
import type { TaskRunner } from './amazon-ui';
import { errorText } from './utils';

function NumberField({ label, value, onChange, unit, step = 'any' }: { label: string; value: number; onChange: (value: number) => void; unit?: string; step?: string }) {
  return <label className="field"><span>{label}{unit && <small className="rule-unit">{unit}</small>}</span><input type="number" step={step} value={Number.isNaN(value) ? '' : value} onChange={event => onChange(event.target.value === '' ? NaN : Number(event.target.value))} /></label>;
}
export function ListingRulesSettings({ section, busy, run, targets }: { section: 'product' | 'pricing'; busy: boolean; run: TaskRunner; targets: AmazonTarget[] }) {
  const [rules, setRules] = useState<ListingRules | null>(null), [dirty, setDirty] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [shopCode, setShopCode] = useState(''), [manufacturer, setManufacturer] = useState('');
  const savedRules = useRef<ListingRules | null>(null);
  const [sizes, setSizes] = useState('');
  useEffect(() => { let current = true; void window.red.getListingRules().then(value => { if (current) { savedRules.current = value; setRules(value); setSizes(value.pricing.bundleSizes.join(', ')); } }).catch(error => { if (current) setError(errorText(error)); }); return () => { current = false; }; }, []);
  useEffect(() => { if (!dirty) return; const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty]);
  function product(change: Partial<ProductRules>) { setRules(value => value && ({ ...value, product: { ...value.product, ...change } })); setDirty(true); setNotice(''); }
  function pricing(change: Partial<PricingRules>) { setRules(value => value && ({ ...value, pricing: { ...value.pricing, ...change } })); setDirty(true); setNotice(''); }
  async function save() {
    if (!rules) return false;
    if (shopCode || manufacturer) { setError('请先添加或清空正在填写的店铺规则，再保存。'); return false; }
    let success = false;
    try {
      const next = parseListingRules({ ...rules, pricing: { ...rules.pricing, bundleSizes: sizes.split(/[,，\s]+/).filter(Boolean).map(Number) } });
      await run('正在保存商品与定价规则…', async () => { const saved = await window.red.saveListingRules(next); savedRules.current = saved; success = true; setRules(saved); setDirty(false); setError(''); setNotice(`规则版本 ${saved.revision} 已保存。新准备的草稿会使用此设置。`); });
    } catch (cause) { setError(errorText(cause)); }
    return success;
  }
  useFormGuard({ dirty: () => dirty || !!shopCode || !!manufacturer, save, discard: () => { const saved = savedRules.current; if (saved) { setRules(saved); setSizes(saved.pricing.bundleSizes.join(', ')); } setDirty(false); setShopCode(''); setManufacturer(''); setError(''); } });
  if (!rules) return <section className="settings-section"><p role="status">{error || '正在读取规则…'}</p></section>;
  const p = rules.product, r = rules.pricing;
  const amount = (key: keyof PricingRules, label: string, unit?: string) => <NumberField key={key} label={label} value={r[key] as number} unit={unit} onChange={value => pricing({ [key]: value })} />;
  return <form className="settings-section rule-settings" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="settings-section-title">{section === 'product' ? <SlidersHorizontal size={19} /> : <Calculator size={19} />}<div><h3>{section === 'product' ? '商品填报规则' : '定价、组套与促销'}</h3><p>{section === 'product' ? '明确的业务字段自动填写，真实参数优先；已有人工修改仍保留。' : '沿用已确认的旧插件公式。所有费用和档位可调整，正常价和促销价分别核验收益。'}</p></div></div>
    <fieldset disabled={busy} className="rule-fieldset">
      <div hidden={section !== 'product'}>
        <div className="rule-fields"><label className="field"><span>历史品牌设置（保留）</span><input value={p.brand} maxLength={100} onChange={event => product({ brand: event.target.value })} /></label><NumberField label="标价" unit="USD" value={p.listPrice} onChange={value => product({ listPrice: value })} /></div>
        <p className="settings-help">品牌与店铺制造商设置保留供参考，不自动填入商品事实。标价只填入类目提供的标价字段，与计算得出的销售价分别保存。型号和零件号缺失时使用当前行 SKU；已有型号保留。</p>
        <div className="settings-subsection"><h4>店铺与制造商</h4><div className="rule-fields">{Object.entries(p.manufacturers).map(([code,name]) => <label className="field" key={code}><span>{code} 制造商</span><input value={name} onChange={event => product({ manufacturers: { ...p.manufacturers, [code]: event.target.value } })} /></label>)}</div>
          <div className="rule-fields"><label className="field"><span>新增店铺编号</span><input value={shopCode} placeholder="例如 U9" onChange={event => setShopCode(event.target.value)} /></label><label className="field"><span>制造商</span><input value={manufacturer} onChange={event => setManufacturer(event.target.value)} /></label></div><button className="button secondary small-button" type="button" disabled={!/^[A-Za-z0-9_-]{1,100}$/.test(shopCode.trim()) || !manufacturer.trim()} onClick={() => { product({ manufacturers: { ...p.manufacturers, [shopCode.trim()]: manufacturer.trim() } }); setShopCode(''); setManufacturer(''); }}>添加店铺规则</button>
          {targets.length > 0 && <div className="rule-fields">{targets.map(target => <label className="field" key={target.id}><span>{target.name} 使用的店铺规则</span><select value={p.targetShops[target.id] ?? ''} onChange={event => { const next = { ...p.targetShops }; if (event.target.value) next[target.id] = event.target.value; else delete next[target.id]; product({ targetShops: next }); }}><option value="">请选择店铺编号</option>{Object.keys(p.manufacturers).map(code => <option key={code}>{code}</option>)}</select></label>)}</div>}
        </div>
        <div className="settings-subsection"><h4>尺寸与包装重量</h4><p className="settings-help">以下默认值仅补齐私有定价估算，不写入商品尺寸、包装属性或图片事实。实际测量须有当前规格的已确认来源依据。</p>
          <label className="rule-toggle"><input type="checkbox" checked={p.dimensionFallback} onChange={event => product({ dimensionFallback: event.target.checked })} />定价缺少尺寸时使用估算值</label>
          <div className="rule-fields">{(['长','宽','高'] as const).map((label,index) => <NumberField key={label} label={label} value={p.dimensions[index]} onChange={value => { const dimensions = [...p.dimensions] as [number,number,number]; dimensions[index] = value; product({ dimensions }); }} />)}<label className="field"><span>尺寸单位</span><select value={p.dimensionUnit} onChange={event => product({ dimensionUnit: event.target.value as ProductRules['dimensionUnit'] })}><option value="cm">厘米 cm</option><option value="inches">英寸 inches</option></select></label></div>
          <label className="rule-toggle"><input type="checkbox" checked={p.weightFallback} onChange={event => product({ weightFallback: event.target.checked })} />定价缺少包装重量时使用估算值</label><div className="rule-fields"><NumberField label="包装重量" value={p.packageWeight} onChange={value => product({ packageWeight: value })} /><label className="field"><span>重量单位</span><select value={p.weightUnit} onChange={event => product({ weightUnit: event.target.value as ProductRules['weightUnit'] })}><option value="g">克 g</option><option value="pounds">磅 pounds</option></select></label></div>
        </div>
        <div className="settings-subsection"><h4>普通商品声明与备货</h4><label className="rule-toggle"><input type="checkbox" checked={p.ordinaryDeclarations} onChange={event => product({ ordinaryDeclarations: event.target.checked })} />保留旧普通商品声明偏好（不自动生成事实声明）</label><div className="rule-fields"><NumberField label="每 SKU 备货套数" step="1" value={p.stockSets} onChange={value => product({ stockSets: value })} /><NumberField label="自动准备最多选取变体" step="1" value={p.variantLimit} onChange={value => product({ variantLimit: value })} /></div><p className="settings-help">电池、原产国与合规声明须有明确的商品事实依据。备货套数与每套件数分别计算；原始采集 SKU 全部保留。</p></div>
      </div>
      <div hidden={section !== 'pricing'}>
        <div className="rule-formula">前期成本 = 采购成本 + 头程 + 包装<br />ROI = [汇率 × (售价 − 其他扣减 − 佣金 − 配送费) − 前期成本] ÷ 前期成本</div>
        <div className="rule-fields">{amount('fx','结算汇率','CNY/USD')}{amount('inboundCost','每套头程','CNY')}{amount('packingCost','每套包装','CNY')}{amount('targetRoi','ROI 须大于')}{amount('margin','最低可行价加价','USD')}{amount('maxPrice','售价上限','USD')}</div>
        <details className="rule-group" open><summary>平台扣费</summary><div className="rule-fields">{amount('commissionPercent','佣金比例','%')}{amount('commissionMinimum','最低佣金','USD')}{amount('reservePercent','其他扣减','%')}</div></details>
        <details className="rule-group"><summary>配送费档位与抛重</summary><p className="settings-help">以下为已确认的历史业务费表，可按店铺实际费率修改。</p><label className="rule-toggle"><input type="checkbox" checked={r.apparel} onChange={event => pricing({ apparel: event.target.checked })} />使用服装费率</label><div className="rule-fields">{amount('lowPriceThreshold','最轻档低价界限','USD')}{amount('lowPriceFee','最轻档低价配送费','USD')}{amount('dimensionalDivisor','体积重除数','in³/lb')}{amount('maxDimensionalWeightGrams','允许抛重上限','g')}</div>
          <div className="rule-fee-table"><div className="rule-fee-heading"><span>重量上界（oz）</span><span>服装（USD）</span><span>非服装（USD）</span></div>{r.deliveryTiers.map((tier,index) => <div className="rule-fee-row" key={index}>{tier.upperOz === null ? <span>以上重量</span> : <NumberField label={`第 ${index+1} 档上界`} value={tier.upperOz} onChange={value => pricing({ deliveryTiers: r.deliveryTiers.map((item,i) => i === index ? { ...item, upperOz: value } : item) })} />}{(['apparel','ordinary'] as const).map(key => <NumberField key={key} label={`${index+1} 档${key === 'apparel' ? '服装' : '非服装'}`} value={tier[key]} onChange={value => pricing({ deliveryTiers: r.deliveryTiers.map((item,i) => i === index ? { ...item, [key]: value } : item) })} />)}</div>)}</div>
        </details>
        <details className="rule-group" open><summary>组套</summary><label className="rule-toggle"><input type="checkbox" checked={r.bundleEnabled} onChange={event => pricing({ bundleEnabled: event.target.checked })} />对符合条件的单 SKU 商品计算组套</label><div className="rule-fields">{amount('bundleThresholdUsd','单件采购价低于','USD')}{amount('bundleCapUsd','每套采购成本上限','USD')}<label className="field"><span>候选件数（按顺序尝试）</span><input value={sizes} onChange={event => { setSizes(event.target.value); setDirty(true); }} placeholder="10, 5, 4" /></label></div></details>
        <details className="rule-group" open><summary>促销</summary><label className="rule-toggle"><input type="checkbox" checked={r.promoEnabled} onChange={event => pricing({ promoEnabled: event.target.checked })} />启用促销价格</label><div className="rule-fields">{amount('promoDiscount','正常价减','USD')}{amount('promoDelayDays','开始延迟','天')}{amount('promoDays','持续时间','天')}</div><p className="settings-help">按北京时间当天零点计算延迟；促销价同样必须达到目标 ROI。</p></details>
      </div>
      <div className="rule-save"><button type="submit" className="button primary" disabled={!dirty}>保存商品与定价规则</button><span className="settings-help">{dirty ? '有未保存修改，切换设置模块仍会保留。' : `当前规则版本 ${rules.revision}`}</span></div>
    </fieldset>
    {error && <p className="workflow-warning" role="alert">{error}</p>}{notice && <p className="workflow-notice" role="status">{notice}</p>}
  </form>;
}
