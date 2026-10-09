import type { AmazonSchema, JsonObject, JsonValue } from '../../shared/amazon-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { isObject } from './context.ts';
import { compileAttributesSchema } from './schema.ts';
import { LISTING_CANDIDATE_FIELDS } from '../../shared/listing-ai-contracts.ts';

export const AMAZON_AI_FIELDS = LISTING_CANDIDATE_FIELDS;
/** Known text leaves; arbitrary nested objects are never flattened or guessed. */
export const NESTED_TEXT_FIELDS:Readonly<Record<string,string>>={blade:'material',closure:'type'};
export interface AmazonFieldCondition {
  pointer: string;
  kind: 'allOf' | 'anyOf' | 'oneOf' | 'then' | 'else' | 'dependentSchemas' | 'dependentRequired';
  required: string[];
  condition?: JsonValue;
}
export interface AmazonFieldCard {
  name: string; title: string; description: string; schemaPointer: string;
  requirement: 'required' | 'conditional' | 'optional';
  groups: { key: string; title: string }[];
  conditions: AmazonFieldCondition[];
  closedEnum: boolean; allowedValues: JsonValue[]; suggestedValues: JsonValue[];
  minLength?: number; maxLength?: number; minUtf8ByteLength?: number; maxUtf8ByteLength?: number;
  minItems?: number; maxItems?: number; minimum?: number; maximum?: number;
}
export const pointerToken = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');

/** Metadata inspection only. The full unmodified schema remains the validator. */
export function resolveSchemaNode(root: JsonObject, input: unknown, visited = new Set<string>()): JsonObject {
  if (!isObject(input)) throw new UserFacingError('Schema 字段结构无效');
  if (input.$ref === undefined) return input;
  const ref = input.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new UserFacingError('Schema 字段目录仅支持当前文档内的 JSON 引用');
  if (visited.has(ref) || visited.size >= 64) throw new UserFacingError('Schema 存在循环引用或引用层级过深');
  let target: unknown = root;
  for (const encoded of ref.slice(2).split('/')) {
    if (/~(?![01])/u.test(encoded)) throw new UserFacingError('Schema 引用转义无效');
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isObject(target) || ['__proto__', 'prototype', 'constructor'].includes(key) || !Object.hasOwn(target, key)) throw new UserFacingError('Schema 引用目标不存在');
    target = target[key];
  }
  const next = new Set(visited); next.add(ref); const resolved = resolveSchemaNode(root, target, next);
  const { $ref: _ref, ...siblings } = input;
  // $ref siblings are an intersection; retain both rather than discard constraints.
  return Object.keys(siblings).length ? { ...resolved, ...siblings, allOf: [resolved, siblings] } : resolved;
}

export function fieldSchema(snapshot: AmazonSchema, name: string): JsonObject {
  const properties = snapshot.schema.properties;
  if (!isObject(properties) || !Object.hasOwn(properties, name)) throw new UserFacingError(`当前 Schema 不包含字段 ${name}`);
  return resolveSchemaNode(snapshot.schema, properties[name]);
}

function unique(values: JsonValue[]): JsonValue[] { return [...new Map(values.map(value => [JSON.stringify(value), value])).values()]; }
function schemaBranches(values: JsonValue[]): (JsonObject | boolean)[] {
  return values.map(value => { if (typeof value === 'boolean' || isObject(value)) return value; throw new UserFacingError('Schema 组合分支必须是对象或布尔值'); });
}
function matchingValues(root: JsonObject, node: JsonObject, values: JsonValue[]): JsonValue[] {
  if (!values.length) return [];
  const scope: JsonObject = {};
  for (const key of ['$schema','$id','$defs','definitions']) if (root[key] !== undefined) scope[key] = root[key];
  // Scalar enum checks do not need every unrelated product attribute compiled.
  // Retain properties only when a local reference actually needs that namespace.
  if(JSON.stringify([node,root.$defs,root.definitions]).includes('#/properties/'))scope.properties=root.properties;
  scope.allOf = [node];
  const validate = compileAttributesSchema(scope);
  return values.filter(value => validate(value));
}
function enumSemantics(root: JsonObject, raw: JsonObject | boolean, depth = 0): { closed: boolean; allowed: JsonValue[]; suggestions: JsonValue[] } {
  if (depth > 64) throw new UserFacingError('Schema 枚举引用层级过深');
  if (typeof raw === 'boolean') return {closed:!raw,allowed:[],suggestions:[]};
  const node = resolveSchemaNode(root, raw);
  const direct = Array.isArray(node.enum) ? node.enum : Object.hasOwn(node, 'const') ? [node.const] : undefined;
  let allowed: JsonValue[] | undefined = direct;
  let suggestions = direct ?? [];
  for (const key of ['anyOf', 'oneOf'] as const) if (Array.isArray(node[key])) {
    const branches = schemaBranches(node[key] as JsonValue[]);
    const alternatives = branches.map(branch => enumSemantics(root, branch, depth + 1));
    suggestions = [...suggestions, ...alternatives.flatMap(branch => [...branch.suggestions, ...branch.allowed])];
    if (key === 'oneOf' && branches.filter(branch => branch === true).length > 1) allowed = [];
    else if (alternatives.length && alternatives.every(branch => branch.closed)) {
      const union = unique(alternatives.flatMap(branch => branch.allowed));
      allowed = allowed ? allowed.filter(value => union.some(other => JSON.stringify(other) === JSON.stringify(value))) : union;
    }
    // oneOf accepts exactly one branch. In particular, true plus an enum makes
    // that enum's values invalid, even though other free-text values remain open.
    if (key === 'oneOf') {
      if (allowed) allowed = matchingValues(root,node,allowed);
      suggestions = matchingValues(root,node,suggestions);
    }
  }
  if (Array.isArray(node.allOf)) for (const branch of schemaBranches(node.allOf)) {
    const restriction = enumSemantics(root, branch, depth + 1); suggestions.push(...restriction.suggestions, ...restriction.allowed);
    if (restriction.closed) allowed = allowed ? allowed.filter(value => restriction.allowed.some(other => JSON.stringify(value) === JSON.stringify(other))) : restriction.allowed;
  }
  const choices=unique(allowed??[]),hints=allowed===undefined?unique(suggestions):[];
  // Check the complete leaf once; recursive branch checks would repeatedly
  // compile the same constraints before their final intersection is known.
  return {closed:allowed!==undefined,allowed:depth===0?matchingValues(root,node,choices):choices,suggestions:depth===0?matchingValues(root,node,hints):hints};
}

const limitKeys = ['minLength', 'maxLength', 'minUtf8ByteLength', 'maxUtf8ByteLength', 'minimum', 'maximum'] as const;
function limits(root: JsonObject, raw: JsonObject | boolean, depth = 0): Partial<AmazonFieldCard> {
  if (depth > 64) throw new UserFacingError('Schema 约束层级过深');
  if (typeof raw === 'boolean') return {};
  const node = resolveSchemaNode(root, raw); const result: Partial<AmazonFieldCard> = {};
  for (const key of limitKeys) if (typeof node[key] === 'number') result[key] = node[key];
  if (Array.isArray(node.allOf)) for (const branch of schemaBranches(node.allOf)) {
    const more = limits(root, branch, depth + 1);
    for (const key of limitKeys) if (more[key] !== undefined) result[key] = result[key] === undefined ? more[key] : key.startsWith('max') ? Math.min(result[key]!, more[key]!) : Math.max(result[key]!, more[key]!);
  }
  // A union can expose a common bound only if every branch supplies that bound.
  for (const union of ['anyOf', 'oneOf']) if (Array.isArray(node[union])) {
    const alternatives = schemaBranches(node[union] as JsonValue[]).filter(branch => branch !== false).map(branch => limits(root, branch, depth + 1));
    for (const key of limitKeys) if (alternatives.length && alternatives.every(branch => branch[key] !== undefined)) {
      const bound = key.startsWith('max') ? Math.max(...alternatives.map(branch => branch[key]!)) : Math.min(...alternatives.map(branch => branch[key]!));
      result[key] = result[key] === undefined ? bound : key.startsWith('max') ? Math.min(result[key]!, bound) : Math.max(result[key]!, bound);
    }
  }
  return result;
}

function conditions(root: JsonObject, names: Set<string>): Map<string, AmazonFieldCondition[]> {
  const result = new Map<string, AmazonFieldCondition[]>();
  const add = (node: JsonObject, pointer: string, kind: AmazonFieldCondition['kind'], condition?: JsonValue) => {
    const required = Array.isArray(node.required) ? node.required.filter((name): name is string => typeof name === 'string' && names.has(name)) : [];
    const constrained = isObject(node.properties) ? Object.keys(node.properties).filter(name => names.has(name)) : [];
    for (const name of new Set([...required, ...constrained])) {
      const entries = result.get(name) ?? []; entries.push({ pointer, kind, required, ...(condition ? { condition: structuredClone(condition) } : {}) }); result.set(name, entries);
    }
  };
  const visit = (raw: JsonObject, pointer: string, depth: number) => {
    if (depth > 64) throw new UserFacingError('Schema 条件层级过深');
    const node = resolveSchemaNode(root, raw);
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) if (Array.isArray(node[key])) for (const [index, child] of (node[key] as JsonValue[]).entries()) if (isObject(child)) {
      const childPointer = `${pointer}/${key}/${index}`; add(child, childPointer, key); visit(child, childPointer, depth + 1);
    }
    for (const key of ['then', 'else'] as const) if (isObject(node[key])) { add(node[key], `${pointer}/${key}`, key, node.if); visit(node[key], `${pointer}/${key}`, depth + 1); }
    if (isObject(node.dependentSchemas)) for (const [trigger, child] of Object.entries(node.dependentSchemas)) if (isObject(child)) {
      const childPointer = `${pointer}/dependentSchemas/${pointerToken(trigger)}`; add(child, childPointer, 'dependentSchemas', { required: [trigger] }); visit(child, childPointer, depth + 1);
    }
    if (isObject(node.dependentRequired)) for (const [trigger, required] of Object.entries(node.dependentRequired)) if (Array.isArray(required)) add({ required }, `${pointer}/dependentRequired/${pointerToken(trigger)}`, 'dependentRequired', { required: [trigger] });
  };
  visit(root, '#', 0); return result;
}

export function buildFieldCatalog(snapshot: AmazonSchema): AmazonFieldCard[] {
  const root = snapshot.schema; const properties = root.properties;
  if (!isObject(properties)) throw new UserFacingError('Schema 缺少实际 properties，不能构造字段目录');
  const names = new Set(Object.keys(properties)); const conditionMap = conditions(root, names);
  const required = new Set(Array.isArray(root.required) ? root.required.filter(value => typeof value === 'string') : []);
  return [...names].map(name => {
    const field = fieldSchema(snapshot, name); let value = field;
    if (field.type === 'array' && isObject(field.items)) { const item = resolveSchemaNode(root, field.items); value = isObject(item.properties) && isObject(item.properties.value) ? resolveSchemaNode(root, item.properties.value) : item; }
    // Actual PTDs use blade[].material[].value and closure[].type[].value.
    const nested=NESTED_TEXT_FIELDS[name];
    if(nested&&isObject(value.properties)&&isObject(value.properties[nested])){
      const node=resolveSchemaNode(root,value.properties[nested]);
      if(node.type==='array'&&isObject(node.items)){
        const item=resolveSchemaNode(root,node.items);
        if(isObject(item.properties)&&isObject(item.properties.value))value=resolveSchemaNode(root,item.properties.value);
      }
    }
    const semantics = enumSemantics(root, value); const fieldConditions = conditionMap.get(name) ?? [];
    return { name, title: typeof field.title === 'string' ? field.title : name, description: typeof field.description === 'string' ? field.description : '', schemaPointer: `#/properties/${pointerToken(name)}`,
      requirement: required.has(name) ? 'required' : fieldConditions.some(condition => condition.required.includes(name)) ? 'conditional' : 'optional',
      groups: Object.entries(snapshot.propertyGroups).filter(([, group]) => group.propertyNames.includes(name)).map(([key, group]) => ({key,title:group.title})),
      conditions: fieldConditions, closedEnum: semantics.closed, allowedValues: semantics.allowed, suggestedValues: semantics.suggestions, ...limits(root, value),
      ...(typeof field.minItems === 'number' ? {minItems:field.minItems} : {}), ...(typeof field.maxItems === 'number' ? {maxItems:field.maxItems} : {}) };
  });
}
