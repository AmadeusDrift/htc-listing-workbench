import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { UserFacingError } from '../../shared/errors.ts';
import type { MiaoshouDimensionId, MiaoshouMapping, MiaoshouProduct, MiaoshouReceipt, SourceAttributeNormalizations } from '../../shared/miaoshou-contracts.ts';
import { normalizeSourceAttributeV1 } from './source-attribute-normalization-v1.ts';

const ERRORS = {
  INPUT: '妙手操作参数无效，请重新选择后重试', CONFIG: '妙手配置无效；请检查 AppKey 和 AppSecret 是否完整、无空格且不是模板占位文字',
  NOT_CONFIGURED: '尚未配置妙手授权，请在设置中填写或导入配置，也可先切换演示模式', CRYPTO: '系统安全加密不可用，无法保存或读取妙手授权，请在原 Windows 用户环境重新保存',
  STORAGE: '妙手数据无法保存或读取，请检查数据目录后重试', AUTH: '妙手身份验证失败，请检查 AppKey、AppSecret 和电脑时间',
  PERMISSION: '妙手应用没有公共采集箱接口权限，请在妙手开放平台检查授权', LIMIT: '妙手请求过于频繁，请稍后重试',
  NETWORK: '妙手网络连接失败，请检查网络后重试', TIMEOUT: '妙手请求超时，请稍后重试', RESPONSE: '妙手返回的数据格式不受支持，请核对来源商品后重试',
  TOO_MANY_SKUS: '妙手商品超过 200 个 SKU，暂不支持导入；未截断或保存商品', TOO_LARGE: '妙手返回的数据过大，未截断或保存商品',
  CHANGED: '妙手配置或模式已变化，请重新查询并预览', PREVIEW: '妙手预览已失效，请重新预览商品', CLOSED: '妙手服务已关闭，请重新打开工作台', BUSY: '妙手已有请求正在进行，请稍后重试',
} as const;
export interface MiaoshouRateLimit { window: 'second' | 'minute' | 'day' | 'unknown'; retryAfterMs?: number }
export class MiaoshouError extends UserFacingError {
  readonly code: keyof typeof ERRORS;
  readonly rateLimit?: MiaoshouRateLimit;
  constructor(code: keyof typeof ERRORS, rateLimit?: MiaoshouRateLimit) {
    super(rateLimit?.window === 'day' ? '妙手每日调用额度已用尽，已暂停读取；请待额度恢复后重试' : ERRORS[code]);
    this.code = code; this.rateLimit = rateLimit;
  }
}
export function fail(code: keyof typeof ERRORS = 'RESPONSE'): never { throw new MiaoshouError(code); }
export function object(raw: unknown, code: keyof typeof ERRORS = 'RESPONSE'): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail(code);
  return raw as Record<string, unknown>;
}
export function exact(raw: unknown, keys: readonly string[], code: keyof typeof ERRORS = 'RESPONSE'): Record<string, unknown> {
  const value = object(raw, code); if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return fail(code); return value;
}
export function text(raw: unknown, max: number, required = false): string {
  if (typeof raw !== 'string' || raw.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(raw)) return fail();
  const value = raw.trim(); if (required && !value) return fail(); return value;
}
export const optionalText = (raw: unknown, max: number): string => raw === undefined || raw === null ? '' : text(raw, max);
export function array(raw: unknown, max: number): unknown[] { if (!Array.isArray(raw)) return fail(); if (raw.length > max) return fail('TOO_LARGE'); return raw; }
export function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) fail(); }
export function uuid(raw: unknown): string { const value = text(raw, 36, true); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) return fail('INPUT'); return value; }
export function remoteId(raw: unknown): string {
  if (typeof raw === 'number') { if (!Number.isSafeInteger(raw) || raw < 0) return fail(); return String(raw); }
  const value = text(raw, 128, true); if (!/^[A-Za-z0-9_.:-]+$/.test(value)) return fail(); return value;
}
export function timestamp(raw: unknown): string {
  const value = text(raw, 24, true); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return fail(); return value;
}
function expandNumber(value: number): string {
  const source = String(value); if (!/[eE]/.test(source)) return source;
  const [coefficient, exponentText] = source.split('e'), [integer, fraction = ''] = coefficient.split('.');
  const digits = integer + fraction, point = integer.length + Number(exponentText);
  return point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
}
export function decimal(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && (!Number.isFinite(raw) || raw < 0 || raw > Number.MAX_SAFE_INTEGER)) return fail();
  const value = typeof raw === 'number' ? expandNumber(raw) : text(raw, 37, true);
  if (!/^\d{1,18}(?:\.\d{1,18})?$/.test(value)) return fail(); return value;
}
export function localPrice(raw: string | null): string { return raw !== null && /^\d{1,8}(?:\.\d{1,4})?$/.test(raw) ? raw : ''; }
export function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function safeUrl(raw: unknown, mode: 'demo' | 'live' = 'live'): string {
  const value = optionalText(raw, 2048); if (!value) return '';
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || /[\\\s]/.test(value) || host.endsWith('.') || !host.includes('.')) return '';
    // Literal IPs are unnecessary for supplier URLs and can disguise private targets.
    if (isIP(host.replace(/^\[|\]$/g, '')) || /^\d+(?:\.\d+)*$/.test(host) || /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|corp|lan|home|home\.arpa|onion|test)$/.test(host)) return '';
    if (host.endsWith('.invalid') && !(mode === 'demo' && (host === 'demo.invalid' || host.endsWith('.demo.invalid')))) return '';
    if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return '';
    for (const key of url.searchParams.keys()) if (/(?:token|cookie|auth|secret|signature|credential|session|password|key)/i.test(key)) return '';
    return url.href;
  } catch { return ''; }
}
export const WARNINGS = {
  title: '来源标题缺失，请补充商品名称', skus: '来源未提供 SKU 明细，已保留单品资料，规格待核对', sources: '来源链接缺失或不可用，请核对来源商品',
  images: '来源未提供可用图片', remoteImages: '图片仅保留来源链接，尚未下载到素材库', unsafeUrl: '部分来源或图片链接不符合安全要求，已排除',
  price: '价格字段口径及币种未知，默认不填采购价', precision: '来源价格精度或范围超出本地采购价支持范围，已保留原值并留空采购价',
  stock: '来源库存为供应商库存，未作为本地可售库存', specs: 'SKU 与规格的对应关系尚未确认，请逐项选择后核对',
  package: '来源重量及包装尺寸仅保留在快照中，不作为产品尺寸事实', demo: '演示商品为虚构测试资料，不能作为真实商品事实使用',
} as const;
const WARNING_VALUES: readonly string[] = Object.values(WARNINGS);
export const DIMENSIONS: readonly MiaoshouDimensionId[] = ['color', 'size', 'third'];
export function validateProduct(raw: unknown, mode: 'demo' | 'live'): MiaoshouProduct {
  // Omit the new optional text when reading old receipts: their fingerprints must remain unchanged.
  const hasDetail = Object.hasOwn(object(raw), 'detailText');
  const p = exact(raw, ['remoteId', 'title', 'description', 'capturedAt', 'sources', 'attributes', 'dimensions', 'skus', 'images', 'warnings', ...(hasDetail ? ['detailText'] : [])]);
  const sources = array(p.sources, 20).map(rawSource => {
    const s = exact(rawSource, ['sourceItemId', 'source', 'sourceSite', 'sourceItemUrl']); const url = text(s.sourceItemUrl, 2048);
    if (url && safeUrl(url, mode) !== url) return fail();
    return { sourceItemId: text(s.sourceItemId, 128), source: text(s.source, 100), sourceSite: text(s.sourceSite, 200), sourceItemUrl: url };
  });
  const attributes = array(p.attributes, 100).map(rawAttribute => { const a = exact(rawAttribute, ['name', 'value']); return { name: text(a.name, 100, true), value: text(a.value, 4000) }; });
  const dimensions = array(p.dimensions, 3).map(rawDimension => {
    const d = exact(rawDimension, ['id', 'name', 'values']); if (!DIMENSIONS.includes(d.id as MiaoshouDimensionId)) return fail();
    const values = array(d.values, 200).map(rawValue => {
      const v = exact(rawValue, ['id', 'name', 'imageUrls']);
      const imageUrls = array(v.imageUrls, 200).map(rawUrl => { const url = text(rawUrl, 2048, true); if (safeUrl(url, mode) !== url) return fail(); return url; }); unique(imageUrls);
      return { id: text(v.id, 128, true), name: text(v.name, 500, true), imageUrls };
    }); unique(values.map(v => v.id)); return { id: d.id as MiaoshouDimensionId, name: text(d.name, 100, true), values };
  }); unique(dimensions.map(d => d.id));
  if (Array.isArray(p.skus) && p.skus.length > 200) return fail('TOO_MANY_SKUS');
  const skus = array(p.skus, 200).map(rawSku => {
    const s = exact(rawSku, ['key', 'itemNum', 'price', 'oriPrice', 'stock', 'oriStock', 'weight', 'packageLength', 'packageWidth', 'packageHeight']);
    const number = (key: string) => { if (s[key] !== null && typeof s[key] !== 'string') return fail(); const value = decimal(s[key]); if (value !== s[key]) return fail(); return value; };
    return { key: text(s.key, 128, true), itemNum: text(s.itemNum, 200), price: number('price'), oriPrice: number('oriPrice'), stock: number('stock'), oriStock: number('oriStock'), weight: number('weight'), packageLength: number('packageLength'), packageWidth: number('packageWidth'), packageHeight: number('packageHeight') };
  }); unique(skus.map(s => s.key));
  const images = array(p.images, 200).map(rawImage => {
    const i = exact(rawImage, ['id', 'url', 'role']), id = text(i.id, 64, true), url = text(i.url, 2048, true);
    if (!/^ms_[0-9a-f]{32}$/.test(id) || id !== `ms_${hash(url).slice(0, 32)}` || safeUrl(url, mode) !== url || !['main', 'gallery', 'detail'].includes(String(i.role))) return fail();
    return { id, url, role: i.role as 'main' | 'gallery' | 'detail' };
  }); unique(images.map(i => i.id)); unique(images.map(i => i.url));
  if (images.filter(i => i.role === 'main').length > 1 || dimensions.some(d => d.values.some(v => v.imageUrls.some(url => !images.some(i => i.url === url))))) return fail();
  const warnings = array(p.warnings, WARNING_VALUES.length).map(rawWarning => { const warning = text(rawWarning, 200, true); if (!WARNING_VALUES.includes(warning)) return fail(); return warning; }); unique(warnings);
  return { remoteId: remoteId(p.remoteId), title: text(p.title, 500), description: text(p.description, 20000), ...(hasDetail ? { detailText: text(p.detailText, 20000, true) } : {}), capturedAt: timestamp(p.capturedAt), sources, attributes, dimensions, skus, images, warnings };
}
export function parseMapping(raw: unknown, product: MiaoshouProduct): MiaoshouMapping {
  const m = exact(raw, ['priceField', 'currency', 'skus'], 'INPUT');
  if (!['none', 'price', 'oriPrice'].includes(String(m.priceField)) || !['unknown', 'CNY'].includes(String(m.currency))) return fail('INPUT');
  const skus = array(m.skus, 200).map(rawSku => {
    const s = exact(rawSku, ['sourceKey', 'dimensions'], 'INPUT'), sourceKey = text(s.sourceKey, 128, true), dims = object(s.dimensions, 'INPUT');
    if (!product.skus.some(sku => sku.key === sourceKey) || Object.keys(dims).some(key => !DIMENSIONS.includes(key as MiaoshouDimensionId))) return fail('INPUT');
    const dimensions: Partial<Record<MiaoshouDimensionId, string>> = {};
    for (const id of DIMENSIONS) if (Object.hasOwn(dims, id)) { const selected = text(dims[id], 128, true); if (!product.dimensions.find(d => d.id === id)?.values.some(v => v.id === selected)) return fail('INPUT'); dimensions[id] = selected; }
    return { sourceKey, dimensions };
  }); unique(skus.map(s => s.sourceKey)); if (skus.length !== product.skus.length) return fail('INPUT');
  return { priceField: m.priceField as MiaoshouMapping['priceField'], currency: m.currency as MiaoshouMapping['currency'], skus: skus.sort((a, b) => compare(a.sourceKey, b.sourceKey)) };
}
export function selectedImageIds(product: MiaoshouProduct, mapping: MiaoshouMapping, sourceKey: string): string[] {
  const selected = mapping.skus.find(s => s.sourceKey === sourceKey)!;
  const urls = new Set(product.dimensions.flatMap(d => d.values.find(v => v.id === selected.dimensions[d.id])?.imageUrls ?? []));
  return product.images.filter(image => urls.has(image.url)).map(image => image.id).sort(compare);
}
export function importWarnings(product: MiaoshouProduct, mapping: MiaoshouMapping): string[] {
  const warnings = new Set(product.warnings);
  if (product.skus.length && (product.dimensions.length === 0 || mapping.skus.some(s => product.dimensions.some(d => d.values.length && !s.dimensions[d.id])))) warnings.add(WARNINGS.specs);
  else warnings.delete(WARNINGS.specs);
  if (mapping.priceField !== 'none' && mapping.currency === 'CNY') {
    warnings.delete(WARNINGS.price);
    if (product.skus.some(s => s[mapping.priceField as 'price' | 'oriPrice'] !== null && !localPrice(s[mapping.priceField as 'price' | 'oriPrice']))) warnings.add(WARNINGS.precision);
  }
  return WARNING_VALUES.filter(w => warnings.has(w));
}
export function fingerprint(product: MiaoshouProduct, mapping: MiaoshouMapping, accountScope: string, mode: 'demo' | 'live'): string {
  const { capturedAt: _capturedAt, ...snapshot } = product;
  const content = { ...snapshot, skus: [...snapshot.skus].sort((a, b) => compare(a.key, b.key)), dimensions: [...snapshot.dimensions].sort((a, b) => compare(a.id, b.id)).map(d => ({ ...d, values: [...d.values].sort((a, b) => compare(a.id, b.id)) })) };
  return hash(canonical({ accountScope, mode, snapshot: content, mapping: { ...mapping, skus: [...mapping.skus].sort((a, b) => compare(a.sourceKey, b.sourceKey)) } }));
}
export function validateMiaoshouReceipt(raw: unknown): MiaoshouReceipt {
  const hasNormalizations = Object.hasOwn(object(raw), 'factNormalizations');
  const r = exact(raw, ['id', 'productId', 'fingerprint', 'accountScope', 'mode', 'receivedAt', 'snapshot', 'mapping', 'skuMappings', ...(hasNormalizations ? ['factNormalizations'] : [])]);
  if (r.mode !== 'demo' && r.mode !== 'live') return fail(); const mode = r.mode;
  const accountScope = text(r.accountScope, 64, true); if (!/^[0-9a-f]{64}$/.test(accountScope)) return fail();
  const snapshot = validateProduct(r.snapshot, mode), mapping = parseMapping(r.mapping, snapshot);
  if (canonical(snapshot) !== canonical(r.snapshot) || canonical(mapping) !== canonical(r.mapping)) return fail();
  const expectedFingerprint = fingerprint(snapshot, mapping, accountScope, mode); if (r.fingerprint !== expectedFingerprint) return fail();
  const skuMappings = array(r.skuMappings, 200).map(rawMapping => {
    const m = exact(rawMapping, ['sourceKey', 'localVariantId', 'imageIds']), sourceKey = text(m.sourceKey, 128, true);
    if (!snapshot.skus.some(s => s.key === sourceKey)) return fail();
    const imageIds = array(m.imageIds, 200).map(id => text(id, 64, true)); unique(imageIds);
    if (canonical([...imageIds].sort(compare)) !== canonical(selectedImageIds(snapshot, mapping, sourceKey))) return fail();
    return { sourceKey, localVariantId: uuid(m.localVariantId), imageIds };
  });
  unique(skuMappings.map(m => m.sourceKey)); unique(skuMappings.map(m => m.localVariantId));
  const id = uuid(r.id), productId = uuid(r.productId); unique([id, productId, ...skuMappings.map(m => m.localVariantId)]);
  if (skuMappings.length !== snapshot.skus.length) return fail();
  let factNormalizations: SourceAttributeNormalizations | undefined;
  if (hasNormalizations) {
    const record = exact(r.factNormalizations, ['version', 'entries']);
    if (record.version !== 'source-attribute-normalization/v1') return fail();
    const expected = snapshot.attributes.flatMap((attribute, attributeIndex) => {
      const normalized = normalizeSourceAttributeV1(attribute);
      return normalized.ruleIds.length ? [{ attributeIndex, rawName: attribute.name, rawValue: attribute.value, ...normalized }] : [];
    });
    const entries = array(record.entries, 100);
    if (!expected.length || entries.length !== expected.length) return fail();
    const validated = entries.map((rawEntry, index) => {
      const entry = exact(rawEntry, ['factId', 'attributeIndex', 'rawName', 'rawValue', 'name', 'value', 'ruleIds']);
      const factId = uuid(entry.factId), wanted = expected[index];
      if (canonical(entry) !== canonical({ factId, ...wanted })) return fail();
      return { factId, ...wanted };
    });
    unique([id, productId, ...skuMappings.map(m => m.localVariantId), ...validated.map(entry => entry.factId)]);
    factNormalizations = { version: 'source-attribute-normalization/v1', entries: validated };
  }
  return { id, productId, fingerprint: expectedFingerprint, accountScope, mode, receivedAt: timestamp(r.receivedAt), snapshot, mapping, skuMappings, ...(factNormalizations ? { factNormalizations } : {}) };
}
