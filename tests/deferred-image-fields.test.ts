import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAttributes } from '../src/main/amazon/schema.ts';
import { nonDeferredImageIssues, withoutDeferredImageRemaining } from '../src/main/image-workflow/deferred-fields.ts';
import * as fieldRecovery from '../src/main/image-workflow/deferred-fields.ts';
import type { AmazonDraft, ListingIssue } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import { CATEGORY_FIELD_REPAIR_FIELDS } from '../src/shared/automatic-listing-contracts.ts';

test('pricing blocking display prefers structured causes over legacy notice wording', () => {
  const draft = { businessRules: { revision: 0, fields: {}, quote: null, bundleQuantity: 1, notices: ['售价上限内无法满足目标 ROI'],
    pricingDecision: { version: 1, status: 'needs_input', code: 'PACKAGE_INPUT_UNCONFIRMED', quoteError: 'ROI_MAX_PRICE',
      inputs: { costCny: 999, dimensionsInches: [1,1,1], weightPounds: .2 },
      evidence: { cost: 'confirmed_cny', dimensions: 'business_default', weight: 'business_default', packageScope: 'source_sale_unit', saleUnit: 'confirmed',
        sourcePackage: { dimensionsInches: null, weightPounds: null } } } } } as AmazonDraft;
  assert.match(fieldRecovery.pricingBlockingReason(draft)!, /包装.*待确认/);
  assert.doesNotMatch(fieldRecovery.pricingBlockingReason(draft)!, /定价未通过/);
  draft.businessRules!.notices = ['Arbitrary translated message'];
  assert.match(fieldRecovery.pricingBlockingReason(draft)!, /包装.*待确认/);
  delete draft.businessRules!.pricingDecision;
  assert.equal(fieldRecovery.pricingBlockingReason(draft), null);
  draft.businessRules!.notices = ['售价上限内无法满足目标 ROI'];
  assert.match(fieldRecovery.pricingBlockingReason(draft)!, /定价未通过/);
  assert.equal(draft.businessRules!.pricingDecision, undefined);
});

test('planned required main URL is deferred while missing color stays actionable', () => {
  const issues = validateAttributes({type:'object',properties:{main_product_image_locator:{type:'array'},color:{type:'array'}},required:['main_product_image_locator','color']},{});
  const draft = {attributes:{},localIssues:issues,previewIssues:[]} as unknown as AmazonDraft;
  const remaining = issues.map(issue => `${issue.attributeNames.join('、')}：${issue.message}`);
  assert.deepEqual(nonDeferredImageIssues(draft).map(issue => issue.attributeNames[0]), ['color']);
  assert.deepEqual(withoutDeferredImageRemaining(draft,remaining), [remaining[1]]);
  draft.localIssues = issues.filter(issue => issue.attributeNames.includes('main_product_image_locator'));
  assert.deepEqual(withoutDeferredImageRemaining(draft,[remaining[0]]), []);
});

test('invalid URLs, mixed-field errors, unknown messages and unplanned slots are never deferred', () => {
  const base: ListingIssue = {code:'90220',message:'Required image missing',severity:'ERROR',attributeNames:['main_product_image_locator'],category:'image',source:'amazon',autoFixable:false};
  const draft = {attributes:{main_product_image_locator:[{media_location:'invalid'}]},localIssues:[],previewIssues:[base]} as unknown as AmazonDraft;
  assert.equal(nonDeferredImageIssues(draft).length,1);
  draft.attributes={};draft.previewIssues=[{...base,attributeNames:['main_product_image_locator','color']}];
  assert.equal(nonDeferredImageIssues(draft).length,1);
  draft.previewIssues=[{...base,code:'LOCAL_format'}];assert.equal(nonDeferredImageIssues(draft).length,1);
  draft.previewIssues=[{...base,attributeNames:['other_product_image_locator_7']}];assert.equal(nonDeferredImageIssues(draft).length,1);
  draft.previewIssues=[base];assert.deepEqual(withoutDeferredImageRemaining(draft,['Unknown image problem']),['Unknown image problem']);
});

test('legacy content recovery is bounded to known incomplete checkpoints with newly repairable fields',()=>{
  assert.equal(typeof fieldRecovery.legacyContentRepairFields,'function');
  const draft={revision:3,variantId:'sku',attributes:{},localIssues:[{code:'LOCAL_required',message:'Theme missing',attributeNames:['theme'],severity:'ERROR'}],previewIssues:[]} as unknown as AmazonDraft;
  const product={variants:[{id:'sku',sourceSpec:'red',originalSpec:'red'}]} as ProductDetail;
  const checkpoint={state:'DONE' as const,draftRevision:3,remaining:['theme missing']};
  assert.deepEqual(fieldRecovery.legacyContentRepairFields(checkpoint,draft,product),['theme']);
  assert.deepEqual(fieldRecovery.legacyContentRepairFields({...checkpoint,state:'STARTED'},draft,product),[]);
  assert.deepEqual(fieldRecovery.legacyContentRepairFields({...checkpoint,repairPolicyVersion:'field-evidence/v2'},draft,product),[]);
  assert.deepEqual(fieldRecovery.legacyContentRepairFields({...checkpoint,draftRevision:2},draft,product),[]);
  assert.deepEqual(fieldRecovery.legacyContentRepairFields({...checkpoint,remaining:[]},draft,product),[]);
  draft.localIssues[0].attributeNames=['batteries_required'];
  assert.deepEqual(fieldRecovery.legacyContentRepairFields(checkpoint,draft,product),[]);
});

test('category migration eligibility requires a reported error or exact durable field prefix',()=>{
  const draft={attributes:{},localIssues:[],previewIssues:[],listingIssues:[],submittedAt:null,schema:{parentageLevel:'NONE'}} as unknown as AmazonDraft;
  assert.deepEqual(fieldRecovery.categoryRepairFields(draft),[]);
  for(const field of CATEGORY_FIELD_REPAIR_FIELDS){
    assert.deepEqual(fieldRecovery.categoryRepairFields(draft,[`${field}：required`]),[field]);
    assert.deepEqual(fieldRecovery.categoryRepairFields(draft,[`material: discusses ${field}`]),[]);
    draft.previewIssues=[{code:'90220',message:'Required field',severity:'WARNING',attributeNames:[field]} as ListingIssue];assert.deepEqual(fieldRecovery.categoryRepairFields(draft),[]);
    draft.previewIssues[0].severity='ERROR';assert.deepEqual(fieldRecovery.categoryRepairFields(draft),[field]);draft.previewIssues=[];
  }
  draft.schema.parentageLevel='PARENT';assert.deepEqual(fieldRecovery.categoryRepairFields(draft,['age_range_description: missing']),[]);
});
