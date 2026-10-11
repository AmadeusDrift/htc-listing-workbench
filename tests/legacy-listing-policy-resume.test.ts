import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures/listing-ai.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { currentImageListingSnapshot } from '../src/main/image-workflow/image-facts.ts';
import { assertImagePlan,imageRiskSourceSnapshot,validateProductImageContext } from '../src/main/ai/image-validation.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { PRODUCT_IMAGE_POLICY_VERSION } from '../src/shared/image-ai-contracts.ts';

test('current image authorization and image-only v5 preserve legacy context bytes and valid v3 history',async t=>{
  const f=await fixture(t),draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_name:[{value:'Blue Coaster'}]}});
  const listing=buildListingContext(draft,f.product,f.amazon.executionTargetScope(draft.targetId).generation,true);
  const base={listing,currentListingCopy:currentImageListingSnapshot(draft,listing).currentListingCopy,listingReviewResultId:randomUUID(),referenceAssets:f.product.assets.map(a=>({assetId:a.id,sha256:f.store.getAssetRecord(a.id)!.sha256,variantId:draft.variantId})),purpose:'detail' as const,policyVersion:PRODUCT_IMAGE_POLICY_VERSION,ipSource:imageRiskSourceSnapshot(f.product,draft.variantId)};
  const plan={kind:'image-plan' as const,prompt:'Show the reference product.',textMode:'planned' as const,expectedText:[{text:'A distinctive desk accent',evidenceIds:[listing.evidence[0].id]}],productUnderstanding:{summary:'Reference product',referenceAssetIds:base.referenceAssets.map(a=>a.assetId),uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS' as const,findings:[]}};
  const before=listingFingerprint(base);
  assert.doesNotThrow(()=>assertImagePlan(plan,base));
  assert.doesNotThrow(()=>assertImagePlan(plan,base,{storedVersion:'listing-evidence/v3'}));
  assert.doesNotThrow(()=>assertImagePlan(plan,base,{storedVersion:'listing-evidence/v5'}));
  assert.throws(()=>assertImagePlan({...plan,expectedText:[{text:'Desk accent',evidenceIds:['unknown-citation']}]},base));
  assert.equal(listingFingerprint(base),before);
});




test('unchanged legacy source survives full schema projection; raw specification and target changes do not',async t=>{
  const {ImageWorkflowService}=await import('../src/main/image-workflow/service.ts');
  const f=await fixture(t),draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_name:[{value:'Blue Coaster'}]}}),generation=f.amazon.executionTargetScope(draft.targetId).generation;
  const old=buildListingContext(draft,f.product,generation,true),full=buildListingContext(draft,f.product,generation);
  const run={imageContext:{listing:old,ipSource:imageRiskSourceSnapshot(f.product,draft.variantId)},imageRecipeSha256:listingFingerprint(draft.salesPlan?.recipe??null)};
  const receiver={listing:{currentContext:()=>full},currentContext:()=>full,store:f.store,amazon:f.amazon};
  const matches=()=> (ImageWorkflowService.prototype as any).currentContextMatches.call(receiver,run,draft);
  assert.equal(matches(),true);
  run.imageContext.ipSource.originalSpec+=' changed';assert.equal(matches(),false);run.imageContext.ipSource=imageRiskSourceSnapshot(f.product,draft.variantId);
  old.targetId=randomUUID();assert.equal(matches(),false);
});

test('old DONE remaining is reevaluated locally before provider configuration and keeps adopted fields and budgets',async t=>{
  const {ImageWorkflowService}=await import('../src/main/image-workflow/service.ts');
  const f=await fixture(t),draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_name:[{value:'Blue Coaster'}]}}),full=buildListingContext(draft,f.product,f.amazon.executionTargetScope(draft.targetId).generation);
  const old=['theme：旧词表不理解原始型号'],run:any={draftId:draft.id,productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,contentPreparation:{state:'DONE',draftRevision:draft.revision,repairPolicyVersion:'field-evidence/v2',remaining:old},copyRepairAttempts:2,maxAttempts:3,slots:[],referenceAssets:[]};
  const before=structuredClone(draft.attributes),saved:any[]=[];
  const receiver={listing:{currentContext:()=>full},currentContext:()=>full,store:f.store,amazon:f.amazon,ai:{getResult:()=>undefined},save:(value:any)=>saved.push(structuredClone(value)),currentContextMatches:()=>true};
  assert.equal(typeof (ImageWorkflowService.prototype as any).reevaluatePolicy,'function');
  await (ImageWorkflowService.prototype as any).reevaluatePolicy.call(receiver,run,draft);
  assert.ok(!run.contentPreparation.remaining.includes(old[0]));
  assert.deepEqual(run.policyReevaluation.previousRemaining,old);assert.equal(run.copyRepairAttempts,2);assert.equal(run.maxAttempts,3);assert.deepEqual(draft.attributes,before);
  await (ImageWorkflowService.prototype as any).reevaluatePolicy.call(receiver,run,draft);assert.equal(saved.length,1);
});

test('actual AI image adapter stores legacy-shaped new requests as image-only v5 without rewriting their source hash',async t=>{
  const {chat}=await import('./fixtures/listing-ai.ts');
  const {openDatabase}=await import('../src/main/database.ts');const {writeCopyReviewSettings}=await import('../src/main/listing-ai/review-settings.ts');
  const f=await fixture(t),draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_name:[{value:'Blue Coaster'}]}});
  const listing=buildListingContext(draft,f.product,f.amazon.executionTargetScope(draft.targetId).generation,true),copy=currentImageListingSnapshot(draft,listing).currentListingCopy;
  const base={listing,currentListingCopy:copy,listingReviewResultId:null,copyReviewBypass:{policy:'copy-review-disabled/v1' as const,at:new Date().toISOString(),contextSha256:listingFingerprint(listing),copySha256:listingFingerprint(copy)},referenceAssets:f.product.assets.map(a=>({assetId:a.id,sha256:f.store.getAssetRecord(a.id)!.sha256,variantId:draft.variantId})),purpose:'detail' as const,policyVersion:PRODUCT_IMAGE_POLICY_VERSION,ipSource:imageRiskSourceSnapshot(f.product,draft.variantId)};
  const db=openDatabase(f.directory);try{writeCopyReviewSettings(db,{enabled:false});}finally{db.close();}
  t.mock.method((f.ai as any).context,'fetch',async(_url:unknown,options:RequestInit)=>{f.requests.push(JSON.parse(String(options.body)));return chat({kind:'image-plan',prompt:'Show the original selected product on a desk.',textMode:'planned',expectedText:[{text:'A distinctive desk accent',evidenceIds:[listing.evidence[0].id]}],productUnderstanding:{summary:'A coaster visible in the source image',referenceAssetIds:base.referenceAssets.map(a=>a.assetId),uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS',findings:[]}});});
  const stable=validateProductImageContext(base),hash=listingFingerprint(stable),result=await f.ai.imagePlan(stable,()=>{});
  assert.equal(result.listingEvidenceContractVersion,'listing-evidence/v5');assert.equal(result.sourceSha256,hash);assert.deepEqual(f.ai.getResult(result.id),result);assert.deepEqual(result.imageContext,stable);assert.equal(f.requests.length,1);
});

test('old DONE owner permits one bounded full-schema completion and repeated restart preserves both operation ledgers',async t=>{
  const {chat,candidateFor}=await import('./fixtures/listing-ai.ts');
  const {ListingAiService}=await import('../src/main/listing-ai/service.ts');
  const {ImageWorkflowService}=await import('../src/main/image-workflow/service.ts');
  const {IMAGE_SET_POLICY}=await import('../src/shared/image-ai-contracts.ts');
  const f=await fixture(t,{theme:{type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'}},required:['value']}}});
  const oldListing=new ListingAiService(f.store,f.amazon,f.ai,()=>false),original=oldListing.currentContext.bind(oldListing);
  oldListing.currentContext=(draft,product,generation)=>original(draft,product,generation,true);
  let field='material';f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[{code:'90220',message:`Missing ${field}`,severity:'ERROR',attributeNames:[field],autoFixable:false,source:'amazon',category:'field'}]});
  f.respond(payload=>chat(candidateFor(payload)));
  const old=await oldListing.complete(f.reference),oldOperation=f.ai.completionJournal.list(f.draft.id)[0];
  assert.equal(oldOperation.state,'DONE');assert.equal(oldOperation.rounds.length,2);
  const oldBytes=JSON.stringify(oldOperation),oldResultIds=oldOperation.rounds.map(r=>r.candidate.resultId!);const oldResults=oldResultIds.map(id=>JSON.stringify(f.ai.getResult(id)));
  field='theme';f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'theme',nativeValue:[{value:'Coaster',marketplace_id:f.draft.marketplaceId}],evidenceIds:[],transformation:'infer'}],missing:[]}));
  const listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false),ai={getResult:f.ai.getResult.bind(f.ai),getCall:f.ai.getCall.bind(f.ai),listResults:f.ai.listResults.bind(f.ai),getProfile:()=>({configured:true,enabled:true})};
  let imagePosts=0;const generation={getConnection:()=>({configured:true,enabled:true}),configurationScope:()=>'',generate:()=>{imagePosts++;throw Error('No images while actual field error remains');}};
  const make=()=>new ImageWorkflowService(f.directory,f.store,f.amazon,ai as never,generation as never,{listing});
  const workflow=make();workflow.saveCopyReviewSettings({enabled:false});const now=new Date().toISOString(),run:any={id:randomUUID(),draftId:old.draft.id,productId:old.draft.productId,productRevision:old.draft.productRevision,variantId:old.draft.variantId,sku:old.draft.sku,status:'BLOCKED',stage:'content',attempt:0,maxAttempts:3,contextSha256:null,draftSha256:null,referenceAssets:[],planResultIds:[],candidateIds:[],ipReviewResultIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:'old finite policy',imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION,slotPolicy:IMAGE_SET_POLICY,slots:Array.from({length:7},(_,i)=>({index:i+1,purpose:i?'detail':'main',status:'PENDING',contextSha256:null,attempts:[],approvedAssetId:null,approvedSha256:null,error:null})),copyReviewEnabled:false,contentPreparation:{operationId:oldOperation.id,state:'DONE',draftRevision:old.draft.revision,repairPolicyVersion:'field-evidence/v2',copyReviewEnabled:false,remaining:['theme：旧分类判断未通过']}};
  (workflow as any).save(run);const before=f.requests.length;
  const first=await workflow.complete({draftId:old.draft.id,draftRevision:old.draft.revision});assert.equal(first.workflow.status,'BLOCKED');assert.ok(first.workflow.policyReevaluation?.repairStarted);assert.equal(f.requests.length-before,2);
  const ops=f.ai.completionJournal.list(f.draft.id);assert.equal(ops.length,2);assert.equal(ops[1].rounds.length,2);assert.equal(JSON.stringify(ops[0]),oldBytes);assert.notEqual(first.workflow.contentPreparation!.operationId,oldOperation.id);
  const paid=f.requests.length;await workflow.close();const restored=make();
  try{await restored.complete({draftId:old.draft.id,draftRevision:f.amazon.getDraft(old.draft.id).revision});await restored.complete({draftId:old.draft.id,draftRevision:f.amazon.getDraft(old.draft.id).revision});assert.equal(f.requests.length,paid);assert.equal(f.ai.completionJournal.list(f.draft.id).length,2);assert.equal(imagePosts,0);assert.equal(JSON.stringify(f.ai.completionJournal.get(oldOperation.id)),oldBytes);assert.deepEqual(oldResultIds.map(id=>JSON.stringify(f.ai.getResult(id))),oldResults);}finally{await restored.close();}
});


test('current legacy-shaped captions still reject explicit contradictions across separate clauses, but unknown codes remain interpretable',()=>{
  for(const [name,value,text] of [['适用年龄','不适合儿童','Not for children and suitable for children'],['适用年龄','不适合儿童','Not for children but child friendly'],['刷毛硬度','非软毛','Not soft handle but soft bristles'],['供电方式','非电动','Not electric but electric cleaner']]){
    const scope:any={listing:{evidence:[{id:'source',name,value,meaning:'general',source:'source_confirmed'}]},policyVersion:'product-image/v1',purpose:'detail'};
    assert.throws(()=>assertImagePlan({textMode:'planned',expectedText:[{text,evidenceIds:['source']}]} as any,scope),text);
  }
  const unknown:any={listing:{evidence:[{id:'source',name:'Selected SKU specification',value:'XZ-190',meaning:'general',source:'raw_source'}]},policyVersion:'product-image/v1',purpose:'detail'};
  assert.doesNotThrow(()=>assertImagePlan({textMode:'planned',expectedText:[{text:'A distinctive desk accent',evidenceIds:['source']}]} as any,unknown));
});
