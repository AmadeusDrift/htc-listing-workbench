import { UserFacingError } from './errors.ts';

export const SKU_NAMING_SETTINGS_KEY = 'sku_naming_v1';
export const SKU_MAX_CHILDREN = 4096;
export const SKU_MAX_SEQUENCE = 999999999;
export type SkuDateFormat = 'yymmdd' | 'yyyymmdd' | 'yyyy-mm-dd';
export interface SkuNamingTemplate {
  id: string; name: string; basePattern: string; childPattern: string;
  dateFormat: SkuDateFormat; sequencePadding: number; prefixes: Record<string, string>;
}
export interface SkuNamingBinding { storeCode: string; templateId: string; targetId?: string }
export interface SkuNamingSettings {
  version: 1; revision: number; defaultTemplateId: string;
  templates: SkuNamingTemplate[]; bindings: SkuNamingBinding[];
}
export interface SkuNamingPreviewInput {
  settings?: SkuNamingSettings; templateId?: string; targetId?: string;
  storeCode: string; collectedAt: string; sequence: number; childCount: number;
}
export interface SkuNamingPreview { templateId: string; collectionDate: string; baseSku: string; childSkus: string[] }
export interface SkuNamingChild { key: string; index: number; suffix: string; sku: string }
export interface SkuNamingGroup {
  id: string; revision: number; storeScope: string; storeCode: string; sourceGroupKey: string;
  collectedAt: string; collectionDate: string; sequence: number; baseSku: string;
  templateSnapshot: { settingsRevision: number; template: SkuNamingTemplate; prefix: string };
  children: SkuNamingChild[]; createdAt: string;
}
export interface AllocateSkuNamingInput {
  storeScope: string; storeCode: string; sourceGroupKey: string; collectedAt: string; childKeys: string[]; targetId?: string;
}
export interface SkuNamingIdentityInput { storeScope: string; sourceGroupKey: string; childKey?: string; sku: string }
export interface SkuNamingApi {
  getSkuNamingSettings(): Promise<SkuNamingSettings>;
  saveSkuNamingSettings(input: SkuNamingSettings): Promise<SkuNamingSettings>;
  previewSkuNaming(input: SkuNamingPreviewInput): Promise<SkuNamingPreview>;
}

function fail(message = 'SKU 命名规则格式无效'): never { throw new UserFacingError(message); }
export function skuNamingObject(raw: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) return fail();
  return value;
}
export function skuNamingText(raw: unknown, max: number, label: string): string {
  if (typeof raw !== 'string' || raw !== raw.trim() || !raw || raw.length > max || /[\x00-\x1f\x7f]/.test(raw)) return fail(`${label}格式无效`);
  return raw;
}
export function skuNamingInteger(raw: unknown, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) return fail('SKU 规则数值超出允许范围');
  return raw;
}
function code(raw: unknown): string {
  const value = skuNamingText(raw, 100, 'SKU 店铺或模板编号');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) return fail('SKU 店铺或模板编号格式无效');
  return value;
}
export function assertSafeSku(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(raw)) return fail('SKU 必须为 1–40 位英文字母、数字、点、下划线或连字符，并以字母或数字开头');
  return raw;
}
function pattern(raw: unknown, placeholders: string[]): string {
  const value = skuNamingText(raw, 120, 'SKU 模板');
  const tokens = [...value.matchAll(/\{([a-z]+)\}/g)].map(match => match[1]);
  const literal = value.replace(/\{[a-z]+\}/g, '');
  if (!/^[A-Za-z0-9._-]*$/.test(literal) || tokens.length !== placeholders.length
    || placeholders.some(key => tokens.filter(token => token === key).length !== 1)) return fail(`SKU 模板必须各包含一次 ${placeholders.map(key => `{${key}}`).join('、')}，且只能使用安全字符`);
  return value;
}
function expand(value: string, replacements: Record<string, string>): string {
  return assertSafeSku(value.replace(/\{([a-z]+)\}/g, (_, key: string) => replacements[key]));
}
export function skuChildSuffix(index: number): string {
  skuNamingInteger(index, 1, SKU_MAX_CHILDREN);
  let suffix = '', value = index;
  while (value) { value--; suffix = String.fromCharCode(65 + value % 26) + suffix; value = Math.floor(value / 26); }
  return suffix;
}
export function skuCollectionDate(raw: unknown): string {
  const value = skuNamingText(raw, 40, '采集时间');
  // Timezone is mandatory: interpretation must never depend on the computer's timezone.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return fail('采集时间需要包含时区的完整日期时间');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
    || (match[7] !== 'Z' && (Number(match[7].slice(1, 3)) > 14 || Number(match[7].slice(4)) > 59
      || Number(match[7].slice(1, 3)) === 14 && Number(match[7].slice(4)) !== 0))) return fail('采集日期或时间无效');
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return fail('采集日期或时间无效');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(epoch);
  const part = (kind: string) => parts.find(item => item.type === kind)!.value;
  const result = `${part('year')}-${part('month')}-${part('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) return fail('采集日期超出允许范围');
  return result;
}
export function renderSkuBase(template: SkuNamingTemplate, prefix: string, collectionDate: string, sequence: number): string {
  skuNamingInteger(sequence, 1, SKU_MAX_SEQUENCE);
  const date = template.dateFormat === 'yyyy-mm-dd' ? collectionDate : collectionDate.replaceAll('-', '').slice(template.dateFormat === 'yymmdd' ? 2 : 0);
  return expand(template.basePattern, { prefix, date, sequence: String(sequence).padStart(template.sequencePadding, '0') });
}
export function renderSkuChild(template: SkuNamingTemplate, parent: string, index: number): string {
  return expand(template.childPattern, { parent, child: skuChildSuffix(index) });
}
export function parseSkuNamingTemplate(raw: unknown): SkuNamingTemplate {
  const value = skuNamingObject(raw, ['id', 'name', 'basePattern', 'childPattern', 'dateFormat', 'sequencePadding', 'prefixes']);
  if (!['yymmdd', 'yyyymmdd', 'yyyy-mm-dd'].includes(String(value.dateFormat))) return fail('SKU 日期格式无效');
  if (!value.prefixes || typeof value.prefixes !== 'object' || Array.isArray(value.prefixes)
    || Object.keys(value.prefixes).length < 1 || Object.keys(value.prefixes).length > 100) return fail('SKU 前缀映射需要 1–100 个店铺');
  const prefixes: Record<string, string> = {};
  for (const [key, rawPrefix] of Object.entries(value.prefixes)) {
    const prefix = skuNamingText(rawPrefix, 16, 'SKU 前缀');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix)) return fail('SKU 前缀只能使用安全字符');
    prefixes[code(key)] = prefix;
  }
  const template: SkuNamingTemplate = { id: code(value.id), name: skuNamingText(value.name, 80, 'SKU 模板名称'),
    basePattern: pattern(value.basePattern, ['prefix', 'date', 'sequence']), childPattern: pattern(value.childPattern, ['parent', 'child']),
    dateFormat: value.dateFormat as SkuDateFormat, sequencePadding: skuNamingInteger(value.sequencePadding, 1, 9), prefixes };
  // Reserve enough room for every supported sequence and child index at save time.
  for (const prefix of Object.values(prefixes)) renderSkuChild(template, renderSkuBase(template, prefix, '2026-10-08', SKU_MAX_SEQUENCE), SKU_MAX_CHILDREN);
  return template;
}
export function defaultSkuNamingSettings(): SkuNamingSettings {
  return { version: 1, revision: 0, defaultTemplateId: 'standard', templates: [{ id: 'standard', name: '店铺日期流水号',
    basePattern: '{prefix}-{date}-{sequence}', childPattern: '{parent}-{child}', dateFormat: 'yymmdd', sequencePadding: 1,
    prefixes: { U2: 'H2', U6: 'H6', U8: 'H8' } }], bindings: [] };
}
export function parseSkuNamingSettings(raw: unknown): SkuNamingSettings {
  const value = skuNamingObject(raw, ['version', 'revision', 'defaultTemplateId', 'templates', 'bindings']);
  if (value.version !== 1) return fail('SKU 规则版本不受支持');
  if (!Array.isArray(value.templates) || value.templates.length < 1 || value.templates.length > 50) return fail('SKU 模板数量需要为 1–50');
  const templates = value.templates.map(parseSkuNamingTemplate), ids = new Set(templates.map(template => template.id));
  if (ids.size !== templates.length || !ids.has(code(value.defaultTemplateId))) return fail('SKU 模板编号重复或默认模板不存在');
  if (!Array.isArray(value.bindings) || value.bindings.length > 200) return fail('SKU 店铺绑定数量超出限制');
  const seen = new Set<string>();
  const bindings = value.bindings.map(rawBinding => {
    const binding = skuNamingObject(rawBinding, ['storeCode', 'templateId'], ['targetId']);
    const templateId = code(binding.templateId), storeCode = code(binding.storeCode);
    const targetId = binding.targetId === undefined ? undefined : skuNamingText(binding.targetId, 100, 'SKU 目标店铺编号');
    const template = templates.find(item => item.id === templateId), key = targetId === undefined ? `store:${storeCode}` : `target:${targetId}`;
    if (!template || !Object.hasOwn(template.prefixes, storeCode) || seen.has(key)) return fail('SKU 店铺绑定重复、模板不存在或缺少前缀');
    seen.add(key);
    return { storeCode, templateId, ...(targetId === undefined ? {} : { targetId }) };
  });
  return { version: 1, revision: skuNamingInteger(value.revision, 0, Number.MAX_SAFE_INTEGER - 1), defaultTemplateId: String(value.defaultTemplateId), templates, bindings };
}
export function resolveSkuNamingTemplate(settings: SkuNamingSettings, storeCode: string, targetId?: string, templateId?: string): SkuNamingTemplate {
  code(storeCode);
  const bound = settings.bindings.find(binding => targetId !== undefined && binding.targetId === targetId)
    ?? settings.bindings.find(binding => binding.targetId === undefined && binding.storeCode === storeCode);
  if (bound && bound.storeCode !== storeCode) return fail('SKU 店铺绑定与当前店铺编号不一致，请检查规则');
  const template = settings.templates.find(item => item.id === (templateId ?? bound?.templateId ?? settings.defaultTemplateId));
  if (!template || !Object.hasOwn(template.prefixes, storeCode)) return fail('当前 SKU 模板缺少此店铺的前缀，请先设置店铺映射');
  return template;
}
export function previewSkuNaming(raw: unknown, savedSettings: SkuNamingSettings = defaultSkuNamingSettings()): SkuNamingPreview {
  const value = skuNamingObject(raw, ['storeCode', 'collectedAt', 'sequence', 'childCount'], ['settings', 'templateId', 'targetId']);
  const settings = value.settings === undefined ? savedSettings : parseSkuNamingSettings(value.settings);
  const storeCode = code(value.storeCode), targetId = value.targetId === undefined ? undefined : skuNamingText(value.targetId, 100, 'SKU 目标店铺编号');
  const template = resolveSkuNamingTemplate(settings, storeCode, targetId, value.templateId === undefined ? undefined : code(value.templateId));
  const collectionDate = skuCollectionDate(value.collectedAt), sequence = skuNamingInteger(value.sequence, 1, SKU_MAX_SEQUENCE);
  const childCount = skuNamingInteger(value.childCount, 0, SKU_MAX_CHILDREN);
  const baseSku = renderSkuBase(template, template.prefixes[storeCode], collectionDate, sequence);
  return { templateId: template.id, collectionDate, baseSku, childSkus: Array.from({ length: childCount }, (_, i) => renderSkuChild(template, baseSku, i + 1)) };
}
