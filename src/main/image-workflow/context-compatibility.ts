import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { listingFingerprint } from '../listing-ai/validation.ts';

/** Image requests do not consume field-card labels/help. Ignore only those two
 * metadata keys for compatibility; retain field order, rules and all other keys.
 * This is never a persisted evidence hash or a listing-field adoption check. */
export function imageListingContextsMatch(stored:ListingAiContext,current:ListingAiContext):boolean {
  const comparable=(context:ListingAiContext)=>({...context,fields:context.fields.map(({title:_title,description:_description,...field})=>field)});
  return listingFingerprint(comparable(stored))===listingFingerprint(comparable(current));
}
