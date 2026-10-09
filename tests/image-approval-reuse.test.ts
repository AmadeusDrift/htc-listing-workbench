import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {compatibleApprovalRecipe} from '../src/main/image-workflow/approval-reuse.ts';
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
