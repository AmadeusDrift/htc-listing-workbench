/** Phase-1 boundary. Credentials and network implementation belong to the main process only. */
export interface AmazonContext { targetId: string; sellerId: string; marketplaceId: string }
export interface SchemaRequest extends AmazonContext { productType: string; locale: string; requirements: string; parentageLevel: 'NONE' | 'PARENT' | 'CHILD' }
export interface AmazonIssue { code: string; message: string; severity: 'ERROR' | 'WARNING' | 'INFO'; attributeNames: string[] }
export interface AmazonProvider {
  getProductTypeSchema(request: SchemaRequest): Promise<{ schema: unknown; metaSchema: unknown; checksum: string }>;
  validationPreview(context: AmazonContext, sku: string, draft: unknown): Promise<{ issues: AmazonIssue[]; requestId: string }>;
  submitListing(context: AmazonContext, sku: string, draft: unknown): Promise<{ submissionId: string; status: string; requestId: string }>;
  getListing(context: AmazonContext, sku: string): Promise<{ statuses: string[]; issues: AmazonIssue[]; requestId: string }>;
}
export interface CollectionSnapshot { version: 1; sourceUrl: string; offerId: string; collectedAt: string; parserVersion: string; sanitizedSnapshot: unknown }
export interface ImageProcessor { process(assetId: string, operation: 'resize' | 'crop' | 'convert'): Promise<{ newAssetId: string }> }
export interface ContentSuggestion { value: string; sourceFactIds: string[]; state: 'ai_suggested' }
