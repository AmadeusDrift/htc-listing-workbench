import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { resultHasOwner } from '../ai/result-owner.ts';
import { listingFingerprint } from '../json-fingerprint.ts';

/** Restore only an adopted field's original general observation citation. The
 * current observations were already verified by sourceObservationEvidence; this
 * does not make uncertain lighting a color authority or authorize a new request. */
export function retainAdoptedObservationEvidence(draft:AmazonDraft,context:ListingAiContext,getResult:(id:string)=>AiResult|undefined,getCall:(id:string)=>AiCall|undefined):void {
  const owners=new Map<string,NonNullable<AmazonDraft['fieldAdoptions']>[number]>();
  for(const adoption of draft.fieldAdoptions??[])for(const change of adoption.changes)
    if(draft.attributes[change.field]!==undefined&&listingFingerprint(change.after)===listingFingerprint(draft.attributes[change.field]))owners.set(change.field,adoption);
  for(const adoption of new Set(owners.values())){
    const result=getResult(adoption.suggestionResultId),original=result?.listingContext;
    if(!result||result.id!==adoption.suggestionResultId||result.output.kind!=='amazon-fields'||!original||original.draftRevision!==adoption.fromRevision||result.productId!==context.productId||result.productRevision!==context.productRevision||result.sourceSha256!==adoption.contextSha256||listingFingerprint(original)!==adoption.contextSha256)continue;
    const call=getCall(result.callId);
    if(call?.status!=='SUCCEEDED'||!resultHasOwner(result,call)||original.draftId!==draft.id||original.productId!==context.productId||original.productRevision!==context.productRevision||original.variantId!==context.variantId||original.sku!==context.sku||original.targetId!==context.targetId||original.marketplaceId!==context.marketplaceId)continue;
    for(const change of adoption.changes){
      if(owners.get(change.field)!==adoption||!adoption.fields.includes(change.field))continue;
      const candidate=result.output.candidates.find(item=>item.field===change.field);
      if(!candidate||!Object.hasOwn(candidate,'nativeValue')||listingFingerprint(candidate.nativeValue)!==listingFingerprint(change.after))continue;
      for(const id of new Set(candidate.items.flatMap(item=>item.evidenceIds))){
        if(context.evidence.some(item=>item.id===id))continue;
        const evidence=original.evidence.find(item=>item.id===id);
        if(!evidence||evidence.source!=='image_observation'||evidence.meaning!=='general'||/color|colour|颜[色]|色彩/i.test(evidence.name)||!change.evidence.some(item=>listingFingerprint(item)===listingFingerprint(evidence)))continue;
        for(const source of context.sourceProduct?.observations??[]){
          if(!source.assessmentId)continue;
          const oldSource=original.sourceProduct?.observations?.find(item=>item.variantId===source.variantId&&item.assessmentId===source.assessmentId);
          if(!oldSource)continue;
          for(const image of source.images){
            if(source.productReferenceAssetIds?.includes(image.assetId)||image.quality!=='clear'||image.visibility!=='complete'||image.presentation!=='single-product'||image.lighting!=='uncertain'||image.contentPurpose==='instructions-only'||image.contentPurpose==='unknown')continue;
            const oldImage=oldSource.images.find(item=>item.assetId===image.assetId);
            if(!oldImage||listingFingerprint(oldImage)!==listingFingerprint(image))continue;
            for(const [index,observation] of (image.observations??[]).entries()){
              if(id!==`${source.variantId}:observation:${image.assetId}:${index}`||observation.visibility!=='visible'||evidence.name!==observation.name||evidence.value!==observation.values.join(', '))continue;
              context.evidence.push(structuredClone(evidence));
            }
          }
        }
      }
    }
  }
}
