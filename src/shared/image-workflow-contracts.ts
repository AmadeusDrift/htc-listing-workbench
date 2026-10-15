import type { AmazonDraft } from './amazon-contracts.ts';
import type { ProductDetail } from './contracts.ts';
import type { CategoryFieldRepairGrant, CATEGORY_FIELD_REPAIR_POLICY_VERSION } from './automatic-listing-contracts.ts';
import { IMAGE_TEXT_REVIEW_POLICY_VERSION } from './image-ai-contracts.ts';
import type { ProductImageContext, ProductImagePolicyVersion, ImageSetPlan, ImageTextReviewPolicyVersion, CandidateImageIdentity } from './image-ai-contracts.ts';

export interface ImageRiskSettings { enabled:boolean; scoreThreshold?:number; levelThreshold?:'low'|'medium'|'high' }
export interface CopyReviewSettings { enabled:boolean }

/** An original review request; absence in historical records never proves NOT_SENT. */
export interface ImageReviewRequestV1 {
  version:1;requestId:string;step:'risk'|'ocr'|'text';runId:string;draftId:string;
  productId:string;productRevision:number;variantId:string;sku:string;slot:number;attempt:number;
  generationRequestId:string;candidate:CandidateImageIdentity;planResultId:string;ocrResultId:string|null;
  contextSha256:string;requestFingerprint:string;
  execution:{providerId:import('./ai-contracts.ts').AiProviderId;model:string;generation:number;purposeSnapshot:import('./ai-purpose-contracts.ts').AiPurposeSnapshot|null};
  reservedAt:string;state:'SENT_UNKNOWN'|'RESULT_STORED';resultId:string|null;
}

/** Producer-v2 intent exists before credentials/limits/transport. No token or OSS credential is stored. */
export interface ImageReviewRequestV2 extends Omit<ImageReviewRequestV1,'version'|'reservedAt'|'requestFingerprint'|'state'> {
 repair?:{priorRequestId:string;rootRequestId:string;commandSha256:string;authorizedAt:string;owner:{kind:'task';taskId:string;itemKey:string}|{kind:'manual';draftId:string}};
 version:2;preparedAt:string;reservedAt:string|null;requestFingerprint:string|null;
 state:'PREPARED'|'SENT_UNKNOWN'|'RESULT_STORED'|'RECEIVED_INVALID'|'DEFINITIVE_REJECTION';
 effects:{id:string;kind:'token'|'upload'|'moderation'|'ocr'|'text';state:'UNPERMITTED'|'PERMITTED'|'RECEIVED';permittedAt:string|null;receivedAt:string|null}[];
}
export type ImageReviewRequest=ImageReviewRequestV1|ImageReviewRequestV2;

export const IMAGE_WORKFLOW_STAGES = ['content', 'planning', 'generating', 'ip-check', 'ocr', 'reviewing', 'adopting', 'complete'] as const;
export type ImageWorkflowStage = typeof IMAGE_WORKFLOW_STAGES[number];
export interface ImageRetryGrantRef {id:string;slot:number;afterAttempt:number;requestId:string;scope:'generation'|'planning'}
export interface ImageRetryAllowance {version:1;grants:ImageRetryGrantRef[]}
export function imageSlotAttemptLimit(run:Pick<ImageWorkflowRun,'maxAttempts'|'retryAllowance'>,slot:number):number{return run.maxAttempts+3*(run.retryAllowance?.grants.filter(grant=>grant.slot===slot&&grant.scope==='generation').length??0);}
export function imageSlotConsumedAttempts(run:Pick<ImageWorkflowRun,'slots'|'attempt'|'reviewRequests'|'sourceReuse'|'unitAdoptionReview'>,slot:number):number{return Math.max(run.slots?.[slot-1]?.attempts.length??run.attempt,run.unitAdoptionReview?.sourceSlotAttempts[slot-1]??0)+(run.unitAdoptionReview?.sourceRepairCounts[slot-1]??0)+(run.sourceReuse?.reviewRepairCounts?.[slot-1]??0)+(run.reviewRequests?.filter(r=>r.version===2&&r.slot===slot&&r.repair&&r.reservedAt!==null).length??0);}
export interface ImageSlotAttempt {
  planReuse?:{version:1;fromRequestId:string};
  /** Main-process proof captured only from a definitive provider rejection. Old FAILED strings are not proof. */
  failureProof?:{version:1;kind:'provider-definitive';at:string};
  appearanceReview?:import('./appearance-review-contracts.ts').AppearanceReviewCheckpoint;
  riskPolicy?:ImageRiskSettings;
  number:number; requestId:string;
  state:'PLANNING'|'READY'|'GENERATING'|'GENERATED'|'PASSED'|'RETRYABLE_FAILURE'|'BLOCKED'|'UNKNOWN';
  planResultId:string|null;candidateId:string|null;ipReviewResultId:string|null;ocrResultId:string|null;reviewResultId:string|null;
  /** Most recently attempted text policy, saved before sending so an unknown response cannot trigger another policy recheck. */
  textReviewPolicyVersion?:ImageTextReviewPolicyVersion;
  /** Detail slots are approved on saved IP evidence only; older OCR records remain as history. */
  approvalPolicy?:'ip-only-detail/v1'|'risk-disabled-detail/v1';
  /** User disabled interception; this is not a passing risk review. */
  riskBypass?:{at:string;candidate:CandidateImageIdentity};
  error:string|null;
}
export interface ImageWorkflowSlot {
  index:number;purpose:'main'|'detail';status:'PENDING'|'RUNNING'|'PASSED'|'FAILED'|'BLOCKED'|'UNKNOWN';
  contextSha256:string|null;attempts:ImageSlotAttempt[];approvedAssetId:string|null;approvedSha256:string|null;error:string|null;
}
export interface UnitAdoptionImageReview {version:1;taskId:string;itemKey:string;sourceRunId:string;sourceRunHash:string;adoptionSha256:string;adoptedDraftRevision:number;adoptedDraftStamp:string;sourceSlotAttempts:number[];sourceSlotContexts:(string|null)[];sourceRepairCounts:number[]}
export interface ImageWorkflowRun {
  /** Read-only legacy UNKNOWN reference; never a request identity or retry grant. */
  planningUnknown?:{version:1;callId:string;certainty:'SENT_UNKNOWN'};
  unitAdoptionReview?:UnitAdoptionImageReview;
  /** Dependency transition only: original OCR call, journal certainty and usage hold remain untouched. */
  retiredOcrDependencies?:{callId:string;at:string}[];
  pendingRequest?:{version:1;callId:string;step:'planning'|'risk'|'ocr'|'text';slot:number;certainty:'SENT_UNKNOWN'};
  reviewRequests?:ImageReviewRequest[];
  retryAllowance?:ImageRetryAllowance;
  /** Absent means historical, not retroactively reviewed. */
  appearanceReviewEnabled?:boolean;
  /** Derivation under the same task; original context and paid attempt prefixes remain owned by the source run. */
  sourceReuse?:{derivationRunId:string;sourceRunId:string;sourceRunHash:string;sourceProductRevision:number;sourceContext:ProductImageContext;slotAttempts:number[];slotContexts:(string|null)[];reviewRepairCounts?:number[]};
  /** Local authorization receipt; never changes image contexts or paid attempts. */
  policyReevaluation?:{version:'source-union-resume/v1';inputSha256:string;at:string;previousRemaining:string[];repairStarted?:boolean};
  rejection?: {version:'rejection-presentation/v1';code:import('./rejection-presentation.ts').OutputRejection['code']|'SOURCE_OBSERVATION_INSUFFICIENT';callId:string;resultId:string|null;contextSha256:string;stage:'content'|'planning';slot:number};
  /** Main-only evidence semantics for stored image captions; absent preserves pre-contract history. */
  listingEvidenceContractVersion?:import('./listing-ai-contracts.ts').ListingEvidenceContractVersion;
  /** Original automatic-row budget when its workflow checkpoint was absent. */
  legacyImageAttempts?:number;
  id: string; draftId: string; productId: string; productRevision: number; variantId: string; sku: string;
  status: 'WAITING_BATCH' | 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  stage: ImageWorkflowStage; attempt: number; maxAttempts: number;
  contextSha256: string | null; draftSha256: string | null;
  referenceAssets: { id: string; sha256: string }[];
  planResultIds: string[]; candidateIds: string[]; ocrResultIds: string[]; reviewResultIds: string[];
  approvedAssetId: string | null; approvedSha256: string | null;
  createdAt: string; updatedAt: string; error: string | null;
  imagePolicyVersion?: ProductImagePolicyVersion;
  ipReviewResultIds?: string[];
  recheckedFromRunId?: string;
  /** Same approved bytes, bound to a later draft without repeating image-provider calls. */
  approvalReuse?: { sourceRunId:string; draftRevision:number; draftSnapshot:string; recipeSnapshot:string };
  /** Captured when planning begins; old records must never be backfilled from a later draft. */
  imageRecipeSha256?:string;
  /** Legacy runs keep their original rules and durable attempts. */
  slotPolicy?:'seven-provisional-v1'|'seven-product-v2';slots?:ImageWorkflowSlot[];activeSlot?:number;
  imageContext?:ProductImageContext;
  setPlan?:ImageSetPlan;setPlanResultId?:string;
  /** Reserved before each current-copy repair so restart cannot reset the paid budget. */
  copyRepairAttempts?:number;
  copyReviewResultId?:string;
  categoryFieldPolicyVersion?:typeof CATEGORY_FIELD_REPAIR_POLICY_VERSION;
  categoryFieldRepair?:CategoryFieldRepairGrant;
  contentPreparation?:{operationId?:string;state:'STARTED'|'DONE';draftRevision:number;remaining:string[];repairPolicyVersion?:'field-evidence/v2';copyReviewEnabled?:boolean;sourceColorEvidenceSha256?:string;draftSha256?:string};
  /** Missing on old records means risk interception was enabled. */
  riskInterceptionEnabled?:boolean;
  /** Policy at single-image adoption; slot workflows keep it per attempt. */
  riskPolicy?:ImageRiskSettings;

  /** Absent on existing runs means independent listing-copy review was enabled. */
  copyReviewEnabled?:boolean;
}
export function hasSevenApprovedImages(run:ImageWorkflowRun|null|undefined):boolean{return !!run&&run.status==='COMPLETED'&&run.stage==='complete'&&!!run.approvedAssetId&&!!run.approvedSha256&&run.slots?.length===7&&run.slots.every(slot=>slot.status==='PASSED'&&!!slot.approvedAssetId&&!!slot.approvedSha256);}
/** Metadata eligibility only; the main process must also verify the saved IP, OCR and negative review. */
export function needsImageTextPolicyReview(attempt:ImageSlotAttempt|undefined):boolean{return !!attempt&&attempt.state==='RETRYABLE_FAILURE'&&!!attempt.candidateId&&!!attempt.planResultId&&!!attempt.ipReviewResultId&&!!attempt.ocrResultId&&!!attempt.reviewResultId&&attempt.textReviewPolicyVersion!==IMAGE_TEXT_REVIEW_POLICY_VERSION;}
/** Unknown generation can only reconcile its existing request; complete never resends it. */
export function canResumeImageWorkflow(run:ImageWorkflowRun|null|undefined):boolean{return !!run?.slots&&run.status!=='COMPLETED'&&!run.slots.some(slot=>slot.status==='BLOCKED')&&run.slots.some(slot=>slot.status!=='PASSED'&&(imageSlotConsumedAttempts(run,slot.index)<imageSlotAttemptLimit(run,slot.index)||['GENERATING','GENERATED','UNKNOWN','PLANNING','READY'].includes(slot.attempts.at(-1)?.state??'')||slot.index>1&&slot.attempts.at(-1)?.state==='RETRYABLE_FAILURE'&&!!slot.attempts.at(-1)?.ipReviewResultId&&!!slot.attempts.at(-1)?.reviewResultId||run.slotPolicy==='seven-product-v2'&&needsImageTextPolicyReview(slot.attempts.at(-1))));}
export interface CompleteAutomaticProductInput { draftId: string; draftRevision: number }
export interface CompleteAutomaticProductResult {
  draft: AmazonDraft; aiCalls: number; previewAttempts: number; remaining: string[]; workflow: ImageWorkflowRun;
}
export interface AutomaticImageCandidatePreview { candidateId:string; previewUrl:string; width:number; height:number }
export const AUTOMATIC_SOURCE_ISSUES = {
  SOURCE_IDENTITY_CONFLICT:'SYSTEM_REPAIR', SOURCE_STORAGE_INVALID:'SYSTEM_REPAIR',
  SOURCE_LINKS_MISSING:'NEEDS_INPUT', SOURCE_BINDING_UNCONFIRMED:'NEEDS_INPUT', SOURCE_REFERENCE_UNUSABLE:'NEEDS_INPUT',
  SOURCE_DOWNLOAD_FAILED:'SYSTEM_REPAIR', SOURCE_MAPPING_MISSING:'SYSTEM_REPAIR', SOURCE_MAPPING_INVALID:'SYSTEM_REPAIR',
} as const;
export type AutomaticSourceIssueCode = keyof typeof AUTOMATIC_SOURCE_ISSUES;
/** Read-only IPC projection; never persist resultUnknown in an ImageWorkflowRun. */
export type ImageWorkflowProgress = ImageWorkflowRun & {retryAllowanceStatus?:{slot:number;manual:boolean;automatic:boolean;reason:string;retainedAttempts?:ImageSlotAttempt[];scope?:'generation'|'planning'}[];sourceTrace?:{selectedSku:unknown;referenceAssets:{assetId:string;sha256:string;variantId:string|null}[];transport:string;requestBytes:number|null;callId:string|null;resultId:string|null;providerReceiptId:string|null;modelObservation:import('./image-ai-contracts.ts').ImagePlanOutput['productUnderstanding']|null};resultUnknown?:boolean;sourceRiskSummary?:string;riskEvidence?:{slot:number;summary:string}[]};
export interface ImageWorkflowApi {
  addImageRetryAllowance(input:{draftId:string;slot:number;requestId:string;commandId:string}):Promise<ImageWorkflowProgress>;
  getAutomaticImageCandidatePreview(input:{draftId:string;slot:number;candidateId:string}):Promise<AutomaticImageCandidatePreview>;
  approveUnknownImageRetry(input:{draftId:string;slot:number;requestId:string}):Promise<ImageWorkflowProgress>;
  getImageRiskSettings():Promise<ImageRiskSettings>;
  saveImageRiskSettings(input:ImageRiskSettings):Promise<ImageRiskSettings>;
  getAppearanceReviewSettings():Promise<{enabled:boolean}>;
  saveAppearanceReviewSettings(input:{enabled:boolean}):Promise<{enabled:boolean}>;
  getCopyReviewSettings():Promise<CopyReviewSettings>;
  saveCopyReviewSettings(input:CopyReviewSettings):Promise<CopyReviewSettings>;
  prepareAutomaticProductSources(input: { productId: string; productRevision: number; variantIds: string[] }): Promise<{ product: ProductDetail; missing: { variantId: string; message: string; code?:AutomaticSourceIssueCode }[] }>;
  cancelAutomaticProductSources(productId: string): Promise<{ cancelled: boolean }>;
  completeAutomaticProduct(input: CompleteAutomaticProductInput): Promise<CompleteAutomaticProductResult>;
  getAutomaticProductProgress(draftId: string): Promise<ImageWorkflowProgress | null>;
  cancelAutomaticProduct(draftId: string): Promise<{ cancelled: boolean }>;
}
