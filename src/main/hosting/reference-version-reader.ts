import type {WorkspaceStore} from '../store.ts';
import type {ImageGenerationService} from '../image-generation/service.ts';
import type {ReferencePinDependencies,ReferenceVersion} from './reference-pins.ts';
import {readManagedImage} from '../ai/source.ts';
import {AiError} from '../ai/errors.ts';
/** Composition port for M09. Only owner-verified managed files can become pinned references. */
export function createReferenceVersionReader(directory:string,store:WorkspaceStore,generation:Pick<ImageGenerationService,'readCandidate'>):ReferencePinDependencies['readVersion']{
 return async(assetId,sha256)=>{
  const asset=store.getAssetRecord(assetId);
  if(asset){if(asset.sha256!==sha256||!['image/png','image/jpeg'].includes(asset.mimeType))throw new AiError('SOURCE_CHANGED');const bytes=await readManagedImage(directory,asset,new AbortController().signal);const version:ReferenceVersion={assetId,sha256,sourceKind:'source',sourceVersion:`asset:${assetId}:${sha256}`,originalPath:asset.originalPath,byteSize:asset.byteSize,mimeType:asset.mimeType as ReferenceVersion['mimeType']};return{version,bytes};}
  const {candidate,bytes}=await generation.readCandidate(assetId);if(candidate.sha256!==sha256)throw new AiError('SOURCE_CHANGED');return{version:{assetId,sha256,sourceKind:'candidate',sourceVersion:`candidate:${assetId}:${sha256}`,originalPath:`image-generation/candidates/${assetId}/image.png`,byteSize:candidate.byteSize,mimeType:candidate.mimeType},bytes};
 };
}
