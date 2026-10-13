import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { hasSevenApprovedImages } from '../../shared/image-workflow-contracts.ts';
import { buildListingContext } from '../listing-ai/context.ts';
import { listingFingerprint } from "../json-fingerprint.ts";
import { currentImageListingSnapshot } from './image-facts.ts';
import { imageWorkflowDraftStamp } from "./approval-reuse.ts";
import { imageListingContextsMatch } from './context-compatibility.ts';

/** Proves a recheck recorded this exact draft version, not that its review passed. */
export function hasRecordedRecheckDraft(input: {
  draft: AmazonDraft; product: ProductDetail; targetGeneration: number;
  context?:ListingAiContext;
  run: ImageWorkflowRun | null | undefined; source: ImageWorkflowRun | undefined;
  getResult(id: string): AiResult | undefined; getCall(id: string): AiCall | undefined;
}): boolean {
  const {draft,product,run,source}=input;
  if(!run||!source||run.id===source.id||run.recheckedFromRunId!==source.id||!hasSevenApprovedImages(source)
    ||run.status==='RUNNING'||draft.submittedAt||!['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(draft.state)
    ||draft.productRevision!==product.revision)return false;
  for(const record of [run,source])if(record.draftId!==draft.id||record.productId!==draft.productId||record.productRevision!==draft.productRevision
    ||record.variantId!==draft.variantId||record.sku!==draft.sku)return false;
  try {
    const snapshot=currentImageListingSnapshot(draft,input.context??buildListingContext(draft,product,input.targetGeneration));
    // A completed field repair can be interrupted before image planning records
    // its context. This proves only the saved draft version, never image approval.
    const preparation=run.contentPreparation;
    const colorEvidence=snapshot.context.evidence.filter(item=>item.source==='source_image');
    if(!run.imageContext&&run.stage==='content'&&preparation?.state==='DONE'&&preparation.copyReviewEnabled===false
      &&preparation.draftRevision===draft.revision&&preparation.draftSha256===imageWorkflowDraftStamp(draft)
      &&(!!run.categoryFieldRepair&&run.categoryFieldPolicyVersion===run.categoryFieldRepair.version
        ||colorEvidence.length&&preparation.sourceColorEvidenceSha256===listingFingerprint(colorEvidence)))return true;
    // Planning captures the entire draft stamp after any current-copy repair. The
    // context also pins its revision, so later human edits cannot reuse this proof.
    if(run.draftSha256){
      return run.draftSha256===imageWorkflowDraftStamp(draft)&&!!run.imageContext
        &&run.contextSha256===listingFingerprint(run.imageContext)
        &&imageListingContextsMatch(run.imageContext.listing,snapshot.context)
        &&listingFingerprint(run.imageContext.currentListingCopy)===listingFingerprint(snapshot.currentListingCopy);
    }
    // A content refusal occurs before draftSha256 is saved. Its linked review still
    // records the exact post-repair draft version and copy, even for NEEDS_CHANGES.
    const review=run.copyReviewResultId?input.getResult(run.copyReviewResultId):undefined;
    const call=review?input.getCall(review.callId):undefined;
    return !!review&&!!call&&review.id===run.copyReviewResultId&&review.output.kind==='listing-current-review'
      &&review.productId===draft.productId&&review.productRevision===draft.productRevision&&review.variantId===draft.variantId
      &&review.createdAt>=run.createdAt&&review.createdAt<=run.updatedAt
      &&call.id===review.callId&&call.status==='SUCCEEDED'&&call.productId===review.productId&&call.productRevision===review.productRevision
      &&call.providerId===review.providerId&&call.model===review.model&&call.finishedAt===review.createdAt
      &&!!review.listingContext&&review.sourceSha256===listingFingerprint(review.listingContext)
      &&imageListingContextsMatch(review.listingContext,snapshot.context)
      &&review.output.copySha256===listingFingerprint(snapshot.currentListingCopy)
      &&listingFingerprint(review.output.currentListingCopy)===listingFingerprint(snapshot.currentListingCopy);
  } catch { return false; }
}
