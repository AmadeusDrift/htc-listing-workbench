import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ImagePlanOutput, ProductImageContext } from '../src/shared/image-ai-contracts.ts';
import { imageCopySourceIds } from '../src/shared/image-ai-contracts.ts';
import { planProductImage } from '../src/main/ai/image-adapters.ts';
import { assertImagePlan, imageGenerationPrompt, repairImagePlanCaptions, validateImagePlan, validateProductImageContext } from '../src/main/ai/image-validation.ts';
import { validateAiCall, validateAiResult } from '../src/main/ai/validation.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { validateImageWorkflowRun } from '../src/main/image-workflow/records.ts';
import { assertImageWorkflowHistory } from '../src/main/image-workflow/history.ts';
import { sceneSet } from './fixtures/image-set.ts';
import { chat } from './fixtures/listing-ai.ts';

// These are immutable diagnostic replies, not adopted production results.
const cases=JSON.parse(readFileSync(new URL('./fixtures/image-plan-rejections.json',import.meta.url),'utf8')).cases;
function fixture(sku:number):{raw:ImagePlanOutput;context:ProductImageContext;workflow:any;call:any} {
  return structuredClone(cases.find((item:any)=>item.sku===`H2-261008-${sku}`));
}
function replay(raw:unknown,context:ProductImageContext):ImagePlanOutput {
  const plan=repairImagePlanCaptions(validateImagePlan(raw),context);assertImagePlan(plan,context);return plan;
}
function photographicPlan() {
  const {raw,context}=fixture(43);
  raw.productUnderstanding={...raw.productUnderstanding!,sufficient:true,uncertainties:[]};
  raw.prompt='Show the selected product from the reference image.';
  raw.setPlan=sceneSet();
  return {raw,context};
}

test('a contradictory PASS retains every IP finding as UNCERTAIN and still obeys the risk switch',()=>{
  const {raw,context}=fixture(27),before=structuredClone(raw),plan=replay(raw,context);
  assert.equal(plan.ipRisk!.verdict,'UNCERTAIN');
  assert.deepEqual(plan.ipRisk!.findings,before.ipRisk!.findings);
  assert.match(plan.ipRisk!.findings[0].name,/RIMEI/);
  assert.throws(()=>imageGenerationPrompt(plan,context,true));
  assert.doesNotThrow(()=>imageGenerationPrompt(plan,context,false));
  assert.deepEqual(raw,before);
});

test('IP normalization cannot hide invalid reference IDs, malformed findings or empty non-PASS findings',()=>{
  for(const alter of [
    (raw:any)=>{raw.ipRisk.findings[0].referenceAssetIds=[randomUUID()];},
    (raw:any)=>{raw.ipRisk.findings[0].name='';},
    (raw:any)=>{raw.ipRisk={verdict:'UNCERTAIN',findings:[]};}
  ]){const {raw,context}=fixture(27);alter(raw);assert.throws(()=>replay(raw,context));}
});

for(const sku of [35,43,51]) {
  test(`original SKU ${sku} refusal preserves its reason, remains non-executable and supports cached historical storage`,()=>{
    const {raw,context,workflow,call:diagnostic}=fixture(sku),before=structuredClone(raw),plan=replay(raw,context);
    assert.equal(plan.prompt,'');assert.equal(plan.productUnderstanding!.sufficient,false);
    assert.deepEqual(plan.productUnderstanding,before.productUnderstanding);
    assert.equal(plan.setPlan!.slots.length,7);assert.deepEqual(raw,before);
    for(const riskEnabled of [true,false])assert.throws(()=>imageGenerationPrompt(plan,context,riskEnabled));
    if(sku===51)assert.deepEqual(plan.setPlan!.slots.map(slot=>slot.role),before.setPlan!.slots.map(slot=>slot.role));

    // Exact source context and workflow record first. The old copy-review
    // receipts are outside this diagnostic export, so the history fixture then
    // uses an explicit, hashed OFF-policy snapshot instead of inventing reviews.
    const resultId=randomUUID();
    validateImageWorkflowRun({...workflow,imageContext:context,setPlan:plan.setPlan,setPlanResultId:resultId});
    const historyContext=validateProductImageContext({...context,listingReviewResultId:null,copyReviewBypass:{policy:'copy-review-disabled/v1',at:diagnostic.finishedAt,
      contextSha256:listingFingerprint(context.listing),copySha256:listingFingerprint(context.currentListingCopy)}});
    // Synthetic successful adapter receipt: the historical failed call is never
    // reclassified or adopted. The result records a valid negative observation.
    const call=validateAiCall({...diagnostic,id:randomUUID(),status:'SUCCEEDED',errorCode:null,requestId:'offline-fixture'});
    const result=validateAiResult({id:resultId,callId:call.id,providerId:call.providerId,productId:call.productId,productRevision:call.productRevision,
      variantId:historyContext.listing.variantId,assetId:null,assetSha256:null,sourceResultIds:imageCopySourceIds(historyContext),model:call.model,
      createdAt:call.finishedAt,reviewState:'unreviewed',sourceSha256:listingFingerprint(historyContext),imageContext:historyContext,listingEvidenceContractVersion:'listing-evidence/v5',imageRequestBytes:1000,output:plan});
    const run=validateImageWorkflowRun({...workflow,listingEvidenceContractVersion:'listing-evidence/v5',imageContext:historyContext,contextSha256:listingFingerprint(historyContext),setPlan:plan.setPlan,setPlanResultId:result.id});
    assert.ok(run.slots!.every(slot=>slot.attempts.length===0));
    const db=new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE image_workflow_runs(id TEXT,record_json TEXT); CREATE TABLE assets(id TEXT,product_id TEXT,sha256 TEXT);');
      db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(run.id,JSON.stringify(run));
      for(const ref of run.referenceAssets)db.prepare('INSERT INTO assets VALUES(?,?,?)').run(ref.id,run.productId,ref.sha256);
      const results=new Map([[result.id,result]]),calls=new Map([[call.id,call]]);
      // Backup import invokes this exact cross-record validator.
      assert.doesNotThrow(()=>assertImageWorkflowHistory(db,results,calls));
      calls.set(call.id,{...call,status:'FAILED',errorCode:'OUTPUT_INVALID'});
      assert.throws(()=>assertImageWorkflowHistory(db,results,calls));
    } finally {db.close();}
  });
}

test('empty prompts require an explicit source refusal and do not relax set-plan or reference validation',()=>{
  for(const alter of [
    (raw:any)=>{raw.productUnderstanding.sufficient=true;},
    (raw:any)=>{delete raw.productUnderstanding;},
    (raw:any)=>{raw.productUnderstanding.uncertainties=[];},
    (raw:any)=>{raw.productUnderstanding.referenceAssetIds=[randomUUID()];},
    (raw:any)=>{raw.setPlan.slots[0].prompt='';},
    (raw:any)=>{raw.setPlan.slots[1].evidenceIds=['unknown-source'];},
    (raw:any)=>{raw.setPlan.slots[1].prompt='Product length is 999 cm.';}
  ]){const {raw,context}=fixture(43);alter(raw);assert.throws(()=>replay(raw,context));}
});

test('Chinese camera clauses separated by enumeration commas are qualitative photography, not product sizes',()=>{
  const {raw,context}=photographicPlan();
  raw.setPlan!.style='统一采用柔和自然光、浅景深、50mm 视角、干净背景，产品是视觉中心。';
  raw.setPlan!.slots[1].prompt='柔和自然光、50mm 视角、干净背景。';
  const plan=replay(raw,context);
  assert.doesNotMatch(plan.setPlan!.style,/50\s*mm/i);
  assert.doesNotMatch(plan.setPlan!.slots[1].prompt,/50\s*mm/i);
  for(const style of ['Product length: 50mm 视角。','50mm 视角 printed on the product。','Product dimensions 50 mm。']){
    raw.setPlan!.style=style;assert.throws(()=>replay(raw,context));
  }
});

test('original SKU 48 still fails because the quoted product-code fact is not eligible evidence',()=>{
  const {raw,context}=fixture(48);
  assert.ok(!context.listing.evidence.some(item=>item.id==='c5cd9544-6f11-42cc-a497-acb17c8c34af'));
  assert.throws(()=>replay(raw,context));
});

test('the adapter returns a source refusal and preserves the complete untrusted reply without a retry',async()=>{
  const {raw,context}=fixture(43),before=structuredClone(raw);
  // Only this mocked HTTP boundary uses synthetic image bytes and their matching
  // digest. Exact historical contexts are exercised by the tests above.
  const bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(256,16);bytes.writeUInt32BE(256,20);
  const sha256=createHash('sha256').update(bytes).digest('hex');context.referenceAssets[0].sha256=sha256;
  let calls=0,captured:unknown,system='';
  const response=await planProductImage(context,undefined,'deepseek-flash',{apiKey:'offline-fixture'},new AbortController().signal,
    {now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,onUntrustedOutput:value=>{captured=value;},fetch:async(_url,options)=>{
      calls++;system=JSON.parse(String(options?.body)).messages[0].content;return chat(raw);
    }},[{assetId:context.referenceAssets[0].assetId,sha256,mimeType:'image/png',width:256,height:256,bytes}]);
  assert.equal(calls,1);assert.deepEqual(captured,before);assert.equal(response.output.productUnderstanding!.sufficient,false);
  assert.equal(response.output.prompt,'');assert.match(system,/sufficient=false[^.]*prompt[^.]*empty/i);
});
