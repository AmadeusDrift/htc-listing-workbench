import type { CurrentListingCopy } from '../../shared/image-ai-contracts.ts';
import { DIMENSION_FIELDS } from '../amazon/field-mapping.ts';
import { HAUL_UNSUPPORTED_FIELDS } from '../amazon/listing-program.ts';
import { compatibleApprovalRecipe } from './approval-reuse.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { listingFingerprint } from "../json-fingerprint.ts";
import { isFullSchema } from "../listing-ai/native-values.ts";
import { generalObservationEvidence } from '../listing-ai/general-observations.ts';

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
  const left=structuredClone(comparable(stored)),right=structuredClone(comparable(current));
  // A projection is not a source change. Only remove exact general citations
  // proven by the same original assessment/images/values on both sides.
  if(isFullSchema(stored)&&isFullSchema(current)&&stored.sourceProduct?.observations?.length&&stored.sourceProduct.observations.every(source=>!!source.assessmentId)
    &&listingFingerprint(stored.sourceProduct.observations)===listingFingerprint(current.sourceProduct?.observations??[])){
    const proven=new Set(stored.sourceProduct.observations.flatMap(generalObservationEvidence).filter(item=>!/color|colour|颜[色]|色彩/i.test(item.name)).map(item=>listingFingerprint(item)));
    left.evidence=left.evidence.filter(item=>!proven.has(listingFingerprint(item)));
    right.evidence=right.evidence.filter(item=>!proven.has(listingFingerprint(item)));
  }
  if(isFullSchema(stored)&&isFullSchema(current)&&stored.listingProgram==='haul'&&current.listingProgram==='haul'){
    const managed=['brand','manufacturer','country_of_origin','import_designation','model_number','model_name','part_number','condition_type','list_price','purchasable_offer','gpsr_safety_attestation','batteries_required','supplier_declared_dg_hz_regulation','required_product_compliance_certificate',...DIMENSION_FIELDS,'item_weight','item_package_weight'];
    const same=(a:unknown,b:unknown)=>a===undefined||b===undefined?a===b:listingFingerprint(a)===listingFingerprint(b);
    for(const field of managed){
      const a=left.currentAttributes?.[field],b=right.currentAttributes?.[field];
      const proven=(context:typeof left)=>context.currentAttributes?.[field]!==undefined&&context.businessValues?.[field]!==undefined&&same(context.currentAttributes[field],context.businessValues[field]);
      const clean=(context:typeof left)=>{if(context.currentAttributes)delete context.currentAttributes[field];if(context.businessValues)delete context.businessValues[field];};
      if(same(a,b)&&(proven(left)||proven(right))){
        // Same old attribute can predate its rule report; no product input changed.
        if(left.businessValues?.[field]===undefined||proven(left))if(right.businessValues?.[field]===undefined||proven(right)){clean(left);clean(right);}
      }else if((a===undefined&&left.businessValues?.[field]===undefined||proven(left))&&(b===undefined&&right.businessValues?.[field]===undefined||proven(right))){clean(left);clean(right);}
    }
    for(const field of HAUL_UNSUPPORTED_FIELDS){delete left.currentAttributes?.[field];delete right.currentAttributes?.[field];delete left.businessValues?.[field];delete right.businessValues?.[field];}
  }
  return listingFingerprint(left)===listingFingerprint(right);
}

/** Bounded diagnostic labels only; never used as request/adoption authority. */
export function imageListingContextChanges(stored:ListingAiContext,current:ListingAiContext):string[] {
  const same=(a:unknown,b:unknown)=>listingFingerprint(a??null)===listingFingerprint(b??null),changes:string[]=[];
  if(!same([stored.schemaChecksum,stored.schemaVersion,stored.schemaSha256,stored.fullSchema],[current.schemaChecksum,current.schemaVersion,current.schemaSha256,current.fullSchema]))changes.push('Schema');
  const identity=(c:ListingAiContext)=>[c.draftId,c.productId,c.productRevision,c.variantId,c.sku,c.targetId,c.targetGeneration,c.marketplaceId,c.productType,c.listingProgram];
  if(!same(identity(stored),identity(current)))changes.push('来源或卖家站点身份');
  if(!same(stored.sourceProduct?.assets,current.sourceProduct?.assets))changes.push('原图');
  if(!same(stored.sourceProduct?.observations,current.sourceProduct?.observations))changes.push('原始图片观察');
  if(!same(stored.sourceProduct?.facts,current.sourceProduct?.facts)||!same(stored.sourceProduct?.selectedSku,current.sourceProduct?.selectedSku)||!same(stored.currentAttributes,current.currentAttributes))changes.push('商品属性或人工事实');
  const colors=(c:ListingAiContext)=>c.evidence.filter(item=>item.meaning==='color'||/color|colour|颜[色]|色彩/i.test(item.name));
  if(!same(colors(stored),colors(current)))changes.push('颜色依据');
  if(!same(stored.evidence,current.evidence))changes.push('字段依据投影');
  return changes.length?changes:['其他图片上下文'];
}
/** Source attributes remain covered by context comparison; newly filled rule
 * labels are not new image prose. Never relax actual title/bullet/description copy. */
export function imageListingCopyMatches(stored:ListingAiContext,current:ListingAiContext,before:CurrentListingCopy[],after:CurrentListingCopy[]):boolean {
  if(listingFingerprint(before)===listingFingerprint(after))return true;
  if(!isFullSchema(stored)||!isFullSchema(current)||stored.listingProgram!=='haul'||current.listingProgram!=='haul'
    ||!imageListingContextsMatch(stored,{...current,draftRevision:stored.draftRevision}))return false;
  const prose=(copy:CurrentListingCopy[])=>copy.filter(item=>['item_name','bullet_point','product_description','generic_keyword'].includes(item.field));
  return listingFingerprint(prose(before))===listingFingerprint(prose(after));
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
