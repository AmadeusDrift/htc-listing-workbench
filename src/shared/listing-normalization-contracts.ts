import type { CandidateField } from './listing-ai-contracts.ts';

export type ListingNormalizationRule = 'ascii-width' | 'trim' | 'boolean-literal' | 'schema-enum' | 'fabric-not-applicable';
export interface ListingNormalizationEntry {
  field: CandidateField;
  index: number;
  rawValue: string | boolean;
  value: string;
  ruleIds: ListingNormalizationRule[];
  evidenceIds: string[];
}
/** Main-process provenance for newly ingested responses; never model-supplied evidence. */
export interface ListingNormalization {
  version: 'listing-normalization/v1';
  entries: ListingNormalizationEntry[];
}
