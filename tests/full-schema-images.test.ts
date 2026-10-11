import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture,chat } from './fixtures/listing-ai.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { currentDraftEvidenceIssues,currentProseRepairIssues,currentCopyIssues } from '../src/main/listing-ai/current-evidence.ts';
import { explicitCategoryConflicts } from '../src/main/listing-ai/full-schema-conflicts.ts';
import { currentImageListingSnapshot } from '../src/main/image-workflow/image-facts.ts';
import { assertImagePlan,imageRiskSourceSnapshot,validateProductImageContext,validateListingCurrentReview } from '../src/main/ai/image-validation.ts';
import { validateStoredAiResult } from '../src/main/ai/validation.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { FULL_SCHEMA_CONTRACT } from '../src/shared/listing-ai-contracts.ts';
import { PRODUCT_IMAGE_POLICY_VERSION } from '../src/shared/image-ai-contracts.ts';
import type { ProductImageContext } from '../src/shared/image-ai-contracts.ts';
import { ImageWorkflowService } from '../src/main/image-workflow/service.ts';
import { imageWorkflowDraftStamp } from '../src/main/image-workflow/records.ts';

test('native nested numeric adoption reaches image snapshots and reviewed v4 copy without serializing schema into review requests',async t=>{
  const calibration={type:'object',required:['steps','enabled'],properties:{steps:{type:'array',items:{type:'number'}},enabled:{type:'boolean'}}};
  const f=await fixture(t,{unfamiliar_numeric_structure:{type:'array',items:{type:'object',required:['calibration'],properties:{calibration}}}});
  let enabled=false;
  const listing=new ListingAiService(f.store,f.amazon,f.ai,()=>enabled);
  const native=[{calibration:{steps:[1,2.5,8],enabled:true}}];
  f.respond((payload,options)=>{
    if(payload.operation==='listing-current-review'){
      assert.equal(payload.fullSchema,undefined);assert.equal(payload.currentAttributes,undefined);
      const system=JSON.parse(String(options?.body)).messages[0].content;
      assert.doesNotMatch(system,/Decompose every assertion|exact substring|Every supported item and claim needs|Together the substrings must cover/i);
      assert.match(system,/uncertainty alone must not reject|claims may be empty/i);
      assert.equal(payload.sourceProduct.selectedSku.id,f.product.variants[0].id);
      assert.equal(payload.sourceProduct.title,f.product.title);
      assert.ok(Array.isArray(payload.sourceProduct.observations));
      assert.ok(payload.sourceProduct.observations.some((observation:any)=>observation.variantId===f.product.variants[0].id));
      assert.equal(payload.sourceProduct.assets,undefined);
      assert.ok(payload.candidate.candidates.every((c:any)=>c.field!=='unfamiliar_numeric_structure'));
      return chat({kind:'amazon-fields-review',verdict:'PASS',checks:payload.candidate.candidates.flatMap((c:any)=>c.items.map((_item:any,index:number)=>({field:c.field,index,verdict:'SUPPORTED',evidenceIds:[],reason:'Reasonable interpretation of the selected source product.',claims:[]}))),issues:[]});
    }
    return chat({kind:'amazon-fields',contract:FULL_SCHEMA_CONTRACT,candidates:[{field:'unfamiliar_numeric_structure',nativeValue:native,evidenceIds:[payload.evidence[0].id],transformation:'copy'},{field:'item_name',nativeValue:[{value:'Blue Coaster',marketplace_id:'ATVPDKIKX0DER'}],evidenceIds:[payload.evidence[0].id],transformation:'compose'}],missing:[]});
  });
  const suggestion=await listing.suggest(f.reference);
  const draft=await listing.adopt({...f.reference,suggestionResultId:suggestion.id,reviewResultId:null,fields:['unfamiliar_numeric_structure','item_name']});
  assert.deepEqual(draft.attributes.unfamiliar_numeric_structure,native);
  const input={draftId:draft.id,draftRevision:draft.revision};
  const snapshot=await listing.snapshotCurrentForImages(input);
  assert.equal(snapshot.context.contract,FULL_SCHEMA_CONTRACT);
  assert.ok(!snapshot.currentListingCopy.some(c=>c.field==='unfamiliar_numeric_structure'));
  const context:ProductImageContext={listing:snapshot.context,currentListingCopy:snapshot.currentListingCopy,listingReviewResultId:null,copyReviewBypass:{policy:'copy-review-disabled/v1',at:new Date().toISOString(),contextSha256:listingFingerprint(snapshot.context),copySha256:listingFingerprint(snapshot.currentListingCopy)},referenceAssets:f.product.assets.map(a=>({assetId:a.id,sha256:f.store.getAssetRecord(a.id)!.sha256,variantId:f.product.variants[0].id})),purpose:'detail',policyVersion:PRODUCT_IMAGE_POLICY_VERSION,ipSource:imageRiskSourceSnapshot(f.product,f.product.variants[0].id)};
  assert.deepEqual(validateProductImageContext(context),context);
  const plan={kind:'image-plan' as const,prompt:'Show the reference product.',textMode:'planned' as const,expectedText:[{text:'A distinctive desk accent',evidenceIds:[snapshot.context.evidence[0].id]}],productUnderstanding:{summary:'Reference product',referenceAssetIds:context.referenceAssets.map(a=>a.assetId),uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS' as const,findings:[]}};
  assert.doesNotThrow(()=>assertImagePlan(plan,context));
  assert.throws(()=>assertImagePlan({...plan,expectedText:[{text:'A desk accent',evidenceIds:['missing-source']}]},context));
  assert.throws(()=>assertImagePlan({...plan,expectedText:[{text:'A 91 cm desk accent',evidenceIds:[snapshot.context.evidence[0].id]}]},context));
  const changed=structuredClone(suggestion);if(changed.output.kind!=='amazon-fields')throw Error('Wrong fixture output');changed.output.candidates[0].nativeValue=[{calibration:{steps:[99],enabled:true}}];
  assert.ok(currentDraftEvidenceIssues(draft,snapshot.context,id=>id===suggestion.id?changed:f.ai.getResult(id)).some(issue=>issue.includes('不一致')));
  enabled=true;
  const reviewed=await listing.reviewCurrentForImages(input);
  assert.equal(reviewed.review.listingEvidenceContractVersion,'listing-evidence/v4');
  assert.equal(reviewed.review.output.kind,'listing-current-review');
  assert.deepEqual(validateStoredAiResult(reviewed.review),reviewed.review);
  assert.doesNotThrow(()=>validateListingCurrentReview(reviewed.review.output));
});

test('historical image copy parser keeps legacy behavior while full contexts accept large schema snapshots',async t=>{
  const f=await fixture(t),draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_name:[{value:'Blue Coaster'}]}});
  const legacy=buildListingContext(draft,f.product,f.amazon.executionTargetScope(draft.targetId).generation,true);
  assert.equal(legacy.contract,undefined);assert.ok(currentImageListingSnapshot(draft,legacy).currentListingCopy.some(c=>c.field==='item_name'));
  const full=buildListingContext(draft,f.product,f.amazon.executionTargetScope(draft.targetId).generation);
  full.fullSchema!.schema.description='Schema metadata '.repeat(15000);
  full.schemaSha256=listingFingerprint(full.fullSchema);
  const snapshot=currentImageListingSnapshot(draft,full),context={listing:full,currentListingCopy:snapshot.currentListingCopy,listingReviewResultId:randomUUID(),referenceAssets:f.product.assets.map(a=>({assetId:a.id,sha256:f.store.getAssetRecord(a.id)!.sha256,variantId:f.product.variants[0].id})),purpose:'main',policyVersion:PRODUCT_IMAGE_POLICY_VERSION,ipSource:imageRiskSourceSnapshot(f.product,f.product.variants[0].id)};
  assert.ok(Buffer.byteLength(JSON.stringify(context))>180000);assert.doesNotThrow(()=>validateProductImageContext(context));
});

test('v4 repairs only the prose field with an explicit SKU contradiction, preserving unknown and ambiguous model wording',async t=>{
  const f=await fixture(t),draft=structuredClone(f.draft),context=buildListingContext(draft,f.product,f.amazon.executionTargetScope(draft.targetId).generation);
  draft.attributes.item_name=[{value:'Electric desk tool XZ-190'}];draft.attributes.product_description=[{value:'A distinctive XZ-190 desk accent.'}];
  context.evidence=[{id:`${context.variantId}:spec`,name:'Selected SKU specification',value:'手动',meaning:'general',source:'selected_sku'}];
  assert.deepEqual(currentProseRepairIssues(draft,context).map(issue=>issue.field),['item_name']);
  assert.ok(explicitCategoryConflicts('power_source_type','Electric',context).length);
  for(const source of ['XZ-190','动力来源：未知特殊型号','not electric or manual','无电池；电池供电']){
    context.evidence[0].value=source;
    assert.deepEqual(currentProseRepairIssues(draft,context),[],source);
    assert.deepEqual(currentCopyIssues([{field:'item_name',values:['Electric desk tool XZ-190']}],context),[],source);
  }
  context.evidence[0].value='电池供电';
  assert.deepEqual(currentProseRepairIssues(draft,context),[],'battery power can be described broadly as electric');
  context.evidence[0].value='不适用儿童';
  draft.attributes.item_name=[{value:'Desk tool for kids'}];
  assert.deepEqual(currentProseRepairIssues(draft,context).map(issue=>issue.field),['item_name']);
  draft.attributes.item_name=[{value:'Desk tool with instruction manual'}];
  context.evidence[0].value='电动';
  assert.deepEqual(currentProseRepairIssues(draft,context),[],'instruction manual is not a manual-power claim');
});

test('seven consecutive slot adoptions keep original-image context and completion scope stable while changed originals still stop reuse',async t=>{
  const f=await fixture(t),draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_name:[{value:'Blue Coaster'}]}});
  const listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false),input={draftId:draft.id,draftRevision:draft.revision};
  const snapshot=await listing.snapshotCurrentForImages(input),scope=(listing as any).completionScope(draft),legacyScope=(listing as any).completionScope(draft,true);
  const context:ProductImageContext={listing:snapshot.context,currentListingCopy:snapshot.currentListingCopy,listingReviewResultId:null,copyReviewBypass:{policy:'copy-review-disabled/v1',at:new Date().toISOString(),contextSha256:listingFingerprint(snapshot.context),copySha256:listingFingerprint(snapshot.currentListingCopy)},referenceAssets:f.product.assets.map(asset=>({assetId:asset.id,sha256:f.store.getAssetRecord(asset.id)!.sha256,variantId:draft.variantId})),purpose:'main',policyVersion:PRODUCT_IMAGE_POLICY_VERSION,ipSource:imageRiskSourceSnapshot(f.product,draft.variantId)};
  const normalized=validateProductImageContext(context);
  const source=f.store.getAssetRecord(f.product.assets[0].id)!,sourcePath=join(f.directory,source.originalPath),original=readFileSync(sourcePath),now=new Date().toISOString();
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,{} as never,{listing});
  const run:any={id:randomUUID(),draftId:draft.id,productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,status:'RUNNING',stage:'adopting',attempt:0,maxAttempts:1,contextSha256:listingFingerprint(normalized),draftSha256:imageWorkflowDraftStamp(draft),referenceAssets:context.referenceAssets.map(a=>({id:a.assetId,sha256:a.sha256})),planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],ipReviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:null,imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION,slotPolicy:'seven-provisional-v1',listingEvidenceContractVersion:'listing-evidence/v4',copyReviewEnabled:false,imageContext:normalized,slots:Array.from({length:7},(_,index)=>({index:index+1,purpose:index===0?'main':'detail',status:'PENDING',contextSha256:null,attempts:[],approvedAssetId:null,approvedSha256:null,error:null}))};
  try{
    const fresh=async()=>{assert.deepEqual(await listing.snapshotCurrentForImages(input),snapshot);assert.equal((listing as any).completionScope(draft),scope);};
    for(const slot of run.slots){
      const bytes=Buffer.concat([original,Buffer.from([slot.index])]),candidate={id:randomUUID(),sha256:createHash('sha256').update(bytes).digest('hex'),width:source.width,height:source.height,byteSize:bytes.length};
      const attempt={number:1,requestId:randomUUID(),state:'GENERATED',planResultId:randomUUID(),candidateId:candidate.id,ipReviewResultId:randomUUID(),ocrResultId:randomUUID(),reviewResultId:randomUUID(),error:null};
      slot.status='RUNNING';slot.contextSha256=listingFingerprint(validateProductImageContext({...normalized,purpose:slot.purpose,slot:{index:slot.index,total:7,provisional:true}}));slot.attempts.push(attempt);
      await (workflow as any).adoptSlot(run,slot,attempt,{candidate,bytes,preview:bytes},fresh,new AbortController().signal);
      assert.equal(slot.status,'PASSED');await fresh();
    }
    assert.equal(f.store.getProduct(f.product.id).assets.length,f.product.assets.length+7);
    assert.notEqual((listing as any).completionScope(draft,true),legacyScope,'legacy scope retains its historical all-assets hash');
    const changed=Buffer.from(original);changed[changed.length-1]^=1;writeFileSync(sourcePath,changed);
    await assert.rejects(listing.snapshotCurrentForImages(input));
  }finally{writeFileSync(sourcePath,original);await workflow.close();}
});
