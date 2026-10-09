import { createHash } from 'node:crypto';
import type { CategoryLibrary } from '../../shared/catalog-contracts.ts';
import { record, text } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';

export function categoryKey(value: Pick<CategoryLibrary, 'targetId' | 'sellerId' | 'marketplaceId' | 'mode' | 'locale'>): string {
  return createHash('sha256').update(JSON.stringify([value.targetId, value.sellerId, value.marketplaceId, value.mode, value.locale])).digest('hex');
}
export function validateCategoryLibrary(raw: unknown): CategoryLibrary {
  const v = record(raw, '类目缓存', ['id','targetId','sellerId','marketplaceId','locale','mode','kind','fetchedAt','productTypes']);
  if (v.kind !== 'product-types-v1' || !['demo','live'].includes(String(v.mode)) || !Array.isArray(v.productTypes) || !v.productTypes.length || v.productTypes.length > 20000) throw new UserFacingError('类目缓存格式无效');
  const fetchedAt = text(v.fetchedAt, '同步时间', 24, true);
  if (!Number.isFinite(Date.parse(fetchedAt)) || new Date(fetchedAt).toISOString() !== fetchedAt) throw new UserFacingError('类目同步时间无效');
  const productTypes = v.productTypes.map(rawType => {
    const row = record(rawType, '产品类型', ['name','displayName']), name = text(row.name, '产品类型', 100, true);
    if (!/^[A-Z0-9][A-Z0-9_]{0,99}$/.test(name)) throw new UserFacingError('产品类型编码无效');
    return { name, displayName: text(row.displayName, '产品类型名称', 300, true) };
  });
  if (new Set(productTypes.map(item => item.name)).size !== productTypes.length) throw new UserFacingError('类目缓存包含重复产品类型');
  const value: CategoryLibrary = { id: text(v.id, '缓存 ID', 64, true), targetId: text(v.targetId, '店铺 ID', 100, true), sellerId: text(v.sellerId, '卖家 ID', 100, true),
    marketplaceId: text(v.marketplaceId, '站点', 100, true), locale: text(v.locale, '语言', 30, true), mode: v.mode as CategoryLibrary['mode'], kind: 'product-types-v1', fetchedAt, productTypes };
  if (value.id !== categoryKey(value) || Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw new UserFacingError('类目缓存身份不符或数据过大');
  return value;
}
