import { createHash } from 'node:crypto';
import { UserFacingError } from '../../shared/errors.ts';
import type { AmazonTarget, JsonObject, JsonValue, SchemaSelection } from '../../shared/amazon-contracts.ts';

import { AMAZON_MARKETPLACES as MARKETPLACES } from '../../shared/amazon-marketplaces.ts';
export function marketplace(id: string, region: string): string {
  const entry = MARKETPLACES[id];
  if (!entry || entry[0] !== region) throw new UserFacingError('站点 ID 与 Amazon 区域不匹配或尚未支持');
  return entry[1];
}
export function object(value: unknown, label = '参数'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new UserFacingError(`${label}必须是 JSON 对象`);
  return value as Record<string, unknown>;
}
export function textField(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new UserFacingError(`${label}格式无效`);
  return value.trim();
}
export function selection(input: unknown): SchemaSelection {
  const value = object(input);
  const targetId = textField(value.targetId, '店铺 ID', 100);
  const productType = textField(value.productType, '商品类型', 100);
  if (!/^[A-Z0-9][A-Z0-9_]{0,99}$/.test(productType)) throw new UserFacingError('商品类型格式无效');
  if (typeof value.parentageLevel !== 'string' || !['NONE', 'PARENT', 'CHILD'].includes(value.parentageLevel)) throw new UserFacingError('父子层级无效');
  if (typeof value.requirements !== 'string' || !['LISTING', 'LISTING_PRODUCT_ONLY', 'LISTING_OFFER_ONLY'].includes(value.requirements)) throw new UserFacingError('上架要求集无效');
  const locale = textField(value.locale, '语言', 16);
  if (!/^(DEFAULT|[a-z]{2}(?:_[A-Z]{2})?)$/.test(locale)) throw new UserFacingError('语言格式无效');
  return { targetId, productType, parentageLevel: value.parentageLevel as SchemaSelection['parentageLevel'], requirements: value.requirements as SchemaSelection['requirements'], locale };
}
export function schemaKey(target: AmazonTarget, input: SchemaSelection): string {
  return createHash('sha256').update(JSON.stringify([target.id, target.mode, target.sellerId, target.marketplaceId, input.locale, input.productType, input.requirements, input.parentageLevel])).digest('hex');
}
export function listingHash(target: Pick<AmazonTarget, 'mode' | 'sellerId' | 'marketplaceId'>, sku: string): string {
  return createHash('sha256').update(JSON.stringify([target.mode, target.sellerId, target.marketplaceId, sku])).digest('hex');
}
export function attributesObject(value: unknown): JsonObject {
  object(value, 'attributes');
  let size = 0;
  function inspect(node: unknown, depth: number): void {
    if (depth > 50) throw new UserFacingError('attributes 嵌套超过限制');
    if (node === null || typeof node === 'boolean') return;
    if (typeof node === 'number') { if (!Number.isFinite(node)) throw new UserFacingError('attributes 数字无效'); return; }
    if (typeof node === 'string') { size += Buffer.byteLength(node); if (size > 2 * 1024 * 1024) throw new UserFacingError('attributes 超过 2 MB'); return; }
    if (Array.isArray(node)) { for (const child of node) inspect(child, depth + 1); return; }
    const obj = object(node, 'attributes');
    for (const [key, child] of Object.entries(obj)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new UserFacingError('attributes 包含不允许的字段');
      size += key.length; inspect(child, depth + 1);
    }
  }
  inspect(value, 0); const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new UserFacingError('attributes 超过 2 MB');
  return JSON.parse(encoded) as JsonObject;
}
export function clone<T>(value: T): T { return structuredClone(value); }
export function isObject(value: JsonValue | unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
