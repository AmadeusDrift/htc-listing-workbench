export const SOURCE_COLOR_POLICY_VERSION = 'source-color/v1' as const;
export const SOURCE_COLOR_VALUES = ['White','Black','Gray','Silver','Gold','Copper','Red','Pink','Orange','Yellow','Green','Blue','Purple','Brown','Beige','Clear','Multicolor'] as const;
export type SourceColorValue = typeof SOURCE_COLOR_VALUES[number];
/** Main-process provenance for original, SKU-bound images; never generated images or listing values. */
export interface SourceColorContext {
  policyVersion: typeof SOURCE_COLOR_POLICY_VERSION;
  productId: string; productRevision: number; variantId: string;
  sourceSpec: string;
  referenceAssets: { assetId: string; sha256: string }[];
}
/** Visible product colors only. An uncertain/conflicting observation is not positive color evidence. */
export interface SourceColorOutput {
  kind: 'source-color'; verdict: 'DETERMINED' | 'UNCERTAIN' | 'CONFLICTING';
  colors: SourceColorValue[]; reason: string; referenceAssetIds: string[];
}
