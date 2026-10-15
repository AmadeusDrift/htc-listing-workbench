import { decodeArtifactInBackground } from '../image-processing/client.ts';
import type { DecodedArtifact } from './service.ts';

/** Decode, alpha inspection and preview generation run in the sequential image process. */
export function decodeArtifact(bytes:Buffer):Promise<DecodedArtifact> {
  return decodeArtifactInBackground(bytes);
}
