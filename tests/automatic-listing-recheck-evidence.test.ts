import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { currentImageListingSnapshot } from '../src/main/image-workflow/image-facts.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { imageWorkflowDraftStamp } from '../src/main/image-workflow/records.ts';
import { hasRecordedRecheckDraft } from '../src/main/image-workflow/recheck-evidence.ts';
import type { AiCall, AiResult } from '../src/shared/ai-contracts.ts';
import type { ImageWorkflowRun } from '../src/shared/image-workflow-contracts.ts';
import type { ListingAiContext } from '../src/shared/listing-ai-contracts.ts';

async function fixture(t:test.TestContext) {
  t.mock.method(globalThis,'fetch',()=>{throw new Error('External network is forbidden in recheck fixtures');});
  mkdirSync('.test-data',{recursive:true});const root=mkdtempSync(resolve('.test-data/recheck-evidence-'));
  const store=new WorkspaceStore(root),amazon=new AmazonService(root,id=>store.getProduct(id),{isEncryptionAvailable:()=>false,encryptString:()=>Buffer.alloc(0),decryptString:()=>''});
  t.after(()=>{amazon.close();store.close();rmSync(root,{recursive:true,force:true});});
  const product=store.createProduct(),target=amazon.enableDemo();
  const initial=await amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  const draft=amazon.saveDraft({id:initial.id,revision:initial.revision,attributes:{...initial.attributes,item_name:[{value:'Copy repaired during recheck',marketplace_id:target.marketplaceId,language_tag:'en_US'}]}});
  const targetGeneration=amazon.executionTargetScope(target.id).generation;
  const snapshot=currentImageListingSnapshot(draft,buildListingContext(draft,product,targetGeneration));
  const at='2026-10-09T09:37:56.218Z',hash='a'.repeat(64);
  const source:ImageWorkflowRun={id:randomUUID(),draftId:draft.id,productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,
    status:'COMPLETED',stage:'complete',attempt:7,maxAttempts:3,contextSha256:hash,draftSha256:imageWorkflowDraftStamp(initial),referenceAssets:[],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],
    approvedAssetId:randomUUID(),approvedSha256:hash,createdAt:'2026-10-09T05:00:00.000Z',updatedAt:'2026-10-09T06:00:00.000Z',error:null,
    slots:Array.from({length:7},(_,i)=>({index:i+1,purpose:i===0?'main':'detail',status:'PASSED',contextSha256:hash,attempts:[],approvedAssetId:randomUUID(),approvedSha256:hash,error:null}))};
  const review:AiResult={id:randomUUID(),callId:randomUUID(),providerId:'deepseek-review',productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,
    assetId:null,assetSha256:null,sourceResultIds:[],model:'fixture-review',createdAt:at,reviewState:'unreviewed',sourceSha256:listingFingerprint(snapshot.context),listingContext:snapshot.context,
    output:{kind:'listing-current-review',currentListingCopy:snapshot.currentListingCopy,copySha256:listingFingerprint(snapshot.currentListingCopy),verdict:'NEEDS_CHANGES',checks:[],issues:[]}};
  const call:AiCall={id:review.callId,providerId:review.providerId,productId:review.productId,productRevision:review.productRevision,status:'SUCCEEDED',errorCode:null,requestId:null,model:review.model,generation:1,
    startedAt:'2026-10-09T09:37:30.000Z',finishedAt:at,usage:{promptTokens:20,completionTokens:10,processedImages:0}};
  const run:ImageWorkflowRun={...structuredClone(source),id:randomUUID(),status:'BLOCKED',stage:'content',attempt:0,maxAttempts:1,contextSha256:null,draftSha256:null,
    slots:source.slots!.map(slot=>({...slot,status:'PENDING',contextSha256:null,approvedAssetId:null,approvedSha256:null})),approvedAssetId:null,approvedSha256:null,
    createdAt:'2026-10-09T06:40:31.016Z',updatedAt:'2026-10-09T09:38:01.287Z',error:'Copy still needs changes',recheckedFromRunId:source.id,copyRepairAttempts:2,copyReviewResultId:review.id};
  const input={draft,product,targetGeneration,run,source,getResult:(id:string)=>id===review.id?review:undefined,getCall:(id:string)=>id===call.id?call:undefined};
  return {input,review,call,amazon};
}

test('a linked unsuccessful copy review proves the repaired version without changing its verdict or budget',async t=>{
  const f=await fixture(t),before=JSON.stringify([f.input.run,f.review]);
  assert.equal(hasRecordedRecheckDraft(f.input),true);
  assert.equal(JSON.stringify([f.input.run,f.review]),before);
  assert.equal(f.input.run.status,'BLOCKED');assert.equal(f.input.run.copyRepairAttempts,2);
});

for(const change of ['revision','copy','schema','source','target','product','review-id','result-scope','call-status','call-identity','call-time','missing-review'] as const)
test(`recheck version recovery rejects changed ${change} evidence`,async t=>{
  const f=await fixture(t);assert.equal(hasRecordedRecheckDraft(f.input),true);
  if(change==='revision')f.input.draft.revision++;
  if(change==='copy')f.input.draft.attributes.item_name=[{value:'Unrecorded edit'}];
  if(change==='schema')f.input.draft.schema.version='different';
  if(change==='source')f.input.source.id=randomUUID();
  if(change==='target')f.input.targetGeneration++;
  if(change==='product')f.input.product.revision++;
  if(change==='review-id')f.input.run.copyReviewResultId=randomUUID();
  if(change==='result-scope')f.review.variantId=randomUUID();
  if(change==='call-status')f.call.status='FAILED';
  if(change==='call-identity')f.call.productId=randomUUID();
  if(change==='call-time')f.call.finishedAt='2026-10-09T09:37:00.000Z';
  if(change==='missing-review')f.input.getResult=()=>undefined;
  assert.equal(hasRecordedRecheckDraft(f.input),false);
});

test('a cancelled planning recheck proves its exact draft snapshot and still rejects later saves',async t=>{
  const f=await fixture(t),snapshot=currentImageListingSnapshot(f.input.draft,buildListingContext(f.input.draft,f.input.product,f.input.targetGeneration));
  Object.assign(f.input.run,{status:'CANCELLED',stage:'planning',draftSha256:imageWorkflowDraftStamp(f.input.draft),imageContext:{listing:snapshot.context,currentListingCopy:snapshot.currentListingCopy,
    listingReviewResultId:f.review.id,referenceAssets:[],purpose:'main',policyVersion:'product-image/ip-v3'}});
  f.input.run.contextSha256=listingFingerprint(f.input.run.imageContext);
  assert.equal(hasRecordedRecheckDraft(f.input),true);
  f.input.draft=f.amazon.saveDraft({id:f.input.draft.id,revision:f.input.draft.revision,attributes:f.input.draft.attributes});
  assert.equal(hasRecordedRecheckDraft(f.input),false,'even saving identical copy advances beyond the recorded revision');
});

for(const path of ['planning','copy-review'] as const)
test(`field title and description changes preserve the original ${path} recheck proof`,async t=>{
  const f=await fixture(t),context=structuredClone(f.review.listingContext!);
  if(path==='planning'){
    Object.assign(f.input.run,{status:'CANCELLED',stage:'planning',draftSha256:imageWorkflowDraftStamp(f.input.draft),imageContext:{listing:structuredClone(context),currentListingCopy:(f.review.output as any).currentListingCopy,
      listingReviewResultId:f.review.id,referenceAssets:[],purpose:'main',policyVersion:'product-image/ip-v3'}});
    f.input.run.contextSha256=listingFingerprint(f.input.run.imageContext);
  }
  const before=JSON.stringify([f.input.run,f.review]);
  for(const field of context.fields){field.title=`Updated ${field.name}`;field.description='Expanded field help from a newer catalog projection.';}
  assert.notEqual(listingFingerprint(context),f.review.sourceSha256,'global listing identity remains strict');
  assert.equal(hasRecordedRecheckDraft({...f.input,context}),true);
  assert.equal(JSON.stringify([f.input.run,f.review]),before,'compatibility must never rewrite historical evidence');
  const stored=path==='planning'?f.input.run.imageContext!.listing:f.review.listingContext!;
  stored.fields[0].description='Tampered historical field help';
  assert.equal(hasRecordedRecheckDraft({...f.input,context}),false,'the original stored context hash must still be valid');
});

for(const path of ['planning','copy-review'] as const)
test(`field metadata compatibility keeps all semantic and identity guards in ${path} proof`,async t=>{
  const f=await fixture(t),original=structuredClone(f.review.listingContext!);
  if(path==='planning'){
    Object.assign(f.input.run,{status:'CANCELLED',stage:'planning',draftSha256:imageWorkflowDraftStamp(f.input.draft),imageContext:{listing:structuredClone(original),currentListingCopy:(f.review.output as any).currentListingCopy,
      listingReviewResultId:f.review.id,referenceAssets:[],purpose:'main',policyVersion:'product-image/ip-v3'}});
    f.input.run.contextSha256=listingFingerprint(f.input.run.imageContext);
  }
  const changes:Record<string,(context:ListingAiContext)=>void>={
    'field name':c=>{c.fields[0].name='theme';},
    'field collection':c=>{c.fields.pop();},
    'field order':c=>{c.fields.reverse();},
    'required status':c=>{c.fields[0].requirement=c.fields[0].requirement==='required'?'optional':'required';},
    'enum permission':c=>{c.fields[0].closedEnum=!c.fields[0].closedEnum;},
    'allowed values':c=>{c.fields[0].allowedValues.push('Changed option');},
    'suggested values':c=>{c.fields[0].suggestedValues.push('Changed suggestion');},
    'inference policy':c=>{c.categoryInferencePolicyVersion='different-policy' as never;},
    'future field permission':c=>{Object.assign(c.fields[0],{futureInferencePermission:true});},
    'future context key':c=>{Object.assign(c,{futureContextPolicy:{enabled:true}});},
    'source fact':c=>{c.evidence.push({id:randomUUID(),name:'Material',value:'Changed source material',meaning:'material',source:'human_confirmed'});},
    'source title':c=>{c.unverifiedSourceTitle+=' changed';},
    'repair request':c=>{c.repairRequest={issues:[{field:'item_name',code:'CHANGED',message:'Changed request'}],currentValues:{item_name:'Changed copy'}};},
  };
  for(const key of ['draftId','productId','variantId','sku','targetId','listingProgram','productType','marketplaceId','locale','requirements','parentageLevel','schemaChecksum','schemaVersion','schemaSha256','policyVersion'] as const)
    changes[key]=c=>{Object.assign(c,{[key]:`${c[key]}-changed`});};
  for(const key of ['draftRevision','productRevision','targetGeneration'] as const)changes[key]=c=>{c[key]++;};
  for(const key of ['minLength','maxLength','minUtf8ByteLength','maxUtf8ByteLength','minItems','maxItems'] as const)changes[key]=c=>{c.fields[0][key]=(c.fields[0][key]??0)+1;};
  for(const [label,change] of Object.entries(changes)){
    const context=structuredClone(original);context.fields[0].description='Metadata may change';change(context);
    assert.equal(hasRecordedRecheckDraft({...f.input,context}),false,label);
  }
  const context=structuredClone(original);context.fields[0].description='Metadata may change';
  assert.equal(hasRecordedRecheckDraft({...f.input,context}),true);
  f.input.draft.attributes.item_name=[{value:'Changed current copy',marketplace_id:f.input.draft.marketplaceId,language_tag:'en_US'}];
  assert.equal(hasRecordedRecheckDraft({...f.input,context}),false,'current copy cannot change with metadata');
});

test('category field completion proves only its exact saved draft before the new image snapshot',async t=>{
  const f=await fixture(t),run=f.input.run;delete run.copyReviewResultId;delete run.copyRepairAttempts;
  run.categoryFieldPolicyVersion='category-inference/v1';run.categoryFieldRepair={version:'category-inference/v1',grantedAttempts:1,grantedAt:run.updatedAt,fields:['age_range_description']};
  run.contentPreparation={state:'DONE',draftRevision:f.input.draft.revision,draftSha256:imageWorkflowDraftStamp(f.input.draft),remaining:[],copyReviewEnabled:false};
  assert.equal(hasRecordedRecheckDraft(f.input),true);assert.equal(run.status,'BLOCKED');
  for(const change of ['STARTED','stamp','revision','grant','policy','submitted'] as const){const input=structuredClone({...f.input,getResult:undefined,getCall:undefined}) as any;input.getResult=()=>undefined;input.getCall=()=>undefined;
    if(change==='STARTED')input.run.contentPreparation.state='STARTED';if(change==='stamp')input.run.contentPreparation.draftSha256='f'.repeat(64);if(change==='revision')input.draft.revision++;if(change==='grant')delete input.run.categoryFieldRepair;if(change==='policy')delete input.run.categoryFieldPolicyVersion;if(change==='submitted')input.draft.submittedAt=new Date().toISOString();
    assert.equal(hasRecordedRecheckDraft(input),false,change);
  }
});
