import type { JsonObject, JsonValue, ListingIssue } from './amazon-contracts.ts';
export type ListingCorrectionState='PREPARED'|'READY'|'SENDING'|'ACCEPTED'|'VERIFIED'|'REJECTED'|'STALE'|'CANCELLED'|'UNKNOWN';
export interface ListingCorrectionReference {id:string;revision:number;patchHash:string}
export interface ListingCorrection extends ListingCorrectionReference {
 correctionVersion?:2;scope?:string[];evidence?:string[];problemKey?:string;round?:number;
 draftId:string;draftRevision:number;draftStamp:string;listingHash:string;previousId:string|null;
 targetId:string;sellerId:string;marketplaceId:string;sku:string;productType:string;locale:string;generation:number;targetStamp:string;
 typeEvidence:string;submittedAttributesHash:string;remoteLocalIssues:ListingIssue[];state:ListingCorrectionState;request:JsonObject;before:JsonObject;after:JsonObject;baselineHash:string;schemaHash:string;
 createdAt:string;updatedAt:string;readyAt:string|null;message:string;preview:JsonObject|null;response:JsonObject|null;readback:JsonObject|null;remainingIssues:JsonValue[];
}
export interface ListingCorrectionAttempt {id:string;correctionId:string;listingHash:string;intentAt:string;request:JsonObject;patchHash:string;identity:JsonObject;state:ListingCorrectionState;response:JsonObject|null;readback:JsonObject|null}
