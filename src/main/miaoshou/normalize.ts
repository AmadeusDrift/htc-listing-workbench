import type { MiaoshouDimension, MiaoshouList, MiaoshouProduct, MiaoshouSourceLink, MiaoshouSourceSku } from '../../shared/miaoshou-contracts.ts';
import { sourceProductUrl } from '../../shared/source-links.ts';
import { array, compare, decimal, fail, hash, MiaoshouError, object, optionalText, remoteId, safeUrl, text, unique, validateProduct, WARNINGS } from './validation.ts';

export type TextSanitizer = (value: string) => string;
const unchanged: TextSanitizer = value => value;

export function responseData(raw: unknown): Record<string, unknown> {
  const envelope = object(raw);
  if (envelope.result !== 'success' || envelope.code !== 'success') {
    const code = typeof envelope.code === 'string' ? envelope.code.toLowerCase() : '';
    if (/appnopermission|permission/.test(code)) return fail('PERMISSION');
    if (/limit|frequen|toomany/.test(code)) throw new MiaoshouError('LIMIT', {
      window: /qpd/.test(code) ? 'day' : /qpm/.test(code) ? 'minute' : /qps/.test(code) ? 'second' : 'unknown',
    });
    if (/auth|sign|appkey|appsecret|token|unauthor/.test(code)) return fail('AUTH');
    return fail();
  }
  return object(envelope.data);
}
function values(raw: unknown, max: number, sanitize: TextSanitizer): [string, Record<string, unknown>][] {
  // The live API also serializes absent maps as []; populated arrays have no stable source keys.
  if (raw === undefined || raw === null || Array.isArray(raw) && raw.length === 0) return [];
  const map = object(raw), entries = Object.entries(map); if (entries.length > max) return fail(max === 200 ? 'TOO_MANY_SKUS' : 'TOO_LARGE');
  return entries.map(([key, value]) => [sanitize(text(key, 128, true)), object(value)] as [string, Record<string, unknown>]).sort((a, b) => compare(a[0], b[0]));
}
function sanitizedUrl(raw: string, mode: 'demo' | 'live', sanitize: TextSanitizer): string {
  const url = safeUrl(decodeEntities(raw), mode); if (!url || sanitize(url) !== url) return '';
  // A credential hidden in percent encoding must not remain in a fetchable URL either.
  try { const decoded = decodeURIComponent(url); if (sanitize(decoded) !== decoded) return ''; } catch { return ''; }
  return url;
}
function sourceLinks(raw: unknown, mode: 'demo' | 'live', warnings: Set<string>, sanitize: TextSanitizer): MiaoshouSourceLink[] {
  return array(raw ?? [], 20).map(value => {
    const s = object(value), url = optionalText(s.sourceItemUrl, 2048);
    const source = cleanText(s.source, 100, sanitize), sourceItemId = cleanText(s.sourceItemId, 128, sanitize);
    // 1688 frequently supplies HTTP/tracking links; preserve product identity using an HTTPS offer URL.
    // Never reintroduce credential-bearing text removed by the sanitizer.
    const candidate = sanitize(url) === url ? sourceProductUrl({ source, sourceItemId, sourceItemUrl: url }) : '';
    const sourceItemUrl = sanitizedUrl(source === '1688' ? candidate : url, mode, sanitize);
    if (url && !sourceItemUrl) warnings.add(WARNINGS.unsafeUrl);
    return { sourceItemId, source, sourceSite: cleanText(s.sourceSite, 200, sanitize), sourceItemUrl };
  });
}
function decodeEntities(source: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return source.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}
function plainText(source: string): string {
  return decodeEntities(source).replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?(?:p|div|br|li|h[1-6]|tr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function cleanText(raw: unknown, max: number, sanitize: TextSanitizer, required = false): string {
  const source = required ? text(raw, max, true) : optionalText(raw, max);
  // HTML decoding and tag removal may join fragments into a credential; scrub only after both.
  return text(sanitize(plainText(source)), max, required);
}
export function normalizeDetail(raw: unknown, capturedAt: string, mode: 'demo' | 'live' = 'live', sanitize: TextSanitizer = unchanged): MiaoshouProduct {
  const p = object(responseData(raw).editCommonCollectBoxDetail), warnings = new Set<string>([WARNINGS.price, WARNINGS.stock, WARNINGS.specs]);
  const images: MiaoshouProduct['images'] = [];
  let imageReferences = 0;
  const imageUrl = (rawUrl: unknown, role: 'main' | 'gallery' | 'detail'): string => {
    if (++imageReferences > 2000) return fail('TOO_LARGE');
    const value = optionalText(rawUrl, 2048), url = sanitizedUrl(value, mode, sanitize); if (!url) { if (value) warnings.add(WARNINGS.unsafeUrl); return ''; }
    if (!images.some(i => i.url === url)) { if (images.length >= 200) return fail('TOO_LARGE'); images.push({ id: `ms_${hash(url).slice(0, 32)}`, url, role }); } return url;
  };
  array(p.imgUrls ?? [], 200).forEach((url, index) => imageUrl(url, index === 0 ? 'main' : 'gallery'));
  const dimensions: MiaoshouDimension[] = [];
  for (const [id, mapName, propName, fallback] of [['color', 'colorMap', 'colorPropName', '颜色'], ['size', 'sizeMap', 'sizePropName', '尺寸'], ['third', 'saleProp3Map', 'saleProp3Name', '第三规格']] as const) {
    const candidates = values(p[mapName], 200, sanitize); if (!candidates.length) continue;
    dimensions.push({ id, name: cleanText(p[propName], 100, sanitize) || fallback, values: candidates.map(([key, value]) => {
      const urls = [...array(value.imgUrls ?? [], 200), ...(value.imgUrl ? [value.imgUrl] : [])].map(url => imageUrl(url, 'gallery')).filter(Boolean);
      return { id: key, name: cleanText(value.name, 500, sanitize, true), imageUrls: [...new Set(urls)] };
    }) });
  }
  const notesText = optionalText(p.notesText, 20000), notes = optionalText(p.notes, 20000), description = cleanText(notesText || notes, 20000, sanitize);
  const detailText = cleanText(notes, 20000, sanitize);
  // Only image src attributes are recognized; account maps and every other HTML attribute are discarded.
  for (const match of notes.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) imageUrl(match[1] ?? match[2], 'detail');
  const readSku = (key: string, sku: Record<string, unknown>): MiaoshouSourceSku => ({ key, itemNum: cleanText(sku.itemNum, 200, sanitize), price: decimal(sku.price), oriPrice: decimal(sku.oriPrice), stock: decimal(sku.stock), oriStock: decimal(sku.oriStock), weight: decimal(sku.weight), packageLength: decimal(sku.packageLength), packageWidth: decimal(sku.packageWidth), packageHeight: decimal(sku.packageHeight) });
  const skuEntries = values(p.skuMap, 200, sanitize); const skus = skuEntries.map(([key, value]) => readSku(key, value));
  if (!skus.length) { warnings.add(WARNINGS.skus); skus.push(readSku('__single_product__', p)); }
  const attributes = array(p.sourceAttrs ?? [], 100).map(rawAttribute => { const a = object(rawAttribute); return { name: cleanText(a.name, 100, sanitize, true), value: cleanText(a.value, 4000, sanitize) }; });
  const sources = sourceLinks(p.sourceList, mode, warnings, sanitize), title = cleanText(p.title, 500, sanitize);
  if (!title) warnings.add(WARNINGS.title); if (!sources.some(s => s.sourceItemUrl)) warnings.add(WARNINGS.sources);
  warnings.add(images.length ? WARNINGS.remoteImages : WARNINGS.images);
  if (skus.some(s => [s.weight, s.packageLength, s.packageWidth, s.packageHeight].some(n => n !== null))) warnings.add(WARNINGS.package);
  if (mode === 'demo') warnings.add(WARNINGS.demo);
  return validateProduct({ remoteId: sanitize(remoteId(p.commonCollectBoxDetailId)), title, description, ...(detailText && detailText !== description ? { detailText } : {}), capturedAt, sources, attributes, dimensions, skus, images, warnings: Object.values(WARNINGS).filter(w => warnings.has(w)) }, mode);
}
export function normalizeList(raw: unknown, pageNo: number, pageSize: number, mode: 'demo' | 'live', sanitize: TextSanitizer = unchanged, deduplicate = false): MiaoshouList {
  const data = responseData(raw); if (!Number.isSafeInteger(data.total) || Number(data.total) < 0) return fail();
  const items = array(data.detailList, pageSize).map(rawItem => {
    const item = object(rawItem), sources = sourceLinks(item.sourceList, mode, new Set(), sanitize), source = sources.find(s => s.sourceItemUrl) ?? sources[0];
    return { id: remoteId(sanitize(remoteId(item.commonCollectBoxDetailId))), title: cleanText(item.title, 500, sanitize), sourceUrl: source?.sourceItemUrl ?? '', sourceName: source?.source || source?.sourceSite || '', minPrice: decimal(item.minSkuPrice ?? item.price), maxPrice: decimal(item.maxSkuPrice ?? item.price), updatedAt: cleanText(item.gmtModified, 100, sanitize), status: cleanText(item.status, 100, sanitize) };
  }); if (!deduplicate) unique(items.map(i => i.id)); if (items.length > Number(data.total)) return fail();
  return { mode, pageNo, pageSize, total: Number(data.total), items: deduplicate ? [...new Map(items.map(item => [item.id, item])).values()] : items };
}
