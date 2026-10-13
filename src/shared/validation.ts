import { UserFacingError } from './errors.ts';
import type { AssetUpdateInput, Fact, ProductMutation, SaveProductInput, VariantInput } from './contracts.ts';

export function record(value: unknown, label: string, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserFacingError(`${label}格式不正确`);
  const result = value as Record<string, unknown>;
  if (allowed && Object.keys(result).some(key => !allowed.includes(key))) throw new UserFacingError(`${label}含有不支持的字段`);
  return result;
}
export function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new UserFacingError(`${label}格式不正确或过长`);
  const result = value.trim();
  if (required && !result) throw new UserFacingError(`请填写${label}`);
  return result;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new UserFacingError('记录 ID 无效');
  return value.toLowerCase();
}
function member<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new UserFacingError(`${label}无效`);
  return value as T;
}
function list(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new UserFacingError(`${label}必须为数组且最多 ${max} 项`);
  return value;
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new UserFacingError(`${label}不能重复`);
}
export function parseMutation(value: unknown): ProductMutation {
  const o = record(value, '操作参数');
  if (!Number.isSafeInteger(o.revision) || (o.revision as number) < 1) throw new UserFacingError('商品版本无效，请重新加载');
  return { productId: identifier(o.productId), revision: o.revision as number };
}
export function parseVariant(value: unknown): VariantInput {
  const o = record(value, 'SKU', ['id', 'sku', 'originalSpec', 'normalizedSpec', 'purchasePrice', 'inventory']);
  const price = text(o.purchasePrice, '采购价', 20);
  if (price && !/^\d{1,8}(?:\.\d{1,4})?$/.test(price)) throw new UserFacingError('采购价请填写非负数，最多保留 4 位小数');
  if (o.inventory !== null && (!Number.isSafeInteger(o.inventory) || (o.inventory as number) < 0 || (o.inventory as number) > 999999999)) throw new UserFacingError('库存请填写非负整数或留空');
  return { id: identifier(o.id), sku: text(o.sku, 'SKU', 100, true), originalSpec: text(o.originalSpec, '原始规格', 2000),
    normalizedSpec: text(o.normalizedSpec, '整理后规格', 2000), purchasePrice: price, inventory: o.inventory as number | null };
}
export function parseFact(value: unknown): Fact {
  const o = record(value, '商品事实', ['id', 'name', 'value', 'source', 'sourceRef', 'state', 'scope', 'variantId']);
  if(o.variantId!==undefined&&o.scope!=='variant')throw new UserFacingError('只有逐规格事实可绑定 SKU');
  return { ...(o.scope!==undefined?{scope:member(o.scope,['common','variant','unknown'] as const,'事实范围')} : {}), ...(o.variantId!==undefined?{variantId:identifier(o.variantId)}:{}), id: identifier(o.id), name: text(o.name, '事实名称', 100, true), value: text(o.value, '事实值', 4000),
    source: member(o.source, ['manual', '1688', 'import', 'ai'], '事实来源'), sourceRef: text(o.sourceRef, '来源位置', 2000),
    state: member(o.state, ['source_confirmed', 'human_confirmed', 'missing', 'ai_suggested', 'conflicting'], '事实状态') };
}
export function parseSaveProduct(value: unknown): SaveProductInput {
  const o = record(value, '商品', ['id', 'revision', 'title', 'sourceUrl', 'description', 'status', 'variants', 'facts']);
  const mutation = parseMutation({ productId: o.id, revision: o.revision });
  const sourceUrl = text(o.sourceUrl, '来源链接', 2048);
  if (sourceUrl) {
    let url: URL;
    try { url = new URL(sourceUrl); } catch { throw new UserFacingError('来源链接请填写完整的 http 或 https 地址'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new UserFacingError('来源链接只支持不含登录凭据的 http 或 https 地址');
  }
  const variants = list(o.variants, 'SKU', 200).map(parseVariant);
  const facts = list(o.facts, '事实', 100).map(parseFact);
  unique(variants.map(v => v.id), 'SKU ID'); unique(variants.map(v => v.sku.toLowerCase()), 'SKU'); unique(facts.map(f => f.id), '事实 ID');
  return { id: mutation.productId, revision: mutation.revision, title: text(o.title, '商品标题', 500, true), sourceUrl,
    description: text(o.description, '商品备注', 20000), status: member(o.status, ['draft', 'ready', 'archived'], '商品状态'), variants, facts };
}
export function parseAssetUpdate(value: unknown): AssetUpdateInput {
  const o = record(value, '图片关联', ['productId', 'revision', 'assetId', 'role', 'variantIds']);
  const variantIds = list(o.variantIds, '图片关联 SKU', 200).map(identifier);
  unique(variantIds, '图片关联 SKU');
  return { ...parseMutation(o), assetId: identifier(o.assetId), role: member(o.role, ['main', 'gallery', 'detail'], '图片角色'), variantIds };
}
