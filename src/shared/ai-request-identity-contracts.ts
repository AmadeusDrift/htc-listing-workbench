export const AI_REQUEST_OPERATIONS = ['source-ocr','source-segmentation','content-suggestion','content-review','listing-fields','listing-copy-review','category','source-observation','source-color','image-plan','generated-image-ocr','image-text-review','image-appearance-review','image-ip-review','legacy-text-request','legacy-text-review-request'] as const;
/** Stable business identity. No configuration, task ID, revision, retry nonce or repair text. */
export interface AiRequestScope {
  version:1; productId:string; operation:typeof AI_REQUEST_OPERATIONS[number];
  variantId?:string; variantIds?:string[]; assetId?:string; sku?:string; targetId?:string; marketplaceId?:string;
  slot?:number; candidateSha256?:string; phase?:'keywords'|'select'|'judge';
}
export interface ProviderReceiptRecovery {
  version:1;receiptId:string;requestFingerprint:string;scopeSha256:string;recoveredAt:string;
}
