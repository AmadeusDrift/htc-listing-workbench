import type { AiResult } from './ai-contracts.ts';
import type { AmazonDraft, JsonValue, ListingProgram, ListingRequirements, ParentageLevel } from './amazon-contracts.ts';
import type { SourceColorContext, SourceColorValue } from './source-color-contracts.ts';

export const INFERABLE_CATEGORY_FIELDS = ['item_firmness_description','age_range_description','is_heat_sensitive','power_source_type','material_feature','is_expiration_dated_product',
  'item_form','dental_floss_type','flavor','contains_liquid_contents','scent','specific_uses_for_product','surface_recommendation','closure','department','target_gender'] as const;
export const CATEGORY_ATTRIBUTE_FIELDS = [...INFERABLE_CATEGORY_FIELDS,'ingredients'] as const;
export const LISTING_BOOLEAN_FIELDS = ['is_heat_sensitive','is_expiration_dated_product','contains_liquid_contents'] as const;
export const CATEGORY_INFERENCE_POLICY_VERSION = 'category-attributes-2026-10-09-v1' as const;
export const LISTING_EVIDENCE_CONTRACT_VERSION = 'listing-evidence/v3' as const;
export const LISTING_EVIDENCE_CONTRACT_VERSIONS = ['listing-evidence/v1','listing-evidence/v2','listing-evidence/v3'] as const;
export type ListingEvidenceContractVersion = typeof LISTING_EVIDENCE_CONTRACT_VERSIONS[number];
export const LISTING_CANDIDATE_FIELDS = ['item_name', 'bullet_point', 'product_description', 'generic_keyword', 'material', 'color', 'item_shape', 'care_instructions',
  'operation_mode', 'included_components', 'special_feature', 'fabric_type', 'theme', 'subject_character', 'blade', 'target_audience', ...CATEGORY_ATTRIBUTE_FIELDS] as const;
export type CandidateField = typeof LISTING_CANDIDATE_FIELDS[number];
/** Classify supported generation paths explicitly; adding a field never relaxes protected inputs. */
export function listingFieldPolicy(field:string):'copy'|'source_attribute'|'product_judgment'|'business_rule'|'measurement'|'blocked'|'unsupported'{
  if((INFERABLE_CATEGORY_FIELDS as readonly string[]).includes(field))return 'product_judgment';
  if(['item_name','bullet_point','product_description','generic_keyword'].includes(field))return 'copy';
  if((LISTING_CANDIDATE_FIELDS as readonly string[]).includes(field))return 'source_attribute';
  if(['country_of_origin','import_designation','batteries_required','supplier_declared_dg_hz_regulation'].includes(field))return 'business_rule';
  if(field==='size')return 'source_attribute';
  if(/dimensions?|weight|volume|quantity|unit_count|number_of_(?:items|boxes|packs)|item_package_quantity/.test(field))return 'measurement';
  if(/brand|manufacturer|origin|batter|danger|hazard|compliance|certif|safety|price|offer|inventory|fulfillment|dimensions?|weight|quantity|unit_count|number_of_items|sku|asin|identifier/i.test(field))return 'blocked';
  return 'unsupported';
}
export interface ListingFieldCandidate {
  field: CandidateField;
  items: { value: string; evidenceIds: string[]; transformation: 'copy' | 'translate' | 'compose' | 'enum_map' | 'infer'; inferenceReason?: string }[];
}
export interface ListingFieldsOutput { kind: 'amazon-fields'; candidates: ListingFieldCandidate[]; missing: { field: CandidateField; reason: string }[] }
export interface ListingClaim { text: string; verdict: 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED'; evidenceIds: string[]; reason: string }
export interface ListingFieldsReviewOutput {
  kind: 'amazon-fields-review'; verdict: 'PASS' | 'NEEDS_CHANGES' | 'BLOCKED';
  checks: { field: CandidateField; index: number; verdict: ListingClaim['verdict']; evidenceIds: string[]; reason: string; claims: ListingClaim[] }[];
  issues: { field: CandidateField; message: string }[];
}
export interface ListingEvidence { id: string; name: string; value: string; meaning: 'general' | 'material' | 'color' | 'item_shape' | 'care_instructions'; source: 'source_confirmed' | 'human_confirmed' | 'selected_sku' | 'source_image'; imageObservation?: { resultId:string; context:SourceColorContext; colors:SourceColorValue[] } }
export interface ListingFieldCard {
  name: CandidateField; title: string; requirement: 'required' | 'conditional' | 'optional';
  description?: string;
  closedEnum: boolean; allowedValues: JsonValue[]; suggestedValues: JsonValue[];
  minLength?: number; maxLength?: number; minUtf8ByteLength?: number; maxUtf8ByteLength?: number; minItems?: number; maxItems?: number;
}
export interface ListingAiContext {
  draftId: string; draftRevision: number; productId: string; productRevision: number; variantId: string; sku: string;
  targetId: string; targetGeneration: number; listingProgram: ListingProgram; productType: string; marketplaceId: string; locale: string;
  requirements: ListingRequirements; parentageLevel: ParentageLevel; schemaChecksum: string; schemaVersion: string; schemaSha256: string; policyVersion: string;
  fields: ListingFieldCard[]; evidence: ListingEvidence[];
  evidenceBlockers?: {field:CandidateField;reason:'source_conflict';facts:{id:string;name:string;value:string}[]}[];
  categoryInferencePolicyVersion?: typeof CATEGORY_INFERENCE_POLICY_VERSION;
  unverifiedSourceTitle: string;
  repairRequest?: { issues: { field: CandidateField; code: string; message: string }[]; currentValues: Partial<Record<CandidateField, JsonValue>> };
}
export interface SuggestAmazonFieldsInput { draftId: string; draftRevision: number }
export interface ReviewAmazonFieldsInput extends SuggestAmazonFieldsInput { suggestionResultId: string }
export interface AdoptAmazonFieldsInput extends ReviewAmazonFieldsInput { reviewResultId: string | null; fields: CandidateField[] }
export interface ListingFieldAdoption {
  id: string; at: string; suggestionResultId: string; reviewResultId: string | null; contextSha256: string;
  reviewDisposition?: 'SKIPPED_DISABLED';
  fromRevision: number; toRevision: number; fields: CandidateField[];
  changes: { field: CandidateField; before: JsonValue | null; after: JsonValue; evidence: ListingEvidence[] }[];
}
export interface ListingAiApi {
  completeAmazonFields(input: SuggestAmazonFieldsInput): Promise<{ draft: AmazonDraft; aiCalls: number; previewAttempts: number; remaining: string[] }>;
  suggestAmazonFields(input: SuggestAmazonFieldsInput): Promise<AiResult>;
  reviewAmazonFields(input: ReviewAmazonFieldsInput): Promise<AiResult>;
  adoptAmazonFields(input: AdoptAmazonFieldsInput): Promise<AmazonDraft>;
  cancelAmazonFields(draftId: string): Promise<{ cancelled: boolean }>;
}
