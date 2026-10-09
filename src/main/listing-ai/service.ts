import type { AiResult } from '../../shared/ai-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { SourceColorContext } from '../../shared/source-color-contracts.ts';
import { hasSkuColorEvidence } from './sku-colors.ts';
import type { AmazonDraft, JsonObject, ListingIssue } from '../../shared/amazon-contracts.ts';
import type { AdoptAmazonFieldsInput, CandidateField, ListingAiContext, ListingFieldAdoption, ListingFieldsOutput, ReviewAmazonFieldsInput, SuggestAmazonFieldsInput } from '../../shared/listing-ai-contracts.ts';
import { LISTING_CANDIDATE_FIELDS } from '../../shared/listing-ai-contracts.ts';
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
  if (!Array.isArray(o.fields) || !o.fields.length || o.fields.length > LISTING_CANDIDATE_FIELDS.length || new Set(o.fields).size !== o.fields.length || o.fields.some(f => !LISTING_CANDIDATE_FIELDS.includes(f))) throw new UserFacingError('请选择有效且不重复的候选字段');
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
  currentContext(draft:AmazonDraft,product:ProductDetail,generation:number):ListingAiContext {
    const context=buildListingContext(draft,product,generation);
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
  /** Cache all conclusive/uncertain observations by exact original-image context; never retry an unknown call. */
  async prepareSourceColors(raw:unknown,signal?:AbortSignal,repairIssues:readonly ListingIssue[]=[]):Promise<{aiCalls:number;evidenceChanged:boolean;evidenceSha256?:string}> {
    const reference=input(raw,'suggest'),initial=this.current(reference),product=this.store.getProduct(initial.draft.productId);
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
        result=await this.ai.observeSourceColor(scope,check,signal);aiCalls++;check();
      }
      if(result.output.kind!=='source-color'||result.output.verdict!=='DETERMINED')throw new UserFacingError(`来源图中的颜色仍无法确定：${result.output.kind==='source-color'?result.output.reason:'观察结果无效'}`);
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
    const context = this.currentContext(draft, this.store.getProduct(draft.productId), generation);
    if (scope?.repairRequest) {
      context.fields = context.fields.filter(field => scope.fields.some(allowed => allowed.name === field.name));
      context.repairRequest = { issues: structuredClone(scope.repairRequest.issues), currentValues: Object.fromEntries(context.fields.map(field => [field.name, draft.attributes[field.name] ?? null])) };
    }
    return { draft, context };
  }
  private async fresh(reference: SuggestAmazonFieldsInput, snapshot: ListingAiContext): Promise<void> {
    const { draft, context } = this.current(reference, snapshot);
    if (listingFingerprint(context) !== listingFingerprint(snapshot)) throw new UserFacingError('来源、店铺或规则已变化，请重新生成建议');
    for(const evidence of snapshot.evidence)if(evidence.imageObservation)await this.ai.assertSourceColorFresh(evidence.imageObservation.context);
    const schema = await this.amazon.getSchema(draft.schema);
    if (schema.checksum !== snapshot.schemaChecksum || schema.version !== snapshot.schemaVersion || listingFingerprint({ schema: schema.schema, metaSchema: schema.metaSchema }) !== snapshot.schemaSha256 || listingFingerprint(this.current(reference, snapshot).context) !== listingFingerprint(snapshot)) throw new UserFacingError('Amazon 字段规则或商品资料已更新，请建立新草稿');
  }
  private result(id: string, c: ListingAiContext): AiResult {
    const result = this.ai.getResult(id), call = result && this.ai.getCall(result.callId);
    if (!result || !call || call.status !== 'SUCCEEDED' || call.providerId !== result.providerId || call.productId !== c.productId || call.productRevision !== c.productRevision || call.model !== result.model || call.finishedAt !== result.createdAt || !result.listingContext || result.sourceSha256 !== listingFingerprint(c) || listingFingerprint(result.listingContext) !== listingFingerprint(c)) throw new UserFacingError('候选已过期或不属于当前草稿，请重新生成');
    return result;
  }
  private candidates(result: AiResult, draft: AmazonDraft, context: ListingAiContext): ListingFieldsOutput {
    if (result.output.kind !== 'amazon-fields') throw new UserFacingError('请选择本草稿生成的 Amazon 字段建议');
    assertListingEvidence(result.output, context);
    const values = Object.fromEntries(result.output.candidates.map(c => [c.field, c.items.map(i => i.value)]));
    const issues = [...validatePolicyOutputs(draft.schema, values), ...result.output.candidates.flatMap(c => validateFieldValues(draft.schema, draft.marketplaceId, c.field, c.items.map(i => i.value), draft.attributes))];
    if (issues.some(i => i.severity === 'ERROR')) throw new UserFacingError(`候选字段不符合规则：${issues.slice(0, 3).map(i => i.message).join('；')}`);
    return result.output;
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
  async adopt(raw: unknown): Promise<AmazonDraft> {
    const reference = input(raw, 'adopt'), reviewEnabled = this.copyReviewEnabled();
    const disposition = !reviewEnabled && reference.reviewResultId === null ? { reviewDisposition: 'SKIPPED_DISABLED' as const } : {};
    const adoptionId = listingFingerprint({ draftId: reference.draftId, revision: reference.draftRevision, suggestion: reference.suggestionResultId, review: reference.reviewResultId, fields: [...reference.fields].sort(), ...disposition });
    const existing = this.amazon.getDraft(reference.draftId);
    const prior = existing.fieldAdoptions?.find(a => a.id === adoptionId);
    if (prior && existing.revision === prior.toRevision) return existing;
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
    const attributes: JsonObject = structuredClone(draft.attributes);
    const changes = reference.fields.map(field => {
      const c = candidate.candidates.find(c => c.field === field); if (!c) throw new UserFacingError('所选字段没有有效候选值');
      const before = attributes[field] ?? null, after = wrapCandidateValues(draft.schema, draft.marketplaceId, field, c.items.map(i => i.value),attributes[field]); attributes[field] = after;
      const evidenceIds = new Set(c.items.flatMap(i => i.evidenceIds));
      return { field, before, after, evidence: context.evidence.filter(e => evidenceIds.has(e.id)) };
    });
    const adoption: ListingFieldAdoption = { id: adoptionId, at: new Date().toISOString(), suggestionResultId: suggestion.id, reviewResultId: review?.id ?? null, contextSha256: listingFingerprint(context), fromRevision: draft.revision, toRevision: draft.revision + 1, fields: [...reference.fields].sort(), changes, ...disposition };
    return this.amazon.adoptFields({ id: draft.id, revision: draft.revision }, attributes, adoption, () => { this.assertReviewSetting(reviewEnabled); if (listingFingerprint(this.current(reference, context).context) !== listingFingerprint(context)) throw new UserFacingError('草稿资料已变化，未写入建议'); });
  }

  /** A fresh copy snapshot for image generation when independent copy review is disabled. */
  async snapshotCurrentForImages(raw: unknown, signal?: AbortSignal): Promise<{ context: ListingAiContext; currentListingCopy: CurrentListingCopy[] }> {
    const reference = input(raw, 'suggest'), { draft, context } = this.current(reference);
    signal?.throwIfAborted();
    const snapshot = currentImageListingSnapshot(draft, context);
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

  /** Validation previews never publish. Only reported copy/semantic fields can enter the model. */
  async complete(raw: unknown, signal?: AbortSignal): Promise<{ draft: AmazonDraft; aiCalls: number; previewAttempts: number; remaining: string[] }> {
    const initial = input(raw, 'suggest'), reviewEnabled = this.copyReviewEnabled(); this.current(initial); signal?.throwIfAborted();
    const colors=await this.prepareSourceColors(initial,signal);
    const rejectedIssues=this.amazon.wasSubmissionRejected(initial.draftId)?this.amazon.getDraft(initial.draftId).listingIssues.filter(issue=>issue.severity==='ERROR'):[];
    let draft = this.amazon.applyBusinessDefaults({ id: initial.draftId, revision: initial.draftRevision });
    let aiCalls = colors.aiCalls, previewAttempts = 0, repairAttempts = 0;
    let reviewIssues: ListingIssue[] = rejectedIssues.filter(issue => reviewEnabled || issue.code !== 'CONTENT_REVIEW');
    const errors = (value: AmazonDraft): ListingIssue[] => (value.previewIssues.some(i => i.severity === 'ERROR') ? value.previewIssues : value.localIssues).filter(i => i.severity === 'ERROR');
    for (;;) {
      signal?.throwIfAborted(); this.assertReviewSetting(reviewEnabled); previewAttempts++;
      try { draft = await this.amazon.previewDraft({ id: draft.id, revision: draft.revision }); }
      catch (error) {
        draft = this.amazon.getDraft(draft.id);
        // Authentication, transport and stale-scope failures require their own resolution.
        if (!(error instanceof UserFacingError) || !error.message.startsWith('本地校验未通过')) throw error;
      }
      signal?.throwIfAborted(); this.assertReviewSetting(reviewEnabled);
      const currentScope=this.current({draftId:draft.id,draftRevision:draft.revision}).context;
      const sourceIssues:ListingIssue[]=currentScope.fields.flatMap(field=>{
        const values=candidateTextValues(field.name,draft.attributes[field.name])??[];
        const conflicts=values.flatMap(value=>selectedSkuCategoryConflicts(value,currentScope.evidence,field.name));
        return conflicts.length?[{code:'SKU_ATTRIBUTE_CONFLICT',severity:'ERROR',category:'field',source:'local',autoFixable:false,attributeNames:[field.name],
          message:`当前字段与所选 SKU 的明确属性矛盾：${conflicts.map(conflict=>`${conflict.field} 应为 ${conflict.expected.join(' / ')}，现有 ${conflict.actual.join(' / ')}`).join('；')}`}]:[];
      });
      if (draft.state === 'AMAZON_VALIDATED' && !reviewIssues.length&&!sourceIssues.length) return { draft, aiCalls, previewAttempts, remaining: [] };
      const issues = [...errors(draft), ...reviewIssues,...sourceIssues], remaining = issues.map(i => `${i.attributeNames.join('、') || i.code}：${i.message}`);
      if (repairAttempts >= 2) return { draft, aiCalls, previewAttempts, remaining };
      const reference = { draftId: draft.id, draftRevision: draft.revision };
      const repairs = issues.filter(issue => issue.category === 'field').flatMap(issue => issue.attributeNames.filter((field): field is CandidateField => LISTING_CANDIDATE_FIELDS.includes(field as CandidateField)).map(field => ({field,code:issue.code.slice(0,100),message:issue.message.slice(0,2000)}))).slice(0,50);
      if(repairs.some(issue=>issue.field==='color'))aiCalls+=(await this.prepareSourceColors(reference,signal,issues)).aiCalls;
      const { context } = this.current(reference);
      context.fields = context.fields.filter(field => repairs.some(issue => issue.field === field.name));
      if (!context.fields.length) return { draft, aiCalls, previewAttempts, remaining: remaining.length ? remaining : ['预览未通过，但没有可自动补写的字段。'] };
      context.repairRequest = { issues: repairs.filter(issue => context.fields.some(field => field.name === issue.field)), currentValues: Object.fromEntries(context.fields.map(field => [field.name, draft.attributes[field.name] ?? null])) };
      validateListingContext(context);
      await this.fresh(reference, context); signal?.throwIfAborted(); this.assertReviewSetting(reviewEnabled);
      const suggestion = await this.ai.listingFields(context, async () => { this.assertReviewSetting(reviewEnabled); await this.fresh(reference, context); this.assertReviewSetting(reviewEnabled); }, undefined, signal); aiCalls++; repairAttempts++;
      signal?.throwIfAborted(); this.assertReviewSetting(reviewEnabled);
      const candidate = this.candidates(suggestion, draft, context);
      const fields = candidate.candidates.filter(c => JSON.stringify(wrapCandidateValues(draft.schema, draft.marketplaceId, c.field, c.items.map(i => i.value),draft.attributes[c.field])) !== JSON.stringify(draft.attributes[c.field])).map(c => c.field);
      if (!fields.length) return { draft, aiCalls, previewAttempts, remaining: [...remaining,...candidate.missing.map(m => `${m.field}：${m.reason}`)] };
      if (!reviewEnabled) {
        reviewIssues = [];
        draft = await this.adopt({ ...reference, suggestionResultId: suggestion.id, reviewResultId: null, fields });
        continue;
      }
      const review = await this.review({ ...reference, suggestionResultId: suggestion.id }, signal); aiCalls++;
      signal?.throwIfAborted();
      if (review.output.kind !== 'amazon-fields-review') throw new UserFacingError('文案审核结果无效');
      if (review.output.verdict !== 'PASS') {
        reviewIssues = review.output.issues.map(issue => ({ code: 'CONTENT_REVIEW', message: issue.message, severity: 'ERROR', attributeNames: [issue.field], autoFixable: false, source: 'local', category: 'field' }));
        if (review.output.verdict === 'BLOCKED') return { draft, aiCalls, previewAttempts, remaining: reviewIssues.map(issue => `${issue.attributeNames.join('、')}：${issue.message}`) };
        continue;
      }
      reviewIssues = [];
      draft = await this.adopt({ ...reference, suggestionResultId: suggestion.id, reviewResultId: review.id, fields });
    }
  }
}
