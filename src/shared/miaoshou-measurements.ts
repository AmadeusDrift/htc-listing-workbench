import type { MiaoshouDimension, MiaoshouMapping, MiaoshouProduct } from './miaoshou-contracts.ts';

export type MeasurementField = `${'item' | 'package' | 'carton'}.${'length' | 'width' | 'height' | 'diameter' | 'weight'}` | 'source.weight' | 'content.weight';
export type MeasurementStatus = 'usable' | 'inferred' | 'suspect' | 'conflict' | 'missing_unit' | 'scope_unknown' | 'superseded';
export interface MeasurementEvidence {
  field: MeasurementField; sourceValue: string; sourceUnit: string; inferredUnit: boolean;
  value: number | null; unit: 'inches' | 'pounds'; status: MeasurementStatus;
  origin: 'attribute' | 'description' | 'specification' | 'api'; evidence: string; reason: string;
}
export interface MiaoshouSkuMeasurements {
  sourceKey: string; specification: string; values: Partial<Record<MeasurementField, MeasurementEvidence>>;
  evidence: MeasurementEvidence[]; missingPackageFields: MeasurementField[];
}
export interface MiaoshouMeasurements { assumed1688Units: boolean; skus: MiaoshouSkuMeasurements[] }
export const MEASUREMENT_LABELS: Record<MeasurementField, string> = {
  'item.length': '商品长度', 'item.width': '商品宽度', 'item.height': '商品高度', 'item.diameter': '商品直径', 'item.weight': '商品净重',
  'package.length': '包装长度', 'package.width': '包装宽度', 'package.height': '包装高度', 'package.diameter': '包装直径', 'package.weight': '包装毛重',
  'carton.length': '整箱长度', 'carton.width': '整箱宽度', 'carton.height': '整箱高度', 'carton.diameter': '整箱直径', 'carton.weight': '整箱重量',
  'source.weight': '来源重量（净毛重未明）', 'content.weight': '净含量',
};
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const UNIT = String.raw`(?:inches|inch|pounds|pound|lbs|lb|kg|cm|mm|oz|g|m|in|千克|公斤|厘米|毫米|英寸|盎司|毫升|磅|克|斤|米|升|ml|kgm)`;
const TOKEN = `${NUMBER}\\s*(?:${UNIT})?`;
const LABEL = String.raw`(?:(?:单个|单件|产品|商品|包装|带包装|含包装|整箱|外箱|每箱|整套|套装|总)\s*){0,3}(?:净含量|净重|毛重|重量|单重|尺寸|长宽高|长宽|直径|厚度|长度|宽度|高度|长|宽|高)|\b(?:(?:package|packed|item|product|carton|net|gross)\s+)?(?:length|width|height|diameter|dimensions|size|weight)\b`;
const UNITS: Record<string, { unit: string; kind: 'length' | 'weight'; factor: number }> = {};
for (const [names, unit, kind, factor] of [
  ['cm,厘米', 'cm', 'length', 1 / 2.54], ['mm,毫米', 'mm', 'length', 1 / 25.4], ['m,米', 'm', 'length', 100 / 2.54],
  ['in,inch,inches,英寸', 'inches', 'length', 1], ['g,克', 'g', 'weight', 1 / 453.59237],
  ['kg,公斤,千克', 'kg', 'weight', 1000 / 453.59237], ['斤', 'jin', 'weight', 500 / 453.59237],
  ['lb,lbs,pound,pounds,磅', 'pounds', 'weight', 1], ['oz,盎司', 'oz', 'weight', 1 / 16],
] as const) for (const name of names.split(',')) UNITS[name] = { unit, kind, factor };
const ready = (e: MeasurementEvidence) => e.status === 'usable' || e.status === 'inferred';
function source1688(product: MiaoshouProduct): boolean {
  return product.sources.some(source => {
    if (/^(?:1688|阿里巴巴)$/i.test(source.source.trim()) || /^(?:1688\.com|www\.1688\.com)$/i.test(source.sourceSite.trim())) return true;
    try { const host = new URL(source.sourceItemUrl).hostname; return host === '1688.com' || host.endsWith('.1688.com'); } catch { return false; }
  });
}
/** Exact source identity only; a display name or an ordinal is not a SKU relationship. */
export function resolveMiaoshouSpecifications(product: MiaoshouProduct, sourceKey: string, mapping?: MiaoshouMapping): { dimension: MiaoshouDimension; value: MiaoshouDimension['values'][number] }[] {
  const selected = mapping?.skus.find(row => row.sourceKey === sourceKey), tokens = sourceKey.startsWith(';') ? sourceKey.slice(1).split(';') : [];
  const slots = ['color', 'size', 'third'];
  // Keys containing semicolons are ambiguous. Accept the positional grammar only when every slot matches.
  const exactKey = tokens.length === 3 && slots.every((id, i) => {
    const dimension = product.dimensions.find(d => d.id === id);
    return dimension ? dimension.values.some(value => value.id === tokens[i]) : tokens[i] === '';
  });
  return product.dimensions.flatMap(dimension => {
    const explicit = selected?.dimensions[dimension.id];
    const id = explicit ?? (exactKey ? tokens[slots.indexOf(dimension.id)] : dimension.values.length === 1 ? dimension.values[0].id : undefined);
    const value = dimension.values.find(v => v.id === id);
    return value ? [{ dimension, value }] : [];
  });
}
function scope(label: string): 'item' | 'package' | 'carton' {
  return /整箱|外箱|每箱|carton/i.test(label) ? 'carton' : /包装|毛重|package|packed|gross/i.test(label) ? 'package' : 'item';
}
function fieldFor(label: string): MeasurementField | null {
  const group = scope(label);
  if (/净含量/.test(label)) return 'content.weight';
  if (/重|weight/i.test(label)) {
    if (group === 'item' && !/净重|单重|单个|单件|商品|产品|item|product|net/i.test(label)) return 'source.weight';
    return `${group}.weight`;
  }
  if (/直径|diameter/i.test(label)) return `${group}.diameter`;
  if (/高度|厚度|高$|height/i.test(label)) return `${group}.height`;
  if (/宽度|宽$|width/i.test(label)) return `${group}.width`;
  if (/长度|长$|length/i.test(label)) return `${group}.length`;
  return null;
}
function candidate(field: MeasurementField, raw: string, rawUnit: string, assumed: boolean, origin: MeasurementEvidence['origin'], evidence: string, suspect = ''): MeasurementEvidence {
  const kind = field.endsWith('.weight') ? 'weight' : 'length', defaultUnit = kind === 'weight' ? 'g' : 'cm';
  const inferredUnit = !rawUnit && assumed, unitName = rawUnit.trim().toLowerCase() || (assumed ? defaultUnit : '');
  const unit = UNITS[unitName], numeric = Number(raw), converted = unit ? numeric * unit.factor : NaN;
  const rounded = unit?.factor === 1 ? numeric : Math.round((converted + Number.EPSILON * Math.abs(converted)) * 100) / 100;
  let status: MeasurementStatus = inferredUnit ? 'inferred' : 'usable';
  let reason = inferredUnit ? `按 1688 默认${kind === 'weight' ? '克' : '厘米'}换算` : '按来源明确单位换算';
  if (!Number.isFinite(numeric) || numeric <= 0) { status = 'suspect'; reason = '数值为空、零或无效'; }
  else if (!unitName) { status = 'missing_unit'; reason = '非 1688 来源缺单位，暂不自动换算'; }
  else if (!unit || unit.kind !== kind) { status = 'suspect'; reason = '来源单位不适用于此尺寸或重量'; }
  else if (!Number.isFinite(rounded) || rounded <= 0) { status = 'suspect'; reason = '换算后低于两位小数精度，不能填 0'; }
  if (suspect) { status = 'suspect'; reason = suspect; }
  if (ready({ status } as MeasurementEvidence) && field === 'source.weight') { status = 'scope_unknown'; reason = '来源未说明净重或包装毛重，保留原值'; }
  return { field, sourceValue: raw, sourceUnit: unit?.unit ?? unitName, inferredUnit,
    value: Number.isFinite(rounded) && unit?.kind === kind ? rounded : null, unit: kind === 'weight' ? 'pounds' : 'inches', status, origin, evidence: evidence.slice(0, 700), reason };
}
function splitToken(token: string): { value: string; unit: string } | null {
  const match = new RegExp(`^(${NUMBER})\\s*(${UNIT})?$`, 'i').exec(token.trim());
  return match ? { value: match[1], unit: match[2] ?? '' } : null;
}
function parseText(text: string, assumed: boolean, origin: MeasurementEvidence['origin']): MeasurementEvidence[] {
  const results: MeasurementEvidence[] = [];
  for (const line of text.split(/[\r\n;；。]/).filter(Boolean)) {
    const labels = [...line.matchAll(new RegExp(LABEL, 'gi'))].filter(match =>
      !/^[长宽高]$/.test(match[0]) || !/\p{Script=Han}/u.test(line[match.index! - 1] ?? '') || new RegExp(`${NUMBER}\\s*${UNIT}$`, 'i').test(line.slice(0, match.index)));
    let inheritedScope: 'item' | 'package' | 'carton' = 'item', inheritedUnit = '';
    for (let index = 0; index < labels.length; index++) {
      const found = labels[index]; let label = found[0];
      let body = line.slice(found.index! + found[0].length, labels[index + 1]?.index).trim();
      let labelUnit = '';
      const tagged = new RegExp(`^[（(]\\s*(${UNIT})\\s*[)）]`, 'i').exec(body);
      if (tagged) { labelUnit = tagged[1]; body = body.slice(tagged[0].length); }
      if (/商品|产品|包装|整箱|外箱|每箱|item|product|package|packed|carton/i.test(label)) { inheritedScope = scope(label); inheritedUnit = labelUnit; }
      else if (/^(?:长|宽|高|长度|宽度|高度|厚度|直径|长宽高|长宽)$/u.test(label)) {
        label = `${inheritedScope === 'package' ? '包装' : inheritedScope === 'carton' ? '整箱' : '商品'}${label}`;
        labelUnit ||= inheritedUnit;
      }
      body = body.replace(/^[\s:：=约≈()（）]+/, '');
      const field = fieldFor(label), dimension = /尺寸|长宽|dimensions|size/i.test(label);
      if (dimension) {
        if (origin === 'specification') body = body.replace(/^(?:特大号|大号|中号|小号|迷你|[SMLX]{1,4})\s*/i, '');
        const tuple = new RegExp(`^(${TOKEN}\\s*[xX×*]\\s*${TOKEN}(?:\\s*[xX×*]\\s*${TOKEN})?)(?![\\d.])`, 'i').exec(body);
        if (!tuple || /^(?:\s*[a-zA-Z×*~～到至/.-]|\s*\d)/.test(body.slice(tuple[0].length))) continue;
        const parts = tuple[1].split(/[xX×*]/).map(splitToken);
        if (parts.some(part => !part)) continue;
        const units = new Set(parts.map(part => part!.unit).filter(Boolean)), shared = units.size === 1 ? [...units][0] : labelUnit;
        const group = scope(label), numbers = parts.map(part => Number(part!.value));
        const cm = parts.every(part => UNITS[(part!.unit || shared || (assumed ? 'cm' : '')).toLowerCase()]?.unit === 'cm');
        const suspect = group === 'package' && (numbers.some(n => n <= 0) || cm && numbers.length === 3 && numbers.every(n => n === numbers[0]) && [1, 10].includes(numbers[0])) ? '包装尺寸疑似占位值，暂不采用' : '';
        parts.forEach((part, axis) => results.push(candidate(`${group}.${(['length', 'width', 'height'] as const)[axis]}`, part!.value, part!.unit || shared, assumed, origin, line, suspect)));
      } else if (field) {
        const value = new RegExp(`^(${NUMBER})\\s*(${UNIT})?`, 'i').exec(body);
        if (!value || /^[\d.a-zA-Z]|^\s*(?:[-~～至到/]|元|件|个|套|盒|只|天|日|月|年|小时|分钟|秒)/.test(body.slice(value[0].length))) continue;
        results.push(candidate(field, value[1], value[2] || labelUnit, assumed, origin, line));
      }
    }
    // Supplier axis names can be wrong, e.g. "颜色: 小号12厘米长青蛙".
    if (origin === 'specification') for (const match of line.matchAll(new RegExp(`(${NUMBER})\\s*(${UNIT})\\s*(长度|宽度|高度|长|宽|高)`, 'gi'))) {
      const field = fieldFor(match[3]); if (field) results.push(candidate(field, match[1], match[2], assumed, origin, line));
    }
  }
  return results;
}
function settle(evidence: MeasurementEvidence[]): Partial<Record<MeasurementField, MeasurementEvidence>> {
  const values: Partial<Record<MeasurementField, MeasurementEvidence>> = {};
  for (const field of new Set(evidence.map(e => e.field))) {
    let group = evidence.filter(e => e.field === field && ready(e));
    const bound = group.filter(e => e.origin === 'specification');
    if (bound.length) {
      for (const e of group.filter(e => e.origin !== 'specification')) { e.status = 'superseded'; e.reason = '采用当前 SKU 的专属参数'; }
      group = bound;
    }
    if (!group.length) continue;
    // Compare physical source values before display rounding, so close conflicts aren't hidden by ROUND(2).
    const exact = group.map(e => Number(e.sourceValue) * (Object.values(UNITS).find(u => u.unit === e.sourceUnit)?.factor ?? 1));
    if (exact.some(value => Math.abs(value - exact[0]) > Math.max(1, Math.abs(exact[0])) * 1e-8)) {
      for (const e of group) { e.status = 'conflict'; e.reason = '同一参数存在不同来源数值，暂不自动采用'; } continue;
    }
    values[field] = group.find(e => !e.inferredUnit) ?? group[0];
  }
  return values;
}
/** Deterministic, local-only derivation. Source snapshots stay immutable; no image or AI request is made. */
export function analyzeMiaoshouMeasurements(product: MiaoshouProduct, mapping?: MiaoshouMapping): MiaoshouMeasurements {
  const assumed1688Units = source1688(product), axisNames = new Set(product.dimensions.map(d => d.name.trim()));
  const common = product.attributes.filter(a => !axisNames.has(a.name.trim())).flatMap(a => parseText(`${a.name}：${a.value}`, assumed1688Units, 'attribute'));
  for (const text of [product.description, product.detailText ?? '']) {
    // notesText often repeats the whole attribute list, including all variants. Do not broadcast those axes.
    const lines = text.split(/[\r\n]/).filter(line => ![...axisNames].some(name => line.trim().startsWith(`${name}：`) || line.trim().startsWith(`${name}:`)));
    common.push(...parseText(lines.join('\n'), assumed1688Units, 'description'));
  }
  const skus = product.skus.map(sku => {
    const selected = resolveMiaoshouSpecifications(product, sku.key, mapping), evidence = common.map(e => ({ ...e }));
    for (const { dimension, value } of selected) evidence.push(...parseText(`${dimension.name}：${value.name}`, assumed1688Units, 'specification'));
    const dimensions = [sku.packageLength, sku.packageWidth, sku.packageHeight];
    const numbers = dimensions.map(value => value === null ? NaN : Number(value));
    const placeholder = numbers.some(n => n <= 0) || numbers.every(n => n === numbers[0]) && [1, 10].includes(numbers[0]);
    dimensions.forEach((value, i) => { if (value !== null) evidence.push(candidate(`package.${(['length', 'width', 'height'] as const)[i]}`, value, 'cm', false, 'api', `妙手 package${['Length', 'Width', 'Height'][i]}：${value} cm`, placeholder ? '包装尺寸疑似占位值，暂不采用' : '')); });
    if (sku.weight !== null) evidence.push(candidate('source.weight', sku.weight, 'kg', false, 'api', `妙手 weight：${sku.weight} kg`));
    const unique = [...new Map(evidence.map(e => [JSON.stringify([e.field, e.sourceValue, e.sourceUnit, e.origin, e.evidence]), e])).values()];
    const values = settle(unique), fields: MeasurementField[] = ['package.length', 'package.width', 'package.height', 'package.weight'];
    return { sourceKey: sku.key, specification: selected.map(s => s.value.name).join(' / '), values, evidence: unique, missingPackageFields: fields.filter(field => !values[field]) };
  });
  return { assumed1688Units, skus };
}
