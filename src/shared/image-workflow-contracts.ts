import type { AmazonDraft } from './amazon-contracts.ts';
import type { ProductDetail } from './contracts.ts';
import type { CategoryFieldRepairGrant, CATEGORY_FIELD_REPAIR_POLICY_VERSION } from './automatic-listing-contracts.ts';
import { IMAGE_TEXT_REVIEW_POLICY_VERSION } from './image-ai-contracts.ts';
import type { ProductImageContext, ProductImagePolicyVersion, ImageSetPlan, ImageTextReviewPolicyVersion, CandidateImageIdentity } from './image-ai-contracts.ts';

export interface ImageRiskSettings { enabled:boolean; scoreThreshold?:number; levelThreshold?:'low'|'medium'|'high' }
export interface CopyReviewSettings { enabled:boolean }

export const IMAGE_WORKFLOW_STAGES = ['content', 'planning', 'generating', 'ip-check', 'ocr', 'reviewing', 'adopting', 'complete'] as const;
export type ImageWorkflowStage = typeof IMAGE_WORKFLOW_STAGES[number];
export interface ImageSlotAttempt {
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
export interface ImageWorkflowRun {
  /** Absent means historical, not retroactively reviewed. */
  appearanceReviewEnabled?:boolean;
  /** Derivation under the same task; original context and paid attempt prefixes remain owned by the source run. */
  sourceReuse?:{derivationRunId:string;sourceRunId:string;sourceRunHash:string;sourceProductRevision:number;sourceContext:ProductImageContext;slotAttempts:number[];slotContexts:(string|null)[]};
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
export function canResumeImageWorkflow(run:ImageWorkflowRun|null|undefined):boolean{return !!run?.slots&&run.status!=='COMPLETED'&&!run.slots.some(slot=>slot.status==='BLOCKED')&&run.slots.some(slot=>slot.status!=='PASSED'&&(slot.attempts.length<run.maxAttempts||['GENERATING','GENERATED','UNKNOWN','PLANNING','READY'].includes(slot.attempts.at(-1)?.state??'')||slot.index>1&&slot.attempts.at(-1)?.state==='RETRYABLE_FAILURE'&&!!slot.attempts.at(-1)?.ipReviewResultId&&!!slot.attempts.at(-1)?.reviewResultId||run.slotPolicy==='seven-product-v2'&&needsImageTextPolicyReview(slot.attempts.at(-1))));}
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
export type ImageWorkflowProgress = ImageWorkflowRun & {sourceTrace?:{selectedSku:unknown;referenceAssets:{assetId:string;sha256:string;variantId:string|null}[];transport:string;requestBytes:number|null;callId:string|null;resultId:string|null;providerReceiptId:string|null;modelObservation:import('./image-ai-contracts.ts').ImagePlanOutput['productUnderstanding']|null};resultUnknown?:boolean;sourceRiskSummary?:string;riskEvidence?:{slot:number;summary:string}[]};
export interface ImageWorkflowApi {
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
