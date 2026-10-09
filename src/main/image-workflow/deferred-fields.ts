import type { AmazonDraft, ListingIssue } from '../../shared/amazon-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
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
export function pricingBlockingReason(draft: AmazonDraft): string | null {
  if(!draft.businessRules || draft.businessRules.quote!==null)return null;
  const notices=draft.businessRules.notices.filter(message=>/售价上限|报价无法.*ROI|抛重.*超出上限|采购成本或人民币币种尚未确认|计价口径.*无法计算|组套.*成本|组套记录.*冲突/.test(message));
  return notices.length?`定价未通过：${notices.join('；')}。请核对实际成本、包装参数或定价设置后重新准备草稿；系统不会自动提高售价上限或降低目标 ROI。`:null;
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
  return [...draft.localIssues,...draft.previewIssues].filter(issue => issue.severity === 'ERROR' && !isDeferredImageIssue(draft,issue,plannedImages));
}

export function withoutDeferredImageRemaining(draft: AmazonDraft, remaining: string[], plannedImages = 7): string[] {
  const forms = (issue: ListingIssue) => [issue.message,`${issue.attributeNames.join('、') || issue.code}：${issue.message}`];
  const errors = [...draft.localIssues,...draft.previewIssues].filter(issue => issue.severity === 'ERROR');
  const deferred = new Set(errors.filter(issue => isDeferredImageIssue(draft,issue,plannedImages)).flatMap(forms));
  // Identical wording attached to a real field error must remain visible.
  for (const message of errors.filter(issue => !isDeferredImageIssue(draft,issue,plannedImages)).flatMap(forms)) deferred.delete(message);
  return remaining.filter(message => !deferred.has(message));
}
