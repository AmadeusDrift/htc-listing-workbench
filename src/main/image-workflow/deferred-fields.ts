import { isPlatformFieldIssue } from '../amazon/preview-validation.ts';
import type { AmazonDraft, ListingIssue } from '../../shared/amazon-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { ListingRules } from '../../shared/listing-rules.ts';
import { pricingQualificationIssue, pricingExempt } from '../pricing/qualification.ts';
import { readPricingRuleInputs } from '../pricing/dependencies.ts';
import { FIELD_REPAIR_MIGRATION_FIELDS, CATEGORY_FIELD_REPAIR_FIELDS } from '../../shared/automatic-listing-contracts.ts';
import type { FieldRepairMigrationField, CategoryFieldRepairField } from '../../shared/automatic-listing-contracts.ts';

/** Only actual field failures justify the one-time category capability migration. */
export function categoryRepairFields(draft:AmazonDraft,remaining:string[]=[]):CategoryFieldRepairField[] {
  if(draft.schema?.parentageLevel==='PARENT'||draft.submittedAt)return [];
  const errors=[...draft.localIssues,...draft.previewIssues,...(draft.listingIssues??[])].filter(issue=>issue.severity==='ERROR').flatMap(issue=>issue.attributeNames);
  return CATEGORY_FIELD_REPAIR_FIELDS.filter(field=>errors.includes(field)||remaining.some(message=>new RegExp(`^(?:[a-z_]+[、,]\\s*)*${field}(?:\\s|[:：、,]|$)`,'u').test(message.trim())));
}

/** Fields whose candidate validation/format support changed in the current release. */
export function newlyRepairableFields(draft:AmazonDraft,product:ProductDetail):FieldRepairMigrationField[] {
  const sourceVariants=draft.salesPlan?.recipe.components.map(component=>component.variantId)??[draft.variantId];
  const specs=product.variants.filter(variant=>sourceVariants.includes(variant.id)).flatMap(variant=>[variant.sourceSpec,variant.originalSpec]).join(' ');
  return [...new Set(nonDeferredImageIssues(draft).flatMap(issue=>issue.attributeNames))].filter((field):field is FieldRepairMigrationField=>
    FIELD_REPAIR_MIGRATION_FIELDS.includes(field as FieldRepairMigrationField)&&(field!=='color'||/夜光本色|松针绿/.test(specs)));
}

/** Caller must persist the policy marker and STARTED intent before the extra request. */
export function legacyContentRepairFields(checkpoint:{state:'STARTED'|'DONE';draftRevision:number;remaining:string[];repairPolicyVersion?:string}|undefined,draft:AmazonDraft,product:ProductDetail):FieldRepairMigrationField[] {
  if(!checkpoint||checkpoint.state!=='DONE'||checkpoint.draftRevision!==draft.revision||!checkpoint.remaining.length||checkpoint.repairPolicyVersion)return [];
  return newlyRepairableFields(draft,product);
}

/** Preserve the business rule's cause instead of presenting its missing price symptom. */
export function pricingBlockingReason(draft: AmazonDraft, rules?: ListingRules): string | null {
  if(pricingExempt(draft))return null;
  if(rules)return pricingQualificationIssue(draft,rules)?.message??null;
  const snapshot=draft.businessRules?.pricingDecision;
  if(snapshot?.version===3){
    try{return pricingQualificationIssue(draft,readPricingRuleInputs(snapshot.dependencies.rules,snapshot.evidence))?.message??null;}
    catch{return '定价依据格式无效，请重新核对后应用商品规则';}
  }
  const actualIssue=(draft.localIssues??[]).find(issue=>issue.severity==='ERROR'&&(issue.code.startsWith('ACTUAL_')||issue.code==='PRICING_EVIDENCE_STALE'));
  if(actualIssue)return actualIssue.message;
  if(!draft.businessRules || draft.businessRules.quote!==null)return null;
  const decision = draft.businessRules.pricingDecision;
  if (decision) {
    if (decision.status === 'quoted') return null;
    const labels = {
      QUOTE_VALID: '已计算报价', QUOTE_INVALID_INPUT: '定价输入无效，须确认有效成本和包装参数',
      DIMENSIONAL_WEIGHT_LIMIT: '已确认包装抛重超出上限', ROI_MAX_PRICE: '已确认输入在售价上限内无法满足目标 ROI',
      ROI_PROMOTION_OR_MARGIN: '已确认输入的加价或促销报价无法同时满足 ROI 和售价上限',
      COST_CNY_UNCONFIRMED: '采购成本或人民币币种待确认', MARKETPLACE_UNSUPPORTED: '当前站点不适用已确认的美元定价规则',
      PACKAGE_MEASUREMENTS_MISSING: '缺少完整包装尺寸或包装重量', PACKAGE_INPUT_UNCONFIRMED: '包装尺寸或重量待确认，当前报价尝试不能判定商品不符合业务要求',
      PACKAGE_SCOPE_UNCONFIRMED: '当前销售单元的整套包装参数待确认，来源单包测量不能直接证明组套包装',
      SOURCE_QUANTITY_CONFLICT: '来源件数或计价口径冲突，待确认销售单元成本', LEGACY_QUANTITY_CONFLICT: '旧组套记录件数冲突，待确认销售单元成本',
      SOURCE_QUANTITY_UNCONFIRMED: '来源件数尚未确认或与销售组合不一致，待确认销售单元成本',
      SALE_QUANTITY_CHANGED: '自动组套件数已变更，待确认销售单元成本', PRICING_SYSTEM_ERROR: '定价计算发生系统异常，需排查后重试',
    };
    const prefix = decision.status === 'business_blocked' ? '定价未通过' : decision.status === 'system_error' ? '定价异常' : '定价资料待确认';
    return `${prefix}：${labels[decision.code]}。请核对实际成本、包装参数或定价设置后重新准备草稿；系统不会自动提高售价上限或降低目标 ROI。`;
  }
  // Display-only compatibility for old snapshots; text never creates structured evidence.
  const notices=draft.businessRules.notices.filter(message=>/售价上限|报价无法.*ROI|抛重.*超出上限|采购成本或人民币币种尚未确认|计价口径.*无法计算|组套.*成本|组套记录.*冲突/.test(message));
  return notices.length?`定价未通过：${notices.join('；')}。请核对实际成本、包装参数或定价设置后重新准备草稿；系统不会自动提高售价上限或降低目标 ROI。`:null;
}

/** Remove only an exact historical pricing explanation after current qualification.
 * Returns a new runtime view; frozen completion results and reports stay untouched. */
export function withoutHistoricalPricingRemaining(draft: AmazonDraft, remaining: string[], rules: ListingRules): string[] {
  if (pricingBlockingReason(draft,rules)!==null) return [...remaining];
  const historical=pricingBlockingReason(draft);
  return historical ? remaining.filter(message=>message!==historical) : [...remaining];
}

/** Only call where an image workflow or execution already owns the planned image slots. */
export function isDeferredImageIssue(draft: AmazonDraft, issue: ListingIssue, plannedImages = 7): boolean {
  if (!['LOCAL_required','90220'].includes(issue.code) || issue.attributeNames.length !== 1) return false;
  const field = issue.attributeNames[0], match = /^other_product_image_locator_([1-9]\d*)$/.exec(field);
  if (field !== 'main_product_image_locator' && (!match || Number(match[1]) >= plannedImages)) return false;
  if (plannedImages < 1) return false;
  const value = draft.attributes[field];
  return value === undefined || value === null || Array.isArray(value) && value.every(item =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
    && (item.media_location === undefined || item.media_location === null || item.media_location === ''));
}

export function nonDeferredImageIssues(draft: AmazonDraft, plannedImages = 7): ListingIssue[] {
  return [...draft.localIssues,...draft.previewIssues].filter(issue => issue.severity === 'ERROR' && !isDeferredImageIssue(draft,issue,plannedImages) && !isPlatformFieldIssue(draft.listingProgram,issue));
}

export function withoutDeferredImageRemaining(draft: AmazonDraft, remaining: string[], plannedImages = 7): string[] {
  const forms = (issue: ListingIssue) => [issue.message,`${issue.attributeNames.join('、') || issue.code}：${issue.message}`];
  const errors = [...draft.localIssues,...draft.previewIssues].filter(issue => issue.severity === 'ERROR');
  const deferred = new Set(errors.filter(issue => isDeferredImageIssue(draft,issue,plannedImages)||isPlatformFieldIssue(draft.listingProgram,issue)).flatMap(forms));
  // Identical wording attached to a real field error must remain visible.
  for (const message of errors.filter(issue => !isDeferredImageIssue(draft,issue,plannedImages)&&!isPlatformFieldIssue(draft.listingProgram,issue)).flatMap(forms)) deferred.delete(message);
  return remaining.filter(message => !deferred.has(message));
}
