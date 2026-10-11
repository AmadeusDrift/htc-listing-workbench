import { compatibleApprovalRecipe } from './approval-reuse.ts';
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
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { ProductImageContext } from '../../shared/image-ai-contracts.ts';
import { imageRiskSourceSnapshot } from '../ai/image-validation.ts';

/** A historical image context is immutable. Compatibility is proved from source
 * inputs, not its finite field projection or the current policy's evidence IDs. */
export function imageActualInputsMatch(base:ProductImageContext,draft:AmazonDraft,product:ProductDetail,current:ListingAiContext,recipeHash?:string):boolean {
  if(isFullSchema(base.listing)||!isFullSchema(current))return imageListingContextsMatch(base.listing,{...current,draftRevision:base.listing.draftRevision});
  const identity=['draftId','productId','productRevision','variantId','sku','targetId','targetGeneration','listingProgram','productType','marketplaceId','locale','requirements','parentageLevel','schemaChecksum','schemaVersion','schemaSha256','unverifiedSourceTitle'] as const;
  if(identity.some(key=>listingFingerprint(base.listing[key]??null)!==listingFingerprint(current[key]??null)))return false;
  if(!base.ipSource)return false;
  const raw=(source:NonNullable<ProductImageContext['ipSource']>)=>({...source,facts:source.facts.map(({id:_id,...fact})=>fact)});
  if(listingFingerprint(raw(base.ipSource))!==listingFingerprint(raw(imageRiskSourceSnapshot(product,draft.variantId))))return false;
  if(!compatibleApprovalRecipe({variantId:base.listing.variantId,imageContext:base,...(recipeHash?{imageRecipeSha256:recipeHash}:{})},draft.salesPlan?.recipe??null))return false;
  return true;
}
