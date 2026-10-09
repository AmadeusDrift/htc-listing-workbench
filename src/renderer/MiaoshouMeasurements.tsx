import { useMemo, useState } from 'react';
import type { MiaoshouMapping, MiaoshouProduct } from '../shared/miaoshou-contracts';
import { analyzeMiaoshouMeasurements, MEASUREMENT_LABELS } from '../shared/miaoshou-measurements';
import type { MeasurementEvidence, MeasurementField } from '../shared/miaoshou-measurements';

const labels: Record<MeasurementEvidence['status'], string> = { usable: '来源有值', inferred: '单位已补全', suspect: '待核对', conflict: '来源冲突', missing_unit: '缺单位', scope_unknown: '净毛重未明', superseded: '使用 SKU 值' };
function display(value?: MeasurementEvidence): string { return value?.value == null ? '待补充' : `${value.sourceUnit === value.unit ? value.value : value.value.toFixed(2)} ${value.unit}`; }
export function MiaoshouMeasurements({ product, mapping }: { product: MiaoshouProduct; mapping?: MiaoshouMapping }) {
  const report = useMemo(() => analyzeMiaoshouMeasurements(product, mapping), [product, mapping]);
  const [sourceKey, setSourceKey] = useState(product.skus[0]?.key ?? '');
  const row = report.skus.find(s => s.sourceKey === sourceKey) ?? report.skus[0];
  if (!row) return null;
  const count = report.skus.filter(s => Object.keys(s.values).length > 0).length;
  const field = (name: MeasurementField) => <div key={name}><dt>{MEASUREMENT_LABELS[name]}</dt><dd>{display(row.values[name])}{row.values[name]?.inferredUnit && <small>已按{row.values[name]?.sourceUnit === 'g' ? '克' : '厘米'}补单位</small>}</dd></div>;
  return <section className="miaoshou-measurements" aria-label="尺寸与重量整理">
    <div className="section-heading"><div><h4>尺寸与重量</h4><p className="settings-help">{count} / {report.skus.length} 个 SKU 已取得可用参数。{report.assumed1688Units ? '1688 文字缺单位按厘米、克处理。' : '按来源明确单位处理。'}</p></div></div>
    <label className="field"><span>查看 SKU 参数</span><select aria-label="查看 SKU 参数" value={row.sourceKey} onChange={event => setSourceKey(event.target.value)}>{report.skus.map(s => <option key={s.sourceKey} value={s.sourceKey}>{s.specification || product.skus.find(sku => sku.key === s.sourceKey)?.itemNum || s.sourceKey}</option>)}</select></label>
    <dl className="miaoshou-measurement-grid">{(['item.length', 'item.width', 'item.height', 'item.weight', 'package.length', 'package.width', 'package.height', 'package.weight'] as MeasurementField[]).map(field)}</dl>
    <p className="settings-help">{row.missingPackageFields.length ? `包装资料待补：${row.missingPackageFields.map(key => MEASUREMENT_LABELS[key]).join('、')}。` : '包装尺寸和毛重已有来源值。'}新建 Haul 草稿时按当前类目支持的字段填入，不代表已通过运费或上架校验。</p>
    <details><summary>查看原值与采用依据（{row.evidence.length}）</summary>
      {!row.evidence.length ? <p className="settings-help">来源文字没有可识别的尺寸重量，暂时留空。</p> : <div className="miaoshou-sku-table"><table><thead><tr><th>参数</th><th>原值</th><th>换算值</th><th>状态与依据</th></tr></thead><tbody>{row.evidence.map((e, index) => <tr key={index}>
        <td>{MEASUREMENT_LABELS[e.field]}</td><td>{e.sourceValue} {e.sourceUnit || '（无单位）'}{e.inferredUnit && <small>单位按 1688 规则补全</small>}</td><td>{display(e)}</td>
        <td><span className={`miaoshou-measurement-state ${e.status === 'usable' || e.status === 'inferred' ? 'available' : e.status === 'superseded' ? 'neutral' : 'pending'}`}>{labels[e.status]}</span><small>{e.reason}</small><small>{e.evidence}</small></td>
      </tr>)}</tbody></table></div>}
    </details>
  </section>;
}
