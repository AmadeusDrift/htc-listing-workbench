import type { AiCall } from '../../shared/ai-contracts.ts';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { listingFingerprint } from '../json-fingerprint.ts';

/** Read-only ownership of an old planning call. This is deliberately not a
 * requestScope and must never be used to authorize send, retry or adoption. */
export function ownsLegacyPlanningCall(run:ImageWorkflowRun,call:AiCall):boolean {
  const p=call.presentationContext,context=run.imageContext,listing=context?.listing;
  return !call.requestScope&&run.status!=='COMPLETED'&&run.stage==='planning'&&!!context
    &&!!p&&p.kind==='image'&&p.workflowId===run.id&&p.slot===0&&p.draftId===run.draftId&&p.variantId===run.variantId
    &&call.productId===run.productId&&call.productRevision===run.productRevision
    &&listing?.draftId===run.draftId&&listing.variantId===run.variantId&&listing.sku===run.sku
    &&listing.productId===run.productId&&listing.productRevision===run.productRevision
    &&p.sourceSha256===run.contextSha256&&listingFingerprint(context)===run.contextSha256
    &&(call.purposeSnapshot?['image_plan','image_plan_repair'].includes(call.purposeSnapshot.purposeId):call.model==='deepseek-flash');
}
