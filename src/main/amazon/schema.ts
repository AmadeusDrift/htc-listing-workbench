import Ajv2019 from 'ajv/dist/2019.js';
import addFormats from 'ajv-formats';
import type { AnySchemaObject, ErrorObject, ValidateFunction } from 'ajv';
import { createHash } from 'node:crypto';
import type { JsonObject, ListingIssue } from '../../shared/amazon-contracts.ts';

export const AMAZON_META_ID = 'https://schemas.amazon.com/selling-partners/definitions/product-types/meta-schema/v1';
const VOCABULARIES = new Set([
  'https://schemas.amazon.com/selling-partners/definitions/product-types/vocabulary/v1',
  ...['core', 'applicator', 'validation', 'meta-data', 'format', 'content'].map(name => `https://json-schema.org/draft/2019-09/vocab/${name}`),
]);

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function uniqueCount(data: unknown[], parent: AnySchemaObject): number {
  const selectors = parent.selectors as string[] | undefined;
  return new Set(data.map(item => selectors?.length && item && typeof item === 'object'
    ? canonical(selectors.map(key => (item as Record<string, unknown>)[key])) : canonical(item))).size;
}
function inspectVocabulary(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) {
    const vocabulary = (value as Record<string, unknown>).$vocabulary;
    if (vocabulary && typeof vocabulary === 'object') for (const [uri, required] of Object.entries(vocabulary)) {
      if (required && !VOCABULARIES.has(uri)) throw new Error('Unsupported vocabulary');
    }
  }
  for (const child of Object.values(value)) inspectVocabulary(child);
}
function validator(): Ajv2019 {
  const ajv = new Ajv2019({ allErrors: true, strictSchema: true, strictTypes: false, strictTuples: false,
    strictRequired: false, allowUnionTypes: true, useDefaults: false, coerceTypes: false, removeAdditional: false, logger: false,
    multipleOfPrecision: 10 }); // Decimal currency steps must tolerate binary floating-point representation.
  addFormats(ajv);
  for (const keyword of ['editable', 'hidden']) ajv.addKeyword({ keyword, schemaType: 'boolean', valid: true });
  for (const keyword of ['enumNames', 'replacedBy', 'replaces', 'enumDeprecated']) ajv.addKeyword({ keyword, schemaType: 'array', valid: true });
  ajv.addKeyword({ keyword: '$lifecycle', schemaType: 'object', valid: true });
  ajv.addKeyword({ keyword: 'selectors', type: 'array', schemaType: 'array', metaSchema: { type: 'array', items: { type: 'string' }, uniqueItems: true }, valid: true });
  ajv.removeKeyword('uniqueItems');
  ajv.addKeyword({ keyword: 'uniqueItems', type: 'array', schemaType: 'boolean',
    validate: (enabled: boolean, data: unknown[], parent: AnySchemaObject = {}) => !enabled || uniqueCount(data, parent) === data.length, errors: false });
  for (const keyword of ['minUniqueItems', 'maxUniqueItems']) ajv.addKeyword({ keyword, type: 'array', schemaType: 'number',
    metaSchema: { type: 'integer', minimum: 0 }, errors: false,
    validate: (limit: number, data: unknown[], parent: AnySchemaObject = {}) => keyword === 'minUniqueItems' ? uniqueCount(data, parent) >= limit : uniqueCount(data, parent) <= limit });
  for (const keyword of ['minUtf8ByteLength', 'maxUtf8ByteLength']) ajv.addKeyword({ keyword, type: 'string', schemaType: 'number',
    metaSchema: { type: 'integer', minimum: 0 }, errors: false,
    validate: (limit: number, data: string) => keyword === 'minUtf8ByteLength' ? Buffer.byteLength(data, 'utf8') >= limit : Buffer.byteLength(data, 'utf8') <= limit });
  return ajv;
}
const validators = new Map<string, ValidateFunction>();
export function compileAttributesSchema(schema: JsonObject, metaSchema: JsonObject = {}): ValidateFunction {
  const key = createHash('sha256').update(JSON.stringify([schema, metaSchema])).digest('hex');
  const existing = validators.get(key); if (existing) return existing;
  inspectVocabulary(schema); inspectVocabulary(metaSchema);
  const ajv = validator();
  if (Object.keys(metaSchema).length && metaSchema.$id !== 'https://json-schema.org/draft/2019-09/schema') ajv.addMetaSchema(metaSchema);
  // The vocabulary identifier is not a fetch URL. A supplied meta-schema is used
  // when available; otherwise our registered 2019-09 vocabulary validates it.
  const copy = structuredClone(schema);
  if (copy.$schema === AMAZON_META_ID && !ajv.getSchema(AMAZON_META_ID)) copy.$schema = 'https://json-schema.org/draft/2019-09/schema';
  const result = ajv.compile(copy);
  if (validators.size >= 64) validators.delete(validators.keys().next().value!);
  validators.set(key, result); return result;
}

function issue(error: ErrorObject): ListingIssue {
  const path = error.instancePath.split('/').filter(Boolean).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const property = typeof error.params.missingProperty === 'string' ? error.params.missingProperty : typeof error.params.additionalProperty === 'string' ? error.params.additionalProperty : undefined;
  const name = path[0] || property;
  const labels: Record<string, string> = { required: '缺少必填字段', enum: '值不在当前 Schema 允许的枚举中', const: '值与当前上下文不符',
    type: '字段类型不正确', additionalProperties: '含有 Schema 未定义的字段', if: '条件要求未满足', uniqueItems: '选择器指定的字段组合重复',
    minUniqueItems: '唯一字段组合数量不足', maxUniqueItems: '唯一字段组合数量超过限制', minUtf8ByteLength: 'UTF-8 字节长度不足', maxUtf8ByteLength: 'UTF-8 字节长度超过限制' };
  return { code: `LOCAL_${error.keyword}`, message: `${[...path, ...(property ? [property] : [])].join('.') || 'attributes'}：${labels[error.keyword] || '不满足当前 Schema 约束'}`,
    severity: 'ERROR', attributeNames: name ? [name] : [], attributePaths: [error.instancePath + (property !== undefined ? '/' + property.replaceAll('~', '~0').replaceAll('/', '~1') : '')], category: name?.includes('image') ? 'image' : 'field', source: 'local', autoFixable: false };
}
export function validateAttributes(schema: JsonObject, attributes: JsonObject, metaSchema: JsonObject = {}, maxIssues = 100): ListingIssue[] {
  try {
    const validate = compileAttributesSchema(schema, metaSchema);
    if (validate(attributes)) return [];
    return (validate.errors || []).slice(0, maxIssues).map(issue);
  } catch {
    return [{ code: 'SCHEMA_UNSUPPORTED', message: '当前 Schema 包含未支持或无效的约束，已阻止上架；请刷新 Schema 或升级 HTC',
      severity: 'ERROR', attributeNames: [], category: 'field', source: 'local', autoFixable: false }];
  }
}
