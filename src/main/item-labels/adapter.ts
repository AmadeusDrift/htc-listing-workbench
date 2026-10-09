import { DEFAULT_ITEM_LABEL_FORMAT, ITEM_LABEL_PAGE_TYPES } from '../../shared/item-label-contracts.ts';
import type { ItemLabelFormat } from '../../shared/item-label-contracts.ts';
import type { JsonObject } from '../../shared/amazon-contracts.ts';
import { record, text } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';

export function validateItemLabelFormat(raw: unknown = DEFAULT_ITEM_LABEL_FORMAT): ItemLabelFormat {
  const v = record(raw, '标签格式', ['labelType','pageType','width','height','localeCode']);
  const localeCode = text(v.localeCode, '标签语言', 5, true);
  if (!/^[a-z]{2}_[A-Z]{2}$/.test(localeCode)) throw new UserFacingError('标签语言格式无效');
  if (v.labelType === 'STANDARD_FORMAT' && ITEM_LABEL_PAGE_TYPES.includes(v.pageType as never) && !('width' in v) && !('height' in v)) return { labelType: v.labelType, pageType: v.pageType as typeof ITEM_LABEL_PAGE_TYPES[number], localeCode };
  if (v.labelType === 'THERMAL_PRINTING' && !('pageType' in v) && [v.width,v.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 25 && n <= 100)) return { labelType: v.labelType, width: v.width as number, height: v.height as number, localeCode };
  throw new UserFacingError('标签格式无效；热敏宽高必须为 25–100 毫米');
}
export function itemLabelRequest(marketplaceId: string, sku: string, quantity: number, format: ItemLabelFormat): JsonObject {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) throw new UserFacingError('商品标签数量必须为 1–10000 个销售单位');
  return { ...validateItemLabelFormat(format), marketplaceId: text(marketplaceId, '站点', 20, true), mskuQuantities: [{ msku: text(sku, 'SKU', 255, true), quantity }] };
}
export function validateItemLabelRequest(raw: unknown, marketplaceId: string): JsonObject {
  const v = record(raw, '标签请求', ['marketplaceId','mskuQuantities','labelType','pageType','width','height','localeCode']);
  if (v.marketplaceId !== marketplaceId || !Array.isArray(v.mskuQuantities) || v.mskuQuantities.length !== 1) throw new UserFacingError('商品标签请求上下文不匹配');
  const item = record(v.mskuQuantities[0], '标签 SKU', ['msku','quantity']);
  const { marketplaceId: _marketplaceId, mskuQuantities: _items, ...format } = v;
  return itemLabelRequest(marketplaceId, text(item.msku, 'SKU', 255, true), item.quantity as number, validateItemLabelFormat(format));
}
export function itemLabelDownloads(raw: unknown, now = Date.now()): { uri: string; expiration: number }[] {
  const v = record(raw, '标签响应');
  if (!Array.isArray(v.documentDownloads) || !v.documentDownloads.length || v.documentDownloads.length > 100) throw new UserFacingError('Amazon 没有返回完整标签文件列表');
  const seen = new Set<string>();
  return v.documentDownloads.map(raw => {
    const d = record(raw, '标签下载');
    if (d.downloadType !== 'URL' || typeof d.uri !== 'string' || d.uri.length > 16384) throw new UserFacingError('Amazon 标签下载描述无效');
    let u: URL; try { u = new URL(d.uri); } catch { throw new UserFacingError('Amazon 标签下载地址无效'); }
    // URLs are transient capabilities received directly from the authenticated Amazon API.
    // No hostname or bucket is granted general trust, and redirects are never followed.
    const amazonHost = /^(?:[a-z0-9-]+\.)*amazon\.com$/.test(u.hostname);
    const s3Host = /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(u.hostname);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !(amazonHost || s3Host) || seen.has(u.href)) throw new UserFacingError('Amazon 标签下载来源无效');
    const expiration = d.expiration === undefined ? now + 15 * 60_000 : Date.parse(String(d.expiration));
    if (!Number.isFinite(expiration) || expiration <= now) throw new UserFacingError('Amazon 标签下载地址已过期');
    seen.add(u.href); return { uri: u.href, expiration: Math.min(expiration, now + 24 * 60 * 60_000) };
  });
}
