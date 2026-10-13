import type {ListingAiContext,ListingFieldsOutput} from '../../shared/listing-ai-contracts.ts';
import { parseFullGeneration, retainValidNativeCandidates } from "./full-schema.ts";
import { isFullSchema } from "./native-values.ts";
import { listingFingerprint } from "../json-fingerprint.ts";
/** Only the known reference-parser rejection is replayed; other conflicts stay rejected. */
export function replayReferenceCandidates(output:ListingFieldsOutput,context:ListingAiContext):ListingFieldsOutput {
 const fields=new Set(output.missing.filter(m=>m.reason.includes('[FIELD_REFERENCE]')).map(m=>m.field));
 const candidates=(output.rejectedCandidates??[]).filter(c=>fields.has(c.field));
 return retainValidNativeCandidates(parseFullGeneration({kind:'amazon-fields',contract:output.contract,candidates:[...output.candidates,...candidates],missing:output.missing.filter(m=>!fields.has(m.field))},context),context);
}
export function sameRecoverySource(before:ListingAiContext,after:ListingAiContext):boolean {
 if(!isFullSchema(before)||!isFullSchema(after))return false;
 const identity=(c:ListingAiContext)=>{const {draftRevision:_,fields:_f,currentAttributes:_a,businessValues:_b,repairRequest:_r,...source}=c;return source;};
 return listingFingerprint(identity(before))===listingFingerprint(identity(after));
}
