import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {compatibleApprovalRecipe,approvalReviewHistoryResolved} from '../src/main/image-workflow/approval-reuse.ts';
import {listingFingerprint} from '../src/main/listing-ai/validation.ts';
import type {ImageWorkflowRun} from '../src/shared/image-workflow-contracts.ts';

const variantId=randomUUID();
function recipe(quantities:number[]){
  const components=quantities.map((quantity,i)=>({variantId:i?randomUUID():variantId,sourceKey:`source-${i}`,sourceSku:`sku-${i}`,specification:'Blue',color:'Blue',quantity,quotedCostCny:null,piecesPerQuote:1,sourcePackPieces:1}));
  return {key:createHash('sha256').update(JSON.stringify(components.map(c=>[c.sourceKey,c.quantity]))).digest('hex'),groupKey:'a'.repeat(64),specification:'Blue',color:'Blue',components,totalPieces:quantities.reduce((a,b)=>a+b,0),totalCostCny:null};
}
function oldRun(count:number):ImageWorkflowRun{return {variantId,imageContext:{sourceVariantIds:[variantId],listing:{evidence:[{id:`${variantId}:sale-count`,value:`${count} pieces`}]}}} as ImageWorkflowRun;}
test('legacy single-component approvals prove exact quantity and source variant before reuse',()=>{
  const run=oldRun(3),single=recipe([3]);assert.equal(compatibleApprovalRecipe(run,single),true);
  assert.equal(compatibleApprovalRecipe(run,recipe([2])),false);
  assert.equal(compatibleApprovalRecipe(run,null),false);
  const foreign=recipe([3]);foreign.components[0].variantId=randomUUID();assert.equal(compatibleApprovalRecipe(run,foreign),false);
  assert.equal(compatibleApprovalRecipe(run,recipe([1,2])),false);
});
test('new persisted recipe fingerprints distinguish multi-component quantities even with identical total',()=>{
  const original=recipe([1,2]),run={...oldRun(3),imageRecipeSha256:listingFingerprint(original)};
  assert.equal(compatibleApprovalRecipe(run,original),true);
  const changed=structuredClone(original);changed.components[0].quantity=2;changed.components[1].quantity=1;changed.key=createHash('sha256').update(JSON.stringify(changed.components.map(c=>[c.sourceKey,c.quantity]))).digest('hex');
  assert.equal(compatibleApprovalRecipe(run,changed),false);
});

test('retired OCR approval history needs exact original owner and never exempts unknown text or generation',()=>{
 const runId=randomUUID(),draftId=randomUUID(),productId=randomUUID(),callId=randomUUID(),candidateId=randomUUID(),planId=randomUUID(),at='2026-10-15T00:00:00.000Z';
 const request={version:2,requestId:callId,step:'ocr',state:'SENT_UNKNOWN',execution:{providerId:'aliyun-ocr'},runId,draftId,productId,productRevision:1,variantId,sku:'SALE-A',slot:1,attempt:1,generationRequestId:candidateId,candidate:{id:candidateId,sha256:'a'.repeat(64),width:256,height:256},planResultId:planId,contextSha256:'b'.repeat(64)};
 const source={id:runId,draftId,productId,productRevision:1,variantId,sku:'SALE-A',reviewRequests:[request],retiredOcrDependencies:[{callId,at}],slots:[{contextSha256:request.contextSha256,approvedSha256:request.candidate.sha256,attempts:[{requestId:candidateId,candidateId,planResultId:planId,state:'PASSED',reviewResultId:randomUUID()}]}]} as unknown as ImageWorkflowRun;
 assert.equal(approvalReviewHistoryResolved(source),true);
 for(const mutation of ['marker','candidate','context','plan','sku','step','generation'] as const){const changed=structuredClone(source);
  if(mutation==='marker')delete changed.retiredOcrDependencies;
  if(mutation==='candidate')changed.reviewRequests![0].candidate.id=randomUUID();
  if(mutation==='context')changed.reviewRequests![0].contextSha256='c'.repeat(64);
  if(mutation==='plan')changed.reviewRequests![0].planResultId=randomUUID();
  if(mutation==='sku')changed.reviewRequests![0].sku='OTHER';
  if(mutation==='step')changed.reviewRequests![0].step='text';
  if(mutation==='generation')changed.slots![0].attempts[0].state='UNKNOWN';
  assert.equal(approvalReviewHistoryResolved(changed),false,mutation);
 }
});
