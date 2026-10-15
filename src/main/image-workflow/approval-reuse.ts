import { plainColorValue } from '../listing-ai/plain-colors.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { hasSevenApprovedImages } from '../../shared/image-workflow-contracts.ts';
import { boundedText, integer, keys, object, uuid } from "../ai/primitives.ts";
import { listingFingerprint } from "../json-fingerprint.ts";
import { UserFacingError } from '../../shared/errors.ts';
import { validateSalesRecipe } from '../sales-plans/records.ts';

export function compatibleApprovalRecipe(run:Pick<ImageWorkflowRun,'variantId'|'imageContext'|'imageRecipeSha256'>,raw:unknown):boolean {
  const recipe=raw===null?null:validateSalesRecipe(raw);
  if(run.imageRecipeSha256)return listingFingerprint(recipe)===run.imageRecipeSha256;
  const base=run.imageContext,counts=base?.listing.evidence.filter(item=>item.id===`${run.variantId}:sale-count`)??[];
  if(recipe===null)return counts.length===0;
  if(recipe.components.length!==1||base?.sourceVariantIds?.length!==1||base.sourceVariantIds[0]!==run.variantId)return false;
  const component=recipe.components[0];
  return component.variantId===run.variantId&&component.quantity===recipe.totalPieces&&counts.length===1&&counts[0].value===`${recipe.totalPieces} pieces`;
}

/** Identical stamp payload to the original workflow; image locators are transport data. */
export function imageApprovalDraftSnapshot(draft:AmazonDraft):string {
  const attributes=Object.fromEntries(Object.entries(draft.attributes).filter(([field])=>field!=='main_product_image_locator'&&!/^other_product_image_locator_\d+$/.test(field)));
  return JSON.stringify({productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,targetId:draft.targetId,sellerId:draft.sellerId,marketplaceId:draft.marketplaceId,mode:draft.mode,schema:draft.schema,attributes});
}
export function validateApprovalReuse(raw:unknown,run:ImageWorkflowRun):NonNullable<ImageWorkflowRun['approvalReuse']> {
  const a=keys(raw,['sourceRunId','draftRevision','draftSnapshot','recipeSnapshot']),sourceRunId=uuid(a.sourceRunId),draftRevision=integer(a.draftRevision,1,Number.MAX_SAFE_INTEGER);
  const recipeSnapshot=boundedText(a.recipeSnapshot,200000);if(!compatibleApprovalRecipe(run,JSON.parse(recipeSnapshot)))throw new UserFacingError('图片审核复用销售组合不一致');
  const draftSnapshot=boundedText(a.draftSnapshot,2000000),snapshot=keys(JSON.parse(draftSnapshot),['productId','productRevision','variantId','sku','targetId','sellerId','marketplaceId','mode','schema','attributes']);
  const schema=object(snapshot.schema),context=run.imageContext?.listing;
  object(snapshot.attributes);boundedText(snapshot.sellerId,100);if(!['demo','live'].includes(String(snapshot.mode)))throw new UserFacingError('图片审核复用快照无效');
  if(!hasSevenApprovedImages(run)||!context||sourceRunId===run.id||draftRevision<context.draftRevision||listingFingerprint(snapshot)!==run.draftSha256
    ||snapshot.productId!==run.productId||snapshot.productRevision!==run.productRevision||snapshot.variantId!==run.variantId||snapshot.sku!==run.sku
    ||snapshot.targetId!==context.targetId||snapshot.marketplaceId!==context.marketplaceId||schema.targetId!==context.targetId||schema.productType!==context.productType
    ||schema.parentageLevel!==context.parentageLevel||schema.requirements!==context.requirements||schema.locale!==context.locale||schema.checksum!==context.schemaChecksum||schema.version!==context.schemaVersion
    ||listingFingerprint({schema:schema.schema,metaSchema:schema.metaSchema})!==context.schemaSha256)throw new UserFacingError('图片审核复用快照与原审核范围不一致');
  return {sourceRunId,draftRevision,draftSnapshot,recipeSnapshot};
}
/** Structural history only. The action boundary still verifies calls, ledger and private bytes. */
export function approvalReviewHistoryResolved(source:ImageWorkflowRun):boolean {
  return !(source.reviewRequests??[]).some(request=>{
    if(request.state==='RESULT_STORED')return false;
    const slot=source.slots?.[request.slot-1],attempt=slot?.attempts[request.attempt-1];
    const retired=request.version===2&&request.step==='ocr'&&request.state==='SENT_UNKNOWN'&&request.execution.providerId==='aliyun-ocr'&&source.retiredOcrDependencies?.some(r=>r.callId===request.requestId)
      &&request.runId===source.id&&request.draftId===source.draftId&&request.productId===source.productId&&request.productRevision===source.productRevision&&request.variantId===source.variantId&&request.sku===source.sku
      &&slot?.contextSha256===request.contextSha256&&attempt?.requestId===request.generationRequestId&&attempt.candidateId===request.candidate.id&&attempt.planResultId===request.planResultId&&attempt.state==='PASSED'&&!!attempt.reviewResultId&&slot.approvedSha256===request.candidate.sha256;
    return !retired;
  });
}
export function assertApprovalReuseSource(run:ImageWorkflowRun,source:ImageWorkflowRun|undefined):void {
  if(!source||source.approvalReuse||!hasSevenApprovedImages(source)||!run.approvalReuse||source.id!==run.approvalReuse.sourceRunId||source.updatedAt>run.createdAt)throw new UserFacingError('图片审核复用来源无效');
  if(run.reviewRequests!==undefined||run.unitAdoptionReview!==undefined||!approvalReviewHistoryResolved(source))throw new UserFacingError('图片审核复用不能复制未决原请求身份');
  const evidence=(value:ImageWorkflowRun)=>{const {id,createdAt,updatedAt,draftSha256,approvalReuse,reviewRequests,retiredOcrDependencies,unitAdoptionReview,...rest}=value;return rest;};
  if(listingFingerprint(evidence(source))!==listingFingerprint(evidence(run)))throw new UserFacingError('图片审核复用记录与原审核证据不一致');
  validateApprovalReuse(run.approvalReuse,run);
}

/** Read-only equivalence for an exact approved draft whose sole change is its
 * ordinary color spelling. Reconstruct the full old stamp; never rewrite proof. */
export function plainColorApprovalMatches(run:ImageWorkflowRun,draft:AmazonDraft,product:ProductDetail):boolean {
  const context=run.imageContext?.listing,oldColor=context?.currentAttributes?.color,currentColor=draft.attributes.color;
  if(!hasSevenApprovedImages(run)||!context||oldColor===undefined||currentColor===undefined
    ||run.productId!==product.id||draft.productId!==product.id||run.productRevision!==product.revision||draft.productRevision!==product.revision
    ||run.variantId!==draft.variantId||!compatibleApprovalRecipe(run,draft.salesPlan?.recipe??null))return false;
  const variant=product.variants.find(value=>value.id===draft.variantId),source=context.sourceProduct?.variants?.find(value=>value.id===draft.variantId)??context.sourceProduct?.selectedSku;
  if(!variant||!source||source.id!==variant.id||source.originalSpec!==variant.originalSpec||source.normalizedSpec!==variant.normalizedSpec)return false;
  if(listingFingerprint(oldColor)===listingFingerprint(currentColor)||listingFingerprint(plainColorValue(oldColor,[variant.originalSpec,variant.normalizedSpec]))!==listingFingerprint(currentColor))return false;
  const previous={...draft,attributes:{...draft.attributes,color:oldColor}};
  return listingFingerprint(JSON.parse(imageApprovalDraftSnapshot(previous)))===run.draftSha256;
}

export function imageWorkflowDraftStamp(draft: AmazonDraft): string {
  return listingFingerprint(JSON.parse(imageApprovalDraftSnapshot(draft)));
}
