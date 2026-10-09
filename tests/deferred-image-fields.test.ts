import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAttributes } from '../src/main/amazon/schema.ts';
import { nonDeferredImageIssues, withoutDeferredImageRemaining } from '../src/main/image-workflow/deferred-fields.ts';
import * as fieldRecovery from '../src/main/image-workflow/deferred-fields.ts';
import type { AmazonDraft, ListingIssue } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import { CATEGORY_FIELD_REPAIR_FIELDS } from '../src/shared/automatic-listing-contracts.ts';

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
