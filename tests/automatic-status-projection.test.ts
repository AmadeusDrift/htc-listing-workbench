import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticItemOutcome, automaticItemReason, automaticQueueOutcome, summarizeAutomaticItems } from '../src/shared/automatic-status-projection.ts';
import { queuePresentation } from '../src/renderer/automatic-queue-view.ts';
import { buildAutomaticProductGroups } from '../src/renderer/automatic-product-groups.ts';
import type { AutomaticListingItem } from '../src/shared/automatic-listing-contracts.ts';
import { automaticFailureTime } from '../src/shared/automatic-resume.ts';

function row(code:string,kind='RULE_FILTERED',status='SCREENED'):AutomaticListingItem {
 return {key:code,productId:'p',productRevision:1,sourceStamp:'',productTitle:'合成商品',variantId:'v',sku:code,stockSets:5,sourcesPrepared:false,status:status as AutomaticListingItem['status'],stage:'DRAFT',draftId:null,executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,batchId:null,error:null,outcome:{version:1,kind:kind as NonNullable<AutomaticListingItem['outcome']>['kind'],code,pricingReport:{} as NonNullable<AutomaticListingItem['outcome']>['pricingReport'],message:'same message',classifiedAt:'2026-10-15T00:00:00.000Z',scope:{mode:'demo',sellerId:'s',marketplaceId:'m',productId:'p',recipeKey:'r',recipeStamp:'',sourceStamp:'',rulesStamp:'',ruleRevision:1},draftId:null,draftRevision:null}};
}
test('stable reason codes distinguish profit, packaging and other rules independently of pricing-report presence',()=>{
 const inputs=[row('ROI_MAX_PRICE'),row('ACTUAL_PRICE_ROI'),row('DIMENSIONAL_WEIGHT_LIMIT'),row('IP_IMAGE_BLOCKED'),row('SOURCE_INPUT_REQUIRED','NEEDS_INPUT','FAILED'),row('SYSTEM_FAILURE','SYSTEM_REPAIR','FAILED'),row('SOURCE_CONSISTENCY_INVALID_OUTPUT','SYSTEM_REPAIR','FAILED'),row('FIELD_RESULT_UNKNOWN','UNKNOWN','FAILED'),row('ROI_MAX_PRICE','RULE_FILTERED','PENDING'),row('SKU_SELECTION_FILTERED')];
 const before=JSON.stringify(inputs),outcomes=inputs.map(automaticItemOutcome);
 assert.deepEqual(outcomes,['profitFiltered','profitFiltered','packagingFiltered','ruleFiltered','needsInput','systemRepair','invalidOutput','unknown','pending','notSelected']);
 const counts=summarizeAutomaticItems(inputs),group=buildAutomaticProductGroups(inputs,[])[0];
 assert.deepEqual(group.outcomeCounts,counts);assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),inputs.length);assert.equal(JSON.stringify(inputs),before);
 const noReport=row('ROI_MAX_PRICE');delete noReport.outcome!.pricingReport;assert.equal(automaticItemOutcome(noReport),'profitFiltered');
 assert.equal(automaticItemOutcome(row('SOME_UNKNOWN_RULE')),'ruleFiltered');
 assert.equal(automaticItemOutcome(row('SYSTEM_FAILURE','UNKNOWN','FAILED')),'unknown','true UNKNOWN has priority over display code');
 assert.equal(automaticItemOutcome(row('AI_RECEIVED_INVALID_OUTPUT','SYSTEM_REPAIR','FAILED')),'invalidOutput');
 assert.equal(automaticItemOutcome(row('AI_OUTPUT_INVALID','SYSTEM_REPAIR','FAILED')),'systemRepair','a generic old error code carries no response certainty');
 assert.match(automaticItemReason(row('EVIDENCE_READ_FAILED','UNKNOWN','FAILED')),/暂不可读，结果仍未知/);
 const missing=row('EVIDENCE_READ_FAILED','UNKNOWN','FAILED');missing.rejection={workflowId:'00000000-0000-4000-8000-000000000001',detail:{version:'rejection-presentation/v1',code:'FIELD_FORMAT_INVALID',callId:'00000000-0000-4000-8000-000000000002',resultId:null,contextSha256:'a'.repeat(64),stage:'content',slot:0}};assert.match(automaticItemReason(missing),/暂不可读，结果仍未知/,'the current missing-evidence projection must not be hidden by an older rejection code');
 assert.doesNotMatch(automaticItemReason(row('EVIDENCE_READ_FAILED','SYSTEM_REPAIR','FAILED')),/结果仍未知/,'an ordinary evidence error does not assert a request became unknown');
});
test('failure timestamps distinguish request proof, local checks and unknown historical time without refresh clock',()=>{
 const event={version:1 as const,stage:'IMAGES' as const,reason:'synthetic failure',occurredAt:'2026-10-15T01:00:00.000Z'};
 assert.deepEqual(automaticFailureTime({...event,source:'request-proof'},'2026-10-15T00:00:00.000Z'),{label:'原请求明确失败凭据时间',at:event.occurredAt});
 assert.equal(automaticFailureTime({...event,source:'local-check'},'2026-10-15T00:00:00.000Z').label,'本次本地检查时间');
 assert.equal(automaticFailureTime({...event,source:'local-check'},'2026-10-15T02:00:00.000Z').label,'历史本地检查时间');
 assert.deepEqual(automaticFailureTime({...event,occurredAt:null},'2026-10-15T02:00:00.000Z'),{label:'原失败时间未保存',at:null});
 assert.equal(automaticFailureTime(event).label,'失败记录时间（未保存时间来源）');
});
test('queue classifications use the same mutually exclusive reason categories as task and SKU counts',()=>{
 for(const [code,kind,expected,label] of [['ROI_MAX_PRICE','RULE_FILTERED','profitFiltered','利润淘汰'],['DIMENSIONAL_WEIGHT_LIMIT','RULE_FILTERED','packagingFiltered','包装抛重限制'],['IP_IMAGE_BLOCKED','RULE_FILTERED','ruleFiltered','其他规则淘汰'],['SOURCE_CONSISTENCY_INVALID_OUTPUT','SYSTEM_REPAIR','invalidOutput','已收无效输出']] as const){
  const input={key:code,productId:'p',recipeKey:'r',specification:'合成',sku:'S',kind,eligible:false,message:'same unsafe text',reconsideration:null,taskId:'t',reasonCode:code};
  const before=JSON.stringify(input);assert.equal(automaticQueueOutcome(input),expected);assert.equal(queuePresentation({productId:'p',title:'',eligibleCount:0,pendingCount:0,filteredCount:1,rows:[input]}).label,label);assert.equal(JSON.stringify(input),before);
 }
});
