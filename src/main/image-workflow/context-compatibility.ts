import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { listingFingerprint } from '../listing-ai/validation.ts';
import { isFullSchema } from '../listing-ai/full-schema.ts';

/** Image requests do not consume field-card labels/help. Ignore only those two
 * metadata keys for compatibility; retain field order and source/schema rules.
 * Full-schema prose and image locators are mutable output; callers separately
 * check the draft stamp/current copy. Keep color, material and other attributes.
 * This is never a persisted evidence hash or a listing-field adoption check. */
export function imageListingContextsMatch(stored:ListingAiContext,current:ListingAiContext):boolean {
  const comparable=(context:ListingAiContext)=>{
    const value={...context,fields:context.fields.map(({title:_title,description:_description,...field})=>field)};
    if(isFullSchema(context))value.currentAttributes=Object.fromEntries(Object.entries(context.currentAttributes??{}).filter(([field])=>
      !['item_name','bullet_point','product_description','generic_keyword','main_product_image_locator'].includes(field)&&!/^other_product_image_locator_\d+$/.test(field)));
    return value;
  };
  return listingFingerprint(comparable(stored))===listingFingerprint(comparable(current));
}
