import { UserFacingError } from '../../shared/errors.ts';
import { identifier } from '../../shared/validation.ts';
import type { AmazonSchema, JsonValue, PrepareAmazonDraftsInput } from '../../shared/amazon-contracts.ts';
import { attributesObject, object, selection } from './context.ts';
import { listingProgram } from './listing-program.ts';

export const PREPARATION_MAX_BYTES = 2 * 1024 * 1024;

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new UserFacingError(`${label}字段无效，请提供完整的批量准备参数`);
}

/** Parse every item before any schema lookup or draft mutation. */
export function preparationInput(input: unknown, allowFamilies = false): PrepareAmazonDraftsInput {
  const value = object(input);
  exactKeys(value, ['targetId', 'productType', 'parentageLevel', 'requirements', 'locale', 'items', ...(Object.hasOwn(value, 'listingProgram') ? ['listingProgram'] : [])], '批量准备');
  const program = listingProgram(value.listingProgram);
  const selected = selection(value); identifier(value.targetId);
  if (selected.parentageLevel !== 'NONE' && !allowFamilies) throw new UserFacingError('父子变体须由自动销售组合流程按当前 Schema 准备');
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 50) throw new UserFacingError('批量准备必须包含 1–50 个 SKU');
  const references = new Set<string>(); let bytes = 0;
  const items = Array.from(value.items, raw => {
    const item = object(raw, 'SKU'); exactKeys(item, ['productId', 'productRevision', 'variantId', 'attributes'], 'SKU');
    const productId = identifier(item.productId); const variantId = identifier(item.variantId);
    if (!Number.isSafeInteger(item.productRevision) || Number(item.productRevision) < 1) throw new UserFacingError('来源商品版本必须是正整数');
    const key = JSON.stringify([productId, variantId]);
    if (references.has(key)) throw new UserFacingError('批量准备包含重复的商品 / SKU 引用');
    references.add(key);
    const attributes = attributesObject(item.attributes);
    bytes += Buffer.byteLength(JSON.stringify(attributes));
    if (bytes > PREPARATION_MAX_BYTES) throw new UserFacingError('批量准备 attributes 合计超过 2 MB');
    return { productId, variantId, productRevision: item.productRevision as number, attributes };
  });
  return { ...selected, listingProgram: program, items };
}

/** JSON object member order is not part of a configured value's identity. */
export function semanticJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(semanticJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${semanticJson(value[key])}`).join(',')}}`;
}

export function preparationSchemaIdentity(snapshot: AmazonSchema): string {
  const { key, targetId, mode, productType, parentageLevel, requirements, locale, checksum, version, schema, metaSchema } = snapshot;
  return semanticJson({ key, targetId, mode, productType, parentageLevel, requirements, locale, checksum, version, schema, metaSchema });
}
