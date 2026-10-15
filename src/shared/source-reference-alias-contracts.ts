/** Frozen main-process wire metadata. Never part of the business source context. */
export const SOURCE_REFERENCE_PROTOCOL = 'source-reference-aliases/v1' as const;
export interface SourceReferenceAliases {
  version: typeof SOURCE_REFERENCE_PROTOCOL;
  contextSha256: string;
  entries: { alias: string; assetId: string; sha256: string }[];
}
