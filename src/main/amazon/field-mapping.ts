import type { ErrorObject } from 'ajv';
import type { AmazonSchema, JsonObject, JsonValue, ListingIssue } from '../../shared/amazon-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { isObject } from './context.ts';
import { buildFieldCatalog, fieldSchema, pointerToken, resolveSchemaNode, NESTED_TEXT_FIELDS } from './field-catalog.ts';
import { compileAttributesSchema } from './schema.ts';
import { LISTING_BOOLEAN_FIELDS } from '../../shared/listing-ai-contracts.ts';

/** Approved project copy policy, independent from and subordinate to current PTD constraints. */
export const AMAZON_COPY_POLICY_VERSION = 'haul-us-copy-2026-10-07-v2';
export const AMAZON_COPY_POLICY = { titleMaxCharacters: 75, titlePreferredCharacters: 70, bulletCount: 5, bulletMaxCharacters: 500, descriptionMaxCharacters: 500, keywordsMaxUtf8Bytes: 200,
  source: 'User-approved project policy: docs/superpowers/plans/2026-10-07-amazon-schema-deepseek.md, Task 2' } as const;

function issue(code: string, field: string, message: string): ListingIssue { return {code,message,attributeNames:[field],severity:'ERROR',category:'field',source:'local',autoFixable:false}; }
function language(snapshot: AmazonSchema, property: JsonValue): string {
  if (snapshot.locale !== 'DEFAULT') return snapshot.locale;
  const resolved = resolveSchemaNode(snapshot.schema, property);
  if (typeof resolved.const === 'string') return resolved.const;
  if (typeof resolved.default === 'string') return resolved.default;
  if (Array.isArray(resolved.enum) && resolved.enum.length === 1 && typeof resolved.enum[0] === 'string') return resolved.enum[0];
  throw new UserFacingError('当前 Schema 的语言需要人工选择');
}

/** Wrap plain candidate values using only properties actually present in the PTD. */
export function wrapCandidateValues(snapshot: AmazonSchema, marketplaceId: string, field: string, values: readonly JsonValue[],existing?:JsonValue): JsonValue {
  const schema = fieldSchema(snapshot, field);
  if((LISTING_BOOLEAN_FIELDS as readonly string[]).includes(field)){
    const node=schema.type==='array'?resolveSchemaNode(snapshot.schema,schema.items):schema;
    const leaf=isObject(node.properties)&&Object.hasOwn(node.properties,'value')?resolveSchemaNode(snapshot.schema,node.properties.value):node;
    if(leaf.type==='boolean')values=values.map(value=>value==='true'?true:value==='false'?false:value);
  }
  if (schema.type !== 'array') {
    if (values.length !== 1) throw new UserFacingError(`字段 ${field} 需要一个值`);
    return structuredClone(values[0]);
  }
  const item = resolveSchemaNode(snapshot.schema, schema.items);
  if (!isObject(item.properties)) return structuredClone([...values]);
  const properties = item.properties;
  return values.map((value,index) => {
    let wrapped: JsonObject = isObject(value) ? structuredClone(value) : Object.hasOwn(properties, 'value') ? { value } : field === 'fulfillment_availability' && Object.hasOwn(properties, 'quantity') ? { quantity: value } : {};
    const nested=NESTED_TEXT_FIELDS[field];
    if(nested&&typeof value==='string'&&Object.hasOwn(properties,nested)){
      const node=resolveSchemaNode(snapshot.schema,properties[nested]);
      const entry=node.type==='array'?resolveSchemaNode(snapshot.schema,node.items):null;
      if(entry&&isObject(entry.properties)&&Object.hasOwn(entry.properties,'value')){
        const prior=Array.isArray(existing)&&isObject(existing[index])?structuredClone(existing[index]):{};
        wrapped={...prior,[nested]:[{value,...(Object.hasOwn(entry.properties,'language_tag')?{language_tag:language(snapshot,entry.properties.language_tag)}:{})}]};
      }
    }
    if (!Object.keys(wrapped).length) throw new UserFacingError(`字段 ${field} 的结构需要人工输入`);
    if (Object.hasOwn(properties, 'marketplace_id')) wrapped.marketplace_id = marketplaceId;
    if (Object.hasOwn(properties, 'language_tag')) wrapped.language_tag = language(snapshot, properties.language_tag);
    return wrapped;
  });
}

/** Read only the supported text leaf, preserving nested source attribute storage. */
export function candidateTextValues(field:string,raw:unknown):string[]|null{
  if(!Array.isArray(raw))return null;
  const nested=NESTED_TEXT_FIELDS[field];
  const entries=nested?raw.flatMap(item=>isObject(item)&&Array.isArray(item[nested])?item[nested]:field==='blade'?[null]:[item]):raw;
  const boolean=(LISTING_BOOLEAN_FIELDS as readonly string[]).includes(field);
  if(entries.some(item=>!isObject(item)||!(boolean&&typeof item.value==='boolean')&&(typeof item.value!=='string'||!item.value.trim())))return null;
  return entries.map(item=>String((item as {value:string|boolean}).value));
}

function errorIdentity(error: ErrorObject): string { return JSON.stringify([error.instancePath, error.schemaPath, error.keyword, error.params]); }
/** Compile the entire PTD, preserving refs and conditional dependencies. Ignore only unchanged errors on other fields. */
export function validateFieldValues(snapshot: AmazonSchema, marketplaceId: string, field: string, values: readonly JsonValue[], attributes: JsonObject = {}): ListingIssue[] {
  let candidate: JsonValue;
  try { candidate = wrapCandidateValues(snapshot, marketplaceId, field, values,attributes[field]); } catch (error) { return [issue('LOCAL_FIELD_SHAPE', field, error instanceof Error ? error.message : '字段结构无效')]; }
  try {
    const validate = compileAttributesSchema(snapshot.schema, snapshot.metaSchema);
    const baseline = { ...attributes }; delete baseline[field]; validate(baseline);
    const previous = new Set((validate.errors ?? []).map(errorIdentity));
    validate({ ...attributes, [field]: candidate });
    const fieldPath = `/${pointerToken(field)}`; const schemaPath = `#/properties/${pointerToken(field)}`;
    return (validate.errors ?? []).filter(error => error.instancePath === fieldPath || error.instancePath.startsWith(`${fieldPath}/`)
      || error.schemaPath === schemaPath || error.schemaPath.startsWith(`${schemaPath}/`) || !previous.has(errorIdentity(error)))
      .map(error => issue(`LOCAL_${error.keyword}`, field, `${field}：不满足当前 Schema ${error.keyword} 约束${typeof error.params.missingProperty === 'string' ? `（需要 ${error.params.missingProperty}）` : ''}`));
  } catch { return [issue('SCHEMA_UNSUPPORTED', field, '当前 Schema 包含未支持或无效约束，无法校验字段')]; }
}

export type MeasurementResult = {status:'mapped';value:number;unit:'inches'|'pounds'} | {status:'needs_input';reason:string};
export interface MeasurementInput { value: unknown; unit?: string }
export interface MeasurementSet { length?: MeasurementInput; width?: MeasurementInput; height?: MeasurementInput; depth?: MeasurementInput; thickness?: MeasurementInput; weight?: MeasurementInput }
export interface ConfirmedMeasurements { item?: MeasurementSet; package?: MeasurementSet; unitCount?: number }

const LENGTH_UNITS: Record<string, number> = { cm:1/2.54, centimeters:1/2.54, mm:1/25.4, millimeters:1/25.4, m:100/2.54, meters:100/2.54, in:1, inch:1, inches:1 };
const WEIGHT_UNITS: Record<string, number> = { g:1/453.59237, grams:1/453.59237, kg:1000/453.59237, kilograms:1000/453.59237, lb:1, lbs:1, pound:1, pounds:1, oz:1/16, ounces:1/16 };
export function convertToUnit(value: unknown, unit: unknown, kind: 'length' | 'weight', target: string): {status:'mapped';value:number;unit:string} | {status:'needs_input';reason:string} {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(number) || number <= 0) return {status:'needs_input',reason:'必须提供大于零的有限数字'};
  if (typeof unit !== 'string' || !unit.trim()) return {status:'needs_input',reason:'来源单位缺失，不能猜测单位'};
  const units = kind === 'length' ? LENGTH_UNITS : WEIGHT_UNITS;
  const sourceFactor = units[unit.trim().toLowerCase()], targetFactor = units[target.toLowerCase()];
  if (!sourceFactor || !targetFactor) return {status:'needs_input',reason:'来源单位不受支持或与测量类型不符'};
  const exact = number * sourceFactor / targetFactor;
  // Native values retain their precision. Only a real unit conversion uses approved ROUND(2).
  const converted = sourceFactor === targetFactor ? number : Math.round((exact + Number.EPSILON * Math.abs(exact)) * 100) / 100;
  if (!Number.isFinite(converted) || converted <= 0) return {status:'needs_input',reason:'转换结果无效或小于当前精度'};
  return {status:'mapped',value:converted,unit:target};
}
export function convertMeasurement(value: unknown, unit: unknown, kind: 'length' | 'weight'): MeasurementResult {
  return convertToUnit(value, unit, kind, kind === 'length' ? 'inches' : 'pounds') as MeasurementResult;
}

/** Supported semantic shapes only. Thickness requires its own explicit source value. */
export const DIMENSION_FIELDS = ['item_dimensions','item_length_width_height','item_length_width','item_length_height','item_width_height','item_depth_width_height',
  'item_length','item_width','item_height','item_depth','item_thickness','item_package_dimensions','item_package_length','item_package_width','item_package_height','item_package_depth'] as const;

function schemaMeasurement(snapshot: AmazonSchema, raw: JsonValue, input: MeasurementInput, kind: 'length' | 'weight'): JsonObject | null {
  const node = resolveSchemaNode(snapshot.schema, raw);
  if (!isObject(node.properties) || !node.properties.unit) return null;
  const valueKey = node.properties.value ? 'value' : node.properties.decimal_value ? 'decimal_value' : null;
  if (!valueKey) return null;
  const unit = resolveSchemaNode(snapshot.schema, node.properties.unit), preferred = kind === 'length' ? 'inches' : 'pounds';
  const allowed = typeof unit.const === 'string' ? [unit.const] : Array.isArray(unit.enum) ? unit.enum.filter((entry): entry is string => typeof entry === 'string') : [preferred];
  const ordered = [preferred, input.unit, ...allowed].filter((entry): entry is string => typeof entry === 'string' && allowed.includes(entry));
  for (const target of new Set(ordered)) {
    const converted = convertToUnit(input.value, input.unit, kind, target);
    if (converted.status === 'mapped') return { [valueKey]: converted.value, unit: converted.unit };
  }
  return null;
}

export function mapMeasurementFields(snapshot: AmazonSchema, marketplaceId: string, source: ConfirmedMeasurements): { attributes: JsonObject; needsInput: string[] } {
  const attributes: JsonObject = {}; const needsInput = new Set<string>(); const fields = isObject(snapshot.schema.properties) ? snapshot.schema.properties : {};
  const add = (field: string, value: JsonObject) => {
    if (!Object.hasOwn(fields, field)) return;
    if (validateFieldValues(snapshot, marketplaceId, field, [value]).length) { needsInput.add(field); return; }
    attributes[field] = wrapCandidateValues(snapshot, marketplaceId, field, [value]);
  };
  for (const field of DIMENSION_FIELDS) {
    if (!Object.hasOwn(fields, field)) continue;
    const scope = field.startsWith('item_package_') ? 'package' : 'item', input = source[scope]; if (!input) continue;
    const node = fieldSchema(snapshot, field), item = resolveSchemaNode(snapshot.schema, node.type === 'array' ? node.items : node);
    if (!isObject(item.properties)) continue;
    const dimensions: JsonObject = {};
    for (const axis of ['length','width','height','depth','thickness'] as const) if (item.properties[axis]) {
      const value = input[axis] ?? (axis === 'depth' ? input.length : undefined);
      const converted = value ? schemaMeasurement(snapshot, item.properties[axis], value, 'length') : null;
      if (converted) dimensions[axis] = converted; else needsInput.add(`${scope}.${axis}`);
    }
    const scalar = /_(length|width|height|depth|thickness)$/.exec(field)?.[1] as keyof MeasurementSet | undefined;
    if (!Object.keys(dimensions).length && scalar) {
      const value = input[scalar] ?? (scalar === 'depth' ? input.length : undefined);
      const converted = value ? schemaMeasurement(snapshot, item, value, 'length') : null;
      if (converted) Object.assign(dimensions, converted); else if (value) needsInput.add(`${scope}.${scalar}`);
    }
    if (Object.keys(dimensions).length) add(field, dimensions);
  }
  for (const scope of ['item','package'] as const) if (source[scope]?.weight) {
    const field = scope === 'item' ? 'item_weight' : 'item_package_weight'; if (!Object.hasOwn(fields, field)) continue;
    const node = fieldSchema(snapshot, field), item = resolveSchemaNode(snapshot.schema, node.type === 'array' ? node.items : node);
    const value = schemaMeasurement(snapshot, item, source[scope]!.weight!, 'weight');
    if (value) add(field, value); else needsInput.add(`${scope}.weight`);
  }
  if (source.unitCount !== undefined) {
    if (!Number.isFinite(source.unitCount) || source.unitCount <= 0 || !Number.isInteger(source.unitCount)) needsInput.add('unit_count');
    else if (Object.hasOwn(fields, 'unit_count')) {
      const item = resolveSchemaNode(snapshot.schema, fieldSchema(snapshot, 'unit_count').items);
      const type = isObject(item.properties) ? item.properties.type : undefined;
      if (isObject(type)) { const properties = resolveSchemaNode(snapshot.schema, type).properties;
        const countType: JsonObject = {value:'Count'};
        if (isObject(properties) && properties.language_tag) countType.language_tag = language(snapshot, properties.language_tag);
        add('unit_count', {value:source.unitCount,type:countType});
      } else needsInput.add('unit_count');
    }
  }
  return {attributes,needsInput:[...needsInput]};
}

export function validatePolicyOutputs(snapshot: AmazonSchema, values: Partial<Record<string, string[]>>): ListingIssue[] {
  const cards = new Map(buildFieldCatalog(snapshot).map(card => [card.name,card])); const issues: ListingIssue[] = [];
  const characterLimits: Record<string,number> = {item_name:75,bullet_point:500,product_description:500};
  for (const [field, entries] of Object.entries(values)) {
    const card = cards.get(field);
    if (!card || !Array.isArray(entries) || entries.some(value => typeof value !== 'string' || !value.trim())) { issues.push(issue('POLICY_FIELD_INVALID',field,'字段不存在或候选值为空')); continue; }
    if (field === 'bullet_point' && entries.length !== 5) issues.push(issue('POLICY_BULLET_COUNT',field,'五点描述必须恰好五条'));
    if (['item_name','product_description','generic_keyword'].includes(field) && entries.length !== 1) issues.push(issue('POLICY_VALUE_COUNT',field,'此文案字段必须恰好一个值'));
    const maxChars = Math.min(card.maxLength ?? Infinity, characterLimits[field] ?? Infinity);
    const maxBytes = Math.min(card.maxUtf8ByteLength ?? Infinity, field === 'generic_keyword' ? 200 : Infinity);
    if (entries.some(value => [...value].length > maxChars)) issues.push(issue('POLICY_MAX_LENGTH',field,`字段不能超过 ${maxChars} 个字符`));
    if (entries.some(value => Buffer.byteLength(value,'utf8') > maxBytes)) issues.push(issue('POLICY_UTF8_LENGTH',field,`字段不能超过 ${maxBytes} UTF-8 字节`));
    if (entries.some(value => [...value].length < (card.minLength ?? 0) || Buffer.byteLength(value,'utf8') < (card.minUtf8ByteLength ?? 0))) issues.push(issue('POLICY_MIN_LENGTH',field,'字段短于当前 Schema 最小长度'));
    if (entries.length < (card.minItems ?? 0) || entries.length > (card.maxItems ?? Infinity)) issues.push(issue('POLICY_ITEM_COUNT',field,'字段条数不符合当前 Schema'));
  }
  return issues;
}
