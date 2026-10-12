import type { AutomaticListingItem } from '../../shared/automatic-listing-contracts.ts';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { sameSchemaValidation } from '../amazon/schema-compatibility.ts';
import { plainColorValue, needsPlainColorRefresh } from './plain-colors.ts';
import { haulUnsupportedField, haulCleanupReason } from '../amazon/listing-program.ts';
import { currentPolicyRemaining, needsBusinessAuthorityRefresh, manualBrandIssues } from '../image-workflow/policy-reevaluation.ts';
import { resultHasOwner } from '../ai/result-owner.ts';
import { randomUUID } from 'node:crypto';
import { CompletionJournal, completionDraftStamp, completionSafetyScope, completionSafetyIdentity, unknownCompletion } from './completion-journal.ts';
import type { CompletionOperation, CompletionRound } from './completion-journal.ts';
import type { AiResult } from '../../shared/ai-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { SourceColorContext } from '../../shared/source-color-contracts.ts';
import { hasSkuColorEvidence } from './sku-colors.ts';
import type { AmazonDraft, JsonObject, ListingIssue } from '../../shared/amazon-contracts.ts';
import type { AdoptAmazonFieldsInput, ListingAiContext, ListingFieldAdoption, ListingFieldsOutput, ReviewAmazonFieldsInput, SuggestAmazonFieldsInput } from '../../shared/listing-ai-contracts.ts';
import { LISTING_CANDIDATE_FIELDS, CATEGORY_INFERENCE_POLICY_VERSION } from '../../shared/listing-ai-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import type { WorkspaceStore } from '../store.ts';
import type { AiService } from '../ai/service.ts';
import type { AmazonService } from '../amazon/service.ts';
import { integer, keys, uuid } from '../ai/validation.ts';
import { candidateTextValues, validateFieldValues, validatePolicyOutputs, wrapCandidateValues } from '../amazon/field-mapping.ts';
import { buildListingContext } from './context.ts';
import { assertListingEvidence, assertListingReview, listingFingerprint, selectedSkuCategoryConflicts, validateListingContext } from './validation.ts';
import type { CurrentListingCopy } from '../../shared/image-ai-contracts.ts';
import { currentImageListingSnapshot } from '../image-workflow/image-facts.ts';
import { currentDraftEvidenceIssues, currentProseRepairIssues } from './current-evidence.ts';
import { isProseField } from './evidence-prose-v3.ts';
import { isFullSchema,candidateNative,nativeCandidateIssues,fullCopyPolicyIssues } from './full-schema.ts';

export interface CurrentCopyRepairResult {
  draft: AmazonDraft;
  aiCalls: number;
  review?: { context: ListingAiContext; review: AiResult; currentListingCopy: CurrentListingCopy[] };
  remaining: string[];
  feedbackResultId?: string;
  blocked: boolean;
}

function input(raw: unknown, kind: 'suggest' | 'review' | 'adopt'): AdoptAmazonFieldsInput {
  const o = keys(raw, ['draftId','draftRevision', ...(kind === 'suggest' ? [] : ['suggestionResultId']), ...(kind === 'adopt' ? ['reviewResultId','fields'] : [])]);
  const common = { draftId: uuid(o.draftId), draftRevision: integer(o.draftRevision, 1, Number.MAX_SAFE_INTEGER) };
  if (kind !== 'adopt') return { ...common, ...(kind === 'review' ? { suggestionResultId: uuid(o.suggestionResultId) } : {}) } as AdoptAmazonFieldsInput;
  if (!Array.isArray(o.fields) || !o.fields.length || new Set(o.fields).size !== o.fields.length || o.fields.some(f => typeof f!=='string'||!f)) throw new UserFacingError('请选择有效且不重复的候选字段');
  return { ...common, suggestionResultId: uuid(o.suggestionResultId), reviewResultId: o.reviewResultId === null ? null : uuid(o.reviewResultId), fields: o.fields };
}
/** Coordinates trusted sources without making the AI and Amazon services depend on each other. */
export class ListingAiService {
  private store: WorkspaceStore; private amazon: AmazonService; private ai: AiService;
  private copyReviewEnabled: () => boolean;
  constructor(store: WorkspaceStore, amazon: AmazonService, ai: AiService, copyReviewEnabled: () => boolean = () => true) { this.store = store; this.amazon = amazon; this.ai = ai; this.copyReviewEnabled = copyReviewEnabled; }
  private colorScopes(draft:AmazonDraft,product:ProductDetail,generation:number):SourceColorContext[] {
    const base=buildListingContext(draft,product,generation);
    if(draft.schema.parentageLevel==='PARENT'||!base.fields.some(field=>field.name==='color'))return [];
    if(!draft.salesPlan&&hasSkuColorEvidence(base.evidence))return [];
    const components=draft.salesPlan?.recipe.components??[{variantId:draft.variantId}];
    const scopes:SourceColorContext[]=[];
    for(const component of components){
      const variant=product.variants.find(value=>value.id===component.variantId);
      if(!variant)throw new UserFacingError('来源 SKU 已变化，未读取其他规格的颜色');
      const raw=buildListingContext({...draft,salesPlan:undefined,variantId:variant.id,sku:variant.sku},product,generation);
      if(hasSkuColorEvidence(raw.evidence))continue;
      try{scopes.push(this.ai.sourceColorContext({productId:product.id,productRevision:product.revision,variantId:variant.id}));}
      catch(error){
        // Missing usable references leave the existing missing-field path intact.
        // Stale source/hash and provider errors must still surface.
        if(error instanceof UserFacingError&&/图片|来源图/.test(error.message))return [];
        throw error;
      }
    }
    return scopes;
  }
  private colorResult(context:SourceColorContext):AiResult|undefined {
    const hash=listingFingerprint(context);
    return this.ai.listResults(context.productId).filter(result=>{
      if(result.output.kind!=='source-color'||!result.sourceColorContext||result.sourceSha256!==hash||listingFingerprint(result.sourceColorContext)!==hash)return false;
      const call=this.ai.getCall(result.callId);
      return !!call&&call.status==='SUCCEEDED'&&call.providerId===result.providerId&&call.productId===context.productId&&call.productRevision===context.productRevision&&call.model===result.model&&call.finishedAt===result.createdAt&&(!call.sourceColorContext||listingFingerprint(call.sourceColorContext)===hash);
    }).at(-1);
  }
  /** Attach original-image observations as their own evidence type, never as saved product facts. */
  private sourceAssets(draft:AmazonDraft,product:ProductDetail):ProductDetail['assets']{
    const variants=[...new Set(draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId])];
    const ids=new Set(variants.flatMap(variantId=>this.ai.sourceConsistencyContext({productId:product.id,productRevision:product.revision,variantId}).referenceAssets.map(asset=>asset.assetId)));
    return product.assets.filter(asset=>ids.has(asset.id));
  }
  currentContext(draft:AmazonDraft,product:ProductDetail,generation:number,legacy=false):ListingAiContext {
    const context=buildListingContext(draft,product,generation,legacy);
    if(isFullSchema(context)){
      context.sourceProduct!.assets=this.sourceAssets(draft,product);
      const observations=[...new Set(draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId])].map(variantId=>this.ai.sourceObservationEvidence({productId:product.id,productRevision:product.revision,variantId}));
      context.sourceProduct!.observations=observations;
      for(const source of observations)for(const image of source.images.filter(image=>!source.productReferenceAssetIds?.includes(image.assetId)))for(const [index,observation] of (image.observations??[]).entries())context.evidence.push({id:`${source.variantId}:observation:${image.assetId}:${index}`,name:observation.name,value:observation.values.join(', '),meaning:'general',source:'image_observation'});
      return validateListingContext(context);
    }
    if(!this.ai.listResults(product.id).some(result=>result.output.kind==='source-color'&&result.productRevision===product.revision))return context;
    const scopes=this.colorScopes(draft,product,generation);
    const results=scopes.map(scope=>this.colorResult(scope));
    if(results.some(result=>!result||result.output.kind!=='source-color'||result.output.verdict!=='DETERMINED'))return context;
    for(const result of results){
      if(!result?.sourceColorContext||result.output.kind!=='source-color'||result.output.verdict!=='DETERMINED')continue;
      context.evidence.push({id:`${draft.variantId}:source-color:${result.id}`,name:'Product color observed in original SKU image',value:result.output.colors.join(', '),meaning:'color',source:'source_image',imageObservation:{resultId:result.id,context:structuredClone(result.sourceColorContext),colors:[...result.output.colors]}});
    }
    return validateListingContext(context);
  }
  /** Authorization aliases do not alter frozen request context fingerprints. */
  currentAuthorizationContext(draft:AmazonDraft,product:ProductDetail,generation:number,legacyImage?:ListingAiContext):ListingAiContext {
    const context=this.currentContext(draft,product,generation);
    if(!isFullSchema(context))return context;
    if((!legacyImage||isFullSchema(legacyImage))&&!draft.fieldAdoptions?.some(adoption=>{const result=this.ai.getResult(adoption.suggestionResultId);return result?.listingContext&&!isFullSchema(result.listingContext);}))return context;
    const legacy=this.currentContext(draft,product,generation,true);
    for(const evidence of legacy.evidence)if(!context.evidence.some(item=>item.id===evidence.id))context.evidence.push(evidence);
    return context;
  }
  /** Cache all conclusive/uncertain observations by exact original-image context; never retry an unknown call. */
  async prepareSourceColors(raw:unknown,signal?:AbortSignal,repairIssues:readonly ListingIssue[]=[]):Promise<{aiCalls:number;evidenceChanged:boolean;evidenceSha256?:string}> {
    const reference=input(raw,'suggest'),initial=this.current(reference),product=this.store.getProduct(initial.draft.productId);
    if(isFullSchema(initial.context))return {aiCalls:0,evidenceChanged:false};
    const existing=initial.context.evidence.filter(value=>value.source==='source_image');
    const colorValues=initial.draft.attributes.color;
    const hasColor=Array.isArray(colorValues)&&colorValues.some(value=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.value==='string'&&value.value.trim());
    const missingRequired=!hasColor&&initial.context.fields.some(field=>field.name==='color'&&field.requirement==='required');
    const rejected=this.amazon.wasSubmissionRejected(initial.draft.id)?initial.draft.listingIssues:[];
    const colorError=[...initial.draft.localIssues,...initial.draft.previewIssues,...rejected,...repairIssues].some(issue=>issue.severity==='ERROR'&&issue.attributeNames.includes('color'));
    if(!missingRequired&&!colorError){
      for(const evidence of existing)await this.ai.assertSourceColorFresh(evidence.imageObservation!.context,signal);
      return {aiCalls:0,evidenceChanged:false,...(existing.length?{evidenceSha256:listingFingerprint(existing)}:{})};
    }
    const generation=initial.context.targetGeneration,scopes=this.colorScopes(initial.draft,product,generation);
    if(!scopes.length)return {aiCalls:0,evidenceChanged:false};
    const before=listingFingerprint(initial.context.evidence);let aiCalls=0;
    const check=()=>{signal?.throwIfAborted();const current=this.current(reference);if(listingFingerprint(this.colorScopes(current.draft,this.store.getProduct(current.draft.productId),current.context.targetGeneration))!==listingFingerprint(scopes))throw new UserFacingError('来源图片或 SKU 已变化，未采用颜色结果');};
    for(const scope of scopes){
      check();await this.ai.assertSourceColorFresh(scope,signal);check();
      let result=this.colorResult(scope);
      if(!result){
        if(this.ai.listCalls().some(call=>call.sourceColorContext&&listingFingerprint(call.sourceColorContext)===listingFingerprint(scope)))throw new UserFacingError('上次来源颜色请求结果未确认或失败，已保留记录，未自动重发');
        this.amazon.assertPricingForPaid(reference.draftId);
        const paidCheck=()=>{check();this.amazon.assertPricingForPaid(reference.draftId);};
        result=await this.ai.observeSourceColor(scope,check,signal,paidCheck);aiCalls++;check();
      }
      if(result.output.kind!=='source-color'||result.output.verdict!=='DETERMINED')throw new UserFacingError('来源图中的颜色仍无法确定，请核对当前 SKU 的原图和规格；未采用模型自述作为确定原因。');
    }
    const context=this.current(reference).context,evidence=context.evidence.filter(value=>value.source==='source_image');
    return {aiCalls,evidenceChanged:before!==listingFingerprint(context.evidence),...(evidence.length?{evidenceSha256:listingFingerprint(evidence)}:{})};
  }
  private assertReviewSetting(enabled: boolean): void {
    if (this.copyReviewEnabled() !== enabled) throw new UserFacingError('文案审核设置已变化，请重新执行');
  }
  private current(reference: SuggestAmazonFieldsInput, scope?: ListingAiContext): { draft: AmazonDraft; context: ListingAiContext } {
    const draft = this.amazon.getDraft(reference.draftId);
    if (draft.revision !== reference.draftRevision) throw new UserFacingError('草稿已修改，请保存并重新生成建议');
    if (!['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(draft.state) || draft.submittedAt) throw new UserFacingError('已提交的草稿不能采纳 AI 建议，请核对处理状态');
    const { target, generation } = this.amazon.executionTargetScope(draft.targetId);
    if (target.paused || !target.configured || target.marketplaceId !== draft.marketplaceId || target.sellerId !== draft.sellerId) throw new UserFacingError('店铺连接或站点已变化，请检查连接');
    const context = this.currentContext(draft, this.store.getProduct(draft.productId), generation,!!scope&&!isFullSchema(scope));
    if (scope?.repairRequest) {
      context.fields = context.fields.filter(field => scope.fields.some(allowed => allowed.name === field.name));
      context.repairRequest = { issues: structuredClone(scope.repairRequest.issues), currentValues: Object.fromEntries(context.fields.map(field => [field.name, draft.attributes[field.name] ?? null])) };
    }
    return { draft, context };
  }
  private assertSourceConsistency(draft:AmazonDraft):void {this.store.assertSourceConsistency(draft.productId,draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId]);}
  private async fresh(reference: SuggestAmazonFieldsInput, snapshot: ListingAiContext): Promise<void> {
    const { draft, context } = this.current(reference, snapshot);this.assertSourceConsistency(draft);
    if (listingFingerprint(context) !== listingFingerprint(snapshot)) throw new UserFacingError('来源、店铺或规则已变化，请重新生成建议');
    for(const evidence of snapshot.evidence)if(evidence.imageObservation)await this.ai.assertSourceColorFresh(evidence.imageObservation.context);
    const schema = await this.amazon.getSchema(draft.schema);this.assertSourceConsistency(this.amazon.getDraft(draft.id));
    const unchanged=schema.checksum===snapshot.schemaChecksum&&schema.version===snapshot.schemaVersion&&listingFingerprint({schema:schema.schema,metaSchema:schema.metaSchema})===snapshot.schemaSha256;
    const displayOnly=schema.version===snapshot.schemaVersion&&snapshot.fullSchema&&sameSchemaValidation(schema,snapshot.fullSchema);
    if ((!unchanged&&!displayOnly) || listingFingerprint(this.current(reference, snapshot).context) !== listingFingerprint(snapshot)) throw new UserFacingError('Amazon 字段规则或商品资料已更新，请建立新草稿');
  }
  private result(id: string, c: ListingAiContext): AiResult {
    const result = this.ai.getResult(id), call = result && this.ai.getCall(result.callId);
    if (!result || !call || !resultHasOwner(result,call) || call.providerId !== result.providerId || call.productId !== c.productId || call.productRevision !== c.productRevision || call.model !== result.model || !result.listingContext || result.sourceSha256 !== listingFingerprint(c) || listingFingerprint(result.listingContext) !== listingFingerprint(c)) throw new UserFacingError('候选已过期或不属于当前草稿，请重新生成');
    return result;
  }
  private candidates(result: AiResult, draft: AmazonDraft, context: ListingAiContext): ListingFieldsOutput {
    if (result.output.kind !== 'amazon-fields') throw new UserFacingError('请选择本草稿生成的 Amazon 字段建议');
    assertListingEvidence(result.output, context);
    const values = Object.fromEntries(result.output.candidates.filter(c=>!isFullSchema(context)||['item_name','bullet_point','product_description','generic_keyword'].includes(c.field)).map(c => [c.field, c.items.map(i => i.value)]));
    const issues = isFullSchema(context)?[...fullCopyPolicyIssues(result.output),...nativeCandidateIssues(result.output,context)]:[...validatePolicyOutputs(draft.schema, values),...result.output.candidates.flatMap(c => validateFieldValues(draft.schema, draft.marketplaceId, c.field, c.items.map(i => i.value), draft.attributes))];
    if (issues.some(i => i.severity === 'ERROR')) throw new UserFacingError(`候选字段不符合规则：${issues.slice(0, 3).map(i => i.message).join('；')}`);
    return result.output;
  }
  hasRetainedFieldReferences(draft:AmazonDraft):boolean {
    return !this.copyReviewEnabled()&&this.ai.listResults(draft.productId).some(r=>!r.fieldCandidateRecovery&&r.listingContext?.draftId===draft.id&&r.output.kind==='amazon-fields'&&r.output.missing.some(m=>m.reason.includes('[FIELD_REFERENCE]')&&draft.attributes[m.field]===undefined));
  }
  /** Explicit local preparation only: reuse newly valid references, never regenerate or infer new facts. */
  recoverRetainedFieldCandidates(raw:unknown):{draft:AmazonDraft;recoveredFields:string[]} {
    const initial=input(raw,'suggest');let draft=this.amazon.getDraft(initial.draftId);let reference:SuggestAmazonFieldsInput=initial;const recoveredFields:string[]=[];
    const limit=this.ai.listResults(draft.productId).filter(r=>!r.fieldCandidateRecovery&&r.listingContext?.draftId===draft.id).reduce((total,r)=>total+(r.output.kind==='amazon-fields'?(r.output.rejectedCandidates?.length??0):0),0);
    for(let index=0;index<limit;index++){
      const result=this.recoverRetainedFieldCandidate(reference);draft=result.draft;
      if(!result.recoveredFields.length)break;
      recoveredFields.push(...result.recoveredFields);reference={draftId:draft.id,draftRevision:draft.revision};
    }
    return {draft,recoveredFields};
  }
  private recoverRetainedFieldCandidate(raw:unknown):{draft:AmazonDraft;recoveredFields:string[]} {
    const reference=input(raw,'suggest'),{draft,context}=this.current(reference);
    if(this.copyReviewEnabled()||draft.submittedAt||['SUBMITTING','SUBMITTED','PROCESSING','BUYABLE','DISCOVERABLE','UNKNOWN'].includes(draft.state))return {draft,recoveredFields:[]};
    this.assertSourceConsistency(draft);
    const originals=this.ai.listResults(draft.productId).filter(r=>!r.fieldCandidateRecovery&&r.output.kind==='amazon-fields'&&r.listingContext?.draftId===draft.id).reverse();
    for(const original of originals){
      if(original.output.kind!=='amazon-fields'||!original.output.rejectedCandidates?.some(c=>draft.attributes[c.field]===undefined))continue;
      const recovered=this.ai.recoverFieldCandidates(original.id,context);if(!recovered)continue;
      const candidate=this.candidates(recovered,draft,context),fields=candidate.candidates.filter(c=>draft.attributes[c.field]===undefined&&original.output.kind==='amazon-fields'&&!original.output.candidates.some(old=>old.field===c.field)).map(c=>c.field);
      if(!fields.length)continue;
      const attributes=structuredClone(draft.attributes),changes=fields.map(field=>{const c=candidate.candidates.find(c=>c.field===field)!,after=candidateNative(c,draft.schema,draft.marketplaceId);attributes[field]=after;return {field,before:null,after,evidence:context.evidence.filter(e=>c.items.some(item=>item.evidenceIds.includes(e.id)))};});
      const adoption:ListingFieldAdoption={id:listingFingerprint({draftId:draft.id,revision:draft.revision,suggestion:recovered.id,review:null,fields:[...fields].sort(),reviewDisposition:'SKIPPED_DISABLED'}),at:new Date().toISOString(),suggestionResultId:recovered.id,reviewResultId:null,contextSha256:listingFingerprint(context),fromRevision:draft.revision,toRevision:draft.revision+1,fields:[...fields].sort(),changes,reviewDisposition:'SKIPPED_DISABLED'};
      const updated=this.amazon.adoptFields({id:draft.id,revision:draft.revision},attributes,adoption,()=>{this.assertReviewSetting(false);this.assertSourceConsistency(draft);if(listingFingerprint(this.current(reference).context)!==listingFingerprint(context))throw new UserFacingError('本地恢复期间资料已变化');},true,(updated,db)=>{
        const journal=new CompletionJournal(db),afterContext={...context,draftRevision:updated.revision,currentAttributes:updated.attributes};
        for(const op of journal.list(draft.id))if(op.state==='DONE'&&op.draftRevision===draft.revision&&op.draftStamp===completionDraftStamp(draft)){
          op.draftRevision=updated.revision;op.draftStamp=completionDraftStamp(updated);op.remaining=currentPolicyRemaining(updated,afterContext,id=>this.ai.getResult(id));journal.save(op);
        }
      });
      return {draft:updated,recoveredFields:fields};
    }
    return {draft,recoveredFields:[]};
  }
  async suggest(raw: unknown, signal?: AbortSignal): Promise<AiResult> {
    await this.prepareSourceColors(raw,signal);
    const reference = input(raw, 'suggest'), { context } = this.current(reference); await this.fresh(reference, context);
    return this.ai.listingFields(context, () => this.fresh(reference, context), undefined, signal);
  }
  async review(raw: unknown, signal?: AbortSignal): Promise<AiResult> {
    if (!this.copyReviewEnabled()) throw new UserFacingError('文案审核已关闭');
    const reference: ReviewAmazonFieldsInput = input(raw, 'review'), scope = this.ai.getResult(reference.suggestionResultId)?.listingContext;
    const { draft, context } = this.current(reference, scope); await this.fresh(reference, context);
    this.assertReviewSetting(true);
    const candidate = this.candidates(this.result(reference.suggestionResultId, context), draft, context);
    return this.ai.listingFields(context, async () => { this.assertReviewSetting(true); await this.fresh(reference, context); this.assertReviewSetting(true); this.candidates(this.result(reference.suggestionResultId, context), this.current(reference).draft, context); }, { suggestionId: reference.suggestionResultId, candidate }, signal);
  }
  async adopt(raw: unknown, signal?:AbortSignal): Promise<AmazonDraft> {
    signal?.throwIfAborted();const reference = input(raw, 'adopt'), reviewEnabled = this.copyReviewEnabled();
    const ignored=reference.fields.filter(field=>haulUnsupportedField(this.amazon.getDraft(reference.draftId).listingProgram,field));
    reference.fields=reference.fields.filter(field=>!ignored.includes(field));
    const disposition = !reviewEnabled && reference.reviewResultId === null ? { reviewDisposition: 'SKIPPED_DISABLED' as const } : {};
    const adoptionId = listingFingerprint({ draftId: reference.draftId, revision: reference.draftRevision, suggestion: reference.suggestionResultId, review: reference.reviewResultId, fields: [...reference.fields].sort(), ...disposition });
    const existing = this.amazon.getDraft(reference.draftId);
    const prior = existing.fieldAdoptions?.find(a => a.id === adoptionId);
    if (prior && existing.revision === prior.toRevision) {
      const scope=this.ai.getResult(reference.suggestionResultId)?.listingContext;
      if(!scope)throw new UserFacingError('已采用候选的来源记录不完整');
      const current=this.current({draftId:existing.id,draftRevision:existing.revision},scope);await this.fresh({draftId:existing.id,draftRevision:existing.revision},current.context);
      signal?.throwIfAborted();this.assertReviewSetting(reviewEnabled);
      const suggestion=this.result(reference.suggestionResultId,scope),candidate=this.candidates(suggestion,existing,current.context);
      if(reference.reviewResultId){const review=this.result(reference.reviewResultId,scope);if(review.output.kind!=='amazon-fields-review'||review.output.verdict!=='PASS'||review.sourceResultIds[0]!==suggestion.id)throw new UserFacingError('已采用候选的复核记录不完整');assertListingReview(review.output,candidate,current.context);}
      signal?.throwIfAborted();this.assertReviewSetting(reviewEnabled);return existing;
    }
    const scopedOwner=this.ai.completionJournal.list(reference.draftId).find(op=>op.scopedRepair&&op.rounds.some(round=>round.candidate.resultId===reference.suggestionResultId));
    if(scopedOwner&&reference.fields.some(field=>!scopedOwner.scopedRepair!.fields.includes(field as 'theme')))throw new UserFacingError('旧主题修复仅允许采纳 theme 字段');
    const scope = this.ai.getResult(reference.suggestionResultId)?.listingContext;
    const { draft, context } = this.current(reference, scope); await this.fresh(reference, context);
    this.assertReviewSetting(reviewEnabled);
    const suggestion = this.result(reference.suggestionResultId, context), candidate = this.candidates(suggestion, draft, context);
    const review = reference.reviewResultId === null ? null : this.result(reference.reviewResultId, context);
    const latestReview = this.ai.listResults(draft.productId).filter(r => r.output.kind === 'amazon-fields-review' && r.sourceResultIds[0] === suggestion.id).at(-1);
    if (!disposition.reviewDisposition && latestReview && latestReview.id !== review?.id) throw new UserFacingError('该建议已有更新的复核结果，请按最新结果处理');
    if (review) {
      if (review.output.kind !== 'amazon-fields-review' || review.output.verdict !== 'PASS' || review.sourceResultIds[0] !== suggestion.id) throw new UserFacingError('复核发现问题，请先处理问题再采纳');
      assertListingReview(review.output, candidate, context);
    }
    if(ignored.length)this.store.recordWorkspaceEvent('amazon.haul.candidates.omitted',haulCleanupReason(ignored),{draftId:draft.id,fields:ignored});
    if(!reference.fields.length)return draft;
    const attributes: JsonObject = structuredClone(draft.attributes);
    if(isFullSchema(context)){
      const selected={...candidate,candidates:candidate.candidates.filter(c=>reference.fields.includes(c.field))};
      const issues=nativeCandidateIssues(selected,context);if(issues.length)throw new UserFacingError(`所选字段不符合规则：${issues.map(i=>i.message).join('；')}`);
    }
    const changes = reference.fields.map(field => {
      const c = candidate.candidates.find(c => c.field === field); if (!c) throw new UserFacingError('所选字段没有有效候选值');
      const before = attributes[field] ?? null, native = candidateNative(c,draft.schema,draft.marketplaceId,attributes[field]), after = field==='color'?plainColorValue(native,context.evidence.filter(e=>e.meaning==='color'||e.id===`${context.variantId}:spec`).map(e=>e.value)):native; attributes[field] = after;
      const evidenceIds = new Set(c.items.flatMap(i => i.evidenceIds));
      return { field, before, after, evidence: context.evidence.filter(e => evidenceIds.has(e.id)) };
    });
    const adoption: ListingFieldAdoption = { id: adoptionId, at: new Date().toISOString(), suggestionResultId: suggestion.id, reviewResultId: review?.id ?? null, contextSha256: listingFingerprint(context), fromRevision: draft.revision, toRevision: draft.revision + 1, fields: [...reference.fields].sort(), changes, ...disposition };
    signal?.throwIfAborted();return this.amazon.adoptFields({ id: draft.id, revision: draft.revision }, attributes, adoption, () => { signal?.throwIfAborted();this.assertReviewSetting(reviewEnabled);this.assertSourceConsistency(this.amazon.getDraft(draft.id)); if (listingFingerprint(this.current(reference, context).context) !== listingFingerprint(context)) throw new UserFacingError('草稿资料已变化，未写入建议'); });
  }

  /** A fresh copy snapshot for image generation when independent copy review is disabled. */
  async snapshotCurrentForImages(raw: unknown, signal?: AbortSignal): Promise<{ context: ListingAiContext; currentListingCopy: CurrentListingCopy[] }> {
    const reference = input(raw, 'suggest'), { draft, context } = this.current(reference);
    signal?.throwIfAborted();
    const snapshot = currentImageListingSnapshot(draft, context);
    const evidenceIssues=currentDraftEvidenceIssues(draft,isFullSchema(context)?this.currentAuthorizationContext(draft,this.store.getProduct(draft.productId),context.targetGeneration):context,id=>this.ai.getResult(id));
    if(evidenceIssues.length)throw new UserFacingError(evidenceIssues.join('；').slice(0,2000));
    if (!snapshot.currentListingCopy.length) throw new UserFacingError('草稿还没有文案，请先完成文案');
    await this.fresh(reference, context); signal?.throwIfAborted();
    const current = this.current(reference);
    if (listingFingerprint(currentImageListingSnapshot(current.draft, current.context)) !== listingFingerprint(snapshot)) throw new UserFacingError('草稿文案已变化，请重新获取文案');
    return snapshot;
  }

  /** Images always start with a fresh independent review, including preview-valid drafts. */
  async reviewCurrentForImages(raw: unknown, signal?: AbortSignal): Promise<{ context: ListingAiContext; review: AiResult; currentListingCopy: CurrentListingCopy[] }> {
    if (!this.copyReviewEnabled()) throw new UserFacingError('文案审核已关闭');
    const reference = input(raw, 'suggest'), { draft, context } = this.current(reference);
    const snapshot = currentImageListingSnapshot(draft,context), currentListingCopy = snapshot.currentListingCopy;
    if (!currentListingCopy.length) throw new UserFacingError('草稿还没有可审核文案，请先完成文案');
    const evidenceIssues=currentDraftEvidenceIssues(draft,isFullSchema(context)?this.currentAuthorizationContext(draft,this.store.getProduct(draft.productId),context.targetGeneration):context,id=>this.ai.getResult(id));
    if(evidenceIssues.length)throw new UserFacingError(evidenceIssues.join('；').slice(0,2000));
    const assertFresh = async () => { this.assertReviewSetting(true); await this.fresh(reference, context); this.assertReviewSetting(true); const current=this.current(reference); if (listingFingerprint(currentImageListingSnapshot(current.draft,current.context)) !== listingFingerprint(snapshot)) throw new UserFacingError('草稿文案已变化，请重新审核'); };
    await assertFresh(); signal?.throwIfAborted();
    const review = await this.ai.reviewCurrentListing(snapshot.context, currentListingCopy, assertFresh, signal);
    await assertFresh(); return { context:snapshot.context, review, currentListingCopy };
  }

  /** One repair round. The durable workflow reserves its two-round budget before calling. */
  async repairCurrentForImages(raw: unknown, signal?: AbortSignal): Promise<CurrentCopyRepairResult> {
    const value = keys(raw, ['draftId','draftRevision','reviewResultId'], ['feedbackResultId']);
    const reference = input({ draftId:value.draftId, draftRevision:value.draftRevision }, 'suggest');
    let { draft, context } = this.current(reference);
    if (!this.copyReviewEnabled()) {
      await this.fresh(reference, context); signal?.throwIfAborted(); this.assertReviewSetting(false);
      return { draft, aiCalls:0, remaining:[], blocked:false };
    }
    const snapshot = currentImageListingSnapshot(draft, context);
    const currentReview = this.result(uuid(value.reviewResultId), snapshot.context);
    if (currentReview.output.kind !== 'listing-current-review'
      || currentReview.output.copySha256 !== listingFingerprint(snapshot.currentListingCopy)
      || listingFingerprint(currentReview.output.currentListingCopy) !== listingFingerprint(snapshot.currentListingCopy)
      || currentReview.output.verdict === 'PASS') throw new UserFacingError('文案修复需要当前草稿的失败复核结果');
    let feedback = currentReview;
    if (value.feedbackResultId !== undefined) {
      const id = uuid(value.feedbackResultId), scope = this.ai.getResult(id)?.listingContext;
      if (!scope?.repairRequest) throw new UserFacingError('修复反馈不属于当前草稿');
      feedback = this.result(id, this.current(reference, scope).context);
      if (feedback.output.kind !== 'amazon-fields-review' || feedback.output.verdict === 'PASS' || feedback.sourceResultIds.length !== 1) throw new UserFacingError('修复反馈必须是未通过的独立复核');
      this.candidates(this.result(feedback.sourceResultIds[0], scope), draft, scope);
    }
    if (feedback.output.kind !== 'listing-current-review' && feedback.output.kind !== 'amazon-fields-review') throw new UserFacingError('文案修复反馈无效');
    const remaining = feedback.output.issues.map(issue => `${issue.field}：${issue.message}`);
    if (currentReview.output.verdict === 'BLOCKED' || feedback.output.verdict === 'BLOCKED') return { draft, aiCalls:0, remaining, blocked:true };
    const repairs = feedback.output.issues.map(issue => ({ field:issue.field, code:'CONTENT_REVIEW', message:issue.message.slice(0,2000) })).slice(0,50);
    context.fields = context.fields.filter(field => repairs.some(issue => issue.field === field.name));
    if (!context.fields.length) return { draft, aiCalls:0, remaining, blocked:true };
    context.repairRequest = { issues:repairs.filter(issue => context.fields.some(field => field.name === issue.field)), currentValues:Object.fromEntries(context.fields.map(field => [field.name,draft.attributes[field.name] ?? null])) };
    validateListingContext(context); await this.fresh(reference, context); signal?.throwIfAborted(); this.assertReviewSetting(true);
    const suggestion = await this.ai.listingFields(context, async () => { this.assertReviewSetting(true); await this.fresh(reference, context); this.assertReviewSetting(true); }, undefined, signal);
    this.assertReviewSetting(true);
    const candidate = this.candidates(suggestion, draft, context);
    const fields = candidate.candidates.filter(field => listingFingerprint(wrapCandidateValues(draft.schema,draft.marketplaceId,field.field,field.items.map(item => item.value),draft.attributes[field.field])) !== listingFingerprint(draft.attributes[field.field] ?? null)).map(field => field.field);
    if (!candidate.candidates.length) return { draft, aiCalls:1, remaining:[...remaining,...candidate.missing.map(item => `${item.field}：${item.reason}`)], blocked:true };
    const reviewed = await this.review({ ...reference, suggestionResultId:suggestion.id }, signal);
    if (reviewed.output.kind !== 'amazon-fields-review') throw new UserFacingError('文案审核结果无效');
    if (reviewed.output.verdict !== 'PASS') return { draft, aiCalls:2, remaining:reviewed.output.issues.map(issue => `${issue.field}：${issue.message}`), feedbackResultId:reviewed.id, blocked:reviewed.output.verdict === 'BLOCKED' };
    signal?.throwIfAborted();
    if (fields.length) draft = await this.adopt({ ...reference, suggestionResultId:suggestion.id, reviewResultId:reviewed.id, fields });
    const review = await this.reviewCurrentForImages({ draftId:draft.id, draftRevision:draft.revision }, signal);
    return { draft, aiCalls:3, review, remaining:review.review.output.kind === 'listing-current-review' ? review.review.output.issues.map(issue => `${issue.field}：${issue.message}`) : ['文案审核结果无效'], blocked:review.review.output.kind !== 'listing-current-review' || review.review.output.verdict === 'BLOCKED' };
  }

  private completionScope(draft:AmazonDraft,legacy=false):string {
    const context=buildListingContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation,legacy);
    const {fields: _fields,evidence: _evidence,draftRevision: _revision,repairRequest: _repair,categoryInferencePolicyVersion: _categoryPolicy,contract:_contract,fullSchema:_schema,currentAttributes:_attributes,businessValues:_business,sourceProduct:_source,...identity}=context;
    const product=this.store.getProduct(draft.productId);
    return listingFingerprint({identity,categoryInferencePolicyVersion:CATEGORY_INFERENCE_POLICY_VERSION,source:{id:product.id,revision:product.revision,facts:product.facts,variants:product.variants,assets:legacy?product.assets:this.sourceAssets(draft,product)},sellerId:draft.sellerId,salesPlan:draft.salesPlan??null,...(legacy?{}:{contract:'listing-full-schema/v1'})});
  }
  /** Main-only stable operation reference shared by automatic owners. */
  beginCompletion(raw:unknown,operationId?:string):CompletionOperation {
    const reference=input(raw,'suggest'),{draft,context}=this.current(reference);
    const operations=this.ai.completionJournal.list(draft.id),prior=operationId?operations.find(op=>op.id===operationId):operations.find(op=>!['DONE','RETIRED'].includes(op.state));
    const legacy=!!prior&&prior.scopeHash!==this.completionScope(draft)&&prior.scopeHash===this.completionScope(draft,true);
    const preserveDone=prior?.state==='DONE'&&legacy&&draft.listingProgram==='haul'&&operationId!==undefined;
    if(prior?.state==='DONE'&&legacy&&isFullSchema(context)&&!preserveDone)operationId=undefined;
    return this.ai.completionJournal.begin({draftId:draft.id,scopeHash:this.completionScope(draft,!isFullSchema(context)||!!legacy&&(prior?.state!=='DONE'||preserveDone)),safetyScopeHash:completionSafetyScope(draft),safetyIdentity:completionSafetyIdentity(draft),copyReviewEnabled:this.copyReviewEnabled(),draftRevision:draft.revision,draftStamp:completionDraftStamp(draft)},operationId,draft,()=>this.completionScope(draft,true));
  }
  beginLegacyThemeRepair(draftId:string,row:AutomaticListingItem,workflow:ImageWorkflowRun):CompletionOperation|undefined {
    const draft=this.amazon.getDraft(draftId),reference={draftId,draftRevision:draft.revision};
    this.current(reference);this.assertSourceConsistency(draft);
    const context=this.currentContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation,true);
    return this.ai.completionJournal.beginLegacyThemeRepair({draftId,scopeHash:this.completionScope(draft),safetyScopeHash:completionSafetyScope(draft),safetyIdentity:completionSafetyIdentity(draft),copyReviewEnabled:this.copyReviewEnabled(),draftRevision:draft.revision,draftStamp:completionDraftStamp(draft)},draft,context,row,workflow);
  }
  getCompletion(id:string):CompletionOperation{return this.ai.completionJournal.get(id);}
  completionUnknown(id:string):boolean{return this.ai.completionJournal.unknown(id);}
  completionOperations(draftId:string):CompletionOperation[]{return this.ai.completionJournal.list(draftId);}
  private completionDraft(operation:CompletionOperation):AmazonDraft {
    const draft=this.amazon.getDraft(operation.draftId);
    if(this.completionScope(draft)!==operation.scopeHash&&this.completionScope(draft,true)!==operation.scopeHash||this.copyReviewEnabled()!==operation.copyReviewEnabled)throw new UserFacingError('字段操作来源、店铺或审核策略已变化，未自动重发');
    if(draft.revision===operation.draftRevision&&completionDraftStamp(draft)===operation.draftStamp)return draft;
    const round=operation.rounds.at(-1),adoption=round?.adoptionId&&draft.fieldAdoptions?.find(a=>a.id===round.adoptionId);
    if(adoption&&adoption.fromRevision===operation.draftRevision&&adoption.toRevision===draft.revision&&adoption.contextSha256===round!.contextHash&&adoption.suggestionResultId===round!.candidate.resultId&&adoption.reviewResultId===(round!.review?.resultId??null)&&adoption.changes.every(change=>listingFingerprint(draft.attributes[change.field])===listingFingerprint(change.after))){
      round!.resolved=true;operation.draftRevision=draft.revision;operation.draftStamp=completionDraftStamp(draft);this.ai.completionJournal.save(operation);return draft;
    }
    throw new UserFacingError('字段操作对应的草稿已修改，保留进度，未自动重发');
  }
  /** Validation previews never publish. Only reported copy/semantic fields enter this journal. */
  async complete(raw:unknown,signal?:AbortSignal,operationId?:string):Promise<{draft:AmazonDraft;aiCalls:number;previewAttempts:number;remaining:string[];rejections?:{resultId:string;callId:string;details:import('../../shared/rejection-presentation.ts').FieldRejections}[]}> {
    signal?.throwIfAborted();const initial=input(raw,'suggest'),journal=this.ai.completionJournal;
    // Preserve the response under its original frozen context before evaluating
    // whether changed current data still permits adoption. Never runs on startup.
    const prior=operationId?journal.get(operationId):journal.list(initial.draftId).find(op=>op.state==='ACTIVE');
    if(prior){if(prior.draftId!==initial.draftId)throw new UserFacingError('字段操作不属于当前草稿');journal.recoverReceived(prior.id);}
    const proofDraft=this.amazon.getDraft(initial.draftId);this.store.assertSourceConsistency(proofDraft.productId,proofDraft.salesPlan?.recipe.components.map(c=>c.variantId)??[proofDraft.variantId]);
    let operation=this.beginCompletion(initial,operationId),draft=this.completionDraft(operation),aiCalls=0,previewAttempts=0;
    const operationContext=(reference:SuggestAmazonFieldsInput)=>this.current(reference,operation.scopeHash===this.completionScope(draft)?undefined:{} as ListingAiContext);
    const reviewEnabled=operation.copyReviewEnabled;
    const refresh=()=>{operation=journal.get(operation.id);signal?.throwIfAborted();this.assertReviewSetting(reviewEnabled);if(operation.state==='GUARD')unknownCompletion();draft=this.completionDraft(operation);};
    const checkpoint=()=>{operation.draftRevision=draft.revision;operation.draftStamp=completionDraftStamp(draft);journal.save(operation);};
    const currentRemaining=(remaining:string[])=>{
      const context=operationContext({draftId:draft.id,draftRevision:draft.revision}).context;
      return [...new Set([...manualBrandIssues(draft,[...draft.previewIssues,...draft.listingIssues]),...remaining,...currentDraftEvidenceIssues(draft,isFullSchema(context)?this.currentAuthorizationContext(draft,this.store.getProduct(draft.productId),context.targetGeneration):context,id=>this.ai.getResult(id))])].slice(0,100).map(value=>value.slice(0,2000));
    };
    const rejections=()=>operation.rounds.flatMap(round=>{const result=journal.result(round.candidate,round);return result?.fieldRejections?.entries.length?[{resultId:result.id,callId:result.callId,details:result.fieldRejections}]:[];});
    const finish=(remaining:string[])=>{operation.remaining=currentRemaining(remaining);operation.state='DONE';checkpoint();return{draft,aiCalls,previewAttempts,remaining:operation.remaining,rejections:rejections()};};
    refresh();
    // Recover received outputs above and enforce unknown-result protection first.
    // A historical ACTIVE round must not bypass the same manual stop as a new round.
    const existingBrandIssues=manualBrandIssues(draft,[...draft.previewIssues,...draft.listingIssues]);
    if(operation.state==='ACTIVE'&&existingBrandIssues.length)return finish([...existingBrandIssues,...operation.remaining]);
    if(operation.state==='DONE'){
      if(operation.scopedRepair){
        const context=this.currentAuthorizationContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation);
        return {draft,aiCalls,previewAttempts,remaining:currentPolicyRemaining(draft,context,id=>this.ai.getResult(id)),rejections:rejections()};
      }
      const recovered=this.recoverRetainedFieldCandidates({draftId:draft.id,draftRevision:draft.revision});
      if(recovered.recoveredFields.length){draft=recovered.draft;operation=journal.get(operation.id);}
      const platformIssues=[...draft.previewIssues,...draft.listingIssues];
      if(needsBusinessAuthorityRefresh(draft,operation.remaining)||needsPlainColorRefresh(draft,this.store.getProduct(draft.productId))){
        const previousRemaining=[...operation.remaining];
        draft=this.amazon.applyBusinessDefaults({id:draft.id,revision:draft.revision},operation.id,true);
        operation=journal.get(operation.id);
        const context=this.currentAuthorizationContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation);
        operation.remaining=currentPolicyRemaining({...draft,previewIssues:platformIssues},context,id=>this.ai.getResult(id));checkpoint();
        this.store.recordWorkspaceEvent('listing.business-authority.refreshed','旧事实依据阻断已按当前业务规则本地重评；原响应和调用预算保留',{draftId:draft.id,operationId:operation.id,previousRemaining,remaining:operation.remaining});
        return{draft,aiCalls:0,previewAttempts:0,remaining:operation.remaining,rejections:rejections()};
      }
      const context=this.currentAuthorizationContext(draft,this.store.getProduct(draft.productId),this.amazon.executionTargetScope(draft.targetId).generation);
      return{draft,aiCalls,previewAttempts,remaining:isFullSchema(context)?currentPolicyRemaining(draft,context,id=>this.ai.getResult(id)):currentRemaining(operation.remaining),rejections:rejections()};
    }
    if(!operation.rounds.length)this.amazon.assertPricingForPaid(draft.id);
    if(!operation.rounds.length&&!operation.scopedRepair){
      this.amazon.assertPricingForPaid(draft.id);
      aiCalls+=(await this.prepareSourceColors({draftId:draft.id,draftRevision:draft.revision},signal)).aiCalls;
      signal?.throwIfAborted();this.assertReviewSetting(reviewEnabled);
      this.amazon.assertPricingForPaid(draft.id);
      draft=this.amazon.applyBusinessDefaults({id:draft.id,revision:draft.revision},operation.id);operation=journal.get(operation.id);checkpoint();
    }
    let reviewIssues:ListingIssue[]=operation.reviewIssues.map(issue=>({code:'CONTENT_REVIEW',message:issue.message,severity:'ERROR',attributeNames:[issue.field],autoFixable:false,source:'local',category:'field'}));
    if(!operation.rounds.length&&this.amazon.wasSubmissionRejected(draft.id))reviewIssues.push(...this.amazon.getDraft(draft.id).listingIssues.filter(issue=>issue.severity==='ERROR'&&(reviewEnabled||issue.code!=='CONTENT_REVIEW')));
    const errors=(value:AmazonDraft)=>(value.previewIssues.some(i=>i.severity==='ERROR')?value.previewIssues:value.localIssues).filter(i=>i.severity==='ERROR');
    for(;;){
      refresh();let round:CompletionRound|undefined=operation.rounds.at(-1);if(round?.resolved)round=undefined;
      let remaining=operation.remaining;
      if(!round){
        previewAttempts++;
        try{draft=await this.amazon.previewDraft({id:draft.id,revision:draft.revision},operation.id);}
        catch(error){draft=this.amazon.getDraft(draft.id);if(!(error instanceof UserFacingError)||!error.message.startsWith('本地校验未通过'))throw error;}
        operation=journal.get(operation.id);
        signal?.throwIfAborted();this.assertReviewSetting(reviewEnabled);checkpoint();
        const currentScope=operationContext({draftId:draft.id,draftRevision:draft.revision}).context;
        const sourceIssues:ListingIssue[]=currentScope.fields.flatMap(field=>{
          if(isFullSchema(currentScope))return [];
          if(isProseField(field.name))return [];
          const values=candidateTextValues(field.name,draft.attributes[field.name])??[],conflicts=values.flatMap(value=>selectedSkuCategoryConflicts(value,currentScope.evidence,field.name));
          return conflicts.length?[{code:'SKU_ATTRIBUTE_CONFLICT',severity:'ERROR',category:'field',source:'local',autoFixable:false,attributeNames:[field.name],message:'当前字段与所选 SKU 的明确属性矛盾：'+conflicts.map(c=>c.field+' 应为 '+c.expected.join(' / ')+'，现有 '+c.actual.join(' / ')).join('；')}]:[];
        });
        sourceIssues.push(...currentProseRepairIssues(draft,currentScope,id=>this.ai.getResult(id)).map(issue=>({code:issue.kind==='citation'?'PROSE_ADOPTION_EVIDENCE':'PROSE_SOURCE_EVIDENCE',severity:'ERROR' as const,category:'field' as const,source:'local' as const,autoFixable:false,attributeNames:[issue.field],message:issue.reason})));
        if(draft.state==='AMAZON_VALIDATED'&&!reviewIssues.length&&!sourceIssues.length)return finish([]);
        const issues=[...errors(draft),...reviewIssues,...sourceIssues];remaining=issues.map(i=>(i.attributeNames.join('、')||i.code)+'：'+i.message);
        if(manualBrandIssues(draft,issues).length)return finish([...manualBrandIssues(draft,issues),...remaining]);
        if(operation.rounds.length+(operation.legacyRecovery?.priorRounds??0)>=2)return finish(remaining);
        const reference={draftId:draft.id,draftRevision:draft.revision};
        const repairs=issues.filter(issue=>issue.category==='field').flatMap(issue=>issue.attributeNames.filter(field=>isFullSchema(currentScope)?currentScope.fields.some(f=>f.name===field):LISTING_CANDIDATE_FIELDS.includes(field)).map(field=>({field,code:issue.code.slice(0,100),message:issue.message.slice(0,2000)}))).filter(issue=>!operation.scopedRepair||operation.scopedRepair.fields.includes(issue.field as 'theme')).slice(0,50);
        if(repairs.some(issue=>issue.field==='color'))aiCalls+=(await this.prepareSourceColors(reference,signal,issues)).aiCalls;
        const {context}=operationContext(reference);context.fields=context.fields.filter(field=>repairs.some(issue=>issue.field===field.name));
        if(!context.fields.length)return finish(remaining.length?remaining:['预览未通过，但没有可自动补写的字段。']);
        context.repairRequest={issues:repairs.filter(issue=>context.fields.some(field=>field.name===issue.field)),currentValues:Object.fromEntries(context.fields.map(field=>[field.name,draft.attributes[field.name]??null]))};validateListingContext(context);
        await this.fresh(reference,context);signal?.throwIfAborted();this.assertReviewSetting(reviewEnabled);
        round={context,contextHash:listingFingerprint(context),candidate:{id:randomUUID(),sent:false,resultId:null},review:reviewEnabled?{id:randomUUID(),sent:false,resultId:null}:null,resolved:false,adoptionId:null};
        operation.rounds.push(round);operation.remaining=remaining.slice(0,100).map(v=>v.slice(0,2000));checkpoint();round=operation.rounds.at(-1)!;
      }
      const context=round.context,reference={draftId:draft.id,draftRevision:context.draftRevision};
      await this.fresh(reference,context);signal?.throwIfAborted();this.assertReviewSetting(reviewEnabled);
      const request=async(kind:'candidate'|'review',candidate?:ListingFieldsOutput):Promise<AiResult>=>{
        for(;;){
          let entry=round![kind]!;const saved=journal.result(entry,round!);if(saved)return saved;
          if(entry.sent){
            if(!journal.unknown(operation.id)&&!(kind==='review'&&journal.reviewCoverageOmission(operation.id))){const recovered=journal.recover({operationId:operation.id,callId:entry.id,contextHash:round!.contextHash});operation=journal.get(operation.id);round=operation.rounds.at(-1)!;return recovered;}
            journal.retryMissing(operation.id,kind);operation=journal.get(operation.id);round=operation.rounds.at(-1)!;entry=round[kind]!;
          }
          const assertBrandDispatch=()=>{const current=this.amazon.getDraft(draft.id),issues=manualBrandIssues(current,[...current.previewIssues,...current.listingIssues]);if(issues.length)throw new UserFacingError(issues.join('；'));};
          assertBrandDispatch();journal.assertSendBudget(operation.id,kind);
          let result:AiResult;
          try{result=await this.ai.listingFields(context,async()=>{this.assertReviewSetting(reviewEnabled);await this.fresh(reference,context);this.assertReviewSetting(reviewEnabled);assertBrandDispatch();},kind==='review'?{suggestionId:round!.candidate.resultId!,candidate:candidate!}:undefined,signal,{operationId:operation.id,callId:entry.id,contextHash:round!.contextHash});}
          catch(error){if(kind!=='review'||!journal.reviewCoverageOmission(operation.id))throw error;aiCalls++;operation=journal.get(operation.id);round=operation.rounds.at(-1)!;signal?.throwIfAborted();this.assertReviewSetting(reviewEnabled);continue;}
          aiCalls++;operation=journal.get(operation.id);round=operation.rounds.at(-1)!;signal?.throwIfAborted();this.assertReviewSetting(reviewEnabled);return result;
        }
      };
      const suggestion=await request('candidate');
      if(isFullSchema(context)&&suggestion.output.kind==='amazon-fields'){
        const issues=[...nativeCandidateIssues(suggestion.output,context),...fullCopyPolicyIssues(suggestion.output)];
        if(issues.length){
          operation.reviewIssues=issues.flatMap(issue=>issue.attributeNames.map(field=>({field,message:issue.message})));
          reviewIssues=issues;round!.resolved=true;operation.remaining=issues.map(i=>i.attributeNames.join('、')+'：'+i.message);checkpoint();continue;
        }
      }
      const candidate=this.candidates(suggestion,draft,context);
      const citationRepairs=new Set(context.repairRequest?.issues.filter(issue=>issue.code==='PROSE_ADOPTION_EVIDENCE'&&isProseField(issue.field)).map(issue=>issue.field));
      const fields=candidate.candidates.filter(c=>(!operation.scopedRepair||operation.scopedRepair.fields.includes(c.field as 'theme'))&&!haulUnsupportedField(draft.listingProgram,c.field)&&(citationRepairs.has(c.field)||JSON.stringify(candidateNative(c,draft.schema,draft.marketplaceId,draft.attributes[c.field]))!==JSON.stringify(draft.attributes[c.field]))).map(c=>c.field);
      if(!fields.length){
        const rejected=candidate.missing.filter(m=>!m.omitted&&/^\[/.test(m.reason));
        if(isFullSchema(context)&&rejected.length&&operation.rounds.length<2){operation.reviewIssues=rejected.map(m=>({field:m.field,message:m.reason}));reviewIssues=rejected.map(m=>({code:'FIELD_REPAIR',message:m.reason,severity:'ERROR',category:'field',source:'local',attributeNames:[m.field],autoFixable:false}));round!.resolved=true;checkpoint();continue;}
        return finish([...remaining,...candidate.missing.filter(m=>!m.omitted).map(m=>m.field+'：'+m.reason)]);
      }
      let review:AiResult|null=null;
      if(reviewEnabled){
        review=await request('review',candidate);if(review.output.kind!=='amazon-fields-review')throw new UserFacingError('文案审核结果无效');
        if(review.output.verdict!=='PASS'){
          operation.reviewIssues=review.output.issues.map(issue=>({field:issue.field,message:issue.message}));reviewIssues=operation.reviewIssues.map(issue=>({code:'CONTENT_REVIEW',message:issue.message,severity:'ERROR',attributeNames:[issue.field],autoFixable:false,source:'local',category:'field'}));
          round!.resolved=true;checkpoint();if(review.output.verdict==='BLOCKED')return finish(reviewIssues.map(issue=>issue.attributeNames.join('、')+'：'+issue.message));continue;
        }
      }
      operation.reviewIssues=isFullSchema(context)?candidate.missing.filter(m=>!m.omitted&&/^\[/.test(m.reason)).map(m=>({field:m.field,message:m.reason})):[];reviewIssues=operation.reviewIssues.map(m=>({code:'FIELD_REPAIR',message:m.message,severity:'ERROR',category:'field',source:'local',attributeNames:[m.field],autoFixable:false}));
      round!.adoptionId=listingFingerprint({draftId:reference.draftId,revision:reference.draftRevision,suggestion:suggestion.id,review:review?.id??null,fields:[...fields].sort(),...(!reviewEnabled?{reviewDisposition:'SKIPPED_DISABLED'}:{})});checkpoint();
      signal?.throwIfAborted();draft=await this.adopt({...reference,suggestionResultId:suggestion.id,reviewResultId:review?.id??null,fields},signal);
      round!.resolved=true;checkpoint();
    }
  }
}
