import type { ProductDetail } from './contracts.ts';
import type { MiaoshouInboxSummary, MiaoshouMapping, MiaoshouProduct, MiaoshouReceipt } from './miaoshou-contracts.ts';
import { analyzeMiaoshouMeasurements, resolveMiaoshouSpecifications } from './miaoshou-measurements.ts';
import type { MeasurementEvidence, MiaoshouSkuMeasurements } from './miaoshou-measurements.ts';

export function automaticMiaoshouMapping(product: MiaoshouProduct): MiaoshouMapping {
  const cny = product.sources.some(source => source.source === '1688');
  return { priceField: cny ? 'price' : 'none', currency: cny ? 'CNY' : 'unknown', skus: product.skus.map(sku => ({ sourceKey: sku.key,
    dimensions: Object.fromEntries(resolveMiaoshouSpecifications(product, sku.key).map(row => [row.dimension.id, row.value.id])) })) };
}
function priceRange(values: (string | null)[]): string {
  const prices = values.filter((value): value is string => value !== null && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0).map(Number);
  if (!prices.length) return '—';
  const format = (value: number) => value.toLocaleString('en-US', { useGrouping: false, minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 6 });
  const min = Math.min(...prices), max = Math.max(...prices);
  return min === max ? format(min) : `${format(min)}–${format(max)}`;
}
function sourceValue(value: MeasurementEvidence | undefined): string | null {
  return value ? `${value.sourceValue} ${value.sourceUnit === 'inches' ? 'in' : value.sourceUnit === 'pounds' ? 'lb' : value.sourceUnit}` : null;
}
function dimensions(row: MiaoshouSkuMeasurements): string | null {
  for (const scope of ['item', 'package'] as const) {
    const axes = ['length', 'width', 'height'].map(axis => row.values[`${scope}.${axis}` as keyof typeof row.values]);
    if (axes.every(Boolean)) {
      const unit = axes[0]!.sourceUnit;
      const text = axes.every(value => value!.sourceUnit === unit) ? `${axes.map(value => value!.sourceValue).join('×')} ${unit}` : axes.map(sourceValue).join(' × ');
      return `${scope === 'package' ? '包装 ' : ''}${text}`;
    }
    if (scope === 'item') {
      const parts = [['length', '长'], ['width', '宽'], ['height', '高'], ['diameter', '直径']].flatMap(([axis, label]) => {
        const value = sourceValue(row.values[`item.${axis}` as keyof typeof row.values]); return value ? [`${label} ${value}`] : [];
      });
      if (parts.length) return parts.join(' · ');
    }
  }
  return null;
}
function weight(row: MiaoshouSkuMeasurements): string | null {
  for (const [field, label] of [['item.weight', '净重'], ['package.weight', '包装'], ['source.weight', '来源']] as const) {
    const evidence = row.values[field] ?? (field === 'source.weight' ? row.evidence.find(value => value.field === field && value.status === 'scope_unknown') : undefined);
    const value = sourceValue(evidence); if (value) return `${label} ${value}`;
  }
  return null;
}
function summarize(values: (string | null)[]): string {
  if (!values.some(Boolean)) return '—';
  const unique = new Set(values); return unique.size === 1 ? values[0]! : '多规格';
}
export function inboxSummary(product: ProductDetail, receipt: MiaoshouReceipt | null, hasSourceUpdate = false): MiaoshouInboxSummary {
  const source = receipt?.snapshot;
  const measurements = source ? analyzeMiaoshouMeasurements(source, receipt.mapping).skus : [];
  const size = summarize(measurements.map(dimensions)), mass = summarize(measurements.map(weight));
  const facts = product.facts.filter(fact => fact.value.trim() && !['missing', 'conflicting', 'ai_suggested'].includes(fact.state));
  const unique = new Map(facts.map(fact => [fact.name, { name: fact.name, value: fact.value }]));
  for (const fact of source?.attributes ?? []) if (!unique.has(fact.name) && fact.value.trim()) unique.set(fact.name, fact);
  const ranked = [...unique.values()].filter(fact => !/重量|净重|毛重|尺寸|长度|宽度|高度|长宽高|价格|采购价|售价|币种|货号|链接|网址/i.test(fact.name))
    .map((fact, index) => ({ fact, index, rank: /材质|容量|容积|件数|数量|格数|适用|功能|颜色|规格|包装/.test(fact.name) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, 3).map(row => row.fact);
  const overrides = source ? facts.filter(fact => fact.state === 'human_confirmed') : facts;
  const directSize = overrides.find(fact => /^(产品|商品)?尺寸$/.test(fact.name))?.value;
  const directWeight = overrides.find(fact => /^(产品|商品)?(净重|重量)$/.test(fact.name))?.value;
  const packageSize = overrides.find(fact => /^包装尺寸$/.test(fact.name))?.value;
  const packageWeight = overrides.find(fact => /^(包装)?毛重$|^包装重量$/.test(fact.name))?.value;
  const actualSize = directSize || (size !== '—' ? size : packageSize ? `包装 ${packageSize}` : '—');
  const actualWeight = directWeight || (mass !== '—' ? mass : packageWeight ? `包装 ${packageWeight}` : '—');
  return { productId: product.id, imageId: (source?.images.find(image => image.role === 'main') ?? source?.images[0])?.id ?? null,
    price: priceRange(source ? source.skus.map(sku => sku.price ?? sku.oriPrice) : product.variants.map(variant => variant.sourcePurchasePrice || variant.purchasePrice)),
    size: actualSize, weight: actualWeight, attributes: ranked, hasSourceUpdate,
    missing: [...(actualSize === '—' ? ['尺寸'] : []), ...(actualWeight === '—' ? ['重量'] : [])] };
}
