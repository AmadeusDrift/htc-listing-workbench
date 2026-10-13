import { FULL_SCHEMA_CONTRACT } from '../../shared/listing-ai-contracts.ts';
import type { ListingFieldCandidate } from '../../shared/listing-ai-contracts.ts';
import type { AmazonSchema,JsonValue } from '../../shared/amazon-contracts.ts';
import { candidateTextValues,wrapCandidateValues } from '../amazon/field-mapping.ts';
export const isFullSchema=(context:{contract?:string}|undefined)=>context?.contract===FULL_SCHEMA_CONTRACT;
export const evidenceVersion=(context:{contract?:string}|undefined)=>isFullSchema(context)?'listing-evidence/v4' as const:'listing-evidence/v3' as const;
export const imageEvidenceVersion=(context:{contract?:string}|undefined)=>isFullSchema(context)?'listing-evidence/v4' as const:'listing-evidence/v5' as const;
export function nativeText(field:string,value:JsonValue):string[]{
  const known=candidateTextValues(field,value);if(known)return known;
  if(typeof value==='string')return[value];
  // Structured attributes are display data, not prose or claims for image captions.
  return [];
}
export function candidateNative(candidate:ListingFieldCandidate,schema:AmazonSchema,marketplaceId:string,existing?:JsonValue):JsonValue {
  return Object.hasOwn(candidate,'nativeValue')?structuredClone(candidate.nativeValue!):wrapCandidateValues(schema,marketplaceId,candidate.field,candidate.items.map(i=>i.value),existing);
}
