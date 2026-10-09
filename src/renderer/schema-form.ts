import type { JsonObject, JsonValue } from '../shared/amazon-contracts.ts';

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
export function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

// The form exposes the union of editable fields. Conditional requiredness and
// constraints are evaluated against the original schema in the main process.
function mergeDisplay(base: JsonObject, extra: JsonObject, conditional = false): JsonObject {
  const result: JsonObject = { ...extra, ...base };
  if (base.properties || extra.properties) {
    const a = objectValue(base.properties), b = objectValue(extra.properties);
    result.properties = Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key, mergeDisplay(objectValue(a[key]), objectValue(b[key]), conditional)]));
  }
  if (base.items || extra.items) result.items = mergeDisplay(objectValue(base.items), objectValue(extra.items), conditional);
  const baseEnum = Array.isArray(base.enum) ? base.enum : 'const' in base ? [base.const] : null;
  const extraEnum = Array.isArray(extra.enum) ? extra.enum : 'const' in extra ? [extra.const] : null;
  if (conditional && !baseEnum && base.type) { delete result.const; delete result.enum; delete result.enumNames; }
  if (baseEnum && extraEnum) {
    delete result.const;
    result.enum = [...new Map([...baseEnum, ...extraEnum].map(value => [JSON.stringify(value), value])).values()];
    if (base.enumNames || extra.enumNames) result.enumNames = result.enum.map(value => {
      const index = baseEnum.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(value));
      if (index >= 0) return (Array.isArray(base.enumNames) ? base.enumNames[index] : undefined) ?? String(value);
      const extraIndex = extraEnum.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(value));
      return (Array.isArray(extra.enumNames) ? extra.enumNames[extraIndex] : undefined) ?? String(value);
    });
  }
  return result;
}

/** Display only: the complete, unmodified schema is validated in the main process. */
export function displaySchema(node: JsonObject, root: JsonObject, depth = 0): JsonObject {
  if (depth > 12) return node;
  let merged = { ...node };
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    let target: JsonValue = root;
    for (const part of node.$ref.slice(2).split('/')) target = objectValue(target)[part.replaceAll('~1', '/').replaceAll('~0', '/')];
    merged = mergeDisplay(node, displaySchema(objectValue(target), root, depth + 1));
    delete merged.$ref;
  }
  const properties = { ...objectValue(merged.properties) };
  const required = new Set(Array.isArray(merged.required) ? merged.required.filter((key): key is string => typeof key === 'string') : []);
  for (const branch of Array.isArray(merged.allOf) ? merged.allOf : []) {
    const shape = displaySchema(objectValue(branch), root, depth + 1);
    for (const [key, value] of Object.entries(objectValue(shape.properties))) properties[key] = mergeDisplay(objectValue(properties[key]), objectValue(value), Boolean(shape.if || shape.then || shape.else));
    for (const key of Array.isArray(shape.required) ? shape.required : []) if (typeof key === 'string') required.add(key);
  }
  // Conditional fields remain editable; the validator determines when they are required.
  for (const branch of [merged.then, merged.else, ...(Array.isArray(merged.anyOf) ? merged.anyOf : []), ...(Array.isArray(merged.oneOf) ? merged.oneOf : [])]) {
    if (branch) for (const [key, value] of Object.entries(objectValue(displaySchema(objectValue(branch), root, depth + 1).properties))) properties[key] = mergeDisplay(objectValue(properties[key]), objectValue(value), true);
  }
  if (Object.keys(properties).length) merged.properties = properties;
  if (required.size) merged.required = [...required];
  return merged;
}

export function setJsonPath(root: JsonObject, path: (string | number)[], value: JsonValue | undefined): JsonObject {
  if (!path.length || path.some(key => typeof key === 'string' && unsafeKeys.has(key))) throw new Error('字段路径无效');
  const next = structuredClone(root);
  let cursor: JsonObject | JsonValue[] = next;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index];
    const record = cursor as JsonObject;
    if (record[key] === null || typeof record[key] !== 'object') record[key] = typeof path[index + 1] === 'number' ? [] : {};
    cursor = record[key] as JsonObject | JsonValue[];
  }
  const key = path[path.length - 1];
  if (value === undefined) {
    if (Array.isArray(cursor) && typeof key === 'number') cursor.splice(key, 1);
    else delete (cursor as JsonObject)[key];
  } else (cursor as JsonObject)[key] = value;
  return next;
}

export function parseAttributes(raw: string): JsonObject {
  if (raw.length > 500_000) throw new Error('草稿不能超过 500 KB');
  let result: unknown;
  try { result = JSON.parse(raw); } catch { throw new Error('JSON 格式有误，请检查逗号、引号和括号'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('属性 JSON 必须是对象');
  function check(value: unknown, depth: number) {
    if (depth > 30) throw new Error('字段层级过深');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('字段包含无效数值');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (unsafeKeys.has(key)) throw new Error('字段包含不允许的名称');
      check(child, depth + 1);
    }
  }
  check(result, 0);
  return result as JsonObject;
}

export function fieldPath(path: (string | number)[]): string {
  return path.map((key, index) => typeof key === 'number' ? `[${key}]` : `${index ? '.' : ''}${key}`).join('');
}
