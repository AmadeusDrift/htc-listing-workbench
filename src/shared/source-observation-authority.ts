import type { SourceObservationEvidence, SourceConsistencyOutput } from './source-image-consistency-contracts.ts';

/** Current-use permission only. Keep uncertain observations and historic verdicts intact. */
export function skuObservationImages(source:SourceObservationEvidence,variantId:string):SourceConsistencyOutput['assets'] {
  if(source.variantId!==variantId)return [];
  return source.images.filter(image=>!source.productReferenceAssetIds?.includes(image.assetId)
    &&image.quality==='clear'&&image.visibility==='complete'&&image.lighting==='neutral'
    &&image.presentation==='single-product'
    // Older observations had no contentPurpose; preserve their existing visible-image contract.
    &&(image.contentPurpose===undefined||image.contentPurpose==='product'));
}
