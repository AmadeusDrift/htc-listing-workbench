import type { AmazonSchema, JsonObject, JsonValue, ListingIssue, ListingProgram } from '../../shared/amazon-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { isObject } from './context.ts';
import { compileAttributesSchema } from './schema.ts';
import { resolveSchemaNode } from './field-catalog.ts';

export const HAUL_UNSUPPORTED_FIELDS = ['fulfillment_availability','externally_assigned_product_identifier','merchant_suggested_asin'] as const;
export const haulUnsupportedField = (program: ListingProgram | undefined, field: string) => program === 'haul' && (HAUL_UNSUPPORTED_FIELDS as readonly string[]).includes(field);
export function cleanHaulAttributes(program: ListingProgram | undefined, input: JsonObject) {
  const attributes=structuredClone(input),removed=Object.keys(attributes).filter(field=>haulUnsupportedField(program,field));
  for(const field of removed)delete attributes[field];
  return {attributes,removed};
}
export const haulCleanupReason = (fields: readonly string[]) => `已自动移除 Haul 官方不支持字段：${fields.join('、')}；其他内容和原始响应保留`;

export function listingProgram(value: unknown): ListingProgram {
  if (value === undefined) return 'standard';
  if (value !== 'haul' && value !== 'standard') throw new UserFacingError('上架项目类型无效，仅支持 haul 或 standard');
  return value;
}

type SchemaStep = { property: string } | { items: true };
function capabilitySchema(root: JsonObject, raw: JsonObject, path: SchemaStep[], depth = 0): JsonObject | null {
  if (depth > 64) throw new UserFacingError('Haul Schema 引用层级过深');
  const node = resolveSchemaNode(root, raw);
  if (!path.length) return node;
  const [step, ...remaining] = path;
  const child = 'property' in step ? isObject(node.properties) && Object.hasOwn(node.properties, step.property) ? node.properties[step.property] : undefined : node.items;
  const restrictions: JsonObject[] = [];
  if (isObject(child)) { const nested = capabilitySchema(root, child, remaining, depth + 1); if (nested) restrictions.push(nested); }
  // A reference and its siblings, or multiple allOf branches, constrain the same
  // location together. Do not choose a branch or overwrite one set of properties.
  if (Array.isArray(node.allOf)) for (const branch of node.allOf) {
    if (branch === false) throw new UserFacingError('Haul Schema 不允许此字段结构');
    if (isObject(branch)) { const nested = capabilitySchema(root, branch, path, depth + 1); if (nested) restrictions.push(nested); }
  }
  return restrictions.length === 0 ? null : restrictions.length === 1 ? restrictions[0] : { allOf: restrictions };
}

function supported(snapshot: AmazonSchema, field: string, property: string, value: JsonValue): boolean {
  try {
    const constraint = capabilitySchema(snapshot.schema, snapshot.schema, [{property:field},{items:true},{property}]);
    if (!constraint) return false;
    // Preserve the original reference scope for refs retained inside the resolved
    // scalar constraint. The full original PTD still validates complete drafts.
    const scope: JsonObject = {};
    for (const key of ['$schema', '$id', '$defs', 'definitions', 'properties']) if (snapshot.schema[key] !== undefined) scope[key] = snapshot.schema[key];
    scope.allOf = [constraint];
    return compileAttributesSchema(scope, snapshot.metaSchema)(value) === true;
  } catch { return false; }
}

export function listingProgramIssues(program: ListingProgram, snapshot: AmazonSchema, attributes?: JsonObject): ListingIssue[] {
  if (program === 'standard') return [];
  const issues: ListingIssue[] = [];
  const add = (code: string, message: string, attribute: string) => issues.push({ code, message, attributeNames: [attribute], severity: 'ERROR', category: 'field', source: 'local', autoFixable: false });
  if (program !== 'haul') { add('LISTING_PROGRAM_INVALID', '上架项目类型无效，请重新创建草稿', 'listingProgram'); return issues; }
  if (!supported(snapshot, 'is_value_stores_item', 'value', true)
    || supported(snapshot, 'is_value_stores_item', 'value', 'true')) {
    add('HAUL_SCHEMA_UNSUPPORTED', '当前 Schema 不支持 Haul 的 is_value_stores_item 布尔 true，不能回退到普通上架', 'is_value_stores_item');
  }
  // Amazon's PARENT schema describes a non-buyable relationship container and
  // may omit purchasable_offer entirely. Haul child offers still require BZR.
  const parent = snapshot.parentageLevel === 'PARENT';
  if (!parent && !supported(snapshot, 'purchasable_offer', 'audience', 'BZR')) add('HAUL_SCHEMA_UNSUPPORTED', '当前 Schema 不支持 Haul 的 BZR 报价受众，不能回退到普通上架', 'purchasable_offer');
  if (!attributes) return issues;
  for (const name of HAUL_UNSUPPORTED_FIELDS) {
    if (Object.hasOwn(attributes, name)) add('HAUL_FORBIDDEN_ATTRIBUTE', `Haul 草稿不能包含 ${name}`, name);
  }
  const flags = attributes.is_value_stores_item;
  if (!Array.isArray(flags) || flags.length === 0 || flags.some(value => !isObject(value) || value.value !== true)) add('HAUL_FLAG_REQUIRED', 'Haul 草稿必须设置 is_value_stores_item 为布尔 true', 'is_value_stores_item');
  const offers = attributes.purchasable_offer;
  if (parent) {
    if (Object.hasOwn(attributes, 'purchasable_offer')) add('HAUL_PARENT_OFFER_FORBIDDEN', '父 SKU 仅用于关联子 SKU，不能包含销售报价', 'purchasable_offer');
  } else if (!Array.isArray(offers) || offers.length === 0 || offers.some(value => !isObject(value) || value.audience !== 'BZR')) add('HAUL_AUDIENCE_REQUIRED', 'Haul 草稿的每个 purchasable_offer 必须显式使用 BZR 受众', 'purchasable_offer');
  return issues;
}

export function assertListingProgram(program: ListingProgram, snapshot: AmazonSchema, attributes?: JsonObject): void {
  const issues = listingProgramIssues(program, snapshot, attributes);
  if (issues.length) throw new UserFacingError(issues.map(issue => issue.message).join('；'));
}

export function programAttributes(program: ListingProgram, marketplaceId: string, parentage: AmazonSchema['parentageLevel'] = 'NONE'): JsonObject {
  return program === 'haul' ? { is_value_stores_item: [{ value: true, marketplace_id: marketplaceId }],
    ...(parentage === 'PARENT' ? {} : { purchasable_offer: [{ audience: 'BZR', marketplace_id: marketplaceId }] }) } : {};
}
