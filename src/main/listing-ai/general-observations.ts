import type { ListingEvidence } from '../../shared/listing-ai-contracts.ts';
import type { SourceObservationEvidence } from '../../shared/source-image-consistency-contracts.ts';

/** General visible features do not require neutral color lighting. This grants
 * no color authority and leaves original assessments and observations intact. */
export function generalObservationEvidence(source:SourceObservationEvidence):ListingEvidence[] {
  return source.images.filter(image=>!source.productReferenceAssetIds?.includes(image.assetId)
    &&image.quality==='clear'&&image.visibility==='complete'&&image.presentation==='single-product'
    &&(image.lighting==='neutral'||!!source.assessmentId)
    &&(image.contentPurpose===undefined||image.contentPurpose==='product'))
    .flatMap(image=>(image.observations??[]).flatMap((observation,index)=>observation.visibility==='visible'
      &&(!/color|colour|颜[色]|色彩/i.test(observation.name)||image.lighting==='neutral')
      ?[{id:`${source.variantId}:observation:${image.assetId}:${index}`,name:observation.name,value:observation.values.join(', '),meaning:'general' as const,source:'image_observation' as const}]:[]));
}
