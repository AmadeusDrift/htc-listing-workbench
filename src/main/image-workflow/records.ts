import {validateUnitImageReview} from './unit-review-checkpoint.ts';
import { assertRetryAllowanceRun, validateRetryAllowance } from './retry-allowance.ts';
import {validateImageReviewRequests} from './review-checkpoint.ts';
import {validateAppearanceCheckpoint} from './appearance-review.ts';
export { imageWorkflowDraftStamp } from './approval-reuse.ts';
export { selectImageReferences } from '../assets/reference-selection.ts';
import { currentImageAdaptation, adaptedImageInputsMatch, assertPartialSourceReuse } from './adaptation.ts';
import { isFullSchema } from "../listing-ai/native-values.ts";
import { imageActualInputsMatch } from './context-compatibility.ts';
import { validateWorkflowRejection, assertWorkflowRejectionOwner,readCompletionForRejection } from './rejection.ts';
import { validateAiCall } from '../ai/validation.ts';
import { assertProductConsistency } from '../source-image-consistency/proof.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import { IMAGE_WORKFLOW_STAGES } from '../../shared/image-workflow-contracts.ts';
import { CATEGORY_FIELD_REPAIR_POLICY_VERSION, CATEGORY_FIELD_REPAIR_FIELDS } from '../../shared/automatic-listing-contracts.ts';
import { PRODUCT_IMAGE_POLICY_VERSION, IMAGE_SET_POLICY, IMAGE_TEXT_REVIEW_POLICY_VERSION } from '../../shared/image-ai-contracts.ts';
import type { ImageTextReviewPolicyVersion } from '../../shared/image-ai-contracts.ts';
import type { ImageWorkflowRun, ImageWorkflowSlot, ImageSlotAttempt } from '../../shared/image-workflow-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { boundedText, date, integer, keys, sha256, uuid, uuidList } from "../ai/primitives.ts";
import { validateStoredAiResult } from "../ai/validation.ts";
import { LISTING_EVIDENCE_CONTRACT_VERSIONS } from '../../shared/listing-ai-contracts.ts';
import type { ListingEvidenceContractVersion } from '../../shared/listing-ai-contracts.ts';
import { listingFingerprint } from "../json-fingerprint.ts";
import { validateProductImageContext, validateImageSetPlan, assertImageSetPlan, validateCandidateImageIdentity } from '../ai/image-validation.ts';
import { readImageRiskSettings, parseImageRiskSettings, riskPolicyCompatible } from './risk-settings.ts';
import { readCopyReviewSettings, copyReviewPolicyCompatible } from '../listing-ai/review-settings.ts';
import { imageWorkflowDraftStamp, validateApprovalReuse, plainColorApprovalMatches } from './approval-reuse.ts';
import { buildListingContext } from '../listing-ai/context.ts';
import { assertCurrentCopyEvidence, assertCurrentImageCategoryExclusions, CONTRACT_ADOPTION_FIELDS, currentDraftEvidenceIssues } from '../listing-ai/current-evidence.ts';


function validateImagePendingRequest(raw:unknown,run:ImageWorkflowRun):NonNullable<ImageWorkflowRun['pendingRequest']>{
 const p=keys(raw,['version','callId','step','slot','certainty']),slot=integer(p.slot,0,7);if(p.version!==1||p.certainty!=='SENT_UNKNOWN'||!['planning','risk','ocr','text'].includes(String(p.step))||run.status==='COMPLETED'||!run.slots&&slot!==0||p.step!=='planning'&&run.slots&&!run.slots[slot-1]?.attempts.length)throw new UserFacingError('图片未决操作身份不一致');return {version:1,callId:uuid(p.callId),step:p.step as NonNullable<ImageWorkflowRun['pendingRequest']>['step'],slot,certainty:'SENT_UNKNOWN'};
}
function validateLegacyImageWorkflowRun(raw: unknown): ImageWorkflowRun {
  const o = keys(raw, ['id','draftId','productId','productRevision','variantId','sku','status','stage','attempt','maxAttempts','contextSha256','draftSha256','referenceAssets',
    'planResultIds','candidateIds','ocrResultIds','reviewResultIds','approvedAssetId','approvedSha256','createdAt','updatedAt','error'], ['pendingRequest','reviewRequests','riskPolicy','rejection','imagePolicyVersion','ipReviewResultIds','recheckedFromRunId','listingEvidenceContractVersion']);
  if(o.listingEvidenceContractVersion!==undefined&&!(LISTING_EVIDENCE_CONTRACT_VERSIONS as readonly unknown[]).includes(o.listingEvidenceContractVersion))throw new UserFacingError('图片证据契约版本无效');
  if (o.imagePolicyVersion !== undefined && !['product-image/v1','product-image/vision-v2',PRODUCT_IMAGE_POLICY_VERSION].includes(String(o.imagePolicyVersion))) throw new UserFacingError('图片规划版本无效');
  if(o.imagePolicyVersion===PRODUCT_IMAGE_POLICY_VERSION && o.ipReviewResultIds===undefined)throw new UserFacingError('缺少侵权风险检测记录');
  if (!['WAITING_BATCH','RUNNING','COMPLETED','BLOCKED','FAILED','CANCELLED','INTERRUPTED'].includes(String(o.status)) || !IMAGE_WORKFLOW_STAGES.includes(o.stage as ImageWorkflowRun['stage']) || ![1,2].includes(Number(o.maxAttempts))) throw new UserFacingError('图片流程记录无效');
  if (!Array.isArray(o.referenceAssets) || o.referenceAssets.length > 3) throw new UserFacingError('图片参考记录无效');
  const referenceAssets = o.referenceAssets.map(raw => { const a = keys(raw, ['id','sha256']); return { id: uuid(a.id), sha256: sha256(a.sha256) }; });
  const run: ImageWorkflowRun = {
    ...(o.listingEvidenceContractVersion===undefined?{}:{listingEvidenceContractVersion:o.listingEvidenceContractVersion as ListingEvidenceContractVersion}),
    id: uuid(o.id), draftId: uuid(o.draftId), productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), variantId: uuid(o.variantId), sku: boundedText(o.sku, 100),
    status: o.status as ImageWorkflowRun['status'], stage: o.stage as ImageWorkflowRun['stage'], attempt: integer(o.attempt, 0, Number(o.maxAttempts)), maxAttempts: integer(o.maxAttempts,1,2),
    contextSha256: o.contextSha256 === null ? null : sha256(o.contextSha256), draftSha256: o.draftSha256 === null ? null : sha256(o.draftSha256), referenceAssets,
    planResultIds: uuidList(o.planResultIds, 2), candidateIds: uuidList(o.candidateIds, 2), ocrResultIds: uuidList(o.ocrResultIds, 2), reviewResultIds: uuidList(o.reviewResultIds, 2),
    approvedAssetId: o.approvedAssetId === null ? null : uuid(o.approvedAssetId), approvedSha256: o.approvedSha256 === null ? null : sha256(o.approvedSha256),
    createdAt: date(o.createdAt), updatedAt: date(o.updatedAt), error: o.error === null ? null : boundedText(o.error, 2000),
    ...(o.imagePolicyVersion ? {imagePolicyVersion:o.imagePolicyVersion as ImageWorkflowRun['imagePolicyVersion']} : {}),
    ...(o.riskPolicy!==undefined?{riskPolicy:parseImageRiskSettings(o.riskPolicy)}:{}),
    ...(o.ipReviewResultIds!==undefined?{ipReviewResultIds:uuidList(o.ipReviewResultIds,2)}:{}),
    ...(o.recheckedFromRunId!==undefined?{recheckedFromRunId:uuid(o.recheckedFromRunId)}:{}),
  };
  if (new Set(referenceAssets.map(a => a.id)).size !== referenceAssets.length || run.updatedAt < run.createdAt ||
    run.planResultIds.length > run.attempt || run.candidateIds.length > run.planResultIds.length || run.ocrResultIds.length > run.candidateIds.length || run.reviewResultIds.length > run.ocrResultIds.length ||
    Boolean(run.approvedAssetId) !== Boolean(run.approvedSha256) || (run.approvedAssetId && run.status !== 'COMPLETED') ||
    (run.status === 'COMPLETED' && (run.stage !== 'complete' || !run.approvedAssetId || !run.contextSha256 || !run.draftSha256 || !run.referenceAssets.length || run.reviewResultIds.length !== run.attempt || !run.attempt || run.error !== null)) ||
    (run.stage === 'complete' && run.status !== 'COMPLETED') ||
    (run.ipReviewResultIds && (run.ipReviewResultIds.length>run.candidateIds.length || run.imagePolicyVersion!==PRODUCT_IMAGE_POLICY_VERSION)) ||
    (run.imagePolicyVersion===PRODUCT_IMAGE_POLICY_VERSION && (run.ocrResultIds.length>run.ipReviewResultIds!.length || run.status==='COMPLETED' && run.ipReviewResultIds!.length!==run.attempt))) throw new UserFacingError('图片流程状态或复核记录不完整');
  if(o.rejection!==undefined)run.rejection=validateWorkflowRejection(o.rejection);
  if(o.pendingRequest!==undefined)run.pendingRequest=validateImagePendingRequest(o.pendingRequest,run);
  if(o.reviewRequests!==undefined)run.reviewRequests=validateImageReviewRequests(o.reviewRequests,run);
  return run;
}

export function validateImageWorkflowRun(raw:unknown,options:{stored?:boolean}={}):ImageWorkflowRun {
  if(!raw||typeof raw!=='object'||!('slots' in raw))return validateLegacyImageWorkflowRun(raw);
  const o=keys(raw,['id','draftId','productId','productRevision','variantId','sku','status','stage','attempt','maxAttempts','contextSha256','draftSha256','referenceAssets','planResultIds','candidateIds','ocrResultIds','reviewResultIds','approvedAssetId','approvedSha256','createdAt','updatedAt','error','imagePolicyVersion','ipReviewResultIds','slotPolicy','slots'],['unitAdoptionReview','pendingRequest','reviewRequests','retryAllowance','appearanceReviewEnabled','sourceReuse','legacyImageAttempts','policyReevaluation','rejection','listingEvidenceContractVersion','activeSlot','imageContext','recheckedFromRunId','setPlan','setPlanResultId','copyRepairAttempts','copyReviewResultId','contentPreparation','approvalReuse','imageRecipeSha256','riskInterceptionEnabled','copyReviewEnabled','categoryFieldPolicyVersion','categoryFieldRepair']);
  const invalid=():never=>{throw new UserFacingError('逐图流程状态或复核记录不完整');};
  if(o.riskInterceptionEnabled!==undefined&&typeof o.riskInterceptionEnabled!=='boolean')invalid();
  if(o.copyReviewEnabled!==undefined&&typeof o.copyReviewEnabled!=='boolean')invalid();
  if(!['seven-provisional-v1',IMAGE_SET_POLICY].includes(String(o.slotPolicy))||o.imagePolicyVersion!==PRODUCT_IMAGE_POLICY_VERSION||!Array.isArray(o.slots)||o.slots.length!==7||!Array.isArray(o.referenceAssets)||o.referenceAssets.length>10||!['WAITING_BATCH','RUNNING','COMPLETED','BLOCKED','FAILED','CANCELLED','INTERRUPTED'].includes(String(o.status))||!IMAGE_WORKFLOW_STAGES.includes(o.stage as ImageWorkflowRun['stage']))invalid();
  const maybeId=(value:unknown)=>value===null?null:uuid(value),maybeHash=(value:unknown)=>value===null?null:sha256(value),message=(value:unknown)=>value===null?null:boundedText(value,2000);
  const maxAttempts=integer(o.maxAttempts,1,3);
  const retryAllowance=o.retryAllowance===undefined?undefined:validateRetryAllowance(o.retryAllowance),limit=(slot:number)=>maxAttempts+3*(retryAllowance?.grants.filter(g=>g.slot===slot&&g.scope==='generation').length??0),totalLimit=21+3*(retryAllowance?.grants.length??0);
  const slots=(o.slots as unknown[]).map((value,index):ImageWorkflowSlot=>{
    const slot=keys(value,['index','purpose','status','contextSha256','attempts','approvedAssetId','approvedSha256','error']);
    if(slot.index!==index+1||slot.purpose!==(index===0?'main':'detail')||!['PENDING','RUNNING','PASSED','FAILED','BLOCKED','UNKNOWN'].includes(String(slot.status))||!Array.isArray(slot.attempts)||slot.attempts.length>limit(index+1))invalid();
    const attempts=(slot.attempts as unknown[]).map((value,at):ImageSlotAttempt=>{
      const a=keys(value,['number','requestId','state','planResultId','candidateId','ipReviewResultId','ocrResultId','reviewResultId','error'],['planReuse','failureProof','appearanceReview','riskPolicy','textReviewPolicyVersion','approvalPolicy','riskBypass']);
      if(a.number!==at+1||!['PLANNING','READY','GENERATING','GENERATED','PASSED','RETRYABLE_FAILURE','BLOCKED','UNKNOWN'].includes(String(a.state)))invalid();
      if(a.textReviewPolicyVersion!==undefined&&(!['image-text-review/v1',IMAGE_TEXT_REVIEW_POLICY_VERSION].includes(String(a.textReviewPolicyVersion))||!a.ocrResultId))invalid();
      let riskBypass:ImageSlotAttempt['riskBypass'];
      if(a.riskBypass!==undefined){const bypass=keys(a.riskBypass,['at','candidate']);riskBypass={at:date(bypass.at),candidate:validateCandidateImageIdentity(bypass.candidate)};if(o.riskInterceptionEnabled!==false||riskBypass.candidate.id!==a.candidateId)invalid();}
      if(a.approvalPolicy!==undefined&&(index===0||!['ip-only-detail/v1','risk-disabled-detail/v1'].includes(String(a.approvalPolicy))||a.approvalPolicy==='ip-only-detail/v1'&&!a.ipReviewResultId||a.approvalPolicy==='risk-disabled-detail/v1'&&!riskBypass))invalid();
      const parsed:ImageSlotAttempt={...(a.appearanceReview===undefined?{}:{appearanceReview:validateAppearanceCheckpoint(a.appearanceReview)}),...(a.riskPolicy===undefined?{}:{riskPolicy:parseImageRiskSettings(a.riskPolicy)}),...(a.approvalPolicy===undefined?{}:{approvalPolicy:a.approvalPolicy as ImageSlotAttempt['approvalPolicy']}),...(riskBypass?{riskBypass}:{}),number:at+1,requestId:uuid(a.requestId),state:a.state as ImageSlotAttempt['state'],planResultId:maybeId(a.planResultId),candidateId:maybeId(a.candidateId),ipReviewResultId:maybeId(a.ipReviewResultId),ocrResultId:maybeId(a.ocrResultId),reviewResultId:maybeId(a.reviewResultId),error:message(a.error),...(a.textReviewPolicyVersion===undefined?{}:{textReviewPolicyVersion:a.textReviewPolicyVersion as ImageTextReviewPolicyVersion})};
      if(a.planReuse!==undefined){const r=keys(a.planReuse,['version','fromRequestId']);if(r.version!==1||!retryAllowance||at<maxAttempts||!a.planResultId)invalid();parsed.planReuse={version:1,fromRequestId:uuid(r.fromRequestId)};const previous=(slot.attempts as ImageSlotAttempt[])[at-1];if(previous?.requestId!==parsed.planReuse.fromRequestId||previous.planResultId!==parsed.planResultId||!previous.failureProof&&!retryAllowance?.grants.some(g=>g.scope==='generation'&&g.slot===index+1&&g.afterAttempt===at&&g.requestId===previous.requestId))invalid();}
      if(a.failureProof!==undefined){const p=keys(a.failureProof,['version','kind','at']);if(p.version!==1||p.kind!=='provider-definitive'||parsed.state!=='RETRYABLE_FAILURE'||parsed.candidateId)invalid();parsed.failureProof={version:1,kind:'provider-definitive',at:date(p.at)};}
      if(parsed.appearanceReview&&(parsed.appearanceReview.candidate.id!==parsed.candidateId||parsed.appearanceReview.planResultId!==parsed.planResultId||parsed.state==='PASSED'&&parsed.appearanceReview.state==='PENDING'))invalid();
      if(parsed.riskPolicy&&(!parsed.riskPolicy.enabled||!parsed.ipReviewResultId))invalid();
      if(parsed.candidateId&&!parsed.planResultId||parsed.ipReviewResultId&&!parsed.candidateId||parsed.ocrResultId&&!parsed.ipReviewResultId&&!riskBypass||parsed.reviewResultId&&!parsed.ocrResultId||parsed.state==='PASSED'&&(!parsed.reviewResultId&&!parsed.approvalPolicy||parsed.error)||parsed.state==='PLANNING'&&parsed.candidateId)invalid();
      if(at<(slot.attempts as unknown[]).length-1&&parsed.state!=='RETRYABLE_FAILURE')invalid();return parsed;
    });
    const parsed:ImageWorkflowSlot={index:index+1,purpose:slot.purpose as 'main'|'detail',status:slot.status as ImageWorkflowSlot['status'],contextSha256:maybeHash(slot.contextSha256),attempts,approvedAssetId:maybeId(slot.approvedAssetId),approvedSha256:maybeHash(slot.approvedSha256),error:message(slot.error)};
    if(Boolean(parsed.approvedAssetId)!==Boolean(parsed.approvedSha256)||(parsed.status==='PASSED')!==Boolean(parsed.approvedAssetId)||parsed.status==='PASSED'&&(attempts.at(-1)?.state!=='PASSED'||!parsed.contextSha256||parsed.error)||attempts.length&&!parsed.contextSha256)invalid();
    return parsed;
  });
  if(o.listingEvidenceContractVersion!==undefined&&!(LISTING_EVIDENCE_CONTRACT_VERSIONS as readonly unknown[]).includes(o.listingEvidenceContractVersion))invalid();
  const evidenceOptions=options.stored?{storedVersion:o.listingEvidenceContractVersion as string??null}:{};
  const imageContext=o.imageContext===undefined?undefined:validateProductImageContext(o.imageContext,evidenceOptions);
  if(imageContext?.copyReviewBypass&&o.copyReviewEnabled!==false)invalid();
  const setPlan=o.setPlan===undefined?undefined:validateImageSetPlan(o.setPlan),setPlanResultId=o.setPlanResultId===undefined?undefined:uuid(o.setPlanResultId);
  if(Boolean(setPlan)!==Boolean(setPlanResultId)||setPlan&&o.slotPolicy!==IMAGE_SET_POLICY||imageContext&&(imageContext.setPolicy===IMAGE_SET_POLICY)!==(o.slotPolicy===IMAGE_SET_POLICY))invalid();
  if(setPlan&&imageContext)assertImageSetPlan(setPlan,imageContext,evidenceOptions);
  const refs=(o.referenceAssets as unknown[]).map(value=>{const ref=keys(value,['id','sha256']);return{id:uuid(ref.id),sha256:sha256(ref.sha256)};});
  const run:ImageWorkflowRun={...(retryAllowance?{retryAllowance}:{}),...(o.listingEvidenceContractVersion===undefined?{}:{listingEvidenceContractVersion:o.listingEvidenceContractVersion as ListingEvidenceContractVersion}),...(o.copyRepairAttempts===undefined?{}:{copyRepairAttempts:integer(o.copyRepairAttempts,0,2)}),id:uuid(o.id),draftId:uuid(o.draftId),productId:uuid(o.productId),productRevision:integer(o.productRevision,1,Number.MAX_SAFE_INTEGER),variantId:uuid(o.variantId),sku:boundedText(o.sku,100),status:o.status as ImageWorkflowRun['status'],stage:o.stage as ImageWorkflowRun['stage'],attempt:integer(o.attempt,0,totalLimit),maxAttempts,contextSha256:maybeHash(o.contextSha256),draftSha256:maybeHash(o.draftSha256),referenceAssets:refs,planResultIds:uuidList(o.planResultIds,totalLimit),candidateIds:uuidList(o.candidateIds,totalLimit),ipReviewResultIds:uuidList(o.ipReviewResultIds,totalLimit),ocrResultIds:uuidList(o.ocrResultIds,totalLimit),reviewResultIds:uuidList(o.reviewResultIds,totalLimit),approvedAssetId:maybeId(o.approvedAssetId),approvedSha256:maybeHash(o.approvedSha256),createdAt:date(o.createdAt),updatedAt:date(o.updatedAt),error:message(o.error),imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION,slotPolicy:o.slotPolicy as ImageWorkflowRun['slotPolicy'],slots,...(setPlan?{setPlan,setPlanResultId}:{}),...(imageContext?{imageContext}:{}),...(o.activeSlot===undefined?{}:{activeSlot:integer(o.activeSlot,1,7)}),...(o.recheckedFromRunId===undefined?{}:{recheckedFromRunId:uuid(o.recheckedFromRunId)})};
  const attempts=slots.flatMap(slot=>slot.attempts);
  for(const [plural,singular] of [['planResultIds','planResultId'],['candidateIds','candidateId'],['ipReviewResultIds','ipReviewResultId'],['ocrResultIds','ocrResultId'],['reviewResultIds','reviewResultId']] as const)if(listingFingerprint(run[plural])!==listingFingerprint([...new Set(attempts.flatMap(attempt=>attempt[singular]?[attempt[singular]]:[]))]))invalid();
  if(run.attempt!==attempts.length||new Set(attempts.map(a=>a.requestId)).size!==attempts.length||new Set(refs.map(ref=>ref.id)).size!==refs.length||run.updatedAt<run.createdAt||run.approvedAssetId!==slots[0].approvedAssetId||run.approvedSha256!==slots[0].approvedSha256||new Set(slots.flatMap(slot=>slot.approvedAssetId?[slot.approvedAssetId]:[])).size!==slots.filter(slot=>slot.status==='PASSED').length)invalid();
  if(imageContext&&(listingFingerprint(imageContext)!==run.contextSha256||imageContext.listing.draftId!==run.draftId||imageContext.listing.productId!==run.productId||imageContext.listing.productRevision!==run.productRevision||imageContext.listing.variantId!==run.variantId||imageContext.listing.sku!==run.sku||listingFingerprint(imageContext.referenceAssets.map(ref=>({id:ref.assetId,sha256:ref.sha256})))!==listingFingerprint(refs)))invalid();
  if(o.unitAdoptionReview!==undefined)run.unitAdoptionReview=validateUnitImageReview(o.unitAdoptionReview);
  if(o.sourceReuse!==undefined){
    const r=keys(o.sourceReuse,['derivationRunId','sourceRunId','sourceRunHash','sourceProductRevision','sourceContext','slotAttempts','slotContexts'],['reviewRepairCounts']);
    if(!Array.isArray(r.slotAttempts)||r.slotAttempts.length!==7||!Array.isArray(r.slotContexts)||r.slotContexts.length!==7)invalid();
    run.sourceReuse={derivationRunId:uuid(r.derivationRunId),sourceRunId:uuid(r.sourceRunId),sourceRunHash:sha256(r.sourceRunHash),sourceProductRevision:integer(r.sourceProductRevision,1,run.productRevision-1),sourceContext:validateProductImageContext(r.sourceContext,evidenceOptions),slotAttempts:(r.slotAttempts as unknown[]).map(v=>integer(v,0,totalLimit)),slotContexts:(r.slotContexts as unknown[]).map(maybeHash),...(r.reviewRepairCounts===undefined?{}:{reviewRepairCounts:Array.isArray(r.reviewRepairCounts)&&r.reviewRepairCounts.length===7?r.reviewRepairCounts.map(v=>integer(v,0,totalLimit)):invalid()})};
    if(run.sourceReuse.sourceRunId===run.id||run.sourceReuse.sourceContext.listing.productRevision!==run.sourceReuse.sourceProductRevision||run.sourceReuse.sourceContext.listing.draftId!==run.draftId)invalid();
  }
  for(const slot of slots)if(slot.contextSha256&&!(run.unitAdoptionReview&&slot.attempts.length<run.unitAdoptionReview.sourceSlotAttempts[slot.index-1]&&slot.contextSha256===run.unitAdoptionReview.sourceSlotContexts[slot.index-1])&&(!imageContext||listingFingerprint(validateProductImageContext({...((run.sourceReuse?.slotAttempts[slot.index-1]??0)>0&&slot.attempts.length===run.sourceReuse!.slotAttempts[slot.index-1]?run.sourceReuse!.sourceContext:imageContext),...(setPlan?{setPlan}:{}),purpose:slot.purpose,slot:{index:slot.index,total:7,provisional:true}},evidenceOptions))!==slot.contextSha256))invalid();
  if(o.slotPolicy===IMAGE_SET_POLICY&&slots.some(slot=>slot.attempts.length)&&!setPlan&&!(run.unitAdoptionReview&&slots.every(slot=>slot.attempts.length<=Math.max(0,run.unitAdoptionReview!.sourceSlotAttempts[slot.index-1]-1))))invalid();
  if(run.status==='COMPLETED'&&(slots.some(slot=>slot.status!=='PASSED')||!run.draftSha256||!run.contextSha256||run.stage!=='complete'||run.error!==null)||run.stage==='complete'&&run.status!=='COMPLETED')invalid();
  if(o.legacyImageAttempts!==undefined)run.legacyImageAttempts=integer(o.legacyImageAttempts,0,2);
  if(o.copyReviewResultId!==undefined)run.copyReviewResultId=uuid(o.copyReviewResultId);
  if(o.categoryFieldPolicyVersion!==undefined){if(o.categoryFieldPolicyVersion!==CATEGORY_FIELD_REPAIR_POLICY_VERSION)invalid();run.categoryFieldPolicyVersion=CATEGORY_FIELD_REPAIR_POLICY_VERSION;}
  if(o.categoryFieldRepair!==undefined){
    const grant=keys(o.categoryFieldRepair,['version','grantedAttempts','grantedAt','fields']);
    if(grant.version!==CATEGORY_FIELD_REPAIR_POLICY_VERSION||run.categoryFieldPolicyVersion!==grant.version||grant.grantedAttempts!==1||!Array.isArray(grant.fields)||!grant.fields.length||grant.fields.length>CATEGORY_FIELD_REPAIR_FIELDS.length||new Set(grant.fields).size!==grant.fields.length||grant.fields.some(field=>!CATEGORY_FIELD_REPAIR_FIELDS.includes(field as typeof CATEGORY_FIELD_REPAIR_FIELDS[number])))invalid();
    run.categoryFieldRepair={version:CATEGORY_FIELD_REPAIR_POLICY_VERSION,grantedAttempts:1,grantedAt:date(grant.grantedAt),fields:grant.fields as typeof CATEGORY_FIELD_REPAIR_FIELDS[number][]};
  }
  if(o.contentPreparation!==undefined){const preparation=keys(o.contentPreparation,['state','draftRevision','remaining'],['repairPolicyVersion','copyReviewEnabled','sourceColorEvidenceSha256','draftSha256','operationId']);if(preparation.repairPolicyVersion!==undefined&&preparation.repairPolicyVersion!=='field-evidence/v2'||preparation.copyReviewEnabled!==undefined&&typeof preparation.copyReviewEnabled!=='boolean')invalid();if(!['STARTED','DONE'].includes(String(preparation.state))||!Array.isArray(preparation.remaining)||preparation.remaining.length>100)invalid();run.contentPreparation={...(preparation.operationId===undefined?{}:{operationId:uuid(preparation.operationId)}),state:preparation.state as 'STARTED'|'DONE',draftRevision:integer(preparation.draftRevision,1,Number.MAX_SAFE_INTEGER),remaining:(preparation.remaining as unknown[]).map(value=>boundedText(value,2000)),...(preparation.repairPolicyVersion?{repairPolicyVersion:'field-evidence/v2' as const}:{}),...(preparation.copyReviewEnabled===undefined?{}:{copyReviewEnabled:preparation.copyReviewEnabled as boolean}),...(preparation.sourceColorEvidenceSha256===undefined?{}:{sourceColorEvidenceSha256:sha256(preparation.sourceColorEvidenceSha256)}),...(preparation.draftSha256===undefined?{}:{draftSha256:sha256(preparation.draftSha256)})};}
  if(o.policyReevaluation!==undefined){const receipt=keys(o.policyReevaluation,['version','inputSha256','at','previousRemaining'],['repairStarted']);if(receipt.version!=='source-union-resume/v1'||!Array.isArray(receipt.previousRemaining)||receipt.previousRemaining.length>100||receipt.repairStarted!==undefined&&receipt.repairStarted!==true)invalid();run.policyReevaluation={version:'source-union-resume/v1',inputSha256:sha256(receipt.inputSha256),at:date(receipt.at),previousRemaining:(receipt.previousRemaining as unknown[]).map(value=>boundedText(value,2000)),...(receipt.repairStarted?{repairStarted:true}:{})};}
  if(o.imageRecipeSha256!==undefined)run.imageRecipeSha256=sha256(o.imageRecipeSha256);
  if(o.riskInterceptionEnabled!==undefined)run.riskInterceptionEnabled=o.riskInterceptionEnabled as boolean;
  if(o.copyReviewEnabled!==undefined)run.copyReviewEnabled=o.copyReviewEnabled as boolean;
  if(o.appearanceReviewEnabled!==undefined){if(typeof o.appearanceReviewEnabled!=='boolean')invalid();run.appearanceReviewEnabled=o.appearanceReviewEnabled as boolean;}
  if(run.appearanceReviewEnabled!==undefined)for(const slot of run.slots??[])if(slot.status==='PASSED'&&(!slot.attempts.at(-1)?.appearanceReview||run.appearanceReviewEnabled&&slot.attempts.at(-1)?.appearanceReview?.state!=='DONE'))invalid();
  for(const slot of run.slots??[])if(slot.status==='PASSED'&&slot.attempts.at(-1)?.riskBypass?.candidate.sha256!==undefined&&slot.attempts.at(-1)!.riskBypass!.candidate.sha256!==slot.approvedSha256)invalid();
  if(o.approvalReuse!==undefined)run.approvalReuse=validateApprovalReuse(o.approvalReuse,run);
  if(o.rejection!==undefined)run.rejection=validateWorkflowRejection(o.rejection);
  if(o.pendingRequest!==undefined)run.pendingRequest=validateImagePendingRequest(o.pendingRequest,run);
  if(o.reviewRequests!==undefined)run.reviewRequests=validateImageReviewRequests(o.reviewRequests,run);
  return run;
}

export const validateStoredImageWorkflowRun=(raw:unknown)=>validateImageWorkflowRun(raw,{stored:true});
/** Validated PASSED slots bind their asset to the last PASSED attempt. Legacy
 * completed runs likewise have aligned plan/candidate/review attempt arrays. */
export function currentWorkflowPlanIds(run:ImageWorkflowRun):string[]{
  return run.slots?run.slots.flatMap(slot=>{const id=slot.attempts.at(-1)?.planResultId;return id?[id]:[];}):run.planResultIds.slice(-1);
}
/** Image URLs are filled by execution after adoption; all other listing changes invalidate the selection. */
export function workflowRuns(db: DatabaseSync, draftId?: string): ImageWorkflowRun[] {
  // Scope before parsing/validating: a progress read must not revalidate every
  // other draft's contexts. Same-draft history remains complete for reuse proofs.
  const rows = draftId
    ? db.prepare("SELECT id,record_json FROM image_workflow_runs WHERE json_extract(record_json,'$.draftId')=? ORDER BY rowid DESC").all(draftId)
    : db.prepare('SELECT id,record_json FROM image_workflow_runs ORDER BY rowid DESC').all();
  const runs=rows.map(row => {
    const run = validateStoredImageWorkflowRun(JSON.parse(String(row.record_json)));
    assertWorkflowRejectionOwner(run,id=>{const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(id);return row?validateAiCall(JSON.parse(String(row.record_json))):undefined;},id=>{const row=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id);return row?validateStoredAiResult(JSON.parse(String(row.record_json))):undefined;},id=>readCompletionForRejection(db,id));
    assertRetryAllowanceRun(db,run);
    if (run.id !== row.id) throw new UserFacingError('图片流程记录身份不一致'); return run;
  });
  for(const run of runs)if(run.sourceReuse)assertPartialSourceReuse(run,runs.find(source=>source.id===run.sourceReuse!.sourceRunId),db);
  return runs;
}
export function approvedWorkflowAsset(db: DatabaseSync, draft: AmazonDraft, product: ProductDetail): { id: string; sha256: string } | null {
  return approvedWorkflowAssets(db,draft,product)?.[0]??null;
}
export function approvedWorkflowAssets(db:DatabaseSync,draft:AmazonDraft,product:ProductDetail):{id:string;sha256:string}[]|null {
  assertProductConsistency(db,product,draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId]);
  const run = workflowRuns(db, draft.id)[0];
  if (!run) return null;
  if (run.imagePolicyVersion !== PRODUCT_IMAGE_POLICY_VERSION) throw new UserFacingError('这张图片使用旧版流程，尚未完成侵权风险检测，请重新自动准备');
  if(!riskPolicyCompatible(run,readImageRiskSettings(db),id=>{const row=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id);const result=row?validateStoredAiResult(JSON.parse(String(row.record_json))):undefined;return result?.output.kind==='image-ip-review'?result.output:undefined;}))throw new UserFacingError('风险拦截已开启，这套图片的检测证据不满足当前风险阈值或曾跳过检测；原图片与历史保留');
  if(!copyReviewPolicyCompatible(run,readCopyReviewSettings(db).enabled))throw new UserFacingError('文案复核已开启，这套图片曾跳过文案复核，请先重新检查已有图片');
  const adapted=currentImageAdaptation(db,run,draft,product);
  if (run.status !== 'COMPLETED' || !adapted&&run.productRevision !== product.revision || run.productId !== product.id || run.variantId !== draft.variantId || run.sku !== draft.sku || (!adapted&&run.draftSha256 !== imageWorkflowDraftStamp(draft)&&!plainColorApprovalMatches(run,draft,product))) throw new UserFacingError('自动图片流程尚未通过或商品内容已变化，请重新完成自动准备');
  const current=buildListingContext(draft,product,run.imageContext?.listing.targetGeneration??0);
  // This projection lacks image-observed color citations. Limit it to current
  // deterministic conflicts; full review checks use the complete image snapshot.
  const getResult=(id:string)=>{
    const row=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id);if(!row)return undefined;
    const result=validateStoredAiResult(JSON.parse(String(row.record_json)));return result.id===id?result:undefined;
  };
  if(run.imageContext&&!isFullSchema(run.imageContext.listing)&&!imageActualInputsMatch(run.imageContext,draft,product,current,run.imageRecipeSha256)&&!adaptedImageInputsMatch(db,run,draft,product,current))throw new UserFacingError('来源规格、图片、店铺或站点已变化，原图片与付费请求已保留');
  const legacy=buildListingContext(draft,product,current.targetGeneration,true);
  for(const evidence of legacy.evidence)if(!current.evidence.some(item=>item.id===evidence.id))current.evidence.push(evidence);
  for(const evidence of run.imageContext?.listing.evidence??[]){
    if(current.evidence.some(item=>item.id===evidence.id)||!evidence.imageObservation)continue;
    const observation=evidence.imageObservation,result=getResult(observation.resultId),scope=result?.sourceColorContext;
    const variant=scope&&product.variants.find(v=>v.id===scope.variantId);
    if(!scope||!variant||scope.productId!==product.id||scope.productRevision!==product.revision||scope.sourceSpec!==(variant.normalizedSpec.trim()||variant.originalSpec.trim())||result?.output.kind!=='source-color'||result.output.verdict!=='DETERMINED'||listingFingerprint(scope)!==listingFingerprint(observation.context)||listingFingerprint(result.output.colors)!==listingFingerprint(observation.colors))continue;
    if(!scope.referenceAssets.every(ref=>db.prepare('SELECT 1 FROM assets a JOIN variant_assets v ON a.id=v.asset_id WHERE a.id=? AND a.product_id=? AND a.sha256=? AND v.variant_id=? AND v.confirmed=1').get(ref.assetId,product.id,ref.sha256,variant.id)))continue;
    const call=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(result.callId);if(!call||validateAiCall(JSON.parse(String(call.record_json))).status!=='SUCCEEDED')continue;
    current.evidence.push(evidence);
  }
  const issues=currentDraftEvidenceIssues(draft,current,getResult,{adoptionFields:CONTRACT_ADOPTION_FIELDS,adoptionContext:'stored'});
  if(issues.length)throw new UserFacingError(issues.join('；').slice(0,2000));
  assertCurrentImageCategoryExclusions(current,{base:run.imageContext,setPlan:run.setPlan,plans:currentWorkflowPlanIds(run).flatMap(id=>{const result=getResult(id);return result?[result]:[];})});
  if(run.imageContext){if(run.setPlan)assertImageSetPlan(run.setPlan,run.imageContext);validateProductImageContext(run.imageContext);assertCurrentCopyEvidence(run.imageContext.currentListingCopy,current);}
  if(run.appearanceReviewEnabled)for(const slot of run.slots??[]){
    const checkpoint=slot.attempts.at(-1)?.appearanceReview,id=checkpoint?.resultIds.at(-1),row=id?db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id):undefined,result=row?validateStoredAiResult(JSON.parse(String(row.record_json))):undefined;
    if(checkpoint?.state!=='DONE'||result?.output.kind!=='image-appearance-review'||result.output.verdict!=='PASS'||result.output.candidate.sha256!==slot.approvedSha256||result.output.planResultId!==slot.attempts.at(-1)?.planResultId)throw new UserFacingError('外观复核尚未通过，候选与原复核依据已保留');
  }
  const selected=run.slots?run.slots.map(slot=>({id:slot.approvedAssetId!,sha256:slot.approvedSha256!})):[{id:run.approvedAssetId!,sha256:run.approvedSha256!}];
  for(const item of selected){const asset = db.prepare('SELECT product_id,sha256 FROM assets WHERE id=?').get(item.id);
    if (!asset || asset.product_id !== product.id || asset.sha256 !== item.sha256 || !db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(item.id, draft.variantId)) throw new UserFacingError('自动图片成果或 SKU 关联已变化');}
  return selected;
}
