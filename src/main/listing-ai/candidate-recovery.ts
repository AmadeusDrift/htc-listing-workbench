import type {ListingAiContext,ListingFieldsOutput} from '../../shared/listing-ai-contracts.ts';
import { fullReference, parseFullGeneration, retainValidNativeCandidates } from "./full-schema.ts";
import { isFullSchema } from "./native-values.ts";
import { listingFingerprint } from "../json-fingerprint.ts";
/** Replay retained references and revalidate colors under the same source guards.
 * legacy is reserved for verification of already-stored v1 derivatives. */
export function replayReferenceCandidates(output:ListingFieldsOutput,context:ListingAiContext,legacy=false):ListingFieldsOutput {
 const fields=new Set(output.missing.filter(m=>m.reason.includes('[FIELD_REFERENCE]')||!legacy&&m.field==='color'&&m.reason.includes('[SOURCE_VALUE_CONFLICT]')).map(m=>m.field));
 const candidates=(output.rejectedCandidates??[]).filter(c=>fields.has(c.field)&&(legacy||c.items.length>0&&c.items.every(item=>item.evidenceIds.some(id=>fullReference(context,id)))));
 const replayed=new Set(legacy?[...fields]:candidates.map(c=>c.field));
 const result=retainValidNativeCandidates(parseFullGeneration({kind:'amazon-fields',contract:output.contract,candidates:[...output.candidates,...candidates],missing:output.missing.filter(m=>!replayed.has(m.field))},context),context);
 if(!legacy){const retained=(output.rejectedCandidates??[]).filter(c=>!replayed.has(c.field));if(retained.length)(result.rejectedCandidates??=[]).push(...structuredClone(retained));}
 return result;
}
export function sameRecoverySource(before:ListingAiContext,after:ListingAiContext):boolean {
 if(!isFullSchema(before)||!isFullSchema(after))return false;
 const identity=(c:ListingAiContext)=>{const {draftRevision:_,fields:_f,currentAttributes:_a,businessValues:_b,repairRequest:_r,...source}=c;return source;};
 return listingFingerprint(identity(before))===listingFingerprint(identity(after));
}
