import { useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { DEFAULT_ITEM_LABEL_FORMAT, ITEM_LABEL_PAGE_TYPES } from '../shared/item-label-contracts';
import type { ItemLabelFormat } from '../shared/item-label-contracts';
import { errorText } from './utils';

const pageNames: Record<typeof ITEM_LABEL_PAGE_TYPES[number], string> = { A4_21:'A4 · 21 格', A4_24:'A4 · 24 格', A4_24_64x33:'A4 · 24 格 · 64 × 33 mm', A4_24_66x35:'A4 · 24 格 · 66 × 35 mm', A4_24_70x36:'A4 · 24 格 · 70 × 36 mm', A4_24_70x37:'A4 · 24 格 · 70 × 37 mm', A4_24i:'A4 · 24 格（24i）', A4_27:'A4 · 27 格', A4_40_52x29:'A4 · 40 格 · 52 × 29 mm', A4_44_48x25:'A4 · 44 格 · 48 × 25 mm', Letter_30:'Letter · 30 格' };
export function ItemLabelSettings({ busy, onSaved }: { busy: boolean; onSaved?: () => void }) {
  const api = window.red;
  const [format, setFormat] = useState<ItemLabelFormat>(DEFAULT_ITEM_LABEL_FORMAT);
  const [saved, setSaved] = useState<ItemLabelFormat | null>(null);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void api.getItemLabelFormat().then(value => { if (mounted.current) { setFormat(value); setSaved(value); } }, cause => { if (mounted.current) setError(errorText(cause)); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [api]);
  const disabled = busy || loading || pending;
  const valid = format.labelType !== 'THERMAL_PRINTING' || [format.width, format.height].every(value => Number.isFinite(value) && value >= 25 && value <= 100);
  function change(value: ItemLabelFormat) { setFormat(value); setNotice(''); }
  async function save() {
    if (disabled || !valid) return;
    setPending(true); setError(''); setNotice('');
    try { const value = await api.saveItemLabelFormat(format); if (mounted.current) { setFormat(value); setSaved(value); setNotice('商品标签格式已保存'); onSaved?.(); } }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setPending(false); }
  }
  return <section className="settings-section item-label-settings" aria-label="商品标签格式">
    <h3>商品标签格式</h3><p className="small-copy">按实际标签纸选择 A4 排版或热敏尺寸。保存后用于新任务与后续备货；已有自动任务保留启动时的格式，当前可用版本以标签列表为准。</p>
    <div className="form-grid"><label className="field"><span>标签纸类型</span><select aria-label="标签纸类型" disabled={disabled} value={format.labelType} onChange={event => change(event.target.value === 'THERMAL_PRINTING' ? { labelType:'THERMAL_PRINTING',width:50,height:30,localeCode:format.localeCode } : { labelType:'STANDARD_FORMAT',pageType:'A4_21',localeCode:format.localeCode })}><option value="STANDARD_FORMAT">A4 / Letter 标签纸</option><option value="THERMAL_PRINTING">热敏标签纸</option></select></label>
      {format.labelType === 'STANDARD_FORMAT' ? <label className="field"><span>标签排版</span><select aria-label="标签排版" disabled={disabled} value={format.pageType} onChange={event => change({ ...format,pageType:event.target.value as typeof ITEM_LABEL_PAGE_TYPES[number] })}>{ITEM_LABEL_PAGE_TYPES.map(value => <option key={value} value={value}>{pageNames[value]}</option>)}</select></label> : <><label className="field"><span>热敏标签宽度（mm）</span><input aria-label="热敏标签宽度（mm）" disabled={disabled} type="number" min={25} max={100} step="any" value={format.width || ''} onChange={event => change({ ...format,width:Number(event.target.value) })} /></label><label className="field"><span>热敏标签高度（mm）</span><input aria-label="热敏标签高度（mm）" disabled={disabled} type="number" min={25} max={100} step="any" value={format.height || ''} onChange={event => change({ ...format,height:Number(event.target.value) })} /></label></>}
    </div>
    {!valid && <p className="workflow-notice" role="alert">热敏标签宽、高均需为 25–100 mm。</p>}
    {loading && <p className="small-copy" role="status">正在读取标签格式…</p>}{error && <p className="workflow-notice" role="alert">{error}</p>}{notice && <p className="workflow-notice" role="status">{notice}</p>}
    <button type="button" className="button secondary" disabled={disabled || !valid || JSON.stringify(format) === JSON.stringify(saved)} onClick={() => { void save(); }}><Save size={15} />{pending ? '正在保存…' : '保存标签格式'}</button>
    <p className="small-copy">标签份数按发往 Amazon 的销售单位数量生成，5 套生成 5 张。下载后可通过系统 PDF 阅读器选择打印机和打印。</p>
  </section>;
}
