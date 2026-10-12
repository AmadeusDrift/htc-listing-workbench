import type {ProductDetail} from '../../shared/contracts.ts';
import type {SourceObservationEvidence} from '../../shared/source-image-consistency-contracts.ts';
/** Only an explicit observation of NO product appearance excludes a source image.
 * Text-heavy products and dimension diagrams remain usable; the source record is unchanged. */
export function productReferenceImages(product:ProductDetail,observations:SourceObservationEvidence[]):ProductDetail {
  const excluded=new Set(observations.flatMap(source=>source.images.filter(image=>image.contentPurpose==='instructions-only').map(image=>image.assetId)));
  return excluded.size?{...product,assets:product.assets.filter(asset=>!excluded.has(asset.id))}:product;
}
