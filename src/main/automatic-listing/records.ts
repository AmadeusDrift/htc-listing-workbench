import type { ProductDetail } from '../../shared/contracts.ts';
import type { AutomaticListingItem, AutomaticListingTask } from '../../shared/automatic-listing-contracts.ts';
import { FIELD_REPAIR_POLICY_VERSION, FIELD_REPAIR_MIGRATION_FIELDS, CATEGORY_FIELD_REPAIR_POLICY_VERSION, CATEGORY_FIELD_REPAIR_FIELDS } from '../../shared/automatic-listing-contracts.ts';
import type { FieldRepairMigrationField } from '../../shared/automatic-listing-contracts.ts';
import { identifier, record, text } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { fingerprint } from '../execution/records.ts';
import { validateItemLabelFormat } from '../item-labels/adapter.ts';
import { validateSalesPlan } from '../sales-plans/records.ts';
import { outcomeScope } from './outcomes.ts';
import { assertBusinessRules } from '../listing-ai/history.ts';
import { AUTOMATIC_SOURCE_ISSUES, type AutomaticSourceIssueCode } from '../../shared/image-workflow-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { AutomaticListingOutcome } from '../../shared/automatic-listing-contracts.ts';
import { DECLARATION_SOURCE_CONFLICT } from '../amazon/declaration-safety.ts';

export const sourceStamp = (product: ProductDetail): string => fingerprint({
  id: product.id, title: product.title, sourceUrl: product.sourceUrl, description: product.description,
  variants: product.variants, facts: product.facts, status: product.status,
});
const fail = (): never => { throw new UserFacingError('自动上架任务记录无效'); };
const counter = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) return fail(); return Number(value);
};
const hash = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail();
const date = (value: unknown): string => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fail();
const optional = (value: unknown, max = 1000): string | null => value === null ? null : text(value, '任务内容', max, true);
const itemKeys = ['key','productId','productRevision','sourceStamp','productTitle','variantId','sku','stockSets','sourcesPrepared','status','stage','draftId','executionTaskIds','imageStarted','imageAttempts','repairAttempts','repair','batchId','error'];
function item(raw: unknown): AutomaticListingItem {
  const value = record(raw, '自动上架 SKU', [...itemKeys,'classification','salesPlan','parentDraftId','repairPolicyVersion','repairPolicyMigration','familyTransition','sourceColorEvidenceSha256','sourceColorRepair','categoryFieldPolicyVersion','categoryFieldRepair','outcome']);
  if (itemKeys.some(key=>!Object.hasOwn(value,key)) || !['PENDING','RUNNING','WAITING','DONE','FAILED','SCREENED'].includes(String(value.status))
    || !['PLAN','SOURCES','CLASSIFY','DRAFT','IMAGES','PARENT','EXECUTION','READBACK','LABELS','COMPLETE'].includes(String(value.stage))
    || typeof value.sourcesPrepared !== 'boolean' || typeof value.imageStarted !== 'boolean' || !Array.isArray(value.executionTaskIds) || value.executionTaskIds.length > 6) fail();
  const productId = identifier(value.productId), variantId = identifier(value.variantId);
  const salesPlan=value.salesPlan===undefined?undefined:validateSalesPlan(value.salesPlan);
  if (value.key !== productId + ':' + (salesPlan?.recipe.key??variantId)) fail();
  const result: AutomaticListingItem = { key: String(value.key), productId, variantId, productRevision: counter(value.productRevision), sourceStamp: hash(value.sourceStamp),
    productTitle: text(value.productTitle, '商品标题', 2000), sku: text(value.sku, 'SKU', 200, true), stockSets: counter(value.stockSets, 100000),
    sourcesPrepared: value.sourcesPrepared as boolean, status: value.status as AutomaticListingItem['status'], stage: value.stage as AutomaticListingItem['stage'],
    draftId: value.draftId === null ? null : identifier(value.draftId), executionTaskIds: (value.executionTaskIds as unknown[]).map(identifier),
    imageStarted: value.imageStarted as boolean, imageAttempts: counter(value.imageAttempts, 21), repairAttempts: counter(value.repairAttempts, 5),
    repair: null, batchId: value.batchId === null ? null : identifier(value.batchId), error: optional(value.error, 2000) };
  if(value.repairPolicyVersion!==undefined){if(value.repairPolicyVersion!==FIELD_REPAIR_POLICY_VERSION)fail();result.repairPolicyVersion=FIELD_REPAIR_POLICY_VERSION;}
  if(value.repairPolicyMigration!==undefined){
    const migration=record(value.repairPolicyMigration,'字段修复迁移',['version','previousAttempts','grantedAttempts','grantedAt','fields']);
    if(migration.version!==FIELD_REPAIR_POLICY_VERSION||result.repairPolicyVersion!==migration.version||migration.previousAttempts!==2||migration.grantedAttempts!==1
      ||!Array.isArray(migration.fields)||!migration.fields.length||migration.fields.length>FIELD_REPAIR_MIGRATION_FIELDS.length||new Set(migration.fields).size!==migration.fields.length||migration.fields.some(field=>!FIELD_REPAIR_MIGRATION_FIELDS.includes(field as FieldRepairMigrationField))||result.repairAttempts<2)fail();
    result.repairPolicyMigration={version:FIELD_REPAIR_POLICY_VERSION,previousAttempts:2,grantedAttempts:1,grantedAt:date(migration.grantedAt),fields:migration.fields as FieldRepairMigrationField[]};
  }
  if(value.sourceColorEvidenceSha256!==undefined){
    if(!result.draftId||!result.executionTaskIds.length||!result.repairAttempts)fail();
    result.sourceColorEvidenceSha256=hash(value.sourceColorEvidenceSha256);
  }
  if(value.sourceColorRepair!==undefined){
    const color=record(value.sourceColorRepair,'来源颜色修复',['evidenceSha256','previousAttempts','grantedAttempts','grantedAt']);
    if(Object.keys(color).length!==4||![2,3,4].includes(Number(color.previousAttempts))||color.grantedAttempts!==1
      ||!result.sourceColorEvidenceSha256||color.evidenceSha256!==result.sourceColorEvidenceSha256)fail();
    result.sourceColorRepair={evidenceSha256:hash(color.evidenceSha256),previousAttempts:counter(color.previousAttempts,4) as 2|3|4,grantedAttempts:1,grantedAt:date(color.grantedAt)};
  }
  if(value.categoryFieldPolicyVersion!==undefined){if(value.categoryFieldPolicyVersion!==CATEGORY_FIELD_REPAIR_POLICY_VERSION)fail();result.categoryFieldPolicyVersion=CATEGORY_FIELD_REPAIR_POLICY_VERSION;}
  if(value.categoryFieldRepair!==undefined){
    const category=record(value.categoryFieldRepair,'类目字段修复',['version','previousAttempts','grantedAttempts','grantedAt','fields']);
    if(Object.keys(category).length!==5||category.version!==CATEGORY_FIELD_REPAIR_POLICY_VERSION||result.categoryFieldPolicyVersion!==category.version||category.grantedAttempts!==1
      ||![2,3,4].includes(Number(category.previousAttempts))||!Array.isArray(category.fields)||!category.fields.length||category.fields.length>CATEGORY_FIELD_REPAIR_FIELDS.length||new Set(category.fields).size!==category.fields.length||category.fields.some(field=>!CATEGORY_FIELD_REPAIR_FIELDS.includes(field as typeof CATEGORY_FIELD_REPAIR_FIELDS[number]))||!result.draftId||!result.executionTaskIds.length)fail();
    result.categoryFieldRepair={version:CATEGORY_FIELD_REPAIR_POLICY_VERSION,previousAttempts:counter(category.previousAttempts,4) as 2|3|4,grantedAttempts:1,grantedAt:date(category.grantedAt),fields:category.fields as typeof CATEGORY_FIELD_REPAIR_FIELDS[number][]};
  }
  const baseLimit=2+(result.repairPolicyMigration?.grantedAttempts??0),grants=[result.sourceColorRepair,result.categoryFieldRepair].filter((grant):grant is NonNullable<typeof grant>=>!!grant).sort((a,b)=>a.previousAttempts-b.previousAttempts);
  if(grants.some((grant,index)=>grant.previousAttempts!==baseLimit+index||result.repairAttempts<grant.previousAttempts+1)||result.repairAttempts>baseLimit+grants.length)fail();
  if(salesPlan){if(salesPlan.sku!==result.sku||!salesPlan.recipe.components.some(c=>c.variantId===variantId)||salesPlan.parentage==='PARENT')fail();result.salesPlan=salesPlan;}
  if(value.parentDraftId!==undefined)result.parentDraftId=identifier(value.parentDraftId);
  if(value.familyTransition!==undefined){
    const change=record(value.familyTransition,'父子体转换进度',['phase','plan','sourceWorkflowId','draftRevision','draftStamp']);
    const plan=validateSalesPlan(change.plan);
    if(Object.keys(change).length!==5||!['BIND','RECHECK','READY'].includes(String(change.phase))||!salesPlan||!result.draftId||!result.imageStarted
      ||plan.parentage!=='CHILD'||!plan.familyBinding||plan.sku!==salesPlan.sku||plan.baseSku!==salesPlan.baseSku||plan.namingGroupId!==salesPlan.namingGroupId
      ||plan.sourceGroupKey!==salesPlan.sourceGroupKey||plan.namingChildKey!==salesPlan.namingChildKey||fingerprint(plan.recipe)!==fingerprint(salesPlan.recipe))fail();
    result.familyTransition={phase:change.phase as 'BIND'|'RECHECK'|'READY',plan,sourceWorkflowId:identifier(change.sourceWorkflowId),draftRevision:counter(change.draftRevision),draftStamp:hash(change.draftStamp)};
    if(!result.familyTransition.draftRevision||value.repair!==null)fail();
    if(change.phase!=='BIND'&&fingerprint(plan)!==fingerprint(salesPlan))fail();
  }
  if (value.repair !== null) {
    const repair = record(value.repair, '字段修复进度', ['phase','sourceWorkflowId','draftRevision','draftStamp','remaining','operationId']);
    if (![4,5,6].includes(Object.keys(repair).length) || !['FIELDS_PENDING','FIELDS_STARTED','RECHECK_PENDING','READY'].includes(String(repair.phase))) fail();
    result.repair = { phase: repair.phase as NonNullable<AutomaticListingItem['repair']>['phase'], sourceWorkflowId: identifier(repair.sourceWorkflowId), draftRevision: counter(repair.draftRevision), draftStamp: hash(repair.draftStamp) };
    if(repair.operationId!==undefined)result.repair.operationId=identifier(repair.operationId);
    if (repair.remaining !== undefined) {
      if (!Array.isArray(repair.remaining) || repair.remaining.length > 100 || repair.remaining.some(message => typeof message !== 'string' || !message || message.length > 2000)) fail();
      result.repair.remaining = repair.remaining as string[];
    }
    if (!result.repair.draftRevision || (!result.repairAttempts && result.repair.phase !== 'FIELDS_PENDING') || !result.draftId || !result.executionTaskIds.length) fail();
  }
  if (value.classification !== undefined) {
    const c = record(value.classification,'商品分类',['productType','reason','keywords','candidateTypes','decisionIds','judged','classifiedAt']);
    if (!Array.isArray(c.keywords) || !c.keywords.length || c.keywords.length>8 || !Array.isArray(c.candidateTypes) || !c.candidateTypes.length || c.candidateTypes.length>50
      || !Array.isArray(c.decisionIds) || c.decisionIds.length<2 || c.decisionIds.length>3 || typeof c.judged !== 'boolean') fail();
    const classification = { productType:text(c.productType,'类型',100,true), reason:text(c.reason,'分类依据',2000,true), keywords:(c.keywords as unknown[]).map(word=>text(word,'关键词',100,true)),
      candidateTypes:(c.candidateTypes as unknown[]).map(name=>text(name,'候选',100,true)),decisionIds:(c.decisionIds as unknown[]).map(identifier),judged:c.judged as boolean,classifiedAt:date(c.classifiedAt) };
    if (!classification.candidateTypes.includes(classification.productType)) fail();
    result.classification = classification;
  }
  if (!result.productRevision || !result.stockSets || new Set(result.executionTaskIds).size !== result.executionTaskIds.length) fail();
  if (['EXECUTION','READBACK','LABELS','COMPLETE'].includes(result.stage) && !result.draftId) fail();
  if (result.status === 'DONE' && result.stage !== 'COMPLETE') fail();
  if(value.outcome!==undefined)result.outcome=validateOutcome(value.outcome,result);
  if(result.status==='SCREENED'&&result.outcome?.kind!=='RULE_FILTERED'||result.outcome?.kind==='RULE_FILTERED'&&result.status!=='SCREENED')fail();
  if(result.stage==='PLAN'&&(result.status!=='FAILED'||!result.error||result.draftId||result.salesPlan||result.executionTaskIds.length||result.imageStarted))fail();
  return result;
}
function validateOutcome(raw:unknown,row:AutomaticListingItem):AutomaticListingOutcome {
  const value=record(raw,'结果分类',['version','kind','code','message','classifiedAt','scope','draftId','draftRevision','pricingReport','image']);
  if(value.version!==1||!['RULE_FILTERED','SYSTEM_REPAIR','NEEDS_INPUT','UNKNOWN','UNCLASSIFIED'].includes(String(value.kind)))fail();
  const scope=record(value.scope,'结果范围',['mode','sellerId','marketplaceId','productId','recipeKey','recipeStamp','sourceStamp','rulesStamp','ruleRevision']);
  if(Object.keys(scope).length!==9||!['demo','live'].includes(String(scope.mode)))fail();
  const result:AutomaticListingOutcome={version:1,kind:value.kind as AutomaticListingOutcome['kind'],code:text(value.code,'结果代码',100,true),message:text(value.message,'结果原因',2000,true),classifiedAt:date(value.classifiedAt),
    scope:{mode:scope.mode as 'demo'|'live',sellerId:text(scope.sellerId,'卖家',100,true),marketplaceId:text(scope.marketplaceId,'站点',100,true),productId:identifier(scope.productId),recipeKey:text(scope.recipeKey,'配方',200,true),recipeStamp:hash(scope.recipeStamp),sourceStamp:hash(scope.sourceStamp),rulesStamp:hash(scope.rulesStamp),ruleRevision:counter(scope.ruleRevision)},
    draftId:value.draftId===null?null:identifier(value.draftId),draftRevision:value.draftRevision===null?null:counter(value.draftRevision)};
  if(result.draftId!==row.draftId||!result.draftId&&result.draftRevision!==null||result.kind==='RULE_FILTERED'&&!result.draftRevision)fail();
  if(value.pricingReport!==undefined){
    const p=record(value.pricingReport,'定价证据',['revision','fields','notices','quote','bundleQuantity','pricingBasis','pricingDecision']);
    if(p.revision!==scope.ruleRevision||p.quote!==null||JSON.stringify(p.fields)!=='{}'||JSON.stringify(p.notices)!=='[]'||!Number.isSafeInteger(p.bundleQuantity)||Number(p.bundleQuantity)<1||!p.pricingDecision||!result.draftId)fail();
    const report=p as unknown as NonNullable<AutomaticListingOutcome['pricingReport']>;
    assertBusinessRules({businessRules:report,marketplaceId:result.scope.marketplaceId,salesPlan:row.salesPlan,schema:{schema:{properties:{}}}} as unknown as AmazonDraft);
    if(report.pricingDecision!.code!==result.code||result.kind!==(report.pricingDecision!.status==='business_blocked'?'RULE_FILTERED':report.pricingDecision!.status==='system_error'?'SYSTEM_REPAIR':'NEEDS_INPUT'))fail();
    result.pricingReport=structuredClone(report);
  }
  if(value.image!==undefined){
    const image=record(value.image,'图片淘汰证据',['kind','workflowId','resultId','callId','planResultId','candidateId','contextSha256','draftRevision','references','policyVersion','message']);
    if(Object.keys(image).length!==11||!['IP_PLAN_BLOCKED','IP_IMAGE_BLOCKED'].includes(String(image.kind))||image.kind!==result.code||result.kind!=='RULE_FILTERED'||!result.draftId||image.draftRevision!==result.draftRevision||!Array.isArray(image.references)||!image.references.length||image.references.length>10)fail();
    const references=(image.references as unknown[]).map(raw=>{const r=record(raw,'参考图',['id','sha256']);if(Object.keys(r).length!==2)fail();return {id:identifier(r.id),sha256:hash(r.sha256)};});
    if(new Set(references.map(r=>r.id)).size!==references.length)fail();
    result.image={kind:image.kind as 'IP_PLAN_BLOCKED'|'IP_IMAGE_BLOCKED',workflowId:identifier(image.workflowId),resultId:identifier(image.resultId),callId:identifier(image.callId),planResultId:identifier(image.planResultId),candidateId:image.candidateId===null?null:identifier(image.candidateId),contextSha256:hash(image.contextSha256),draftRevision:counter(image.draftRevision),references,policyVersion:text(image.policyVersion,'图片规则版本',100,true),message:text(image.message,'图片规则原因',2000,true)};
    if((result.image.kind==='IP_IMAGE_BLOCKED')!==Boolean(result.image.candidateId))fail();
  }
  if(result.kind==='RULE_FILTERED'&&(!result.pricingReport&&!result.image||result.pricingReport&&result.image||row.repair?.phase==='FIELDS_STARTED'&&!row.repair.operationId||['EXECUTION','READBACK','LABELS','COMPLETE'].includes(row.stage)))fail();
  if(Object.hasOwn(AUTOMATIC_SOURCE_ISSUES,result.code)){
    if(result.kind!==AUTOMATIC_SOURCE_ISSUES[result.code as AutomaticSourceIssueCode]||row.stage!=='SOURCES'||result.draftId!==null)fail();
  }else if(result.code===DECLARATION_SOURCE_CONFLICT){
    if(result.kind!=='NEEDS_INPUT'||!result.draftId||!result.draftRevision||result.pricingReport||result.image)fail();
  }else if(!result.pricingReport&&!result.image&&!['LEGACY_FAILURE','PRICING_EVIDENCE_STALE','SYSTEM_FAILURE','SOURCE_INPUT_REQUIRED','FIELD_RESULT_UNKNOWN','IMAGE_RESULT_UNKNOWN','SUBMISSION_UNKNOWN','EVIDENCE_READ_FAILED'].includes(result.code))fail();
  return result;
}
const taskKeys = ['id','revision','status','targetId','targetName','sellerId','marketplaceId','mode','targetStamp','profileId','profileStamp','rulesStamp','ruleRevision','productType','locale','labelFormat','items','createdAt','updatedAt','error'];
export function validateAutomaticListingTask(raw: unknown): AutomaticListingTask {
  const value = record(raw, '自动上架任务', taskKeys);
  if (Object.keys(value).length !== taskKeys.length || !['CREATED','QUEUED','RUNNING','WAITING','PAUSED','NEEDS_ATTENTION','COMPLETED','CANCELLED'].includes(String(value.status))
    || !['demo','live'].includes(String(value.mode)) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 5000) fail();
  const items = (value.items as unknown[]).map(item);
  const planned=items.filter(row=>row.stage!=='PLAN');
  if (new Set(items.map(row => row.key)).size !== items.length || new Set(planned.map(row => row.sku)).size !== planned.length) fail();
  if (value.status === 'COMPLETED' && items.some(row => !['DONE','SCREENED'].includes(row.status))) fail();
  const result:AutomaticListingTask={ id: identifier(value.id), revision: counter(value.revision), status: value.status as AutomaticListingTask['status'],
    targetId: text(value.targetId, '目标店铺', 100, true), targetName: text(value.targetName, '目标店铺', 200, true),
    sellerId: text(value.sellerId, '卖家', 100, true), marketplaceId: text(value.marketplaceId, '站点', 100, true), mode: value.mode as 'demo' | 'live',
    targetStamp: hash(value.targetStamp), profileId: text(value.profileId, '图床', 30, true), profileStamp: hash(value.profileStamp), rulesStamp: hash(value.rulesStamp),
    ruleRevision: counter(value.ruleRevision), productType: text(value.productType, '商品类型', 100, true), locale: text(value.locale, '语言', 30, true), items,
    labelFormat: validateItemLabelFormat(value.labelFormat), createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), error: optional(value.error, 2000) };
  for(const row of items)if(row.outcome&&fingerprint(row.outcome.scope)!==fingerprint(outcomeScope(result,row)))fail();
  return result;
}
