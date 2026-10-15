import {validateAppearanceReview} from '../image-workflow/appearance-review.ts';
export * from './primitives.ts';
export { protectedAttribute,validateTextOutput,validateTextReviewOutput,ossImageUrl } from './basic-output-validation.ts';
import { validateBasicOutput } from './basic-output-validation.ts';
import { CAPABILITIES,invalid,object,keys,providerId,uuid,integer,boundedText,flag,date,sha256,uuidList,isChatProvider,isGenerationProvider,isReviewProvider,modelFor,validateUsage,requestId } from './primitives.ts';
import { validatePurposeSnapshot } from './purpose-routing.ts';
import { validateAssignments } from './field-purpose-groups.ts';
import { assembleFieldOutputs } from '../listing-ai/group-output.ts';
import { textModelCapability } from './model-capabilities.ts';
import {replayReferenceCandidates,sameRecoverySource} from '../listing-ai/candidate-recovery.ts';
import { parseFullGeneration, retainValidNativeCandidates } from '../listing-ai/full-schema.ts';
import { validateOutputRejection, validateFieldRejections } from '../../shared/rejection-presentation.ts';
import { validateConsistencyContext } from "../source-image-consistency/contracts.ts";
import { validateConsistencyOutput,assertConsistencyOutput } from '../source-image-consistency/comparison.ts';
import { LISTING_EVIDENCE_CONTRACT_VERSIONS } from '../../shared/listing-ai-contracts.ts';
import type { ListingEvidenceContractVersion } from '../../shared/listing-ai-contracts.ts';
import { assertListingEvidence } from '../listing-ai/validation.ts';
import { assertStoredListingEvidence } from '../listing-ai/stored-evidence.ts';
import { validateListingNormalizationV1 } from '../listing-ai/normalization-v1.ts';
import type { AiCall,AiErrorCode,AiOutput,AiResult } from '../../shared/ai-contracts.ts';
import { listingFingerprint, validateListingContext, validateListingFieldsOutput, validateListingReviewOutput } from '../listing-ai/validation.ts';
import { AI_ERROR_CODES } from './errors.ts';
import { validateRequestScope } from './request-identity.ts';
import { assertCurrentListingReview, assertImagePlan, parseImagePlanResponse, parseImagePlanRecovery, validateGeneratedImageOcr, validateImagePlan, validateImageTextReview, validateImageIpReview, validateListingCurrentReview, validateProductImageContext } from './image-validation.ts';
import { MAX_VISION_REQUEST_BYTES } from './vision.ts';
import { PRODUCT_IMAGE_POLICY_VERSION, imageCopySourceIds } from '../../shared/image-ai-contracts.ts';
import { validateCategoryDecision } from './category-adapter.ts';
import { assertSourceColorOutput, validateSourceColorContext, validateSourceColorOutput } from './source-color-validation.ts';

export function validateAiCall(raw: unknown): AiCall {
    const o = keys(raw, ['id', 'providerId', 'productId', 'productRevision', 'status', 'errorCode', 'requestId', 'model', 'generation', 'startedAt', 'finishedAt', 'usage'], ['requestScope','requestFingerprint','categoryContext','purposeAssignments','providerReceiptId','purposeSnapshot','sourceColorContext','sourceConsistencyContext','rejection','presentationContext','thinking','responseReceived','imagePlanRetryBlock','schemaResponseRetained']), id = providerId(o.providerId);
  if (typeof o.status !== 'string' || !['RUNNING', 'SUCCEEDED', 'FAILED'].includes(o.status) || (o.errorCode !== null && !AI_ERROR_CODES.includes(o.errorCode as AiErrorCode))) invalid();
  const requestScope=o.requestScope===undefined?undefined:validateRequestScope(o.requestScope);
  if((requestScope===undefined)!==(o.requestFingerprint===undefined)||requestScope&&requestScope.productId!==o.productId)invalid();
  const startedAt = date(o.startedAt), finishedAt = o.finishedAt === null ? null : date(o.finishedAt);
  if ((o.status === 'RUNNING' && (finishedAt !== null || o.errorCode !== null)) || (o.status === 'SUCCEEDED' && (!finishedAt || o.errorCode !== null)) || (o.status === 'FAILED' && (!finishedAt || o.errorCode === null)) || (finishedAt && finishedAt < startedAt)) invalid();
  if(o.thinking!==undefined&&(!isChatProvider(id)||typeof o.thinking!=='boolean'))invalid();
  let presentationContext:AiCall['presentationContext'];
  if(o.presentationContext!==undefined){const c=keys(o.presentationContext,['kind','draftId','variantId','sourceSha256','slot'],['workflowId','imagePlanRequestSha256']);if(!['image','listing'].includes(String(c.kind)))invalid();presentationContext={...(c.imagePlanRequestSha256===undefined?{}:{imagePlanRequestSha256:sha256(c.imagePlanRequestSha256)}),...(c.workflowId===undefined?{}:{workflowId:uuid(c.workflowId)}),kind:c.kind as 'image'|'listing',draftId:uuid(c.draftId),variantId:uuid(c.variantId),sourceSha256:sha256(c.sourceSha256),slot:integer(c.slot,0,7)};if(c.kind==='listing'&&(c.slot!==0||c.workflowId!==undefined||c.imagePlanRequestSha256!==undefined))invalid();}
  if(o.schemaResponseRetained!==undefined&&(o.schemaResponseRetained!==true||o.responseReceived!==true||!presentationContext))invalid();
  if(o.responseReceived!==undefined&&(o.responseReceived!==true||o.status!=='FAILED'||o.errorCode!=='OUTPUT_INVALID'))invalid();
  if(o.imagePlanRetryBlock!==undefined&&(!['RESPONSE_NOT_CONTENT','RESPONSE_SECRET_ECHO'].includes(String(o.imagePlanRetryBlock))||!isGenerationProvider(id)||!textModelCapability(id==='openrouter'?'openrouter':'deepseek',String(o.model)).vision||presentationContext?.kind!=='image'||o.status!=='FAILED'||o.errorCode!=='OUTPUT_INVALID'))invalid();
  const rejection=o.rejection===undefined?undefined:validateOutputRejection(o.rejection);
  if(rejection&&(o.status!=='FAILED'||o.errorCode!=='OUTPUT_INVALID'))invalid();
  const sourceColorContext=o.sourceColorContext===undefined?undefined:validateSourceColorContext(o.sourceColorContext);
  const sourceConsistencyContext=o.sourceConsistencyContext===undefined?undefined:validateConsistencyContext(o.sourceConsistencyContext);
  if(sourceConsistencyContext&&(sourceColorContext||!isGenerationProvider(id)||!textModelCapability(id==='openrouter'?'openrouter':'deepseek',String(o.model)).vision||sourceConsistencyContext.productId!==o.productId||sourceConsistencyContext.productRevision!==o.productRevision))invalid();
  if(sourceColorContext&&(!isGenerationProvider(id)||!textModelCapability(id==='openrouter'?'openrouter':'deepseek',String(o.model)).vision||sourceColorContext.productId!==o.productId||sourceColorContext.productRevision!==o.productRevision))invalid();
  const purposeSnapshot=o.purposeSnapshot===undefined?undefined:validatePurposeSnapshot(o.purposeSnapshot);
  const purposeAssignments=o.purposeAssignments===undefined?undefined:validateAssignments(o.purposeAssignments);
  if(purposeAssignments&&(!purposeSnapshot||purposeAssignments.some(a=>a.purpose.model!==o.model||a.purpose.gateway!==purposeSnapshot.gateway||a.purpose.effectiveEffort!==purposeSnapshot.effectiveEffort)))invalid();
  if(purposeSnapshot&&(purposeSnapshot.model!==o.model||purposeSnapshot.gateway!==(id.startsWith('openrouter')?'openrouter':'deepseek')))invalid();
  let categoryContext:AiCall['categoryContext'];
  if(o.categoryContext!==undefined){const c=keys(o.categoryContext,['version','phase','requestSha256']);if(c.version!==1||!['keywords','select','judge'].includes(String(c.phase))||!purposeSnapshot||purposeSnapshot.purposeId!==(c.phase==='select'?'category_decision':'category_analysis'))invalid();categoryContext={version:1,phase:c.phase as 'keywords'|'select'|'judge',requestSha256:sha256(c.requestSha256)};}
  return { ...(requestScope?{requestScope,requestFingerprint:sha256(o.requestFingerprint)}:{}), ...(categoryContext?{categoryContext}:{}), ...(purposeAssignments?{purposeAssignments}:{}), ...(o.providerReceiptId===undefined?{}:{providerReceiptId:sha256(o.providerReceiptId)}), ...(purposeSnapshot?{purposeSnapshot}:{}), ...(o.schemaResponseRetained?{schemaResponseRetained:true as const}:{}), ...(o.imagePlanRetryBlock?{imagePlanRetryBlock:o.imagePlanRetryBlock as AiCall['imagePlanRetryBlock']}:{}), ...(o.responseReceived?{responseReceived:true as const}:{}), ...(o.thinking===undefined?{}:{thinking:flag(o.thinking)}), ...(presentationContext?{presentationContext}:{}), ...(rejection?{rejection}:{}), id: uuid(o.id), providerId: id, productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), status: o.status as AiCall['status'], errorCode: o.errorCode as AiCall['errorCode'], requestId: requestId(o.requestId), model: modelFor(id, o.model), generation: integer(o.generation, 1, Number.MAX_SAFE_INTEGER - 1), startedAt, finishedAt, usage: validateUsage(o.usage), ...(sourceColorContext?{sourceColorContext}:{}), ...(sourceConsistencyContext?{sourceConsistencyContext}:{}) };
}
export function validateOutput(raw: unknown): AiOutput {
  const kind = object(raw).kind;
  if (kind === 'source-image-consistency') return validateConsistencyOutput(raw);
  if (kind === 'source-color') return validateSourceColorOutput(raw);
  if (kind === 'category-decision') return validateCategoryDecision(raw);
  if (kind === 'image-plan') return validateImagePlan(raw);
  if (kind === 'generated-image-ocr') return validateGeneratedImageOcr(raw);
  if (kind === 'image-appearance-review') return validateAppearanceReview(raw);
  if (kind === 'image-text-review') return validateImageTextReview(raw);
  if (kind === 'image-ip-review') return validateImageIpReview(raw);
  if (kind === 'listing-current-review') return validateListingCurrentReview(raw);
  if (kind === 'amazon-fields') return validateListingFieldsOutput(raw);
  if (kind === 'amazon-fields-review') return validateListingReviewOutput(raw);
  return validateBasicOutput(raw);
}
export function validateAiResult(raw: unknown, options:{stored?:boolean}={}): AiResult {
  const o = keys(raw, ['id', 'callId', 'providerId', 'productId', 'productRevision', 'variantId', 'assetId', 'assetSha256', 'sourceResultIds', 'model', 'createdAt', 'reviewState', 'output'], ['providerReceiptRecovery','fieldGroupPart','fieldGroupAssembly','fieldCandidateRecovery','imagePlanRecovery', 'localRecovery', 'fieldRejections', 'listingEvidenceContractVersion', 'listingNormalization', 'sourceSha256', 'listingContext', 'listingRequestBytes', 'imageContext', 'imageRequestBytes', 'sourceColorContext', 'sourceColorRequestBytes', 'sourceConsistencyContext', 'sourceConsistencyRequestBytes']), id = providerId(o.providerId), output = validateOutput(o.output);
  const variantId = o.variantId === null ? null : uuid(o.variantId), assetId = o.assetId === null ? null : uuid(o.assetId), sourceResultIds = uuidList(o.sourceResultIds, 10);
  const assetSha256 = o.assetSha256 === null ? null : boundedText(o.assetSha256, 64);
  const listingKind = output.kind === 'amazon-fields' || output.kind === 'amazon-fields-review' || output.kind === 'listing-current-review';
  const imageKind = output.kind === 'image-appearance-review' || output.kind === 'image-plan' || output.kind === 'generated-image-ocr' || output.kind === 'image-text-review' || output.kind === 'image-ip-review';
  const expectedProvider = output.kind === 'source-image-consistency' || output.kind === 'source-color' ? 'deepseek' : output.kind === 'category-decision' ? output.phase === 'judge' ? 'deepseek-review' : 'deepseek' : imageKind ? output.kind === 'image-plan' ? 'deepseek' : output.kind === 'generated-image-ocr' ? 'aliyun-ocr' : output.kind === 'image-ip-review' ? 'aliyun-image-risk' : 'deepseek-review' : listingKind ? output.kind === 'amazon-fields' ? 'deepseek' : 'deepseek-review' : null;
  if (o.reviewState !== 'unreviewed' || (expectedProvider ? (expectedProvider==='deepseek'?!isGenerationProvider(id):expectedProvider==='deepseek-review'?!isReviewProvider(id):id!==expectedProvider) : output.kind !== CAPABILITIES[id]) || (assetSha256 !== null && !/^[a-f0-9]{64}$/.test(assetSha256))) invalid();
  if (isChatProvider(id) || imageKind ? (!variantId || assetId !== null || assetSha256 !== null) : (variantId !== null || !assetId || !assetSha256 || sourceResultIds.length)) invalid();
  if (o.sourceSha256 !== undefined && !isGenerationProvider(id) && !listingKind && !imageKind && output.kind !== 'category-decision') invalid();
  if (output.kind === 'text-review' && (sourceResultIds.length !== 1 || sourceResultIds[0] !== output.suggestionId)) invalid();
  if(o.listingEvidenceContractVersion!==undefined&&(!(listingKind||imageKind)||!(LISTING_EVIDENCE_CONTRACT_VERSIONS as readonly unknown[]).includes(o.listingEvidenceContractVersion)))invalid();
  if(listingKind&&o.listingEvidenceContractVersion==='listing-evidence/v5')invalid();
  const evidenceOptions=options.stored?{storedVersion:o.listingEvidenceContractVersion as string??null}:{};
  const listingContext = listingKind ? validateListingContext(o.listingContext) : undefined;
  let fieldGroupPart:AiResult['fieldGroupPart'],fieldGroupAssembly:AiResult['fieldGroupAssembly'];
  if(o.fieldGroupPart!==undefined){
    const part=keys(o.fieldGroupPart,['operationId','fields']);if(output.kind!=='amazon-fields'||!listingContext||!Array.isArray(part.fields)||!part.fields.length||part.fields.length>1000||part.fields.some(f=>typeof f!=='string'||!listingContext.fields.some(v=>v.name===f))||new Set(part.fields).size!==part.fields.length)invalid();
    fieldGroupPart={operationId:uuid(part.operationId),fields:part.fields as string[]};
    if([...output.candidates,...output.missing].some(f=>!fieldGroupPart!.fields.includes(f.field)))invalid();
  }
  if(o.fieldGroupAssembly!==undefined){
    const group=keys(o.fieldGroupAssembly,['version','operationId','sources','assembledAt']);
    if(fieldGroupPart||o.localRecovery||o.fieldCandidateRecovery||group.version!==1||!listingContext||output.kind!=='amazon-fields'||!Array.isArray(group.sources)||group.sources.length<2||group.sources.length>7||group.sources.some(s=>!s||typeof s!=='object'||Object.hasOwn(s,'fieldGroupAssembly')||Object.hasOwn(s,'fieldCandidateRecovery'))||Buffer.byteLength(JSON.stringify(group.sources))>16*1024*1024)invalid();
    const sources=(group.sources as unknown[]).map(s=>validateAiResult(s,options)),assembledAt=date(group.assembledAt),operationId=uuid(group.operationId),first=sources[0];
    if(first.callId!==o.callId||first.providerId!==id||first.model!==o.model||first.createdAt!==o.createdAt||new Set(sources.map(s=>s.id)).size!==sources.length||sources.some(s=>s.output.kind!=='amazon-fields'||s.fieldGroupPart?.operationId!==operationId||s.sourceSha256!==o.sourceSha256||s.productId!==o.productId||s.productRevision!==o.productRevision||s.variantId!==o.variantId||s.createdAt>assembledAt))invalid();
    if(listingFingerprint(assembleFieldOutputs(sources.map(s=>s.output as import('../../shared/listing-ai-contracts.ts').ListingFieldsOutput),listingContext))!==listingFingerprint(output))invalid();
    fieldGroupAssembly={version:1,operationId,sources,assembledAt};
  }
  if(listingContext&&((listingContext.contract==='listing-full-schema/v1')!==(o.listingEvidenceContractVersion==='listing-evidence/v4')))invalid();
  if(listingContext&&output.kind==='amazon-fields'&&Boolean(output.contract)!==Boolean(listingContext.contract))invalid();
  if (!listingKind && (o.listingContext !== undefined || o.listingRequestBytes !== undefined)) invalid();
  if (listingContext && (listingContext.productId !== o.productId || listingContext.productRevision !== o.productRevision || listingContext.variantId !== variantId || listingFingerprint(listingContext) !== o.sourceSha256 || sourceResultIds.length !== (output.kind === 'amazon-fields-review'||output.kind==='amazon-fields'&&o.fieldCandidateRecovery!==undefined ? 1 : 0))) invalid();
  if (listingContext && output.kind === 'listing-current-review') assertCurrentListingReview({ kind: 'amazon-fields-review', verdict: output.verdict, checks: output.checks, issues: output.issues }, output.currentListingCopy, listingContext,options.stored?{storedVersion:o.listingEvidenceContractVersion as string??null}:{});
  if(listingContext&&output.kind==='amazon-fields'){if(options.stored)assertStoredListingEvidence(output,listingContext,o.listingEvidenceContractVersion as string|undefined);else assertListingEvidence(output,listingContext);}
  if (o.listingNormalization !== undefined && (output.kind !== 'amazon-fields' || !listingContext || o.listingEvidenceContractVersion !== 'listing-evidence/v3')) invalid();
  const listingNormalization = o.listingNormalization === undefined ? undefined : validateListingNormalizationV1(o.listingNormalization, output as import('../../shared/listing-ai-contracts.ts').ListingFieldsOutput, listingContext!);
  if(o.fieldRejections!==undefined&&(output.kind!=='amazon-fields'||!listingContext))invalid();
  const fieldRejections=o.fieldRejections===undefined?undefined:validateFieldRejections(o.fieldRejections,output as import('../../shared/listing-ai-contracts.ts').ListingFieldsOutput,listingContext!);
  let fieldCandidateRecovery:AiResult['fieldCandidateRecovery'];
  if(o.fieldCandidateRecovery!==undefined){
    const r=keys(o.fieldCandidateRecovery,['parserVersion','originalResult','originalSha256','recoveredAt']);
    if(r.parserVersion!=='field-reference-recovery/v1'||o.localRecovery||o.imagePlanRecovery||!listingContext||output.kind!=='amazon-fields'||!r.originalResult||typeof r.originalResult!=='object'||Object.hasOwn(r.originalResult,'fieldCandidateRecovery')||Buffer.byteLength(JSON.stringify(r.originalResult),'utf8')>2*1024*1024||listingFingerprint(r.originalResult)!==r.originalSha256)invalid();
    const original=validateStoredAiResult(r.originalResult);
    if(original.localRecovery||original.imagePlanRecovery||original.output.kind!=='amazon-fields'||!original.listingContext||!sameRecoverySource(original.listingContext,listingContext)||sourceResultIds.length!==1||sourceResultIds[0]!==original.id||original.id===o.id||original.callId!==o.callId||original.createdAt!==o.createdAt||date(r.recoveredAt)<original.createdAt||original.productId!==o.productId||original.productRevision!==o.productRevision||original.variantId!==o.variantId||original.providerId!==id||original.model!==o.model)invalid();
    if(listingFingerprint(replayReferenceCandidates(original.output,listingContext))!==listingFingerprint(output))invalid();
    fieldCandidateRecovery={parserVersion:r.parserVersion,originalResult:r.originalResult,originalSha256:sha256(r.originalSha256),recoveredAt:date(r.recoveredAt)};
  }
  let localRecovery:AiResult['localRecovery'];
  if(o.localRecovery!==undefined){
    const r=keys(o.localRecovery,['parserVersion','operationId','contextSha256','rawSha256','rawOutput','recoveredAt']);
    if((r.parserVersion!=='full-schema-recovery/v1'&&r.parserVersion!=='full-schema-recovery/v2')||!listingContext||listingContext.contract!=='listing-full-schema/v1'||output.kind!=='amazon-fields'||Buffer.byteLength(JSON.stringify(r.rawOutput),'utf8')>200000||listingFingerprint(r.rawOutput)!==r.rawSha256||r.contextSha256!==o.sourceSha256||r.recoveredAt!==o.createdAt)invalid();
    // v1 shipped both before and after selected-image citations were introduced.
    // Accept only an exact replay of one of those two published interpretations;
    // never upgrade or overwrite the stored output. New recoveries are stamped v2.
    const policies=r.parserVersion==='full-schema-recovery/v1'?['text-evidence/v1','selected-image/v2'] as const:['selected-image/v2'] as const;
    const expected=listingFingerprint(output);
    if(!policies.some(policy=>{try{return listingFingerprint(retainValidNativeCandidates(parseFullGeneration(r.rawOutput,listingContext,policy),listingContext))===expected;}catch{return false;}}))invalid();
    localRecovery={parserVersion:r.parserVersion,operationId:uuid(r.operationId),contextSha256:sha256(r.contextSha256),rawSha256:sha256(r.rawSha256),rawOutput:r.rawOutput,recoveredAt:date(r.recoveredAt)};
  }
  const imageContext = imageKind ? validateProductImageContext(o.imageContext,evidenceOptions) : undefined;
  let imagePlanRecovery:AiResult['imagePlanRecovery'];
  if(o.imagePlanRecovery!==undefined){
    const r=keys(o.imagePlanRecovery,['parserVersion','contextSha256','rawSha256','rawOutput','recoveredAt'],['repair']);
    if(o.localRecovery||!['image-plan-recovery/v1','image-plan-recovery/v2'].includes(String(r.parserVersion))||!imageContext||output.kind!=='image-plan'||Buffer.byteLength(JSON.stringify(r.rawOutput),'utf8')>200000||listingFingerprint(r.rawOutput)!==r.rawSha256||r.contextSha256!==o.sourceSha256||r.recoveredAt!==o.createdAt)invalid();
    if(listingFingerprint((r.parserVersion==='image-plan-recovery/v1'?parseImagePlanResponse:parseImagePlanRecovery)(r.rawOutput,imageContext))!==listingFingerprint(output))invalid();
    let repair:NonNullable<AiResult['imagePlanRecovery']>['repair'];if(r.repair!==undefined){const v=keys(r.repair,['previousPlanId','issues']);if(!Array.isArray(v.issues)||!v.issues.length||v.issues.length>50)invalid();repair={previousPlanId:uuid(v.previousPlanId),issues:v.issues.map(v=>boundedText(v,2000))};if(sourceResultIds.at(-1)!==repair.previousPlanId)invalid();}
    imagePlanRecovery={...(repair?{repair}:{}),parserVersion:r.parserVersion as 'image-plan-recovery/v1'|'image-plan-recovery/v2',contextSha256:sha256(r.contextSha256),rawSha256:sha256(r.rawSha256),rawOutput:r.rawOutput,recoveredAt:date(r.recoveredAt)};
  }
  if(imageContext&&((imageContext.listing.contract==='listing-full-schema/v1')!==(o.listingEvidenceContractVersion==='listing-evidence/v4')))invalid();
  if (!imageKind && (o.imageContext !== undefined || o.imageRequestBytes !== undefined)) invalid();
  if (imageContext) {
    const copySources = imageCopySourceIds(imageContext), offset = copySources.length;
    if (imageContext.listing.productId !== o.productId || imageContext.listing.productRevision !== o.productRevision || imageContext.listing.variantId !== variantId || listingFingerprint(imageContext) !== o.sourceSha256 || copySources.some((id,index) => sourceResultIds[index] !== id)) invalid();
    if (output.kind === 'image-plan') { if (sourceResultIds.length < offset || sourceResultIds.length > offset + 1) invalid(); assertImagePlan(output, imageContext,evidenceOptions); }
    if (output.kind === 'generated-image-ocr' && sourceResultIds.length !== offset) invalid();
    if (output.kind === 'image-ip-review' && (sourceResultIds.length!==offset+1 || sourceResultIds[offset]!==output.planResultId || imageContext.policyVersion!==PRODUCT_IMAGE_POLICY_VERSION))invalid();
    if (output.kind === 'image-appearance-review' && (sourceResultIds.length !== offset + (output.previousResultId ? 2 : 1) || sourceResultIds[offset] !== output.planResultId || output.previousResultId && sourceResultIds[offset+1] !== output.previousResultId || output.checks.some(c=>c.referenceAssetIds.some(id=>!imageContext.referenceAssets.some(a=>a.assetId===id))))) invalid();
    if (output.kind === 'image-text-review' && (sourceResultIds.length !== offset + 2 || sourceResultIds[offset] !== output.planResultId || sourceResultIds[offset+1] !== output.ocrResultId)) invalid();
  }
  if (imageContext && imageContext.policyVersion !== 'product-image/v1' && (output.kind === 'image-plan'||output.kind === 'image-appearance-review') && !textModelCapability(id==='openrouter'||id==='openrouter-review'?'openrouter':'deepseek',String(o.model)).vision) invalid();
  const sourceConsistencyContext=output.kind==='source-image-consistency'?validateConsistencyContext(o.sourceConsistencyContext):undefined;
  if(output.kind!=='source-image-consistency'&&(o.sourceConsistencyContext!==undefined||o.sourceConsistencyRequestBytes!==undefined))invalid();
  if(sourceConsistencyContext&&output.kind==='source-image-consistency'){
    if(!textModelCapability(id==='openrouter'?'openrouter':'deepseek',String(o.model)).vision||sourceResultIds.length||sourceConsistencyContext.productId!==o.productId||sourceConsistencyContext.productRevision!==o.productRevision||sourceConsistencyContext.variantId!==variantId||listingFingerprint(sourceConsistencyContext)!==o.sourceSha256)invalid();
    assertConsistencyOutput(output,sourceConsistencyContext);
  }
  const sourceColorContext=output.kind==='source-color'?validateSourceColorContext(o.sourceColorContext):undefined;
  if(output.kind!=='source-color'&&(o.sourceColorContext!==undefined||o.sourceColorRequestBytes!==undefined))invalid();
  if(sourceColorContext&&output.kind==='source-color'){
    if(!textModelCapability(id==='openrouter'?'openrouter':'deepseek',String(o.model)).vision||sourceResultIds.length||sourceColorContext.productId!==o.productId||sourceColorContext.productRevision!==o.productRevision||sourceColorContext.variantId!==variantId||listingFingerprint(sourceColorContext)!==o.sourceSha256)invalid();
    assertSourceColorOutput(output,sourceColorContext);
  }
  let providerReceiptRecovery:AiResult['providerReceiptRecovery'];
  if(o.providerReceiptRecovery!==undefined){const r=keys(o.providerReceiptRecovery,['version','receiptId','requestFingerprint','scopeSha256','recoveredAt'],['receiptSha256']);if(![1,2].includes(r.version as number)||r.version===1&&r.receiptSha256!==undefined||r.version===2&&!['generated-image-ocr','image-text-review','image-ip-review'].includes(output.kind)||o.localRecovery||o.imagePlanRecovery||o.fieldCandidateRecovery||date(r.recoveredAt)!==o.createdAt)invalid();const base={receiptId:sha256(r.receiptId),requestFingerprint:sha256(r.requestFingerprint),scopeSha256:sha256(r.scopeSha256),recoveredAt:date(r.recoveredAt)};providerReceiptRecovery=r.version===1?{version:1,...base}:{version:2,...base,receiptSha256:sha256(r.receiptSha256)};}
  return { ...(providerReceiptRecovery?{providerReceiptRecovery}:{}), ...(fieldGroupPart?{fieldGroupPart}:{}), ...(fieldGroupAssembly?{fieldGroupAssembly}:{}), ...(fieldCandidateRecovery?{fieldCandidateRecovery}:{}), ...(imagePlanRecovery?{imagePlanRecovery}:{}), ...(localRecovery?{localRecovery}:{}), ...(fieldRejections?{fieldRejections}:{}), id: uuid(o.id), callId: uuid(o.callId), providerId: id, productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), variantId, assetId, assetSha256, sourceResultIds, model: modelFor(id, o.model), createdAt: date(o.createdAt), reviewState: 'unreviewed', output, ...(o.sourceSha256 === undefined ? {} : { sourceSha256: sha256(o.sourceSha256) }), ...(listingContext ? { listingContext, ...(o.listingEvidenceContractVersion===undefined?{}:{listingEvidenceContractVersion:o.listingEvidenceContractVersion as ListingEvidenceContractVersion}), ...(o.listingRequestBytes===undefined?{}:{listingRequestBytes:integer(o.listingRequestBytes,1,listingContext.contract?16*1024*1024:1024*1024)}) } : {}), ...(listingNormalization ? { listingNormalization } : {}), ...(imageContext ? { imageContext, ...(o.listingEvidenceContractVersion===undefined?{}:{listingEvidenceContractVersion:o.listingEvidenceContractVersion as ListingEvidenceContractVersion}), ...(imagePlanRecovery&&o.imageRequestBytes===undefined?{}:{imageRequestBytes: integer(o.imageRequestBytes, 1, MAX_VISION_REQUEST_BYTES)}) } : {}), ...(sourceColorContext?{sourceColorContext,sourceColorRequestBytes:integer(o.sourceColorRequestBytes,1,MAX_VISION_REQUEST_BYTES)}:{}), ...(sourceConsistencyContext?{sourceConsistencyContext,sourceConsistencyRequestBytes:integer(o.sourceConsistencyRequestBytes,1,MAX_VISION_REQUEST_BYTES)}:{}) };
}
/** Persistence readers validate the original contract, never authorize a new action. */
export const validateStoredAiResult=(raw:unknown):AiResult=>validateAiResult(raw,{stored:true});
