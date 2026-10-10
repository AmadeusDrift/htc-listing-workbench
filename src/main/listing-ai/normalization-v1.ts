/** Frozen ingestion/provenance rules for listing-normalization/v1. Do not rewrite stored output. */
import { LISTING_CANDIDATE_FIELDS } from '../../shared/listing-ai-contracts.ts';
import type { CandidateField, ListingAiContext, ListingFieldCard, ListingFieldsOutput } from '../../shared/listing-ai-contracts.ts';
import type { ListingNormalization, ListingNormalizationEntry, ListingNormalizationRule } from '../../shared/listing-normalization-contracts.ts';
import { hasSemanticEvidence } from './evidence-semantic-v0.ts';
import { ListingValidationError } from './validation.ts';

const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw);
const booleanFields = ['is_heat_sensitive', 'is_expiration_dated_product', 'contains_liquid_contents'];
// Compatibility numerals, Roman numerals, ligatures and model identifiers are not NFKC-folded.
const width = (value: string): string => value.replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
const enumKey = (value: string): string => width(value).trim().toLowerCase();

function normalizedValue(rawValue: unknown, card: ListingFieldCard, evidenceIds: string[], context: ListingAiContext): { value: unknown; ruleIds: ListingNormalizationRule[] } {
  const ruleIds: ListingNormalizationRule[] = [];
  const boolean = booleanFields.includes(card.name);
  if (typeof rawValue !== 'string' && !(boolean && typeof rawValue === 'boolean')) return { value: rawValue, ruleIds };
  if (typeof rawValue === 'string' && (rawValue.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(rawValue))) throw new ListingValidationError('字段原始文本过长或包含不支持的控制字符');
  // A schema's exact literal (including its spelling/whitespace) takes precedence.
  if (typeof rawValue === 'string' && card.closedEnum && card.allowedValues.includes(rawValue)) return { value: rawValue, ruleIds };
  if (typeof rawValue === 'boolean' && card.closedEnum && (card.allowedValues.includes(rawValue) || card.allowedValues.includes(String(rawValue)))) return { value: String(rawValue), ruleIds: ['boolean-literal'] };
  let value: string;
  if (typeof rawValue === 'boolean') { value = String(rawValue); ruleIds.push('boolean-literal'); }
  else {
    value = width(rawValue); if (value !== rawValue) ruleIds.push('ascii-width');
    const trimmed = value.trim(); if (trimmed !== value) ruleIds.push('trim'); value = trimmed;
    if (boolean && /^(?:true|false)$/i.test(value) && value !== value.toLowerCase()) { value = value.toLowerCase(); ruleIds.push('boolean-literal'); }
  }
  if (card.closedEnum) {
    const matches = card.allowedValues.filter(option => typeof option === 'string' && enumKey(option) === enumKey(value)
      || boolean && typeof option === 'boolean' && String(option) === value);
    if (matches.length > 1) throw new ListingValidationError('字段格式对应多个 Schema 枚举选项，不能确定唯一值');
    if (matches.length === 1) {
      const exact = String(matches[0]); if (value !== exact) { value = exact; ruleIds.push('schema-enum'); }
    } else if (card.name === 'fabric_type' && /^n\/?a$/i.test(value)) {
      const options = card.allowedValues.filter((option): option is string => typeof option === 'string' && /^not[ _]applicable$/i.test(option));
      if (options.length > 1) throw new ListingValidationError('字段格式对应多个 Schema 枚举选项，不能确定唯一值');
      const evidence = context.evidence.filter(entry => evidenceIds.includes(entry.id));
      if (options.length === 1 && hasSemanticEvidence('fabric_type', options[0], evidence)) { value = options[0]; ruleIds.push('fabric-not-applicable'); }
    }
  }
  return { value, ruleIds };
}

/** Preserve all keys and invalid types for the strict parser; only known candidate value leaves can change. */
export function normalizeListingCandidate(raw: unknown, context: ListingAiContext): { candidate: unknown; entries: ListingNormalizationEntry[] } {
  const entries: ListingNormalizationEntry[] = [];
  if (!object(raw) || !(LISTING_CANDIDATE_FIELDS as readonly unknown[]).includes(raw.field) || !Array.isArray(raw.items)) return { candidate: raw, entries };
  const card = context.fields.find(card => card.name === raw.field); if (!card) return { candidate: raw, entries };
  const items = raw.items.map((item: unknown, index: number) => {
    if (!object(item) || !Array.isArray(item.evidenceIds) || item.evidenceIds.some(id => typeof id !== 'string')) return item;
    const evidenceIds = item.evidenceIds as string[], { value, ruleIds } = normalizedValue(item.value, card, evidenceIds, context);
    if (ruleIds.length && value !== item.value && typeof value === 'string') entries.push({ field: raw.field as CandidateField, index, rawValue: item.value as string | boolean, value, ruleIds, evidenceIds: [...evidenceIds] });
    return { ...item, value };
  });
  return { candidate: { ...raw, items }, entries };
}

export function normalizeListingGeneration(raw: unknown, context: ListingAiContext): { content: unknown; entries: ListingNormalizationEntry[] } {
  const entries: ListingNormalizationEntry[] = [];
  if (!object(raw) || !Array.isArray(raw.candidates)) return { content: raw, entries };
  const candidates = raw.candidates.map(candidate => { const normalized = normalizeListingCandidate(candidate, context); entries.push(...normalized.entries); return normalized.candidate; });
  return { content: { ...raw, candidates }, entries };
}

/** Recompute only the recorded conversion to verify provenance; return stored values without rewriting them. */
export function validateListingNormalizationV1(raw: unknown, output: ListingFieldsOutput, context: ListingAiContext): ListingNormalization {
  const fail = (): never => { throw new ListingValidationError('字段规范化记录与实际候选或转换规则不一致'); };
  const keys = (value: unknown, names: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).sort().join() === [...names].sort().join();
  if (!keys(raw, ['version', 'entries']) || raw.version !== 'listing-normalization/v1' || !Array.isArray(raw.entries) || !raw.entries.length
    || raw.entries.length > output.candidates.reduce((count, candidate) => count + candidate.items.length, 0)) return fail();
  const seen = new Set<string>();
  for (const entry of raw.entries) {
    if (!keys(entry, ['field', 'index', 'rawValue', 'value', 'ruleIds', 'evidenceIds']) || !Number.isSafeInteger(entry.index) || Number(entry.index) < 0
      || !['string', 'boolean'].includes(typeof entry.rawValue)) return fail();
    const card = context.fields.find(card => card.name === entry.field), candidate = output.candidates.find(candidate => candidate.field === entry.field)?.items[Number(entry.index)];
    const key = `${entry.field}:${entry.index}`;
    if (!card || !candidate || seen.has(key) || candidate.value !== entry.value || entry.rawValue === entry.value
      || JSON.stringify(candidate.evidenceIds) !== JSON.stringify(entry.evidenceIds) || candidate.evidenceIds.some(id => !context.evidence.some(evidence => evidence.id === id))) return fail();
    const replay = normalizedValue(entry.rawValue, card, candidate.evidenceIds, context);
    if (replay.value !== entry.value || !replay.ruleIds.length || JSON.stringify(replay.ruleIds) !== JSON.stringify(entry.ruleIds)) return fail();
    seen.add(key);
  }
  return structuredClone(raw) as unknown as ListingNormalization;
}
